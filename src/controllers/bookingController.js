const prisma = require("../config/prisma");
const { Prisma } = require("@prisma/client");
const { successResponse, errorResponse } = require("../utils/response");
const { sendBookingConfirmationEmail } = require("../utils/email");
const { getRequestedLanguage, resolveLocalizedName } = require("../utils/localization");

function deriveIsGlobal(businessId, createdByUserId) {
  if (businessId == null || businessId === "") return true;
  if (createdByUserId == null || createdByUserId === "") return true;
  return false;
}

function canViewMenuItem(menu, contextBusinessId, userId) {
  if (menu.createdByUserId === userId) {
    return true;
  }
  if (menu.businessId != null && menu.businessId !== contextBusinessId) {
    return false;
  }
  if (menu.businessId == null) {
    return menu.isGlobal === true;
  }
  const dg = deriveIsGlobal(menu.businessId, menu.createdByUserId);
  return dg;
}

function num(d) {
  if (d == null) return 0;
  const n = typeof d === "number" ? d : Number(d);
  return Number.isFinite(n) ? n : 0;
}

/** Express may expose query keys as arrays — normalize to a single string. */
function queryStringParam(val) {
  if (val == null || val === "") return "";
  const first = Array.isArray(val) ? val[0] : val;
  return typeof first === "string" ? first : "";
}

/**
 * Parse `limit` / `offset`-style query params (arrays allowed).
 * @param {unknown} val
 * @param {number} fallback
 * @param {{ min?: number; max?: number }} [opts]
 */
function queryNumberParam(val, fallback, opts = {}) {
  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  if (val == null || val === "") return fallback;
  const raw = Array.isArray(val) ? val[0] : val;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function computePricingFromSnapshots(rows, guestCount, discount, servicePct, taxPct) {
  const guests = Math.max(0, Math.floor(Number(guestCount) || 0));
  const perPlateTotal = rows.reduce((s, r) => {
    const q = r.quantity != null ? Math.max(1, parseInt(String(r.quantity), 10) || 1) : 1;
    return s + num(r.pricePerPlateSnapshot) * q;
  }, 0);
  const subtotal = perPlateTotal * guests;
  const serviceChargeAmount = Math.round(subtotal * (servicePct / 100));
  // Tax on subtotal only (aligned with app getBookingPricingBreakdown)
  const taxAmount = Math.round(subtotal * (taxPct / 100));
  const disc = Math.round(Math.max(0, num(discount)));
  const totalDue = Math.max(
    0,
    Math.round(subtotal + serviceChargeAmount + taxAmount - disc),
  );
  return {
    perPlateTotal,
    subtotal,
    serviceChargeAmount,
    taxAmount,
    totalDue,
  };
}

function paymentStatusFromAmounts(amountPaid, totalDue) {
  const paid = num(amountPaid);
  const due = num(totalDue);
  if (paid <= 0) return "PENDING";
  if (paid >= due - 0.01) return "RECEIVED";
  return "PARTIAL";
}

const EVENT_EDIT_CUTOFF_MS = 12 * 60 * 60 * 1000;

/**
 * Event/menu/customer-detail edits allowed only more than 12h before event start —
 * but only once the booking is CONFIRMED. A DRAFT booking isn't a real commitment yet,
 * so it stays editable at any time, even after its event date has passed.
 */
function canEditBeforeEventCutoff(eventAt, status) {
  if (status === "DRAFT") return true;
  if (!eventAt) return true;
  const start = new Date(eventAt).getTime();
  if (Number.isNaN(start)) return true;
  if (start <= Date.now()) return false;
  return start - Date.now() > EVENT_EDIT_CUTOFF_MS;
}

function canEditMenuBeforeEvent(eventAt, status) {
  return canEditBeforeEventCutoff(eventAt, status);
}

function canEditCustomerDetailsBeforeEvent(eventAt, status) {
  return canEditBeforeEventCutoff(eventAt, status);
}

function primaryEventAtFromRow(b) {
  const events = [...(b.events || [])].sort((a, c) => {
    const ta = a.eventAt ? new Date(a.eventAt).getTime() : 0;
    const tb = c.eventAt ? new Date(c.eventAt).getTime() : 0;
    return ta - tb;
  });
  if (events.length > 0 && events[0].eventAt) {
    return events[0].eventAt;
  }
  return b.eventAt ?? null;
}

/** True when patch may change plate-based totals (menu lines or guest/discount/tax). */
function patchTouchesBookingPricing(body, existing) {
  if (Array.isArray(body.menu_item_ids) && body.menu_item_ids.length) return true;
  if (Array.isArray(body.menu_items) && body.menu_items.length) return true;
  if (
    body.discount_amount !== undefined ||
    body.service_charge_pct !== undefined ||
    body.tax_pct !== undefined
  ) {
    return true;
  }
  if (body.guest_count !== undefined) {
    const next = body.guest_count != null ? parseInt(body.guest_count, 10) : null;
    if (next !== (existing.guestCount ?? null)) return true;
  }
  const firstEvent =
    Array.isArray(body.events) && body.events.length > 0 ? body.events[0] : null;
  if (firstEvent?.guest_count !== undefined) {
    const next = firstEvent.guest_count != null ? parseInt(firstEvent.guest_count, 10) : null;
    if (next !== (existing.guestCount ?? null)) return true;
  }
  if (Array.isArray(body.events)) {
    for (const raw of body.events) {
      const ev = raw || {};
      if (ev.guest_count === undefined || !ev.id) continue;
      const cur = (existing.events || []).find((row) => row.id === ev.id);
      if (!cur) continue;
      const next = ev.guest_count != null ? parseInt(ev.guest_count, 10) : null;
      if (next !== (cur.guestCount ?? null)) return true;
    }
  }
  return false;
}

const CONFIRMED_LIMITED_PATCH_TOP = new Set([
  "customer_name",
  "customer_phone",
  "customer_email",
  "customer_address",
  "event_at",
  "event_location",
  "function_type",
  "guest_count",
  "notes",
  "events",
  // Display-only booking window; `baseData` applies these regardless, so they
  // must not flip an otherwise-allowed confirmed edit into the "locked" branch.
  "event_range_start",
  "event_range_end",
  "updated_at",
  "update_reason",
  "step_number",
]);

const CONFIRMED_LIMITED_PATCH_EVENT_KEYS = new Set([
  "id",
  "event_at",
  "event_location",
  "function_type",
  "jamanvar_type",
  "guest_count",
  "notes",
  "status",
]);

/** Sent by the app for pass-through; not applied on confirmed limited patch. */
const CONFIRMED_LIMITED_PATCH_EVENT_IGNORE = new Set([
  "dish_id",
  "parent_dish_id",
  "is_template",
  "event_snapshot",
  "event_total",
]);

/**
 * Confirmed booking: customer + event detail fields (not menu/snapshot), within 48h rule.
 */
function isConfirmedLimitedPatch(body) {
  const keys = Object.keys(body || {}).filter((k) => body[k] !== undefined);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!CONFIRMED_LIMITED_PATCH_TOP.has(k)) return false;
  }
  if (Array.isArray(body.events)) {
    for (const raw of body.events) {
      const ev = raw || {};
      const evKeys = Object.keys(ev).filter((k) => ev[k] !== undefined);
      for (const k of evKeys) {
        if (CONFIRMED_LIMITED_PATCH_EVENT_IGNORE.has(k)) continue;
        if (!CONFIRMED_LIMITED_PATCH_EVENT_KEYS.has(k)) return false;
      }
    }
  }
  return (
    body.customer_name !== undefined ||
    body.customer_phone !== undefined ||
    body.customer_email !== undefined ||
    body.customer_address !== undefined ||
    body.event_at !== undefined ||
    body.event_location !== undefined ||
    body.function_type !== undefined ||
    body.guest_count !== undefined ||
    body.notes !== undefined ||
    (Array.isArray(body.events) && body.events.length > 0)
  );
}

/** @deprecated use isConfirmedLimitedPatch */
function isCustomerDetailsOnlyPatch(body) {
  return isConfirmedLimitedPatch(body);
}

const {
  deriveEventFoodSubtotal,
  deriveEventSubtotal,
  computeBookingTotalDueFromEvents,
} = require("./bookingPricingHelpers");

/** Prefer max(stored, event-derived) when events imply a higher balance than `booking.totalDue`. */
function resolveTotalDueForPayment(booking) {
  const stored = num(booking.totalDue);
  const fromEvents = computeBookingTotalDueFromEvents(booking);
  if (fromEvents > 0) return Math.max(stored, fromEvents);
  return stored;
}

// Selectable options: breakfast, lunch, dinner.
const JAMANVAR_SLUGS = new Set([
  "breakfast",
  "lunch",
  "dinner",
]);

// Legacy slugs written by older app versions — normalize to current canonical key.
const JAMANVAR_LEGACY_MAP = {
  morningbreakfast: "breakfast",
  eveningnasto: "breakfast",
};

/** Normalize any jamanvar slug (including legacy) to a canonical value. */
function normalizeJamanvarSlug(v) {
  if (!v || typeof v !== "string") return null;
  const norm = v.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (JAMANVAR_LEGACY_MAP[norm]) return JAMANVAR_LEGACY_MAP[norm];
  // Find canonical key whose normalized form matches
  for (const slug of JAMANVAR_SLUGS) {
    if (slug.toLowerCase().replace(/[^a-z]/g, "") === norm) return slug;
  }
  return null;
}

function isStoredJamanvarSlug(v) {
  return normalizeJamanvarSlug(v) !== null;
}

function resolveEventJamanvarType(ev) {
  if (ev.jamanvarType) return normalizeJamanvarSlug(ev.jamanvarType) ?? ev.jamanvarType;
  if (isStoredJamanvarSlug(ev.functionType)) return normalizeJamanvarSlug(ev.functionType);
  return null;
}

function jamanvarTypeFromEventBody(ev, current) {
  if (ev.jamanvar_type !== undefined) {
    if (ev.jamanvar_type == null) return null;
    return normalizeJamanvarSlug(String(ev.jamanvar_type).trim()) ?? String(ev.jamanvar_type).trim();
  }
  if (ev.function_type !== undefined && isStoredJamanvarSlug(ev.function_type)) {
    return normalizeJamanvarSlug(String(ev.function_type).trim());
  }
  const cur = current?.jamanvarType ?? null;
  return cur ? (normalizeJamanvarSlug(cur) ?? cur) : null;
}

function serializeBookingEvent(ev) {
  return {
    id: ev.id,
    booking_id: ev.bookingId,
    event_at: ev.eventAt?.toISOString?.() ?? ev.eventAt ?? null,
    event_location: ev.eventLocation ?? null,
    jamanvar_type: resolveEventJamanvarType(ev),
    function_type: ev.functionType ?? null,
    guest_count: ev.guestCount ?? null,
    notes: ev.notes ?? null,
    status: ev.status ?? "PENDING",
    dish_id: ev.dishId ?? null,
    parent_dish_id: ev.parentDishId ?? null,
    is_template: ev.isTemplate ?? null,
    event_total: ev.eventTotal != null ? num(ev.eventTotal) : null,
    event_subtotal: deriveEventFoodSubtotal(ev),
    event_snapshot: ev.eventSnapshot ?? null,
    created_at: ev.createdAt?.toISOString?.() ?? ev.createdAt,
    updated_at: ev.updatedAt?.toISOString?.() ?? ev.updatedAt,
  };
}

async function enrichEventSnapshotMenuImages(booking) {
  if (!booking || !Array.isArray(booking.events) || booking.events.length === 0) {
    return booking;
  }

  const snapshotImageByMenuId = new Map();
  for (const mi of booking.menuItems || []) {
    const mid = String(mi?.menuItemId ?? "").trim();
    if (!mid) continue;
    if (mi?.imageUrlSnapshot) {
      snapshotImageByMenuId.set(mid, mi.imageUrlSnapshot);
    }
  }

  const needsLiveLookup = new Set();
  let needsEnrichment = false;
  for (const ev of booking.events) {
    const rows = ev?.eventSnapshot?.menu_items;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row?.image_url) continue;
      const id = String(row?.id ?? "").trim();
      if (!id) continue;
      needsEnrichment = true;
      if (!snapshotImageByMenuId.has(id)) {
        needsLiveLookup.add(id);
      }
    }
  }

  if (!needsEnrichment) return booking;

  const liveImageByMenuId = new Map();
  if (needsLiveLookup.size > 0) {
    const menuRows = await prisma.menuItem.findMany({
      where: { id: { in: [...needsLiveLookup] } },
      select: { id: true, imageUrl: true },
    });
    for (const m of menuRows) {
      liveImageByMenuId.set(m.id, m.imageUrl || null);
    }
  }

  const enrichedEvents = booking.events.map((ev) => {
    const snapshot = ev?.eventSnapshot;
    if (!snapshot || !Array.isArray(snapshot.menu_items)) return ev;
    const enrichedMenuItems = snapshot.menu_items.map((row) => {
      if (row?.image_url) return row;
      const id = String(row?.id ?? "").trim();
      if (!id) return row;
      const imageUrl = snapshotImageByMenuId.get(id) || liveImageByMenuId.get(id) || null;
      return imageUrl ? { ...row, image_url: imageUrl } : row;
    });
    return {
      ...ev,
      eventSnapshot: {
        ...snapshot,
        menu_items: enrichedMenuItems,
      },
    };
  });

  return {
    ...booking,
    events: enrichedEvents,
  };
}

async function generateUniqueBookingCode(tx, businessId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const n = Math.floor(Math.random() * 1000);
    const bookingCode = `KMT-R-${String(n).padStart(3, "0")}`;
    const exists = await tx.booking.findFirst({
      where: { businessId, bookingCode },
      select: { id: true },
    });
    if (!exists) return bookingCode;
  }
  throw new Error("BOOKING_CODE_ALLOC_FAILED");
}

function serializeBooking(b, { includePayments = true } = {}) {
  const menuItems = (b.menuItems || []).map((mi) => ({
    id: mi.id,
    menu_item_id: mi.menuItemId,
    quantity: mi.quantity ?? 1,
    price_per_plate_snapshot: num(mi.pricePerPlateSnapshot),
    name_snapshot: mi.nameSnapshot,
    image_url_snapshot: mi.imageUrlSnapshot,
  }));

  const payments =
    includePayments && b.payments
      ? b.payments.map((p) => ({
          id: p.id,
          amount: num(p.amount),
          method: p.method,
          created_at: p.createdAt?.toISOString?.() ?? p.createdAt,
        }))
      : undefined;

  // Customer address is the live default an event inherits when it has no
  // `eventLocation` of its own (legacy `b.eventLocation` kept as a last resort
  // for bookings created before `customerAddress` existed and not yet backfilled).
  const customerAddress = b.customerAddress ?? b.eventLocation ?? null;
  const resolveEventLoc = (own) =>
    typeof own === "string" && own.trim() ? own : customerAddress;

  let serializedEvents = (b.events || []).map((ev) => {
    const row = serializeBookingEvent(ev);
    return {
      ...row,
      // Event's own address stays as-is (null/empty = "inherit"); the resolved
      // value clients should actually display is `effective_event_location`.
      effective_event_location: resolveEventLoc(row.event_location),
    };
  });
  const hasEvents = serializedEvents.length > 0;
  const bookingAtIso = b.eventAt?.toISOString?.() ?? b.eventAt ?? null;

  if (hasEvents) {
    const first = serializedEvents[0];
    serializedEvents = [
      {
        ...first,
        // Older app builds read `events[0].event_location` directly, so keep it
        // populated with the inherited value for them; newer builds read
        // `event_location` (raw) + `effective_event_location` instead.
        event_location: resolveEventLoc(first.event_location),
        guest_count: first.guest_count ?? b.guestCount ?? null,
        event_at: first.event_at ?? bookingAtIso,
      },
      ...serializedEvents.slice(1),
    ];
  }

  const firstEvent = hasEvents ? serializedEvents[0] : null;
  const rootAt = firstEvent?.event_at ?? bookingAtIso;
  const rootLoc =
    firstEvent?.effective_event_location ?? customerAddress ?? null;
  const rootGuests = firstEvent?.guest_count ?? b.guestCount ?? null;
  const rootFn = b.functionType ?? null;

  const extraServiceLines = (b.extraServiceLines || []).map((line) => ({
    id: line.id,
    booking_id: line.bookingId,
    event_id: line.eventId ?? null,
    extra_service_id: line.extraServiceId,
    quantity: line.quantity ?? 1,
    unit_price_snapshot: num(line.unitPriceSnapshot),
    line_total: num(line.lineTotal),
    title_snapshot: line.titleSnapshot,
    pricing_type_snapshot: line.pricingTypeSnapshot,
  }));
  const extraCharges = extraServiceLines.reduce((s, l) => s + l.line_total, 0);

  return {
    id: b.id,
    business_id: b.businessId,
    status: b.status,
    step_number: b.stepNumber,
    booking_code: b.bookingCode,
    customer_name: b.customerName,
    customer_phone: b.customerPhone,
    customer_email: b.customerEmail,
    customer_address: b.customerAddress ?? null,
    event_range_start: b.eventRangeStart?.toISOString?.() ?? b.eventRangeStart,
    event_range_end: b.eventRangeEnd?.toISOString?.() ?? b.eventRangeEnd,
    event_at: rootAt,
    event_location: rootLoc,
    function_type: rootFn,
    guest_count: rootGuests,
    ...(!hasEvents ? { notes: b.notes } : {}),
    discount_amount: num(b.discountAmount),
    service_charge_pct: num(b.serviceChargePct),
    tax_pct: num(b.taxPct),
    subtotal: num(b.subtotal),
    service_charge_amount: num(b.serviceChargeAmount),
    tax_amount: num(b.taxAmount),
    total_due: num(b.totalDue),
    /** Mirrors `total_due` for clients that resolve totals from `final_amount`. */
    final_amount: num(b.totalDue),
    amount_paid: num(b.amountPaid),
    payment_status: paymentStatusFromAmounts(num(b.amountPaid), num(b.totalDue)),
    menu_items: menuItems,
    events: serializedEvents,
    extra_service_lines: extraServiceLines,
    extra_charges: extraCharges,
    ...(payments !== undefined ? { payments } : {}),
    can_edit_menu: canEditMenuBeforeEvent(firstEvent?.event_at ?? bookingAtIso, b.status),
    can_edit_customer_details: canEditCustomerDetailsBeforeEvent(
      firstEvent?.event_at ?? bookingAtIso,
      b.status,
    ),
    created_at: b.createdAt?.toISOString?.() ?? b.createdAt,
    updated_at: b.updatedAt?.toISOString?.() ?? b.updatedAt,
    completed_at: b.completedAt?.toISOString?.() ?? b.completedAt ?? null,
  };
}

/**
 * Lightweight list-row shape for the Orders list (`listBookings?lite=1`) — only the
 * fields a list card needs, so the query stays a cheap `select` instead of eagerly
 * loading every event's menu snapshot / extra service lines / payments per row.
 */
function serializeBookingListRow(b) {
  const events = b.events || [];
  const nextEvent = events[0];
  const nextEventAt = nextEvent?.eventAt ?? b.eventAt ?? null;
  // `events` is already pre-sorted eventAt asc, so the last row is the latest
  // event — used as a fallback span (first event to last event) only when the
  // booking has no explicit eventRangeStart/End (legacy bookings created
  // before the date-range picker existed).
  const lastEvent = events[events.length - 1];
  const lastEventAt = lastEvent?.eventAt ?? nextEventAt;
  // eventRangeStart/eventRangeEnd is the booking-level span the owner picked
  // up front when creating the booking (selectEvent.tsx) — the authoritative
  // "start to end" for a multi-day function, independent of how many
  // per-day BookingEvent rows were actually added under it.
  const rangeStart = b.eventRangeStart ?? nextEventAt;
  const rangeEnd = b.eventRangeEnd ?? lastEventAt;
  /** Deduped, chronological (events are pre-sorted by eventAt asc). */
  const jamanvarTypes = [
    ...new Set(events.map((ev) => ev.jamanvarType).filter(Boolean)),
  ];
  return {
    id: b.id,
    booking_code: b.bookingCode,
    customer_name: b.customerName,
    customer_phone: b.customerPhone,
    status: b.status,
    payment_status: paymentStatusFromAmounts(num(b.amountPaid), num(b.totalDue)),
    event_at: nextEventAt?.toISOString?.() ?? nextEventAt,
    event_start_at: rangeStart?.toISOString?.() ?? rangeStart,
    event_end_at: rangeEnd?.toISOString?.() ?? rangeEnd,
    jamanvar_types: jamanvarTypes,
    event_count: b._count?.events ?? events.length,
    guest_count: b.guestCount,
    total_due: num(b.totalDue),
    amount_paid: num(b.amountPaid),
    created_at: b.createdAt?.toISOString?.() ?? b.createdAt,
  };
}

function bookingEventTimestampsFromRow(b) {
  const events = [...(b.events || [])].sort((a, c) => {
    const ta = a.eventAt ? new Date(a.eventAt).getTime() : 0;
    const tb = c.eventAt ? new Date(c.eventAt).getTime() : 0;
    return ta - tb;
  });
  const ts = [];
  for (const ev of events) {
    if (ev.eventAt) {
      const t = new Date(ev.eventAt).getTime();
      if (!Number.isNaN(t)) ts.push(t);
    }
  }
  if (ts.length === 0 && b.eventAt) {
    const t = new Date(b.eventAt).getTime();
    if (!Number.isNaN(t)) ts.push(t);
  }
  return ts.sort((a, c) => a - c);
}

function bookingLatestEventMsFromRow(b) {
  const ts = bookingEventTimestampsFromRow(b);
  return ts.length ? ts[ts.length - 1] : NaN;
}

/**
 * Past-day confirmed booking that is still waiting manual completion.
 * Mirrors app-side rule used by dashboard/schedule.
 */
function bookingNeedsPastDayManualCompleteFromRow(b, now = new Date()) {
  if (!b || b.status !== "CONFIRMED") return false;
  if (b.completedAt) return false;
  const latest = bookingLatestEventMsFromRow(b);
  if (Number.isNaN(latest)) return false;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  return latest < startToday.getTime();
}

async function loadBookingForBusiness(bookingId, businessId, extras = {}) {
  return prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: {
      menuItems: true,
      extraServiceLines: true,
      events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
      ...(extras.includePayments
        ? { payments: { orderBy: { createdAt: "desc" } } }
        : {}),
    },
  });
}

/**
 * POST /v1/createBooking — create draft
 */
async function createBooking(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const body = req.body || {};

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        defaultServiceChargePct: true,
        defaultTaxPct: true,
      },
    });
    if (!business) {
      return errorResponse(res, "Business not found", 404, "NOT_FOUND");
    }

    const firstEvent =
      Array.isArray(body.events) && body.events.length > 0 ? body.events[0] : null;
    const sc = num(body.service_charge_pct ?? business.defaultServiceChargePct);
    const txp = num(body.tax_pct ?? business.defaultTaxPct);
    const pricing = computePricingFromSnapshots(
      [],
      body.guest_count ?? firstEvent?.guest_count ?? 0,
      body.discount_amount ?? 0,
      sc,
      txp,
    );

    const booking = await prisma.booking.create({
      data: {
        businessId,
        status: "DRAFT",
        stepNumber: Math.min(5, Math.max(1, parseInt(body.step_number, 10) || 1)),
        customerName: body.customer_name ?? null,
        customerPhone: body.customer_phone ?? null,
        customerEmail: body.customer_email ?? null,
        // Newer clients send `customer_address`; older ones only send
        // `event_location` from the same "customer info" field — accept either.
        customerAddress: body.customer_address ?? body.event_location ?? null,
        eventRangeStart: body.event_range_start
          ? new Date(body.event_range_start)
          : null,
        eventRangeEnd: body.event_range_end
          ? new Date(body.event_range_end)
          : null,
        eventAt:
          (firstEvent?.event_at ?? body.event_at)
            ? new Date(firstEvent?.event_at ?? body.event_at)
            : null,
        eventLocation: firstEvent?.event_location ?? body.event_location ?? null,
        functionType: firstEvent?.function_type ?? body.function_type ?? null,
        guestCount:
          firstEvent?.guest_count != null
            ? parseInt(firstEvent.guest_count, 10)
            : (body.guest_count != null ? parseInt(body.guest_count, 10) : null),
        notes: firstEvent?.notes ?? body.notes ?? null,
        discountAmount: new Prisma.Decimal(String(body.discount_amount ?? 0)),
        serviceChargePct: new Prisma.Decimal(String(sc)),
        taxPct: new Prisma.Decimal(String(txp)),
        subtotal: new Prisma.Decimal(String(pricing.subtotal)),
        serviceChargeAmount: new Prisma.Decimal(String(pricing.serviceChargeAmount)),
        taxAmount: new Prisma.Decimal(String(pricing.taxAmount)),
        totalDue: new Prisma.Decimal(String(pricing.totalDue)),
      },
    });

    if (Array.isArray(body.events) && body.events.length > 0) {
      await prisma.bookingEvent.createMany({
        data: body.events.map((ev) => ({
          bookingId: booking.id,
          eventAt: ev.event_at ? new Date(ev.event_at) : null,
          eventLocation: ev.event_location ?? null,
          functionType: null,
          jamanvarType:
            ev.jamanvar_type !== undefined && ev.jamanvar_type != null
              ? String(ev.jamanvar_type).trim()
              : ev.function_type != null && isStoredJamanvarSlug(ev.function_type)
                ? String(ev.function_type).trim()
                : null,
          guestCount: ev.guest_count != null ? parseInt(ev.guest_count, 10) : null,
          notes: ev.notes ?? null,
          status: ev.status ?? "PENDING",
          dishId: ev.dish_id ?? null,
          parentDishId: ev.parent_dish_id ?? null,
          isTemplate: ev.is_template ?? null,
          eventSnapshot: ev.event_snapshot ?? null,
          eventTotal:
            ev.event_total != null ? new Prisma.Decimal(String(ev.event_total)) : null,
        })),
      });
    }

    const withMenu = await loadBookingForBusiness(booking.id, businessId, {
      includePayments: true,
    });
    return successResponse(res, "Draft created", serializeBooking(withMenu));
  } catch (e) {
    console.error("createBooking:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * PATCH /v1/bookings/:id — draft or confirmed (menu edit on confirmed only before cutoff day)
 */
async function patchBooking(req, res) {
  try {
    const requestedLanguage = getRequestedLanguage(req);
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const bookingId = req.params.id;
    const body = req.body || {};

    const existing = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: false,
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status === "CANCELLED") {
      return errorResponse(res, "Cancelled booking cannot be updated", 200, "VALIDATION_ERROR");
    }

    // Optimistic concurrency guard (plan: updated_at conflict check).
    if (body.updated_at) {
      const clientUpdatedAt = new Date(body.updated_at).toISOString();
      const serverUpdatedAt = new Date(existing.updatedAt).toISOString();
      if (clientUpdatedAt !== serverUpdatedAt) {
        return errorResponse(
          res,
          "This booking changed on another device. Please refresh before saving.",
          409,
          "WRITE_CONFLICT",
        );
      }
    }

    const isDraft = existing.status === "DRAFT";
    const menuItemIds = Array.isArray(body.menu_item_ids) ? body.menu_item_ids : null;
    const menuLines = Array.isArray(body.menu_items) ? body.menu_items : null;
    const firstEvent =
      Array.isArray(body.events) && body.events.length > 0 ? body.events[0] : null;
    const nextEventAt = firstEvent?.event_at ?? body.event_at;
    const nextEventLocation =
      body.event_location !== undefined
        ? body.event_location
        : firstEvent?.event_location ?? undefined;
    const nextFunctionType = firstEvent?.function_type ?? body.function_type;
    const nextGuestCount = firstEvent?.guest_count ?? body.guest_count;
    const nextNotes = firstEvent?.notes ?? body.notes;

    const confirmedLimitedPatch = !isDraft && isConfirmedLimitedPatch(body);
    const eventAtForCutoff = primaryEventAtFromRow(existing);

    // Post-confirm: customer + event details (>12h before event); menu still locked.
    if (!isDraft) {
      const touchesMenu = menuItemIds != null || menuLines != null;
      const touchesEvents = Array.isArray(body.events);
      const touchesEventFields =
        body.event_at !== undefined ||
        body.event_location !== undefined ||
        body.function_type !== undefined ||
        body.guest_count !== undefined ||
        body.notes !== undefined;

      if (confirmedLimitedPatch) {
        if (!canEditBeforeEventCutoff(eventAtForCutoff, existing.status)) {
          return errorResponse(
            res,
            "Booking details can only be updated more than 12 hours before the event.",
            200,
            "VALIDATION_ERROR",
          );
        }
        if (touchesMenu) {
          return errorResponse(
            res,
            "Confirmed booking is locked for menu updates.",
            200,
            "VALIDATION_ERROR",
          );
        }
      } else if (touchesMenu || touchesEvents || touchesEventFields) {
        return errorResponse(
          res,
          "Confirmed booking is locked for event/menu updates.",
          200,
          "VALIDATION_ERROR",
        );
      } else if (
        body.customer_name !== undefined ||
        body.customer_phone !== undefined ||
        body.customer_email !== undefined ||
        body.customer_address !== undefined
      ) {
        return errorResponse(
          res,
          "Confirmed booking is locked for customer updates.",
          200,
          "VALIDATION_ERROR",
        );
      }
    }

    if (menuItemIds != null || menuLines != null) {
      const menuCutoffAt = primaryEventAtFromRow(existing) ?? existing.eventAt;
      if (!canEditMenuBeforeEvent(menuCutoffAt, existing.status)) {
        return errorResponse(
          res,
          "Menu can only be edited more than 12 hours before the event.",
          200,
          "VALIDATION_ERROR",
        );
      }

      let lines = [];
      if (menuLines && menuLines.length > 0) {
        lines = menuLines.map((row) => ({
          id: String(row.menu_item_id ?? row.menuItemId ?? "").trim(),
          qty: Math.max(1, Math.min(999, parseInt(String(row.quantity ?? 1), 10) || 1)),
        })).filter((x) => x.id);
      } else if (menuItemIds) {
        lines = menuItemIds.map((x) => ({
          id: String(x).trim(),
          qty: 1,
        })).filter((x) => x.id);
      }

      const merged = new Map();
      for (const line of lines) {
        merged.set(line.id, (merged.get(line.id) ?? 0) + line.qty);
      }
      const mergedLines = [...merged.entries()].map(([id, qty]) => ({
        id,
        qty: Math.min(999, Math.max(1, qty)),
      }));

      const ids = mergedLines.map((l) => l.id);
      const menus = await prisma.menuItem.findMany({
        where: { id: { in: ids } },
      });
      if (menus.length !== ids.length) {
        return errorResponse(res, "One or more menu items not found", 200, "VALIDATION_ERROR");
      }
      for (const m of menus) {
        if (!canViewMenuItem(m, businessId, userId)) {
          return errorResponse(res, "Forbidden menu item in selection", 403, "FORBIDDEN");
        }
      }

      await prisma.bookingMenuItem.deleteMany({ where: { bookingId } });
      const menuById = new Map(menus.map((m) => [m.id, m]));
      const createRows = mergedLines.map((line) => {
        const m = menuById.get(line.id);
        return {
          bookingId,
          menuItemId: m.id,
          quantity: line.qty,
          pricePerPlateSnapshot: m.pricePerPerson,
          nameSnapshot: resolveLocalizedName(m.name, requestedLanguage),
          imageUrlSnapshot: m.imageUrl,
        };
      });
      if (createRows.length) {
        await prisma.bookingMenuItem.createMany({ data: createRows });
      }
    }

    if (
      confirmedLimitedPatch &&
      !isDraft &&
      body.event_at !== undefined &&
      !Array.isArray(body.events)
    ) {
      const sortedEvents = [...(existing.events || [])].sort((a, c) => {
        const ta = a.eventAt ? new Date(a.eventAt).getTime() : 0;
        const tb = c.eventAt ? new Date(c.eventAt).getTime() : 0;
        return ta - tb;
      });
      const primary = sortedEvents[0];
      if (primary?.id) {
        await prisma.bookingEvent.update({
          where: { id: primary.id },
          data: {
            eventAt: body.event_at ? new Date(body.event_at) : null,
          },
        });
      }
    }

    if (Array.isArray(body.events) && confirmedLimitedPatch && !isDraft) {
      const confirmedEventUpdates = [];
      for (const rawEvent of body.events) {
        const ev = rawEvent || {};
        if (!ev.id) {
          return errorResponse(
            res,
            "Cannot add events to a confirmed booking from this screen.",
            200,
            "VALIDATION_ERROR",
          );
        }
        const exists = (existing.events || []).find((row) => row.id === ev.id);
        if (!exists) {
          return errorResponse(res, "Event not found", 404, "NOT_FOUND");
        }
        const cutoffAt = exists.eventAt ?? eventAtForCutoff;
        if (!canEditBeforeEventCutoff(cutoffAt)) {
          // return errorResponse(
          //   res,
          //   "Event can only be updated more than 48 hours before the event time.",
          //   200,
          //   "VALIDATION_ERROR",
          // );
        }
        const nextEventAtForMenu =
          ev.event_at !== undefined
            ? ev.event_at
              ? new Date(ev.event_at)
              : null
            : exists.eventAt;
        // The bulk `events` path historically dropped menu/snapshot fields on a
        // confirmed booking. Apply them here too, still gated by the same 12h
        // menu-edit window, so editing an event's menu from the "Update Event"
        // screen works (not just the dedicated single-event endpoint). Compare
        // against the stored values so an unchanged snapshot passed through for a
        // non-target event never trips the window check.
        const menuEditAllowed = canEditMenuBeforeEvent(
          nextEventAtForMenu ?? cutoffAt,
          existing.status,
        );
        const snapshotChanged =
          ev.event_snapshot !== undefined &&
          JSON.stringify(ev.event_snapshot ?? null) !==
            JSON.stringify(exists.eventSnapshot ?? null);
        const dishFieldsChanged =
          (ev.dish_id !== undefined && ev.dish_id !== (exists.dishId ?? null)) ||
          (ev.parent_dish_id !== undefined &&
            ev.parent_dish_id !== (exists.parentDishId ?? null)) ||
          (ev.is_template !== undefined &&
            Boolean(ev.is_template) !== Boolean(exists.isTemplate));
        const touchesEventMenu = snapshotChanged || dishFieldsChanged;
        if (touchesEventMenu && !menuEditAllowed) {
          return errorResponse(
            res,
            "Menu can only be edited more than 12 hours before the event.",
            200,
            "VALIDATION_ERROR",
          );
        }
        confirmedEventUpdates.push({
          id: ev.id,
          data: {
            eventAt: nextEventAtForMenu,
            eventLocation:
              ev.event_location !== undefined ? ev.event_location : exists.eventLocation,
            functionType: null,
            jamanvarType: jamanvarTypeFromEventBody(ev, exists),
            guestCount:
              ev.guest_count !== undefined
                ? ev.guest_count != null
                  ? parseInt(ev.guest_count, 10)
                  : null
                : exists.guestCount,
            notes: ev.notes !== undefined ? ev.notes : exists.notes,
            status: ev.status !== undefined ? ev.status : exists.status,
            ...(touchesEventMenu && menuEditAllowed
              ? {
                  eventSnapshot:
                    ev.event_snapshot !== undefined
                      ? ev.event_snapshot
                      : exists.eventSnapshot,
                  dishId:
                    ev.dish_id !== undefined ? ev.dish_id : exists.dishId,
                  parentDishId:
                    ev.parent_dish_id !== undefined
                      ? ev.parent_dish_id
                      : exists.parentDishId,
                  isTemplate:
                    ev.is_template !== undefined
                      ? Boolean(ev.is_template)
                      : exists.isTemplate,
                }
              : {}),
          },
        });
      }
      if (confirmedEventUpdates.length) {
        await prisma.$transaction(
          confirmedEventUpdates.map((row) =>
            prisma.bookingEvent.update({ where: { id: row.id }, data: row.data }),
          ),
        );
      }
    }

    if (Array.isArray(body.events) && !(confirmedLimitedPatch && !isDraft)) {
      for (const rawEvent of body.events) {
        const ev = rawEvent || {};
        if (!ev.id) continue;
        const cur = (existing.events || []).find((row) => row.id === ev.id);
        // if (cur?.eventAt && !canEditBeforeEventCutoff(cur.eventAt)) {
        //   return errorResponse(
        //     res,
        //     "Event can only be updated more than 48 hours before the event time.",
        //     200,
        //     "VALIDATION_ERROR",
        //   );
        // }
      }
      await prisma.$transaction(async (tx) => {
        const existingEvents = await tx.bookingEvent.findMany({
          where: { bookingId },
          select: {
            id: true,
            eventAt: true,
            eventLocation: true,
            functionType: true,
            jamanvarType: true,
            guestCount: true,
            notes: true,
            status: true,
            dishId: true,
            parentDishId: true,
            isTemplate: true,
            eventSnapshot: true,
            eventTotal: true,
          },
        });
        const existingById = new Map(existingEvents.map((ev) => [ev.id, ev]));
        const keepIds = [];

        for (const rawEvent of body.events) {
          const ev = rawEvent || {};
          const current = ev.id ? existingById.get(ev.id) : null;
          const payload = current
            ? {
                eventAt:
                  ev.event_at !== undefined
                    ? (ev.event_at ? new Date(ev.event_at) : null)
                    : current.eventAt,
                eventLocation:
                  ev.event_location !== undefined ? ev.event_location : current.eventLocation,
                functionType: null,
                jamanvarType: jamanvarTypeFromEventBody(ev, current),
                guestCount:
                  ev.guest_count !== undefined
                    ? (ev.guest_count != null ? parseInt(ev.guest_count, 10) : null)
                    : current.guestCount,
                notes: ev.notes !== undefined ? ev.notes : current.notes,
                status: ev.status !== undefined ? ev.status : current.status,
                dishId: ev.dish_id !== undefined ? ev.dish_id : current.dishId,
                parentDishId:
                  ev.parent_dish_id !== undefined ? ev.parent_dish_id : current.parentDishId,
                isTemplate:
                  ev.is_template !== undefined ? ev.is_template : current.isTemplate,
                eventSnapshot:
                  ev.event_snapshot !== undefined ? ev.event_snapshot : current.eventSnapshot,
                eventTotal:
                  ev.event_total !== undefined
                    ? (ev.event_total != null ? new Prisma.Decimal(String(ev.event_total)) : null)
                    : current.eventTotal,
              }
            : {
                eventAt: ev.event_at ? new Date(ev.event_at) : null,
                eventLocation: ev.event_location ?? null,
                functionType: null,
                jamanvarType: jamanvarTypeFromEventBody(ev, null),
                guestCount: ev.guest_count != null ? parseInt(ev.guest_count, 10) : null,
                notes: ev.notes ?? null,
                status: ev.status ?? "PENDING",
                dishId: ev.dish_id ?? null,
                parentDishId: ev.parent_dish_id ?? null,
                isTemplate: ev.is_template ?? null,
                eventSnapshot: ev.event_snapshot ?? null,
                eventTotal:
                  ev.event_total != null ? new Prisma.Decimal(String(ev.event_total)) : null,
              };

          if (current) {
            await tx.bookingEvent.update({
              where: { id: ev.id },
              data: payload,
            });
            keepIds.push(ev.id);
          } else {
            const created = await tx.bookingEvent.create({
              data: {
                bookingId,
                ...payload,
              },
              select: { id: true },
            });
            keepIds.push(created.id);
          }
        }

        await tx.bookingEvent.deleteMany({
          where: {
            bookingId,
            ...(keepIds.length ? { id: { notIn: keepIds } } : {}),
          },
        });
      });
    }

    const guests =
      body.guest_count != null ? parseInt(body.guest_count, 10) : existing.guestCount ?? 0;
    const discount = body.discount_amount != null ? num(body.discount_amount) : num(existing.discountAmount);
    const sc =
      body.service_charge_pct != null ? num(body.service_charge_pct) : num(existing.serviceChargePct);
    const txp = body.tax_pct != null ? num(body.tax_pct) : num(existing.taxPct);

    const needsPricingRecalc = patchTouchesBookingPricing(body, existing);
    let pricing = needsPricingRecalc
      ? computePricingFromSnapshots(
          await prisma.bookingMenuItem.findMany({ where: { bookingId } }),
          guests,
          discount,
          sc,
          txp,
        )
      : {
          subtotal: num(existing.subtotal),
          serviceChargeAmount: num(existing.serviceChargeAmount),
          taxAmount: num(existing.taxAmount),
          totalDue: num(existing.totalDue),
        };
    const dueSnapshot = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        serviceChargeAmount: true,
        serviceChargePct: true,
        taxAmount: true,
        taxPct: true,
        discountAmount: true,
        events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
        extraServiceLines: true,
      },
    });
    // `dueSnapshot` is read before the update, so its discount/tax/service still
    // hold the OLD values. Overlay the incoming ones so the event-derived total
    // reflects this patch (otherwise a discount/tax/service edit persists the new
    // percentages but leaves total_due computed from the previous values).
    const dueBasis = {
      ...(dueSnapshot || existing),
      serviceChargePct: sc,
      serviceChargeAmount: pricing.serviceChargeAmount,
      taxPct: txp,
      taxAmount: pricing.taxAmount,
      discountAmount: discount,
    };
    const totalFromEvents = computeBookingTotalDueFromEvents(dueBasis);
    if (totalFromEvents > 0) {
      pricing = { ...pricing, totalDue: totalFromEvents };
    }

    if (num(existing.amountPaid) > pricing.totalDue + 0.02) {
      return errorResponse(
        res,
        "Recorded payments exceed the new total. Adjust before changing the booking.",
        200,
        "VALIDATION_ERROR",
      );
    }

    const baseData = {
      customerName: body.customer_name !== undefined ? body.customer_name : existing.customerName,
      customerPhone: body.customer_phone !== undefined ? body.customer_phone : existing.customerPhone,
      customerEmail: body.customer_email !== undefined ? body.customer_email : existing.customerEmail,
      customerAddress:
        body.customer_address !== undefined
          ? body.customer_address
          : existing.customerAddress,
      eventRangeStart:
        body.event_range_start !== undefined
          ? (body.event_range_start ? new Date(body.event_range_start) : null)
          : existing.eventRangeStart,
      eventRangeEnd:
        body.event_range_end !== undefined
          ? (body.event_range_end ? new Date(body.event_range_end) : null)
          : existing.eventRangeEnd,
      eventAt:
        nextEventAt !== undefined ? (nextEventAt ? new Date(nextEventAt) : null) : existing.eventAt,
      eventLocation: nextEventLocation !== undefined ? nextEventLocation : existing.eventLocation,
      functionType: nextFunctionType !== undefined ? nextFunctionType : existing.functionType,
      guestCount: nextGuestCount != null ? parseInt(nextGuestCount, 10) : existing.guestCount,
      notes: nextNotes !== undefined ? nextNotes : existing.notes,
      discountAmount: new Prisma.Decimal(String(discount)),
      serviceChargePct: new Prisma.Decimal(String(sc)),
      taxPct: new Prisma.Decimal(String(txp)),
      subtotal: new Prisma.Decimal(String(pricing.subtotal)),
      serviceChargeAmount: new Prisma.Decimal(String(pricing.serviceChargeAmount)),
      taxAmount: new Prisma.Decimal(String(pricing.taxAmount)),
      totalDue: new Prisma.Decimal(String(pricing.totalDue)),
      paymentStatus: paymentStatusFromAmounts(existing.amountPaid, pricing.totalDue),
    };

    const draftOnly =
      isDraft && body.step_number != null
        ? {
            stepNumber: Math.min(5, Math.max(1, parseInt(body.step_number, 10))),
          }
        : {};

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        ...baseData,
        ...draftOnly,
      },
      include: {
        menuItems: true,
        events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
      },
    });

    return successResponse(
      res,
      "Booking updated",
      serializeBooking(updated, { includePayments: false }),
    );
  } catch (e) {
    console.error("patchBooking:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * PATCH /v1/bookings/:id/updateEvent/:eventId — update a single event safely
 */
async function updateEvent(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;
    const body = req.body || {};

    const existing = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status === "CANCELLED") {
      return errorResponse(res, "Cancelled booking cannot be updated", 200, "VALIDATION_ERROR");
    }
    if (existing.status !== "DRAFT" && existing.status !== "CONFIRMED") {
      return errorResponse(
        res,
        "This booking cannot be updated.",
        200,
        "VALIDATION_ERROR",
      );
    }

    if (body.updated_at) {
      const clientUpdatedAt = new Date(body.updated_at).toISOString();
      const serverUpdatedAt = new Date(existing.updatedAt).toISOString();
      if (clientUpdatedAt !== serverUpdatedAt) {
        return errorResponse(
          res,
          "This booking changed on another device. Please refresh before saving.",
          409,
          "WRITE_CONFLICT",
        );
      }
    }

    const current = (existing.events || []).find((ev) => ev.id === eventId);
    if (!current) {
      return errorResponse(res, "Event not found", 404, "NOT_FOUND");
    }
    // if (!canEditBeforeEventCutoff(current.eventAt)) {
    //   return errorResponse(
    //     res,
    //     "Event can only be updated more than 48 hours before the event time.",
    //     200,
    //     "VALIDATION_ERROR",
    //   );
    // }

    await prisma.bookingEvent.update({
      where: { id: eventId },
      data: {
        eventAt:
          body.event_at !== undefined ? (body.event_at ? new Date(body.event_at) : null) : current.eventAt,
        eventLocation:
          body.event_location !== undefined ? body.event_location : current.eventLocation,
        functionType: null,
        jamanvarType: jamanvarTypeFromEventBody(body, current),
        guestCount:
          body.guest_count !== undefined
            ? (body.guest_count != null ? parseInt(body.guest_count, 10) : null)
            : current.guestCount,
        notes: body.notes !== undefined ? body.notes : current.notes,
        status: body.status !== undefined ? body.status : current.status,
        dishId: body.dish_id !== undefined ? body.dish_id : current.dishId,
        parentDishId:
          body.parent_dish_id !== undefined ? body.parent_dish_id : current.parentDishId,
        isTemplate: body.is_template !== undefined ? body.is_template : current.isTemplate,
        eventSnapshot:
          body.event_snapshot !== undefined ? body.event_snapshot : current.eventSnapshot,
        eventTotal:
          body.event_total !== undefined
            ? (body.event_total != null ? new Prisma.Decimal(String(body.event_total)) : null)
            : current.eventTotal,
      },
    });

    if (body.step_number != null) {
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          stepNumber: Math.min(5, Math.max(1, parseInt(body.step_number, 10) || 1)),
        },
      });
    }

    const updated = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    return successResponse(res, "Event updated", serializeBooking(updated));
  } catch (e) {
    console.error("updateEvent:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * PATCH /v1/bookings/:id/events/:eventId/replaceMenuItem
 *
 * Swaps one menu item id for another inside this event's `event_snapshot.menu_items`,
 * keeping every other field on that row (quantity_per_plate, price overrides, etc.)
 * untouched. Used right after a per-event recipe save forks a business-private copy
 * of a global catalog menu item (see menuController.updateMenuItem) — without this,
 * the event would keep pointing at the untouched original and never see the newly
 * saved recipe quantities.
 */
async function replaceEventMenuItem(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;
    const oldMenuItemId = String(req.body?.old_menu_item_id || "").trim();
    const newMenuItemId = String(req.body?.new_menu_item_id || "").trim();
    if (!oldMenuItemId || !newMenuItemId) {
      return errorResponse(
        res,
        "old_menu_item_id and new_menu_item_id are required",
        200,
        "VALIDATION_ERROR",
      );
    }

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true, status: true },
    });
    if (!booking) return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    if (booking.status === "CANCELLED") {
      return errorResponse(
        res,
        "Cancelled booking cannot be updated",
        200,
        "VALIDATION_ERROR",
      );
    }

    const event = await prisma.bookingEvent.findFirst({
      where: { id: eventId, bookingId },
      select: { id: true, eventSnapshot: true },
    });
    if (!event) return errorResponse(res, "Event not found", 404, "NOT_FOUND");

    const snapshot = event.eventSnapshot;
    const menuItems = Array.isArray(snapshot?.menu_items) ? snapshot.menu_items : [];
    let changed = false;
    const nextMenuItems = menuItems.map((row) => {
      if (String(row?.id ?? "").trim() === oldMenuItemId) {
        changed = true;
        return { ...row, id: newMenuItemId };
      }
      return row;
    });

    if (!changed) {
      return successResponse(res, "No matching menu item in this event", {
        updated: false,
      });
    }

    await prisma.bookingEvent.update({
      where: { id: eventId },
      data: {
        eventSnapshot: { ...snapshot, menu_items: nextMenuItems },
      },
    });

    return successResponse(res, "Event menu item replaced", { updated: true });
  } catch (e) {
    console.error("replaceEventMenuItem:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/bookings/:id/createEvent — create single event in draft booking
 */
async function createEvent(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const body = req.body || {};

    const existing = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status === "CANCELLED") {
      return errorResponse(res, "Cancelled booking cannot be updated", 200, "VALIDATION_ERROR");
    }
    if (existing.completedAt) {
      return errorResponse(res, "Completed booking cannot be updated", 200, "VALIDATION_ERROR");
    }
    // DRAFT: full booking-setup flow. CONFIRMED: adding an extra event to an
    // already-confirmed booking (e.g. from the booking summary screen) — the
    // bulk `events` array on updateBooking deliberately rejects this, so new
    // events for a confirmed booking are created one at a time, here.
    if (existing.status !== "DRAFT" && existing.status !== "CONFIRMED") {
      return errorResponse(
        res,
        "Confirmed booking is locked for event/menu updates.",
        200,
        "VALIDATION_ERROR",
      );
    }

    if (body.updated_at) {
      const clientUpdatedAt = new Date(body.updated_at).toISOString();
      const serverUpdatedAt = new Date(existing.updatedAt).toISOString();
      if (clientUpdatedAt !== serverUpdatedAt) {
        return errorResponse(
          res,
          "This booking changed on another device. Please refresh before saving.",
          409,
          "WRITE_CONFLICT",
        );
      }
    }

    await prisma.bookingEvent.create({
      data: {
        bookingId,
        eventAt: body.event_at ? new Date(body.event_at) : null,
        eventLocation: body.event_location ?? null,
        functionType: null,
        jamanvarType: jamanvarTypeFromEventBody(body, null),
        guestCount: body.guest_count != null ? parseInt(body.guest_count, 10) : null,
        notes: body.notes ?? null,
        status: body.status ?? "PENDING",
        dishId: body.dish_id ?? null,
        parentDishId: body.parent_dish_id ?? null,
        isTemplate: body.is_template ?? null,
        eventSnapshot: body.event_snapshot ?? null,
        eventTotal:
          body.event_total != null ? new Prisma.Decimal(String(body.event_total)) : null,
      },
    });

    if (body.step_number != null) {
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          stepNumber: Math.min(5, Math.max(1, parseInt(body.step_number, 10) || 1)),
        },
      });
    }

    const updated = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    return successResponse(res, "Event created", serializeBooking(updated));
  } catch (e) {
    console.error("createEvent:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * DELETE /v1/bookings/:id/deleteEvent/:eventId — delete single event
 */
async function deleteEvent(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;

    const existing = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status === "CANCELLED") {
      return errorResponse(res, "Cancelled booking cannot be updated", 200, "VALIDATION_ERROR");
    }
    if (existing.status !== "DRAFT") {
      return errorResponse(
        res,
        "Confirmed booking is locked for event/menu updates.",
        200,
        "VALIDATION_ERROR",
      );
    }

    const currentEvents = existing.events || [];
    const target = currentEvents.find((ev) => ev.id === eventId);
    if (!target) {
      return errorResponse(res, "Event not found", 404, "NOT_FOUND");
    }
    if (currentEvents.length <= 1) {
      return errorResponse(
        res,
        "Cannot delete the last event. Delete booking instead.",
        200,
        "VALIDATION_ERROR",
      );
    }
    if (!canEditBeforeEventCutoff(target.eventAt, existing.status)) {
      return errorResponse(
        res,
        "Event can only be deleted more than 12 hours before the event time.",
        200,
        "VALIDATION_ERROR",
      );
    }

    await prisma.bookingEvent.delete({ where: { id: eventId } });

    const updated = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    return successResponse(res, "Event deleted", serializeBooking(updated));
  } catch (e) {
    console.error("deleteEvent:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/** Earliest event time for a booking, or legacy booking.eventAt (matches dashboard bucketing). */
function deriveBookingEventMs(b) {
  const evs = b.events || [];
  let best = NaN;
  for (const ev of evs) {
    if (!ev.eventAt) continue;
    const t = new Date(ev.eventAt).getTime();
    if (!Number.isNaN(t)) {
      if (Number.isNaN(best) || t < best) best = t;
    }
  }
  if (!Number.isNaN(best)) return best;
  if (b.eventAt) {
    const t = new Date(b.eventAt).getTime();
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

/**
 * GET /v1/dashboard — home-tab aggregates for the mobile app.
 */
async function getDashboard(req, res) {
  try {
    const businessId = req.businessId;
    const now = new Date();

    const [confirmedRows, draftCount, upcomingOrdersCount] = await Promise.all([
      prisma.booking.findMany({
        where: { businessId, status: "CONFIRMED" },
        orderBy: { createdAt: "desc" },
        take: 500,
        include: {
          menuItems: true,
          extraServiceLines: true,
          events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
          payments: { orderBy: { createdAt: "desc" }, take: 5 },
        },
      }),
      prisma.booking.count({ where: { businessId, status: "DRAFT" } }),
      // Matches listBookings' own event_from=now filter, so this count stays
      // consistent with what the Orders list actually shows when opened.
      prisma.booking.count({
        where: {
          businessId,
          status: "CONFIRMED",
          OR: [
            { eventAt: { gte: now } },
            { events: { some: { eventAt: { gte: now } } } },
          ],
        },
      }),
    ]);

    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(startToday);
    endToday.setDate(endToday.getDate() + 1);
    const endTwoDay = new Date(startToday);
    endTwoDay.setDate(endTwoDay.getDate() + 2);

    const paymentDueTotal = confirmedRows.reduce((sum, b) => {
      const outstanding = Math.max(0, num(b.totalDue) - num(b.amountPaid));
      return sum + outstanding;
    }, 0);

    const todayRaw = [];
    const twoDayRaw = [];
    const upcomingRaw = [];
    const completedRaw = [];
    const pendingManualCompletionRaw = [];

    for (const b of confirmedRows) {
      const t = deriveBookingEventMs(b);
      if (Number.isNaN(t)) continue;
      if (t >= startToday.getTime() && t < endToday.getTime()) {
        todayRaw.push({ b, t });
      }
      if (t >= startToday.getTime() && t < endTwoDay.getTime()) {
        twoDayRaw.push({ b, t });
      }
      if (t >= endToday.getTime()) {
        upcomingRaw.push({ b, t });
      }
      if (b.completedAt) {
        completedRaw.push({ b, t });
      }
      if (bookingNeedsPastDayManualCompleteFromRow(b, now)) {
        pendingManualCompletionRaw.push({ b, t });
      }
    }

    todayRaw.sort((a, b) => a.t - b.t);
    upcomingRaw.sort((a, b) => a.t - b.t);
    completedRaw.sort((a, b) => b.t - a.t);
    pendingManualCompletionRaw.sort((a, b) => a.t - b.t);

    const ordersToPrepare = twoDayRaw.filter(({ t }) => t >= now.getTime()).length;

    const payload = {
      today_event_count: todayRaw.length,
      two_day_event_count: twoDayRaw.length,
      draft_count: draftCount,
      payment_due_total: paymentDueTotal,
      orders_to_prepare_count: ordersToPrepare,
      upcoming_orders_count: upcomingOrdersCount,
      today_timeline: todayRaw.map(({ b }) => serializeBooking(b)),
      upcoming_bookings: upcomingRaw.slice(0, 5).map(({ b }) => serializeBooking(b)),
      completed_orders: completedRaw.slice(0, 5).map(({ b }) => serializeBooking(b)),
      pending_manual_completion: pendingManualCompletionRaw
        .slice(0, 10)
        .map(({ b }) => serializeBooking(b)),
    };

    return successResponse(res, "OK", payload);
  } catch (e) {
    console.error("getDashboard:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * GET /v1/bookings/customers/search?q=...&limit=10
 * Distinct past customers for autocomplete (min 3 characters).
 */
async function searchBookingCustomers(req, res) {
  try {
    const businessId = req.businessId;
    const q = (
      queryStringParam(req.query.q) || queryStringParam(req.query.search)
    )
      .trim()
      .slice(0, 80);

    if (q.length < 3) {
      return successResponse(res, "OK", { customers: [] });
    }

    const take = queryNumberParam(req.query.limit, 10, { min: 1, max: 15 });
    const ic = { contains: q, mode: "insensitive" };

    const rows = await prisma.booking.findMany({
      where: {
        businessId,
        OR: [
          { customerName: ic },
          { customerPhone: ic },
          { customerEmail: ic },
        ],
      },
      select: {
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        customerAddress: true,
        eventLocation: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 40,
    });

    const seen = new Set();
    const customers = [];
    for (const row of rows) {
      const name = String(row.customerName ?? "").trim();
      const phone = String(row.customerPhone ?? "").trim();
      const email = String(row.customerEmail ?? "").trim();
      const address = String(row.customerAddress ?? row.eventLocation ?? "").trim();
      if (!name && !phone) continue;
      const key = phone
        ? `p:${phone}`
        : `n:${name.toLowerCase()}|${email.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      customers.push({
        customer_name: name || null,
        customer_phone: phone || null,
        customer_email: email || null,
        customer_address: address || null,
        // Legacy alias kept so older app builds still prefill something.
        event_location: address || null,
      });
      if (customers.length >= take) break;
    }

    return successResponse(res, "OK", { customers });
  } catch (e) {
    console.error("searchBookingCustomers:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * GET /v1/bookings
 */
async function listBookings(req, res) {
  try {
    const businessId = req.businessId;
    const {
      status,
      payment_status,
      event_from,
      event_to,
      created_from,
      created_to,
      completed_from,
      completed_to,
      manual_completed_only,
      limit,
      offset,
    } = req.query;

    /** Read from req.query so `q` is never dropped by destructuring; alias `search` for proxies. */
    const searchQRaw = (
      queryStringParam(req.query.q) || queryStringParam(req.query.search)
    )
      .trim()
      .slice(0, 160);
    const isLite = req.query.lite === "1" || req.query.lite === "true";
    const nameOnly = req.query.name_only === "1" || req.query.name_only === "true";

    /** Single explicit AND avoids Prisma quirks mixing top-level filters with `where.AND`. */
    const clauses = [{ businessId }];
    if (status) {
      clauses.push({ status });
    }
    if (payment_status) {
      const normalizedPaymentStatus =
        payment_status === "PAID" ? "RECEIVED" : payment_status;
      clauses.push({ paymentStatus: normalizedPaymentStatus });
    }
    if (event_from || event_to) {
      const eventRange = {};
      if (event_from) eventRange.gte = new Date(event_from);
      if (event_to) eventRange.lte = new Date(event_to);
      /** Match legacy `booking.eventAt` OR any child `BookingEvent.eventAt` in range. */
      clauses.push({
        OR: [
          { eventAt: eventRange },
          {
            events: {
              some: {
                eventAt: eventRange,
              },
            },
          },
        ],
      });
    }
    if (searchQRaw.length > 0) {
      const ic = { contains: searchQRaw, mode: "insensitive" };
      if (nameOnly) {
        /** Orders screen: search matches the customer/order name only. */
        clauses.push({ customerName: ic });
      } else {
        /** Match client, contact, booking code, venues, types, notes; nested events. */
        const eventRowsOr = [
          { eventLocation: ic },
          { functionType: ic },
          { notes: ic },
        ];
        clauses.push({
          OR: [
            { customerName: ic },
            { customerPhone: ic },
            { bookingCode: ic },
            { customerEmail: ic },
            { eventLocation: ic },
            { functionType: ic },
            { notes: ic },
            {
              events: {
                some: {
                  OR: eventRowsOr,
                },
              },
            },
          ],
        });
      }
    }
    if (created_from || created_to) {
      const createdAt = {};
      if (created_from) createdAt.gte = new Date(created_from);
      if (created_to) createdAt.lte = new Date(created_to);
      clauses.push({ createdAt });
    }
    if (completed_from || completed_to) {
      const completedAt = {};
      if (completed_from) completedAt.gte = new Date(completed_from);
      if (completed_to) completedAt.lte = new Date(completed_to);
      clauses.push({ completedAt });
    } else if (manual_completed_only === "true") {
      clauses.push({ completedAt: { not: null } });
    }

    const where = { AND: clauses };

    const take = queryNumberParam(limit, 50, { min: 1, max: 200 });
    const skip = queryNumberParam(offset, 0, { min: 0, max: 100_000 });

    const useCompletionSort =
      manual_completed_only === "true" || completed_from || completed_to;

    const [rows, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: useCompletionSort
          ? [{ completedAt: "desc" }, { createdAt: "desc" }]
          : { createdAt: "desc" },
        take,
        skip,
        ...(isLite
          ? {
              select: {
                id: true,
                bookingCode: true,
                customerName: true,
                customerPhone: true,
                status: true,
                paymentStatus: true,
                eventAt: true,
                eventRangeStart: true,
                eventRangeEnd: true,
                guestCount: true,
                totalDue: true,
                amountPaid: true,
                createdAt: true,
                /** All events (not just the next one) — small rows, needed for the meal-type list on the Orders card. */
                events: {
                  select: { eventAt: true, jamanvarType: true },
                  orderBy: { eventAt: "asc" },
                },
                _count: { select: { events: true } },
              },
            }
          : {
              include: {
                menuItems: true,
                extraServiceLines: true,
                events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
                payments: { orderBy: { createdAt: "desc" }, take: 5 },
              },
            }),
      }),
      prisma.booking.count({ where }),
    ]);

    const has_more = skip + rows.length < total;

    return successResponse(res, "OK", {
      bookings: rows.map((b) => (isLite ? serializeBookingListRow(b) : serializeBooking(b))),
      total,
      limit: take,
      offset: skip,
      has_more,
    });
  } catch (e) {
    console.error("listBookings:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * GET /v1/bookings/:id
 */
async function getBooking(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const includePayments =
      req.query.include_payments === "1" || req.query.include_payments === "true";
    const skipImageEnrich =
      req.query.enrich_images === "0" || req.query.enrich_images === "false";

    const row = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      include: {
        menuItems: true,
        extraServiceLines: true,
        events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
        ...(includePayments
          ? { payments: { orderBy: { createdAt: "desc" } } }
          : {}),
      },
    });
    if (!row) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    const enrichedRow = skipImageEnrich
      ? row
      : await enrichEventSnapshotMenuImages(row);
    return successResponse(
      res,
      "OK",
      serializeBooking(enrichedRow, { includePayments }),
    );
  } catch (e) {
    console.error("getBooking:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/bookings/:id/completeOrder — caterer marks booking completed (order history / dashboard).
 */
async function completeBookingOrder(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;

    const row = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    if (!row) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (row.completedAt) {
      const enriched = await enrichEventSnapshotMenuImages(row);
      return successResponse(res, "Already completed", serializeBooking(enriched));
    }
    if (row.status !== "CONFIRMED") {
      return errorResponse(
        res,
        "Only confirmed bookings can be marked complete",
        200,
        "VALIDATION_ERROR",
      );
    }
    const latestMs = bookingLatestEventMsFromRow(row);
    if (Number.isNaN(latestMs)) {
      return errorResponse(
        res,
        "Add at least one scheduled event before completing this order",
        200,
        "VALIDATION_ERROR",
      );
    }
    if (latestMs >= Date.now()) {
      return errorResponse(
        res,
        "You can complete this order only after the last event has finished",
        200,
        "VALIDATION_ERROR",
      );
    }

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: { completedAt: new Date() },
      include: {
        menuItems: true,
        events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
    const enriched = await enrichEventSnapshotMenuImages(updated);
    return successResponse(res, "Order completed", serializeBooking(enriched));
  } catch (e) {
    console.error("completeBookingOrder:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * DELETE /v1/deleteBooking/:id
 * Deletes a draft booking for current business.
 */
async function deleteBooking(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;

    const existing = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true, status: true },
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status !== "DRAFT") {
      return errorResponse(
        res,
        "Only draft bookings can be deleted",
        200,
        "VALIDATION_ERROR",
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.bookingMenuItem.deleteMany({ where: { bookingId } });
      await tx.paymentTransaction.deleteMany({ where: { bookingId } });
      await tx.booking.delete({ where: { id: bookingId } });
    });

    return successResponse(res, "Draft deleted", { id: bookingId });
  } catch (e) {
    console.error("deleteBooking:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/bookings/:id/cancel — marks a confirmed booking as cancelled.
 */
async function cancelBooking(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;

    const existing = await loadBookingForBusiness(bookingId, businessId, {
      includePayments: true,
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status === "CANCELLED") {
      return errorResponse(res, "Booking is already cancelled", 200, "VALIDATION_ERROR");
    }
    if (existing.status !== "CONFIRMED") {
      return errorResponse(
        res,
        "Only confirmed bookings can be cancelled",
        200,
        "VALIDATION_ERROR",
      );
    }
    if (existing.completedAt) {
      return errorResponse(
        res,
        "Completed orders cannot be cancelled",
        200,
        "VALIDATION_ERROR",
      );
    }

    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
      include: {
        menuItems: true,
        events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
    const enriched = await enrichEventSnapshotMenuImages(updated);
    return successResponse(res, "Booking cancelled", serializeBooking(enriched));
  } catch (e) {
    console.error("cancelBooking:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/bookings/:id/confirm
 */
async function confirmBooking(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;

    const existing = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      include: {
        menuItems: true,
        events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
      },
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status !== "DRAFT") {
      return errorResponse(res, "Booking is not a draft", 200, "VALIDATION_ERROR");
    }

    const result = await prisma.$transaction(async (tx) => {
      let bookingCode = existing.bookingCode;
      if (!bookingCode) {
        bookingCode = await generateUniqueBookingCode(tx, businessId);
      }

      const menuRows = await tx.bookingMenuItem.findMany({ where: { bookingId } });
      const guests = existing.guestCount ?? 0;
      const pricing = computePricingFromSnapshots(
        menuRows,
        guests,
        num(existing.discountAmount),
        num(existing.serviceChargePct),
        num(existing.taxPct),
      );

      // Confirming the booking confirms every one of its events too — there's
      // no separate per-event confirmation step, so this is the one place
      // BookingEvent.status moves off PENDING. Never downgrades an event
      // that's already COMPLETED (post-event flows set that separately).
      await tx.bookingEvent.updateMany({
        where: { bookingId, status: { not: "COMPLETED" } },
        data: { status: "CONFIRMED" },
      });

      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: "CONFIRMED",
          bookingCode,
          subtotal: new Prisma.Decimal(String(pricing.subtotal)),
          serviceChargeAmount: new Prisma.Decimal(String(pricing.serviceChargeAmount)),
          taxAmount: new Prisma.Decimal(String(pricing.taxAmount)),
          totalDue: new Prisma.Decimal(String(pricing.totalDue)),
          paymentStatus: paymentStatusFromAmounts(existing.amountPaid, pricing.totalDue),
        },
        include: {
          menuItems: true,
          events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      return updated;
    });

    const emailTo = result.customerEmail;
    if (emailTo) {
      try {
        await sendBookingConfirmationEmail(emailTo, {
          bookingCode: result.bookingCode,
          eventAt: result.eventAt,
        });
      } catch (mailErr) {
        console.warn("confirmBooking email:", mailErr.message);
      }
    }

    return successResponse(res, "Booking confirmed", serializeBooking(result));
  } catch (e) {
    console.error("confirmBooking:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/bookigrecordPayment/:id
 */
async function recordPayment(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const body = req.body || {};
    const amount = num(body.amount);
    const method = body.method;

    if (!method || !["CASH", "UPI", "BANK_TRANSFER"].includes(method)) {
      return errorResponse(res, "Invalid payment method", 200, "VALIDATION_ERROR");
    }
    if (amount <= 0) {
      return errorResponse(res, "Amount must be positive", 200, "VALIDATION_ERROR");
    }

    const existing = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      include: {
        extraServiceLines: true,
        events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
      },
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (existing.status !== "CONFIRMED") {
      return errorResponse(res, "Payments only for confirmed bookings", 200, "VALIDATION_ERROR");
    }

    const totalDue = resolveTotalDueForPayment(existing);
    const already = num(existing.amountPaid);
    const remaining = Math.max(0, Math.round(totalDue - already));
    if (amount > remaining + 0.01) {
      return errorResponse(
        res,
        "Amount exceeds remaining balance",
        200,
        "VALIDATION_ERROR",
        `Maximum payable: ${remaining}`,
      );
    }

    const newPaid = already + amount;
    const payStatus = paymentStatusFromAmounts(newPaid, totalDue);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.create({
        data: {
          bookingId,
          amount: new Prisma.Decimal(String(amount)),
          method,
        },
      });
      return tx.booking.update({
        where: { id: bookingId },
        data: {
          amountPaid: new Prisma.Decimal(String(newPaid)),
          paymentStatus: payStatus,
        },
        include: {
          menuItems: true,
          events: { orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }] },
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
    });

    return successResponse(res, "Payment recorded", serializeBooking(updated));
  } catch (e) {
    console.error("recordPayment:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/bookings/:id/pdf-jobs
 * Placeholder async trigger endpoint for non-blocking PDF pipeline.
 */
async function triggerBookingPdfJobs(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const existing = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true },
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    // Current implementation intentionally returns accepted trigger response.
    return successResponse(res, "PDF jobs triggered", { ok: true });
  } catch (e) {
    console.error("triggerBookingPdfJobs:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/retryBookingPdfJob/:id/:jobId
 * Placeholder retry endpoint for PDF pipeline.
 */
async function retryBookingPdfJob(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const jobId = req.params.jobId;
    const existing = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true },
    });
    if (!existing) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    return successResponse(res, "PDF job retry queued", { ok: true, job_id: jobId ?? null });
  } catch (e) {
    console.error("retryBookingPdfJob:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

module.exports = {
  createBooking,
  patchBooking,
  createEvent,
  updateEvent,
  replaceEventMenuItem,
  deleteEvent,
  getDashboard,
  listBookings,
  searchBookingCustomers,
  getBooking,
  completeBookingOrder,
  deleteBooking,
  cancelBooking,
  confirmBooking,
  recordPayment,
  triggerBookingPdfJobs,
  retryBookingPdfJob,
  computePricingFromSnapshots,
  canEditMenuBeforeEvent,
  canEditCustomerDetailsBeforeEvent,
  serializeBooking,
  loadBookingForBusiness,
  generateUniqueBookingCode,
};

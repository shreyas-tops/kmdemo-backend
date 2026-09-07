const prisma = require("../config/prisma");
const { Prisma } = require("@prisma/client");
const { successResponse, errorResponse } = require("../utils/response");
const { getRequestedLanguage, resolveLocalizedName } = require("../utils/localization");
const {
  computeQuotationTotalFromEvents,
  deriveQuotationEventFoodSubtotal,
  deriveQuotationEventExtrasSubtotal,
  isQuotationExpired,
} = require("./quotationPricingHelpers");
const { roundInr } = require("./bookingPricingHelpers");
const {
  fetchExtraServicesForLines,
  buildExtraServiceLineRows,
} = require("./extraServiceController");

/** Flattens every event's `extra_service_lines` into one array for a single up-front catalog fetch. */
function allExtraServiceLinesFromEvents(events) {
  const all = [];
  for (const ev of events || []) {
    if (Array.isArray(ev.extra_service_lines)) all.push(...ev.extra_service_lines);
  }
  return all;
}

function serializeQuotationExtraServiceLine(row) {
  return {
    id: row.id,
    quotation_id: row.quotationId,
    event_id: row.eventId ?? null,
    extra_service_id: row.extraServiceId,
    quantity: row.quantity,
    unit_price_snapshot: num(row.unitPriceSnapshot),
    line_total: num(row.lineTotal),
    title_snapshot: row.titleSnapshot,
    pricing_type_snapshot: row.pricingTypeSnapshot,
  };
}

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
  return deriveIsGlobal(menu.businessId, menu.createdByUserId);
}

function num(d) {
  if (d == null) return 0;
  const n = typeof d === "number" ? d : Number(d);
  return Number.isFinite(n) ? n : 0;
}

/** @returns {number | null | undefined} undefined = omit patch; null = clear column */
function parsePlatePrice(body) {
  const raw = body.plate_price ?? body.platePrice;
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** @param {unknown} bodyStatus @param {"DRAFT"|"SALE"|"SENT"|"ACCEPTED"} [fallback] */
function parseQuotationStatus(bodyStatus, fallback = "SALE") {
  const raw = String(bodyStatus ?? fallback).toUpperCase();
  if (raw === "DRAFT") return "DRAFT";
  if (raw === "SALE") return "SALE";
  if (raw === "ACCEPTED") return "ACCEPTED";
  if (raw === "SENT") return "SENT";
  return fallback;
}

/**
 * Build quotation menu snapshot rows from optional `body.menu_items`, else catalog prices.
 * @returns {{ rows: { menuItemId: string, pricePerPlateSnapshot: number, nameSnapshot: string }[] } | { error: string }}
 */
function buildSnapRowsFromMenuItemsOrCatalog(body, menus, requestedLanguage) {
  const custom = Array.isArray(body.menu_items) ? body.menu_items : [];
  if (custom.length === 0) {
    return {
      rows: menus.map((m) => ({
        menuItemId: m.id,
        pricePerPlateSnapshot: num(m.pricePerPerson),
        nameSnapshot: resolveLocalizedName(m.name, requestedLanguage),
      })),
    };
  }
  if (custom.length !== menus.length) {
    return { error: "menu_items must have the same length as menu_item_ids" };
  }
  const byId = new Map(custom.map((x) => [String(x.menu_item_id), x]));
  for (const m of menus) {
    if (!byId.has(m.id)) {
      return { error: "menu_items must include every menu_item_id" };
    }
  }
  const rows = menus.map((m) => {
    const row = byId.get(m.id);
    const snap = num(
      row.price_per_plate_snapshot ??
        row.price_per_plate ??
        row.pricePerPlateSnapshot ??
        row.pricePerPlate,
    );
    const nameSnap =
      row.name_snapshot != null && String(row.name_snapshot).trim() !== ""
        ? String(row.name_snapshot).trim()
        : resolveLocalizedName(m.name, requestedLanguage);
    return { menuItemId: m.id, pricePerPlateSnapshot: snap, nameSnapshot: nameSnap };
  });
  return { rows };
}

/** First event in `body.events[]`, if any — source of the legacy flat-field mirror. */
function firstEventFromBody(body) {
  return Array.isArray(body.events) && body.events.length > 0 ? body.events[0] : null;
}

/**
 * Legacy `menu_item_ids`/`menu_items` derived from `events[0].event_snapshot.menu_items`
 * when the request uses the new nested-events shape and doesn't also send the flat
 * fields directly — keeps `QuotationMenuItem` (the pre-existing flat mirror table) and
 * `Quotation.eventDate/guestCount/functionType` populated exactly like before.
 */
function legacyMenuFieldsFromBody(body) {
  if (Array.isArray(body.menu_item_ids)) {
    return { menu_item_ids: body.menu_item_ids, menu_items: body.menu_items };
  }
  const first = firstEventFromBody(body);
  const snapMenuItems = first?.event_snapshot?.menu_items;
  if (!Array.isArray(snapMenuItems) || snapMenuItems.length === 0) {
    return { menu_item_ids: [], menu_items: undefined };
  }
  return {
    menu_item_ids: snapMenuItems.map((r) => r.id),
    menu_items: snapMenuItems.map((r) => ({
      menu_item_id: r.id,
      price_per_plate_snapshot: num(first.event_snapshot.price_per_plate),
      name_snapshot: r.name ?? null,
    })),
  };
}

function serializeQuotationEvent(ev) {
  const eventFoodAmount = deriveQuotationEventFoodSubtotal(ev);
  const eventExtrasAmount = deriveQuotationEventExtrasSubtotal(ev);
  const computedEventTotal = roundInr(eventFoodAmount + eventExtrasAmount);
  return {
    id: ev.id,
    quotation_id: ev.quotationId,
    event_at: ev.eventAt?.toISOString?.() ?? ev.eventAt ?? null,
    event_location: ev.eventLocation ?? null,
    jamanvar_type: ev.jamanvarType ?? null,
    function_type: ev.functionType ?? null,
    guest_count: ev.guestCount ?? null,
    notes: ev.notes ?? null,
    status: ev.status ?? "PENDING",
    dish_id: ev.dishId ?? null,
    parent_dish_id: ev.parentDishId ?? null,
    is_template: ev.isTemplate ?? null,
    /** Food-only amount (guests × pricePerPlate from snapshot). */
    event_subtotal: eventFoodAmount,
    /** Extra services total for this event. */
    event_extras_amount: eventExtrasAmount,
    /** Full event total = food + extras. */
    event_total: computedEventTotal,
    event_snapshot: ev.eventSnapshot ?? null,
    extra_service_lines: (ev.extraServiceLines || []).map(serializeQuotationExtraServiceLine),
    created_at: ev.createdAt?.toISOString?.() ?? ev.createdAt,
    updated_at: ev.updatedAt?.toISOString?.() ?? ev.updatedAt,
  };
}

function serializeQuotation(q) {
  // Client address is the live default an event inherits when it has no
  // `eventLocation` of its own — mirrors Booking's `customerAddress`.
  const clientAddress = q.clientAddress ?? null;
  const serializedEvents = (q.events || []).map((ev) => {
    const row = serializeQuotationEvent(ev);
    return {
      ...row,
      effective_event_location:
        typeof row.event_location === "string" && row.event_location.trim()
          ? row.event_location
          : clientAddress,
    };
  });
  const first = serializedEvents[0];

  const extraServiceLines = (q.extraServiceLines || []).map(serializeQuotationExtraServiceLine);
  const extraCharges = extraServiceLines.reduce((s, l) => s + num(l.line_total), 0);
  const foodSubtotal = (q.events || []).reduce(
    (s, ev) => s + deriveQuotationEventFoodSubtotal(ev),
    0,
  );

  return {
    id: q.id,
    business_id: q.businessId,
    status: q.status ?? "SALE",
    client_name: q.clientName,
    client_phone: q.clientPhone ?? null,
    client_email: q.clientEmail ?? null,
    client_address: q.clientAddress ?? null,
    function_type: q.functionType ?? null,
    // Legacy mirror of events[0] — kept in sync so older callers / the Schedule tab's
    // date filter (which queries this column directly) keep working unmodified.
    event_date: first?.event_at ?? (q.eventDate?.toISOString?.() ?? q.eventDate),
    guest_count: first?.guest_count ?? q.guestCount,
    discount_amount: num(q.discountAmount),
    service_charge_pct: num(q.serviceChargePct),
    tax_pct: num(q.taxPct),
    subtotal: num(q.subtotal),
    food_subtotal: roundInr(foodSubtotal),
    service_charge_amount: num(q.serviceChargeAmount),
    tax_amount: num(q.taxAmount),
    total: num(q.total),
    plate_price: q.platePrice != null ? num(q.platePrice) : null,
    menu_items: (q.menuItems || []).map((mi) => ({
      id: mi.id,
      menu_item_id: mi.menuItemId,
      price_per_plate_snapshot: num(mi.pricePerPlateSnapshot),
      name_snapshot: mi.nameSnapshot,
    })),
    events: serializedEvents,
    extra_service_lines: extraServiceLines,
    extra_charges: extraCharges,
    converted_booking_id: q.convertedBookingId ?? null,
    converted_at: q.convertedAt?.toISOString?.() ?? q.convertedAt ?? null,
    created_at: q.createdAt?.toISOString?.() ?? q.createdAt,
    updated_at: q.updatedAt?.toISOString?.() ?? q.updatedAt,
  };
}

const quotationInclude = {
  menuItems: true,
  events: {
    include: { extraServiceLines: true },
    orderBy: [{ eventAt: "asc" }, { createdAt: "asc" }],
  },
  extraServiceLines: true,
};

/**
 * Creates QuotationEvent + (per-event) QuotationExtraServiceLine rows for `events[]`
 * inside an open transaction. Events are created one at a time (not `createMany`)
 * because each event's service lines need its freshly-assigned id.
 *
 * `servicesById` must already be fetched (see `fetchExtraServicesForLines`) — this
 * function does no I/O beyond the `tx` writes themselves. Fetching the extra service
 * catalog per event via a separate connection while this transaction is open eats
 * into Prisma's 5s interactive-transaction timeout, and compounds with event count.
 */
async function createQuotationEventsInTx(tx, { quotationId, events, servicesById }) {
  for (const ev of events) {
    const created = await tx.quotationEvent.create({
      data: {
        quotationId,
        eventAt: ev.event_at ? new Date(ev.event_at) : null,
        eventLocation: ev.event_location ?? null,
        functionType: ev.function_type ?? null,
        jamanvarType:
          ev.jamanvar_type != null && String(ev.jamanvar_type).trim() !== ""
            ? String(ev.jamanvar_type).trim()
            : null,
        guestCount: ev.guest_count != null ? parseInt(ev.guest_count, 10) : null,
        notes: ev.notes ?? null,
        status: ev.status ?? "PENDING",
        dishId: ev.dish_id ?? null,
        parentDishId: ev.parent_dish_id ?? null,
        isTemplate: ev.is_template ?? null,
        eventSnapshot: ev.event_snapshot ?? null,
        eventTotal: ev.event_total != null ? new Prisma.Decimal(String(ev.event_total)) : null,
      },
    });

    const lines = Array.isArray(ev.extra_service_lines) ? ev.extra_service_lines : [];
    if (lines.length === 0) continue;

    const guestCount = Math.max(0, Number(created.guestCount) || 0);
    const resolved = buildExtraServiceLineRows({ lines, guestCount, servicesById });
    if (resolved.error) return { error: resolved.error };
    if (resolved.rows.length > 0) {
      await tx.quotationExtraServiceLine.createMany({
        data: resolved.rows.map((r) => ({
          ...r,
          quotationId,
          eventId: created.id,
        })),
      });
    }
  }
  return {};
}

async function createQuotation(req, res) {
  try {
    const requestedLanguage = getRequestedLanguage(req);
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const body = req.body || {};

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { defaultServiceChargePct: true, defaultTaxPct: true },
    });
    if (!business) {
      return errorResponse(res, "Business not found", 404, "NOT_FOUND");
    }

    const events = Array.isArray(body.events) ? body.events : [];
    const firstEvent = events[0] ?? null;
    const legacyMenu = legacyMenuFieldsFromBody(body);

    const menuItemIds = Array.isArray(legacyMenu.menu_item_ids) ? legacyMenu.menu_item_ids : [];
    const ids = [...new Set(menuItemIds.map((x) => String(x)))];
    const menus = ids.length ? await prisma.menuItem.findMany({ where: { id: { in: ids } } }) : [];
    if (menus.length !== ids.length) {
      return errorResponse(res, "One or more menu items not found", 422, "VALIDATION_ERROR");
    }
    for (const m of menus) {
      if (!canViewMenuItem(m, businessId, userId)) {
        return errorResponse(res, "Forbidden menu item in selection", 403, "FORBIDDEN");
      }
    }

    const sc = num(body.service_charge_pct ?? business.defaultServiceChargePct);
    const txp = num(body.tax_pct ?? business.defaultTaxPct);
    const guests =
      firstEvent?.guest_count != null
        ? parseInt(firstEvent.guest_count, 10)
        : parseInt(body.guest_count, 10) || 0;
    const discount = num(body.discount_amount ?? 0);

    const snapBuilt = buildSnapRowsFromMenuItemsOrCatalog(
      { menu_items: legacyMenu.menu_items },
      menus,
      requestedLanguage,
    );
    if (snapBuilt.error) {
      return errorResponse(res, snapBuilt.error, 422, "VALIDATION_ERROR");
    }
    const status = parseQuotationStatus(body.status, "SALE");
    const platePriceVal = parsePlatePrice(body);
    const platePriceDecimal = platePriceVal == null ? null : new Prisma.Decimal(String(platePriceVal));

    // Fetch the extra-service catalog once, before opening the transaction — see
    // `createQuotationEventsInTx`'s doc comment for why this can't happen inside it.
    const extraServicesFetch = await fetchExtraServicesForLines({
      businessId,
      userId,
      lines: allExtraServiceLinesFromEvents(events),
    });
    if (extraServicesFetch.error) {
      return errorResponse(res, extraServicesFetch.error, 422, "VALIDATION_ERROR");
    }
    const servicesById = extraServicesFetch.servicesById;

    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.quotation.create({
        data: {
          businessId,
          status,
          platePrice: platePriceDecimal,
          clientName: String(body.client_name ?? ""),
          clientPhone:
            body.client_phone != null && String(body.client_phone).trim() !== ""
              ? String(body.client_phone).trim()
              : null,
          clientEmail:
            body.client_email != null && String(body.client_email).trim() !== ""
              ? String(body.client_email).trim()
              : null,
          clientAddress:
            body.client_address != null && String(body.client_address).trim() !== ""
              ? String(body.client_address).trim()
              : null,
          functionType:
            (firstEvent?.function_type ?? body.function_type) != null &&
            String(firstEvent?.function_type ?? body.function_type).trim() !== ""
              ? String(firstEvent?.function_type ?? body.function_type).trim()
              : null,
          eventDate: (firstEvent?.event_at ?? body.event_date)
            ? new Date(firstEvent?.event_at ?? body.event_date)
            : null,
          guestCount: guests,
          discountAmount: new Prisma.Decimal(String(discount)),
          serviceChargePct: new Prisma.Decimal(String(sc)),
          taxPct: new Prisma.Decimal(String(txp)),
          // Placeholder; recomputed from events below once created.
          subtotal: new Prisma.Decimal("0"),
          serviceChargeAmount: new Prisma.Decimal("0"),
          taxAmount: new Prisma.Decimal("0"),
          total: new Prisma.Decimal("0"),
        },
      });

      const rows = snapBuilt.rows.map((r) => ({
        quotationId: created.id,
        menuItemId: r.menuItemId,
        pricePerPlateSnapshot: r.pricePerPlateSnapshot,
        nameSnapshot: r.nameSnapshot,
      }));
      if (rows.length) {
        await tx.quotationMenuItem.createMany({ data: rows });
      }

      if (events.length > 0) {
        const evResult = await createQuotationEventsInTx(tx, {
          quotationId: created.id,
          events,
          servicesById,
        });
        if (evResult.error) throw new Error(`__VALIDATION__${evResult.error}`);
      }

      const withEvents = await tx.quotation.findUnique({
        where: { id: created.id },
        include: quotationInclude,
      });
      const pricing = computeQuotationTotalFromEvents(withEvents);

      return tx.quotation.update({
        where: { id: created.id },
        data: {
          subtotal: new Prisma.Decimal(String(pricing.subtotal)),
          serviceChargeAmount: new Prisma.Decimal(String(pricing.serviceChargeAmount)),
          taxAmount: new Prisma.Decimal(String(pricing.taxAmount)),
          total: new Prisma.Decimal(String(pricing.total)),
        },
        include: quotationInclude,
      });
    });

    return successResponse(res, "Quotation created", serializeQuotation(result));
  } catch (e) {
    if (typeof e.message === "string" && e.message.startsWith("__VALIDATION__")) {
      return errorResponse(
        res,
        e.message.replace("__VALIDATION__", ""),
        404,
        "NOT_FOUND",
      );
    }
    console.error("createQuotation:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function listQuotations(req, res) {
  try {
    const businessId = req.businessId;
    const take = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [rows, total] = await Promise.all([
      prisma.quotation.findMany({
        where: { businessId },
        // Farthest-out event date first, nearest date last (nulls/no-date quotations last);
        // most-recently-updated breaks ties, e.g. quotations sharing the same event date.
        orderBy: [{ eventDate: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
        take,
        skip,
        include: quotationInclude,
      }),
      prisma.quotation.count({ where: { businessId } }),
    ]);

    return successResponse(res, "OK", {
      quotations: rows.map(serializeQuotation),
      total,
    });
  } catch (e) {
    console.error("listQuotations:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function getQuotation(req, res) {
  try {
    const businessId = req.businessId;
    const id = req.params.id;
    const row = await prisma.quotation.findFirst({
      where: { id, businessId },
      include: quotationInclude,
    });
    if (!row) {
      return errorResponse(res, "Quotation not found", 404, "NOT_FOUND");
    }
    return successResponse(res, "OK", serializeQuotation(row));
  } catch (e) {
    console.error("getQuotation:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function updateQuotation(req, res) {
  try {
    const requestedLanguage = getRequestedLanguage(req);
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const id = req.params.id;
    const body = req.body || {};

    const existing = await prisma.quotation.findFirst({
      where: { id, businessId },
      include: quotationInclude,
    });
    if (!existing) {
      return errorResponse(res, "Quotation not found", 404, "NOT_FOUND");
    }

    const eventsProvided = Array.isArray(body.events);
    const events = eventsProvided ? body.events : [];
    const firstEvent = events[0] ?? null;

    let menus = [];
    const legacyMenu = eventsProvided ? legacyMenuFieldsFromBody(body) : null;
    const menuIdsToResolve = eventsProvided
      ? legacyMenu.menu_item_ids
      : Array.isArray(body.menu_item_ids)
        ? body.menu_item_ids
        : null;
    if (Array.isArray(menuIdsToResolve)) {
      const menuItemIds = [...new Set(menuIdsToResolve.map((x) => String(x)))];
      menus = menuItemIds.length
        ? await prisma.menuItem.findMany({ where: { id: { in: menuItemIds } } })
        : [];
      if (menus.length !== menuItemIds.length) {
        return errorResponse(res, "One or more menu items not found", 422, "VALIDATION_ERROR");
      }
      for (const m of menus) {
        if (!canViewMenuItem(m, businessId, userId)) {
          return errorResponse(res, "Forbidden menu item in selection", 403, "FORBIDDEN");
        }
      }
    }

    const guests =
      firstEvent?.guest_count != null
        ? parseInt(firstEvent.guest_count, 10)
        : body.guest_count != null
          ? parseInt(body.guest_count, 10)
          : existing.guestCount;
    const discount = body.discount_amount != null ? num(body.discount_amount) : num(existing.discountAmount);
    const sc =
      body.service_charge_pct != null ? num(body.service_charge_pct) : num(existing.serviceChargePct);
    const txp = body.tax_pct != null ? num(body.tax_pct) : num(existing.taxPct);

    let snapBuiltForTx = null;
    if (menus.length || (eventsProvided && legacyMenu.menu_item_ids.length === 0)) {
      const snapBuilt = buildSnapRowsFromMenuItemsOrCatalog(
        { menu_items: eventsProvided ? legacyMenu.menu_items : body.menu_items },
        menus,
        requestedLanguage,
      );
      if (snapBuilt.error) {
        return errorResponse(res, snapBuilt.error, 422, "VALIDATION_ERROR");
      }
      snapBuiltForTx = snapBuilt;
    }

    const platePricePatch = parsePlatePrice(body);

    // Fetch the extra-service catalog once, before opening the transaction — see
    // `createQuotationEventsInTx`'s doc comment for why this can't happen inside it.
    let servicesById = new Map();
    if (eventsProvided && events.length > 0) {
      const extraServicesFetch = await fetchExtraServicesForLines({
        businessId,
        userId,
        lines: allExtraServiceLinesFromEvents(events),
      });
      if (extraServicesFetch.error) {
        return errorResponse(res, extraServicesFetch.error, 422, "VALIDATION_ERROR");
      }
      servicesById = extraServicesFetch.servicesById;
    }

    const result = await prisma.$transaction(async (tx) => {
      if (snapBuiltForTx) {
        await tx.quotationMenuItem.deleteMany({ where: { quotationId: id } });
        const rows = snapBuiltForTx.rows.map((r) => ({
          quotationId: id,
          menuItemId: r.menuItemId,
          pricePerPlateSnapshot: r.pricePerPlateSnapshot,
          nameSnapshot: r.nameSnapshot,
        }));
        if (rows.length) await tx.quotationMenuItem.createMany({ data: rows });
      }

      if (eventsProvided) {
        await tx.quotationExtraServiceLine.deleteMany({ where: { quotationId: id } });
        await tx.quotationEvent.deleteMany({ where: { quotationId: id } });
        if (events.length > 0) {
          const evResult = await createQuotationEventsInTx(tx, {
            quotationId: id,
            events,
            servicesById,
          });
          if (evResult.error) throw new Error(`__VALIDATION__${evResult.error}`);
        }
      }

      await tx.quotation.update({
        where: { id },
        data: {
          ...(platePricePatch !== undefined
            ? {
                platePrice:
                  platePricePatch === null ? null : new Prisma.Decimal(String(platePricePatch)),
              }
            : {}),
          ...(body.status !== undefined
            ? { status: parseQuotationStatus(body.status, existing.status) }
            : {}),
          clientName: body.client_name !== undefined ? String(body.client_name) : existing.clientName,
          clientPhone:
            body.client_phone !== undefined
              ? body.client_phone != null && String(body.client_phone).trim() !== ""
                ? String(body.client_phone).trim()
                : null
              : existing.clientPhone,
          clientEmail:
            body.client_email !== undefined
              ? body.client_email != null && String(body.client_email).trim() !== ""
                ? String(body.client_email).trim()
                : null
              : existing.clientEmail,
          clientAddress:
            body.client_address !== undefined
              ? body.client_address != null && String(body.client_address).trim() !== ""
                ? String(body.client_address).trim()
                : null
              : existing.clientAddress,
          functionType:
            (firstEvent?.function_type ?? body.function_type) !== undefined
              ? (firstEvent?.function_type ?? body.function_type) != null &&
                String(firstEvent?.function_type ?? body.function_type).trim() !== ""
                ? String(firstEvent?.function_type ?? body.function_type).trim()
                : null
              : existing.functionType,
          eventDate:
            (firstEvent?.event_at ?? body.event_date) !== undefined
              ? (firstEvent?.event_at ?? body.event_date)
                ? new Date(firstEvent?.event_at ?? body.event_date)
                : null
              : existing.eventDate,
          guestCount: guests,
          discountAmount: new Prisma.Decimal(String(discount)),
          serviceChargePct: new Prisma.Decimal(String(sc)),
          taxPct: new Prisma.Decimal(String(txp)),
        },
      });

      const withEvents = await tx.quotation.findUnique({
        where: { id },
        include: quotationInclude,
      });
      const pricing = computeQuotationTotalFromEvents(withEvents);

      return tx.quotation.update({
        where: { id },
        data: {
          subtotal: new Prisma.Decimal(String(pricing.subtotal)),
          serviceChargeAmount: new Prisma.Decimal(String(pricing.serviceChargeAmount)),
          taxAmount: new Prisma.Decimal(String(pricing.taxAmount)),
          total: new Prisma.Decimal(String(pricing.total)),
        },
        include: quotationInclude,
      });
    });

    return successResponse(res, "Quotation updated", serializeQuotation(result));
  } catch (e) {
    if (typeof e.message === "string" && e.message.startsWith("__VALIDATION__")) {
      return errorResponse(
        res,
        e.message.replace("__VALIDATION__", ""),
        404,
        "NOT_FOUND",
      );
    }
    console.error("updateQuotation:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function deleteQuotation(req, res) {
  try {
    const businessId = req.businessId;
    const id = req.params.id;

    // Single round trip: deleteMany scoped by (id, businessId) does the ownership
    // check and the delete together — findFirst-then-delete was two sequential
    // queries for the same result.
    const { count } = await prisma.quotation.deleteMany({
      where: { id, businessId },
    });
    if (count === 0) {
      return errorResponse(res, "Quotation not found", 404, "NOT_FOUND");
    }
    return successResponse(res, "Quotation deleted", { id });
  } catch (e) {
    console.error("deleteQuotation:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/quotations/:id/convertToBooking — client approved the quotation; turn it
 * into a real Booking, copying every event (with its menu snapshot) and every
 * per-event extra-service line. Idempotent: calling this twice returns the same Booking.
 */
async function convertQuotationToBooking(req, res) {
  try {
    const businessId = req.businessId;
    const id = req.params.id;

    const existing = await prisma.quotation.findFirst({
      where: { id, businessId },
      include: quotationInclude,
    });
    if (!existing) {
      return errorResponse(res, "Quotation not found", 404, "NOT_FOUND");
    }

    // Lazily required to avoid a require-cycle at module load time
    // (bookingController also requires quotationController-adjacent helpers indirectly).
    const {
      serializeBooking,
      loadBookingForBusiness,
      generateUniqueBookingCode,
    } = require("./bookingController");
    const { computeBookingTotalDueFromEvents } = require("./bookingPricingHelpers");

    if (existing.convertedBookingId) {
      const already = await loadBookingForBusiness(existing.convertedBookingId, businessId, {
        includePayments: false,
      });
      if (already) {
        return successResponse(res, "Already converted", serializeBooking(already));
      }
    }

    if (isQuotationExpired(existing)) {
      return errorResponse(
        res,
        "This quotation has expired and can no longer be confirmed. Update the event date and try again.",
        400,
        "QUOTATION_EXPIRED",
      );
    }

    const newBookingId = await prisma.$transaction(async (tx) => {
      const bookingCode = await generateUniqueBookingCode(tx, businessId);
      const firstEvent = existing.events[0] ?? null;

      // Derive event date range for multi-event bookings
      const eventDates = existing.events
        .map((ev) => ev.eventAt)
        .filter((d) => d != null)
        .map((d) => new Date(d).getTime())
        .filter((ms) => !Number.isNaN(ms));
      const eventRangeStart = eventDates.length > 0 ? new Date(Math.min(...eventDates)) : null;
      const eventRangeEnd = eventDates.length > 0 ? new Date(Math.max(...eventDates)) : null;

      const booking = await tx.booking.create({
        data: {
          businessId,
          status: "CONFIRMED",
          bookingCode,
          customerName: existing.clientName,
          customerPhone: existing.clientPhone,
          customerEmail: existing.clientEmail ?? null,
          // Client address becomes the booking's customer address; events with
          // no address of their own keep inheriting it (see below).
          customerAddress: existing.clientAddress ?? null,
          eventAt: firstEvent?.eventAt ?? existing.eventDate,
          eventRangeStart,
          eventRangeEnd,
          eventLocation: null,
          functionType: firstEvent?.functionType ?? existing.functionType,
          guestCount: firstEvent?.guestCount ?? existing.guestCount,
          discountAmount: existing.discountAmount,
          serviceChargePct: existing.serviceChargePct,
          taxPct: existing.taxPct,
        },
      });

      // Transfer flat menu items (legacy single-event mirror) to BookingMenuItem
      if (existing.menuItems.length > 0) {
        await tx.bookingMenuItem.createMany({
          data: existing.menuItems.map((mi) => ({
            bookingId: booking.id,
            menuItemId: mi.menuItemId,
            quantity: 1,
            pricePerPlateSnapshot: mi.pricePerPlateSnapshot,
            nameSnapshot: mi.nameSnapshot,
          })),
          skipDuplicates: true,
        });
      }

      const eventIdMap = new Map();
      for (const ev of existing.events) {
        const created = await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            eventAt: ev.eventAt,
            // Keep the event's own address; blank stays blank so it inherits
            // the booking's customerAddress (copied from clientAddress above).
            eventLocation: ev.eventLocation ?? null,
            functionType: ev.functionType ?? null,
            jamanvarType: ev.jamanvarType,
            guestCount: ev.guestCount,
            notes: ev.notes,
            status: "CONFIRMED",
            dishId: ev.dishId,
            parentDishId: ev.parentDishId,
            isTemplate: ev.isTemplate,
            eventSnapshot: ev.eventSnapshot,
            eventTotal: ev.eventTotal,
          },
          select: { id: true },
        });
        eventIdMap.set(ev.id, created.id);
      }

      if (existing.extraServiceLines.length) {
        await tx.bookingExtraServiceLine.createMany({
          data: existing.extraServiceLines.map((l) => ({
            bookingId: booking.id,
            eventId: l.eventId ? (eventIdMap.get(l.eventId) ?? null) : null,
            extraServiceId: l.extraServiceId,
            quantity: l.quantity,
            unitPriceSnapshot: l.unitPriceSnapshot,
            lineTotal: l.lineTotal,
            titleSnapshot: l.titleSnapshot,
            pricingTypeSnapshot: l.pricingTypeSnapshot,
          })),
        });
      }

      const withEvents = await tx.booking.findUnique({
        where: { id: booking.id },
        include: { events: true, extraServiceLines: true },
      });
      const totalDue = computeBookingTotalDueFromEvents(withEvents);
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          totalDue: new Prisma.Decimal(String(totalDue)),
          subtotal: new Prisma.Decimal(String(totalDue)),
          paymentStatus: "PENDING",
        },
      });

      await tx.quotation.update({
        where: { id },
        data: { status: "ACCEPTED", convertedBookingId: booking.id, convertedAt: new Date() },
      });

      return booking.id;
    });

    const newBooking = await loadBookingForBusiness(newBookingId, businessId, {
      includePayments: false,
    });
    return successResponse(res, "Quotation converted to booking", serializeBooking(newBooking));
  } catch (e) {
    console.error("convertQuotationToBooking:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

module.exports = {
  createQuotation,
  listQuotations,
  getQuotation,
  updateQuotation,
  deleteQuotation,
  convertQuotationToBooking,
  serializeQuotation,
};

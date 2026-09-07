const prisma = require("../config/prisma");
const { successResponse, errorResponse } = require("../utils/response");
const { renderSupplyPdfBuffer } = require("../utils/renderSupplyPdfBuffer");
const {
  getRequestedLanguage,
  normalizeLocalizedName,
  resolveLocalizedName,
} = require("../utils/localization");

const VALID_TYPES = new Set(["INGREDIENT", "UTENSIL"]);

/**
 * Same rule as MenuItem: private only when both business and creator are set.
 */
function deriveSupplyIsGlobal(businessId, createdByUserId) {
  if (businessId == null || businessId === "") return true;
  if (createdByUserId == null || createdByUserId === "") return true;
  return false;
}

/** List/select visibility mirrors menu listMenuItems OR-branches. */
function supplyVisibilityOrBranches(businessId, userId) {
  return [
    { businessId, OR: [{ isGlobal: true }, { createdByUserId: userId }] },
    { businessId: null, OR: [{ createdByUserId: userId }, { isGlobal: true }] },
    { createdByUserId: userId },
  ];
}

/** Remaining assignable stock for a utensil (total − damaged − assigned elsewhere). */
function effectiveUtensilAssignable(source, assignedElsewhere = 0) {
  if (source.type !== "UTENSIL" || source.availableCount == null) return null;
  const total = Math.max(0, Number(source.availableCount) || 0);
  const damaged = Math.max(0, Number(source.damagedCount) || 0);
  const assigned = Math.max(0, Number(assignedElsewhere) || 0);
  return Math.max(0, total - damaged - assigned);
}

/** Utensil rows cap booking quantities to remaining assignable stock. */
function utensilStockExceededMessage(source, requestedQty, assignedElsewhere = 0) {
  if (source.type !== "UTENSIL" || source.availableCount == null) return null;
  const cap = effectiveUtensilAssignable(source, assignedElsewhere);
  if (cap == null) return null;
  const q = parseInt(String(requestedQty), 10);
  const qty = Number.isFinite(q) ? q : 0;
  if (qty > cap) {
    return "Quantity cannot exceed remaining stock for this utensil";
  }
  return null;
}

async function loadSupplyCategoryBySlug(slug) {
  return prisma.supplyItemCategory.findFirst({
    where: { slug, isActive: true },
    select: { slug: true, name: true },
  });
}

function serializeSupplyItem(row, lang) {
  const localized = normalizeLocalizedName(row.name) || { en: "" };
  return {
    id: row.id,
    business_id: row.businessId ?? null,
    is_global: row.isGlobal,
    type: row.type,
    category: row.category?.slug ?? row.categorySlug,
    name: resolveLocalizedName(row.name, lang),
    name_i18n: localized,
    unit_options: row.unitOptions ?? [],
    default_unit: row.defaultUnit,
    available_count: row.availableCount ?? null,
    damaged_count: row.type === "UTENSIL" ? Math.max(0, row.damagedCount ?? 0) : 0,
    photo_url: row.photoUrl ?? null,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function serializeSupplyItemCategory(row, lang) {
  const localized = normalizeLocalizedName(row.name) || { en: "" };
  return {
    id: row.id,
    slug: row.slug,
    name: resolveLocalizedName(row.name, lang),
    name_i18n: localized,
    sort_order: row.sortOrder,
    is_active: row.isActive,
  };
}

function serializeSupplyUnit(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * GET query.type optional: INGREDIENT | UTENSIL — only categories that have
 * at least one visible supply item of that type (for tab UX).
 * Omit type to return every active row from SupplyItemCategory.
 */
async function listSupplyItemCategories(req, res) {
  try {
    const language = getRequestedLanguage(req);
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const typeRaw = req.query.type != null ? String(req.query.type).toUpperCase() : "";
    const type = VALID_TYPES.has(typeRaw) ? typeRaw : null;

    if (req.query.type != null && !type) {
      return errorResponse(res, "Invalid type", 200, "VALIDATION_ERROR");
    }

    if (type) {
      const supplyRows = await prisma.supplyItem.findMany({
        where: {
          AND: [
            { type },
            { isActive: true },
            { OR: supplyVisibilityOrBranches(businessId, userId) },
          ],
        },
        select: { categorySlug: true },
      });
      const slugSet = [...new Set(supplyRows.map((r) => r.categorySlug))];
      if (slugSet.length === 0) {
        return successResponse(res, "OK", { categories: [] });
      }
      const rows = await prisma.supplyItemCategory.findMany({
        where: { isActive: true, slug: { in: slugSet } },
        orderBy: { sortOrder: "asc" },
      });
      return successResponse(res, "OK", {
        categories: rows.map((row) => serializeSupplyItemCategory(row, language)),
      });
    }

    const rows = await prisma.supplyItemCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
    return successResponse(res, "OK", {
      categories: rows.map((row) => serializeSupplyItemCategory(row, language)),
    });
  } catch (e) {
    console.error("listSupplyItemCategories:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function createSupplyItem(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const body = req.body || {};
    const type = String(body.type || "").toUpperCase();
    const categorySlug = String(body.category_slug ?? body.category ?? "")
      .trim()
      .toLowerCase();
    const names = normalizeLocalizedName(body.name ?? body.name_i18n);
    if (!VALID_TYPES.has(type)) {
      return errorResponse(res, "Invalid type", 200, "VALIDATION_ERROR");
    }
    if (!categorySlug) {
      return errorResponse(res, "category_slug is required", 200, "VALIDATION_ERROR");
    }
    if (!names) {
      return errorResponse(
        res,
        "All language names are required",
        200,
        "VALIDATION_ERROR",
      );
    }
    const unitOptions = Array.isArray(body.unit_options)
      ? body.unit_options
          .map((u) => String(u ?? "").trim().toLowerCase())
          .filter(Boolean)
      : [];
    const defaultUnit = String(body.default_unit || "").trim().toLowerCase();
    if (unitOptions.length === 0) {
      return errorResponse(
        res,
        "unit_options must have at least one unit",
        200,
        "VALIDATION_ERROR",
      );
    }
    if (!defaultUnit || !unitOptions.includes(defaultUnit)) {
      return errorResponse(
        res,
        "default_unit must be one of unit_options",
        200,
        "VALIDATION_ERROR",
      );
    }
    const categoryRow = await loadSupplyCategoryBySlug(categorySlug);
    if (!categoryRow) {
      return errorResponse(
        res,
        "category_slug must match an active supply category slug",
        200,
        "VALIDATION_ERROR",
      );
    }

    const availableCount =
      body.available_count == null
        ? null
        : Math.max(0, parseInt(String(body.available_count), 10) || 0);
    const damagedCount =
      type === "UTENSIL"
        ? Math.max(0, parseInt(String(body.damaged_count ?? 0), 10) || 0)
        : 0;
    if (availableCount != null && damagedCount > availableCount) {
      return errorResponse(
        res,
        "damaged_count cannot exceed available_count",
        200,
        "VALIDATION_ERROR",
      );
    }

    const row = await prisma.supplyItem.create({
      data: {
        businessId,
        createdByUserId: userId ?? null,
        isGlobal: deriveSupplyIsGlobal(businessId, userId),
        type,
        categorySlug: categoryRow.slug,
        name: names,
        unitOptions,
        defaultUnit,
        availableCount,
        damagedCount,
        photoUrl: body.photo_url ?? null,
      },
      include: { category: true },
    });
    return successResponse(
      res,
      "Supply item created",
      serializeSupplyItem(row, getRequestedLanguage(req)),
    );
  } catch (e) {
    console.error("createSupplyItem:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

function nameMatchesSearch(row, qLower) {
  const haystack = [
    resolveLocalizedName(row.name, "en"),
    resolveLocalizedName(row.name, "hi"),
    resolveLocalizedName(row.name, "gu"),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(qLower);
}

function buildPagination(page, limit, total, returnedCount) {
  const skip = (page - 1) * limit;
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    total_pages: totalPages,
    has_more: skip + returnedCount < total,
  };
}

async function listSupplyItems(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const language = getRequestedLanguage(req);
    const type = req.query.type ? String(req.query.type).toUpperCase() : undefined;
    // Accepts one slug or a comma-separated list (multi-select filter).
    const rawCategory =
      req.query.category_slug != null
        ? String(req.query.category_slug)
        : req.query.category != null
          ? String(req.query.category)
          : "";
    const categorySlugs = [
      ...new Set(
        rawCategory
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const q = String(req.query.q ?? "").trim();
    const qLower = q.toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const skip = (page - 1) * limit;

    const filterAnd = [{ isActive: true }];
    if (type && VALID_TYPES.has(type)) filterAnd.push({ type });
    if (categorySlugs.length === 1) {
      filterAnd.push({ categorySlug: categorySlugs[0] });
    } else if (categorySlugs.length > 1) {
      filterAnd.push({ categorySlug: { in: categorySlugs } });
    }

    const visibilityWhere = {
      AND: [{ OR: supplyVisibilityOrBranches(businessId, userId) }, ...filterAnd],
    };

    if (!q) {
      const [total, rows] = await prisma.$transaction([
        prisma.supplyItem.count({ where: visibilityWhere }),
        prisma.supplyItem.findMany({
          where: visibilityWhere,
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
          include: { category: true },
        }),
      ]);
      return successResponse(res, "OK", {
        items: rows.map((row) => serializeSupplyItem(row, language)),
        pagination: buildPagination(page, limit, total, rows.length),
      });
    }

    /** Search: same locale matching as before; filter then paginate (scoped by category when set). */
    const allMatching = await prisma.supplyItem.findMany({
      where: visibilityWhere,
      orderBy: { createdAt: "desc" },
      include: { category: true },
    });
    const filteredRows = allMatching.filter((row) => nameMatchesSearch(row, qLower));
    const total = filteredRows.length;
    const pageRows = filteredRows.slice(skip, skip + limit);
    return successResponse(res, "OK", {
      items: pageRows.map((row) => serializeSupplyItem(row, language)),
      pagination: buildPagination(page, limit, total, pageRows.length),
    });
  } catch (e) {
    console.error("listSupplyItems:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function updateSupplyItem(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const id = req.params.id;
    const body = req.body || {};
    const existing = await prisma.supplyItem.findFirst({
      where: {
        id,
        isActive: true,
        OR: supplyVisibilityOrBranches(businessId, userId),
      },
      include: { category: true },
    });
    if (!existing) return errorResponse(res, "Supply item not found", 404, "NOT_FOUND");
    const hasNameInput = body.name !== undefined || body.name_i18n !== undefined;
    const names = hasNameInput
      ? normalizeLocalizedName(body.name ?? body.name_i18n)
      : null;
    if (hasNameInput && !names) {
      return errorResponse(
        res,
        "All language names are required",
        200,
        "VALIDATION_ERROR",
      );
    }
    const patch = {
      ...(names ? { name: names } : {}),
      ...(body.default_unit !== undefined
        ? { defaultUnit: String(body.default_unit || "").trim().toLowerCase() }
        : {}),
      ...(body.available_count !== undefined
        ? {
            availableCount:
              body.available_count == null
                ? null
                : Math.max(0, Number(body.available_count) || 0),
          }
        : {}),
      ...(body.damaged_count !== undefined && existing.type === "UTENSIL"
        ? {
            damagedCount: Math.max(0, Number(body.damaged_count) || 0),
          }
        : {}),
      ...(body.photo_url !== undefined ? { photoUrl: body.photo_url } : {}),
    };
    if (Array.isArray(body.unit_options)) {
      patch.unitOptions = body.unit_options
        .map((u) => String(u ?? "").trim().toLowerCase())
        .filter(Boolean);
    }
    if (body.category_slug !== undefined || body.category !== undefined) {
      const categorySlug = String(body.category_slug ?? body.category ?? "")
        .trim()
        .toLowerCase();
      if (!categorySlug) {
        return errorResponse(res, "category_slug is required", 200, "VALIDATION_ERROR");
      }
      const categoryRow = await loadSupplyCategoryBySlug(categorySlug);
      if (!categoryRow) {
        return errorResponse(
          res,
          "category_slug must match an active supply category slug",
          200,
          "VALIDATION_ERROR",
        );
      }
      patch.categorySlug = categoryRow.slug;
    }
    if (patch.unitOptions && patch.unitOptions.length === 0) {
      return errorResponse(
        res,
        "unit_options must have at least one unit",
        200,
        "VALIDATION_ERROR",
      );
    }
    const finalUnitOptions = patch.unitOptions ?? existing.unitOptions ?? [];
    const finalDefaultUnit = patch.defaultUnit ?? existing.defaultUnit;
    if (!finalDefaultUnit || !finalUnitOptions.includes(finalDefaultUnit)) {
      return errorResponse(
        res,
        "default_unit must be one of unit_options",
        200,
        "VALIDATION_ERROR",
      );
    }
    const finalAvailableCount =
      patch.availableCount !== undefined
        ? patch.availableCount
        : existing.availableCount;
    const finalDamagedCount =
      patch.damagedCount !== undefined ? patch.damagedCount : existing.damagedCount ?? 0;
    if (
      existing.type === "UTENSIL" &&
      finalAvailableCount != null &&
      finalDamagedCount > finalAvailableCount
    ) {
      return errorResponse(
        res,
        "damaged_count cannot exceed available_count",
        200,
        "VALIDATION_ERROR",
      );
    }
    const row = await prisma.supplyItem.update({
      where: { id },
      data: patch,
      include: { category: true },
    });
    return successResponse(
      res,
      "Supply item updated",
      serializeSupplyItem(row, getRequestedLanguage(req)),
    );
  } catch (e) {
    console.error("updateSupplyItem:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function deleteSupplyItem(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const id = req.params.id;
    const existing = await prisma.supplyItem.findFirst({
      where: {
        id,
        isActive: true,
        OR: supplyVisibilityOrBranches(businessId, userId),
      },
      select: { id: true },
    });
    if (!existing) return errorResponse(res, "Supply item not found", 404, "NOT_FOUND");
    await prisma.supplyItem.update({ where: { id }, data: { isActive: false } });
    return successResponse(res, "Supply item deleted", { id });
  } catch (e) {
    console.error("deleteSupplyItem:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function listSupplyUnits(req, res) {
  try {
    const rows = await prisma.unit.findMany({
      orderBy: [{ name: "asc" }, { createdAt: "desc" }],
    });
    return successResponse(res, "OK", {
      units: rows.map(serializeSupplyUnit),
    });
  } catch (e) {
    console.error("listSupplyUnits:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function createSupplyUnit(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name ?? "").trim();
    const slug = String(body.slug ?? "")
      .trim()
      .toLowerCase();
    if (!name) return errorResponse(res, "Unit name is required", 200, "VALIDATION_ERROR");
    if (!slug) return errorResponse(res, "Unit slug is required", 200, "VALIDATION_ERROR");
    const existing = await prisma.unit.findUnique({ where: { slug } });
    if (existing) return errorResponse(res, "Unit slug already exists", 200, "VALIDATION_ERROR");
    const row = await prisma.unit.create({
      data: { name, slug },
    });
    return successResponse(res, "Supply unit created", serializeSupplyUnit(row));
  } catch (e) {
    console.error("createSupplyUnit:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function updateSupplyUnit(req, res) {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const existing = await prisma.unit.findUnique({ where: { id } });
    if (!existing) return errorResponse(res, "Supply unit not found", 404, "NOT_FOUND");
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) return errorResponse(res, "Unit name is required", 200, "VALIDATION_ERROR");
      patch.name = name;
    }
    if (body.slug !== undefined) {
      const slug = String(body.slug ?? "")
        .trim()
        .toLowerCase();
      if (!slug) return errorResponse(res, "Unit slug is required", 200, "VALIDATION_ERROR");
      const conflict = await prisma.unit.findFirst({
        where: { slug, id: { not: id } },
        select: { id: true },
      });
      if (conflict) {
        return errorResponse(res, "Unit slug already exists", 200, "VALIDATION_ERROR");
      }
      patch.slug = slug;
    }
    const row = await prisma.unit.update({ where: { id }, data: patch });
    return successResponse(res, "Supply unit updated", serializeSupplyUnit(row));
  } catch (e) {
    console.error("updateSupplyUnit:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function deleteSupplyUnit(req, res) {
  try {
    const id = req.params.id;
    const existing = await prisma.unit.findUnique({ where: { id } });
    if (!existing) return errorResponse(res, "Supply unit not found", 404, "NOT_FOUND");
    await prisma.unit.delete({ where: { id } });
    return successResponse(res, "Supply unit deleted", { id });
  } catch (e) {
    console.error("deleteSupplyUnit:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function setBookingSupplyItems(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const bookingId = req.params.id;
    const payload = Array.isArray(req.body?.items) ? req.body.items : [];
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
    const ids = [
      ...new Set(
        payload
          .map((row) => String(row.supply_item_id || "").trim())
          .filter(Boolean),
      ),
    ];
    const supplyRows = await prisma.supplyItem.findMany({
      where: {
        id: { in: ids },
        isActive: true,
        OR: supplyVisibilityOrBranches(businessId, userId),
      },
      include: { category: true },
    });
    const byId = new Map(supplyRows.map((row) => [row.id, row]));
    if (supplyRows.length !== ids.length) {
      return errorResponse(
        res,
        "One or more supply items not found",
        200,
        "VALIDATION_ERROR",
      );
    }

    for (const row of supplyRows) {
      if (row.businessId != null && row.businessId !== businessId) {
        return errorResponse(
          res,
          "One or more supply items not found",
          200,
          "VALIDATION_ERROR",
        );
      }
    }

    for (const row of payload) {
      const source = byId.get(String(row.supply_item_id || "").trim());
      if (!source) continue;
      const msg = utensilStockExceededMessage(source, row.quantity, 0);
      if (msg) return errorResponse(res, msg, 200, "VALIDATION_ERROR");
    }

    const createRows = payload.map((row) => {
      const source = byId.get(String(row.supply_item_id));
      // Quantity 0 is kept — a listed item with the amount still to be decided.
      let qty;
      if (source.type === "UTENSIL") {
        const p = parseInt(String(row.quantity), 10);
        qty = Math.max(0, Math.min(999, Number.isFinite(p) ? p : 0));
      } else {
        const p = parseFloat(String(row.quantity));
        const safe = Number.isFinite(p) && p > 0 ? p : 0;
        qty = Math.min(999, Math.max(0, Math.round(safe * 100) / 100));
      }
      if (source.type === "UTENSIL") {
        const cap = effectiveUtensilAssignable(source, 0);
        if (cap != null && qty > cap) qty = cap;
      }
      return {
        bookingId,
        supplyItemId: source.id,
        quantity: qty,
        unit: String(row.unit || source.defaultUnit || "pcs"),
        categorySlug: source.categorySlug,
        nameSnapshot: source.name,
      };
    });

    // Array-form transaction: single round trip, no interactive transaction id
    // for a pooled Supabase connection to lose mid-flight (P2028).
    await prisma.$transaction([
      prisma.bookingSupplyItem.deleteMany({ where: { bookingId } }),
      ...(createRows.length
        ? [prisma.bookingSupplyItem.createMany({ data: createRows })]
        : []),
    ]);
    return successResponse(res, "Supply items updated", { ok: true });
  } catch (e) {
    console.error("setBookingSupplyItems:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function getBookingSupplyItems(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const lang = getRequestedLanguage(req);
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true },
    });
    if (!booking) return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    const rows = await prisma.bookingSupplyItem.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
    });
    return successResponse(res, "OK", {
      items: rows.map((row) => ({
        supply_item_id: row.supplyItemId,
        quantity: row.quantity,
        unit: row.unit,
        category: row.categorySlug,
        name: resolveLocalizedName(row.nameSnapshot, lang),
        name_i18n: normalizeLocalizedName(row.nameSnapshot) || { en: "" },
      })),
    });
  } catch (e) {
    console.error("getBookingSupplyItems:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function setEventSupplyItems(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;
    const body = req.body || {};
    const itemType = String(body.type || "INGREDIENT").toUpperCase();
    if (!VALID_TYPES.has(itemType)) {
      return errorResponse(res, "Invalid type", 200, "VALIDATION_ERROR");
    }
    const payload = Array.isArray(body.items) ? body.items : [];
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
      select: { id: true },
    });
    if (!event) return errorResponse(res, "Event not found", 404, "NOT_FOUND");
    const ids = [
      ...new Set(
        payload
          .map((row) => String(row.supply_item_id || "").trim())
          .filter(Boolean),
      ),
    ];
    const supplyRows = await prisma.supplyItem.findMany({
      where: {
        id: { in: ids },
        isActive: true,
        OR: supplyVisibilityOrBranches(businessId, userId),
      },
      include: { category: true },
    });
    const byId = new Map(supplyRows.map((row) => [row.id, row]));
    if (supplyRows.length !== ids.length) {
      return errorResponse(
        res,
        "One or more supply items not found",
        200,
        "VALIDATION_ERROR",
      );
    }

    for (const row of supplyRows) {
      if (row.businessId != null && row.businessId !== businessId) {
        return errorResponse(
          res,
          "One or more supply items not found",
          200,
          "VALIDATION_ERROR",
        );
      }
    }

    let assignedElsewhereByItem = new Map();
    if (itemType === "UTENSIL") {
      const assignmentRows = await prisma.bookingEventSupplyItem.groupBy({
        by: ["supplyItemId"],
        where: {
          itemType: "UTENSIL",
          supplyItemId: { in: ids },
          bookingEventId: { not: eventId },
          bookingEvent: {
            status: { in: ACTIVE_UTENSIL_EVENT_STATUSES },
            booking: { businessId },
          },
        },
        _sum: { quantity: true },
      });
      assignedElsewhereByItem = new Map(
        assignmentRows.map((row) => [row.supplyItemId, row._sum.quantity ?? 0]),
      );

      for (const row of payload) {
        const source = byId.get(String(row.supply_item_id || "").trim());
        if (!source) continue;
        const assignedElsewhere =
          assignedElsewhereByItem.get(source.id) ?? 0;
        const msg = utensilStockExceededMessage(
          source,
          row.quantity,
          assignedElsewhere,
        );
        if (msg) return errorResponse(res, msg, 200, "VALIDATION_ERROR");
      }
    }

    const createRows = payload.map((row) => {
      const source = byId.get(String(row.supply_item_id));
      // Quantity 0 is kept for both types — a listed item whose amount is still
      // TBD. Ingredients may be fractional (1.5 kg); utensils stay whole.
      let qty;
      if (itemType === "INGREDIENT") {
        const parsedQty = parseFloat(String(row.quantity));
        const safeQty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 0;
        qty = Math.min(999, Math.max(0, Math.round(safeQty * 100) / 100));
      } else {
        const p = parseInt(String(row.quantity), 10);
        qty = Math.max(0, Math.min(999, Number.isFinite(p) ? p : 0));
      }
      if (itemType === "UTENSIL") {
        const cap = effectiveUtensilAssignable(
          source,
          assignedElsewhereByItem.get(source.id) ?? 0,
        );
        if (cap != null && qty > cap) qty = cap;
      }
      return {
        bookingEventId: eventId,
        supplyItemId: source.id,
        itemType,
        quantity: qty,
        unit: String(row.unit || source.defaultUnit || "pcs"),
        categorySlug: source.categorySlug,
        nameSnapshot: source.name,
      };
    });

    // Batched (array-form) transaction rather than an interactive callback —
    // one round trip, no client-held transaction id that a pooled Supabase
    // connection can drop mid-flight (P2028 "transaction not found").
    await prisma.$transaction([
      prisma.bookingEventSupplyItem.deleteMany({
        where: { bookingEventId: eventId, itemType },
      }),
      ...(createRows.length
        ? [prisma.bookingEventSupplyItem.createMany({ data: createRows })]
        : []),
    ]);
    return successResponse(res, "Event supply items updated", { ok: true });
  } catch (e) {
    console.error("setEventSupplyItems:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

function buildSupplySummaryFlags(groupedByType, hasSavedList) {
  const types = new Set((groupedByType || []).map((g) => g.itemType));
  const hasIngredients = types.has("INGREDIENT");
  const hasUtensils = types.has("UTENSIL");
  return {
    has_ingredients: hasIngredients,
    has_utensils: hasUtensils,
    has_saved_list: hasSavedList,
    has_supply_items: hasIngredients || hasUtensils || hasSavedList,
  };
}

/**
 * GET .../eventsSupplySummaries — flags for all events on a booking (one round-trip).
 */
async function getBookingEventsSupplySummaries(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: {
        events: { select: { id: true } },
      },
    });
    if (!booking) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }

    const eventIds = booking.events.map((e) => e.id);
    if (eventIds.length === 0) {
      return successResponse(res, "OK", { summaries: {} });
    }

    const [grouped, savedLists] = await Promise.all([
      prisma.bookingEventSupplyItem.groupBy({
        by: ["bookingEventId", "itemType"],
        where: { bookingEventId: { in: eventIds } },
        _count: { _all: true },
      }),
      prisma.supplySavedList.findMany({
        where: { businessId, bookingEventId: { in: eventIds } },
        select: { bookingEventId: true },
        distinct: ["bookingEventId"],
      }),
    ]);

    const savedSet = new Set(
      savedLists.map((r) => r.bookingEventId).filter(Boolean),
    );
    const byEvent = new Map();
    for (const row of grouped) {
      const list = byEvent.get(row.bookingEventId) || [];
      list.push({ itemType: row.itemType });
      byEvent.set(row.bookingEventId, list);
    }

    const summaries = {};
    for (const eventId of eventIds) {
      summaries[eventId] = buildSupplySummaryFlags(
        byEvent.get(eventId) || [],
        savedSet.has(eventId),
      );
    }

    return successResponse(res, "OK", { summaries });
  } catch (e) {
    console.error("getBookingEventsSupplySummaries:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * GET .../events/:eventId/supplySummary — lightweight flags for navigation/UI.
 */
async function getEventSupplySummary(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;

    const event = await prisma.bookingEvent.findFirst({
      where: {
        id: eventId,
        bookingId,
        booking: { businessId },
      },
      select: { id: true },
    });
    if (!event) {
      return errorResponse(res, "Event not found", 404, "NOT_FOUND");
    }

    const [grouped, savedList] = await Promise.all([
      prisma.bookingEventSupplyItem.groupBy({
        by: ["itemType"],
        where: { bookingEventId: eventId },
        _count: { _all: true },
      }),
      prisma.supplySavedList.findFirst({
        where: { businessId, bookingEventId: eventId },
        select: { id: true },
      }),
    ]);

    return successResponse(
      res,
      "OK",
      buildSupplySummaryFlags(grouped, Boolean(savedList)),
    );
  } catch (e) {
    console.error("getEventSupplySummary:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function getEventSupplyItems(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;
    const lang = getRequestedLanguage(req);
    const itemType = req.query.type ? String(req.query.type).toUpperCase() : undefined;
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true },
    });
    if (!booking) return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    const rows = await prisma.bookingEventSupplyItem.findMany({
      where: {
        bookingEventId: eventId,
        ...(itemType && VALID_TYPES.has(itemType) ? { itemType } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    return successResponse(res, "OK", {
      items: rows.map((row) => ({
        supply_item_id: row.supplyItemId,
        quantity: row.quantity,
        unit: row.unit,
        category: row.categorySlug,
        type: row.itemType,
        name: resolveLocalizedName(row.nameSnapshot, lang),
        name_i18n: normalizeLocalizedName(row.nameSnapshot) || { en: "" },
      })),
    });
  } catch (e) {
    console.error("getEventSupplyItems:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function updateEventSupplyItem(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;
    const supplyItemId = req.params.supplyItemId;
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
    const row = await prisma.bookingEventSupplyItem.findFirst({
      where: { bookingEventId: eventId, supplyItemId },
    });
    if (!row) return errorResponse(res, "Supply item not found", 404, "NOT_FOUND");
    await prisma.bookingEventSupplyItem.update({
      where: { id: row.id },
      data: {
        ...(req.body?.quantity !== undefined
          ? {
              quantity: Math.max(
                1,
                Math.min(999, parseInt(String(req.body.quantity), 10) || 1),
              ),
            }
          : {}),
        ...(req.body?.unit !== undefined
          ? { unit: String(req.body.unit || row.unit) }
          : {}),
      },
    });
    return successResponse(res, "Event supply item updated", { ok: true });
  } catch (e) {
    console.error("updateEventSupplyItem:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function deleteEventSupplyItem(req, res) {
  try {
    const businessId = req.businessId;
    const bookingId = req.params.id;
    const eventId = req.params.eventId;
    const supplyItemId = req.params.supplyItemId;
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
    await prisma.bookingEventSupplyItem.deleteMany({
      where: { bookingEventId: eventId, supplyItemId },
    });
    return successResponse(res, "Event supply item deleted", { ok: true });
  } catch (e) {
    console.error("deleteEventSupplyItem:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/** Mirrors `menuController` visibility for catalog menu rows. */
function deriveMenuIsGlobal(businessId, createdByUserId) {
  if (businessId == null || businessId === "") return true;
  if (createdByUserId == null || createdByUserId === "") return true;
  return false;
}

function canViewMenuItemForSupply(menu, contextBusinessId, userId) {
  if (menu.createdByUserId === userId) return true;
  if (menu.businessId != null && menu.businessId !== contextBusinessId) {
    return false;
  }
  if (menu.businessId == null) return menu.isGlobal === true;
  return deriveMenuIsGlobal(menu.businessId, menu.createdByUserId);
}

function normalizeMenuIngredients(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [];
  return raw;
}

/**
 * Suggested/template ingredient quantities may now be fractional (e.g. a
 * recipe scaled to 2.5 kg) — round to 2 decimals instead of ceiling to a
 * whole number so precision survives. A non-positive input still means "no
 * computed value yet" and keeps the previous friendly default of 1.
 */
function roundSupplyQty(n) {
  const v = Number(n) || 0;
  if (v <= 0) return 1;
  return Math.min(999, Math.max(0.01, Math.round(v * 100) / 100));
}

function supplyUnitOptionsForRow(src, preferredUnit) {
  const pref = String(preferredUnit ?? "").trim();
  const fromRow = Array.isArray(src?.unitOptions)
    ? src.unitOptions.map((u) => String(u ?? "").trim()).filter(Boolean)
    : [];
  const fallback = pref || src?.defaultUnit || fromRow[0] || "kg";
  const merged = [...fromRow];
  if (pref && !merged.includes(pref)) merged.unshift(pref);
  if (!merged.includes(fallback)) merged.push(fallback);
  return merged.length ? merged : [fallback];
}

/**
 * Core scan of an event's menu-item snapshot rows, building both the
 * whole-event aggregate buckets (for `suggestions`) and the per-menu-item
 * breakdown (for `menu_items`) in one pass. Extracted so
 * `computeMenuItemIngredientBreakdown` (used by the full-booking-PDF
 * endpoint) can reuse the exact same scaling math without duplicating it.
 */
function computeEventMenuIngredientData(menuItems, guestMul, menuById, language) {
  /** key = supplyItemId + "\t" + unit -> scaled numeric qty */
  const buckets = new Map();
  const legacy = [];
  /** menuItemId -> { menu_item_id, name, quantity_per_plate, rows: Map<key, {supply_item_id, unit, qty_per_plate, quantity, cost}> } */
  const byMenuItem = new Map();

  for (const row of menuItems) {
    const mid = String(row?.id ?? "").trim();
    const menu = menuById.get(mid);
    if (!menu) continue;
    const qpp = Math.max(
      1,
      Math.floor(Number(row?.quantity_per_plate ?? row?.quantity ?? 1) || 1),
    );
    const plates = qpp * guestMul;
    const ingredients = normalizeMenuIngredients(menu.ingredients);
    let itemEntry = byMenuItem.get(mid);
    if (!itemEntry) {
      itemEntry = {
        menu_item_id: mid,
        name: resolveLocalizedName(menu.name, language),
        quantity_per_plate: qpp,
        rows: new Map(),
      };
      byMenuItem.set(mid, itemEntry);
    }
    for (const ing of ingredients) {
      const sidRaw = ing?.supply_item_id ?? ing?.supplyItemId;
      const sid = typeof sidRaw === "string" ? sidRaw.trim() : "";
      const rawQty = ing?.qty ?? ing?.quantity;
      const q = Number(String(rawQty ?? "").trim());
      const baseQty = Number.isFinite(q) && q > 0 ? q : 0;
      const unit = String(ing?.unit ?? "").trim() || "kg";
      const scaled = baseQty * plates;
      if (!sid) {
        const nm = String(ing?.name ?? "").trim();
        if (nm) {
          legacy.push({ name: nm, unit, note: "no_supply_item_id" });
        }
        continue;
      }
      const key = `${sid}\t${unit}`;
      // A recipe ingredient with no quantity defined yet (baseQty === 0, e.g. a
      // freshly-added menu ingredient) must still surface in the per-menu-item
      // breakdown so the caterer can define it there for the first time — only
      // the whole-event aggregate `suggestions` list skips zero-quantity rows.
      if (scaled > 0) {
        buckets.set(key, (buckets.get(key) ?? 0) + scaled);
      }
      const existingRow = itemEntry.rows.get(key);
      const rawCost = ing?.cost;
      const cost = typeof rawCost === "number" ? rawCost : Number(rawCost);
      itemEntry.rows.set(key, {
        supply_item_id: sid,
        unit,
        qty_per_plate: baseQty,
        quantity: (existingRow?.quantity ?? 0) + scaled,
        // Preserved as-is (not scaled) so a client full-replace save doesn't
        // silently zero out MenuItem's estimated_cost/profit calculation.
        cost: Number.isFinite(cost) ? cost : (existingRow?.cost ?? undefined),
      });
    }
  }

  return { buckets, legacy, byMenuItem };
}

/**
 * Per-menu-item ingredient breakdown for one booking event, scaled to its
 * guest count — the recipe-computed view (no per-event manual overrides
 * merged in, since those aren't attributable back to a specific dish). Used
 * by the full-booking-PDF endpoint to build the "Ingredients by dish"
 * sub-section for each event.
 */
async function computeMenuItemIngredientBreakdown(
  event,
  businessId,
  userId,
  language,
  includeEmpty = false,
) {
  const snap = event.eventSnapshot;
  const menuItems = Array.isArray(snap?.menu_items) ? snap.menu_items : [];
  if (menuItems.length === 0) return [];

  const guests = Math.max(0, Number(event.guestCount) || 0);
  const guestMul = guests > 0 ? guests : 1;

  const menuIds = [
    ...new Set(menuItems.map((row) => String(row?.id ?? "").trim()).filter(Boolean)),
  ];
  if (menuIds.length === 0) return [];

  const menus = await prisma.menuItem.findMany({
    where: { id: { in: menuIds } },
    include: { category: true },
  });
  const visibleMenus = menus.filter((m) => canViewMenuItemForSupply(m, businessId, userId));
  const menuById = new Map(visibleMenus.map((m) => [m.id, m]));

  const { byMenuItem } = computeEventMenuIngredientData(menuItems, guestMul, menuById, language);

  const supplyIds = [
    ...new Set(
      [...byMenuItem.values()].flatMap((item) =>
        [...item.rows.values()].map((r) => r.supply_item_id),
      ),
    ),
  ];
  if (supplyIds.length === 0) {
    return [...byMenuItem.values()].map((item) => ({
      menu_item_id: item.menu_item_id,
      name: item.name,
      ingredients: [],
    }));
  }

  const supplyRows = await prisma.supplyItem.findMany({
    where: {
      id: { in: supplyIds },
      type: "INGREDIENT",
      isActive: true,
      OR: supplyVisibilityOrBranches(businessId, userId),
    },
  });
  const supplyById = new Map(supplyRows.map((r) => [r.id, r]));

  return [...byMenuItem.values()].map((item) => {
    const ingredientsOut = [];
    for (const rowEntry of item.rows.values()) {
      const src = supplyById.get(rowEntry.supply_item_id);
      if (!src) continue;
      const hasQty = rowEntry.quantity > 0;
      // Recipe ingredient with no quantity defined yet: kept for the working
      // supply-list view (`includeEmpty`), omitted from PDFs.
      if (!hasQty && !includeEmpty) continue;
      ingredientsOut.push({
        supply_item_id: rowEntry.supply_item_id,
        name: resolveLocalizedName(src.name, language),
        unit: rowEntry.unit,
        quantity: hasQty ? roundSupplyQty(rowEntry.quantity) : 0,
        category_slug: src.categorySlug,
      });
    }
    return {
      menu_item_id: item.menu_item_id,
      name: item.name,
      ingredients: ingredientsOut,
    };
  });
}

/**
 * GET /v1/bookings/:id/fullPdfSupplyBreakdown
 *
 * Assembles, for every event of a booking in one request, the data the
 * full-booking PDF needs beyond what `getBooking` already returns:
 *  - per-menu-item ingredient breakdown per event (recipe-computed, scaled
 *    to that event's guest count).
 *  - each event's actually-saved utensils (BookingEventSupplyItem, UTENSIL).
 * Plus booking-wide totals for both ingredients and utensils, keyed by
 * supply item, with a per-event quantity map — feeds the "Total Ingredients
 * Used" / "Total Utensils Used" pivot tables. Totals use each event's
 * actually-saved supply-list quantities; an event with nothing saved yet
 * falls back to its recipe-computed sum so it isn't silently omitted.
 */
async function getFullBookingPdfSupplyBreakdown(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const language = getRequestedLanguage(req);
    const bookingId = req.params.id;
    // The working "Booking Supply List" screen asks for zero-quantity
    // ingredients too (so the caterer can see and fill them in); PDF callers
    // omit this flag and keep zero-quantity rows out.
    const includeEmpty =
      req.query.include_empty === "1" || req.query.include_empty === "true";

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true },
    });
    if (!booking) return errorResponse(res, "Booking not found", 404, "NOT_FOUND");

    const events = await prisma.bookingEvent.findMany({
      where: { bookingId },
      orderBy: { eventAt: "asc" },
      select: { id: true, eventSnapshot: true, guestCount: true, eventAt: true },
    });

    const savedRows = await prisma.bookingEventSupplyItem.findMany({
      where: { bookingEvent: { bookingId } },
      orderBy: { createdAt: "asc" },
    });
    /** `${eventId}\t${itemType}` -> rows[] */
    const savedByEventAndType = new Map();
    for (const row of savedRows) {
      const key = `${row.bookingEventId}\t${row.itemType}`;
      if (!savedByEventAndType.has(key)) savedByEventAndType.set(key, []);
      savedByEventAndType.get(key).push(row);
    }

    const eventsOut = [];
    /** supplyItemId (or synthetic key for a not-yet-saved fallback) -> accumulator */
    const ingredientTotals = new Map();
    const utensilTotals = new Map();

    const addToTotals = (map, key, name, unit, eventId, qty, category) => {
      const n = Number(qty) || 0;
      if (n <= 0 && !includeEmpty) return;
      if (!map.has(key)) {
        map.set(key, { name, unit, category, perEvent: new Map(), total: 0 });
      }
      const entry = map.get(key);
      entry.perEvent.set(eventId, (entry.perEvent.get(eventId) ?? 0) + n);
      entry.total += n;
    };

    for (const event of events) {
      const menuItemsBreakdown = await computeMenuItemIngredientBreakdown(
        event,
        businessId,
        userId,
        language,
        includeEmpty,
      );

      const savedIngredientRows = savedByEventAndType.get(`${event.id}\tINGREDIENT`) ?? [];
      const savedUtensilRows = savedByEventAndType.get(`${event.id}\tUTENSIL`) ?? [];

      eventsOut.push({
        event_id: event.id,
        menu_items: menuItemsBreakdown.map(({ menu_item_id, name, ingredients }) => ({
          menu_item_id,
          name,
          ingredients: ingredients.map(({ name: n, unit, quantity, category_slug }) => ({
            name: n,
            unit,
            quantity,
            category_slug,
          })),
        })),
        utensils: savedUtensilRows.map((row) => ({
          name: resolveLocalizedName(row.nameSnapshot, language),
          quantity: row.quantity,
          unit: row.unit,
        })),
      });

      if (savedIngredientRows.length > 0) {
        for (const row of savedIngredientRows) {
          addToTotals(
            ingredientTotals,
            row.supplyItemId,
            resolveLocalizedName(row.nameSnapshot, language),
            row.unit,
            event.id,
            row.quantity,
            row.categorySlug,
          );
        }
      } else {
        for (const item of menuItemsBreakdown) {
          for (const ing of item.ingredients) {
            addToTotals(
              ingredientTotals,
              ing.supply_item_id,
              ing.name,
              ing.unit,
              event.id,
              ing.quantity,
              ing.category_slug,
            );
          }
        }
      }

      for (const row of savedUtensilRows) {
        addToTotals(
          utensilTotals,
          row.supplyItemId,
          resolveLocalizedName(row.nameSnapshot, language),
          row.unit,
          event.id,
          row.quantity,
          row.categorySlug,
        );
      }
    }

    const toRows = (map) =>
      [...map.entries()]
        .map(([supplyItemId, e]) => ({
          supply_item_id: supplyItemId,
          name: e.name,
          unit: e.unit,
          category_slug: e.category,
          per_event: Object.fromEntries(
            [...e.perEvent.entries()].map(([eid, q]) => [eid, Math.round(q * 100) / 100]),
          ),
          total: Math.round(e.total * 100) / 100,
        }))
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    // Manually-added booking-wide items (from the Booking Supply List screen)
    // aren't tied to any event — surfaced separately so callers (Documents
    // hub) can fold them into "whole booking" PDFs without misattributing
    // them to one arbitrary event.
    const bookingLevelRows = await prisma.bookingSupplyItem.findMany({
      where: { bookingId },
      include: { supplyItem: { select: { type: true } } },
      orderBy: { createdAt: "asc" },
    });
    const bookingLevelIngredients = [];
    const bookingLevelUtensils = [];
    for (const row of bookingLevelRows) {
      const out = {
        name: resolveLocalizedName(row.nameSnapshot, language),
        quantity: row.quantity,
        unit: row.unit,
        category_slug: row.categorySlug,
      };
      if (row.supplyItem?.type === "UTENSIL") {
        bookingLevelUtensils.push(out);
      } else {
        bookingLevelIngredients.push(out);
      }
    }

    return successResponse(res, "OK", {
      events: eventsOut,
      totals: {
        ingredients: toRows(ingredientTotals),
        utensils: toRows(utensilTotals),
      },
      booking_level: {
        ingredients: bookingLevelIngredients,
        utensils: bookingLevelUtensils,
      },
    });
  } catch (e) {
    console.error("getFullBookingPdfSupplyBreakdown:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

function buildSuggestedSupplyEventMeta(event, menuItemCount, lineCount) {
  return {
    guest_count: event.guestCount ?? null,
    menu_item_count: menuItemCount,
    ingredient_line_count: lineCount,
    function_type: event.functionType ?? null,
    event_at: event.eventAt ? event.eventAt.toISOString() : null,
  };
}

/**
 * GET /v1/bookings/:id/events/:eventId/suggestedSupplyFromMenu
 * Aggregates ingredient lines (with supply_item_id) from MenuItems referenced by the event snapshot,
 * scaled by ingredient qty × quantity_per_plate × guest_count (when guests > 0).
 * Merges saved event ingredient lines when present.
 */
async function getSuggestedEventSupplyFromMenu(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const language = getRequestedLanguage(req);
    const bookingId = req.params.id;
    const eventId = req.params.eventId;

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true, status: true },
    });
    if (!booking) {
      return errorResponse(res, "Booking not found", 404, "NOT_FOUND");
    }
    if (booking.status === "CANCELLED") {
      return errorResponse(
        res,
        "Cancelled booking cannot be used",
        422,
        "VALIDATION_ERROR",
      );
    }

    const event = await prisma.bookingEvent.findFirst({
      where: { id: eventId, bookingId },
      select: {
        id: true,
        eventSnapshot: true,
        guestCount: true,
        functionType: true,
        eventAt: true,
      },
    });
    if (!event) {
      return errorResponse(res, "Event not found", 404, "NOT_FOUND");
    }

    const eventMetaBase = buildSuggestedSupplyEventMeta(event, 0, 0);

    const snap = event.eventSnapshot;
    if (snap == null || typeof snap !== "object") {
      return successResponse(res, "OK", {
        suggestions: [],
        legacy_without_supply: [],
        menu_items: [],
        event: eventMetaBase,
        has_saved_ingredients: false,
      });
    }

    const menuItems = Array.isArray(snap.menu_items) ? snap.menu_items : [];
    const guests = Math.max(0, Number(event.guestCount) || 0);
    const guestMul = guests > 0 ? guests : 1;

    const savedRows = await prisma.bookingEventSupplyItem.findMany({
      where: { bookingEventId: eventId, itemType: "INGREDIENT" },
      orderBy: { createdAt: "asc" },
    });
    const savedBySupplyId = new Map(
      savedRows.map((r) => [r.supplyItemId, r]),
    );
    const hasSavedIngredients = savedRows.length > 0;

    if (menuItems.length === 0) {
      const savedSupplyIds = savedRows.map((r) => r.supplyItemId);
      const savedSupplyRows =
        savedSupplyIds.length > 0
          ? await prisma.supplyItem.findMany({
              where: {
                id: { in: savedSupplyIds },
                type: "INGREDIENT",
                isActive: true,
              },
            })
          : [];
      const savedSupplyById = new Map(savedSupplyRows.map((r) => [r.id, r]));
      const manualOnly = [];
      for (const row of savedRows) {
        const src = savedSupplyById.get(row.supplyItemId);
        manualOnly.push({
          supply_item_id: row.supplyItemId,
          name: resolveLocalizedName(row.nameSnapshot, language),
          quantity: row.quantity,
          template_quantity: 0,
          template_unit: row.unit,
          unit: row.unit,
          unit_options: src
            ? supplyUnitOptionsForRow(src, row.unit)
            : [row.unit],
          category_slug: row.categorySlug,
          from_menu: false,
        });
      }
      manualOnly.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || "")),
      );
      return successResponse(res, "OK", {
        suggestions: manualOnly,
        legacy_without_supply: [],
        menu_items: [],
        event: buildSuggestedSupplyEventMeta(
          event,
          0,
          manualOnly.length,
        ),
        has_saved_ingredients: hasSavedIngredients,
      });
    }

    const menuIds = [
      ...new Set(
        menuItems
          .map((row) => String(row?.id ?? "").trim())
          .filter(Boolean),
      ),
    ];
    if (menuIds.length === 0) {
      return successResponse(res, "OK", {
        suggestions: [],
        legacy_without_supply: [],
        menu_items: [],
        event: buildSuggestedSupplyEventMeta(event, menuItems.length, 0),
        has_saved_ingredients: hasSavedIngredients,
      });
    }

    const menus = await prisma.menuItem.findMany({
      where: { id: { in: menuIds } },
      include: { category: true },
    });

    const visibleMenus = menus.filter((m) =>
      canViewMenuItemForSupply(m, businessId, userId),
    );
    const menuById = new Map(visibleMenus.map((m) => [m.id, m]));

    const { buckets, legacy, byMenuItem } = computeEventMenuIngredientData(
      menuItems,
      guestMul,
      menuById,
      language,
    );

    // How many distinct dishes in this event use each ingredient — a saved
    // per-event override can only be attributed back to a single dish's card
    // when it's used in exactly one dish; when shared across dishes the
    // saved total can't be unambiguously split, so those cards keep showing
    // the recipe-template quantity.
    const supplyItemMenuItemCount = new Map();
    for (const item of byMenuItem.values()) {
      const seenInThisItem = new Set();
      for (const rowEntry of item.rows.values()) {
        if (seenInThisItem.has(rowEntry.supply_item_id)) continue;
        seenInThisItem.add(rowEntry.supply_item_id);
        supplyItemMenuItemCount.set(
          rowEntry.supply_item_id,
          (supplyItemMenuItemCount.get(rowEntry.supply_item_id) ?? 0) + 1,
        );
      }
    }

    const supplyIdsFromMenu = [
      ...new Set(
        [
          ...[...buckets.keys()].map((k) => k.split("\t")[0]),
          ...[...byMenuItem.values()].flatMap((item) =>
            [...item.rows.values()].map((r) => r.supply_item_id),
          ),
        ].filter(Boolean),
      ),
    ];
    const supplyIdsSaved = savedRows.map((r) => r.supplyItemId);
    const supplyIds = [
      ...new Set([...supplyIdsFromMenu, ...supplyIdsSaved]),
    ];

    if (supplyIds.length === 0) {
      // Still surface every event menu item (with an empty ingredient list) so
      // a business with no recipe defined yet can start one from scratch.
      const emptyMenuItems = [...byMenuItem.values()].map((item) => ({
        menu_item_id: item.menu_item_id,
        name: item.name,
        quantity_per_plate: item.quantity_per_plate,
        ingredients: [],
      }));
      return successResponse(res, "OK", {
        suggestions: [],
        legacy_without_supply: legacy,
        menu_items: emptyMenuItems,
        event: buildSuggestedSupplyEventMeta(event, menuItems.length, 0),
        has_saved_ingredients: hasSavedIngredients,
      });
    }

    const supplyRows = await prisma.supplyItem.findMany({
      where: {
        id: { in: supplyIds },
        type: "INGREDIENT",
        isActive: true,
        OR: supplyVisibilityOrBranches(businessId, userId),
      },
      include: { category: true },
    });
    const supplyById = new Map(supplyRows.map((r) => [r.id, r]));

    const suggestions = [];
    const seenSupplyIds = new Set();

    for (const [key, total] of buckets) {
      const [sid, unitFromIng] = key.split("\t");
      const src = supplyById.get(sid);
      if (!src) continue;
      const unit =
        unitFromIng ||
        src.defaultUnit ||
        (src.unitOptions && src.unitOptions[0]) ||
        "kg";
      const templateQty = roundSupplyQty(total);
      const templateUnit = unit;
      const saved = savedBySupplyId.get(sid);
      suggestions.push({
        supply_item_id: src.id,
        name: resolveLocalizedName(src.name, language),
        template_quantity: templateQty,
        template_unit: templateUnit,
        quantity: saved ? saved.quantity : templateQty,
        unit: saved?.unit || templateUnit,
        unit_options: supplyUnitOptionsForRow(src, templateUnit),
        category_slug: src.categorySlug,
        from_menu: true,
      });
      seenSupplyIds.add(sid);
    }

    for (const saved of savedRows) {
      if (seenSupplyIds.has(saved.supplyItemId)) continue;
      const src = supplyById.get(saved.supplyItemId);
      if (!src) continue;
      const defaultUnit =
        src.defaultUnit ||
        (src.unitOptions && src.unitOptions[0]) ||
        saved.unit ||
        "kg";
      suggestions.push({
        supply_item_id: src.id,
        name: resolveLocalizedName(src.name, language),
        template_quantity: 0,
        template_unit: defaultUnit,
        quantity: saved.quantity,
        unit: saved.unit,
        unit_options: supplyUnitOptionsForRow(src, saved.unit),
        category_slug: src.categorySlug,
        from_menu: false,
      });
      seenSupplyIds.add(saved.supplyItemId);
    }

    suggestions.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")),
    );

    const menu_items = [];
    for (const item of byMenuItem.values()) {
      const ingredientsOut = [];
      for (const rowEntry of item.rows.values()) {
        const src = supplyById.get(rowEntry.supply_item_id);
        if (!src) continue;
        const saved = savedBySupplyId.get(rowEntry.supply_item_id);
        const useSaved =
          saved && supplyItemMenuItemCount.get(rowEntry.supply_item_id) === 1;
        ingredientsOut.push({
          supply_item_id: rowEntry.supply_item_id,
          name: resolveLocalizedName(src.name, language),
          unit: useSaved ? saved.unit : rowEntry.unit,
          qty_per_plate: rowEntry.qty_per_plate,
          // A saved value is an explicit user choice — keep it as-is, including
          // 0. A recipe ingredient with no quantity defined starts at 0 too
          // (the caterer sets it here for the first time), rather than the old
          // filler default of 1.
          quantity: useSaved
            ? Math.min(999, Math.max(0, Math.round((Number(saved.quantity) || 0) * 100) / 100))
            : rowEntry.quantity > 0
              ? roundSupplyQty(rowEntry.quantity)
              : 0,
          category_slug: src.categorySlug,
          cost: rowEntry.cost ?? null,
        });
      }
      menu_items.push({
        menu_item_id: item.menu_item_id,
        name: item.name,
        quantity_per_plate: item.quantity_per_plate,
        ingredients: ingredientsOut,
      });
    }

    return successResponse(res, "OK", {
      suggestions,
      legacy_without_supply: legacy,
      menu_items,
      event: buildSuggestedSupplyEventMeta(
        event,
        menuItems.length,
        suggestions.length,
      ),
      has_saved_ingredients: hasSavedIngredients,
    });
  } catch (e) {
    console.error("getSuggestedEventSupplyFromMenu:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function shareBookingSupplyItems(req, res) {
  return successResponse(res, "Share request queued", { ok: true });
}

async function shareEventSupplyItems(req, res) {
  return successResponse(res, "Share request queued", { ok: true });
}

function normalizeVendorPhone(raw) {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function serializeVendor(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? "",
    whatsappNo: row.whatsappNo ?? "",
    categorySlug: row.categorySlug ?? "",
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function createVendor(req, res) {
  try {
    const businessId = req.businessId;
    const body = req.body || {};
    const name = String(body.name ?? "").trim();
    const whatsappNo = normalizeVendorPhone(
      body.whatsappNo ?? body.whatsapp_number ?? body.phone,
    );
    const categorySlug = String(body.categorySlug ?? body.category ?? "")
      .trim()
      .toLowerCase();
    const address = String(body.address ?? "").trim();
    if (!name) {
      return errorResponse(res, "Vendor name is required", 200, "VALIDATION_ERROR");
    }
    if (!whatsappNo || whatsappNo.length < 10) {
      return errorResponse(res, "Vendor phone is required", 200, "VALIDATION_ERROR");
    }
    if (!categorySlug) {
      return errorResponse(
        res,
        "Vendor category is required",
        200,
        "VALIDATION_ERROR",
      );
    }
    const row = await prisma.vendor.create({
      data: {
        businessId,
        name,
        whatsappNo,
        categorySlug,
        address: address || null,
      },
    });
    return successResponse(res, "Vendor created", serializeVendor(row));
  } catch (e) {
    console.error("createVendor:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function listVendors(req, res) {
  try {
    const businessId = req.businessId;
    const categorySlug = String(req.query.categorySlug ?? req.query.category ?? "")
      .trim()
      .toLowerCase();
    const q = String(req.query.q ?? "")
      .trim()
      .toLowerCase();
    const rows = await prisma.vendor.findMany({
      where: {
        businessId,
        isActive: true,
        ...(categorySlug ? { categorySlug } : {}),
      },
      orderBy: [{ name: "asc" }, { createdAt: "desc" }],
    });
    const filtered = q
      ? rows.filter((row) => {
          const hay = `${row.name} ${row.whatsappNo ?? ""} ${row.address ?? ""}`.toLowerCase();
          return hay.includes(q);
        })
      : rows;
    return successResponse(res, "OK", { vendors: filtered.map(serializeVendor) });
  } catch (e) {
    console.error("listVendors:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function updateVendor(req, res) {
  try {
    const businessId = req.businessId;
    const id = req.params.id;
    const body = req.body || {};
    const existing = await prisma.vendor.findFirst({
      where: { id, businessId, isActive: true },
      select: { id: true },
    });
    if (!existing) return errorResponse(res, "Vendor not found", 404, "NOT_FOUND");
    const data = {};
    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) {
        return errorResponse(res, "Vendor name is required", 200, "VALIDATION_ERROR");
      }
      data.name = name;
    }
    if (
      body.whatsappNo !== undefined ||
      body.whatsapp_number !== undefined ||
      body.phone !== undefined
    ) {
      const whatsappNo = normalizeVendorPhone(
        body.whatsappNo ?? body.whatsapp_number ?? body.phone,
      );
      if (!whatsappNo || whatsappNo.length < 10) {
        return errorResponse(res, "Vendor phone is required", 200, "VALIDATION_ERROR");
      }
      data.whatsappNo = whatsappNo;
    }
    if (body.categorySlug !== undefined || body.category !== undefined) {
      const categorySlug = String(body.categorySlug ?? body.category ?? "")
        .trim()
        .toLowerCase();
      if (!categorySlug) {
        return errorResponse(
          res,
          "Vendor category is required",
          200,
          "VALIDATION_ERROR",
        );
      }
      data.categorySlug = categorySlug;
    }
    if (body.address !== undefined) {
      const address = String(body.address ?? "").trim();
      data.address = address || null;
    }
    const row = await prisma.vendor.update({ where: { id }, data });
    return successResponse(res, "Vendor updated", serializeVendor(row));
  } catch (e) {
    console.error("updateVendor:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

async function deleteVendor(req, res) {
  try {
    const businessId = req.businessId;
    const id = req.params.id;
    const existing = await prisma.vendor.findFirst({
      where: { id, businessId, isActive: true },
      select: { id: true },
    });
    if (!existing) return errorResponse(res, "Vendor not found", 404, "NOT_FOUND");
    await prisma.vendor.update({ where: { id }, data: { isActive: false } });
    return successResponse(res, "Vendor deleted", { id });
  } catch (e) {
    console.error("deleteVendor:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

const ACTIVE_UTENSIL_EVENT_STATUSES = ["PENDING", "CONFIRMED"];

function formatEventAtIso(eventAt) {
  if (!eventAt) return null;
  try {
    return new Date(eventAt).toISOString();
  } catch {
    return null;
  }
}

function buildUtensilEventTitle(bookingEvent) {
  const fn = String(bookingEvent?.functionType ?? "").trim();
  if (fn) return fn;
  const customer = String(bookingEvent?.booking?.customerName ?? "").trim();
  if (customer) return customer;
  const code = String(bookingEvent?.booking?.bookingCode ?? "").trim();
  if (code) return code;
  return "Event";
}

function buildUtensilEventSubtitle(bookingEvent) {
  const parts = [];
  const at = formatEventAtIso(bookingEvent?.eventAt);
  if (at) {
    parts.push(
      new Date(at).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    );
  }
  const customer = String(bookingEvent?.booking?.customerName ?? "").trim();
  if (customer && customer !== buildUtensilEventTitle(bookingEvent)) {
    parts.push(customer);
  }
  return parts.join(" • ") || "—";
}

function computeUtensilAvailability(total, assigned, damaged) {
  const a = Math.max(0, Number(assigned) || 0);
  const d = Math.max(0, Number(damaged) || 0);
  if (total == null) {
    return {
      total: null,
      assigned: a,
      damaged: d,
      free: null,
      status: a > 0 ? "IN_USE" : d > 0 ? "DAMAGED" : "AVAILABLE",
    };
  }
  const t = Math.max(0, Number(total) || 0);
  const free = Math.max(0, t - a - d);
  let status = "AVAILABLE";
  if (a > 0) status = "IN_USE";
  else if (d > 0) status = "DAMAGED";
  return { total: t, assigned: a, damaged: d, free, status };
}

async function loadActiveUtensilAssignmentMap(businessId, supplyItemIds) {
  const map = new Map();
  if (!businessId || !Array.isArray(supplyItemIds) || supplyItemIds.length === 0) {
    return map;
  }
  const rows = await prisma.bookingEventSupplyItem.findMany({
    where: {
      itemType: "UTENSIL",
      supplyItemId: { in: supplyItemIds },
      bookingEvent: {
        status: { in: ACTIVE_UTENSIL_EVENT_STATUSES },
        booking: { businessId },
      },
    },
    select: {
      supplyItemId: true,
      quantity: true,
      unit: true,
      bookingEventId: true,
      bookingEvent: {
        select: {
          id: true,
          eventAt: true,
          functionType: true,
          booking: {
            select: {
              id: true,
              customerName: true,
              bookingCode: true,
            },
          },
        },
      },
    },
    orderBy: [{ bookingEvent: { eventAt: "asc" } }],
  });

  for (const row of rows) {
    const id = row.supplyItemId;
    if (!map.has(id)) {
      map.set(id, { assigned: 0, events: [] });
    }
    const entry = map.get(id);
    const qty = Math.max(0, parseInt(String(row.quantity), 10) || 0);
    entry.assigned += qty;
    entry.events.push({
      event_id: row.bookingEventId,
      booking_id: row.bookingEvent?.booking?.id ?? null,
      title: buildUtensilEventTitle(row.bookingEvent),
      subtitle: buildUtensilEventSubtitle(row.bookingEvent),
      event_at: formatEventAtIso(row.bookingEvent?.eventAt),
      quantity: qty,
      unit: row.unit,
    });
  }
  return map;
}

function serializeUtensilInventoryRow(row, assignmentEntry, lang) {
  const base = serializeSupplyItem(row, lang);
  const availability = computeUtensilAvailability(
    row.availableCount,
    assignmentEntry?.assigned ?? 0,
    row.damagedCount ?? 0,
  );
  return {
    ...base,
    total: availability.total,
    assigned: availability.assigned,
    damaged: availability.damaged,
    free: availability.free,
    status: availability.status,
    assigned_events: assignmentEntry?.events ?? [],
  };
}

/** GET /v1/utensilsInventory — catalog + computed in-use / free stock. */
async function getUtensilsInventory(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const language = getRequestedLanguage(req);
    const q = String(req.query.q ?? "").trim();
    const qLower = q.toLowerCase();
    const statusFilter = String(req.query.status ?? "all").trim().toLowerCase();

    const visibilityWhere = {
      AND: [
        { OR: supplyVisibilityOrBranches(businessId, userId) },
        { isActive: true },
        { type: "UTENSIL" },
      ],
    };

    let rows = await prisma.supplyItem.findMany({
      where: visibilityWhere,
      orderBy: { createdAt: "desc" },
      include: { category: true },
    });

    if (q) {
      rows = rows.filter((row) => nameMatchesSearch(row, qLower));
    }

    const assignmentMap = await loadActiveUtensilAssignmentMap(
      businessId,
      rows.map((row) => row.id),
    );

    let items = rows.map((row) =>
      serializeUtensilInventoryRow(row, assignmentMap.get(row.id), language),
    );

    if (statusFilter === "available") {
      items = items.filter(
        (row) => row.status === "AVAILABLE" && (row.free == null || row.free > 0),
      );
    } else if (statusFilter === "in_use") {
      items = items.filter((row) => row.assigned > 0);
    } else if (statusFilter === "damaged") {
      items = items.filter((row) => row.damaged > 0);
    }

    let totalUnits = 0;
    let assignedUnits = 0;
    let freeUnits = 0;
    let damagedUnits = 0;
    for (const row of items) {
      if (row.total != null) {
        totalUnits += row.total;
        assignedUnits += row.assigned;
        freeUnits += row.free ?? 0;
        damagedUnits += row.damaged ?? 0;
      }
    }

    return successResponse(res, "OK", {
      summary: {
        total_items: items.length,
        total_units: totalUnits,
        assigned_units: assignedUnits,
        free_units: freeUnits,
        damaged_units: damagedUnits,
      },
      items,
    });
  } catch (e) {
    console.error("getUtensilsInventory:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/** GET /v1/utensilsInventory/:id — single utensil + assigned events. */
async function getUtensilInventoryDetail(req, res) {
  try {
    const businessId = req.businessId;
    const userId = req.user?.userId;
    const language = getRequestedLanguage(req);
    const id = String(req.params.id || "").trim();
    if (!id) return errorResponse(res, "id is required", 200, "VALIDATION_ERROR");

    const row = await prisma.supplyItem.findFirst({
      where: {
        id,
        type: "UTENSIL",
        isActive: true,
        OR: supplyVisibilityOrBranches(businessId, userId),
      },
      include: { category: true },
    });
    if (!row) return errorResponse(res, "Utensil not found", 404, "NOT_FOUND");

    const assignmentMap = await loadActiveUtensilAssignmentMap(businessId, [row.id]);
    const item = serializeUtensilInventoryRow(
      row,
      assignmentMap.get(row.id),
      language,
    );

    return successResponse(res, "OK", { item });
  } catch (e) {
    console.error("getUtensilInventoryDetail:", e);
    return errorResponse(res, "Server error", 500, "SERVER_ERROR", e.message);
  }
}

/**
 * POST /v1/generateSupplyListPdf
 * Body: { document_label, heading, subtitle?, company_name?, company_address?,
 *   company_owner_name?, company_phone?, company_email?, company_gst?,
 *   table_labels: { item, qty, unit }, groups: [{ title, lines: [{ name, quantity, unit }] }] }
 * Returns: application/pdf
 */
async function generateSupplyListPdf(req, res) {
  try {
    if (!req.businessId) {
      return errorResponse(
        res,
        "Business not found",
        200,
        "VALIDATION_ERROR",
        "NO_BUSINESS",
      );
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const buffer = await renderSupplyPdfBuffer({
      documentLabel: body.document_label,
      heading: body.heading,
      subtitle: body.subtitle,
      companyName: body.company_name,
      companyAddress: body.company_address,
      companyOwnerName: body.company_owner_name,
      companyPhone: body.company_phone,
      companyEmail: body.company_email,
      companyGst: body.company_gst,
      tableLabels: body.table_labels,
      groups: body.groups,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="supply-requirement.pdf"',
    );
    return res.status(200).send(buffer);
  } catch (e) {
    console.error("generateSupplyListPdf:", e);
    return errorResponse(
      res,
      e.message || "Server error",
      500,
      "SERVER_ERROR",
      e.message,
    );
  }
}

module.exports = {
  createSupplyItem,
  listSupplyItems,
  listSupplyItemCategories,
  listSupplyUnits,
  createSupplyUnit,
  updateSupplyUnit,
  deleteSupplyUnit,
  updateSupplyItem,
  deleteSupplyItem,
  getUtensilsInventory,
  getUtensilInventoryDetail,
  setBookingSupplyItems,
  getBookingSupplyItems,
  setEventSupplyItems,
  getEventSupplyItems,
  getEventSupplySummary,
  getBookingEventsSupplySummaries,
  getSuggestedEventSupplyFromMenu,
  getFullBookingPdfSupplyBreakdown,
  createVendor,
  listVendors,
  updateVendor,
  deleteVendor,
  updateEventSupplyItem,
  deleteEventSupplyItem,
  shareBookingSupplyItems,
  shareEventSupplyItems,
  generateSupplyListPdf,
};

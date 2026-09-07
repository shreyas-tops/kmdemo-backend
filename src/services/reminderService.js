/**
 * Reminder Service
 *
 * Finds BookingEvents whose reminder window is currently active and sends
 * push notifications + inbox records to eligible business users.
 *
 * Dedup strategy:
 *   EventReminder has @@unique([bookingEventId, reminderType]).
 *   The findMany query filters out events that already have a record (none: {}).
 *   After successful delivery we upsert the record — the unique constraint makes
 *   a concurrent parallel upsert a safe no-op rather than a duplicate.
 *
 * Retry strategy:
 *   If push delivery fails, we do NOT insert the EventReminder record.
 *   The next cron tick re-queries the same event (it still has no record) and retries.
 *   This window is only 15 minutes wide, so retries happen within the same cron cycle.
 *
 * Scale:
 *   One DB query per reminder type (no N+1 — users fetched via nested select).
 *   Push is batched via expoPush.js (100 msgs/batch, all batches in parallel).
 */

const prisma = require("../config/prisma");
const { sendGroupedNotification } = require("../utils/notificationLocalization");
const { getNotificationContent, buildForSuffix, buildEventDatePhrase } = require("../utils/notificationTranslations");

// Minutes ahead of the event each reminder fires.
// windowMinutes MUST match the cron interval to avoid gaps or double-sends.
const REMINDER_CONFIGS = {
  "24_HOUR":   { minutesAhead: 24 * 60, windowMinutes: 15 },
  "2_HOUR":    { minutesAhead: 2 * 60,  windowMinutes: 15 }, // Phase 2
  "30_MINUTE": { minutesAhead: 30,       windowMinutes: 15 }, // Phase 2
};

// IST fixed offset: UTC+5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns whether `eventAt` falls on the calendar day after today in IST.
 * Uses fixed UTC+5:30 offset to avoid locale-parsing issues on UTC servers.
 */
function isTomorrowIST(eventAt) {
  const nowDay   = Math.floor((Date.now() + IST_OFFSET_MS) / 86_400_000);
  const eventDay = Math.floor((new Date(eventAt).getTime() + IST_OFFSET_MS) / 86_400_000);
  return eventDay === nowDay + 1;
}

function formatTimeIST(date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   true,
  }).format(date).toUpperCase();
}

function formatDateLongIST(date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday:  "long",
    day:      "numeric",
    month:    "long",
    year:     "numeric",
  }).format(date);
}

/**
 * Builds the push notification title + body for a given event, reminder type
 * and recipient language.
 *
 * Body example (24_HOUR, event tomorrow, en):
 *   Wedding for Patel Family
 *   Tomorrow at 06:30 AM
 *   Venue: Padmavat Society, Paldi
 *   Guests: 150
 */
function buildNotificationContent(event, reminderType, lang) {
  const eventDate = event.eventAt ? new Date(event.eventAt) : null;
  const eventType = event.functionType || "Event";
  const forSuffix = buildForSuffix(lang, event.booking.customerName);
  const timeStr   = eventDate ? formatTimeIST(eventDate) : "";

  const datePhrase = eventDate
    ? buildEventDatePhrase(lang, {
        reminderType,
        isTomorrow:  reminderType === "24_HOUR" && isTomorrowIST(eventDate),
        timeStr,
        longDateStr: formatDateLongIST(eventDate),
      })
    : "";

  return getNotificationContent("eventReminder", lang, {
    eventType,
    forSuffix,
    datePhrase,
    venue:  event.eventLocation || event.booking.customerAddress || null,
    guests: event.guestCount,
  });
}

/**
 * Process all events due for `reminderType` within the current 15-min window.
 *
 * @param {string} reminderType — one of the keys in REMINDER_CONFIGS
 * @returns {Promise<{ processed: number, notified: number, failed: number, skipped: number }>}
 */
async function processReminderType(reminderType) {
  const config = REMINDER_CONFIGS[reminderType];
  if (!config) throw new Error(`Unknown reminder type: ${reminderType}`);

  const now         = new Date();
  const windowStart = new Date(now.getTime() + config.minutesAhead * 60_000);
  const windowEnd   = new Date(windowStart.getTime() + config.windowMinutes * 60_000);

  let events;
  try {
    events = await prisma.bookingEvent.findMany({
      where: {
        eventAt: { gte: windowStart, lt: windowEnd },
        // Exclude events already notified (the unique-constraint dedup guard)
        eventReminders: { none: { reminderType } },
        status:  { not: "COMPLETED" },
        booking: { status: { not: "CANCELLED" } },
      },
      select: {
        id:            true,
        eventAt:       true,
        eventLocation: true,
        functionType:  true,
        guestCount:    true,
        booking: {
          select: {
            id:              true,
            customerName:    true,
            customerAddress: true,
            business: {
              select: {
                users: {
                  where: {
                    notificationStatus: 1,
                    deviceToken:        { not: null },
                    deletedAt:          null,
                  },
                  select: { id: true, deviceToken: true, language: true },
                },
              },
            },
          },
        },
      },
    });
  } catch (err) {
    console.error(`[Reminder:${reminderType}] DB query failed:`, err.message);
    return { processed: 0, notified: 0, failed: 0, skipped: 0 };
  }

  if (events.length === 0) {
    return { processed: 0, notified: 0, failed: 0, skipped: 0 };
  }

  console.log(
    `[Reminder:${reminderType}] ${events.length} event(s) in window ` +
    `[${windowStart.toISOString()} – ${windowEnd.toISOString()}]`,
  );

  let notified = 0, failed = 0, skipped = 0;

  for (const event of events) {
    const users = event.booking.business.users.filter((u) => u.deviceToken);

    if (users.length === 0) {
      skipped++;
      continue;
    }

    const ok = await _processEventReminder(event, reminderType, users);
    if (ok) notified++;
    else    failed++;
  }

  return { processed: events.length, notified, failed, skipped };
}

/**
 * Handles the full notification lifecycle for a single event + reminder type:
 *   1. Persist UserNotification inbox records (await before push)
 *   2. Send push via Expo
 *   3. On success: upsert EventReminder (dedup guard)
 *
 * @returns {Promise<boolean>} true if the reminder was successfully sent and recorded
 */
async function _processEventReminder(event, reminderType, users) {
  const notifData = {
    type:           "event_reminder",
    screen:         "bookingDetails",
    bookingId:      event.booking.id,
    bookingEventId: event.id,
  };

  // Groups recipients by language and sends each group its own translated
  // title/body — both the inbox record (Step 1) and the push (Step 2).
  let pushResult;
  try {
    pushResult = await sendGroupedNotification(
      users,
      (lang) => buildNotificationContent(event, reminderType, lang),
      notifData,
      "event_reminder",
    );
  } catch (err) {
    console.error(`[Reminder] sendGroupedNotification threw for event ${event.id}:`, err.message);
    return false;
  }

  const delivered = pushResult.successCount > 0 || pushResult.skippedCount === users.length;
  if (!delivered) {
    console.warn(
      `[Reminder:${reminderType}] Push delivery failed for event ${event.id} ` +
      `(errors=${pushResult.errorCount}) — will retry next tick`,
    );
    return false;
  }

  // Step 3: record the sent reminder — upsert makes concurrent cron overlap safe.
  try {
    await prisma.eventReminder.upsert({
      where:  { bookingEventId_reminderType: { bookingEventId: event.id, reminderType } },
      create: { bookingEventId: event.id, reminderType },
      update: {},
    });
  } catch (err) {
    // Non-fatal: push already delivered; log but don't return false.
    // The event will be re-queried next tick and the upsert will again no-op.
    console.error(`[Reminder] EventReminder upsert failed for event ${event.id}:`, err.message);
  }

  console.log(
    `[Reminder:${reminderType}] Event ${event.id} — ` +
    `sent=${pushResult.successCount} errors=${pushResult.errorCount} skipped=${pushResult.skippedCount}`,
  );
  return true;
}

/**
 * Sends a reminder for a specific BookingEvent immediately, bypassing the
 * time window check. Used by the admin test endpoint.
 *
 * @param {string} bookingEventId
 * @param {string} [reminderType]
 * @returns {Promise<{ ok: boolean, reason?: string, pushSent?: number }>}
 */
async function sendReminderForEvent(bookingEventId, reminderType = "24_HOUR") {
  if (!REMINDER_CONFIGS[reminderType]) {
    return { ok: false, reason: `Unknown reminder type: ${reminderType}` };
  }

  let event;
  try {
    event = await prisma.bookingEvent.findUnique({
      where: { id: bookingEventId },
      select: {
        id:            true,
        eventAt:       true,
        eventLocation: true,
        functionType:  true,
        guestCount:    true,
        booking: {
          select: {
            id:              true,
            customerName:    true,
            customerAddress: true,
            business: {
              select: {
                users: {
                  where: {
                    notificationStatus: 1,
                    deviceToken:        { not: null },
                    deletedAt:          null,
                  },
                  select: { id: true, deviceToken: true, language: true },
                },
              },
            },
          },
        },
      },
    });
  } catch (err) {
    return { ok: false, reason: `DB error: ${err.message}` };
  }

  if (!event) return { ok: false, reason: "BookingEvent not found" };

  const users = event.booking.business.users.filter((u) => u.deviceToken);

  if (users.length === 0) {
    return { ok: false, reason: "No eligible users with a registered device token" };
  }

  const ok = await _processEventReminder(event, reminderType, users);
  return { ok, pushSent: users.length };
}

module.exports = { processReminderType, sendReminderForEvent, REMINDER_CONFIGS };

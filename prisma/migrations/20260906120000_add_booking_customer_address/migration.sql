-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "customerAddress" TEXT;

-- Backfill: the legacy booking-level `eventLocation` was surfaced in the app's
-- "customer info" step, so carry it over as the customer address. Per-event
-- `BookingEvent.eventLocation` rows are left untouched (they stay explicit).
UPDATE "Booking"
SET "customerAddress" = "eventLocation"
WHERE "customerAddress" IS NULL
  AND "eventLocation" IS NOT NULL
  AND btrim("eventLocation") <> '';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "nextRunAt" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT;

-- CreateIndex
--
-- Partial on purpose, written by hand because Prisma's schema language cannot
-- express a WHERE clause: the only query that uses this index also filters
-- `recurrenceRule IS NOT NULL`, and templates are a tiny minority of Post rows.
-- A full index would carry an entry with nextRunAt = NULL for every campaign
-- and every occurrence — an hourly template alone produces ~8760 a year.
-- The name is the one Prisma derives from the @@index in schema.prisma, on
-- purpose: that is what makes the diff clean. Verified on the pinned Prisma
-- 7.10.0, by replaying every migration into a fresh database and diffing it
-- against the schema — the index comes out partial and `migrate diff` reports
-- "No difference detected", so `migrate dev` will not try to re-create it.
-- Re-check after a Prisma upgrade; if a future describer starts reporting the
-- predicate, this comment is where to look.
CREATE INDEX "Post_templatePaused_nextRunAt_idx" ON "Post"("templatePaused", "nextRunAt") WHERE "recurrenceRule" IS NOT NULL;

-- Deliberately NO backfill of "nextRunAt".
--
-- Arming pre-existing templates with now() looked like the safe option, but it
-- means every one of them fires within ~60s of deploy — at deploy time, not at
-- its own window. That is exactly the harm the "never replay missed windows"
-- rule in recurrence.ts exists to prevent, and it cannot be undone while VK's
-- wall.delete is unavailable. A template left with a NULL nextRunAt simply does
-- not fire; it is armed by the first edit or resume, which computes the real
-- next occurrence. Nothing in src/ writes recurrenceRule without nextRunAt, so
-- this only concerns hand-inserted rows.

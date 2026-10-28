-- AlterTable
--
-- Added in two steps on purpose. A bare `ADD COLUMN ... NOT NULL` without a
-- default fails outright on a table that already has rows ("column contains
-- null values"), leaving a half-applied migration that blocks every later
-- deploy. PostDelivery predates this migration, so any environment with
-- delivery history would hit exactly that. The default backfills existing
-- rows; dropping it afterwards keeps the column matching the Prisma schema,
-- where `@updatedAt` is maintained by the client rather than by the database.
ALTER TABLE "PostDelivery" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PostDelivery" ALTER COLUMN "updatedAt" DROP DEFAULT;

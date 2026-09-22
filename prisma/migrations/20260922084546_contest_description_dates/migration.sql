-- AlterTable
ALTER TABLE "Contest" ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "startsAt" TIMESTAMP(3);

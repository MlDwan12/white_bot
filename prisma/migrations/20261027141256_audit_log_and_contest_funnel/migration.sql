-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('admin', 'system', 'bot');

-- CreateEnum
CREATE TYPE "ContestFunnelStage" AS ENUM ('consented', 'not_subscribed', 'joined', 'already_joined');

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "details" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContestFunnelEvent" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "stage" "ContestFunnelStage" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContestFunnelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_at_idx" ON "AuditLog"("actorId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "ContestFunnelEvent_contestId_platform_externalUserId_stage_key" ON "ContestFunnelEvent"("contestId", "platform", "externalUserId", "stage");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestFunnelEvent" ADD CONSTRAINT "ContestFunnelEvent_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ContestAnonymousStarts" (
    "contestId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ContestAnonymousStarts_pkey" PRIMARY KEY ("contestId")
);

-- AddForeignKey
ALTER TABLE "ContestAnonymousStarts" ADD CONSTRAINT "ContestAnonymousStarts_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "ContestStatus" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "passwordChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Contest" ADD COLUMN     "endWarningSentAt" TIMESTAMP(3);

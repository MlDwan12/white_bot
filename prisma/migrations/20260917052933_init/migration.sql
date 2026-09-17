-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('vk', 'max');

-- CreateEnum
CREATE TYPE "GroupKind" AS ENUM ('community', 'chat', 'channel');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('pending_confirmation', 'active', 'token_invalid', 'bot_removed', 'removed');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'partially_failed', 'stopped');

-- CreateEnum
CREATE TYPE "PostDeliveryStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'skipped_by_stop', 'unknown');

-- CreateEnum
CREATE TYPE "ContestStatus" AS ENUM ('draft', 'open', 'drawn');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('developer', 'admin');

-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('groups_manage', 'groups_tags_edit', 'groups_tokens_manage', 'groups_pendingMax_review', 'groups_view', 'posts_manage', 'contests_manage', 'admins_manage', 'system_health', 'audit_viewAll');

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "kind" "GroupKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "GroupStatus" NOT NULL DEFAULT 'pending_confirmation',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "vkTextOverride" TEXT,
    "maxTextOverride" TEXT,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledAt" TIMESTAMP(3),
    "recurrenceRule" TEXT,
    "templatePaused" BOOLEAN NOT NULL DEFAULT false,
    "autoDeleteAt" TIMESTAMP(3),
    "autoDeleteAfterMinutes" INTEGER,
    "status" "PostStatus" NOT NULL DEFAULT 'draft',
    "stopRequested" BOOLEAN NOT NULL DEFAULT false,
    "clonedFromPostId" TEXT,
    "recurringTemplateId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostDelivery" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "status" "PostDeliveryStatus" NOT NULL DEFAULT 'pending',
    "externalMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PostDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contest" (
    "id" TEXT NOT NULL,
    "postId" TEXT,
    "title" TEXT NOT NULL,
    "status" "ContestStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContestParticipant" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "vkId" TEXT,
    "maxId" TEXT,

    CONSTRAINT "ContestParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContestPrize" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "place" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "winnerParticipantId" TEXT,
    "isForced" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContestPrize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContestDrawLog" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "drawnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultSnapshot" JSONB NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,

    CONSTRAINT "ContestDrawLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "maxUserId" TEXT,
    "extraPermissions" "Permission"[] DEFAULT ARRAY[]::"Permission"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Group_platform_externalId_key" ON "Group"("platform", "externalId");

-- CreateIndex
CREATE INDEX "Post_clonedFromPostId_idx" ON "Post"("clonedFromPostId");

-- CreateIndex
CREATE INDEX "Post_recurringTemplateId_idx" ON "Post"("recurringTemplateId");

-- CreateIndex
CREATE INDEX "PostDelivery_groupId_idx" ON "PostDelivery"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "PostDelivery_postId_groupId_key" ON "PostDelivery"("postId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Contest_postId_key" ON "Contest"("postId");

-- CreateIndex
CREATE INDEX "ContestParticipant_contestId_idx" ON "ContestParticipant"("contestId");

-- CreateIndex
CREATE UNIQUE INDEX "ContestPrize_contestId_place_key" ON "ContestPrize"("contestId", "place");

-- CreateIndex
CREATE UNIQUE INDEX "ContestPrize_winnerParticipantId_key" ON "ContestPrize"("winnerParticipantId");

-- CreateIndex
CREATE INDEX "ContestDrawLog_contestId_idx" ON "ContestDrawLog"("contestId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_maxUserId_key" ON "AdminUser"("maxUserId");

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_idx" ON "AdminSession"("adminUserId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_clonedFromPostId_fkey" FOREIGN KEY ("clonedFromPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_recurringTemplateId_fkey" FOREIGN KEY ("recurringTemplateId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostDelivery" ADD CONSTRAINT "PostDelivery_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostDelivery" ADD CONSTRAINT "PostDelivery_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contest" ADD CONSTRAINT "Contest_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestParticipant" ADD CONSTRAINT "ContestParticipant_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestPrize" ADD CONSTRAINT "ContestPrize_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestPrize" ADD CONSTRAINT "ContestPrize_winnerParticipantId_fkey" FOREIGN KEY ("winnerParticipantId") REFERENCES "ContestParticipant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestDrawLog" ADD CONSTRAINT "ContestDrawLog_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

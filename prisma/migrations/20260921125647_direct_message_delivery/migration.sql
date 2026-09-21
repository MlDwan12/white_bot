-- CreateEnum
CREATE TYPE "DirectMessageStatus" AS ENUM ('pending', 'sending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "DirectMessageDelivery" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "status" "DirectMessageStatus" NOT NULL DEFAULT 'pending',
    "externalMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DirectMessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DirectMessageDelivery_platformUserId_idx" ON "DirectMessageDelivery"("platformUserId");

-- CreateIndex
CREATE INDEX "DirectMessageDelivery_status_updatedAt_idx" ON "DirectMessageDelivery"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DirectMessageDelivery_postId_platformUserId_key" ON "DirectMessageDelivery"("postId", "platformUserId");

-- AddForeignKey
ALTER TABLE "DirectMessageDelivery" ADD CONSTRAINT "DirectMessageDelivery_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectMessageDelivery" ADD CONSTRAINT "DirectMessageDelivery_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "PlatformUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

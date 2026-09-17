-- AlterTable
ALTER TABLE "Group" ALTER COLUMN "status" DROP DEFAULT;

-- CreateTable
CREATE TABLE "PostTemplateTarget" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "PostTemplateTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostTemplateTarget_groupId_idx" ON "PostTemplateTarget"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "PostTemplateTarget_postId_groupId_key" ON "PostTemplateTarget"("postId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_refreshTokenHash_key" ON "AdminSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "ContestDrawLog_actorId_idx" ON "ContestDrawLog"("actorId");

-- CreateIndex
CREATE INDEX "Group_tags_idx" ON "Group" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "Post_status_scheduledAt_idx" ON "Post"("status", "scheduledAt");

-- AddForeignKey
ALTER TABLE "PostTemplateTarget" ADD CONSTRAINT "PostTemplateTarget_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostTemplateTarget" ADD CONSTRAINT "PostTemplateTarget_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestDrawLog" ADD CONSTRAINT "ContestDrawLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


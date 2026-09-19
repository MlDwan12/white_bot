-- Удаление опубликованного: отметка об удалении и срок автоудаления
-- на каждой доставке.

-- AlterTable
ALTER TABLE "PostDelivery" ADD COLUMN     "autoDeleteDueAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PostDelivery_autoDeleteDueAt_idx" ON "PostDelivery"("autoDeleteDueAt");


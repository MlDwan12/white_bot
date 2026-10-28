-- Контест-участие: участники приходят нажатием кнопки под анонс-постом,
-- а не вставкой списком. vkId/maxId заменены на platform + externalUserId;
-- таблица пустая (функциональность ещё не выпускалась), поэтому NOT NULL
-- без бэкофилла здесь безопасен.

-- CreateEnum
CREATE TYPE "ContestParticipantSource" AS ENUM ('button', 'manual');

-- CreateEnum
CREATE TYPE "ContestNotifyStatus" AS ENUM ('pending', 'sent', 'failed', 'manual_required', 'notified_manually');

-- CreateEnum
CREATE TYPE "ContestDrawLogKind" AS ENUM ('draw', 'override');

-- AlterTable
ALTER TABLE "Contest" ADD COLUMN     "joinButtonLabel" TEXT NOT NULL DEFAULT 'Участвовать',
ADD COLUMN     "notifyWinners" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resultsButtonLabel" TEXT NOT NULL DEFAULT 'Узнать результаты';

-- AlterTable
ALTER TABLE "ContestDrawLog" ADD COLUMN     "kind" "ContestDrawLogKind" NOT NULL DEFAULT 'draw',
ADD COLUMN     "seed" TEXT;

-- AlterTable
ALTER TABLE "ContestParticipant" DROP COLUMN "maxId",
DROP COLUMN "vkId",
ADD COLUMN     "dedupKey" TEXT NOT NULL,
ADD COLUMN     "externalUserId" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "platform" "Platform" NOT NULL,
ADD COLUMN     "source" "ContestParticipantSource" NOT NULL DEFAULT 'button';

-- AlterTable
ALTER TABLE "ContestPrize" ADD COLUMN     "notifyAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "notifyError" TEXT,
ADD COLUMN     "notifyStatus" "ContestNotifyStatus" NOT NULL DEFAULT 'pending';

-- CreateIndex
CREATE INDEX "ContestParticipant_groupId_idx" ON "ContestParticipant"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ContestParticipant_contestId_dedupKey_key" ON "ContestParticipant"("contestId", "dedupKey");

-- AddForeignKey
ALTER TABLE "ContestParticipant" ADD CONSTRAINT "ContestParticipant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;


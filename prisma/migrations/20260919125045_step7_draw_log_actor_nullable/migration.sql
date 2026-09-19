-- До Шага 9 (аутентификация) у запроса нет опознанного админа, а запись в
-- журнал розыгрыша нужна всё равно: null честнее выдуманного actorId.

-- DropForeignKey
ALTER TABLE "ContestDrawLog" DROP CONSTRAINT "ContestDrawLog_actorId_fkey";
-- AlterTable
ALTER TABLE "ContestDrawLog" ALTER COLUMN "actorId" DROP NOT NULL;
-- AddForeignKey
ALTER TABLE "ContestDrawLog" ADD CONSTRAINT "ContestDrawLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

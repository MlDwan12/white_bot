-- Счётчик неудачных автоудалений: без него строка, которую удалить
-- нельзя в принципе, навсегда занимает место в окне выборки и
-- вытесняет те, что удалить можно.

-- AlterTable
ALTER TABLE "PostDelivery" ADD COLUMN     "autoDeleteAttempts" INTEGER NOT NULL DEFAULT 0;


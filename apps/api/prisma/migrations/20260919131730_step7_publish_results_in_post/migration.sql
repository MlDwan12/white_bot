-- Публикация победителей в тексте анонса: единственный канал, видимый
-- всем подписчикам, пока нет мини-аппа.

-- AlterTable
ALTER TABLE "Contest" ADD COLUMN     "publishResultsInPost" BOOLEAN NOT NULL DEFAULT true;


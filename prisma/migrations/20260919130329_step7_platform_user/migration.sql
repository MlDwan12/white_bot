-- Профиль участника отдельной таблицей: заводится при первом участии и
-- переживает конкурс, к которому человек записался.

-- AlterTable
ALTER TABLE "ContestParticipant" ADD COLUMN     "platformUserId" TEXT;

-- CreateTable
CREATE TABLE "PlatformUser" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "profile" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformUser_platform_externalUserId_key" ON "PlatformUser"("platform", "externalUserId");

-- CreateIndex
CREATE INDEX "ContestParticipant_platformUserId_idx" ON "ContestParticipant"("platformUserId");

-- AddForeignKey
ALTER TABLE "ContestParticipant" ADD CONSTRAINT "ContestParticipant_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "PlatformUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;


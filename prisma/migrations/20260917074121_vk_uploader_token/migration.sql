-- CreateTable
CREATE TABLE "VkUploaderToken" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "accessTokenEncrypted" TEXT NOT NULL,
    "vkUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VkUploaderToken_pkey" PRIMARY KEY ("id")
);


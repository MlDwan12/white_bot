/*
  Warnings:

  - You are about to drop the column `attachments` on the `Post` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('image', 'document');

-- AlterTable
ALTER TABLE "Post" DROP COLUMN "attachments";

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "optimizedPath" TEXT,
    "optimizedSizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostAttachment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "PostAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaPlatformUpload" (
    "id" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "scope" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaPlatformUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storagePath_key" ON "MediaAsset"("storagePath");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_optimizedPath_key" ON "MediaAsset"("optimizedPath");

-- CreateIndex
CREATE INDEX "MediaAsset_checksum_idx" ON "MediaAsset"("checksum");

-- CreateIndex
CREATE INDEX "PostAttachment_mediaAssetId_idx" ON "PostAttachment"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "PostAttachment_postId_position_key" ON "PostAttachment"("postId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "PostAttachment_postId_mediaAssetId_key" ON "PostAttachment"("postId", "mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaPlatformUpload_mediaAssetId_platform_scope_key" ON "MediaPlatformUpload"("mediaAssetId", "platform", "scope");

-- AddForeignKey
ALTER TABLE "PostAttachment" ADD CONSTRAINT "PostAttachment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostAttachment" ADD CONSTRAINT "PostAttachment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaPlatformUpload" ADD CONSTRAINT "MediaPlatformUpload_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

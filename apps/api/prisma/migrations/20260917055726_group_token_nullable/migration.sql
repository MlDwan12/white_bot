-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "tokenMask" TEXT,
ALTER COLUMN "accessTokenEncrypted" DROP NOT NULL;


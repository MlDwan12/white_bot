-- CreateTable
CREATE TABLE "ContestRequiredGroup" (
    "contestId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "ContestRequiredGroup_pkey" PRIMARY KEY ("contestId","groupId")
);

-- CreateIndex
CREATE INDEX "ContestRequiredGroup_groupId_idx" ON "ContestRequiredGroup"("groupId");

-- AddForeignKey
ALTER TABLE "ContestRequiredGroup" ADD CONSTRAINT "ContestRequiredGroup_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestRequiredGroup" ADD CONSTRAINT "ContestRequiredGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

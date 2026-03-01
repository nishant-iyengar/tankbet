-- AlterTable
ALTER TABLE "User" ADD COLUMN "phoneNumber" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

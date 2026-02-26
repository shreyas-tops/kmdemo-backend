/*
  Warnings:

  - Added the required column `businessName` to the `LicenseCode` table without a default value. This is not possible if the table is not empty.
  - Added the required column `prefix` to the `LicenseCode` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sequence` to the `LicenseCode` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "LicenseCode" ADD COLUMN     "businessName" TEXT NOT NULL,
ADD COLUMN     "prefix" TEXT NOT NULL,
ADD COLUMN     "sequence" INTEGER NOT NULL;

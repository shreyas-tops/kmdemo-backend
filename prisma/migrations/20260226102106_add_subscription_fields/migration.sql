/*
  Warnings:

  - Added the required column `purchasePlan` to the `LicenseCode` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subscriptionEnd` to the `LicenseCode` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subscriptionStart` to the `LicenseCode` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "LicenseCode" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "purchasePlan" INTEGER NOT NULL,
ADD COLUMN     "subscriptionEnd" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "subscriptionStart" TIMESTAMP(3) NOT NULL;

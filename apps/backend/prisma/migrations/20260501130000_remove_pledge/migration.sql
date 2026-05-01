-- Remove Pledge.to integration

-- Drop foreign key from Contribution to Disbursement
ALTER TABLE "Contribution" DROP CONSTRAINT IF EXISTS "Contribution_disbursementId_fkey";

-- Drop disbursementId column from Contribution
ALTER TABLE "Contribution" DROP COLUMN IF EXISTS "disbursementId";

-- Drop Disbursement table (and its unique index on pledgeDonationId)
DROP TABLE IF EXISTS "Disbursement";

-- Drop DisbursementStatus enum
DROP TYPE IF EXISTS "DisbursementStatus";

-- Drop pledgeSlug column from Charity
ALTER TABLE "Charity" DROP COLUMN IF EXISTS "pledgeSlug";

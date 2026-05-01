-- DropTable (before AlterTable User, due to FK constraints)
DROP TABLE "Withdrawal";

-- DropTable
DROP TABLE "Deposit";

-- AlterTable: remove Stripe fields from User
ALTER TABLE "User" DROP COLUMN "stripeCustomerId",
DROP COLUMN "stripePaymentMethodId";

-- DropEnum
DROP TYPE "DepositStatus";

-- DropEnum
DROP TYPE "WithdrawalStatus";

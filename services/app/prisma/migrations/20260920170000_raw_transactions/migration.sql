-- CreateTable
CREATE TABLE "raw_transactions" (
    "id" UUID NOT NULL,
    "uid" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "type_code" CHAR(2) NOT NULL,
    "type_name" TEXT NOT NULL,
    "nature_code" CHAR(1) NOT NULL,
    "product_code" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "booked_on" DATE NOT NULL,
    "counterpart_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reject_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "raw_transactions_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "raw_transactions_status_check" CHECK ("status" IN ('COMPLETED', 'REJECTED'))
);

CREATE UNIQUE INDEX "raw_transactions_uid_key" ON "raw_transactions"("uid");
CREATE INDEX "raw_transactions_account_number_booked_on_idx" ON "raw_transactions"("account_number", "booked_on");
CREATE INDEX "raw_transactions_created_at_idx" ON "raw_transactions"("created_at");

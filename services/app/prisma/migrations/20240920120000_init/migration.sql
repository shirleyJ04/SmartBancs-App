-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "holder_name" TEXT NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounts_balance_non_negative" CHECK ("balance" >= 0)
);

CREATE UNIQUE INDEX "accounts_account_number_key" ON "accounts"("account_number");

CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "from_account_id" UUID NOT NULL,
    "to_account_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transfers_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "transfers_distinct_accounts" CHECK ("from_account_id" <> "to_account_id")
);

CREATE UNIQUE INDEX "transfers_idempotency_key_key" ON "transfers"("idempotency_key");

CREATE TABLE "transfer_failures" (
    "id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "idempotency_key" TEXT,
    "from_account" TEXT,
    "to_account" TEXT,
    "amount" TEXT,
    "currency" TEXT,
    "reason_code" TEXT NOT NULL,
    "reason_message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_failures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "claim_expires_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "transfer_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "outbox_events"("status", "next_attempt_at");

CREATE TABLE "recommendations" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendations_outbox_event_id_key" ON "recommendations"("outbox_event_id");

ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

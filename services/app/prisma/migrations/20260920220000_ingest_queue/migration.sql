-- Durable ingest queue: API enqueues, worker drains with FOR UPDATE SKIP LOCKED.
CREATE TABLE "ingest_queue" (
    "id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "claim_expires_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ingest_queue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ingest_queue_status_next_attempt_at_idx" ON "ingest_queue"("status", "next_attempt_at");

-- CreateTable
CREATE TABLE "infra_exceptions" (
    "id" UUID NOT NULL,
    "correlation_id" UUID,
    "component" TEXT NOT NULL,
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "operation" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infra_exceptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "infra_exceptions_error_code_created_at_idx" ON "infra_exceptions"("error_code", "created_at");
CREATE INDEX "infra_exceptions_component_created_at_idx" ON "infra_exceptions"("component", "created_at");

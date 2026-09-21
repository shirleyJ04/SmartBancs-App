CREATE TABLE IF NOT EXISTS ai_transactions (
    uid TEXT PRIMARY KEY,
    account_number TEXT NOT NULL,
    type_code CHAR(2) NOT NULL,
    nature_code CHAR(1) NOT NULL,
    product_code CHAR(3) NOT NULL,
    type_label TEXT NOT NULL,
    status TEXT NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    currency CHAR(3) NOT NULL,
    booked_on DATE NOT NULL,
    month TEXT NOT NULL,
    counterpart_name TEXT NOT NULL,
    category TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_transactions_account_idx ON ai_transactions (account_number);
CREATE INDEX IF NOT EXISTS ai_transactions_tipo_idx ON ai_transactions (type_code, nature_code, product_code);

CREATE TABLE IF NOT EXISTS ai_prompt_contexts (
    account_number TEXT PRIMARY KEY,
    as_of_month TEXT NOT NULL,
    compare_month TEXT NOT NULL,
    current_total NUMERIC(18, 2) NOT NULL,
    previous_total NUMERIC(18, 2) NOT NULL,
    total_ratio NUMERIC(10, 2),
    rejected_cards INTEGER NOT NULL,
    counterparts JSONB NOT NULL,
    categories JSONB NOT NULL,
    prompt TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_advices (
    id UUID PRIMARY KEY,
    account_number TEXT NOT NULL,
    correlation_id TEXT,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    prompt_used TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'rules',
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_advices ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'rules';
ALTER TABLE ai_advices ADD COLUMN IF NOT EXISTS model TEXT;

CREATE INDEX IF NOT EXISTS ai_advices_account_idx ON ai_advices (account_number, created_at DESC);

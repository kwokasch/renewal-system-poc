-- Domain state: the local view of registry truth
CREATE TABLE IF NOT EXISTS domains (
  domain_name    TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',   -- active | expired | redemption | pending_delete
  expires_at     INTEGER NOT NULL,                 -- unix ms
  auto_renew     INTEGER NOT NULL DEFAULT 1,       -- boolean
  renewal_price  REAL NOT NULL DEFAULT 12.99,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Accounts: billing info (simplified for POC)
CREATE TABLE IF NOT EXISTS accounts (
  account_id     TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  balance        REAL NOT NULL DEFAULT 100.00,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Renewal history: audit trail of every attempt and outcome
CREATE TABLE IF NOT EXISTS renewal_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_name    TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  action         TEXT NOT NULL,        -- auto_renew | manual_renew | reconciliation
  trigger_source TEXT NOT NULL,        -- do_alarm | cron_sweep | api_request
  status         TEXT NOT NULL,        -- queued | processing | success | failed | payment_failed
  idempotency_key TEXT UNIQUE,         -- prevents duplicate renewals
  amount_charged REAL,
  registry_response TEXT,              -- store EPP response for audit
  error_message  TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at   INTEGER,
  FOREIGN KEY (domain_name) REFERENCES domains(domain_name)
);

-- Dead-letter table: permanently failed renewals needing manual investigation
CREATE TABLE IF NOT EXISTS dead_letter_renewals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_name      TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  error_message    TEXT,
  payment_refunded INTEGER NOT NULL DEFAULT 0,  -- boolean: was the charge reversed?
  requires_action  INTEGER NOT NULL DEFAULT 1,  -- boolean: needs human investigation?
  resolved_at      INTEGER,                     -- when someone handled it
  resolved_by      TEXT,                        -- who resolved it
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (domain_name) REFERENCES domains(domain_name)
);

-- Index for the cron reconciliation sweep
CREATE INDEX IF NOT EXISTS idx_domains_expires_at ON domains(expires_at);
CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status);
CREATE INDEX IF NOT EXISTS idx_renewal_history_domain ON renewal_history(domain_name);
CREATE INDEX IF NOT EXISTS idx_renewal_history_idempotency ON renewal_history(idempotency_key);

-- Seed data: test accounts and domains at various lifecycle stages

INSERT OR IGNORE INTO accounts (account_id, email, balance) VALUES
  ('acct_001', 'alice@example.com', 250.00),
  ('acct_002', 'bob@example.com', 50.00),
  ('acct_003', 'carol@example.com', 5.00);  -- low balance: will trigger payment failure

-- Domains expiring at various times (unix ms)
-- Using offsets from a base time to make testing predictable

-- Expires in 5 days — should be caught by DO alarm (set 7 days before expiry)
INSERT OR IGNORE INTO domains (domain_name, account_id, status, expires_at, auto_renew, renewal_price) VALUES
  ('example.com', 'acct_001', 'active', (unixepoch() + 5 * 86400) * 1000, 1, 12.99);

-- Expires in 2 days — urgent, DO alarm already passed, cron should catch this
INSERT OR IGNORE INTO domains (domain_name, account_id, status, expires_at, auto_renew, renewal_price) VALUES
  ('urgent-renew.io', 'acct_001', 'active', (unixepoch() + 2 * 86400) * 1000, 1, 15.99);

-- Expires in 30 days — not yet due, DO alarm is set but hasn't fired
INSERT OR IGNORE INTO domains (domain_name, account_id, status, expires_at, auto_renew, renewal_price) VALUES
  ('plenty-of-time.dev', 'acct_002', 'active', (unixepoch() + 30 * 86400) * 1000, 1, 10.99);

-- Auto-renew OFF — should be skipped by renewal system, only manual
INSERT OR IGNORE INTO domains (domain_name, account_id, status, expires_at, auto_renew, renewal_price) VALUES
  ('manual-only.com', 'acct_002', 'active', (unixepoch() + 3 * 86400) * 1000, 0, 12.99);

-- Low-balance account — will fail payment step
INSERT OR IGNORE INTO domains (domain_name, account_id, status, expires_at, auto_renew, renewal_price) VALUES
  ('cant-afford.net', 'acct_003', 'active', (unixepoch() + 4 * 86400) * 1000, 1, 12.99);

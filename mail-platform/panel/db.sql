CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS managed_domains (
  id BIGSERIAL PRIMARY KEY,
  domain_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  alias_limit INTEGER NOT NULL DEFAULT 400,
  mailbox_limit INTEGER NOT NULL DEFAULT 50,
  default_quota_mb INTEGER NOT NULL DEFAULT 3072,
  max_quota_mb INTEGER NOT NULL DEFAULT 10240,
  total_quota_mb INTEGER NOT NULL DEFAULT 51200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id BIGSERIAL PRIMARY KEY,
  event_hash TEXT NOT NULL UNIQUE,
  user_email TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  action TEXT NOT NULL,
  qid TEXT NULL,
  message_id TEXT NULL,
  source TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  raw_event JSONB NOT NULL,
  warned_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mailbox_state (
  email TEXT PRIMARY KEY,
  domain_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  warn_count INTEGER NOT NULL DEFAULT 0,
  last_warn_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_user_time ON rate_limit_events(user_email, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_state_status ON mailbox_state(status);

CREATE TABLE IF NOT EXISTS mail_domains (
  domain_name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  dkim_selector TEXT NOT NULL DEFAULT 'mail',
  dkim_public_key TEXT NOT NULL DEFAULT '',
  dkim_private_key_path TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS mail_users (
  email TEXT PRIMARY KEY,
  domain_name TEXT NOT NULL REFERENCES mail_domains(domain_name) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  quota_mb INTEGER NOT NULL DEFAULT 3072,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS mail_aliases (
  source TEXT PRIMARY KEY,
  destination TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_domains_active ON mail_domains(active);
CREATE INDEX IF NOT EXISTS idx_mail_users_domain ON mail_users(domain_name);
CREATE INDEX IF NOT EXISTS idx_mail_users_active ON mail_users(active);

CREATE TABLE IF NOT EXISTS smtp_relay_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  relay_host TEXT NOT NULL DEFAULT '',
  relay_port INTEGER NOT NULL DEFAULT 587,
  relay_user TEXT NOT NULL DEFAULT '',
  relay_pass_enc TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

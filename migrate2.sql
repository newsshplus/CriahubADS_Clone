-- Migração: Novas tabelas para funcionalidades avançadas

-- Log de atividade
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  contact_id TEXT REFERENCES contacts(id),
  campaign_id TEXT REFERENCES campaigns(id),
  event_type TEXT NOT NULL,
  event_detail TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Email gate
CREATE TABLE IF NOT EXISTS collected_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  email TEXT NOT NULL,
  campaign_id TEXT REFERENCES campaigns(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Follow-up automatico
CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  message TEXT NOT NULL,
  send_after_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Variações de resposta
CREATE TABLE IF NOT EXISTS reply_variations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  variation_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_activity_log_account ON activity_log(ig_account_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_collected_emails_account ON collected_emails(ig_account_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_reply_variations_campaign ON reply_variations(campaign_id);

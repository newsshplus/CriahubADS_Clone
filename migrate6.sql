-- ============================================================
-- migrate6.sql — SMTP config, Contact form submissions
-- ============================================================

-- SMTP Configuration (admin settings)
CREATE TABLE IF NOT EXISTS smtp_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  smtp_host TEXT DEFAULT '',
  smtp_port INTEGER DEFAULT 587,
  smtp_user TEXT DEFAULT '',
  smtp_pass TEXT DEFAULT '',
  smtp_from_email TEXT DEFAULT '',
  smtp_from_name TEXT DEFAULT 'CriaHub',
  smtp_use_tls INTEGER DEFAULT 1,
  recipient_email TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Insert default row
INSERT OR IGNORE INTO smtp_config (id) VALUES (1);

-- Contact form submissions
CREATE TABLE IF NOT EXISTS contact_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT DEFAULT '',
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'new',
  admin_notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_status ON contact_submissions(status);

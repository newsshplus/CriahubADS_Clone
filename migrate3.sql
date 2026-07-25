-- ============================================================
-- CriaHub SaaS — Migration: subscriptions, plans, users
-- ============================================================

-- Utilizadores SaaS (contas de acesso ao painel)
CREATE TABLE IF NOT EXISTS saas_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- active / banned / deleted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Planos disponíveis
CREATE TABLE IF NOT EXISTS saas_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price_eur_monthly REAL NOT NULL DEFAULT 0,
  max_accounts INTEGER NOT NULL DEFAULT 1,
  max_dms_month INTEGER NOT NULL DEFAULT 500,
  max_campaigns INTEGER NOT NULL DEFAULT 3,
  features TEXT NOT NULL DEFAULT '[]', -- JSON array of feature names
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Subscrições dos utilizadores
CREATE TABLE IF NOT EXISTS saas_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES saas_users(id),
  plan_id TEXT NOT NULL REFERENCES saas_plans(id),
  status TEXT NOT NULL DEFAULT 'active', -- active / cancelled / expired / past_due
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id) -- um plano por utilizador
);

-- Pagamentos registados
CREATE TABLE IF NOT EXISTS saas_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES saas_users(id),
  subscription_id TEXT REFERENCES saas_subscriptions(id),
  amount_eur REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'manual', -- manual / stripe / mbway / transfer
  status TEXT NOT NULL DEFAULT 'completed', -- completed / pending / failed / refunded
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_saas_users_email ON saas_users(email);
CREATE INDEX IF NOT EXISTS idx_saas_subscriptions_user ON saas_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_saas_subscriptions_status ON saas_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_saas_payments_user ON saas_payments(user_id);

-- Inserir planos padrão
INSERT OR IGNORE INTO saas_plans (id, name, price_eur_monthly, max_accounts, max_dms_month, max_campaigns, features, sort_order) VALUES
('plan_starter', 'Starter', 9.90, 1, 500, 3, '["ia_basica","dashboard","suporte_email"]', 1),
('plan_pro', 'Pro', 19.90, 2, 5000, -1, '["ia_avancada","dashboard","analytics","email_gate","follow_gate","export_csv","suporte_prioritario"]', 2),
('plan_business', 'Business', 39.90, 5, 20000, -1, '["ia_avancada","dashboard","analytics","email_gate","follow_gate","export_csv","bulk_create","activity_log","api_access","suporte_dedicado"]', 3);

-- Subscrição padrão para o admin (acesso ilimitado)
INSERT OR IGNORE INTO saas_users (id, email, password_hash, name, status) VALUES
('usr_admin', 'admin@criahub.pt', '$ADMIN_HASH', 'Administrador', 'active');

-- Subscrição admin ilimitada
INSERT OR IGNORE INTO saas_subscriptions (id, user_id, plan_id, status, started_at, expires_at) VALUES
('sub_admin', 'usr_admin', 'plan_business', 'active', datetime('now'), datetime('now', '+100 years'));

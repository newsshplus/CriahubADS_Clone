ALTER TABLE saas_users ADD COLUMN plan_id TEXT REFERENCES saas_plans(id);
ALTER TABLE saas_users ADD COLUMN role TEXT NOT NULL DEFAULT 'client';
UPDATE saas_users SET role = 'admin' WHERE email = 'admin@criahub.pt';
CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_subscriptions_user ON saas_subscriptions(user_id);

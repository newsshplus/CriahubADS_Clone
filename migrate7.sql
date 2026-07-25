-- Add plan limit columns
ALTER TABLE saas_plans ADD COLUMN max_contacts INTEGER NOT NULL DEFAULT 200;
ALTER TABLE saas_plans ADD COLUMN max_users INTEGER NOT NULL DEFAULT 1;

-- Update plan limits
UPDATE saas_plans SET max_contacts = 200, max_users = 1, max_accounts = 1, max_dms_month = 500, max_campaigns = 3 WHERE id = 'plan_free';
UPDATE saas_plans SET max_contacts = 5000, max_users = 2, max_accounts = 2, max_dms_month = 10000, max_campaigns = 25 WHERE id = 'plan_starter';
UPDATE saas_plans SET max_contacts = -1, max_users = 5, max_accounts = 5, max_dms_month = -1, max_campaigns = -1 WHERE id = 'plan_pro';
UPDATE saas_plans SET max_contacts = -1, max_users = 10, max_accounts = 999, max_dms_month = -1, max_campaigns = -1 WHERE id = 'plan_business';

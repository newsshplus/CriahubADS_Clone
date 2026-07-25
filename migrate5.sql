-- ============================================================
-- migrate5.sql — WhatsApp CRM, TikTok, Meta Ads, GA4, Leads
-- ============================================================

-- WhatsApp: Configuração por conta
CREATE TABLE IF NOT EXISTS whatsapp_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  evo_api_url TEXT,
  evo_api_key TEXT,
  instance_name TEXT,
  phone_number TEXT,
  status TEXT DEFAULT 'disconnected',
  webhook_secret TEXT,
  auto_close_minutes INTEGER DEFAULT 60,
  ai_enabled INTEGER DEFAULT 0,
  ai_model TEXT DEFAULT 'llama-3.3-70b-versatile',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_configs_account ON whatsapp_configs(account_id);

-- WhatsApp: Contactos
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  wa_jid TEXT,
  phone TEXT,
  name TEXT,
  profile_pic TEXT,
  tags TEXT DEFAULT '[]',
  custom_fields TEXT DEFAULT '{}',
  source TEXT DEFAULT 'whatsapp',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_account ON whatsapp_contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_jid ON whatsapp_contacts(wa_jid);

-- WhatsApp: Conversas
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  contact_id INTEGER,
  wa_jid TEXT,
  status TEXT DEFAULT 'open',
  assigned_to TEXT,
  stage TEXT DEFAULT 'new',
  last_message TEXT,
  last_message_at TEXT,
  unread_count INTEGER DEFAULT 0,
  labels TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_account ON whatsapp_conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_status ON whatsapp_conversations(status);

-- WhatsApp: Mensagens
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER,
  account_id TEXT NOT NULL,
  wa_jid TEXT,
  from_me INTEGER DEFAULT 0,
  message_type TEXT DEFAULT 'text',
  content TEXT,
  media_url TEXT,
  caption TEXT,
  message_id TEXT,
  status TEXT DEFAULT 'delivered',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_msg_conv ON whatsapp_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_msg_account ON whatsapp_messages(account_id);

-- TikTok: Configuração
CREATE TABLE IF NOT EXISTS tiktok_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TEXT,
  tiktok_username TEXT,
  tiktok_user_id TEXT,
  status TEXT DEFAULT 'disconnected',
  scopes TEXT DEFAULT 'user.info.basic,video.list,comment.read,message.send',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tiktok_configs_account ON tiktok_configs(account_id);

-- TikTok: Automações (comentários → DM)
CREATE TABLE IF NOT EXISTS tiktok_automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  name TEXT NOT NULL,
  video_id TEXT,
  video_url TEXT,
  keyword TEXT,
  response_template TEXT,
  ai_enabled INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  dm_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tiktok_auto_account ON tiktok_automations(account_id);

-- Meta Ads: Configuração
CREATE TABLE IF NOT EXISTS meta_ads_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  ad_account_id TEXT,
  access_token TEXT,
  business_id TEXT,
  status TEXT DEFAULT 'disconnected',
  last_sync TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_config_account ON meta_ads_configs(account_id);

-- Meta Ads: Insights de campanhas
CREATE TABLE IF NOT EXISTS campaign_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  platform TEXT DEFAULT 'meta',
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  ad_id TEXT,
  ad_name TEXT,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend REAL DEFAULT 0,
  reach INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc REAL DEFAULT 0,
  cpm REAL DEFAULT 0,
  roas REAL DEFAULT 0,
  leads_count INTEGER DEFAULT 0,
  messages_count INTEGER DEFAULT 0,
  date_start TEXT,
  date_stop TEXT,
  fetched_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_insights_account ON campaign_insights(account_id);
CREATE INDEX IF NOT EXISTS idx_campaign_insights_platform ON campaign_insights(platform);
CREATE INDEX IF NOT EXISTS idx_campaign_insights_date ON campaign_insights(date_start);

-- Meta Ads: Lead Forms
CREATE TABLE IF NOT EXISTS meta_lead_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  page_id TEXT,
  page_name TEXT,
  form_id TEXT,
  form_name TEXT,
  status TEXT DEFAULT 'active',
  leads_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meta_lead_forms_account ON meta_lead_forms(account_id);

-- GA4: Configuração
CREATE TABLE IF NOT EXISTS ga4_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  property_id TEXT,
  property_name TEXT,
  service_account_email TEXT,
  private_key TEXT,
  status TEXT DEFAULT 'disconnected',
  last_sync TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ga4_config_account ON ga4_configs(account_id);

-- GA4: Dados de analytics
CREATE TABLE IF NOT EXISTS ga4_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  property_id TEXT,
  metric_name TEXT,
  metric_value REAL,
  dimension TEXT,
  dimension_value TEXT,
  date TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ga4_data_account ON ga4_data(account_id);
CREATE INDEX IF NOT EXISTS idx_ga4_data_date ON ga4_data(date);

-- Leads: Centralização (multi-plataforma)
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  user_id TEXT,
  source TEXT NOT NULL,
  source_id TEXT,
  name TEXT,
  email TEXT,
  phone TEXT,
  platform TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  form_name TEXT,
  tags TEXT DEFAULT '[]',
  status TEXT DEFAULT 'new',
  score INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  custom_fields TEXT DEFAULT '{}',
  contacted_at TEXT,
  converted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

-- Leads: Atividades de follow-up
CREATE TABLE IF NOT EXISTS lead_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  performed_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id);

-- Atualizar planos com preços novos
INSERT OR IGNORE INTO saas_plans (id, name, price_eur_monthly, max_accounts, max_dms_month, max_campaigns, features, active, sort_order)
VALUES ('plan_free', 'Free', 0, 1, 500, 3, '["basic_automation","ig_only","community_support","watermark"]', 1, 0);

UPDATE saas_plans SET
  name = 'Starter',
  price_eur_monthly = 9.90,
  max_accounts = 2,
  max_dms_month = 10000,
  max_campaigns = 25,
  features = '["ig_tiktok_wa","25_automations","ai_included","crm_basic","email_support"]'
WHERE id = 'plan_starter';

UPDATE saas_plans SET
  name = 'Pro',
  price_eur_monthly = 24.90,
  max_accounts = 5,
  max_dms_month = -1,
  max_campaigns = -1,
  features = '["ig_tiktok_wa","unlimited_automations","ai_advanced","crm_tags","analytics_advanced","priority_support","5_users"]'
WHERE id = 'plan_pro';

UPDATE saas_plans SET
  name = 'Business',
  price_eur_monthly = 59.90,
  max_accounts = 999,
  max_dms_month = -1,
  max_campaigns = -1,
  features = '["all_channels","unlimited_everything","ai_advanced","full_crm","white_label","api_access","webhooks","dedicated_support","10_users"]'
WHERE id = 'plan_business';

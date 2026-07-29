CREATE TABLE IF NOT EXISTS plan_content (
  plan_id TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'pt',
  description TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '[]',
  button_text TEXT NOT NULL DEFAULT '',
  price_monthly REAL,
  price_label TEXT,
  highlight TEXT DEFAULT '',
  PRIMARY KEY (plan_id, locale)
);

INSERT OR IGNORE INTO plan_content (plan_id, locale, description, features, button_text, price_monthly, price_label, highlight) VALUES
('plan_free', 'pt', 'Para experimentar', '["200 contactos","500 DMs/mês","3 automações","Instagram apenas","1 utilizador"]', 'Começar Grátis', 0, 'Grátis', ''),
('plan_starter', 'pt', 'Para quem está a começar', '["10.000 DMs/mês","Instagram + TikTok + WhatsApp","25 automações","IA incluída","2 utilizadores"]', 'Escolher Starter', 9.90, '9,90€/mês', ''),
('plan_pro', 'pt', 'Para negócios em crescimento', '["DMs ilimitados","IA avançada","5 utilizadores","CRM + Tags","Analytics avançados","Suporte prioritário"]', 'Escolher Pro', 24.90, '24,90€/mês', 'Mais Popular'),
('plan_business', 'pt', 'Para agências e multi-marcas', '["Tudo ilimitado","White label","10 utilizadores","API + Webhooks","Suporte dedicado"]', 'Escolher Business', 59.90, '59,90€/mês', '');

INSERT OR IGNORE INTO plan_content (plan_id, locale, description, features, button_text, price_monthly, price_label, highlight) VALUES
('plan_free', 'en', 'To try it out', '["200 contacts","500 DMs/month","3 automations","Instagram only","1 user"]', 'Start Free', 0, 'Free', ''),
('plan_starter', 'en', 'For those just starting out', '["10,000 DMs/month","Instagram + TikTok + WhatsApp","25 automations","AI included","2 users"]', 'Choose Starter', 9.90, '€9.90/mo', ''),
('plan_pro', 'en', 'For growing businesses', '["Unlimited DMs","Advanced AI","5 users","CRM + Tags","Advanced analytics","Priority support"]', 'Choose Pro', 24.90, '€24.90/mo', 'Most Popular'),
('plan_business', 'en', 'For agencies and multi-brands', '["Everything unlimited","White label","10 users","API + Webhooks","Dedicated support"]', 'Choose Business', 59.90, '€59.90/mo', '');

INSERT OR IGNORE INTO plan_content (plan_id, locale, description, features, button_text, price_monthly, price_label, highlight) VALUES
('plan_free', 'es', 'Para probar', '["200 contactos","500 DMs/mes","3 automatizaciones","Solo Instagram","1 usuario"]', 'Empezar Gratis', 0, 'Gratis', ''),
('plan_starter', 'es', 'Para quien está empezando', '["10.000 DMs/mes","Instagram + TikTok + WhatsApp","25 automatizaciones","IA incluida","2 usuarios"]', 'Elegir Starter', 9.90, '9,90€/mes', ''),
('plan_pro', 'es', 'Para negocios en crecimiento', '["DMs ilimitados","IA avanzada","5 usuarios","CRM + Tags","Analíticas avanzadas","Soporte prioritario"]', 'Elegir Pro', 24.90, '24,90€/mes', 'Más Popular'),
('plan_business', 'es', 'Para agencias y multi-marcas', '["Todo ilimitado","White label","10 usuarios","API + Webhooks","Soporte dedicado"]', 'Elegir Business', 59.90, '59,90€/mes', '');

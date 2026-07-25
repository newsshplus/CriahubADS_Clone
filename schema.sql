-- ============================================================
-- CriaHub Automation — Schema do banco de dados (D1 / SQLite)
-- ============================================================

-- Clientes da CriaHub que vão usar a automação (multi-tenant)
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,              -- gerado por nós (ex: "cli_abc123")
  name TEXT NOT NULL,               -- nome do cliente/empresa
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active / paused
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Contas do Instagram conectadas via OAuth (uma ou mais por cliente)
CREATE TABLE IF NOT EXISTS ig_accounts (
  id TEXT PRIMARY KEY,              -- gerado por nós (ex: "ig_xyz789")
  client_id TEXT NOT NULL REFERENCES clients(id),
  ig_user_id TEXT NOT NULL,         -- ID numérico do Instagram (retornado pela Meta)
  username TEXT,                    -- @usuario, pra exibição
  access_token TEXT NOT NULL,       -- token de acesso (de longa duração)
  token_expires_at TEXT,            -- quando o token expira, pra renovarmos a tempo
  status TEXT NOT NULL DEFAULT 'connected', -- connected / disconnected / error
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ig_user_id)
);

-- Campanhas (cada palavra-chave + mensagens + conteúdo a entregar)
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  keyword TEXT NOT NULL,                    -- palavra-chave do comentário
  private_reply_message TEXT NOT NULL,      -- Mensagem 1
  follow_request_message TEXT NOT NULL,     -- pedido de follow
  delivery_content TEXT NOT NULL,           -- link/conteúdo entregue
  is_default INTEGER NOT NULL DEFAULT 0,    -- 1 = campanha padrão (fallback DM-first)
  status TEXT NOT NULL DEFAULT 'active',    -- active / paused
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Contatos (pessoas que interagiram, por conta do Instagram)
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  igsid TEXT NOT NULL,               -- Instagram-Scoped ID da pessoa
  username TEXT,
  is_following INTEGER DEFAULT 0,    -- último valor conhecido de is_user_follow_business
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ig_account_id, igsid)
);

-- Tags (segmentação de contatos)
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  name TEXT NOT NULL,
  UNIQUE(ig_account_id, name)
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (contact_id, tag_id)
);

-- Estado do fluxo (follow-gate) por contato + campanha
CREATE TABLE IF NOT EXISTS conversation_state (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  stage TEXT NOT NULL DEFAULT 'aguardando_quero', -- aguardando_quero / aguardando_follow / entregue
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (contact_id, campaign_id)
);

-- Dedup persistente de eventos (evita reprocessar o mesmo comentário/mensagem em retries da Meta)
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,        -- comment_id ou message_id
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Índices para consultas mais comuns
CREATE INDEX IF NOT EXISTS idx_ig_accounts_client ON ig_accounts(client_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(ig_account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(ig_account_id);

-- Configuracoes do sistema (chave-valor)
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Log de atividade (todas as interacoes)
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  contact_id TEXT REFERENCES contacts(id),
  campaign_id TEXT REFERENCES campaigns(id),
  event_type TEXT NOT NULL,            -- comment_received, dm_sent, dm_failed, follow_checked, email_collected
  event_detail TEXT,                   -- detalhes do evento (texto do comentario, erro, etc)
  status TEXT NOT NULL DEFAULT 'success', -- success / failed / pending
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Email gate (emails coletados via DM)
CREATE TABLE IF NOT EXISTS collected_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  email TEXT NOT NULL,
  campaign_id TEXT REFERENCES campaigns(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Follow-up automatico (lembretes)
CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  ig_account_id TEXT NOT NULL REFERENCES ig_accounts(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  message TEXT NOT NULL,
  send_after_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / sent / cancelled
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Variações de resposta (para respostas mais naturais)
CREATE TABLE IF NOT EXISTS reply_variations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  variation_type TEXT NOT NULL,        -- comment_reply / dm_quero / dm_follow / dm_entrega
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Índices adicionais
CREATE INDEX IF NOT EXISTS idx_activity_log_account ON activity_log(ig_account_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_collected_emails_account ON collected_emails(ig_account_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_reply_variations_campaign ON reply_variations(campaign_id);

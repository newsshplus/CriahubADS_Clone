-- Notifications table: push notifications sent by admin
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info', -- info, improvement, feature, promo, warning
  icon TEXT DEFAULT '📢',
  link TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- User notifications: tracks which user has seen which notification
CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (notification_id) REFERENCES notifications(id),
  FOREIGN KEY (user_id) REFERENCES saas_users(id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_notif_user ON user_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notif_notif ON user_notifications(notification_id);
CREATE INDEX IF NOT EXISTS idx_notifications_active ON notifications(active);

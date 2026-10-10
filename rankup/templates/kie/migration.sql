-- 独立示例；在已有产品中映射用户/账本表，不重复建立。
PRAGMA foreign_keys = ON;
CREATE TABLE kie_users (id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0 CHECK(credits >= 0));
CREATE TABLE kie_ledger (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES kie_users(id), delta INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE);
CREATE TRIGGER kie_ledger_balance AFTER INSERT ON kie_ledger BEGIN UPDATE kie_users SET credits = credits + NEW.delta WHERE id = NEW.user_id; END;
CREATE TABLE kie_daily (day TEXT PRIMARY KEY, reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micros >= 0));
CREATE TABLE kie_ops (id INTEGER PRIMARY KEY CHECK(id=1), reserved_micros INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, balance REAL, checked_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, alert_at INTEGER);
INSERT INTO kie_ops(id) VALUES(1);
CREATE TRIGGER kie_daily_total_insert AFTER INSERT ON kie_daily BEGIN UPDATE kie_ops SET reserved_micros = reserved_micros + NEW.reserved_micros WHERE id=1; END;
CREATE TRIGGER kie_daily_total_update AFTER UPDATE OF reserved_micros ON kie_daily BEGIN UPDATE kie_ops SET reserved_micros=reserved_micros + NEW.reserved_micros - OLD.reserved_micros WHERE id=1; END;
CREATE TABLE kie_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES kie_users(id), task_id TEXT UNIQUE, status TEXT NOT NULL, site_credits INTEGER NOT NULL, budget_micros INTEGER NOT NULL, day TEXT NOT NULL, photo_keys TEXT NOT NULL DEFAULT '[]', output_keys TEXT, source_expires_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, cost_credits REAL, notified_at INTEGER, photos_deleted_at INTEGER);

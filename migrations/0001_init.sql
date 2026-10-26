CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  max_devices INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS license_devices (
  fingerprint TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS license_events (
  id TEXT PRIMARY KEY,
  license_id TEXT,
  type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_limits (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_license_devices_license ON license_devices(license_id);
CREATE INDEX IF NOT EXISTS idx_license_events_at ON license_events(at DESC);

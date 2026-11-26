CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL,
  repo text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS deployments (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'done', 'failed')),
  sha text,
  url text,
  log text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- höchstens ein laufender Build pro Projekt, auch bei zwei gleichzeitigen Klicks
CREATE UNIQUE INDEX IF NOT EXISTS one_build_per_project ON deployments (project_id) WHERE status = 'building';

-- Phase 2: GitHub App, Admin, Umgebungsvariablen
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS project_env (
  project_id int NOT NULL REFERENCES projects ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (project_id, key)
);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS admin boolean NOT NULL DEFAULT false;

-- Phase 3: eigene Domains, plattformweit eindeutig (zwei User dürfen nicht dieselbe Domain beanspruchen)
CREATE TABLE IF NOT EXISTS domains (
  id serial PRIMARY KEY,
  project_id int NOT NULL REFERENCES projects ON DELETE CASCADE,
  name text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'dns' CHECK (status IN ('dns', 'cert')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS domains_name ON domains (lower(name));

-- GitHub App pro User (wie bei Dokploy): privat, also kann nur sein eigenes GitHub-Konto sie installieren
CREATE TABLE IF NOT EXISTS github_apps (
  user_id int PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  app_id bigint NOT NULL UNIQUE,
  slug text NOT NULL,
  html_url text NOT NULL,
  pem text NOT NULL,
  webhook_secret text NOT NULL,
  installation_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users DROP COLUMN IF EXISTS github_installation_id;
DELETE FROM settings WHERE key = 'github_app';

-- Phase 4.5: Grenzen pro User (gelten als ResourceQuota im Namespace) und Messwerte vom Kubelet
ALTER TABLE users ADD COLUMN IF NOT EXISTS cpu_limit int NOT NULL DEFAULT 1000;      -- Millicores, garantiert
ALTER TABLE users ADD COLUMN IF NOT EXISTS memory_limit int NOT NULL DEFAULT 2048;   -- MiB
ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_limit int NOT NULL DEFAULT 5120;  -- MiB, Images plus /tmp der Pods
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_projects int NOT NULL DEFAULT 3;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS image_bytes bigint;

-- eine Zeile pro Node und Messrunde; alle Zeilen einer Runde haben dieselbe Zeit
CREATE TABLE IF NOT EXISTS node_metrics (
  at timestamptz NOT NULL,
  node text NOT NULL,
  cpu int NOT NULL,            -- Millicores
  cpu_total int NOT NULL,
  memory bigint NOT NULL,      -- Bytes
  memory_total bigint NOT NULL,
  disk bigint NOT NULL,
  disk_total bigint NOT NULL,
  rx bigint NOT NULL,          -- Bytes seit der letzten Runde
  tx bigint NOT NULL,
  PRIMARY KEY (node, at)
);

CREATE TABLE IF NOT EXISTS pod_metrics (
  at timestamptz NOT NULL,
  user_id int NOT NULL REFERENCES users ON DELETE CASCADE,
  project text NOT NULL,
  pod text NOT NULL,
  cpu int NOT NULL,
  memory bigint NOT NULL,
  disk bigint NOT NULL,
  rx bigint NOT NULL,
  tx bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS pod_metrics_user ON pod_metrics (user_id, at);
CREATE INDEX IF NOT EXISTS pod_metrics_at ON pod_metrics (at);

-- Bandbreite pro Tag bleibt länger als die Rohwerte (7 Tage)
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id int NOT NULL REFERENCES users ON DELETE CASCADE,
  day date NOT NULL,
  rx bigint NOT NULL DEFAULT 0,
  tx bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Phase 4: Dateiname aus der Google Search Console (Methode HTML-Datei), gilt für alle Domains des Projekts
ALTER TABLE projects ADD COLUMN IF NOT EXISTS google_verification text;

-- Phase 5.5: dauerhafter Ordner pro Projekt (PVC auf Longhorn, 3 Replikas); beide NULL = kein Ordner
ALTER TABLE projects ADD COLUMN IF NOT EXISTS volume_path text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS volume_mib int;
ALTER TABLE users ADD COLUMN IF NOT EXISTS volume_limit int NOT NULL DEFAULT 1024;  -- MiB pro User, belegt im Cluster das Dreifache

-- Phase 6: persönliche Tokens für MCP (Claude Code, Codex); wie bei sessions nur der Hash
CREATE TABLE IF NOT EXISTS api_tokens (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,              -- "shipli_AbCde", zum Wiedererkennen in der Liste
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens (user_id);

-- jeder MCP-Aufruf; nie Argumente, weil darin Werte von Variablen stehen
CREATE TABLE IF NOT EXISTS mcp_audit (
  id bigserial PRIMARY KEY,
  token_id int NOT NULL REFERENCES api_tokens ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  tool text NOT NULL,
  project_id int,                    -- ohne FK: der Eintrag bleibt, wenn das Projekt gelöscht wird
  ok boolean NOT NULL,
  error text
);
CREATE INDEX IF NOT EXISTS mcp_audit_at ON mcp_audit (at);

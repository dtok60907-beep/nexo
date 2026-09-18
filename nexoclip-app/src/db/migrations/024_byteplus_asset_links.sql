-- Requires 013_generation_outputs_usage.sql: assets(workspace_id, id) unique index.
CREATE TABLE IF NOT EXISTS byteplus_asset_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  local_asset_id UUID NOT NULL,
  group_id TEXT,
  provider_asset_id TEXT,
  attempt_id UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'active', 'failed')),
  error JSONB,
  project_name TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, local_asset_id)
    REFERENCES assets(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, local_asset_id)
);

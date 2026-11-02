-- SQLite mirror of `full-postgres/0039_add_telemetry_provider_model_indexes.sql`.
CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_provider_created_idx"
  ON "telemetry_events" ("tenant_id", "provider_id", "created_at");

CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_model_created_idx"
  ON "telemetry_events" ("tenant_id", "requested_model", "created_at");

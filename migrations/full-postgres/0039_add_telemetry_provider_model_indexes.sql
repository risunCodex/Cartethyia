-- Indexes for the console's per-provider and per-model telemetry aggregates.
--
-- The provider usage matrix and `breakdownTelemetry("provider")` filter on
-- `tenant_id` + `provider_id` and aggregate over `created_at`; the top-model
-- breakdown does the same for `requested_model`. These queries used the
-- tenant-range index, which scanned every event in the window for one
-- provider/model card. Each new index turns the card into an index-only range
-- scan.
CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_provider_created_idx"
  ON "telemetry_events" USING btree ("tenant_id", "provider_id", "created_at");

CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_model_created_idx"
  ON "telemetry_events" USING btree ("tenant_id", "requested_model", "created_at");

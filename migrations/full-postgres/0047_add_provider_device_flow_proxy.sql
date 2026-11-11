-- Adds `provider_routing_settings.device_flow_proxy` (text, NOT NULL, default
-- 'random') — how device-code OAuth flows (start + poll) choose their egress.
--
--   'random' (default) — route the device-authorization and token-poll
--     requests through a randomly selected active network pool. The upstream
--     sees a rotating IP, which prevents "multiple codes from one IP"
--     detection for Cursor/Grok/device-code providers.
--   'direct' — always dial direct egress (the old behavior). Explicitly
--     selected by the operator, e.g. when pools are unavailable or the
--     provider must see one stable address.
--
-- Idempotency comes from the migration ledger, not from the statement: the
-- runner records the file inside the same transaction, so a file that has
-- already run is never re-executed. The baseline is generated from
-- `0000_baseline.sql` alone and does not carry this column.
ALTER TABLE "provider_routing_settings"
  ADD COLUMN IF NOT EXISTS "device_flow_proxy" text NOT NULL DEFAULT 'random';

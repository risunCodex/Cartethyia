-- Relax the native-identity uniqueness for machine-scoped identities.
--
-- The unique index on `native_identity->>'machineToken'` (0026) encoded the
-- OS-derived mint's premise: one device identity per account. The vendor
-- `runtime-info` bridge output is different — it is *machine-scoped*: the
-- component returns a byte-identical token for any/absent account on one
-- host, so every account on that host legitimately shares the identity, and
-- the official upstream scores it as one device (see the donor's issue #158:
-- a risk pin attaches to the machine+egress dimension, not the account).
--
-- The index therefore keeps enforcing one-derived-identity-per-token only
-- where sharing would be a spoof artifact, and lets runtime-info bindings
-- repeat across accounts of the same machine.

DROP INDEX IF EXISTS "provider_accounts_native_identity_token_uidx";

CREATE UNIQUE INDEX "provider_accounts_native_identity_token_uidx"
  ON "provider_accounts" ((native_identity ->> 'machineToken'))
  WHERE native_identity IS NOT NULL
    AND native_identity ->> 'source' <> 'runtime-info';

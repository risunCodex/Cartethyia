/**
 * Backup and restore HTTP surface.
 *
 * `GET /backup/export` streams the payload as a download; `POST /backup/import`
 * accepts a file and restores it, detecting whether it is one of our own
 * backups or a router export.
 *
 * Both require the operator's console password in the body/query, not merely a
 * session: an export is the entire configuration in the clear — every provider
 * credential and API-key hash — and an import replaces it. A stolen session
 * cookie should not be enough to walk away with the secrets or overwrite them,
 * so this is the one console surface that re-authenticates.
 *
 * The body bound is enforced here, before the JSON parse, because the whole
 * point of the limit is to not buffer an unbounded file.
 */
import { Elysia, t, type AnyElysia } from "elysia";
import type { ConsoleAccessResolver } from "../auth/access";
import { invalidateApiKeyCache } from "../../security/api-key-auth";
import { invalidatePublicModels } from "../providers/catalog/public-model-store";
import { ConsoleDomainError, errorResponse, requireAnyScope } from "../shared/errors";
import { NO_COMPRESS_HEADER } from "../response-compression";
import { MAX_BACKUP_BYTES } from "./contracts";
import type { BackupSection } from "./contracts";
import { DELETE_ALL_SCOPES, compressBackupStream } from "./store";
import type { BackupService } from "./service";
import type { AuditRecorder } from "../auth/audit-recorder";

interface BackupRoutesConfig {
  readonly accessResolver: ConsoleAccessResolver;
  /**
   * Builds the service for one request. A factory rather than an instance
   * because re-authentication reads the caller's session, and a shared
   * instance would have to hold one request's identity across others.
   */
  readonly backupFor: (request: Request) => BackupService;
  /**
   * Structurally satisfied by `InMemoryRouteSnapshotService`.
   *
   * A restore replaces the rows that decide where traffic goes — providers,
   * models, aliases, and combos among them — so the cached route snapshot
   * describes a catalog that no longer exists the moment the transaction
   * commits. Without this the data plane keeps dispatching the pre-restore
   * routing (a combo that now points at different members still resolves its
   * old members) until some unrelated console write happens to invalidate.
   */
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /**
   * The tenant's API keys, read after a restore so their admission counters can
   * be purged. A restore replaces `api_keys` wholesale, so a key that was
   * revoked after the backup — and had its counters purged by `deleteKey` — can
   * come back with `revoked_at = NULL`; without purging, its lifetime counter
   * is re-seeded from the restored total, granting a fresh full budget on top
   * of everything already spent. Optional so a host that never restores keys
   * need not supply it.
   */
  readonly apiKeyStore?: { list(tenantId: string): Promise<readonly { id: string }[]> };
  /**
   * Structurally satisfied by `ApiKeyAdmissionService`. Purges one key's
   * reservation/counter state. Paired with {@link apiKeyStore} on restore.
   */
  readonly admissionService?: { purgeKey(apiKeyId: string): Promise<void> };
  readonly auditSink?: AuditRecorder;
}

/**
 * Scopes that may export or restore configuration.
 *
 * `dashboard:write` is the console session. It is the only scope that can
 * actually complete either action: both re-authenticate by verifying the
 * operator's password against their session's user row, and a tenant API key
 * carries no session, so a key reaching this route fails at that gate rather
 * than at the scope check. The scope list is stated in full anyway so the
 * rejection a key receives names the scope it would need, instead of implying
 * the route is open to a credential that can never satisfy it.
 */
const BACKUP_SCOPES = ["dashboard:write"] as const;

const importBody = t.Object({
  password: t.String(),
  backup: t.Unknown(),
  /**
   * Table names to restore. Absent or empty restores every table in the file,
   * which is what the dashboard's checklist defaults to and what the API did
   * before selection existed.
   */
  tables: t.Optional(t.Array(t.String())),
});

/**
 * The inspect body: a file, no password.
 *
 * Inspection writes nothing and reads no secret — it only reports which tables
 * the file carries and which of them the live schema has — so it needs no
 * re-authentication. Requiring the console password here would mean typing it
 * twice for one restore.
 */
const inspectBody = t.Object({
  backup: t.Unknown(),
});

const exportQuery = t.Object({
  password: t.String(),
  sections: t.Optional(t.String()),
  compressed: t.Optional(t.String()),
});

const deleteAllBody = t.Object({
  password: t.String(),
  scopes: t.Array(t.Union(DELETE_ALL_SCOPES.map((scope) => t.Literal(scope))), { minItems: 1 }),
});

function parseSections(raw: string | undefined): readonly BackupSection[] | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0) as readonly BackupSection[];
}

/**
 * Enforces the byte bound against actual received bytes, not just the declared
 * header: a missing or spoofed content-length would otherwise bypass the 413
 * and buffer an unbounded file into JSON.parse. Elysia has already parsed the
 * body here, so measure the re-serialized form — an over-limit file still
 * fails closed before any restore/inspection touches the DB. Returns the 413
 * response when over the limit, or `null` when the body is accepted.
 */
function enforceBodyLimit(request: Request, body: unknown, set: { status?: number | string }): { error: string; code: string } | null {
  const declared = Number(request.headers.get("content-length") ?? "0");
  const actualBytes = JSON.stringify(body ?? null).length;
  if (
    (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) ||
    actualBytes > MAX_BACKUP_BYTES
  ) {
    set.status = 413;
    return {
      error: `backup exceeds the ${MAX_BACKUP_BYTES} byte limit`,
      code: "request_too_large",
    };
  }
  return null;
}

/**
 * Streams the export document into the response body as it is written; one
 * row-page of the tenant's data is in memory at a time.
 */
function payloadDocument(chunks: AsyncGenerator<string, void, void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await chunks.return();
    },
  });
}

export function createBackupRoutes(config: BackupRoutesConfig): AnyElysia {
  return new Elysia({ prefix: "/backup" })
    .get("/export", { query: exportQuery }, async ({ request, query, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), BACKUP_SCOPES);
        if (access.tenantId === null) {
          throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
        }
        const backup = config.backupFor(request);
        const sections = parseSections(query.sections);
        const compressed = query.compressed === "1";
        const exportStream = await backup.export({
          password: query.password,
          tenantId: access.tenantId,
          compressed,
          ...(sections === undefined ? {} : { sections }),
        });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        set.headers["cache-control"] = "no-store";
        if (!compressed) {
          // The document is written through the stream, so a tenant with
          // hundreds of thousands of rows is serialized here while only one
          // row-page of it is ever in memory. The headers live on the
          // Response itself: a native Response carries the stream, and the
          // response wrapper would otherwise buffer it whole to gzip it —
          // the same trade its ceiling path already made for large exports
          // (rebuilt, uncompressed) — so this branch opts out of it.
          const headers = new Headers({
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="cartethyia_backup_${stamp}.json"`,
            "content-type": "application/json; charset=utf-8",
            [NO_COMPRESS_HEADER]: "1",
          });
          return new Response(payloadDocument(exportStream.jsonChunks), { headers });
        }
        const bytes = await compressBackupStream(exportStream.jsonChunks);
        set.headers["content-type"] = "application/json; charset=utf-8";
        // Opt out of the response wrapper's gzip rather than declaring
        // `content-encoding: gzip`: the bytes here are base64 of a gzip
        // stream, and a client told "this is gzip" tries to inflate the
        // base64 text and fails. The payload inside is already compressed,
        // and a second pass over base64 would find nothing to gain while
        // paying a synchronous `gzipSync` over the whole multi-MB body.
        set.headers[NO_COMPRESS_HEADER] = "1";
        return { compressed: true, filename: `cartethyia_backup_${stamp}.json.gz`, bytes: bytes.toString("base64") };
      } catch (error) {
        return errorResponse(error, set, "Backup export failed");
      }
    })
    .post("/import", { body: importBody }, async ({ request, body, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), BACKUP_SCOPES);
        if (access.tenantId === null) {
          throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
        }
        const tooLarge = enforceBodyLimit(request, body, set);
        if (tooLarge !== null) return tooLarge;
        // The restoring tenant comes from the caller's own access decision and
        // from nowhere else. A request body may not name the tenant it writes
        // into: that would let any holder of the scope import into, and
        // overwrite, a tenant they are not.
        const result = await config.backupFor(request).restore(
          body.password,
          body.backup,
          access.tenantId,
          body.tables === undefined ? undefined : { tables: body.tables },
        );
        // Routing-visible write: the restore has committed, so the cached
        // snapshot must be rebuilt before the next `/v1/*` dispatch.
        await config.snapshotInvalidator?.invalidate();
        // A restore can re-insert keys the tenant revoked after the backup, and
        // `deleteKey` purged their counters when they went away. Drop the whole
        // auth cache (the restore is rare, and a stale entry for any key must
        // not survive it) and purge admission state for every key the tenant
        // now has, so a resurrected key cannot start with a fresh budget.
        if (result.restored.api_keys !== undefined) {
          invalidateApiKeyCache();
          // A restore rewrites the catalog and every key's allowlist, so a
          // cached model listing is stale. Called directly as well as through
          // the routing notice above, because with no Redis there is no notice
          // — and this process's own cache would survive the restore.
          invalidatePublicModels();
          const keys = await config.apiKeyStore?.list(access.tenantId);
          if (keys && config.admissionService) {
            const admission = config.admissionService;
            await Promise.all(keys.map((key) => admission.purgeKey(key.id)));
          }
        }
        set.status = 200;
        // `partial` is the honest verdict: a 200 with warnings means the file
        // was applied as far as the current schema allows, not in full.
        return { ...result, partial: result.warnings.length > 0 };
      } catch (error) {
        return errorResponse(error, set, "Backup import failed");
      }
    })
    .post("/delete-all", { body: deleteAllBody }, async ({ request, body, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), BACKUP_SCOPES);
        if (access.tenantId === null) {
          throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
        }
        const result = await config.backupFor(request).deleteAll(body.password, body.scopes, access.tenantId);
        await config.auditSink?.record({
          access,
          action: "backup.delete_all",
          target: access.tenantId,
          detail: { scopes: [...new Set(body.scopes)], deleted: result.deleted },
        });
        invalidateApiKeyCache();
        invalidatePublicModels();
        await Promise.allSettled([
          config.snapshotInvalidator?.invalidate(),
          ...(config.admissionService
            ? result.apiKeyIds.map((id) => config.admissionService?.purgeKey(id))
            : []),
        ]);
        set.status = 200;
        return { deleted: result.deleted };
      } catch (error) {
        return errorResponse(error, set, "Delete all failed");
      }
    })
    .post("/inspect", { body: inspectBody }, async ({ request, body, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), BACKUP_SCOPES);
        if (access.tenantId === null) {
          throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
        }
        const tooLarge = enforceBodyLimit(request, body, set);
        if (tooLarge !== null) return tooLarge;
        // Reads nothing and writes nothing: the checklist the restore wizard
        // shows, so an operator can pick sections before typing a password.
        return config.backupFor(request).inspect(body.backup);
      } catch (error) {
        return errorResponse(error, set, "Backup inspection failed");
      }
    });
}

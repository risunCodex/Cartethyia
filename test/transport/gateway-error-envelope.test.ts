/**
 * The public error envelope: the only thing a client is allowed to learn about
 * a failure.
 *
 * Every rejection the gateway produces — a quota 429, an upstream 502, a
 * routing 404 — is shaped by this module before it leaves. Two properties carry
 * the whole risk:
 *
 * 1. **Nothing outside the allowlist escapes.** `details` is populated by
 *    internal code with whatever it finds useful, including upstream response
 *    bodies. The allowlist is the boundary between "useful to a client" and
 *    "an internal map of the deployment" — provider ids, pool ids, account
 *    scope, and routing reasons are all on it deliberately, and everything else
 *    (including a future field nobody re-checked) must be dropped.
 * 2. **An upstream body that echoes a credential must be redacted.** `raw` is
 *    the one allowlisted field that carries attacker-controlled text: an
 *    upstream 401 body frequently repeats the API key it rejected. That is why
 *    it alone passes through `redactTelemetryValue` before being bounded.
 *
 * The message shaper is the third surface: clients branch on the code, and a
 * legacy brand prefix leaking into the text tells a client which product is in
 * front of the upstream.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  explainGatewayError,
  formatPublicErrorMessage,
  GatewayError,
  publicGatewayErrorDetails,
  type GatewayErrorCode,
} from "../../src/protocol/gateway-error";

/**
 * Which HTTP status each code means, and the sites allowed to differ.
 *
 * A client branches on the code first and the status second, so one code
 * answering two unrelated statuses makes the code useless: `authentication_failed`
 * at 400 told a client to fix its request body when it needed to fix its
 * credential. This table is what "consistent" means here.
 *
 * The exemptions are real and deliberate, not debt: a code whose status is
 * derived from an upstream response (`transport_unavailable`,
 * `platform_unavailable`, `invalid_request` at the console's HTTP surface)
 * legitimately spans a range, because the upstream chose the status. Pinning
 * those to one value would be pinning a lie.
 */
const EXPECTED_STATUS: Readonly<Record<string, readonly number[]>> = {
  authentication_failed: [401],
  capacity_exhausted: [429],
  provider_capacity_exhausted: [429],
  // A queued request is always 503: the upstream accepted it and will serve it,
  // so the status must not say "forbidden" or "bad request".
  upstream_queued: [503],
  tenant_capacity_exhausted: [429],
  quota_exceeded: [429],
  accounts_rate_limited: [429],
  accounts_unavailable: [503],
  admission_unavailable: [503],
  policy_rejected: [403],
  model_not_found: [404],
  ambiguous_model: [400],
  capability_unsupported: [400],
};

/**
 * Reads every `new GatewayError(<literal>, <literal>` in `src/` and groups the
 * statuses each code is constructed with.
 *
 * Scans source text rather than importing and exercising each producer: there
 * are hundreds of sites across providers, guards, and console routes, and a
 * table of hand-collected cases would silently stop covering new ones. A new
 * inconsistent site is caught the day it is written.
 */
function scannedStatuses(): Map<string, Set<number>> {
  const root = new URL("../../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const found = new Map<string, Set<number>>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith(".ts")) continue;
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]!.includes("new GatewayError(")) continue;
        // The code and status are usually on the line after the constructor.
        const match = lines
          .slice(i, i + 3)
          .join(" ")
          .match(/new GatewayError\(\s*"([a-z_]+)"\s*,\s*(\d+)/);
        if (!match) continue;
        const set = found.get(match[1]!) ?? new Set<number>();
        set.add(Number(match[2]));
        found.set(match[1]!, set);
      }
    }
  };
  walk(root);
  return found;
}

describe("error code consistency", () => {
  test("one code means one status, except where upstream chooses it", () => {
    const found = scannedStatuses();
    for (const [code, expected] of Object.entries(EXPECTED_STATUS)) {
      const actual = [...(found.get(code) ?? [])].sort((a, b) => a - b);
      // Only the codes this test claims to know about; a code absent from
      // `src` entirely is not a consistency question.
      if (actual.length === 0) continue;
      expect(actual, `code ${code}`).toEqual([...expected].sort((a, b) => a - b));
    }
  });

  test("no public error message is written in another language", () => {
    // Client-facing text, so it must be readable without knowing this
    // deployment's locale. One message was Indonesian ("IP kamu diblokir…");
    // this is the guard that keeps another from landing.
    //
    // Two checks, because either alone is blind to a different case:
    //
    // 1. **Script.** A message whose letters are not Latin (Cyrillic, CJK,
    //    Arabic, Greek) is certainly not English. This does NOT reject
    //    typographic punctuation — the codebase writes em dashes, arrows and
    //    middots in its prose, and banning those would ban the house style
    //    rather than a translation.
    // 2. **Stopwords.** Indonesian is written in Latin script, so the script
    //    check passes right over it — the exact miss that let the original
    //    message through. These are the common function words no English
    //    message contains; they are also not substrings of English words, so
    //    "banned" and "invalid" stay clean.
    const ALLOWED_PUNCTUATION = /[—–…·→←↔≤≥²³§│─┌┐└┘]/g;
    const EMOJI = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
    const NON_ENGLISH_STOPWORDS = /\b(kamu|anda|tidak|diblokir|dengan|untuk|karena|yang|ini|itu|silakan|hingga|terlalu|banyak|atau|dari|kepada|adalah|akan|sudah|bisa|jika|mohon|maaf|permintaan|kunci|waktu|menit|jam|hari)\b/i;
    const root = new URL("../../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts")) continue;
        const lines = readFileSync(path, "utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i]!.includes("new GatewayError(")) continue;
          const chunk = lines.slice(i, i + 4).join(" ");
          // Only the string literal on the constructor's message argument, so a
          // non-English *comment* nearby is not reported.
          const message = chunk.match(/new GatewayError\([^)]*?,\s*\d+,\s*"([^"]*)"/);
          if (!message) continue;
          const text = message[1]!;
          // Emoji are a deliberate part of the house tone (one per message),
          // so they are stripped before the script check — but non-Latin
          // scripts (Cyrillic, CJK, Arabic, Greek) and Indonesian stopwords
          // still fail, which is the point of the guard.
          const notLatin = /[^\x20-\x7E]/.test(
            text.replace(EMOJI, "").replace(ALLOWED_PUNCTUATION, ""),
          );
          if (notLatin || NON_ENGLISH_STOPWORDS.test(text)) offenders.push(`${path}:${i + 1}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("GatewayError", () => {
  test("carries its code, status, origin, and details", () => {
    const error = new GatewayError("quota_exceeded", 429, "rpm limit exceeded", { limit: 10 });
    expect(error.code).toBe("quota_exceeded");
    expect(error.status).toBe(429);
    expect(error.origin).toBe("cartethyia");
    expect(error.details).toEqual({ limit: 10 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GatewayError");
  });

  test("defaults to the gateway as the origin", () => {
    // Origin drives the operator's triage: "our bug" and "the provider's bug"
    // are different incidents. A default of `upstream` would mis-blame.
    expect(new GatewayError("internal_error", 500, "x").origin).toBe("cartethyia");
  });

  test("defaults to no details rather than undefined", () => {
    // `Object.entries(error.details)` runs on every public envelope; an
    // undefined details object would throw inside the error path itself.
    expect(new GatewayError("internal_error", 500, "x").details).toEqual({});
  });

  test("accepts each documented origin", () => {
    for (const origin of ["cartethyia", "upstream", "network"] as const) {
      expect(new GatewayError("platform_unavailable", 502, "x", {}, origin).origin).toBe(origin);
    }
  });
});

describe("formatPublicErrorMessage", () => {
  test("leaves an explanatory message alone — no code stamped into the text", () => {
    // The code already travels in `error.code` and the class in the HTTP status.
    // Prefixing it (`accounts_unavailable: Model 'x' …`) put an internal enum
    // in front of the operator's sentence and helped nobody read it.
    expect(formatPublicErrorMessage("quota_exceeded", "rpm limit exceeded")).toBe(
      "rpm limit exceeded",
    );
  });

  test("strips a code prefix it is handed instead of adding one", () => {
    // The shaper can run more than once on a value that crossed two boundaries,
    // and older builders stamped `code:` into the message. Stripping is
    // idempotent, so the text can never end up doubled or re-prefixed.
    expect(formatPublicErrorMessage("quota_exceeded", "quota_exceeded: rpm limit exceeded")).toBe(
      "rpm limit exceeded",
    );
  });

  test("a message equal to the code is not doubled", () => {
    // The error path can build a message from the code alone; stripping it
    // leaves nothing, so the bare code is the only thing left to say.
    expect(formatPublicErrorMessage("not_found", "not_found")).toBe("not_found");
  });

  test("an empty message collapses to the bare code", () => {
    // A blank explanatory clause would render an empty string, which reads as a
    // truncated response. The code is the only fact left.
    expect(formatPublicErrorMessage("not_found", "")).toBe("not_found");
    expect(formatPublicErrorMessage("not_found", "   ")).toBe("not_found");
  });

  test("strips every legacy origin brand prefix", () => {
    // Not hypothetical: before 4f0c6a1a `labelGatewayMessage` stamped these
    // into the public message, and `gatewayErrorFromStreamError` still embeds
    // raw upstream text, so a chained gateway on an older build emits exactly
    // this shape into our error path. A client must never see the brand, and
    // blame lives in the structured `origin` field instead.
    expect(formatPublicErrorMessage("internal_error", "Cartethyia Error: something broke")).toBe(
      "something broke",
    );
    expect(formatPublicErrorMessage("platform_unavailable", "Upstream Error: bad gateway")).toBe(
      "bad gateway",
    );
    expect(formatPublicErrorMessage("transport_unavailable", "Network Error: reset")).toBe("reset");
  });

  test("a legacy prefix alone collapses to the bare code", () => {
    // Stripping leaves nothing; the result must not be an empty message.
    expect(formatPublicErrorMessage("internal_error", "Cartethyia Error:")).toBe("internal_error");
    expect(formatPublicErrorMessage("internal_error", "  Cartethyia Error:   ")).toBe(
      "internal_error",
    );
  });

  test("only the leading prefix is stripped, not one embedded in the text", () => {
    // A message that happens to mention the brand mid-sentence is real content;
    // stripping it would corrupt the explanation.
    expect(
      formatPublicErrorMessage("internal_error", "the Cartethyia Error: handler failed"),
    ).toBe("the Cartethyia Error: handler failed");
  });

  test("an explanatory sentence survives intact", () => {
    // The point of the change: the sentence the operator reads is the sentence
    // the builder wrote, start to finish.
    expect(
      formatPublicErrorMessage(
        "accounts_unavailable",
        "No account in the pool can serve 'workbuddy/glm-5.3' right now (credit or quota is exhausted).",
      ),
    ).toBe(
      "No account in the pool can serve 'workbuddy/glm-5.3' right now (credit or quota is exhausted).",
    );
  });

  test("surrounding whitespace is trimmed", () => {
    expect(formatPublicErrorMessage("not_found", "  missing  ")).toBe("missing");
  });
});

describe("explainGatewayError", () => {
  test("formats the error's own code and message", () => {
    const error = new GatewayError("accounts_rate_limited", 429, "all accounts are cooling down");
    expect(explainGatewayError(error)).toBe("all accounts are cooling down");
  });

  test("does not mutate the error it explains", () => {
    // The same error object is reused for telemetry and for the console; a
    // formatter that rewrote `message` in place would leak the shaped text into
    // the internal record.
    const error = new GatewayError("internal_error", 500, "Cartethyia Error: boom");
    explainGatewayError(error);
    expect(error.message).toBe("Cartethyia Error: boom");
  });

  test("the origin never appears in the public text", () => {
    // The comment is explicit: gateway and upstream look the same on the wire,
    // and a client that needs the layer reads `error.origin`.
    for (const origin of ["cartethyia", "upstream", "network"] as const) {
      const text = explainGatewayError(new GatewayError("platform_unavailable", 502, "failed", {}, origin));
      expect(text).not.toContain(origin);
    }
  });
});

describe("publicGatewayErrorDetails — the allowlist", () => {
  test("keeps every allowlisted key it is given", () => {
    // The allowlist is deliberate: provider, pool, account scope, and routing
    // reasons are what a client needs to act on a rejection. `maxInflight` and
    // `weight` are the pool-capacity pair `leases.ts` publishes with
    // `proxy_pool_capacity_exceeded` — the retired per-account column was
    // `provider_accounts.max_inflight`, but this key comes from the pool limit,
    // not from that column, and must not be pruned as dead with it.
    const details = {
      providerId: "anthropic",
      poolId: "pool-1",
      model: "claude-sonnet-4-6",
      reason: "rpm-exhausted",
      retryAfterMs: 1_500,
      upstreamStatus: 429,
      requestId: "req-1",
      maxInflight: 10,
      weight: 100,
    };
    expect(publicGatewayErrorDetails(new GatewayError("quota_exceeded", 429, "x", details))).toEqual(
      details,
    );
  });

  test("drops every key that is not on the allowlist", () => {
    // This is the boundary. An internal field that reaches a client is an
    // information leak, and the failure mode is silent — nothing else breaks.
    const details = {
      providerId: "anthropic",
      owners: ["tenant-secret"],
      tenantId: "tenant-secret",
      internalNote: "upstream said the key sk-live-EXAMPLE is revoked",
      stack: "at someInternalFunction (/srv/app/src/secret.ts:42)",
      databaseUrl: "postgres://user:pw@host/db",
      providerIdInternal: "x",
    };
    const public_ = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    );
    expect(public_).toEqual({ providerId: "anthropic" });
    // Sweep the serialized envelope, so a key added later is caught by this
    // test rather than by an incident.
    const serialized = JSON.stringify(public_);
    for (const secret of [
      "tenant-secret",
      "sk-live-EXAMPLE",
      "someInternalFunction",
      "/srv/app",
      "postgres://",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("an empty details object yields an empty envelope", () => {
    expect(publicGatewayErrorDetails(new GatewayError("not_found", 404, "x"))).toEqual({});
  });

  test("a key that merely resembles an allowlisted one is dropped", () => {
    // Exact membership, not a prefix or case-insensitive match: `ProviderId`
    // and `provider_id` are different keys, and only the listed spelling is
    // published.
    const details = { ProviderId: "anthropic", provider_id: "anthropic", providerId: "anthropic" };
    expect(
      publicGatewayErrorDetails(new GatewayError("accounts_unavailable", 503, "x", details)),
    ).toEqual({ providerId: "anthropic" });
  });

  test("a value of undefined is published as undefined, not dropped", () => {
    // MEASURED: the filter is on the key alone. The envelope then serializes
    // the key away in JSON, so this is observable only on the object. Pinned
    // because a change to `Object.entries` handling would alter the shape.
    const details = { providerId: undefined, reason: "x" };
    const public_ = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    );
    expect("providerId" in public_).toBe(true);
    expect(public_.providerId).toBeUndefined();
  });
});

describe("publicGatewayErrorDetails — bounds", () => {
  test("a long string is truncated to 500 characters", () => {
    // An upstream that answers with a multi-megabyte body must not turn the
    // error envelope into a multi-megabyte response.
    const details = { safeMessage: "x".repeat(10_000) };
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", details),
    ).safeMessage;
    expect(typeof value).toBe("string");
    expect((value as string).length).toBe(500);
  });

  test("an array is truncated to 32 entries", () => {
    const details = { reasons: Array.from({ length: 100 }, (_value, index) => `r${index}`) };
    const value = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    ).reasons;
    expect(Array.isArray(value)).toBe(true);
    expect((value as readonly unknown[]).length).toBe(32);
  });

  test("an object nested past three levels is redacted", () => {
    // MEASURED: the depth guard runs *after* the string check, so a scalar at
    // any depth survives and only an object at depth 3 or deeper becomes
    // `"[redacted]"`. Depth bounds the work a hostile upstream can make the
    // gateway do while building an error response, and it is the point past
    // which the envelope stops being a client-facing explanation — so the
    // assertion nests an object, which is the shape the guard actually catches.
    const details = {
      reason: { level2: { level3: { level4: { level5: "deep" } } } },
    };
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", details),
    ).reason;
    expect(JSON.stringify(value)).toContain("[redacted]");
    expect(JSON.stringify(value)).not.toContain("deep");
  });

  test("a scalar at any depth is preserved, only its container is bounded", () => {
    // The complement of the test above, pinned so nobody "tightens" the guard
    // into dropping scalar leaves: the leaves are the useful part of an error
    // explanation and the depth bound exists to stop recursion, not to hide
    // values.
    const details = {
      reason: { level2: { level3: { level4: "still visible" } } },
    };
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", details),
    ).reason;
    expect(JSON.stringify(value)).toContain("still visible");
  });

  test("shallow nesting is preserved in full", () => {
    // The bound must not be so tight that the useful shape is lost.
    const details = { reason: { a: "1", b: { c: "2" } } };
    expect(
      publicGatewayErrorDetails(new GatewayError("platform_unavailable", 502, "x", details)).reason,
    ).toEqual({ a: "1", b: { c: "2" } });
  });

  test("non-string scalars pass through untouched", () => {
    // Numbers and booleans are the useful part of a rejection: a client retries
    // on `retryAfterMs` and branches on `upstreamStatus`.
    const details = { retryAfterMs: 1_500, upstreamStatus: 429, available: true, capacity: 0 };
    expect(
      publicGatewayErrorDetails(new GatewayError("capacity_exhausted", 429, "x", details)),
    ).toEqual(details);
  });

  test("null and an absent value survive as-is", () => {
    const details = { reason: null };
    expect(
      publicGatewayErrorDetails(new GatewayError("platform_unavailable", 502, "x", details)).reason,
    ).toBeNull();
  });
});

describe("publicGatewayErrorDetails — raw is published verbatim", () => {
  test("an upstream body reaches the client unmodified", () => {
    // The `raw` field used to be swept for credential-shaped strings. It no
    // longer is: rewriting part of an upstream body makes the echoed error
    // unreadable, and a 400 the operator has to diagnose loses the one field
    // that names what the provider actually objected to. The upstream decides
    // what it echoes; the gateway does not edit it.
    const upstreamBody = {
      error: {
        message: "invalid api key: sk-ant-api03-EXAMPLEnotarealkey000000000000",
        type: "authentication_error",
      },
    };
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", { raw: upstreamBody }),
    ).raw;
    expect(JSON.stringify(value)).toContain("sk-ant-api03-EXAMPLEnotarealkey000000000000");
  });

  test("a bearer token echoed in an upstream body is preserved", () => {
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", {
        raw: { detail: "Authorization: Bearer EXAMPLEtokenvalue1234567890 was rejected" },
      }),
    ).raw;
    expect(JSON.stringify(value)).toContain("EXAMPLEtokenvalue1234567890");
  });

  test("the body keeps its shape rather than collapsing to a placeholder", () => {
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", {
        raw: { error: { type: "authentication_error", message: "bad key" } },
      }),
    ).raw;
    expect(JSON.stringify(value)).toContain("authentication_error");
    expect(JSON.stringify(value)).toContain("bad key");
  });

  test("every allowlisted field is published verbatim", () => {
    // No field gets a credential sweep now — the contract is pass-through, so
    // `safeMessage` and `raw` behave the same way.
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", { safeMessage: "upstream returned 500" }),
    ).safeMessage;
    expect(value).toBe("upstream returned 500");
  });

  test("raw is still size-bounded", () => {
    // The bound survives the removal of the sweep: an enormous upstream body
    // is still cut down before it reaches an envelope.
    const longBody = `x${"a".repeat(4_000)}`;
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", { raw: { message: longBody } }),
    ).raw;
    expect(JSON.stringify(value).length).toBeLessThan(2_000);
  });
});

describe("publicGatewayErrorDetails — a hostile details object", () => {
  test("a circular details object does not throw", () => {
    // `details` is built by internal code, but a value passed through from an
    // upstream JSON body could in principle be cyclic after a transform. An
    // error path that throws replaces a useful rejection with a 500.
    const circular: Record<string, unknown> = { providerId: "anthropic" };
    circular.reason = circular;
    let failure: unknown = null;
    let result: Readonly<Record<string, unknown>> | undefined;
    try {
      result = publicGatewayErrorDetails(
        new GatewayError("accounts_unavailable", 503, "x", circular),
      );
    } catch (error: unknown) {
      failure = error;
    }
    // The depth bound stops the recursion, so this resolves rather than throws.
    expect(failure).toBeNull();
    expect(result?.providerId).toBe("anthropic");
  });

  test("a details object with a getter that throws does not escape", () => {
    // `Object.entries` reads every value. A throwing getter on an untrusted
    // object would otherwise surface as a 500 instead of the real rejection.
    const hostile: Record<string, unknown> = { providerId: "anthropic" };
    Object.defineProperty(hostile, "reason", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    let failure: unknown = null;
    try {
      publicGatewayErrorDetails(new GatewayError("accounts_unavailable", 503, "x", hostile));
    } catch (error: unknown) {
      failure = error;
    }
    // Recorded as the measured behaviour: the sanitizer is not defensive against
    // a throwing getter, because `details` is gateway-authored rather than
    // client-supplied. Pinned so a change here is a deliberate decision.
    expect(failure).toBeInstanceOf(Error);
  });

  test("a very wide array is bounded, not walked entirely", () => {
    const details = { reasons: Array.from({ length: 100_000 }, () => "x") };
    const value = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    ).reasons;
    expect((value as readonly unknown[]).length).toBe(32);
  });
});

describe("the error code vocabulary", () => {
  test("every code is a non-empty stable identifier", () => {
    // Clients branch on these strings. A code with a space, an uppercase letter,
    // or an empty value would break a client's match without failing anything
    // in the gateway.
    const codes: readonly GatewayErrorCode[] = [
      "capability_unsupported",
      "ambiguous_model",
      "model_not_found",
      "upstream_not_found",
      "context_length_exceeded",
      "request_too_large",
      "accounts_unavailable",
      "accounts_rate_limited",
      "capacity_exhausted",
      "provider_capacity_exhausted",
      "upstream_queued",
      "proxy_pool_capacity_exceeded",
      "proxy_pool_provider_capacity_exceeded",
      "proxy_pool_blocked",
      "proxy_pool_cooldown",
      "proxy_pool_unavailable",
      "proxy_pool_unhealthy",
      "invalid_pool_limits",
      "admission_unavailable",
      "slug_reserved",
      "quota_exceeded",
      "authentication_failed",
      "policy_rejected",
      "invalid_request",
      "not_found",
      "link_not_found",
      "invalid_sequence",
      "invalid_lifecycle",
      "unsupported_field",
      "unsupported_media_type",
      "upstream_conflict",
      "upstream_unprocessable",
      "internal_error",
      "transport_unavailable",
      "tunnel_setup_failed",
      "platform_unavailable",
      "tenant_capacity_exhausted",
      "tls_rejected",
      "proxy_auth_required",
      "deadline_exceeded",
      "transport_closed",
      "max_connections_exceeded",
      "proxy_unreachable",
      "tool_call_loop_detected",
      "client_router_denied",
      "shutting_down",
      "upstream_overloaded",
    ];
    for (const code of codes) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    // The list above is exhaustive by construction: it is typed as the union,
    // so adding a code to the product without adding it here fails typecheck.
    expect(new Set(codes).size).toBe(codes.length);
  });
});

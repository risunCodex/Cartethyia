/**
 * The buddy CLI identity.
 *
 * These assertions come from the two reference gateways, which agree on the
 * split: the desktop product sends browser *transport* headers plus a device
 * token, and the CLI — issued by the OpenAI Node SDK — sends neither, and adds
 * the agent envelope and the SDK fingerprint. The CLI still keeps the
 * request-shape markers (`x-requested-with`, `x-codebuddy-request`) the
 * reference sends on every call; what it drops is the browser transport
 * (`accept: text/event-stream`, `origin`, `referer`, `accept-language`) and the
 * device token — that combination is what separates CLI from the desktop
 * hybrid these tests pin.
 *
 * Opt-in is pinned too: an unset flag must leave every header exactly as it
 * was, because a wrong identity upstream is what gets an account blocked.
 */
import { describe, expect, test } from "bun:test";
import { codebuddyHeaders } from "../../src/providers/integrations/buddy/codebuddy/shared";
import { workbuddyHeaders } from "../../src/providers/integrations/buddy/workbuddy/shared";
import type { ProviderDispatchContext } from "../../src/providers/provider-contracts";

/** No browser *transport* header survives into the CLI identity. */
const BROWSER_HEADERS = ["origin", "referer", "accept-language"] as const;

/** Request-shape markers the reference sends on every call, CLI included. */
const REQUEST_MARKERS = ["x-requested-with", "x-codebuddy-request"] as const;

const AGENT_ENVELOPE = ["X-Agent-Intent", "X-Agent-Type", "X-Agent-Runtime"] as const;

const STAINLESS = [
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count",
] as const;

const context = {
  credential: { account_id: "abcdef123456", auth_state: { deviceToken: "desktop-token" } },
} as unknown as ProviderDispatchContext;

const anonymous = {
  credential: { auth_state: {} },
} as unknown as ProviderDispatchContext;

describe("CodeBuddy CLI identity", () => {
  test("carries the agent envelope and no stainless fingerprint on chat", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    expect(headers["X-Agent-Intent"]).toBe("craft");
    expect(headers["X-Agent-Type"]).toBe("main");
    // The reference enum is local-agent / cloud-agent / agent-agent; a gateway
    // is none of them and the parser returns "other" for unknown.
    expect(headers["X-Agent-Runtime"]).toBe("other");
    // The CLI's chat transport is axios, not the OpenAI Node SDK, so the
    // stainless fingerprint is absent on CodeBuddy chat.
    for (const name of STAINLESS) expect(headers[name]).toBeUndefined();
  });

  test("drops browser transport and the device token, keeps the request markers", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    for (const name of BROWSER_HEADERS) expect(headers[name]).toBeUndefined();
    // The account carries a device token; the CLI never sends one.
    expect(headers["X-Device-Token"]).toBeUndefined();
    expect(headers["x-device-token"]).toBeUndefined();
    expect(headers["accept"]).toBe("application/json");
    // The request-shape markers the reference sends on every call survive.
    for (const name of REQUEST_MARKERS) expect(headers[name]).toBeDefined();
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["x-codebuddy-request"]).toBe("1");
  });

  test("sets X-User-Id from the account, and anonymous without one", async () => {
    expect((await codebuddyHeaders("CLI", context, undefined, true))["X-User-Id"]).toBe("abcdef123456");
    // The reference sends the literal `anonymous` rather than omitting it.
    expect((await codebuddyHeaders("CLI", anonymous, undefined, true))["X-User-Id"]).toBe("anonymous");
  });

  test("prefers the JWT sub as X-User-Id when the credential carries one", async () => {
    // The reference keys on the upstream uid (`sub`), not the internal account
    // id — the two can diverge after an import.
    const token = `h.${Buffer.from(JSON.stringify({ sub: "jwt-sub-uid" })).toString("base64url")}.s`;
    const jwtContext = {
      credential: { account_id: "internal-account", secret: new TextEncoder().encode(token) },
    } as unknown as ProviderDispatchContext;
    const headers = await codebuddyHeaders("CLI", jwtContext, undefined, true);
    expect(headers["X-User-Id"]).toBe("jwt-sub-uid");
  });

  test("sends X-Userinfo and X-Auth-Method when identity fields exist", async () => {
    const token = `h.${Buffer.from(JSON.stringify({ sub: "uid-1", enterprise_id: "ent-1" })).toString("base64url")}.s`;
    const jwtContext = {
      credential: {
        account_id: "internal",
        secret: new TextEncoder().encode(token),
        auth_state: { authMethod: "device_code" },
      },
    } as unknown as ProviderDispatchContext;
    const headers = await codebuddyHeaders("CLI", jwtContext, undefined, true);
    expect(headers["X-Auth-Method"]).toBe("device_code");
    expect(headers["X-Userinfo"]).toBeDefined();
    const decoded = JSON.parse(Buffer.from(headers["X-Userinfo"]!, "base64").toString("utf-8"));
    expect(decoded.uin).toBe("uid-1");
    expect(decoded.owner_uin).toBe("ent-1");
    expect(decoded.token_source).toBe("device_code");
  });

  test("omits X-Private-Data unless the dispatch is actually private", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    expect(headers["X-Private-Data"]).toBeUndefined();
    const privateContext = {
      credential: { auth_state: { privateData: true } },
    } as unknown as ProviderDispatchContext;
    const privateHeaders = await codebuddyHeaders("CLI", privateContext, undefined, true);
    expect(privateHeaders["X-Private-Data"]).toBe("true");
  });

  test("forwards X-Agent-Purpose only when one exists", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    // No inbound purpose, no env role: the reference omits the header.
    expect(headers["X-Agent-Purpose"]).toBeUndefined();
    const purposeContext = {
      credential: { auth_state: {} },
      request_headers: { "x-agent-purpose": "person_agent" },
    } as unknown as ProviderDispatchContext;
    const withPurpose = await codebuddyHeaders("CLI", purposeContext, undefined, true);
    expect(withPurpose["X-Agent-Purpose"]).toBe("person_agent");
  });

  test("forwards root/parent conversation ids only when supplied", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    expect(headers["X-Root-Request-ID"]).toBeUndefined();
    expect(headers["X-Parent-Conversation-ID"]).toBeUndefined();
    const ctx = {
      credential: { auth_state: {} },
      request_headers: {
        "x-root-request-id": "root-1",
        "x-parent-conversation-id": "parent-1",
      },
    } as unknown as ProviderDispatchContext;
    const withIds = await codebuddyHeaders("CLI", ctx, undefined, true);
    expect(withIds["X-Root-Request-ID"]).toBe("root-1");
    expect(withIds["X-Parent-Conversation-ID"]).toBe("parent-1");
  });

  test("sends X-IDE-Version on both identities", async () => {
    for (const variant of ["IDE", "CLI"] as const) {
      const headers = await codebuddyHeaders(variant, context);
      expect(headers["X-IDE-Version"]).toBeDefined();
    }
  });

  test("extends the trace family with the CLI's parent span", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    expect(headers["traceparent"]).toBeDefined();
    expect(headers["X-B3-ParentSpanId"]).toBeDefined();
    // The CLI conversation request is a child span, so b3 carries four fields
    // where the desktop product's carries three.
    expect(headers["b3"]?.split("-").length).toBe(4);
  });
});

describe("WorkBuddy CLI identity", () => {
  test("carries the agent envelope, drops browser transport, keeps the markers", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4", true);
    for (const name of AGENT_ENVELOPE) expect(headers[name]).toBeDefined();
    for (const name of BROWSER_HEADERS) expect(headers[name]).toBeUndefined();
    for (const name of REQUEST_MARKERS) expect(headers[name]).toBeDefined();
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["x-codebuddy-request"]).toBe("1");
    expect(headers["x-device-token"]).toBeUndefined();
    expect(headers["accept"]).toBe("application/json");
    // The CLI of chat transport is axios, so the stainless fingerprint is absent.
    for (const name of STAINLESS) expect(headers[name]).toBeUndefined();
  });

  test("presents itself as CLI rather than the desktop product", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4", true);
    expect(headers["x-ide-name"]).toBe("CLI");
    expect(headers["x-ide-type"]).toBe("CLI");
    // The upstream gates chat on the desktop UA brand; the CLI has its own.
    expect(headers["user-agent"]).toMatch(/^CLI\/\S+ CodeBuddy\/\S+$/);
  });

  test("omits the desktop device pair the CLI has no equivalent for", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4", true);
    expect(headers["x-machine-id"]).toBeUndefined();
    expect(headers["x-session-id"]).toBeUndefined();
  });
});

describe("the desktop identity is unchanged", () => {
  test("x-product is the official SaaS value on both realms", async () => {
    // `WorkBuddy` was a value this repo invented; both references send `SaaS`.
    expect((await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4"))["x-product"]).toBe("SaaS");
    expect((await workbuddyHeaders(context, undefined, "www.workbuddy.cn", "5.8.3"))["x-product"]).toBe("SaaS");
  });

  test("an unset flag leaves the desktop headers exactly as they were", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4");
    expect(headers["origin"]).toBe("https://www.workbuddy.ai");
    expect(headers["referer"]).toBe("https://www.workbuddy.ai/");
    expect(headers["accept-language"]).toBe("en-US");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["x-codebuddy-request"]).toBe("1");
    // The desktop client sends either a real device token (bundled Turing SDK)
    // or the failure placeholder — never neither. Intl included.
    expect(headers["x-device-token"] !== undefined || headers["x-device-token-error"] !== undefined).toBe(true);
    expect(headers["x-ide-name"]).toBe("WorkBuddy");
    expect(headers["accept"]).toBe("application/json, text/event-stream");
    // Not one CLI-only header leaks into the default identity.
    for (const name of AGENT_ENVELOPE) expect(headers[name]).toBeUndefined();
    for (const name of STAINLESS) expect(headers[name]).toBeUndefined();
  });

  test("CN desktop sends a device token (SDK) or the captured token", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.cn", "5.7.7.40774747");
    expect(headers["x-device-token"] !== undefined || headers["x-device-token-error"] !== undefined).toBe(true);
  });

  test("desktop with no captured token still presents token or error", async () => {
    const headers = await workbuddyHeaders(anonymous, undefined, "www.workbuddy.ai", "5.8.4");
    expect(headers["x-device-token"] !== undefined || headers["x-device-token-error"] !== undefined).toBe(true);
  });

  test("an account authorized as CLI overrides the desktop default", async () => {
    const cliAccount = {
      credential: { account_id: "a1", auth_state: { cliIdentity: true } },
    } as unknown as ProviderDispatchContext;
    const headers = await workbuddyHeaders(cliAccount, undefined, "www.workbuddy.ai", "5.8.4");
    expect(headers["x-ide-name"]).toBe("CLI");
    expect(headers["x-device-token"]).toBeUndefined();
  });

  test("desktop message ids are dashed UUIDs while CLI message ids stay hex", async () => {
    // The reference emits dashed-UUID message/request ids on the WorkBuddy
    // desktop product and 32-hex on CLI traffic.
    const desktop = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4");
    expect(desktop["x-conversation-message-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(desktop["x-request-id"]).toBe(desktop["x-conversation-message-id"]);
    // The turn aggregation key stays hex even on desktop.
    expect(desktop["x-conversation-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    const cli = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4", true);
    expect(cli["x-conversation-message-id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(cli["x-request-id"]).toBe(cli["x-conversation-message-id"]);
  });
});

/**
 * Chat-wire payload and message normalization shared by the Tencent "buddy"
 * family providers — CodeBuddy International (`cb`), CodeBuddy CN (`cbcn`),
 * and WorkBuddy. All three speak the same upstream contract for this part of
 * the payload, so the rules live here once instead of being copied per
 * variant:
 *
 * - streaming is mandatory (`stream=true`);
 * - `reasoning_summary` is opted in only when a `reasoning_effort` is
 *   requested;
 * - the agent-namespace fields are never forwarded;
 * - caller `system`/`developer` turns are replaced by the variant's fixed
 *   leading system prompt, and bare string user content becomes a typed text
 *   block; and
 * - consecutive same-role `user` turns must be merged before dispatch.
 *
 * Provider-specific identity headers and catalog tables stay in each variant's
 * own `*-shared.ts`.
 */
import { createHash } from "node:crypto";
import { completeRequiredSchema } from "../../../protocol/codecs";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { isRecord } from "../../../protocol/codecs";
import { applyDeepSeekReasoning, applyOpenAIReasoning, backfillDeepSeekReasoningContent, clampedEffortOutputFloor, ensureChatReasoningReplayPresence } from "../../../protocol/reasoning";
import { BUDDY_CN_EFFORTS, BUDDY_INTL_EFFORTS, BUDDY_SHARED_RAW } from "./buddy-catalog-shared";
// Imported for the CN roster only: a CN-only id has no row in the shared
// table, and without one `raiseOutputForRaisedEffort` silently no-ops, so a
// raised effort still answers inside a budget sized for the lower one. It is
// read inside the function below — never at module init — so the cycle with
// cn-provider (which imports this module) resolves before any call.
import { CODEBUDDY_CN_RAW } from "./codebuddy/cn-catalog";
import { buddyAccountUid } from "./buddy-oauth-shared";
import { SYSTEM_PROMPT_WRAPPER_PREFIX, SYSTEM_PROMPT_WRAPPER_SUFFIX } from "../../../console/system-prompt/contracts";
import type { ProviderDispatchContext } from "../../provider-contracts";

const BUDDY_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const INVALID_BUDDY_TOOL_NAME_CHARS = /[^a-zA-Z0-9_-]/g;
const MAX_BUDDY_TOOL_NAME_LENGTH = 64;

function uniqueToolName(base: string, used: Set<string>): string {
  const clipped = (base || "tool").slice(0, MAX_BUDDY_TOOL_NAME_LENGTH);
  if (!used.has(clipped)) return clipped;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${clipped.slice(0, MAX_BUDDY_TOOL_NAME_LENGTH - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
}

function normalizedToolName(value: string, index: number, used: Set<string>): string {
  const base =
    BUDDY_TOOL_NAME_PATTERN.test(value) && value.length <= MAX_BUDDY_TOOL_NAME_LENGTH
      ? value
      : value.replace(INVALID_BUDDY_TOOL_NAME_CHARS, "");
  return uniqueToolName(base || `tool_${index + 1}`, used);
}

/**
 * Buddy's Chat Completions wire has no `web_search_preview` hosted tool; its
 * search is an ordinary function named `web_search` with a `{query}` schema.
 * Rewriting the hosted declaration here lets the caller's own tool loop
 * (Model Lab, or any client that executes its functions) run the query at
 * `POST /v1/search`. The gateway never executes it: an unexecuted call is
 * returned to the caller like any other function call.
 */
function buddyHostedSearchFunction(rawTool: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = rawTool["type"];
  if (type !== "web_search" && type !== "web_search_preview") return undefined;
  return {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}


export function normalizeBuddyToolNames(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload["tools"])) return;
  const used = new Set<string>();
  const replacements = new Map<string, string>();
  payload["tools"] = payload["tools"].map((rawTool, index) => {
    if (!isRecord(rawTool)) return rawTool;
    const hostedSearch = buddyHostedSearchFunction(rawTool);
    if (hostedSearch !== undefined) {
      used.add("web_search");
      return hostedSearch;
    }
    const fn = isRecord(rawTool["function"]) ? rawTool["function"] : undefined;
    const custom = isRecord(rawTool["custom"]) ? rawTool["custom"] : undefined;
    const sourceName = fn?.["name"] ?? custom?.["name"] ?? rawTool["name"];
    if (typeof sourceName !== "string") return rawTool;
    const name = normalizedToolName(sourceName, index, used);
    used.add(name);
    if (!replacements.has(sourceName)) replacements.set(sourceName, name);
    if (fn !== undefined)
      return {
        ...rawTool,
        function: {
          ...fn,
          name,
          ...(fn["parameters"] === undefined ? {} : { parameters: completeRequiredSchema(fn["parameters"]) }),
        },
      };
    if (custom !== undefined)
      return {
        ...rawTool,
        custom: {
          ...custom,
          name,
          ...(custom["format"] === undefined ? {} : { format: completeRequiredSchema(custom["format"]) }),
        },
      };
    return {
      ...rawTool,
      name,
      ...(rawTool["parameters"] === undefined ? {} : { parameters: completeRequiredSchema(rawTool["parameters"]) }),
    };
  });
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message) || !Array.isArray(message["tool_calls"])) continue;
      for (const call of message["tool_calls"]) {
        if (!isRecord(call) || !isRecord(call["function"])) continue;
        const name = call["function"]["name"];
        const replacement = typeof name === "string" ? replacements.get(name) : undefined;
        if (replacement !== undefined) call["function"]["name"] = replacement;
      }
    }
  }
  const choice = payload["tool_choice"];
  if (!isRecord(choice)) return;
  if (choice["type"] === "allowed_tools" && Array.isArray(choice["tools"])) {
    for (const rawAllowed of choice["tools"]) {
      if (!isRecord(rawAllowed)) continue;
      const allowedFn = isRecord(rawAllowed["function"]) ? rawAllowed["function"] : rawAllowed;
      const name = allowedFn["name"];
      const replacement = typeof name === "string" ? replacements.get(name) : undefined;
      if (replacement !== undefined) allowedFn["name"] = replacement;
    }
    return;
  }
  const choiceFn = isRecord(choice["function"]) ? choice["function"] : undefined;
  const choiceCustom = isRecord(choice["custom"]) ? choice["custom"] : undefined;
  const choiceName = choiceFn?.["name"] ?? choiceCustom?.["name"] ?? choice["name"];
  if (typeof choiceName !== "string") return;
  const replacement = replacements.get(choiceName);
  if (replacement === undefined) return;
  if (choiceFn !== undefined) choice["function"] = { ...choiceFn, name: replacement };
  else if (choiceCustom !== undefined) choice["custom"] = { ...choiceCustom, name: replacement };
  else choice["name"] = replacement;
}


/**
 * The upstream id `auto` resolves to, per realm.
 *
 * Both realms have a "let the backend choose" id, and the reference rewrites
 * `auto` onto it before anything downstream keys on the name — so eligibility,
 * cooldowns and the catalog all see one id. CN's is `default`; intl's is
 * `default-model` (confirmed from live CLI session logs, which send
 * `model=default-model` for the intl auto path).
 */
const BUDDY_AUTO_TARGET: Readonly<Record<"intl" | "cn", string>> = {
  intl: "default-model",
  cn: "default",
};

/**
 * Rewrites `auto` onto the realm's backend-selected id.
 *
 * Only a bare, exact `auto` is rewritten (after trimming): a provider-qualified
 * name or anything carrying a prefix is a different request and is left alone.
 */
function resolveBuddyAutoModel(payload: Record<string, unknown>, realm: "intl" | "cn"): void {
  const value = payload["model"];
  if (typeof value !== "string") return;
  if (value.trim().toLowerCase() !== "auto") return;
  payload["model"] = BUDDY_AUTO_TARGET[realm];
}

/**
 * Account-isolated prompt-cache key, `wb2a-<uid8>-<convHex>`.
 *
 * A client-supplied key is kept: the caller already knows which prefix it wants
 * reused. Otherwise the key is derived here, and the uid segment is a hard
 * isolation factor. The same conversation id on two pooled accounts must not
 * produce the same key — upstream prefix-cache reuse across accounts both
 * leaks one account's conversation into another's cache and bills the wrong
 * account for the hit. An empty conversation still hashes the uid alone, so
 * two accounts with no session still never collide.
 *
 * The generic router only forwards a client key. This stays in the buddy hook
 * because the `wb2a-` shape and the uid isolation are a buddy-family fact.
 */
function injectBuddyPromptCacheKey(
  payload: Record<string, unknown>,
  request: CanonicalRequest | undefined,
  context: ProviderDispatchContext | undefined,
): void {
  const existing = payload["prompt_cache_key"];
  if (typeof existing === "string" && existing.trim().length > 0) return;
  const uid = buddyCacheUid(context);
  const conversation = buddyCacheConversation(payload, request, context);
  payload["prompt_cache_key"] = buildBuddyPromptCacheKey(uid, conversation);
}

/**
 * The account uid from the access token, or `""` when the credential carries
 * none. Empty still injects a key — the readable segment becomes `"-"` — which
 * is the reference's own fallback for a credential with no identity.
 */
function buddyCacheUid(context: ProviderDispatchContext | undefined): string {
  const secret = context?.credential?.secret;
  if (secret === undefined || secret.byteLength === 0) return "";
  const token = new TextDecoder().decode(secret).trim();
  if (token.length === 0) return "";
  return buddyAccountUid(token) ?? "";
}

/**
 * Conversation hash source: the body's own id first, then the inbound session
 * the gateway already resolved. A fabricated id is never invented — an empty
 * source hashes the uid alone, so a new session does not reuse another
 * session's prefix while accounts still never collide.
 */
function buddyCacheConversation(
  payload: Record<string, unknown>,
  request: CanonicalRequest | undefined,
  context: ProviderDispatchContext | undefined,
): string {
  for (const field of ["conversation_id", "conversationId"] as const) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const fromRequest = request?.conversation?.conversation_id;
  if (typeof fromRequest === "string" && fromRequest.trim().length > 0) return fromRequest.trim();
  const header = context?.request_headers?.["x-conversation-id"]?.trim();
  return header && header.length > 0 ? header : "";
}

/**
 * `wb2a-<uid8>-<sha256(uid|conversation) hex[:32]>`.
 *
 * `uid8` is the isolation segment a human can read; the hash covers the full
 * uid, so two accounts sharing a prefix still never collide. Stable for the
 * same account and conversation, different for any other pair.
 */
export function buildBuddyPromptCacheKey(uid: string, conversation: string): string {
  const uid8 = uid.length > 8 ? uid.slice(0, 8) : uid.length > 0 ? uid : "-";
  const digest = createHash("sha256").update(`${uid}|${conversation}`).digest("hex").slice(0, 32);
  return `wb2a-${uid8}-${digest}`;
}

/**
 * Rewrites the buddy channel-block code in outbound message text.
 *
 * The upstream blocks any request whose body contains that exact digit run —
 * the check is a verbatim match on the code itself, not a semantic one. A client
 * that quotes the error (a retry, a pasted log, a tool result) is refused on
 * the next turn merely for mentioning it. Inserting a hyphen keeps the number
 * readable and breaks the match.
 *
 * Only text is touched. Image parts and tool-call argument structure are not
 * rewritten, because a digit run inside a base64 blob or a JSON key is not
 * what the check reads and rewriting it would corrupt the payload.
 */
function rewriteBuddyBlockedCode(payload: Record<string, unknown>): void {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    rewriteBlockedCodeField(message, "content");
    rewriteBlockedCodeField(message, "reasoning_content");
    const calls = message["tool_calls"];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!isRecord(call)) continue;
      const fn = call["function"];
      if (isRecord(fn) && typeof fn["arguments"] === "string") {
        fn["arguments"] = fn["arguments"].split("11128").join("11-128");
      }
    }
  }
}

function rewriteBlockedCodeField(message: Record<string, unknown>, field: string): void {
  const value = message[field];
  if (typeof value === "string") {
    if (value.includes("11128")) message[field] = value.split("11128").join("11-128");
    return;
  }
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!isRecord(part)) continue;
    const text = part["text"];
    if (typeof text === "string" && text.includes("11128")) {
      part["text"] = text.split("11128").join("11-128");
    }
  }
}

const BUDDY_ZWSP = "\u200b";

function escapeBuddyRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a matcher that tolerates the zero-width spaces upstream interleaves
 * between characters, so an identity template is still recognized after a
 * normalizer has split it apart.
 */
function buddyTemplateSource(text: string): string {
  const words = text
    .split(" ")
    .map((word) => [...word].map(escapeBuddyRegexLiteral).join(`${BUDDY_ZWSP}*`));
  return words.join(`[\\s${BUDDY_ZWSP}]+`) + `${BUDDY_ZWSP}*`;
}

function buddyTemplatePattern(text: string): RegExp {
  return new RegExp(`(?<!\\w)${buddyTemplateSource(text)}(?!\\w)`, "i");
}

// DeepSeek Harness (DSH) role identities. DSH is the harness behind WorkBuddy;
// a history that still carries its self-description reads to the upstream as a
// foreign channel, so the hardened client rewrites it back to the WorkBuddy
// identity rather than forwarding a competing one.
const DSH_CODING_PATTERN = new RegExp(
  `(?<!\\w)${buddyTemplateSource("You are a coding agent powered by the")}` +
    `[\\s${BUDDY_ZWSP}]+([^\\r\\n]{1,200}?)[\\s${BUDDY_ZWSP}]+` +
    `${buddyTemplateSource("model")}(?!\\w)`,
  "i",
);
const DSH_CHANNEL_IDENTITY_PATTERN = buddyTemplatePattern(
  "You are an AI agent powered by DeepSeek Harness",
);
const DSH_MINIMAL_PATTERN = buddyTemplatePattern("You are a helpful software engineer assistant");
const DSH_DIRECT_PATTERN = buddyTemplatePattern("You are DeepSeek Harness");
const DSH_WEB_GUI_PATTERN = buddyTemplatePattern("DeepSeek Harness Web GUI");

/** The identity DSH role prompts are rewritten to; matches the donor gateway. */
const DSH_WORKBUDDY_IDENTITY = "You are WorkBuddy, a powerful AI assistant";

/**
 * Rewrites DeepSeek Harness role identities in one message's text back to the
 * WorkBuddy identity. Port of the donor gateway's always-on
 * `desensitize_channel_body`, scoped to text the wire actually carries.
 *
 * This normalizes a replayed history (or a surviving system turn) that still
 * claims the DSH harness, so a WorkBuddy request never advertises a competing
 * channel identity upstream. The coding persona keeps the model it named:
 * "You are a coding agent powered by the X model" becomes the WorkBuddy
 * identity plus "powered by the X model".
 */
export function scrubBuddyChannelIdentityText(text: string): string {
  if (!text) return text;
  const withCodingPersona = text.replace(
    DSH_CODING_PATTERN,
    (_match, model: string) =>
      `${DSH_WORKBUDDY_IDENTITY}. This conversation is powered by the ${model.trim()} model`,
  );
  return withCodingPersona
    .replace(DSH_CHANNEL_IDENTITY_PATTERN, DSH_WORKBUDDY_IDENTITY)
    .replace(DSH_MINIMAL_PATTERN, DSH_WORKBUDDY_IDENTITY)
    .replace(DSH_DIRECT_PATTERN, DSH_WORKBUDDY_IDENTITY)
    .replace(DSH_WEB_GUI_PATTERN, "WorkBuddy Web GUI");
}

function scrubBuddyMessageText(message: Record<string, unknown>, field: string): void {
  const value = message[field];
  if (typeof value === "string") {
    const scrubbed = scrubBuddyChannelIdentityText(value);
    if (scrubbed !== value) message[field] = scrubbed;
    return;
  }
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!isRecord(part)) continue;
    const text = part["text"];
    if (typeof text === "string") {
      const scrubbed = scrubBuddyChannelIdentityText(text);
      if (scrubbed !== text) part["text"] = scrubbed;
    }
  }
}

/**
 * Applies the DSH identity scrub across a buddy conversation: every
 * `system`/`developer`/`assistant` turn's text and `reasoning_content` is
 * normalized, so a replayed harness history cannot carry a competing channel
 * identity upstream.
 */
export function scrubBuddyChannelIdentity(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = message["role"];
    if (role !== "system" && role !== "developer" && role !== "assistant") continue;
    scrubBuddyMessageText(message, "content");
    scrubBuddyMessageText(message, "reasoning_content");
  }
}

/**
 * OpenAI-compatible adapters that need the DeepSeek reasoning-replay backfill
 * on outbound chat payloads. The buddy family runs it inside
 * `buddyPrePayloadCommon`; these adapters register here so the same rule
 * reaches every reseller that serves a thinking model.
 */
export const clineReasoningReplayPrepares: readonly ((
  payload: Record<string, unknown>,
) => void)[] = [
  (payload) => {
    backfillDeepSeekReasoningContent(payload);
    ensureChatReasoningReplayPresence(payload);
  },
];

/**
 * The reference injects `cache_retention` on every chat body: `long` by
 * default, `short` when prompt caching for 1h is disabled
 * (`CODEBUDDY_DISABLE_PROMPT_CACHING_1H`). Matching the client keeps the
 * upstream's prompt-caching behavior and price on the same path the CLI uses.
 */
function injectBuddyCacheRetention(payload: Record<string, unknown>): void {
  if (payload["cache_retention"] !== undefined) return;
  const disabled =
    process.env.CODEBUDDY_DISABLE_PROMPT_CACHING_1H?.trim() === "1" ||
    process.env.CODEBUDDY_DISABLE_PROMPT_CACHING_1H?.trim().toLowerCase() === "true";
  payload["cache_retention"] = disabled ? "short" : "long";
}

/**
 * Payload prefix shared by the buddy pre-payload hooks: force `stream=true`,
 * apply the provider's DeepSeek thinking contract, opt `reasoning_summary` in
 * only when an effort is requested, and drop agent-namespace fields.
 */
export function buddyPrePayloadCommon(
  payload: Record<string, unknown>,
  request?: CanonicalRequest,
  realm: "intl" | "cn" = "intl",
  context?: ProviderDispatchContext,
): void {
  injectBuddyPromptCacheKey(payload, request, context);
  injectBuddyCacheRetention(payload);
  // `auto` and `default-model` are the same upstream model under two names, and
  // the reference resolves one to the other everywhere — catalog, eligibility,
  // cooldown keys. Treating them as two independent rows meant a client that
  // sent `auto` got a different (account, model) cooldown key from a client that
  // sent `default-model` for the same backend model, so one could be cooling
  // while the other dialed it.
  //
  // Resolved here rather than in the generic router because it is a buddy-family
  // fact: `auto` is a real model name on other providers.
  resolveBuddyAutoModel(payload, realm);
  // Canonical upstream renames: max_completion_tokens is OpenAI compat alias, buddy only reads max_tokens
  if (payload["max_tokens"] === undefined && payload["max_completion_tokens"] !== undefined) {
    const v = payload["max_completion_tokens"];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) payload["max_tokens"] = v;
    delete payload["max_completion_tokens"];
  } else if (payload["max_completion_tokens"] !== undefined) {
    delete payload["max_completion_tokens"];
  }
  // tool_choice: buddy Go struct is string — object form 400s (code 11101). Normalize to wire string.
  normalizeBuddyToolChoice(payload);
  // image_url string → object (OpenAI allows string, buddy requires {url})
  normalizeBuddyImageUrl(payload);
  // developer role → system (buddy whitelist rejects developer, 11128)
  normalizeBuddyRoles(payload);
  applyOpenAIReasoning(payload, request);
  applyDeepSeekReasoning(payload);
  // sol family defaults to high reasoning like reference thinking.go defaultDeepSeekEffort — sol without effort gets 500/invoke error otherwise
  injectSolReasoningDefault(payload);
  payload["stream"] = true;
  const effort = payload["reasoning_effort"];
  if (effort === "none" || effort === "off") {
    delete payload["reasoning_effort"];
    delete payload["reasoning_summary"];
  } else if (typeof effort === "string" && effort.length > 0) {
    payload["reasoning_summary"] = "auto";
  } else {
    delete payload["reasoning_summary"];
  }
  backfillDeepSeekReasoningContent(payload);
  clampBuddyReasoningEffort(payload, realm);
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    const arr = messages as Array<Record<string, unknown>>;
    // Nameless calls 400 before anything else can be judged, and their results
    // must be orphans before the repack below tries to reorder them.
    dropBuddyEmptyNameToolCalls(arr);
    // Buddy wire: repack tool result blocks before cleanup (image_resize_notice splits tool results → 11148)
    repackBuddyToolResultBlocks(arr);
    cleanupBuddyOrphanToolPairs(arr);
    coalesceConsecutiveAssistantMessages(arr);
    // Normalize a replayed harness history before the blocked-code rewrite
    // below: DSH role identities are replaced with the WorkBuddy identity, so
    // a WorkBuddy-family request never forwards a competing channel identity.
    scrubBuddyChannelIdentity(arr);
    // After every merge: a quoted `11128` in any surviving text blocks the
    // whole request, and the merges above are what produce the final text.
    rewriteBuddyBlockedCode(payload);
  }
  delete payload["agent"];
  delete payload["agent_mode"];
  delete payload["agent_prompt"];
}

function injectSolReasoningDefault(payload: Record<string, unknown>): void {
  const model = typeof payload["model"] === "string" ? (payload["model"] as string) : "";
  const isSol = model.toLowerCase().includes("sol");
  if (!isSol) return;
  if (payload["reasoning_effort"] !== undefined) return;
  const thinking = payload["thinking"] as Record<string, unknown> | undefined;
  if (thinking && typeof thinking["type"] === "string" && (thinking["type"] as string) !== "") return;
  payload["reasoning_effort"] = "high";
}

/**
 * Repack tool result blocks: move non-tool messages interleaved between
 * assistant tool_calls and its tool results to after the block.
 * Port of workbuddy2api repackToolResultBlocks — fixes 11148 tool_call_sequence_broken.
 */
function repackBuddyToolResultBlocks(messages: Array<Record<string, unknown>>): void {
  if (messages.length < 3) return;
  const out: Array<Record<string, unknown>> = [];
  let changed = false;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i] as Record<string, unknown>;
    if (!m || m["role"] !== "assistant" || !Array.isArray(m["tool_calls"]) || (m["tool_calls"] as unknown[]).length === 0) {
      out.push(m);
      i += 1;
      continue;
    }
    const want = new Set<string>();
    for (const tc of m["tool_calls"] as unknown[]) {
      const id = (tc as Record<string, unknown>)?.["id"];
      if (typeof id === "string" && id.length > 0) want.add(id);
    }
    out.push(m);
    i += 1;
    const results: Array<Record<string, unknown>> = [];
    const between: Array<Record<string, unknown>> = [];
    let sawNonTool = false;
    while (i < messages.length) {
      const mm = messages[i] as Record<string, unknown>;
      if (!mm || typeof mm !== "object") break;
      const role = mm["role"];
      if (role === "tool") {
        const id = mm["tool_call_id"];
        if (typeof id !== "string" || !want.has(id)) break;
        results.push(mm);
        if (sawNonTool) changed = true;
        i += 1;
        continue;
      }
      if (results.length === 0) break;
      between.push(mm);
      sawNonTool = true;
      i += 1;
    }
    out.push(...results);
    out.push(...between);
    if (between.length > 0) changed = true;
  }
  if (!changed) return;
  messages.length = 0;
  messages.push(...out);
}

/**
 * Drop assistant tool_calls whose function name is empty.
 *
 * A streamed call can lose its name and land in the client transcript as
 * `function.name: ""` (see `tool-identity.ts`: the client then replays it and
 * every later request is rejected with "`name` must be non-empty"). Buddy
 * reports this as `11133` with `param: ""`, naming no field, so the transcript
 * is the only place it can be caught.
 *
 * The name is only ever absent, never wrong: replaying the same body with the
 * name set to an identifier that is not even in `tools` returns 200, so the
 * upstream rejects the missing value rather than an unknown one. Dropping the
 * call is therefore not lossy — a nameless call cannot be dispatched anyway.
 * The matching tool result becomes an orphan and
 * `cleanupBuddyOrphanToolPairs` removes it in the same pass.
 */
function dropBuddyEmptyNameToolCalls(messages: Array<Record<string, unknown>>): void {
  let changed = false;
  for (const message of messages) {
    if (message["role"] !== "assistant" || !Array.isArray(message["tool_calls"])) continue;
    const calls = message["tool_calls"] as unknown[];
    const kept = calls.filter((call) => {
      if (call === null || typeof call !== "object") return true;
      const fn = (call as Record<string, unknown>)["function"];
      if (fn === null || typeof fn !== "object") return true;
      const name = (fn as Record<string, unknown>)["name"];
      return typeof name === "string" && name.trim().length > 0;
    });
    if (kept.length === calls.length) continue;
    const { tool_calls: _dropped, ...rest } = message as Record<string, unknown> & { tool_calls: unknown };
    if (kept.length === 0) {
      messages[messages.indexOf(message)] = rest;
    } else {
      (message as Record<string, unknown>)["tool_calls"] = kept;
    }
    changed = true;
  }
  if (!changed) return;
  // A message left with neither content nor calls carries nothing upstream.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message["role"] !== "assistant") continue;
    const hasCalls = Array.isArray(message["tool_calls"]) && (message["tool_calls"] as unknown[]).length > 0;
    const content = message["content"];
    const hasContent = (typeof content === "string" && content.trim().length > 0) || Array.isArray(content);
    if (!hasCalls && !hasContent) messages.splice(i, 1);
  }
}

/**
 * Remove orphan tool_calls / tool results that lack a pair — port of
 * workbuddy2api cleanupOrphanToolCalls. Lets a broken history self-heal
 * instead of 400ing every subsequent request.
 */
function cleanupBuddyOrphanToolPairs(messages: Array<Record<string, unknown>>): void {
  const toolResultIds = new Set<string>();
  const toolCallIds = new Set<string>();
  for (const m of messages) {
    if (m["role"] === "tool" && typeof m["tool_call_id"] === "string") toolResultIds.add(m["tool_call_id"] as string);
    if (m["role"] === "assistant" && Array.isArray(m["tool_calls"])) {
      for (const tc of m["tool_calls"] as unknown[]) {
        const id = (tc as Record<string, unknown>)?.["id"];
        if (typeof id === "string") toolCallIds.add(id);
      }
    }
  }
  if (toolResultIds.size === 0 && toolCallIds.size === 0) return;
  const out: Array<Record<string, unknown>> = [];
  let changed = false;
  for (const m of messages) {
    if (m["role"] === "assistant" && Array.isArray(m["tool_calls"])) {
      const kept = (m["tool_calls"] as unknown[]).filter((tc) => {
        const id = (tc as Record<string, unknown>)?.["id"];
        return typeof id === "string" && toolResultIds.has(id);
      });
      if (kept.length === 0 && toolCallIds.size > 0 && (m["tool_calls"] as unknown[]).length > 0) {
        // Drop empty tool_calls key — keep message without it
        const { tool_calls: _drop, ...rest } = m as Record<string, unknown> & { tool_calls: unknown };
        if (Object.keys(kept).length === 0) changed = true;
        out.push(rest as Record<string, unknown>);
        if (kept.length !== (m["tool_calls"] as unknown[]).length) changed = true;
        continue;
      }
      if (kept.length !== (m["tool_calls"] as unknown[]).length) {
        changed = true;
        out.push({ ...m, tool_calls: kept });
        continue;
      }
    }
    if (m["role"] === "tool") {
      const id = m["tool_call_id"];
      if (typeof id === "string" && !toolCallIds.has(id as string)) {
        changed = true;
        continue;
      }
    }
    out.push(m);
  }
  if (!changed) return;
  messages.length = 0;
  messages.push(...out);
}



const BUDDY_EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/**
 * Clamps an effort the model's ladder does not serve to the nearest served
 * level, and clamps a `max_tokens` above the catalog output limit down to it.
 *
 * Both are repaired here rather than refused. A client that asked for `max`
 * on a model that serves only `high` wants an answer, and the gateway is the
 * place that knows the ladder — refusing with 400 makes the client retry a
 * request the gateway could have served. The output budget is lifted when the
 * effort was raised, because a higher level spends part of the same budget on
 * reasoning and a limit sized for the lower one truncates the answer.
 *
 * A model with no ladder is left alone. Absence means the levels have not
 * been measured, and clamping it would invent a constraint.
 */
function clampBuddyReasoningEffort(payload: Record<string, unknown>, realm: "intl" | "cn"): void {
  const model = typeof payload["model"] === "string" ? payload["model"].trim().toLowerCase() : "";
  const table = realm === "cn" ? BUDDY_CN_EFFORTS : BUDDY_INTL_EFFORTS;
  const supported = model.length > 0 ? table[model] : undefined;
  const key =
    "reasoning_effort" in payload
      ? "reasoning_effort"
      : "reasoningEffort" in payload
        ? "reasoningEffort"
        : undefined;
  if (key !== undefined && supported !== undefined) {
    const requested = payload[key];
    if (typeof requested === "string") {
      const normalized = requested.trim().toLowerCase();
      const requestedRank = BUDDY_EFFORT_RANK[normalized];
      if (
        requestedRank !== undefined &&
        !supported.some((effort) => effort.toLowerCase() === normalized)
      ) {
        const ranked = supported
          .map((effort) => ({ effort, rank: BUDDY_EFFORT_RANK[effort.toLowerCase()] }))
          .filter((entry): entry is { effort: string; rank: number } => entry.rank !== undefined);
        const below = ranked.filter((entry) => entry.rank <= requestedRank);
        const chosen =
          below.length > 0
            ? below.reduce((best, entry) => (entry.rank > best.rank ? entry : best))
            : ranked.reduce((best, entry) => (entry.rank < best.rank ? entry : best));
        payload[key] = chosen.effort;
        raiseOutputForRaisedEffort(payload, normalized, chosen.effort.trim().toLowerCase());
      }
    }
  }
  const limit = model.length > 0 ? buddyModelOutputLimit(model) : undefined;
  const maxTokens = payload["max_tokens"];
  if (
    limit !== undefined &&
    typeof maxTokens === "number" &&
    Number.isFinite(maxTokens) &&
    maxTokens > limit
  ) {
    payload["max_tokens"] = limit;
  }
}

/**
 * Lifts `max_tokens` when the ladder raised the caller's effort.
 *
 * A higher level spends part of the same output budget on reasoning, so a
 * limit sized for the lower one can no longer hold the answer. The floor is
 * half the model's catalog output limit, and a budget already above it is
 * left alone.
 */
function raiseOutputForRaisedEffort(
  payload: Record<string, unknown>,
  requested: string,
  applied: string,
): void {
  const model = typeof payload["model"] === "string" ? payload["model"].trim().toLowerCase() : "";
  if (model.length === 0) return;
  const floor = clampedEffortOutputFloor(requested, applied, buddyModelOutputLimit(model));
  if (floor === undefined) return;
  const current = payload["max_tokens"];
  if (typeof current === "number" && Number.isFinite(current) && current >= floor) return;
  payload["max_tokens"] = floor;
}

/**
 * The catalog output limit for one buddy model id, when a catalog names it.
 *
 * Both rosters are searched: CN-only ids (glm-5.1, hy4-preview, the CN
 * DeepSeek rows) exist only in the CN table, and searching the shared one
 * alone left every CN model without a limit.
 */
function buddyModelOutputLimit(model: string): number | undefined {
  const row =
    BUDDY_SHARED_RAW.find((entry) => entry[0]?.toLowerCase() === model) ??
    CODEBUDDY_CN_RAW.find((entry) => entry[0]?.toLowerCase() === model);
  const out = row?.[5];
  return typeof out === "number" && Number.isFinite(out) && out > 0 ? out : undefined;
}

function normalizeBuddyToolChoice(payload: Record<string, unknown>): void {
  if (!("tool_choice" in payload)) return;
  const tc = payload["tool_choice"];
  if (typeof tc === "string") {
    // `none` means "do not call this turn", not "forget the tool schemas".
    // Deleting tools makes DeepSeek emit unparseable DSML text instead.
    if (tc.trim().toLowerCase() === "none") payload["tool_choice"] = "none";
    return;
  }
  if (tc && typeof tc === "object" && !Array.isArray(tc)) {
    const obj = tc as Record<string, unknown>;
    const typ = typeof obj["type"] === "string" ? (obj["type"] as string).trim().toLowerCase() : "";
    if (typ === "none") {
      payload["tool_choice"] = "none";
    } else if (typ === "auto" || typ === "required") {
      payload["tool_choice"] = typ;
    } else if (typ === "function") {
      let name = "";
      const fn = obj["function"];
      if (fn && typeof fn === "object" && !Array.isArray(fn)) name = typeof (fn as Record<string, unknown>)["name"] === "string" ? ((fn as Record<string, unknown>)["name"] as string) : "";
      if (!name && typeof obj["name"] === "string") name = obj["name"] as string;
      name = name.trim();
      payload["tool_choice"] = name.length > 0 ? name : "auto";
    } else {
      delete payload["tool_choice"];
    }
    return;
  }
  delete payload["tool_choice"];
}

/** Images kept in one outbound body. The upstream rejects a larger set. */
const BUDDY_MAX_IMAGES = 16;
const BUDDY_IMAGE_OMITTED = "[Image omitted by request image limit.]";

function normalizeBuddyImageUrl(payload: Record<string, unknown>): void {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  let kept = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = (m as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (let index = 0; index < content.length; index += 1) {
      const part = content[index];
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "image_url") continue;
      const v = p["image_url"];
      if (typeof v === "string") {
        if (v.length === 0) continue;
        p["image_url"] = { url: v };
      }
      kept += 1;
      if (kept > BUDDY_MAX_IMAGES) {
        content[index] = { type: "text", text: BUDDY_IMAGE_OMITTED };
      }
    }
  }
}

function normalizeBuddyRoles(payload: Record<string, unknown>): void {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec["role"] === "developer") rec["role"] = "system";
  }
}

/** Normalizes one message's content into a Chat-wire content-part array. */
function contentParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string")
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === "object",
  );
}

/**
 * Coalesces consecutive `user` messages into one, preserving content-part
 * order. The buddy upstream merges consecutive same-role turns itself and
 * drops `image_url` parts while doing so, so an attachment delivered as its
 * own user turn (the shape VS Code Copilot emits for a pasted screenshot)
 * reaches the model as text only — the image is silently gone even though the
 * gateway forwarded it. Merging here keeps every image in the same message as
 * the text the caller sent alongside it.
 *
 * Lossless: only adjacent same-role `user` turns merge, and every part is
 * retained in order. Assistant/tool/system turns are untouched.
 */
export function coalesceConsecutiveUserMessages(messages: Array<Record<string, unknown>>): void {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (message["role"] !== "user" || previous?.["role"] !== "user") {
      out.push(message);
      continue;
    }
    out[out.length - 1] = {
      ...previous,
      content: [...contentParts(previous["content"]), ...contentParts(message["content"])],
    };
  }
  messages.length = 0;
  messages.push(...out);
}

/**
 * Responses input can split one assistant turn into several adjacent items
 * (text, reasoning, and parallel function calls). Chat wire needs a single
 * assistant message so the reasoning trace accompanies every call in the
 * batch; tool results or user turns always end the batch.
 */
function coalesceConsecutiveAssistantMessages(messages: Array<Record<string, unknown>>): void {
  let write = 0;
  for (const message of messages) {
    const previous = messages[write - 1];
    if (message["role"] !== "assistant" || previous?.["role"] !== "assistant") {
      messages[write++] = message;
      continue;
    }
    const firstContent = previous["content"];
    const nextContent = message["content"];
    let content: unknown = firstContent ?? nextContent;
    if (firstContent != null && nextContent != null) {
      if (typeof firstContent === "string" && typeof nextContent === "string") {
        if (firstContent.length === 0) content = nextContent;
        else if (nextContent.length === 0) content = firstContent;
        else content = `${firstContent}\n${nextContent}`;
      } else content = [...contentParts(firstContent), ...contentParts(nextContent)];
    }
    const firstCalls = previous["tool_calls"];
    const nextCalls = message["tool_calls"];
    const firstReasoning = previous["reasoning_content"];
    const nextReasoning = message["reasoning_content"];
    const merged: Record<string, unknown> = { ...previous, ...message, content };
    if (Array.isArray(firstCalls) || Array.isArray(nextCalls))
      merged["tool_calls"] = [
        ...(Array.isArray(firstCalls) ? firstCalls : []),
        ...(Array.isArray(nextCalls) ? nextCalls : []),
      ];
    if (typeof firstReasoning === "string" && typeof nextReasoning === "string") {
      if (firstReasoning.length === 0) merged["reasoning_content"] = nextReasoning;
      else if (nextReasoning.length === 0) merged["reasoning_content"] = firstReasoning;
      else merged["reasoning_content"] = `${firstReasoning}\n${nextReasoning}`;
    } else if (typeof firstReasoning === "string" || typeof nextReasoning === "string") {
      merged["reasoning_content"] = firstReasoning ?? nextReasoning;
    }
    messages[write - 1] = merged;
  }
  messages.length = write;
}

/**
 * Drops messages whose content is empty, mirroring the buddy upstream's own
 * validation (empty-content turns are rejected with code `11151`). Guarded:
 * anything carrying tool calls, tool results, or reasoning is kept — an
 * assistant `tool_calls` turn with null content and a ledger-folded result
 * text are both load-bearing, not empty.
 */
export function dropEmptyBuddyMessages(messages: Array<Record<string, unknown>>): void {
  const kept = messages.filter((message) => {
    if (!isRecord(message)) return true;
    if (Array.isArray(message["tool_calls"]) && message["tool_calls"].length > 0) return true;
    if (typeof message["tool_call_id"] === "string" && message["tool_call_id"].trim().length > 0)
      return true;
    const content = message["content"];
    if (typeof content === "string") {
      if (content.trim().length > 0) return true;
      // `content === ""` on a bare assistant turn (no tool_calls, no
      // tool_call_id) is unverifiable by the receiving model regardless of
      // what `reasoning_content` carries. The upstream rejects it with
      // code `11151 "history not found"` for both shapes observed in the
      // wild:
      //   (a) `reasoning_content: ""` — the Chat encoder's output for a
      //       canonical `reasoning` part with no `.summary` and a non-string
      //       `.payload` (signature-less thinking block already stripped on
      //       an earlier hop), and
      //   (b) `reasoning_content: "reasoning unavailable"` — the OMP client's
      //       sentinel in a Responses `reasoning` input item of shape
      //       `{summary: [], content: [{type: "reasoning_text",
      //       text: "reasoning unavailable"}]}`, emitted when the client
      //       strips the previous turn's trace on a model switch.
      // Both are unverifiable: the receiving model never issued that
      // signature, so nothing is round-trippable. Verifiable signatures
      // round-trip on `tool_calls` turns (kept by the guard above) via the
      // `reasoning_content` side channel; a signature on a bare turn with
      // no tool_calls is not a shape any upstream in this family accepts.
      return false;
    }
    if (Array.isArray(content)) return content.length > 0;
    // Null content with no tool/reasoning load is a bare turn the upstream
    // rejects — drop it rather than dispatch a known-invalid payload.
    return false;
  });
  if (kept.length === messages.length) return;
  messages.length = 0;
  messages.push(...kept);
}

/**
 * Guarantees the wire opens with a `system` turn. The buddy upstream rejects a
 * first message that is not a system prompt (code `11128`), and a CN-neutralized
 * or caller-less history can otherwise arrive with a bare `user` turn first.
 * Non-empty by construction: an empty system turn trips the sibling `11151`
 * validation above, so the placeholder carries real content.
 */
export function ensureBuddyLeadingSystem(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
): void {
  if (messages.length === 0) {
    messages.push({ role: "system", content: systemPrompt });
    return;
  }
  const first = messages[0];
  if (isRecord(first) && first["role"] === "system") return;
  messages.unshift({ role: "system", content: systemPrompt });
}

/**
 * Runs the full buddy message-envelope tail shared by every variant: merge
 * consecutive user turns, drop empty-content turns the upstream rejects
 * (`11151`), then guarantee a leading system turn (`11128`). The system text
 * is the variant's own prompt, so each pre-payload hook passes its prompt in.
 */
/**
 * Longest message text that gets an automatic ephemeral prompt-cache marker,
 * mirroring the reference gateway (`MIN_AUTO_CACHE_TEXT_LENGTH`).
 */
const MIN_AUTO_CACHE_TEXT_LENGTH = 1024;

/**
 * Marks one message's text content cacheable in place: the system turn and the
 * last user turn are the long, stable ones a prefix cache serves best. A
 * string message becomes a typed text block; a text part inside an array gets
 * `cache_control: {type: "ephemeral"}`. Only the first qualifying text part of
 * a message is marked, like the reference.
 */
function markCacheableTextContent(message: Record<string, unknown>): void {
  const content = message["content"];
  if (typeof content === "string") {
    if (content.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH) {
      message["content"] = [
        { type: "text", text: content, cache_control: { type: "ephemeral" } },
      ];
    }
    return;
  }
  if (!Array.isArray(content)) return;
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (!isRecord(part) || part["type"] !== "text") continue;
    const text = typeof part["text"] === "string" ? part["text"] : "";
    if (text.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH && part["cache_control"] === undefined) {
      content[index] = { ...part, cache_control: { type: "ephemeral" } };
      return;
    }
  }
}

/**
 * Auto-injects ephemeral prompt-cache markers on the system turn and the last
 * user turn when the caller declared none. Mirrors `applyPromptCacheControl` in
 * the reference gateway: an explicit `cache_control` anywhere is respected and
 * disables the auto-pass so the caller's own caching strategy wins.
 */
export function applyBuddyAutoPromptCache(messages: Array<Record<string, unknown>>): void {
  const hasExplicit = messages.some((message) =>
    Array.isArray(message["content"]) &&
    (message["content"] as Array<Record<string, unknown>>).some(
      (part) => isRecord(part) && part["cache_control"] !== undefined,
    ),
  );
  if (hasExplicit) return;
  if (messages.length === 0) return;
  const first = messages[0];
  if (isRecord(first) && first["role"] === "system") markCacheableTextContent(first);
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRecord(messages[index]) && messages[index]!["role"] === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser >= 0) markCacheableTextContent(messages[lastUser]!);
}

/**
 * Strips the `content` key from assistant tool_calls-only turns.
 *
 * Mirrors the reference gateway's OpenAI transcript: an assistant turn that
 * only asks for tools carries `tool_calls` and no content at all (Go's
 * `omitzero`-style SDKs omit the key rather than send `null`/`""`). Keeping
 * an empty string content invites the upstream to fall back to its prose/DSML
 * channel; omitting the key keeps it on the structured `tool_calls` channel.
 */
export function omitBuddyAssistantToolCallContent(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const calls = message["tool_calls"];
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const content = message["content"];
    if (typeof content === "string" && content.trim().length === 0) {
      delete message["content"];
    } else if (Array.isArray(content) && content.length === 0) {
      delete message["content"];
    }
  }
}

/**
 * Forwards the caller's parallel tool-call intent onto the buddy wire.
 *
 * The canonical control is `generation_controls.parallel_tool_calls`; the
 * reference gateway always passes it through so upstream keeps the structured
 * tool channel, and the same is applied here.
 */
export function injectBuddyParallelToolCalls(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
): void {
  const parallel = request.generation_controls?.parallel_tool_calls;
  if (parallel !== undefined) payload["parallel_tool_calls"] = parallel;
}

export interface BuddyMessageFinalizeOptions {
  /** The fixed leading system prompt installed on the wire. */
  readonly leadPrompt: string;
  /** Coalesce consecutive user turns (default true). */
  readonly coalesceConsecutiveUser?: boolean;
  /** Drop empty-content turns the upstream rejects (default true). */
  readonly dropEmpty?: boolean;
  /** Guarantee the wire opens with a system turn (default true). */
  readonly ensureLeadingSystem?: boolean;
  /** Omit content on assistant tool_calls-only turns (default true). */
  readonly omitToolCallContent?: boolean;
  /** Auto-inject ephemeral prompt-cache markers (default true). */
  readonly autoPromptCache?: boolean;
}

/**
 * The single authoritative buddy message-shape pipeline. Every variant runs
 * the same sequence — coalesce, drop empty turns, guarantee the leading system
 * turn, omit content on tool_calls-only assistant turns, then auto-cache — so
 * the wire shape cannot drift between CodeBuddy intl, CN, and WorkBuddy.
 */
export function finalizeBuddyMessages(
  messages: Array<Record<string, unknown>>,
  options: BuddyMessageFinalizeOptions,
): void {
  if (options.coalesceConsecutiveUser !== false) {
    coalesceConsecutiveUserMessages(messages);
  }
  if (options.dropEmpty !== false) {
    dropEmptyBuddyMessages(messages);
  }
  if (options.ensureLeadingSystem !== false) {
    ensureBuddyLeadingSystem(messages, options.leadPrompt);
  }
  if (options.omitToolCallContent !== false) {
    omitBuddyAssistantToolCallContent(messages);
  }
  if (options.autoPromptCache !== false) {
    applyBuddyAutoPromptCache(messages);
  }
}

/**
 * Applies the buddy-family message envelope in place: drop caller
 * `system`/`developer` turns, install the variant's fixed leading system
 * prompt, rebuild bare string user content as a typed text block, then
 * coalesce consecutive user turns.
 *
 * The upstream gateway expects that fixed leading prompt — and validates its
 * text, not merely the presence of a `system` turn. Substituting caller text
 * there answers `400 · 11128 "Illegal API invocation from an unapproved
 * channel"` on CodeBuddy, which reads the prompt as the calling channel's
 * identity; forwarding caller text as a `developer` turn is rejected too. So
 * every variant that has one applies the same transformation — only the prompt
 * text differs, which is why the caller passes it in. Variants without a fixed
 * prompt (CodeBuddy CN replaces caller system text with a neutralizer instead)
 * keep their own path and share only `coalesceConsecutiveUserMessages`.
 *
 * Tool call/output pairing is intentionally NOT handled here: the shared
 * canonical repair (`repairRequestToolCalls`, request/preparer) owns it for
 * every route, so this stays a system-prompt and content-shape hook.
 */
export function applyBuddySystemPrompt(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
  extraSystemText?: string,
): void {
  // Tenant injection (Inject System Prompt) rides AFTER the fixed prompt,
  // inside the same system turn, framed by the gateway's marker prefix/suffix:
  // the upstream validates the identity prompt as the channel opener, so the
  // fixed text must stay first and byte-identical; the wrapped tail carries
  // the tenant's directive without touching the identity. An override-mode
  // tenant prompt degrades to this wrapped append (the caller decides via
  // `isWrappedInjectionProvider` before passing the text).
  const effectivePrompt =
    extraSystemText === undefined || extraSystemText.length === 0
      ? systemPrompt
      : `${systemPrompt}\n\n${SYSTEM_PROMPT_WRAPPER_PREFIX}\n${extraSystemText}\n${SYSTEM_PROMPT_WRAPPER_SUFFIX}`;
  const source = messages.filter(
    (message) => message["role"] !== "system" && message["role"] !== "developer",
  );
  messages.length = 0;
  messages.push({ role: "system", content: effectivePrompt });
  for (const message of source) {
    if (message["role"] === "user" && typeof message["content"] === "string") {
      messages.push({
        ...message,
        content: [{ type: "text", text: message["content"] }],
      });
    } else {
      messages.push({ ...message });
    }
  }
  finalizeBuddyMessages(messages, { leadPrompt: systemPrompt });
}

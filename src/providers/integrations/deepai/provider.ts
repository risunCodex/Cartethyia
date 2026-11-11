// DeepAI provider — TypeScript, DeepAI Code model API, Free Limited.
//
// DeepAI Code's model API (`https://api.deepai.org/deepai_code`) is served
// with a non-Bearer credential: the sign-in flow returns an opaque `api_key`
// that travels in the `Api-Key` header (a Bearer or `x-api-key` spelling is
// rejected with 401 — verified live 2026-11-11). Every model call also needs
// the lane headers (`X-DeepAI-Code-Theos` / `-Instance` / `-Machine`), which
// the adapter stamps per dispatch. The daily free allowance is 50 Theos and
// the 11 zero-Theos models draw nothing from it.
//
// Verified live 2026-11-11 (evidence: `documentation/research/deepai/`):
//   - `GET /deepai_code/models` → 200, 22 rows (unauthenticated).
//   - `POST /deepai_code/chat/completions` → 200 stream + non-stream with
//     lane headers + `Api-Key`.
//   - `POST /deepai_code/responses` → 200 SSE for `gpt-6-astra` only.
//   - `GET /deepai_code/theos` → 200 allowance (balance/granted/refresh).
import type { ApiKeyProviderSpec } from "../../configured-provider";
import {
  DEEPAI_API_ORIGIN,
  DEEPAI_CHAT_PATH,
  DEEPAI_RESPONSES_PATH,
  deepAIBaseHeaders,
} from "./deepai-common";
import type { ProviderDispatchContext } from "../../provider-contracts";

export const DEEPAI_SPEC: ApiKeyProviderSpec = {
  provider_id: "deepai",
  base_url: DEEPAI_API_ORIGIN,
  endpoint_paths_by_wire_family: {
    chat: DEEPAI_CHAT_PATH,
    responses: DEEPAI_RESPONSES_PATH,
  },
  // The credential is not a bearer: sending `Authorization` would be wrong
  // (and the upstream rejects a stray bearer). `buildExtraHeaders` stamps the
  // `Api-Key` + lane headers instead.
  credential_forwarding: "never",
  buildExtraHeaders: async (context: ProviderDispatchContext) => {
    const secret = context.credential.secret;
    const apiKey = secret === undefined || secret.length === 0 ? "" : new TextDecoder().decode(secret);
    return deepAIBaseHeaders(apiKey);
  },
};

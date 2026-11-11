// Free-pi realm constants.
//
// A single deployment with no regional variants: the backend base URL is the
// same for everyone (FREEPI_BASE_URL defaults to https://api.freepi.ai). The
// chat wire is OpenAI-completions (`/v1/chat/completions`), and the credential
// is a JWT issued by the backend (device flow or guest), sent as
// `Authorization: Bearer <jwt>`.

/** Default backend base URL, matching FREEPI_BASE_URL. */
export const FREEPI_BASE_URL = "https://api.freepi.ai";

/** Chat completions path, relative to the base URL (OpenAI-completions). */
export const FREEPI_CHAT_PATH = "/v1/chat/completions";

/** Ad fetch/impression paths, relative to the base URL. */
export const FREEPI_AD_NEXT_PATH = "/ads/next";
export const FREEPI_AD_IMPRESSION_PATH = "/ads/impression";

/** Consent version shipped in 0.6.14. */
export const FREEPI_CONSENT_VERSION = "4";

/** Provider id used by the registry. */
export const FREEPI_PROVIDER_ID = "freepi";

/** Static roster fallback; the live `/client-version` catalog replaces it. */
export const FREEPI_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/** Context window the provider reports for every model (the client hardcodes 200k). */
export const FREEPI_CONTEXT_WINDOW = 200_000;

/** Maximum output tokens the client requests (hardcoded in the bundle). */
export const FREEPI_MAX_OUTPUT_TOKENS = 8192;

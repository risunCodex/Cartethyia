import { memo, useState } from "react";

const failedIcons = new Set<string>();

const iconAssets: Record<string, { file: string; ext: "svg" | "webp" | "png" }> = {
  claude: { file: "claude-code", ext: "svg" },
  anthropic: { file: "anthropics", ext: "webp" },
  openai: { file: "openai-light", ext: "svg" },
  codex: { file: "codex", ext: "webp" },
  opencode: { file: "opencode", ext: "webp" },
  "opencode-zen": { file: "opencode", ext: "webp" },
  "opencode-go": { file: "opencode-go", ext: "webp" },
  "google-antigravity": { file: "antigravity", ext: "svg" },
  antigravity: { file: "antigravity", ext: "svg" },
  blackbox: { file: "blackbox", ext: "svg" },
  blackboxai: { file: "blackbox", ext: "svg" },
  grok: { file: "grok-build", ext: "webp" },
  "grok-build": { file: "grok-build", ext: "webp" },
  xai: { file: "grok-build", ext: "webp" },
  inferhub: { file: "inferhub", ext: "svg" },
  gemini: { file: "gemini", ext: "webp" },
  alibaba: { file: "alibaba", ext: "svg" },
  alibabacp: { file: "alibaba", ext: "svg" },
  // The mainland DashScope host is Alibaba Cloud's own console, so it reuses
  // the Alibaba mark rather than introducing a second one for the same company.
  dashscope: { file: "alibaba", ext: "svg" },
  fireworks: { file: "fireworks", ext: "webp" },
  exa: { file: "exa", ext: "svg" },
  perplexity: { file: "perplexity", ext: "webp" },
  tokenharbor: { file: "tokenharbor", ext: "svg" },
  aihubmix: { file: "aihubmix", ext: "svg" },
  // The Coding Plan is a Z.AI product; the official mark is a dark rounded
  // tile with a white Z (from z.ai). ZCode uses its own official mark, which
  // is the same family: dark tile + white Z.
  zcode: { file: "zcode", ext: "webp" },
  "zcode-start": { file: "zcode", ext: "webp" },
  zai: { file: "zai", ext: "webp" },
  "zai-plan": { file: "zai", ext: "webp" },
  "zai-start": { file: "zai", ext: "webp" },
  "kimi-code": { file: "kimi-code", ext: "webp" },
  kimi: { file: "kimi-code", ext: "webp" },
  github: { file: "github", ext: "webp" },
  copilot: { file: "copilot", ext: "webp" },
  xiaomipg: { file: "mimo", ext: "webp" },
  xiaomitp: { file: "mimo", ext: "webp" },
  mimo: { file: "mimo", ext: "webp" },
  cb: { file: "codebuddy", ext: "webp" },
  cbcn: { file: "codebuddy", ext: "webp" },
  // WorkBuddy variants share the CodeBuddy family brand mark. Without these
  // entries `assetFor` falls through to missing provider-specific assets.
  agentrouter: { file: "agentrouter", ext: "svg" },
  parallel: { file: "parallel", ext: "svg" },
  gmi: { file: "gmi-cloud", ext: "svg" },
  hermes: { file: "hermes", ext: "webp" },
  nous: { file: "nous-research", ext: "svg" },
  inception: { file: "inception", ext: "svg" },
  bai: { file: "bai", ext: "svg" },
  cline: { file: "cline", ext: "webp" },
  cerebras: { file: "cerebras", ext: "webp" },
  qoder: { file: "qoder", ext: "webp" },
  // The China deployment is the same Qoder brand mark; without this entry
  // `qodercn` falls through to the generic placeholder while `qoder` renders
  // the real logo, so the two realms look unrelated in the provider list.
  qodercn: { file: "qoder", ext: "webp" },
  mistral: { file: "mistral", ext: "webp" },
  muse: { file: "muse", ext: "svg" },
  // Meta Model API is the same Meta brand mark as Muse Code.
  meta: { file: "muse", ext: "svg" },
  openrouter: { file: "openrouter", ext: "webp" },
  ollama: { file: "ollama", ext: "webp" },
  ollamacloud: { file: "ollama-cloud", ext: "webp" },
  nvidia: { file: "nvidia", ext: "webp" },
  deepseek: { file: "deepseek", ext: "webp" },
  "deepseek-tui": { file: "deepseek-tui", ext: "webp" },
  droid: { file: "droid", ext: "webp" },
  jcode: { file: "jcode", ext: "webp" },
  kilo: { file: "kilocode", ext: "webp" },
  "kilo-gateway": { file: "kilocode-gateway", ext: "webp" },
  openclaw: { file: "openclaw", ext: "webp" },
  cowork: { file: "claude", ext: "webp" },
  roo: { file: "roo", ext: "webp" },
  continue: { file: "continue", ext: "webp" },
  amp: { file: "amp", ext: "webp" },
  qwen: { file: "qwen", ext: "webp" },
  kiro: { file: "kiro", ext: "webp" },
  kimchi: { file: "kimchi", ext: "webp" },
  commandcode: { file: "commandcode", ext: "webp" },
  cursor: { file: "cursor", ext: "webp" },
  // Devin's official mark is an SVG (dark tile + white rotor); without this
  // entry the fallback would look for `devin.webp`.
  devin: { file: "devin", ext: "svg" },
  // Windsurf is the same Codeium family as Devin but uses its own mark; it is
  // not mapped to Devin's logo. Credentials for Windsurf Enterprise seats store
  // under the `devin` provider, but the icon stays its own brand.
  windsurf: { file: "windsurf", ext: "svg" },
  trae: { file: "trae", ext: "webp" },
  // The China deployment is the same Trae brand mark; without this entry
  // `traecn` falls through to the generic placeholder while `trae` renders the
  // real logo, so the two realms look unrelated in the provider list.
  traecn: { file: "trae", ext: "webp" },
  // Zro's official mark is a black-on-transparent SVG (from the Zro docs
  // site); without this entry the fallback would look for `zro.webp`.
  zro: { file: "zro", ext: "svg" },
  // SenseNova marks are PNGs shared by both realms (CN + Intl); the Intl entry
  // uses the same official mark as its China sibling.
  sensenova: { file: "sensenova", ext: "png" },
  "sensenova-intl": { file: "sensenova-intl", ext: "png" },
  // Clixad has no shipped brand mark in the asset folder; naming it here keeps
  // the lookup deterministic and the fallback renders the "CL" initials.
  clixad: { file: "clixad", ext: "svg" },
};

function assetFor(icon: string): { file: string; ext: "svg" | "webp" | "png" } {
  const normalized = icon.toLowerCase().trim();
  return iconAssets[normalized] ?? { file: normalized, ext: "webp" };
}

function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export const ProviderIcon = memo(function ProviderIcon({
  icon,
  name,
  size = 32,
  imageSize,
  style,
  className,
}: {
  icon: string;
  name: string;
  size?: number;
  imageSize?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [failed, setFailed] = useState(() => failedIcons.has(icon));
  const asset = assetFor(icon);
  const renderedImageSize = imageSize ?? size;
  return (
    <div
      className={className}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "8px",
        background: "var(--surface-2)",
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        overflow: "hidden",
        border: "1px solid var(--inner-border)",
        ...style,
      }}
      role="img"
      aria-label={`${name} provider`}
    >
      {failed ? (
        <span
          style={{
            fontSize: `${Math.max(10, Math.floor(size * 0.35))}px`,
            fontWeight: 700,
            color: "var(--text-secondary)",
          }}
        >
          {initialsOf(name)}
        </span>
      ) : (
        <img
          src={`${import.meta.env.BASE_URL}assets/providers/${asset.file}.${asset.ext}`}
          alt=""
          width={renderedImageSize}
          height={renderedImageSize}
          loading="lazy"
          decoding="async"
          style={{
            width: `${renderedImageSize}px`,
            height: `${renderedImageSize}px`,
            objectFit: "contain",
            padding: asset.ext === "svg" ? "1px" : "2px",
          }}
          onError={() => {
            failedIcons.add(icon);
            setFailed(true);
          }}
        />
      )}
    </div>
  );
});

/**
 * Generates `chat-proto.ts` (embedded proto source) from `vendor/qoder/chat.proto`.
 *
 * The gRPC transport embeds the proto as a TS string so it works from source,
 * dist, and the standalone binary without runtime filesystem dependence. Run
 * after editing `vendor/qoder/chat.proto`:
 *
 *   bun run scripts/scratch/gen-chat-proto.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const protoPath = resolve(root, "vendor/qoder/chat.proto");
const outPath = resolve(root, "src/providers/integrations/qoder/chat-proto.ts");

const proto = readFileSync(protoPath, "utf8");
const escaped = proto.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const ts = `/**
 * Generated from \`vendor/qoder/chat.proto\` (Qoder desktop client v1.1.81,
 * \`qoder-worker-runtime.mjs\`). Do not edit by hand — regenerate from the
 * proto file via \`scripts/scratch/gen-chat-proto.ts\`.
 */
export const CHAT_PROTO_SOURCE = \`${escaped}\`;
`;

writeFileSync(outPath, ts);
console.log(`generated ${outPath} (${escaped.length} chars)`);

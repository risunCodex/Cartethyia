// Generate a 200x200 PNG (red left / blue right) and run a live image dispatch
// through the shipped Devin adapter, capturing the exact request wire.
// Language: JavaScript (Bun), file: scripts/provider-probing/devin/devin-image-probe.mjs
//
// RESULT (2026-11-07, paired live control): Devin does NOT support inline
// images on this account. `swe-1-6-slow` answers "cannot see" identically
// with and without an ImageData payload; `swe-2-flash-medium` rejects with
// invalid_argument. The adapter now DROPS image parts, so this probe's wire
// capture should report `images=0`. Use devin-image-control.mjs to reproduce
// the verdict.
//
// Usage:
//   bun scripts/provider-probing/devin/devin-image-probe.mjs
//   DEVIN_MODEL=swe-1-6-slow bun scripts/.../devin-image-probe.mjs
//   DEVIN_IMAGE_MODE=dataurl|base64|none bun scripts/.../devin-image-probe.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { loginDevinCliHook } from "../../../src/providers/integrations/devin/devin-auth.ts";
import { devinAdapter } from "../../../src/providers/integrations/devin/devin.ts";
import { DEVIN_CHAT_MESSAGE_PATH } from "../../../src/providers/integrations/devin/devin-shared.ts";
import { DevinMessageTypes } from "../../../src/providers/integrations/devin/protocol/devin-proto.ts";
import { arg, redact } from "./_lib.mjs";

// ── Minimal PNG writer (200x200, RGB) ──
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 1 + x * 3 + 1] = g;
      raw[row + 1 + x * 3 + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = makePng(200, 200, (x, y) => {
  if (x < 100) return [220, 30, 40];      // red
  return [30, 60, 220];                   // blue
});
const b64 = png.toString("base64");
const outDir = "D:/tmp/scratch/devin-probe";
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/red-blue-200.png`, png);
console.log(`image: 200x200 PNG red|blue | ${png.length} bytes | base64 ${b64.length} chars`);
console.log(`saved: ${outDir}/red-blue-200.png`);

const cred = process.env.DEVIN_CRED || (await loginDevinCliHook());
const model = arg("model", "swe-2-flash-medium");
const imageMode = arg("image-mode", "dataurl");
const prompt = arg("prompt", "What two colors do you see in this image? Answer with just the color names.");
const maxTokens = Number(arg("max-tokens", "2048"));

// Canonical image part. Cartethyia's `image` payload shape follows the
// OpenAI-style data URL used by the surface adapters.
const imagePart = imageMode === "dataurl"
  ? { kind: "image", payload: { url: `data:image/png;base64,${b64}` } }
  : imageMode === "base64"
    ? { kind: "image", payload: { data: b64, media_type: "image/png" } }
    : { kind: "image", payload: `data:image/png;base64,${b64}` };

const request = {
  model,
  messages: [{ role: "user", content: [{ kind: "text", text: prompt }, imagePart] }],
  generation_controls: { max_tokens: maxTokens },
  stream: true,
  source_surface: "chat",
};

// Wrap fetch to capture the exact request bytes the adapter sends.
let capturedBody = null;
const captureFetch = async (input, init) => {
  const url = String(input);
  if (url.includes("GetChatMessage") && init?.body) {
    capturedBody = Buffer.from(init.body);
  }
  return fetch(input, init);
};

const target = {
  provider_id: "devin",
  model_id: model,
  wire_family: "chat",
  endpoint_path: DEVIN_CHAT_MESSAGE_PATH,
  capabilities: {},
};
const context = {
  credential: { provider_id: "devin", credential_kind: "api_key", secret: new TextEncoder().encode(cred) },
  deadline: Date.now() + 60_000,
  abort_signal: new AbortController().signal,
  outbound_fetch: captureFetch,
};

console.log(`\ncred:   ${redact(cred)}`);
console.log(`model:  ${model}`);
console.log(`mode:   ${imageMode}`);
console.log(`prompt: ${JSON.stringify(prompt)}\n`);

let text = "";
let thinking = "";
const errors = [];
let terminal = null;
let usage = null;
for await (const event of devinAdapter.dispatch(request, target, context)) {
  if (event.type === "content_delta") {
    const p = event.content;
    if (p.kind === "text") text += p.text;
    else if (p.kind === "reasoning" && typeof p.payload === "string") thinking += p.payload;
  } else if (event.type === "usage") usage = event.usage;
  else if (event.type === "terminal") terminal = event;
  else if (event.type === "error") errors.push(event);
}

console.log(`text:     ${JSON.stringify(text.slice(0, 400))}`);
console.log(`thinking: ${thinking.length} chars`);
console.log(`usage:    ${usage ? `in=${usage.input_tokens} out=${usage.output_tokens}` : "none"}`);
console.log(`terminal: ${terminal ? `${terminal.state}/${terminal.stop_reason}` : "MISSING"}`);
console.log(`errors:   ${errors.length ? errors.map((e) => `${e.category}: ${e.message}`).join(" | ") : "none"}`);

// Decode our own captured request to show what actually went on the wire.
if (capturedBody) {
  console.log(`\n=== captured request wire (${capturedBody.length} bytes) ===`);
  const framePayload = capturedBody[0] === 1 ? (await import("node:zlib")).gunzipSync(capturedBody.subarray(5)) : capturedBody.subarray(5);
  try {
    const decoded = DevinMessageTypes.GetChatMessageRequest.decode(framePayload);
    const prompts = decoded.chatMessagePrompts ?? [];
    console.log(`chatMessagePrompts: ${prompts.length}`);
    for (const p of prompts) {
      console.log(`  source=${p.source} prompt=${JSON.stringify(String(p.prompt).slice(0, 80))} images=${p.images?.length ?? 0} toolCalls=${p.toolCalls?.length ?? 0}`);
    }
    console.log(`chatModelUid=${decoded.chatModelUid}`);
  } catch (e) {
    console.log(`decode failed: ${e.message}`);
  }
}

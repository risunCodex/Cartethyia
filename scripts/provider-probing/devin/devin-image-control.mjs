// Paired live control: do Devin's available models actually see inline images?
// Language: JavaScript (Bun), file: scripts/provider-probing/devin/devin-image-control.mjs
//
// Three conditions per model: red|blue PNG, green|yellow PNG, and NO image.
// If the answers are indistinguishable from the no-image control, the image
// is not consumed and the adapter must not send it.
//
// Usage: bun scripts/provider-probing/devin/devin-image-control.mjs

import { deflateSync, gunzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  callDevinUnary,
  DevinMessageTypes,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_GET_USER_JWT_PATH,
  DEVIN_CHAT_MESSAGE_PATH,
  devinCliMetadata,
  encodeFrame,
  ConnectFrameDecoder,
} from "./_lib.mjs";
import { loginDevinCliHook } from "../../../src/providers/integrations/devin/devin-auth.ts";

function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); }
function png(left, right) {
  const w = 200, h = 200;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { const row = y * (1 + w * 3); raw[row] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = x < 100 ? left : right; raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const RED_BLUE = png([220, 30, 40], [30, 60, 220]);
const GREEN_YELLOW = png([20, 190, 60], [245, 225, 30]);
mkdirSync("D:/tmp/scratch/devin-probe", { recursive: true });
writeFileSync("D:/tmp/scratch/devin-probe/control-red-blue.png", RED_BLUE);
writeFileSync("D:/tmp/scratch/devin-probe/control-green-yellow.png", GREEN_YELLOW);

const cred = await loginDevinCliHook();
const jwt = await callDevinUnary(
  DEVIN_GET_USER_JWT_PATH,
  DevinMessageTypes.GetUserJwtRequest,
  DevinMessageTypes.GetUserJwtResponse,
  { metadata: devinCliMetadata(cred) },
  { baseUrl: DEVIN_DEFAULT_BASE_URL, signal: AbortSignal.timeout(20_000) },
);
const PROMPT = "What colors are visible in this image? Reply with ONLY the color names.";

async function run(model, image) {
  const prompts = [{ messageId: crypto.randomUUID(), source: 1, prompt: PROMPT }];
  if (image) prompts[0].images = [{ base64Data: image.toString("base64"), mimeType: "image/png", caption: "color-test.png" }];
  const req = {
    metadata: devinCliMetadata(cred, jwt.userJwt),
    prompt: "",
    chatMessagePrompts: prompts,
    requestType: 5,
    plannerMode: 1,
    systemPromptCacheOptions: { type: 1 },
    configuration: { numCompletions: 1, maxTokens: 4096, maxNewlines: 400, temperature: 1, topK: 40, topP: Math.fround(0.95) },
    cascadeId: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    chatModelUid: model,
  };
  const frame = encodeFrame(Buffer.from(DevinMessageTypes.GetChatMessageRequest.encode(req).finish()), true);
  const res = await fetch(DEVIN_DEFAULT_BASE_URL + DEVIN_CHAT_MESSAGE_PATH, {
    method: "POST",
    headers: { "content-type": "application/connect+proto", "connect-protocol-version": "1", "connect-content-encoding": frame[0] === 1 ? "gzip" : "identity", "accept-encoding": "identity", "connect-accept-encoding": "gzip", "user-agent": "connect-go/1.18.1 (go1.26.3)" },
    body: new Uint8Array(frame),
    signal: AbortSignal.timeout(60_000),
  });
  const dec = new ConnectFrameDecoder();
  let text = "", trailer = "", thinking = 0;
  for (const f of dec.push(Buffer.from(await res.arrayBuffer()))) {
    if (f.flags & 2) { trailer = (f.compressed ? gunzipSync(f.payload) : Buffer.from(f.payload)).toString("utf8"); continue; }
    const p = f.compressed ? gunzipSync(f.payload) : f.payload;
    const m = DevinMessageTypes.GetChatMessageResponse.decode(p);
    if (m.deltaText) text += m.deltaText;
    if (m.deltaThinking) thinking += String(m.deltaThinking).length;
  }
  return { text: text.trim().slice(0, 100), trailer: trailer.slice(0, 90), thinking };
}

const cases = [
  ["swe-1-6-slow", RED_BLUE, "1.6-slow / red|blue"],
  ["swe-1-6-slow", GREEN_YELLOW, "1.6-slow / green|yellow"],
  ["swe-1-6-slow", null, "1.6-slow / NO IMAGE (control)"],
  ["swe-1-6-slow", GREEN_YELLOW, "1.6-slow / green|yellow #2"],
  ["swe-1-6-slow", null, "1.6-slow / NO IMAGE #2"],
  ["swe-2-flash-medium", RED_BLUE, "2-flash / red|blue"],
  ["swe-2-flash-medium", null, "2-flash / NO IMAGE (control)"],
];
console.log("model / condition".padEnd(38), "answer / trailer");
for (const [model, image, label] of cases) {
  const r = await run(model, image);
  console.log(`${label.padEnd(38)} ${JSON.stringify(r.text)} ${r.trailer.includes("error") ? r.trailer : ""}`);
}
console.log("\nverdict: if image conditions match the no-image control, vision is NOT available.");

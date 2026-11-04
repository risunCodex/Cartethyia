# Copilot Wire Audit — reference VS Code 1.144 vs Cartethyia github adapter

Tanggal: 2026-11-03
Referensi: VSCodeUserSetup-x64-1.144.0-unpacked (extension copilot-chat 0.72.0)
Trigger: akun `gpt-6-luna` masuk COOLDOWN auth_invalidated dengan
`unauthorized: not licensed to use Copilot` / `forbidden` berulang.

---

## 1. Ringkasan

Kesimpulan awal: adapter sudah mengirim hampir semua header yang reference kirim,
tapi ada **dua header identitas device yang hilang** (`VScode-SessionId`,
`VScode-MachineId`) dan **satu header organisasi** (`Openai-Organization`) yang
reference kirim pada request chat — plus `X-Interaction-Id` yang nilainya beda.
Belum terbukti mana yang memicu "not licensed" sampai ada cred live untuk test.

## 2. Header request chat — reference vs adapter

Sumber reference: `extensions/copilot/dist/extension.js` (minified).

| Header | Reference (VS Code 1.144) | Adapter (github.ts prepareHeaders + GITHUB_REQUEST_HEADERS) | Bedanya |
| --- | --- | --- | --- |
| `User-Agent` | `GitHubCopilotChat/0.72.0` (fetch wrapper) | `user-agent: GitHubCopilotChat/0.72.0` | ✅ sama |
| `X-VSCode-User-Agent-Library-Version` | `node-http`/`node-fetch`/`electron-fetch` (`sH` = library ID) | `x-vscode-user-agent-library-version: vscode-chat/0.72.0` | ⚠️ **nilai beda** (library vs versi extension) |
| `Editor-Version` | `vscode/1.144.0` | `editor-version: vscode/1.144.0` | ✅ sama |
| `Editor-Plugin-Version` | `copilot-chat/0.72.0` | `editor-plugin-version: copilot-chat/0.72.0` | ✅ sama |
| `Editor-Device-Id` | `this._extensionInfo.deviceId` (UUID persistent) | `editor-device-id: <install-id github>` | ✅ sama nilai |
| `Copilot-Integration-Id` | `vscode-chat` (di-set di `_mixinHeaders`, hanya jika `BFi(type)` true) | `copilot-integration-id: vscode-chat` | ✅ sama (case-insensitive) |
| `X-GitHub-Api-Version` | `2026-08-01` | `x-github-api-version: 2026-08-01` | ✅ sama |
| `VScode-SessionId` | `this._extensionInfo.sessionId` | **tidak ada** | ❌ **hilang** |
| `VScode-MachineId` | `this._extensionInfo.machineId` | **tidak ada** | ❌ **hilang** |
| `OpenAI-Intent` | `conversation-agent` / `conversation` (dari request) | `openai-intent: conversation-agent` | ✅ sama (untuk chat biasa) |
| `X-Request-Id` | UUID (per request) | `x-request-id: requestId` | ✅ sama |
| `X-Interaction-Id` | `interactionService.interactionId` (beda dari request id) | `x-interaction-id: requestId` | ⚠️ **nilai beda** |
| `X-Agent-Task-Id` | UUID = request id | `x-agent-task-id: requestId` | ✅ sama |
| `X-Initiator` | `user` / `agent` | `x-initiator: user/agent` | ✅ sama |
| `X-Interaction-Type` | `conversation-agent` (dari interaction type) | `x-interaction-type: conversation-agent` | ✅ sama |
| `Openai-Organization` | `github-copilot` (di request chat stream) | **tidak ada** | ❌ **hilang** |
| `x-policy-id` | `nil` (di endpoint tertentu) | **tidak ada** | ⚠️ hanya untuk endpoint tertentu |

## 3. Token minting (`/copilot_internal/v2/token`)

Reference (`makeRequest` type `CopilotToken`): hanya `fetch(tokenURL, r)` —
**TANPA `_mixinHeaders`** karena `BFi("CopilotToken")` = false. Jadi token
minting di reference hanya membawa `User-Agent` + `X-VSCode-User-Agent-Library-Version`
dari fetch wrapper, plus `Authorization`.

Adapter (`mintGithubToken`): mengirim `GITHUB_REQUEST_HEADERS` lengkap
(termasuk `copilot-integration-id`, `editor-version`, dll). Ini **lebih banyak**
dari reference tapi bukan penyebab "not licensed" — token minting menerima header
ekstra dengan baik (verifikasi live 200 sebelumnya).

## 4. Discovery (`/models`)

Reference (`Models` ada di `BFi` set): dapat `_mixinHeaders` → `Copilot-Integration-Id`
+ `VScode-SessionId/MachineId` + `Editor-*`.

Adapter (`discoverGithubModels`): mengirim `accept` + `authorization` +
`GITHUB_REQUEST_HEADERS`. **Kurang `VScode-SessionId`/`VScode-MachineId`**
(sama seperti chat). `/models` adalah endpoint yang kemungkinan besar menegakkan
policy/license (di sini "not licensed" bisa muncul), jadi ini kandidat kuat.

## 5. Auto model (gpt-6-luna)

`gpt-6-luna` adalah **Auto model**: dispatch memanggil `POST /auto`
(`#selectAutoModel`) dengan `{ prompt, tier, has_image? }`.

Reference (`Auto` ada di `BFi` set): dapat `_mixinHeaders` penuh.

Adapter (`#selectAutoModel`): memakai `prepareHeaders` → sudah dapat
`GITHUB_REQUEST_HEADERS` + `x-*` + `x-vscode-user-agent-library-version`,
tapi **tetap kurang `VScode-SessionId`/`VScode-MachineId`** dan
`Openai-Organization`.

Karena error "not licensed" muncul pada model `gpt-6-luna`, dan model ini
berarti lewat `POST /auto` dulu, header auto-request adalah tempat paling mungkin
evaluasi license terjadi.

## 6. Kandidat penyebab "not licensed"

1. **`VScode-SessionId` + `VScode-MachineId` hilang** — server mungkin
   menganggap request bukan dari client sah (perlu identitas device untuk
   license check).
2. **`X-VSCode-User-Agent-Library-Version` nilai beda** — reference mengirim
   library ID (`node-http` dll), adapter mengirim `vscode-chat/0.72.0`.
   Nilai ini mungkin dicek server (mengindikasikan client "asli").
3. **`Openai-Organization: github-copilot` hilang** — hanya di request chat
   stream; mungkin tidak wajib.
4. **`X-Interaction-Id` beda** — nilainya harus dari interaction service,
   bukan request id; kecil kemungkinan memicu license check.

## 7. Yang BELUM terbukti

- Header mana yang benar-benar dicek server untuk "not licensed". Perlu probe:
  1. Request dengan header reference **persis** (termasuk `VScode-SessionId`/
     `VScode-MachineId` + `X-VSCode-User-Agent-Library-Version: node-http`)
     → apakah tetap 403?
  2. Request tanpa header itu → apakah berubah?
  3. Bandingkan juga `/auto` vs `/chat/completions` vs `/models`.
- Kredensial live baru diperlukan (akun sekarang cooldown/auth_invalidated).

## 8. Rekomendasi perubahan (menunggu verifikasi live)

A. Tambahkan `VScode-SessionId` dan `VScode-MachineId` ke header chat + auto +
   discovery. Dari mana nilainya?
   - `VScode-MachineId`: bisa = `getOrCreateInstallId("github")` (sudah ada,
     persistent). Percobaan pertama pakai ini.
   - `VScode-SessionId`: belum ada padanan. Opsi: derive dari install id +
     hash credential (per-account), atau `randomUUID()` per proses. Reference
     memakai session per-window VS Code, jadi nilai persisten-account lebih
     mendekati.
B. Ubah `x-vscode-user-agent-library-version` dari `vscode-chat/0.72.0`
   menjadi `node-http` (atau `node-fetch`), menyamakan reference. **Catatan:**
   test `github-request-context.test.ts` saat ini mengekspektasikan
   `vscode-chat/0.72.0`, jadi perubahan ini harus dibarengi update test.
C. Tambahkan `Openai-Organization: github-copilot` di request chat (opsional,
   hanya jika A/B belum cukup).
D. Pertimbangkan `X-Interaction-Id` terpisah dari `X-Request-Id`.

## 9. File terkait

- Adapter: `src/providers/integrations/github/github.ts` (`prepareHeaders`,
  `#selectAutoModel`)
- OAuth: `src/providers/integrations/github/github-oauth.ts`
  (`GITHUB_REQUEST_HEADERS`, `mintGithubToken`)
- Discovery: `src/providers/integrations/github/github-discovery.ts`
- Quota: `src/providers/integrations/github/github-quota.ts`
- Test: `test/providers/github-request-context.test.ts`
- Reference: `D:\tmp\unpacked\vs-code\{code_GetDestDir}\2c33b50b16\resources\app\extensions\copilot\dist\extension.js`

## 10. Hasil probe live (2026-11-03)

Cred: `github-accounts-2026-11-03T12-57-28-223Z.json` — account
`jinhsera-design` (`access_type_sku: free_limited_copilot`, plan `individual`,
`chat_enabled: true`).

Semua varian header → **200** di host `api.individual.githubcopilot.com`:

| Varian | `/auto` (gpt-6-luna) | `/models` | `/chat/completions` |
| --- | --- | --- | --- |
| 0-baseline (adapter lama) | 200 | 200 | 200 |
| 1 +VScode-ids | 200 | 200 | 200 |
| 2 library-ref (node-http) | 200 | 200 | 200 |
| 3 reference-full | 200 | 200 | 200 |
| adapter 1:1 baru (setelah update) | 200 | 200 | 200 |

**Kesimpulan penting:** header **bukan** penyebab "not licensed". Account
`jinhsera-design` **free limited** tetap bisa pakai `gpt-6-luna`
(`restricted_to` mencakup `free`), dan semua permutasi header diterima 200.
Penyebab sesungguhnya di akun lama (`thehertaborneo@gmail.com`) kemungkinan
**entitlement/plan akun** — bukan wire request. Perubahan 1:1 dilakukan tetap
karena diminta dan memperketat identitas client (konsisten dengan reference),
tapi tidak serta-merta menyembuhkan "not licensed" pada akun tanpa entitlement.

## 11. Langkah berikutnya

1. Dapatkan cred live baru (akun sehat).
2. Probe `POST /auto` + `/models` + `/chat/completions` dengan:
   - (a) header adapter sekarang (baseline) → harapkan 403 "not licensed";
   - (b) header reference persis (tambah `VScode-SessionId`/`VScode-MachineId`,
         `Openai-Organization`, ubah library-version) → cek apakah jadi 200;
   - (c) hanya tambah `VScode-*` (tanpa ubah library-version) → isolasi variabel.
3. Terapkan perubahan minimal berdasarkan hasil probe.
4. Update test `github-request-context` bila nilai header berubah.

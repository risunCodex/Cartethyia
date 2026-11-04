/**
 * Dump exact model ids (id + version) from /models for luna/gpt-5+, plus the
 * selected_model shape from /auto. No secrets printed.
 */
import { parseArgs } from "node:util";
import { readAccountsFile, pickAccount } from "../lib/accounts";
import { parseGithubCredential } from "../../../src/providers/integrations/github/github-oauth";

const { values } = parseArgs({ options: { creds: { type: "string" } } });
if (!values.creds) throw new Error("--creds <path>");

const account = pickAccount(readAccountsFile(values.creds), { providerId: "github" });
if (!account.accessToken) throw new Error("no accessToken");
const cred = parseGithubCredential(account.accessToken);
const githubToken = String(account.refreshToken ?? "");

async function get(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text().catch(() => "") };
}

const common = {
  Accept: "application/json",
  Authorization: `Bearer ${githubToken}`,
  "User-Agent": "opencode/0.1.0",
  "X-GitHub-Api-Version": "2025-04-01",
};

{
  const { status, text } = await get(`https://${cred.apiHost}/models`, common);
  console.log(`[/models] HTTP ${status}`);
  if (status === 200) {
    const data = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
    for (const row of data.data ?? []) {
      const id = String(row.id ?? "");
      if (/luna|gpt-5|gpt-6|sol|terra/.test(id)) {
        console.log(`  id=${id}  version=${JSON.stringify(row.version)}  endpoints=${JSON.stringify(row.supported_endpoints)}`);
      }
    }
  } else {
    console.log("  body:", text.replace(/\s+/g, " ").slice(0, 300));
  }
}

// /auto with plain GitHub token, then print selected_model fully.
{
  const autoBody = { prompt: "hi", tier: "efficiency" };
  const res = await fetch(`https://${cred.apiHost}/auto`, {
    method: "POST",
    headers: { ...common, "Content-Type": "application/json" },
    body: JSON.stringify(autoBody),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  console.log(`\n[/auto] HTTP ${res.status}`);
  if (res.ok) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    console.log("  selected_model:", JSON.stringify(parsed.selected_model));
    console.log("  keys:", Object.keys(parsed).join(", "));
    console.log("  multi_turn_mode:", JSON.stringify(parsed.multi_turn_mode));
  } else {
    console.log("  body:", text.replace(/\s+/g, " ").slice(0, 300));
  }
}

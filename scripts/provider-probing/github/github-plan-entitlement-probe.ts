/**
 * Probe: inspect the account's Copilot plan / SKU and whether gpt-6-luna is
 * entitled, from /models and /copilot_internal/user. Prints no secrets.
 */
import { parseArgs } from "node:util";
import { readAccountsFile, pickAccount } from "../lib/accounts";
import { parseGithubCredential, GITHUB_REQUEST_HEADERS } from "../../../src/providers/integrations/github/github-oauth";

const { values } = parseArgs({ options: { creds: { type: "string" } } });
if (!values.creds) throw new Error("--creds <path>");

const account = pickAccount(readAccountsFile(values.creds), { providerId: "github" });
if (!account.accessToken) throw new Error("account has no accessToken");
const cred = parseGithubCredential(account.accessToken);

async function getText(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text().catch(() => "") };
}

const common = { ...GITHUB_REQUEST_HEADERS, authorization: `Bearer ${cred.access}` };

// 1. /models — find the account's SKU field + gpt-6-luna entitlement.
{
  const { status, text } = await getText(`https://${cred.apiHost}/models`, common);
  console.log(`[/models] HTTP ${status}`);
  if (status !== 200) {
    console.log("  body:", text.replace(/\s+/g, " ").slice(0, 300));
  } else {
    const data = JSON.parse(text) as {
      data?: Array<Record<string, unknown>>;
      access_type_sku?: unknown;
      sku?: unknown;
      plan?: unknown;
    };
    console.log("  data.length:", data.data?.length);
    for (const row of data.data ?? []) {
      const id = String(row.id ?? "");
      if (id.includes("gpt-6-luna") || id.includes("luna") || id.includes("gpt-5.6")) {
        console.log("  model:", id);
        const billing = row.billing as Record<string, unknown> | undefined;
        console.log("    restricted_to:", JSON.stringify(billing?.restricted_to));
        const caps = row.capabilities as Record<string, unknown> | undefined;
        console.log("    supports:", JSON.stringify((caps?.supports as Record<string, unknown>) ?? {}).slice(0, 200));
      }
    }
    console.log("  top-level keys:", Object.keys(data).join(", "));
    console.log("  access_type_sku:", JSON.stringify(data.access_type_sku));
    console.log("  sku:", JSON.stringify(data.sku));
    console.log("  plan:", JSON.stringify(data.plan));
  }
}

// 2. /copilot_internal/user — usage + plan.
{
  const { status, text } = await getText(
    `https://api.github.com/copilot_internal/user`,
    { ...common, authorization: `Bearer ${account.refreshToken ?? cred.access}` },
  );
  console.log(`\n[/copilot_internal/user] HTTP ${status}`);
  console.log("  head:", text.replace(/\s+/g, " ").slice(0, 400));
}

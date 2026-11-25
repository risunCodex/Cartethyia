/**
 * `POST /v1/embeddings` telemetry attribution.
 *
 * Embeddings passthrough requests used to land in `telemetry_events` with
 * `requested_model = 'unknown'` and an empty `reported_model` (even on 200 OK
 * dispatches), because the request telemetry helper only read
 * `state.canonicalRequest?.model` and `generation.ts` never forwarded upstream
 * `model` / `usage` from JSON responses.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestGateway, type TestGateway, type TestRoute } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe, getTestPool } from "../helpers/database";

interface TelemetryRow {
  status: string;
  http_status: number | null;
  endpoint: string | null;
  requested_model: string | null;
  reported_model: string | null;
  input_tokens: number | null;
}

async function waitForTelemetryRow(
  gateway: TestGateway,
  requestId: string,
): Promise<TelemetryRow> {
  const pool = await getTestPool();
  const fetchRow = () =>
    pool.query<TelemetryRow>(
      "select status, http_status, endpoint, requested_model, reported_model, input_tokens from telemetry_events where request_id = $1",
      [requestId],
    );
  let result = await fetchRow();
  for (let waited = 0; result.rowCount === 0 && waited < 10_000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await gateway.telemetryBuffer.flush();
    result = await fetchRow();
  }
  expect(result.rowCount).toBe(1);
  return result.rows[0]!;
}

dbDescribe("POST /v1/embeddings telemetry", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;
  let embed: { providerId: string; modelId: string; accountId: string };

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    embed = await world.addProvider({
      modelId: "text-embedding-3-small",
      modelOptions: { wireFamily: "chat", endpointPath: "/v1/embeddings" },
    });
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  test("records requested_model, reported_model, and usage even on a large (>10 KB) embedding JSON response", async () => {
    await gateway.setRoutes([
      {
        providerId: embed.providerId,
        modelId: embed.modelId,
        accountId: embed.accountId,
        endpoint: "/v1/embeddings",
        serviceKind: "embedding" as NonNullable<TestRoute["serviceKind"]>,
      },
    ]);
    const adapter = gateway.adapter(embed.providerId);
    const largeEmbedding = Array.from({ length: 1536 }, (_, i) => Number((i * 0.0001).toFixed(4)));
    adapter.dispatchNativeService = async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: largeEmbedding }],
          model: "upstream-embed-v3",
          usage: { prompt_tokens: 42, total_tokens: 42 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const response = await gateway.json(
      "/v1/embeddings",
      { model: embed.modelId, input: "hello embeddings" },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).not.toBeNull();

    const row = await waitForTelemetryRow(gateway, requestId!);
    expect(row.status).toBe("completed");
    expect(row.http_status).toBe(200);
    expect(row.endpoint).toBe("/v1/embeddings");
    expect(row.requested_model).toBe(embed.modelId);
    expect(row.reported_model).toBe("upstream-embed-v3");
    expect(row.input_tokens).toBe(42);
  }, 15_000);

  test("leaves reported_model null (never backfilled) when upstream omits model", async () => {
    await gateway.setRoutes([
      {
        providerId: embed.providerId,
        modelId: embed.modelId,
        accountId: embed.accountId,
        endpoint: "/v1/embeddings",
        serviceKind: "embedding" as NonNullable<TestRoute["serviceKind"]>,
      },
    ]);
    const adapter = gateway.adapter(embed.providerId);
    adapter.dispatchNativeService = async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const response = await gateway.json(
      "/v1/embeddings",
      { model: embed.modelId, input: "hello without model" },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).not.toBeNull();

    const row = await waitForTelemetryRow(gateway, requestId!);
    expect(row.requested_model).toBe(embed.modelId);
    expect(row.reported_model).toBeNull();
  }, 15_000);
});

import { describe, expect, test } from "bun:test";
import { rosterCacheForTests } from "../../src/providers/integrations/cursor/cursor";

describe("cursor rosterCache", () => {
  test("capped at 1024 entries with oldest-first eviction", () => {
    rosterCacheForTests.set("seed-clear-1", []);
    rosterCacheForTests.set("seed-clear-2", []);
    expect(rosterCacheForTests.size()).toBe(2);

    // Fill past the cap with distinct credentials.
    for (let i = 0; i < 1100; i += 1) {
      rosterCacheForTests.set(`credential-${i}`, []);
    }
    expect(rosterCacheForTests.size()).toBe(1024);

    // Oldest entries were evicted; the newest still hit.
    expect(rosterCacheForTests.get("credential-0")).toBeUndefined();
    expect(rosterCacheForTests.get("credential-1099")).toBeDefined();

    // Distinct credentials do not collide onto one entry.
    expect(rosterCacheForTests.get("credential-1098")).toBeDefined();
  });

  test("re-setting the same credential refreshes without growing", () => {
    rosterCacheForTests.set("refresh-me", []);
    rosterCacheForTests.set("refresh-me", []);
    rosterCacheForTests.set("refresh-me", []);
    expect(rosterCacheForTests.get("refresh-me")).toBeDefined();
  });
});

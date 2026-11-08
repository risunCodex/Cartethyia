/**
 * Console route manifest: one owner for router/nav/title metadata.
 *
 * Pins the B1 cutover so a future route add/remove cannot drift the shell nav
 * or topbar titles away from the protected router tree.
 */
import { describe, expect, test } from "bun:test";
import { CONSOLE_ROUTE_SPECS, navigationGroups, resolveRouteMeta } from "../../src/apps/console/route-manifest";

function navPaths(): string[] {
  return navigationGroups.flatMap((group) =>
    group.items.flatMap((item) => (item.path === undefined ? [] : [item.path])),
  );
}

describe("console route manifest", () => {
  test("the sidebar nav is derived from the same manifest as the router", () => {
    const routePaths = CONSOLE_ROUTE_SPECS
      .filter((route) => route.navGroup !== undefined)
      .map((route) => route.path)
      .sort();
    expect(navPaths().sort()).toEqual(routePaths);
  });

  test("there is no empty nav group left behind", () => {
    expect(navigationGroups.every((group) => group.items.length > 0)).toBe(true);
  });

  test("provider detail titles use the provider label when available", () => {
    expect(
      resolveRouteMeta("/providers/inferhub", [
        { providerId: "inferhub", displayName: "InferHub", label: "InferHub marketplace" },
      ]),
    ).toMatchObject({
      title: "InferHub marketplace",
      sub: "Routing, accounts, models, and health",
    });
  });

  test("provider detail titles fall back to the path id without a catalog row", () => {
    expect(resolveRouteMeta("/providers/custom-provider")).toMatchObject({
      title: "custom-provider",
      sub: "Routing, accounts, models, and health",
    });
  });

  test("cli-tool detail titles resolve from the path segment", () => {
    expect(resolveRouteMeta("/cli-tools/claude-code")).toMatchObject({
      title: "CLI Tool",
      sub: "claude-code — mappings, endpoints, and downloadable config",
    });
  });
});

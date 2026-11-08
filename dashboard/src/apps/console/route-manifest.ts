import {
  Activity,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  Network,
  Palette,
  ScrollText,
  Server,
  Settings as SettingsIcon,
  ShieldAlert,
  Terminal,
  type LucideIcon,
} from "lucide-react";

export type ConsoleRouteKey =
  | "overview"
  | "usage"
  | "providers"
  | "provider-detail"
  | "combos"
  | "quota"
  | "proxy"
  | "console-log"
  | "customization"
  | "model-lab"
  | "cli-tools"
  | "cli-tool-detail"
  | "settings";

export interface ConsoleRouteMeta {
  readonly title: string;
  readonly sub: string;
  readonly icon: LucideIcon;
}

export interface ConsoleRouteSpec extends ConsoleRouteMeta {
  readonly key: ConsoleRouteKey;
  readonly path: string;
  readonly navGroup?: string;
  readonly navLabel?: string;
}

export interface NavItemDef {
  readonly label: string;
  readonly path?: string;
  readonly icon: LucideIcon;
  readonly badge?: string;
  readonly disabled?: boolean;
  readonly children?: readonly NavItemDef[];
}

export interface NavGroupDef {
  readonly label: string;
  readonly items: readonly NavItemDef[];
}

export interface ProviderRouteLabel {
  readonly providerId: string;
  readonly displayName: string;
  readonly label?: string;
}

export const CONSOLE_FALLBACK: ConsoleRouteMeta = {
  title: "Console",
  sub: "Cartethyia AI Gateway Administration",
  icon: LayoutDashboard,
};

export const CONSOLE_ROUTE_SPECS: readonly ConsoleRouteSpec[] = [
  {
    key: "overview",
    path: "/",
    navGroup: "Main",
    navLabel: "Overview",
    title: "Overview",
    sub: "Gateway health, capacity, and live metrics",
    icon: LayoutDashboard,
  },
  {
    key: "usage",
    path: "/usage",
    navGroup: "Main",
    navLabel: "Usage",
    title: "Usage & Metrics",
    sub: "Token economics, requests, and cost breakdown",
    icon: Activity,
  },
  {
    key: "providers",
    path: "/providers",
    navGroup: "Main",
    navLabel: "Providers",
    title: "Provider Catalog",
    sub: "Upstream credentials, models, and latency",
    icon: Server,
  },
  {
    key: "provider-detail",
    path: "/providers/:providerId",
    title: "Provider",
    sub: "Routing, accounts, models, and health",
    icon: Server,
  },
  {
    key: "model-lab",
    path: "/model-lab",
    navGroup: "Main",
    navLabel: "Model Lab",
    title: "Model Lab",
    sub: "Chat a routed model without leaving the console",
    icon: FlaskConical,
  },
  {
    key: "combos",
    path: "/combos",
    navGroup: "Control",
    navLabel: "Combos & Routes",
    title: "Combos & Routing",
    sub: "Failover policies, model aliases, and weighted routes",
    icon: Cpu,
  },
  {
    key: "quota",
    path: "/quota",
    navGroup: "Control",
    navLabel: "Quota Management",
    title: "Quota Management",
    sub: "Rate limits, leases, and tenant quotas",
    icon: ShieldAlert,
  },
  {
    key: "proxy",
    path: "/proxy",
    navGroup: "Control",
    navLabel: "Proxy & Requests",
    title: "Proxy & Requests",
    sub: "Network pools, SOCKS5/HTTP egress, and dispatch",
    icon: Network,
  },
  {
    key: "cli-tools",
    path: "/cli-tools",
    navGroup: "Control",
    navLabel: "CLI Tools",
    title: "CLI Tools",
    sub: "Claude Code CLI, OpenCode, and local developer tool integrations",
    icon: Terminal,
  },
  {
    key: "cli-tool-detail",
    path: "/cli-tools/:toolId",
    title: "CLI Tool",
    sub: "Mappings, endpoints, and downloadable config",
    icon: Terminal,
  },
  {
    key: "customization",
    path: "/customization",
    navGroup: "System",
    navLabel: "Customization",
    title: "Customization",
    sub: "Background, transparency, and blur",
    icon: Palette,
  },
  {
    key: "console-log",
    path: "/console-log",
    navGroup: "System",
    navLabel: "Console Log",
    title: "Console Log",
    sub: "Live server logs and audit trail",
    icon: ScrollText,
  },
  {
    key: "settings",
    path: "/settings",
    navGroup: "System",
    navLabel: "Settings",
    title: "Settings",
    sub: "Account security, runtime preferences, and state recovery",
    icon: SettingsIcon,
  },
];

const STATIC_ROUTE_META = new Map(
  CONSOLE_ROUTE_SPECS.filter((route) => !route.path.includes(":"))
    .map((route) => [route.path, { title: route.title, sub: route.sub, icon: route.icon } satisfies ConsoleRouteMeta]),
);

export const navigationGroups: readonly NavGroupDef[] = Array.from(
  CONSOLE_ROUTE_SPECS.reduce((groups, route) => {
    if (!route.navGroup || !route.navLabel) return groups;
    const items = groups.get(route.navGroup) ?? [];
    items.push({ label: route.navLabel, path: route.path, icon: route.icon });
    groups.set(route.navGroup, items);
    return groups;
  }, new Map<string, NavItemDef[]>()),
  ([label, items]) => ({ label, items }),
);

/**
 * Resolves the topbar title/subtitle for a pathname.
 *
 * The two parameterized routes (`/providers/:providerId`, `/cli-tools/:toolId`)
 * carry their subject in the path, so the static manifest owns the chrome and
 * this helper fills in the path segment when needed.
 */
export function resolveRouteMeta(
  pathname: string,
  providers: readonly ProviderRouteLabel[] = [],
): ConsoleRouteMeta {
  const providerMatch = /^\/providers\/([^/]+)\/?$/.exec(pathname);
  if (providerMatch?.[1]) {
    const providerId = decodeURIComponent(providerMatch[1]);
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    return {
      title: provider?.label || provider?.displayName || providerId,
      sub: "Routing, accounts, models, and health",
      icon: Server,
    };
  }
  const toolMatch = /^\/cli-tools\/([^/]+)\/?$/.exec(pathname);
  if (toolMatch?.[1]) {
    return {
      title: "CLI Tool",
      sub: `${decodeURIComponent(toolMatch[1])} — mappings, endpoints, and downloadable config`,
      icon: Terminal,
    };
  }
  return STATIC_ROUTE_META.get(pathname) ?? CONSOLE_FALLBACK;
}

/**
 * Remote-support tunnel contracts.
 *
 * A tunnel publishes the loopback gateway to a public or tailnet address. This
 * module owns the vocabulary (which tool, which states, what a status reports)
 * and is deliberately free of Elysia and Node imports so the dashboard can
 * import the same shape without dragging a server runtime into the browser
 * bundle.
 */

/** The two supported publishers. Both must already be installed. */
export const REMOTE_SUPPORT_TOOLS = ["cloudflared", "tailscale"] as const;

export type RemoteSupportTool = (typeof REMOTE_SUPPORT_TOOLS)[number];

/**
 * Why a tunnel cannot start. `not_installed` is the common one: this product
 * never installs third-party binaries, so a missing `cloudflared` or
 * `tailscale` is reported for the operator to install, never downloaded.
 */
export type RemoteSupportBlocker =
  | "not_installed"
  | "unsupported_platform"
  | "launch_failed"
  /** The publisher launched but has not published an address yet. */
  | "not_ready";

export interface RemoteSupportStatus {
  /** Which publisher is up, or `null` when neither is. */
  readonly active: RemoteSupportTool | null;
  /** The published base URL, present once the publisher reported one. */
  readonly url: string | null;
  /** Set when a start was refused, with the operator-facing reason. */
  readonly blocker: RemoteSupportBlocker | null;
  /** Operator-facing detail for `blocker`, e.g. the install hint. */
  readonly message: string | null;
  /** Local port the tunnel forwards to. */
  readonly port: number;
  /** Which publishers are installed on this host. Cached so the UI doesn't poll. */
  readonly installed: Readonly<Record<RemoteSupportTool, boolean>>;
}

export interface RemoteSupportStartResponse extends RemoteSupportStatus {
  readonly started: boolean;
}

/** Human-readable install guidance, keyed by tool. Never an installer. */
export function remoteSupportInstallHint(tool: RemoteSupportTool): string {
  // Cross-OS install hint: pick the host's package manager. A Windows-only
  // hint on Linux/macOS would be nonsense (and vice versa).
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const installCommand = (pkg: string): string =>
    win ? `winget install ${pkg}` : mac ? `brew install ${pkg}` : `sudo apt-get install -y ${pkg}`;
  if (tool === "cloudflared") {
    return `cloudflared is not installed. Install it yourself (${installCommand("cloudflared")}) and try again.`;
  }
  return `tailscale is not installed. Install it yourself (${installCommand("tailscale")}), run \`tailscale up\` once, then try again.`;
}

/**
 * Public source and distribution links, in one place.
 *
 * `risunCodex/Cartethyia` is the primary repository and the destination of
 * every public surface — header links, the GitHub badge, and the star/fork
 * counts. The original `risunCode/Cartethyia` was hidden from public view by
 * GitHub after automated star activity was flagged as manipulation; it is kept
 * here as `GITHUB_ALT_REPO` so operators who still have access keep a path to
 * the historical repository, and so a rename cannot drop that link entirely.
 * It is offered as a secondary menu entry, never as the visible default.
 *
 * These were declared twice: one copy in the console shell built them from a
 * repo slug, and the share page's badge component carried its own hardcoded URL
 * plus a second copy of the slug for the shields.io badges. Two literals for
 * one repository means a rename moves one surface and leaves the other pointing
 * at the old project, so every link and every badge resolves from here.
 */

/** The primary repository, publicly reachable. */
export const GITHUB_REPO = "risunCodex/Cartethyia";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

/**
 * The hidden original. Same history, different account, kept as a fallback
 * for anyone who still has access and so a rename does not drop the historical
 * link entirely.
 */
export const GITHUB_ALT_REPO = "risunCode/Cartethyia";
export const GITHUB_ALT_REPO_URL = `https://github.com/${GITHUB_ALT_REPO}`;
export const GITHUB_ALT_RELEASES_URL = `https://github.com/${GITHUB_ALT_REPO}/releases`;

export const GITLAB_REPO_URL = "https://gitlab.com/risuncode/cartethyia";
export const DISCORD_INVITE_URL = "https://discord.gg/zFcNPJM6qM";
export const NPM_PACKAGE = "cartethyia";
export const NPM_PACKAGE_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;

/**
 * The command an operator runs to upgrade a global install.
 *
 * Kept here so the console, the CLI's printed instructions, and the docs cannot
 * disagree about the flag: `-g` is npm's alias for `--global`, and the shorter
 * one is what people copy by hand.
 */
export const NPM_UPDATE_COMMAND = `npm update -g ${NPM_PACKAGE}`;

/** One place a reader can obtain the project. */
export interface SourceLink {
  readonly id: "github-alt" | "github" | "gitlab" | "npm" | "discord";
  readonly label: string;
  readonly href: string;
  /** Shown under the label in the menu; says what the destination is. */
  readonly hint: string;
}

/**
 * The split button's menu, primary destination first.
 *
 * The primary leads: it is the repository the badge counts and the one a
 * reader should land on. The alternative follows as a labelled mirror.
 */
export const SOURCE_LINKS: readonly SourceLink[] = [
  {
    id: "github",
    label: "GitHub",
    href: GITHUB_REPO_URL,
    hint: "Primary repository",
  },
  {
    id: "github-alt",
    label: "GitHub (alt)",
    href: GITHUB_ALT_REPO_URL,
    hint: "Historical mirror — original account",
  },
  {
    id: "gitlab",
    label: "GitLab",
    href: GITLAB_REPO_URL,
    hint: "Source mirror",
  },
  {
    id: "npm",
    label: "npm",
    href: NPM_PACKAGE_URL,
    hint: `Package — ${NPM_PACKAGE}`,
  },
  {
    id: "discord",
    label: "Discord",
    href: DISCORD_INVITE_URL,
    hint: "Community — questions, setups, and bug reports",
  },
];

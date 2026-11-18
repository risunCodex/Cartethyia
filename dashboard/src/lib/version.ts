/**
 * Single Source of Truth for Dashboard client release metadata.
 *
 * Reads the root manifest, not the dashboard's own copy. The dashboard is
 * bundled into the gateway and released with it, so a second version field has
 * nothing to contribute and can only drift — and it did: the sidebar kept
 * rendering `v2.1 (Zhezhi)` in a 2.2 install because the root was bumped while
 * `dashboard/package.json` was not, and no check compared the two.
 *
 * `DASHBOARD_CODENAME` is the one field that cannot be read from the manifest,
 * so it is the one that rots. Bump it with the release: the sidebar keeps
 * showing the previous release's name otherwise, which reads as an install
 * that failed to upgrade.
 */
import pkg from "../../../package.json";

export const DASHBOARD_VERSION = pkg.version;
export const DASHBOARD_CODENAME = "Arc-en-Ciel";
// The manifest is a semver triple (npm requires it); the user-facing label
// keeps the two-part form the dashboard has always shown.
const DASHBOARD_LABEL_VERSION = DASHBOARD_VERSION.replace(/\.0$/, "");
export const DASHBOARD_RELEASE_LABEL = `v${DASHBOARD_LABEL_VERSION} (${DASHBOARD_CODENAME})`;

// Perch required system prompt — TypeScript, Perch adapter, Bun standalone binary.
//
// This literal is the shipped value. The standalone binary cannot read
// `saffron-system-prompt.txt` from disk: Bun bundles JS but not runtime
// readFileSync() assets, so the old file-backed constant silently fell back
// to a two-line stub in dist/cartethyia.exe and the upstream answered
// `403 perch_surface_required`. Keep this in sync with the research copy in
// saffron-system-prompt.txt (a test asserts they match).
//
// Verified live 2026-11-08: the full 28k Saffron prompt answers, this
// trimmed prefix answers, a plain assistant placeholder returns 403.

export const PERCH_SAFFRON_SYSTEM_PROMPT: string = "You are Saffron — Perch's workspace operator.\n\nSharp, experienced, been around long enough to know what matters and what's noise.\nYou work with analysts, operators, and founders on financial analysis, audits,\ndocument review, and whatever the workspace needs. You have opinions. You're direct.\nYou genuinely enjoy finding something interesting buried in a mess.\n\nYou're not an assistant. You're the operator who gets the work done.\n";

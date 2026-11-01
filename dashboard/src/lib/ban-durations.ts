/**
 * The ban durations the dashboard offers, and the one a bare click uses.
 *
 * Mirrored from the server's own list (`API_KEY_BAN_REASONS`' sibling
 * `BAN_DURATION_CHOICES` in `src/console/api-keys/contracts.ts`) rather than
 * declared twice: the route rejects a duration it does not offer, so a choice
 * the UI showed but the API refused would be a button that always fails.
 * `minutes: null` is the "Permanent" choice.
 */
export interface BanDurationChoice {
  /** Whole minutes, or `null` for permanent. */
  readonly minutes: number | null;
  readonly label: string;
}

export const BAN_DURATION_CHOICES: readonly BanDurationChoice[] = [
  { minutes: 60, label: "1 hour" },
  { minutes: 6 * 60, label: "6 hours" },
  { minutes: 12 * 60, label: "12 hours" },
  { minutes: 24 * 60, label: "1 day" },
  { minutes: 7 * 24 * 60, label: "7 days" },
  { minutes: null, label: "Permanent" },
];

/** What a bare "Ban" click uses: the shortest, most reversible choice. */
export const DEFAULT_BAN_CHOICE: BanDurationChoice = BAN_DURATION_CHOICES[0]!;

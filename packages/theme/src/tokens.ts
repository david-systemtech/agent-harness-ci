/** The two ladders every theme derives: a client paints one, by its own light or dark preference. */
export const LADDERS = ["light", "dark"] as const;
export type LadderName = (typeof LADDERS)[number];

/**
 * Every token a ladder holds, by the names the surfaces port audit records.
 * Four surfaces, a float for overlays, a black scrim for overlays and
 * shadows, the hairline and the edge owed 3:1 (`line-strong`), three inks; the accent as a fill (`beam`), its
 * pressed depth, the ink on it and its text companion; the machine,
 * thinking and three status colours (`cyan`, `sage`, `mint`, `amber`,
 * `signal`) with the inks on the two status fills; and five washes, the ink
 * or the accent at an alpha.
 */
export const TOKEN_NAMES = [
  "abyss",
  "inset",
  "panel",
  "raised",
  "float",
  "scrim",
  "line",
  "line-strong",
  "ink",
  "ink-muted",
  "ink-faint",
  "beam",
  "beam-dim",
  "beam-ink",
  "beam-text",
  "cyan",
  "sage",
  "mint",
  "amber",
  "amber-ink",
  "signal",
  "signal-ink",
  "hairline",
  "hairline-strong",
  "wash",
  "wash-strong",
  "wash-user",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

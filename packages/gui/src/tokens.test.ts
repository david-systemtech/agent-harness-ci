// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENT_COLOURS } from "@agent-harness/contracts";
import { TOKEN_NAMES } from "@agent-harness/theme";
import { describe, expect, it } from "vitest";

/**
 * Tailwind's inline theme (ADR 0023): the stylesheet names every token the
 * theme package derives to Tailwind as a colour reading the root's CSS
 * variable, and nothing else, with Tailwind's own palette reset away.
 */
const stylesheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

/** Each declaration of the stylesheet's `@theme inline` block, as written. */
const inlineTheme = (): string[] => {
  const block = /@theme inline \{([^}]*)\}/.exec(stylesheet)?.[1];
  if (block === undefined) throw new Error("styles.css has no @theme inline block.");
  return block
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== "");
};

describe("the tokens stylesheet", () => {
  it("maps every token and every environment colour's token onto the root's variable of the same name, and resets Tailwind's palette", () => {
    const names = [...TOKEN_NAMES, ...ENVIRONMENT_COLOURS.map((colour) => `environment-${colour}`)];
    expect(inlineTheme()).toEqual(["--color-*: initial", ...names.map((name) => `--color-${name}: var(--${name})`)]);
  });

  it("builds on Tailwind", () => {
    expect(stylesheet.startsWith('@import "tailwindcss";')).toBe(true);
  });
});

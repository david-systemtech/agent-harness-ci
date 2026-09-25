import { ACTIONS, isCommandId } from "@agent-harness/contracts";
import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { eventName, type InkKey } from "./keys.js";

/**
 * Every default key of the shared list that is one press, from the bytes a
 * terminal sends for it, through Ink 7.1.1's own parser, to the name the
 * keymap holds it by: a default Ink cannot be heard as is a dead key. Keys
 * pressed in turn (`Esc Esc`, `\ Enter`) and the classes (`;;`, `1–4`,
 * `Letters`) are read by the components that answer them, not here.
 * `Shift+Enter` and `Ctrl+Enter` are the kitty keyboard protocol's bytes: a
 * terminal without it sends a bare carriage return for both, as it did for
 * Artemis.
 */
const BYTES: Readonly<Record<string, string>> = {
  Tab: "\t",
  "Shift+Tab": "\u001B[Z",
  Esc: "\u001B",
  Enter: "\r",
  "Shift+Enter": "\u001B[13;2u",
  "Ctrl+Enter": "\u001B[13;5u",
  Backspace: "\u007F",
  Space: " ",
  "↑": "\u001B[A",
  "↓": "\u001B[B",
  "→": "\u001B[C",
  "←": "\u001B[D",
  "Shift+↑": "\u001B[1;2A",
  "Shift+↓": "\u001B[1;2B",
  "Ctrl+↑": "\u001B[1;5A",
  "Ctrl+↓": "\u001B[1;5B",
  "Ctrl+←": "\u001B[1;5D",
  "Ctrl+→": "\u001B[1;5C",
  PgUp: "\u001B[5~",
  PgDn: "\u001B[6~",
  Home: "\u001B[H",
  End: "\u001B[F",
  "Ctrl+Home": "\u001B[1;5H",
  "Ctrl+End": "\u001B[1;5F",
  "Ctrl+A": "\u0001",
  "Ctrl+C": "\u0003",
  "Ctrl+D": "\u0004",
  "Ctrl+E": "\u0005",
  "Ctrl+G": "\u0007",
  "Ctrl+J": "\n",
  "Ctrl+K": "\u000B",
  "Ctrl+O": "\u000F",
  "Ctrl+P": "\u0010",
  "Ctrl+R": "\u0012",
  "Ctrl+S": "\u0013",
  "Ctrl+T": "\u0014",
  "Ctrl+U": "\u0015",
  "Ctrl+V": "\u0016",
  "Ctrl+W": "\u0017",
  "Ctrl+Y": "\u0019",
  "Ctrl+\\": "\u001C",
  "Ctrl+]": "\u001D",
  "Ctrl+_": "\u001F",
  "Alt+B": "\u001Bb",
  "Alt+D": "\u001Bd",
  "Alt+F": "\u001Bf",
  "Alt+H": "\u001Bh",
};

const CLASSES = new Set([";;", "1–4", "Letters"]);
const singlePresses = [...new Set(ACTIONS.filter((a) => !isCommandId(a.id)).flatMap((a) => a.keys))].filter((k) => !CLASSES.has(k) && !k.includes(" "));
/** A printable character's bytes are itself. */
const bytesOf = (name: string): string | undefined => BYTES[name] ?? ([...name].length === 1 ? name : undefined);

/** What `eventName` makes of each of `writes`, heard through Ink's `useInput` in the test renderer. */
const hear = async (writes: readonly string[]): Promise<(string | undefined)[]> => {
  const heard: (string | undefined)[] = [];
  const Probe = () => {
    useInput((input, key) => void heard.push(eventName(input, key as InkKey)));
    return createElement(Text, null, "keys");
  };
  const app = render(createElement(Probe));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const names: (string | undefined)[] = [];
  for (const bytes of writes) {
    const before = heard.length;
    app.stdin.write(bytes);
    // Ink waits 20 ms before it takes a lone Esc as the key rather than the start of a sequence.
    await new Promise((resolve) => setTimeout(resolve, bytes === "\u001B" ? 40 : 5));
    names.push(heard.length === before + 1 ? heard[before] : `heard ${String(heard.length - before)} keys`);
  }
  app.unmount();
  return names;
};

describe("every default key that is one press", () => {
  it("has the bytes a terminal sends for it", () => {
    expect(singlePresses.length).toBeGreaterThan(60);
    expect(singlePresses.filter((name) => bytesOf(name) === undefined)).toEqual([]);
  });

  it("is heard by that name through Ink's own key parser", async () => {
    const heard = await hear(singlePresses.map((name) => bytesOf(name) ?? ""));
    const wrong = singlePresses.flatMap((name, i) => (heard[i] === name ? [] : [`${name} heard as ${String(heard[i])}`]));
    expect(wrong).toEqual([]);
  });
});

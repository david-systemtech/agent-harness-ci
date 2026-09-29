/**
 * The terminal UI's memory of what `@` picked: worth more the oftener and the
 * later, and kept in its state directory. The ranking it adds to is the
 * client runtime's, and tested there.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fuzzyMatch } from "@agent-harness/client-runtime";
import { afterAll, describe, expect, it } from "vitest";

import { Frecency, MENTIONS_FILE } from "./mentions.js";

const temporaries: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-mentions-"));
  temporaries.push(directory);
  return directory;
};
afterAll(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("Frecency", () => {
  it("is worth nothing for a path never picked", () => {
    expect(new Frecency().boost("never.ts", NOW)).toBe(0);
  });

  it("puts what was picked first in the ranking when nothing has been typed", () => {
    const frecency = new Frecency();
    frecency.record("packages/core/src/index.ts");

    const results = fuzzyMatch("", ["docs/composer.md", "apps/tui/src/app.tsx", "packages/core/src/index.ts"], { frecency });

    expect(results.map((match) => match.path)).toEqual(["packages/core/src/index.ts", "apps/tui/src/app.tsx", "docs/composer.md"]);
  });

  it("rises with picks and decays with age", () => {
    const frecency = new Frecency();
    frecency.record("often.ts", NOW - DAY);
    frecency.record("often.ts", NOW);
    frecency.record("once.ts", NOW);
    frecency.record("stale.ts", NOW - 60 * DAY);

    expect(frecency.boost("often.ts", NOW)).toBeGreaterThan(frecency.boost("once.ts", NOW));
    expect(frecency.boost("once.ts", NOW)).toBeGreaterThan(frecency.boost("stale.ts", NOW));
    // A boost nudges the ranking; it can never carry an irrelevant file to the
    // top of a real match.
    expect(frecency.boost("often.ts", NOW)).toBeLessThanOrEqual(48);
    expect(frecency.boost("stale.ts", NOW)).toBeGreaterThan(0);
  });

  it("round-trips through its JSON file", async () => {
    const directory = await temporaryDirectory();
    // Nested, so that saving has to create the directory the way a first run does.
    const path = join(directory, "nested", MENTIONS_FILE);
    const memory = await Frecency.load(path);
    memory.record("a.ts", NOW);
    memory.record("a.ts", NOW);
    memory.record("b.ts", NOW - DAY);
    await memory.save();

    const reopened = await Frecency.load(path);

    expect(reopened.boost("a.ts", NOW)).toBeCloseTo(memory.boost("a.ts", NOW));
    expect(reopened.boost("b.ts", NOW)).toBeCloseTo(memory.boost("b.ts", NOW));
    expect(reopened.boost("a.ts", NOW)).toBeGreaterThan(reopened.boost("b.ts", NOW));
    const written = JSON.parse(await readFile(path, "utf8")) as { version: number };
    expect(written.version).toBe(1);

    // And saves back to the file it was loaded from, a pick later.
    reopened.record("c.ts", NOW);
    await reopened.save();
    expect((await Frecency.load(path)).boost("c.ts", NOW)).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("writes its file and directory for their owner alone", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested", MENTIONS_FILE);
    const memory = new Frecency(path);
    memory.record("a.ts", NOW);
    await memory.save();

    expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("remembers nothing when the file is missing, unreadable or nonsense", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "nonsense.json"), "not json at all");
    await writeFile(join(directory, "wrong.json"), JSON.stringify({ version: 99, entries: { "a.ts": { at: NOW, count: 3 } } }));

    const missing = await Frecency.load(join(directory, "gone.json"));
    const nonsense = await Frecency.load(join(directory, "nonsense.json"));
    const wrong = await Frecency.load(join(directory, "wrong.json"));

    expect(missing.boost("a.ts", NOW)).toBe(0);
    expect(nonsense.boost("a.ts", NOW)).toBe(0);
    expect(wrong.boost("a.ts", NOW)).toBe(0);
    // Nowhere to save to is not an error either.
    await expect(new Frecency().save()).resolves.toBeUndefined();
  });

  it("names the file the caller joins to the state directory", () => {
    expect(MENTIONS_FILE).toBe("mentions.json");
  });
});

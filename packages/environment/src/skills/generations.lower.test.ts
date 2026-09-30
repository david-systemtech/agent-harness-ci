import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_PLUGIN_NAME } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { GENERATIONS_DIRECTORY, GENERATION_SWEEP_INTERVAL_MS, createGenerations, type GenerationsOptions, type PlacedMember } from "./generations.js";

/**
 * The materialiser at its own seam, against a temporary data directory
 * (skills spec, "Testing Decisions", the one lower seam): what the wire
 * cannot show. A generation's entries are links rather than copies; a
 * generation a live process holds is kept; and a sweep's outcome is only
 * knowable once it has finished, which the environment's hourly timer does
 * not say. The environment's suite drives the same materialiser through
 * runs (`materialisation.test.ts`).
 */

/** Whether the next file symlink is refused as Windows refuses one without the privilege; the rest go through. */
const refusals = vi.hoisted(() => ({ fileSymlinks: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: (target: string, path: string, type?: string) =>
      refusals.fileSymlinks && type === "file"
        ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`), { code: "EPERM" }))
        : actual.symlink(target, path, type),
  };
});

const { tempDir, onCleanup } = useCleanups();

/** Writes `text` at `path`, making its folders. */
const write = (path: string, text: string): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
};

/** A data directory with an own directory holding `tdd` (a skill folder with a script) and `review.md` (a command file). */
const fixture = (options: Partial<GenerationsOptions> = {}) => {
  const dataDir = tempDir();
  const own = join(dataDir, "skills", "own");
  write(join(own, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test-driven development.\n---\nRed, then green.\n");
  write(join(own, "skills", "tdd", "scripts", "run.sh"), "#!/bin/sh\necho red\n");
  write(join(own, "commands", "review.md"), "---\ndescription: Review the branch.\n---\nReview it.\n");
  const clock = options.clock ?? manualClock();
  const generations = createGenerations({ dataDir, clock, ...options });
  const tdd: PlacedMember = {
    name: "tdd",
    kind: "skill",
    target: join(own, "skills", "tdd"),
    origin: null,
    commit: null,
    invocation: "model+slash",
    native: false,
  };
  const review: PlacedMember = { ...tdd, name: "review", kind: "command", target: join(own, "commands", "review.md") };
  return { dataDir, own, clock, generations, tdd, review, root: join(dataDir, GENERATIONS_DIRECTORY) };
};

/** A native member: a trusted repository's `.claude/skills` member, which the adapter loads itself. */
const native = (name: string): PlacedMember => ({
  name,
  kind: "skill",
  target: `/work/repo/.claude/skills/${name}`,
  origin: { kind: "repository", repository: "github.com/david/repo", path: `.claude/skills/${name}` },
  commit: null,
  invocation: "model+slash",
  native: true,
});

/** The generations under the root, by name. */
const listed = (root: string): string[] => (existsSync(root) ? readdirSync(root).sort() : []);

describe("a generation", () => {
  it("is a plugin named agent-harness whose skills/<name> is a symbolic link to each member's folder, never a copy, so an edit there reads through it", async () => {
    const { generations, tdd, root } = fixture();
    const { fingerprint, generation } = await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "scope");
    expect(generation).toBe(join(root, fingerprint));
    expect(JSON.parse(readFileSync(join(generation as string, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: SKILL_PLUGIN_NAME });
    const entry = join(generation as string, "skills", "tdd");
    expect(lstatSync(entry).isSymbolicLink()).toBe(true);
    expect(readlinkSync(entry)).toBe(tdd.target);
    expect(readdirSync(join(generation as string, "skills"))).toEqual(["tdd"]);
    writeFileSync(join(tdd.target, "SKILL.md"), "---\nname: tdd\ndescription: Test-driven development.\n---\nRed, green, refactor.\n");
    expect(readFileSync(join(entry, "SKILL.md"), "utf8")).toContain("Red, green, refactor.");
    expect(readFileSync(join(entry, "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho red\n");
  });

  it("holds a command member as a skill folder whose SKILL.md is a link to the command file, since the CLI skips a linked command file", async () => {
    const { generations, review } = fixture();
    const { generation } = await generations.materialise({ members: [review], hiddenNativeNames: [] }, "scope");
    const folder = join(generation as string, "skills", "review");
    expect(lstatSync(folder).isDirectory()).toBe(true);
    expect(readdirSync(folder)).toEqual(["SKILL.md"]);
    expect(lstatSync(join(folder, "SKILL.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(folder, "SKILL.md"))).toBe(review.target);
    expect(existsSync(join(generation as string, "commands"))).toBe(false);
  });

  it("leaves native members out, and is none when nothing is left to link, while the fingerprint still covers them", async () => {
    const { generations, tdd } = fixture();
    const mixed = await generations.materialise({ members: [tdd, native("release")], hiddenNativeNames: [] }, "scope");
    expect(readdirSync(join(mixed.generation as string, "skills"))).toEqual(["tdd"]);
    const nativeOnly = await generations.materialise({ members: [native("release")], hiddenNativeNames: ["triage"] }, "scope");
    expect(nativeOnly.generation).toBeNull();
    expect(nativeOnly.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    const empty = await generations.materialise({ members: [], hiddenNativeNames: [] }, "scope");
    expect(empty.generation).toBeNull();
    expect(new Set([mixed.fingerprint, nativeOnly.fingerprint, empty.fingerprint]).size).toBe(3);
  });

  it("is reused for an unchanged fingerprint, whatever order the members come in, and another is made for a changed one", async () => {
    const { generations, tdd, review, root } = fixture();
    const first = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    const again = await generations.materialise({ members: [review, tdd], hiddenNativeNames: [] }, "another scope");
    expect(again).toEqual(first);
    expect(listed(root)).toEqual([first.fingerprint]);
    const changed = await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "scope");
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(listed(root)).toEqual([first.fingerprint, changed.fingerprint].sort());
  });
});

describe("the fingerprint", () => {
  it("is the same for identical state, and changes with each name, folder, origin, snapshot commit, native flag and hidden native name", async () => {
    const { generations, tdd } = fixture();
    const of = async (members: readonly PlacedMember[], hiddenNativeNames: readonly string[] = []) =>
      (await generations.materialise({ members, hiddenNativeNames }, "scope")).fingerprint;
    const base = await of([tdd]);
    expect(await of([{ ...tdd }])).toBe(base);
    // What the members' frontmatter says is read live through the link: an edit to it is no new generation.
    expect(await of([{ ...tdd, invocation: "slash-only" }])).toBe(base);
    const variants = [
      await of([{ ...tdd, name: "test-driven" }]),
      await of([{ ...tdd, target: join(tdd.target, "..", "tdd-2") }]),
      await of([{ ...tdd, origin: { kind: "repository", repository: "github.com/mattpocock/skills", path: "tdd" } }]),
      await of([{ ...tdd, commit: "0123456789abcdef0123456789abcdef01234567" }]),
      await of([{ ...tdd, native: true }]),
      await of([tdd], ["triage"]),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
});

describe("the sweep", () => {
  it("deletes a generation no live process uses and no resolution holds current, and leaves the members' own files as they were", async () => {
    const { generations, tdd, review, root, own } = fixture();
    const first = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    const second = await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "scope");
    // Resolved since the last sweep, so a process about to be spawned under it still finds it: kept by the first sweep.
    await generations.sweep();
    expect(listed(root)).toEqual([first.fingerprint, second.fingerprint].sort());
    await generations.sweep();
    expect(listed(root)).toEqual([second.fingerprint]);
    expect(readFileSync(join(own, "skills", "tdd", "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho red\n");
    expect(readFileSync(join(own, "commands", "review.md"), "utf8")).toContain("Review it.");
  });

  it("keeps a generation while a live process holds it, and deletes it after the last release", async () => {
    const { generations, tdd, review, root } = fixture();
    const held = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    const release = generations.hold(held.generation as string);
    const again = generations.hold(held.generation as string);
    await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "scope");
    await generations.sweep();
    await generations.sweep();
    expect(listed(root)).toContain(held.fingerprint);
    release();
    // A release answers once: the second hold keeps it still.
    release();
    await generations.sweep();
    expect(listed(root)).toContain(held.fingerprint);
    again();
    await generations.sweep();
    expect(listed(root)).not.toContain(held.fingerprint);
  });

  it("keeps the generation each scope's latest resolution holds current, however many sweeps pass", async () => {
    const { generations, tdd, review, root } = fixture();
    const one = await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "account one");
    const two = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "account two");
    for (let sweep = 0; sweep < 3; sweep += 1) await generations.sweep();
    expect(listed(root)).toEqual([one.fingerprint, two.fingerprint].sort());
  });

  it("clears what a start before this one left: generations and a build a crash cut short", async () => {
    const { dataDir, root, clock } = fixture();
    mkdirSync(join(root, "0123456789abcdef0123456789abcdef", "skills"), { recursive: true });
    mkdirSync(join(root, ".building-cut-short"), { recursive: true });
    const generations = createGenerations({ dataDir, clock });
    await generations.sweep();
    expect(listed(root)).toEqual([]);
  });

  it("runs at start and every hour on the clock", async () => {
    const clock = manualClock();
    const { generations, tdd, review, root } = fixture({ clock });
    const stale = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "scope");
    onCleanup(generations.start());
    // The sweep at start keeps what was resolved since the last one; the first hourly one deletes the stale generation.
    clock.advance(GENERATION_SWEEP_INTERVAL_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listed(root)).toContain(stale.fingerprint);
    clock.advance(1);
    await vi.waitFor(() => expect(listed(root)).not.toContain(stale.fingerprint), { timeout: WAIT_MS });
  });
});

describe("on Windows", () => {
  it("links a folder as a junction and, where a file symbolic link is refused, a command file by a hard link it renews when the file is replaced", async () => {
    const { generations, tdd, review } = fixture({ platform: "win32" });
    refusals.fileSymlinks = true;
    onCleanup(() => void (refusals.fileSymlinks = false));
    const { generation } = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    // Off Windows the junction type is ignored: the folder's link is a symbolic link to it.
    expect(readlinkSync(join(generation as string, "skills", "tdd"))).toBe(tdd.target);
    const linked = join(generation as string, "skills", "review", "SKILL.md");
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
    expect(lstatSync(linked).ino).toBe(lstatSync(review.target).ino);
    // An editor that saves by writing a new file and renaming it over the old one leaves the hard link on the old text.
    write(`${review.target}.new`, "---\ndescription: Review the branch.\n---\nReview it twice.\n");
    const { renameSync } = await import("node:fs");
    renameSync(`${review.target}.new`, review.target);
    const again = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    expect(again.generation).toBe(generation);
    expect(readFileSync(linked, "utf8")).toContain("Review it twice.");
  });
});

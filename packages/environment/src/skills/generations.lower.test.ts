import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync, type RmOptions } from "node:fs";
import { join } from "node:path";
import { SKILL_PLUGIN_NAME } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { GENERATIONS_DIRECTORY, GENERATION_SWEEP_INTERVAL_MS, createGenerations, type GenerationsOptions, type PlacedMember } from "./generations.js";
import { createSnapshots, snapshotPath } from "./snapshots.js";

/**
 * The materialiser at its own seam, against a temporary data directory
 * (skills spec, "Testing Decisions", the one lower seam): what the wire
 * cannot show. A generation's entries are links rather than copies; a
 * generation a live process holds is kept; and a sweep's outcome is only
 * knowable once it has finished, which the environment's hourly timer does
 * not say. The environment's suite drives the same materialiser through
 * runs (`materialisation.test.ts`).
 */

/**
 * Whether a file symlink is refused as Windows refuses one without the
 * privilege, whether the next hard link is refused as a file that is gone
 * for an instant is, and how many unlinks go through before the next is
 * refused as a file another process holds open is (null: none is); the
 * rest go through.
 */
const refusals = vi.hoisted(() => ({ fileSymlinks: false, nextHardLink: false, unlinksBeforeBusy: null as number | null }));

/**
 * Whether a recursive `rm` follows each link it meets and deletes what the
 * link leads to: the worst a platform's recursive removal could do with a
 * junction, which a generation's deletion must not rely on any platform not
 * doing.
 */
const recursiveRemoval = vi.hoisted(() => ({ followsLinks: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { join: joined } = await import("node:path");
  /** Deletes what each link under `path` leads to. */
  const deleteThroughLinks = async (path: string): Promise<void> => {
    const found = await actual.lstat(path).catch(() => null);
    if (found?.isSymbolicLink()) await actual.rm(await actual.realpath(path), { recursive: true, force: true });
    else if (found?.isDirectory()) for (const entry of await actual.readdir(path)) await deleteThroughLinks(joined(path, entry));
  };
  return {
    ...actual,
    rm: async (path: string, options?: RmOptions) => {
      if (recursiveRemoval.followsLinks && options?.recursive === true) await deleteThroughLinks(path);
      return actual.rm(path, options);
    },
    symlink: (target: string, path: string, type?: string) =>
      refusals.fileSymlinks && type === "file"
        ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`), { code: "EPERM" }))
        : actual.symlink(target, path, type),
    link: (target: string, path: string) => {
      if (!refusals.nextHardLink) return actual.link(target, path);
      refusals.nextHardLink = false;
      return Promise.reject(Object.assign(new Error(`ENOENT: no such file or directory, link '${target}' -> '${path}'`), { code: "ENOENT" }));
    },
    unlink: (path: string) => {
      if (refusals.unlinksBeforeBusy === null) return actual.unlink(path);
      if (refusals.unlinksBeforeBusy > 0) {
        refusals.unlinksBeforeBusy -= 1;
        return actual.unlink(path);
      }
      refusals.unlinksBeforeBusy = null;
      return Promise.reject(Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" }));
    },
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
    description: "Test-driven development.",
    kind: "skill",
    target: join(own, "skills", "tdd"),
    origin: null,
    commit: null,
    invocation: "model+slash",
    userInvocable: true,
    argumentHint: null,
    native: false,
    alwaysOn: false,
  };
  const review: PlacedMember = { ...tdd, name: "review", description: "Review the branch.", kind: "command", target: join(own, "commands", "review.md") };
  return { dataDir, own, clock, generations, tdd, review, root: join(dataDir, GENERATIONS_DIRECTORY) };
};

/** A native member: a trusted repository's `.claude/skills` member, which the adapter loads itself. */
const native = (name: string): PlacedMember => ({
  name,
  description: `The repository's ${name}.`,
  kind: "skill",
  target: `/work/repo/.claude/skills/${name}`,
  origin: { kind: "repository", repository: "github.com/david/repo", path: `.claude/skills/${name}` },
  commit: null,
  invocation: "model+slash",
  userInvocable: true,
  argumentHint: null,
  native: true,
  alwaysOn: false,
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
  it("is the same for identical state, and changes with each name, folder, origin, snapshot commit, native flag, always-on flag and hidden native name", async () => {
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
      await of([{ ...tdd, alwaysOn: true }]),
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

  it("never leaves a generation whose deletion was cut short under its fingerprint, so the set's next resolution makes it whole", async () => {
    const { generations, tdd, review, root } = fixture();
    const whole = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "scope");
    await generations.sweep();
    // One link goes, and the next is refused as a file another process holds open is: the deletion stops part-way.
    refusals.unlinksBeforeBusy = 1;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    await generations.sweep();
    expect(errors).toHaveBeenCalledOnce();
    expect(listed(root)).not.toContain(whole.fingerprint);
    const again = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    expect(again).toEqual(whole);
    expect(readdirSync(join(again.generation as string, "skills")).sort()).toEqual(["review", "tdd"]);
    // What the cut-short deletion left goes at the next sweep, with the generation no resolution holds current.
    await generations.sweep();
    expect(listed(root)).toEqual([whole.fingerprint]);
  });

  it("deletes in one sweep a generation whose command folder holds more than its SKILL.md, never following a link there or a member's to what it leads to", async () => {
    const { generations, tdd, review, root, own } = fixture();
    const stale = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    const kept = await generations.materialise({ members: [tdd], hiddenNativeNames: [] }, "scope");
    await generations.sweep();
    // What a run at containment off could leave in a command folder: a file, and a link to a folder outside the generation.
    const folder = join(stale.generation as string, "skills", "review");
    write(join(folder, "notes.md"), "Left by a run.\n");
    const outside = tempDir();
    write(join(outside, "kept.md"), "Not the generation's.\n");
    symlinkSync(outside, join(folder, "elsewhere"), "dir");
    recursiveRemoval.followsLinks = true;
    onCleanup(() => void (recursiveRemoval.followsLinks = false));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    await generations.sweep();
    expect(errors).not.toHaveBeenCalled();
    expect(listed(root)).toEqual([kept.fingerprint]);
    expect(readFileSync(join(outside, "kept.md"), "utf8")).toBe("Not the generation's.\n");
    expect(readFileSync(join(own, "skills", "tdd", "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho red\n");
    expect(readFileSync(review.target, "utf8")).toContain("Review it.");
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
    const current = { members: [tdd], hiddenNativeNames: [] };
    await generations.materialise(current, "scope");
    onCleanup(generations.start());
    // The materialiser's work runs one piece at a time: a resolution after a sweep answers once the sweep has finished.
    const swept = () => generations.materialise(current, "scope");
    // The sweep at start keeps what was resolved since the last one; the first hourly one deletes the stale generation.
    clock.advance(GENERATION_SWEEP_INTERVAL_MS - 1);
    await swept();
    expect(listed(root)).toContain(stale.fingerprint);
    clock.advance(1);
    await swept();
    expect(listed(root)).not.toContain(stale.fingerprint);
  });
});

/** The snapshot store's sweep, which runs after the generations' one: when a resolution's touch lands within it, which the wire cannot time. */
describe("the snapshots' sweep", () => {
  it("keeps a snapshot a resolution touched while the sweep read the generations' links, and deletes it at the next sweep when nothing else keeps it", async () => {
    const dataDir = tempDir();
    const snapshot = snapshotPath(dataDir, "source-1", "0".repeat(40));
    mkdirSync(snapshot, { recursive: true });
    let touching = true;
    const snapshots = createSnapshots({
      dataDir,
      // The touch is queued as the sweep begins, so it lands while the sweep awaits the links.
      current: () => {
        if (touching) queueMicrotask(() => snapshots.touch(snapshot));
        return [];
      },
    });
    await snapshots.sweep();
    expect(existsSync(snapshot)).toBe(true);
    touching = false;
    await snapshots.sweep();
    expect(existsSync(snapshot)).toBe(false);
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
    renameSync(`${review.target}.new`, review.target);
    const again = await generations.materialise({ members: [tdd, review], hiddenNativeNames: [] }, "scope");
    expect(again.generation).toBe(generation);
    expect(readFileSync(linked, "utf8")).toContain("Review it twice.");
  });

  it("links a command file again where its renewal was cut short, so the set's next resolution is not refused for the link it lacks", async () => {
    const { generations, review } = fixture({ platform: "win32" });
    refusals.fileSymlinks = true;
    onCleanup(() => void (refusals.fileSymlinks = false));
    const set = { members: [review], hiddenNativeNames: [] };
    const { generation } = await generations.materialise(set, "scope");
    write(`${review.target}.new`, "---\ndescription: Review the branch.\n---\nReview it twice.\n");
    renameSync(`${review.target}.new`, review.target);
    // The old hard link goes, and the new one is refused: the file was gone for an instant as an editor saved it.
    refusals.nextHardLink = true;
    await expect(generations.materialise(set, "scope")).rejects.toThrow("ENOENT");
    const again = await generations.materialise(set, "scope");
    expect(again.generation).toBe(generation);
    const linked = join(generation as string, "skills", "review", "SKILL.md");
    expect(lstatSync(linked).ino).toBe(lstatSync(review.target).ino);
    expect(readFileSync(linked, "utf8")).toContain("Review it twice.");
  });
});

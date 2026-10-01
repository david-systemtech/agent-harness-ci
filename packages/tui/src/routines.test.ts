import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BYPASS_SENTENCE } from "@agent-harness/contracts";
import { readRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalEditResult } from "./composer/external-editor.js";
import { KEY, renderApp, type EnvironmentHandle, type RenderedApp, type RenderOptions } from "../test/harness.js";
import { ZONE, firingEntry, listedRoutine, preCheckRecord, scriptRoutines, skipEntry, type RoutinesScript, type ScriptedRoutines } from "../test/routines.js";

/**
 * `/routines` in the terminal UI (docs/specs/routines.md, "Clients";
 * docs/specs/tui.md, "The routines"; #533), over the client runtime's
 * `projections.routines` and `projections.routineHistory` and its commands,
 * against scripted environments answering the routine methods
 * (`test/routines.ts`), the editor a fake that hands back what the test
 * writes.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const WATCH = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d01";
const DIGEST = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d02";
const BACKUP = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d03";

interface Launched {
  readonly app: RenderedApp;
  readonly desk: EnvironmentHandle;
  readonly laptop: EnvironmentHandle;
  readonly deskRoutines: ScriptedRoutines;
  readonly laptopRoutines: ScriptedRoutines;
}

/** The desk here and a laptop paired, each answering the routine methods from its script; the desk's sessions as given. */
const launch = async (
  scripts: { readonly desk?: RoutinesScript; readonly laptop?: RoutinesScript } = {},
  options: Partial<RenderOptions> & { readonly deskSessions?: readonly { readonly id?: string; readonly title: string }[] } = {},
): Promise<Launched> => {
  const app = await renderApp({
    ...options,
    script: {
      environments: [
        { name: "desk", reach: "local", sessions: [...(options.deskSessions ?? [])] },
        { name: "laptop", reach: "paired" },
      ],
    },
  });
  apps.push(app);
  const desk = app.environment("desk");
  const laptop = app.environment("laptop");
  const deskRoutines = scriptRoutines(desk, scripts.desk);
  const laptopRoutines = scriptRoutines(laptop, scripts.laptop);
  await app.waitFor("● desk ready");
  return { app, desk, laptop, deskRoutines, laptopRoutines };
};

const openRoutines = async (app: RenderedApp, typed = "/routines") => {
  await app.type(typed);
  await app.press(KEY.enter);
};

/** The frame's row holding `text`; fails naming it when none does. */
const rowWith = (app: RenderedApp, text: string): number => {
  const at = app.rows().findIndex((row) => row.includes(text));
  if (at === -1) throw new Error(`No row holds ${text}; the frame is:\n${app.frame()}`);
  return at;
};

describe("/routines: the list", () => {
  it("lists every environment's routines under its heading in the connection list's order, each with its schedule in words, its next firing, its last outcome, its streak and its attention", async () => {
    const { app } = await launch(
      {
        desk: {
          routines: [
            listedRoutine(WATCH, {
              state: { lastOutcome: { kind: "firing", entryId: "0199dd00-0000-4000-8000-0000000000e1", outcome: "succeeded", reason: null, at: "2026-09-23T19:04:00.000Z" } },
            }),
            listedRoutine(DIGEST, {
              definition: { name: "Morning digest", schedule: { kind: "weekdays", at: "08:30" }, timezone: "Europe/London", enabled: false },
              state: { lastOutcome: { kind: "firing", entryId: "0199dd00-0000-4000-8000-0000000000e2", outcome: "failed", reason: "timed_out", at: "2026-09-23T07:40:00.000Z" }, failureStreak: 3 },
              attention: ["failing", "account_signed_out"],
            }),
          ],
        },
        laptop: { routines: [listedRoutine(BACKUP, { definition: { name: "Backup check", schedule: { kind: "manual" } }, nextDueAt: null })] },
      },
      // Under 100 columns the rail gives the card its room, so each line is read whole.
      { size: { columns: 99, rows: 30 } },
    );
    await openRoutines(app);
    await app.waitFor("Backup check");

    expect(rowWith(app, "desk · 2 routines")).toBeLessThan(rowWith(app, "Upstream watch"));
    expect(rowWith(app, "Upstream watch")).toBeLessThan(rowWith(app, "Morning digest"));
    expect(rowWith(app, "Morning digest")).toBeLessThan(rowWith(app, "laptop · 1 routine"));
    expect(rowWith(app, "laptop · 1 routine")).toBeLessThan(rowWith(app, "Backup check"));
    // Each routine's row, and the line under it.
    const row = (name: string, under = 0) => app.rows()[rowWith(app, name) + under] ?? "";
    expect(row("Upstream watch")).toContain("Every Monday at 03:00 (Asia/Manila)");
    expect(row("Upstream watch", 1)).toMatch(/next \S+/);
    expect(row("Morning digest")).toContain("Monday to Friday at 08:30 (Europe/London)");
    expect(row("Morning digest", 1)).toContain("disabled · account signed out");
    expect(app.frame()).toMatch(/last succeeded/);
    expect(app.frame()).toContain("last failed: timed out");
    expect(app.frame()).toContain("3 failed in a row");
    expect(app.frame()).toContain("account signed out");
    expect(app.rows()[rowWith(app, "Backup check")]).toContain("Only when run now");
  });

  it("marks an unreachable environment's list stale, keeping what it last listed", async () => {
    const { app, laptop } = await launch({ laptop: { routines: [listedRoutine(BACKUP, { definition: { name: "Backup check" } })] } });
    await openRoutines(app);
    await app.waitFor("Backup check");
    laptop.autoAccept(false);
    laptop.discovery("nothing");
    laptop.server.drop();
    await app.waitFor(/laptop · 1 routine · unreachable: as listed at \d\d:\d\d/);
    expect(app.frame()).toContain("Backup check");
  });
});

const FIRING_SESSION = "0199ab00-0000-4000-8000-0000000000f1";
const LIVE_SESSION = "0199ab00-0000-4000-8000-0000000000f2";

describe("/routines: Enter", () => {
  it("opens the latest firing's session: the live firing's, else the newest firing in the routine's history", async () => {
    const { app } = await launch(
      {
        desk: {
          routines: [
            listedRoutine(WATCH),
            listedRoutine(DIGEST, {
              definition: { name: "Morning digest" },
              state: { liveFiring: { firingId: "0199dd00-0000-4000-8000-0000000000e3", trigger: "run-now", dueAt: "2026-09-24T00:00:00.000Z", startedAt: "2026-09-24T00:00:00.000Z", sessionId: LIVE_SESSION, runId: "7c9e6679-7425-40de-944b-e07fc1f90ae8" } },
            }),
          ],
          history: {
            [WATCH]: [skipEntry("0199dd00-0000-4000-8000-0000000000e4"), firingEntry("0199dd00-0000-4000-8000-0000000000e5", FIRING_SESSION)],
          },
        },
      },
      { deskSessions: [{ id: FIRING_SESSION, title: "Watch firing" }, { id: LIVE_SESSION, title: "Digest firing" }] },
    );
    await openRoutines(app);
    await app.waitFor("Morning digest");
    await app.press(KEY.enter);
    await app.waitFor("Watch firing · ");
    expect(app.frame()).not.toContain("Morning digest");

    await openRoutines(app);
    await app.waitFor("Morning digest");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Digest firing · ");
  });

  it("says so when the routine has not fired", async () => {
    const { app } = await launch({ desk: { routines: [listedRoutine(WATCH)], history: { [WATCH]: [skipEntry("0199dd00-0000-4000-8000-0000000000e4")] } } });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press(KEY.enter);
    await app.waitFor("Upstream watch has not fired yet.");
  });
});

describe("/routines: the row verbs", () => {
  it("runs a routine now, and refuses at once with one line while its environment cannot be reached", async () => {
    const { app, laptop, laptopRoutines } = await launch({ laptop: { routines: [listedRoutine(BACKUP, { definition: { name: "Backup check" } })] } });
    await openRoutines(app);
    await app.waitFor("Backup check");
    await app.press(KEY.down, "r");
    await app.waitFor("Running Backup check on laptop now.");
    expect(laptopRoutines.heard("routines.runNow").map((h) => h.params["routineId"])).toEqual([BACKUP]);

    laptop.autoAccept(false);
    laptop.discovery("nothing");
    laptop.server.drop();
    await app.waitFor("unreachable: as listed at");
    await app.press("r");
    await app.waitFor("Not run: laptop cannot be reached.");
    expect(laptopRoutines.heard("routines.runNow")).toHaveLength(1);
  });

  it("disables a routine and enables it again", async () => {
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press(KEY.space);
    await app.waitFor("disabled · never fired");
    expect(deskRoutines.definitionOf(WATCH).enabled).toBe(false);
    await app.press(KEY.space);
    await app.waitFor(/next .+ · never fired/);
    expect(deskRoutines.heard().filter((h) => h.method === "routines.enable" || h.method === "routines.disable").map((h) => h.method)).toEqual(["routines.disable", "routines.enable"]);
  });

  it("exports a routine to the path typed, writing the YAML its environment exported", async () => {
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press("x");
    await app.waitFor("Export Upstream watch to: upstream-watch.yaml");
    await app.press(...Array.from({ length: "upstream-watch.yaml".length }, () => KEY.backspace));
    await app.type("watch.yaml");
    await app.press(KEY.enter);
    const path = join(app.stateDir, "watch.yaml");
    await app.waitFor(`Exported Upstream watch to ${path}.`);
    const written = await readFile(path, "utf8");
    expect(written).toContain("# Routines exported from desk at 2026-10-01T08:00:00.000Z.");
    expect(readRoutineYaml(written, ZONE).map((document) => document.definition)).toEqual([deskRoutines.definitionOf(WATCH)]);
  });
});

describe("/routines: a routine's history", () => {
  const history = () => [
    firingEntry("0199dd00-0000-4000-8000-0000000000e7", FIRING_SESSION, {
      trigger: "run-now",
      startedAt: "2026-09-23T10:00:00.000Z",
      text: "Two sources moved: see the digest.",
      preCheck: preCheckRecord("v1.2.3\nv1.2.4\n"),
      targets: [
        { kind: "client-notice", on: "both" },
        { kind: "webhook", target: "hermes-home", on: "success" },
      ],
      deliveries: [
        { target: { kind: "client-notice", on: "both" }, result: "delivered", attempts: [{ attempt: 1, at: "2026-09-23T10:04:00.000Z", result: "delivered", status: null, error: null, retryAt: null }] },
        {
          target: { kind: "webhook", target: "hermes-home", on: "success" },
          result: "failed",
          attempts: [{ attempt: 1, at: "2026-09-23T10:04:00.000Z", result: "failed", status: 400, error: "Bad Request", retryAt: null }],
        },
      ],
    }),
    skipEntry("0199dd00-0000-4000-8000-0000000000e6", { at: "2026-09-22T19:00:00.000Z", reason: "pre-check-failed", detail: "The script exited 2." }),
    firingEntry("0199dd00-0000-4000-8000-0000000000e5", LIVE_SESSION, { startedAt: "2026-09-21T19:00:00.000Z", outcome: "failed", reason: "timed_out", text: "Ran out of time reading the sources." }),
  ];

  it("lists its firings and skips newest first, the one at the cursor with its kept text, its pre-check's output and its deliveries", async () => {
    const { app } = await launch({ desk: { routines: [listedRoutine(WATCH)], history: { [WATCH]: history() } } });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press("h");
    await app.waitFor("History of Upstream watch on desk");
    await app.waitFor("run now");
    expect(rowWith(app, "succeeded")).toBeLessThan(rowWith(app, "skipped: the pre-check failed"));
    expect(rowWith(app, "skipped: the pre-check failed")).toBeLessThan(rowWith(app, "failed: timed out"));
    expect(app.frame()).toContain("Two sources moved: see the digest.");
    expect(app.frame()).toContain("Pre-check: exited 0 in 1.2s, 14 bytes, changed");
    expect(app.frame()).toContain("v1.2.4");
    expect(app.frame()).toContain("client notice: delivered");
    expect(app.frame()).toContain("hermes-home: failed, 400 Bad Request");

    await app.press(KEY.down);
    await app.waitFor("The script exited 2.");
    await app.press(KEY.down);
    await app.waitFor("Ran out of time reading the sources.");
  });

  it("opens an entry's firing with Enter, says a skip has none, and goes back to the list with Esc", async () => {
    const { app } = await launch(
      { desk: { routines: [listedRoutine(WATCH)], history: { [WATCH]: history() } } },
      { deskSessions: [{ id: FIRING_SESSION, title: "Watch firing" }, { id: LIVE_SESSION, title: "Timed out firing" }] },
    );
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press("h");
    await app.waitFor("run now");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("A skip has no session: the due time was skipped before one started.");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("History of"), "the history closed");
    expect(app.frame()).toContain("desk · 1 routine");
    await app.press("h");
    await app.waitFor("run now");
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Timed out firing · ");
  });
});

/** An editor for the tests: each call hands back what `saves` makes of the text it was handed, or abandons the edit. */
const fakeEditor = (...saves: ((handed: string) => ExternalEditResult)[]) => {
  const handed: string[] = [];
  const editRoutine = async (yaml: string): Promise<ExternalEditResult> => {
    handed.push(yaml);
    const save = saves[handed.length - 1];
    if (save === undefined) throw new Error(`The editor was opened a ${handed.length}th time, which the test did not expect.`);
    return save(yaml);
  };
  return { handed, editRoutine };
};

/** A save that changes `from` to `to` in what the editor was handed. */
const changing =
  (from: string, to: string) =>
  (handed: string): ExternalEditResult => {
    if (!handed.includes(from)) throw new Error(`The editor was not handed ${from}:\n${handed}`);
    return { ok: true, text: handed.replace(from, to) };
  };

describe("/routines: editing a routine in the editor", () => {
  it("opens the routine's YAML as its environment exports it, and applies what is saved with routines.import naming the routine", async () => {
    const editor = fakeEditor(changing("Read the sources and file a digest.", "Read the sources twice, then file a digest."));
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } }, { editRoutine: editor.editRoutine });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press("e");
    await app.waitFor("Saved Upstream watch on desk.");
    expect(editor.handed[0]).toContain("# Routines exported from desk at 2026-10-01T08:00:00.000Z.");
    const [imported] = deskRoutines.heard("routines.import");
    expect(imported?.params).toMatchObject({ routineId: WATCH, yaml: expect.stringContaining("Read the sources twice, then file a digest.") });
    expect(imported?.params["routineIds"]).toBeUndefined();
    expect(deskRoutines.definitionOf(WATCH).instructions).toBe("Read the sources twice, then file a digest.");
  });

  it("sends nothing for an edit saved unchanged or abandoned", async () => {
    const editor = fakeEditor(
      (handed) => ({ ok: true, text: handed }),
      () => ({ ok: false, reason: "editor exited with status 1" }),
    );
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } }, { editRoutine: editor.editRoutine });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press("e");
    await app.waitFor("Upstream watch is unchanged: nothing was sent.");
    await app.press("e");
    await app.waitFor("Not edited: editor exited with status 1.");
    expect(deskRoutines.heard("routines.import")).toEqual([]);
    expect(deskRoutines.heard("routines.checkImport")).toEqual([]);
  });

  it("reopens a refused edit with each issue as a comment at its path, and saving again retries it", async () => {
    const editor = fakeEditor(
      (handed) => ({ ok: true, text: handed.replace("day: monday", "day: someday").replace("enabled: true", "enabled: true\nbogus: 1") }),
      (handed) => ({ ok: true, text: handed.replace("day: someday", "day: tuesday").replace("bogus: 1\n", "") }),
      (handed) => ({ ok: true, text: handed.replace("  Read the sources", "  Read every source") }),
    );
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } }, { editRoutine: editor.editRoutine });
    deskRoutines.answerNext("routines.import", {
      error: { code: "invalid_params", message: "The YAML cannot be imported as it is.", data: { issues: [{ code: "custom", path: ["yaml", 0, "instructions"], message: "Name the sources." }] } },
    });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press("e");
    await app.waitFor("Saved Upstream watch on desk.");

    // The schedule's day and the unknown key, each refused at its own line.
    const second = (editor.handed[1] ?? "").split("\n");
    const at = (prefix: string) => second.findIndex((line) => line.startsWith(prefix));
    expect(second[at("schedule:") - 1]).toMatch(/^# refused: schedule\.day: .+/);
    expect(second[at("bogus:") - 1]).toBe('# refused: bogus: A routine document has no key "bogus" here.');
    // The import itself refused the third save at the instructions; the comments of the round before are gone.
    const third = (editor.handed[2] ?? "").split("\n");
    expect(third[third.findIndex((line) => line.startsWith("instructions:")) - 1]).toBe("# refused: instructions: Name the sources.");
    expect(third.filter((line) => line.includes("# refused:"))).toHaveLength(1);
    expect(deskRoutines.heard("routines.import")).toHaveLength(2);
    expect(deskRoutines.definitionOf(WATCH)).toMatchObject({ schedule: { kind: "weekly", day: "tuesday", at: "03:00" }, instructions: "Read every source and file a digest." });
  });
});

describe("/routines: what an edit asks and where it waits", () => {
  it("shows the bypass sentence for a document whose mode is bypassPermissions, and applies it only once confirmed", async () => {
    const bypass = changing("mode: acceptEdits", "mode: bypassPermissions");
    const editor = fakeEditor(bypass, bypass);
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } }, { editRoutine: editor.editRoutine });
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    await app.press("e");
    await app.waitFor(`Upstream watch asks for bypassPermissions. ${BYPASS_SENTENCE} Apply it? y/n`);
    await app.press("n");
    await app.waitFor("Not applied: Upstream watch on desk is as it was.");
    expect(deskRoutines.heard("routines.import")).toEqual([]);

    await app.press("e");
    await app.waitFor("Apply it? y/n");
    await app.press("y");
    await app.waitFor("Saved Upstream watch on desk.");
    expect(deskRoutines.definitionOf(WATCH).mode).toBe("bypassPermissions");
  });

  it("queues an edit saved while its environment cannot be reached, showing its routine pending until it is sent", async () => {
    let laptopHandle: EnvironmentHandle | undefined;
    const editor = fakeEditor((handed) => {
      // The laptop goes away while the routine is being edited.
      laptopHandle?.autoAccept(false);
      laptopHandle?.discovery("nothing");
      laptopHandle?.server.drop();
      return { ok: true, text: handed.replace("Read the sources and file a digest.", "Check the backups.") };
    });
    const { app, laptop, laptopRoutines } = await launch({ laptop: { routines: [listedRoutine(BACKUP, { definition: { name: "Backup check" } })] } }, { editRoutine: editor.editRoutine });
    laptopHandle = laptop;
    await openRoutines(app);
    await app.waitFor("Backup check");
    await app.press(KEY.down, "e");
    await app.waitFor("Queued: Backup check is saved once laptop can be reached; until then it shows pending.");
    await app.waitUntil(() => (app.rows().find((row) => row.includes("Backup check")) ?? "").includes("pending"), "the routine shown pending");
    expect(laptopRoutines.heard("routines.import")).toEqual([]);

    laptop.discovery("ready");
    laptop.autoAccept(true);
    await app.jump(40_000);
    await app.waitUntil(() => laptopRoutines.heard("routines.import").length === 1, "the import sent once the laptop is back", 400);
    await app.waitUntil(() => !(app.rows().find((row) => row.includes("Backup check")) ?? "").includes("pending"), "the routine no longer pending", 400);
    expect(laptopRoutines.definitionOf(BACKUP).instructions).toBe("Check the backups.");
  });
});

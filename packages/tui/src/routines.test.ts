import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BYPASS_SENTENCE } from "@agent-harness/contracts";
import { readRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import { afterEach, describe, expect, it } from "vitest";
import stringWidth from "string-width";
import type { ExternalEditResult } from "./composer/external-editor.js";
import { KEY, renderApp, settle, type EnvironmentHandle, type RenderedApp, type RenderOptions } from "../test/harness.js";
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
  it("names each unknown skill in the routine's state line, in the order the environment lists them", async () => {
    const { app } = await launch(
      { desk: { routines: [listedRoutine(WATCH, { definition: { schedule: { kind: "manual" }, skills: ["known", "foo", "bar"] }, nextDueAt: null, attention: ["skill_unknown", "script_missing"], unknownSkills: ["foo", "bar"] })] } },
      { size: { columns: 99, rows: 30 } },
    );
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    expect(app.rows()[rowWith(app, "Upstream watch") + 1]).toContain("not due · skills unknown: foo, bar · pre-check script missing");
    expect(app.frame()).not.toContain("skills unknown: known");
  });

  it("fits a long unknown-skill list to a narrow routine card and wraps it in the import check", async () => {
    const unknownSkills = ["foo", "bar", "code-review", "diagnosing-bugs", "domain-modeling", "writing-for-agents"];
    const { app, deskRoutines } = await launch(
      { desk: { routines: [listedRoutine(WATCH, { definition: { enabled: false, skills: unknownSkills }, attention: ["skill_unknown"], unknownSkills })] } },
      { size: { columns: 60, rows: 30 } },
    );
    await openRoutines(app);
    await app.waitFor("Upstream watch");
    const under = app.rows()[rowWith(app, "Upstream watch") + 1] ?? "";
    expect(under).toContain("disabled · skills unknown: foo, bar");
    expect(under.trimEnd()).toMatch(/…$/);
    expect(under).not.toContain("writing-for-agents");
    expect(app.rows().every((row) => stringWidth(row) <= 60)).toBe(true);

    await app.press(KEY.esc);
    await writeFile(join(app.stateDir, "skills.yaml"), await deskRoutines.exported([WATCH]), "utf8");
    deskRoutines.warnNext({ attention: ["skill_unknown"], unknownSkills, workspace: null });
    await openRoutines(app, "/routines import skills.yaml");
    await app.waitFor("1. Upstream watch");
    expect(app.frame().replace(/\s+/g, " ")).toContain("Here it would need: skills unknown: foo, bar, code-review, diagnosing-bugs, domain-modeling, writing-for-agents");
    expect(app.rows().every((row) => stringWidth(row) <= 60)).toBe(true);
  });

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

  it("says an environment whose routines could not be listed is not being read (PR review)", async () => {
    const { app, laptopRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } });
    laptopRoutines.answerNext("routines.list", { error: { code: "internal", message: "The routines store could not be read.", data: {} } });
    await openRoutines(app);
    await app.waitFor("laptop · 0 routines · not listed: The routines store");
    expect(app.frame()).toContain("Its routines could not be listed.");
    expect(app.frame()).not.toContain("Reading its routines…");
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

  it("closes only the export that asked: one whose answer comes back after it was left leaves another routine's export open (PR review)", async () => {
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH), listedRoutine(DIGEST, { definition: { name: "Morning digest" } })] } });
    await openRoutines(app);
    await app.waitFor("Morning digest");
    const release = deskRoutines.holdNext("routines.export");
    await app.press("x");
    await app.waitFor("Export Upstream watch to: upstream-watch.yaml");
    await app.press(KEY.enter);
    await app.waitUntil(() => deskRoutines.heard("routines.export").length === 1, "the export asked for");
    await app.press(KEY.esc);
    await app.press(KEY.down, "x");
    await app.waitFor("Export Morning digest to: morning-digest.yaml");
    release();
    await app.waitFor(`Exported Upstream watch to ${join(app.stateDir, "upstream-watch.yaml")}.`);
    expect(app.frame()).toContain("Export Morning digest to: morning-digest.yaml");
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
    const away: { laptop?: EnvironmentHandle } = {};
    const editor = fakeEditor((handed) => {
      // The laptop goes away while the routine is being edited.
      away.laptop?.autoAccept(false);
      away.laptop?.discovery("nothing");
      away.laptop?.server.drop();
      return { ok: true, text: handed.replace("Read the sources and file a digest.", "Check the backups.") };
    });
    const { app, laptop, laptopRoutines } = await launch({ laptop: { routines: [listedRoutine(BACKUP, { definition: { name: "Backup check" } })] } }, { editRoutine: editor.editRoutine });
    away.laptop = laptop;
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

describe("/routines new and /routines import", () => {
  it("names each unknown skill on the import check's Here it would need line", async () => {
    const { app, deskRoutines } = await launch(
      { desk: { routines: [listedRoutine(WATCH, { definition: { skills: ["known", "bar", "foo"] } })] } },
      { size: { columns: 99, rows: 30 } },
    );
    await writeFile(join(app.stateDir, "skills.yaml"), await deskRoutines.exported([WATCH]), "utf8");
    deskRoutines.warnNext({ attention: ["skill_unknown", "script_missing"], unknownSkills: ["bar", "foo"], workspace: null });
    await openRoutines(app, "/routines import skills.yaml");
    await app.waitFor("1. Upstream watch");
    expect(app.rows()[rowWith(app, "Here it would need:")]).toContain("Here it would need: skills unknown: bar, foo, pre-check script missing");
    expect(app.frame()).not.toContain("skills unknown: known");
  });

  it("opens a template with the presets in the editor, and imports what is saved as a new routine under an id this client minted", async () => {
    const editor = fakeEditor((handed) => ({ ok: true, text: handed.replace("name: New routine", "name: Nightly triage") }));
    const { app, deskRoutines } = await launch({}, { editRoutine: editor.editRoutine });
    await openRoutines(app, "/routines new");
    await app.waitFor("Saved Nightly triage on desk.");
    const template = editor.handed[0] ?? "";
    for (const preset of ["if-missed: run-once", "injection: inherit", 'silent-marker: "[SILENT]"', "max-duration-minutes: 60", "- { kind: client-notice, on: both }"]) expect(template).toContain(preset);
    expect(template.split("\n").filter((line) => line.startsWith("#")).length).toBeGreaterThan(5);
    const [imported] = deskRoutines.heard("routines.import");
    expect(imported?.params["routineIds"]).toEqual(["0199cc00-0000-4000-8000-000000000001"]);
    expect(imported?.params["routineId"]).toBeUndefined();
    expect(deskRoutines.definitionOf("0199cc00-0000-4000-8000-000000000001")).toMatchObject({ name: "Nightly triage", ifMissed: "run-once", silenceMarker: "[SILENT]", maxDurationMinutes: 60 });
  });

  it("sends nothing for the template saved as it is", async () => {
    const editor = fakeEditor((handed) => ({ ok: true, text: handed }));
    const { app, deskRoutines } = await launch({}, { editRoutine: editor.editRoutine });
    await openRoutines(app, "/routines new");
    await app.waitFor("The new routine is unchanged: nothing was sent.");
    expect(deskRoutines.heard("routines.import")).toEqual([]);
  });

  it("reads a file, shows what routines.checkImport says of each document, and imports it once confirmed", async () => {
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } });
    const yaml = (await deskRoutines.exported([WATCH])).replace("name: Upstream watch", "name: Upstream watch copy").replace("mode: acceptEdits", "mode: bypassPermissions");
    await writeFile(join(app.stateDir, "routines.yaml"), `${yaml}---\n${yaml.replace("Upstream watch copy", "Second watch").replace("mode: bypassPermissions", "mode: plan")}`, "utf8");
    deskRoutines.warnNext({ attention: ["script_missing"], unknownSkills: [], workspace: { kind: "scratch", repositoryIdentity: null } });
    await openRoutines(app, "/routines import routines.yaml");
    await app.waitFor(`Import from ${join(app.stateDir, "routines.yaml")} to desk`);
    expect(app.frame()).toContain("Upstream watch copy");
    expect(app.frame()).toContain("Second watch");
    expect(app.frame()).toContain("Here it would need: pre-check script missing");
    expect(app.frame()).toContain("Its workspace here: a scratch directory");
    await app.waitFor(`Import 2 routines to desk? Upstream watch copy asks for bypassPermissions. ${BYPASS_SENTENCE} y/n`);
    await app.press("y");
    await app.waitFor("Imported Upstream watch copy and Second watch to desk.");
    const [imported] = deskRoutines.heard("routines.import");
    expect(imported?.params["routineIds"]).toEqual(["0199cc00-0000-4000-8000-000000000001", "0199cc00-0000-4000-8000-000000000002"]);
    await app.waitFor("desk · 3 routines");
  });

  it("shows a file's issues at their paths and imports nothing", async () => {
    const { app, deskRoutines } = await launch({ desk: { routines: [listedRoutine(WATCH)] } });
    const yaml = await deskRoutines.exported([WATCH]);
    await writeFile(join(app.stateDir, "taken.yaml"), `${yaml}---\n${yaml.replace("name: Upstream watch", "name: Other watch").replace("enabled: true", "enabled: maybe")}`, "utf8");
    await openRoutines(app, "/routines import taken.yaml");
    await app.waitFor("name: Upstream watch is taken on this environment.");
    expect(rowWith(app, "1. Upstream watch")).toBeLessThan(rowWith(app, "name: Upstream watch is taken"));
    expect(rowWith(app, "2. Not a routine")).toBeLessThan(rowWith(app, "enabled: "));
    expect(app.frame()).toContain("Nothing is imported until the file's issues are fixed.");
    expect(app.frame()).not.toContain("y/n");
    expect(deskRoutines.heard("routines.import")).toEqual([]);
  });
});

describe("/routines endpoints and /routines test-precheck (David, 2026-09-28)", () => {
  const hermes = { name: "hermes-home", url: "https://hermes.example.com/webhooks/harness", secretKind: "pasted", lastResult: { at: "2026-09-23T10:04:00.000Z", result: "delivered", status: 204, error: null } } as const;

  it("lists the header environment's webhook endpoints and tests one", async () => {
    const { app, deskRoutines } = await launch({ desk: { endpoints: [hermes] } });
    await openRoutines(app, "/routines endpoints");
    await app.waitFor("Webhook endpoints on desk");
    await app.waitFor("hermes-home");
    const row = app.rows()[rowWith(app, "hermes-home")] ?? "";
    expect(row).toContain("https://hermes.example.com/webhooks/harness");
    expect(app.frame()).toMatch(/secret pasted · last delivered, 204/);
    await app.press("t");
    await app.waitFor("hermes-home answered 204 in 120ms.");
    expect(deskRoutines.heard("routines.endpoints.test").map((h) => h.params)).toEqual([{ name: "hermes-home" }]);
  });

  it("adds an endpoint from its name, URL and pasted secret, never drawing the secret, and removes one once confirmed", async () => {
    const { app, deskRoutines } = await launch({ desk: { endpoints: [hermes] } });
    await openRoutines(app, "/routines endpoints");
    await app.waitFor("hermes-home");
    await app.press("a");
    await app.waitFor("Name (lower-case letters, digits and hyphens):");
    await app.type("matrix-relay");
    await app.press(KEY.enter);
    await app.waitFor("URL:");
    await app.type("https://relay.example.com/hook");
    await app.press(KEY.enter);
    await app.waitFor("Secret, pasted (Enter for none):");
    await app.paste("token-for-tests");
    await app.waitFor("•••••••••••••••");
    expect(app.frame()).not.toContain("token-for-tests");
    await app.press(KEY.enter);
    await app.waitFor("Saved the endpoint matrix-relay on desk.");
    await app.waitFor("matrix-relay");
    expect(deskRoutines.heard("routines.endpoints.set").map((h) => ({ ...h.params, commandId: "minted" }))).toEqual([
      { commandId: "minted", name: "matrix-relay", url: "https://relay.example.com/hook", secret: { kind: "pasted", secret: "token-for-tests" } },
    ]);

    await app.press(KEY.down, "d");
    await app.waitFor("Remove the endpoint matrix-relay from desk? A routine delivering to it shows it missing. y/n");
    await app.press("y");
    await app.waitFor("Removed the endpoint matrix-relay from desk.");
    await app.waitUntil(() => !app.frame().includes("https://relay.example.com/hook"), "the endpoint's row gone");
    expect(deskRoutines.endpoints.map((endpoint) => endpoint.name)).toEqual(["hermes-home"]);
  });

  it("says why an endpoint another client removed already was not removed (PR review)", async () => {
    const relay = { name: "matrix-relay", url: "https://relay.example.com/hook", secretKind: "missing", lastResult: null } as const;
    const { app, deskRoutines } = await launch({ desk: { endpoints: [hermes, relay] } });
    await openRoutines(app, "/routines endpoints");
    await app.waitFor("matrix-relay");
    deskRoutines.endpoints.splice(1, 1);
    await app.press(KEY.down, "d");
    await app.waitFor("Remove the endpoint matrix-relay from desk? A routine delivering to it shows it missing. y/n");
    await app.press("y");
    await app.waitFor("Not removed: No webhook endpoint matrix-relay is on this environment.");
    expect(deskRoutines.endpoints.map((endpoint) => endpoint.name)).toEqual(["hermes-home"]);
  });

  it("runs a routine's pre-check once by its name and shows what it found", async () => {
    const { app, deskRoutines } = await launch({
      desk: {
        routines: [listedRoutine(WATCH, { definition: { preCheck: { kind: "script", path: "upstream-watch.sh", timeoutSeconds: 60 } } })],
        preChecks: { [WATCH]: preCheckRecord("v1.2.3\nv1.2.4\n", { differs: false }) },
      },
    });
    await openRoutines(app, "/routines test-precheck upstream WATCH");
    await app.waitFor("Pre-check of Upstream watch on desk");
    await app.waitFor("exited 0 in 1.2s, 14 bytes, unchanged");
    expect(app.frame()).toContain("v1.2.4");
    expect(deskRoutines.heard("routines.testPreCheck").map((h) => h.params)).toEqual([{ routineId: WATCH }]);
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("Pre-check of"), "the card closed");
    await openRoutines(app, "/routines test-precheck nightly");
    await app.waitFor("No routine is named nightly.");
  });

  it("draws a pre-check's answer only on the card that asked: one that comes back after it was closed leaves another routine's card as it is (PR review)", async () => {
    const { app, deskRoutines } = await launch({
      desk: {
        routines: [listedRoutine(WATCH), listedRoutine(DIGEST, { definition: { name: "Morning digest" } })],
        preChecks: { [WATCH]: preCheckRecord("v1.2.3\nv1.2.4\n"), [DIGEST]: preCheckRecord("three new posts\n", { differs: false }) },
      },
    });
    const release = deskRoutines.holdNext("routines.testPreCheck");
    await openRoutines(app, "/routines test-precheck upstream watch");
    await app.waitFor("Running its pre-check once");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("Pre-check of"), "the card closed");
    await openRoutines(app, "/routines test-precheck morning digest");
    await app.waitFor("three new posts");
    release();
    await settle();
    await app.tick(2);
    expect(deskRoutines.heard("routines.testPreCheck").map((h) => h.params["routineId"])).toEqual([WATCH, DIGEST]);
    expect(app.frame()).toContain("Pre-check of Morning digest on desk");
    expect(app.frame()).toContain("exited 0 in 1.2s, 16 bytes, unchanged");
    expect(app.frame()).not.toContain("v1.2.4");
  });

  it("closes only the endpoint form that asked: a save whose answer comes back after it was left leaves the form opened since (PR review)", async () => {
    const { app, deskRoutines } = await launch({ desk: { endpoints: [hermes] } });
    await openRoutines(app, "/routines endpoints");
    await app.waitFor("hermes-home");
    await app.press("a");
    await app.waitFor("Name (lower-case letters, digits and hyphens):");
    await app.type("matrix-relay");
    await app.press(KEY.enter);
    await app.waitFor("URL:");
    await app.type("https://relay.example.com/hook");
    await app.press(KEY.enter);
    await app.waitFor("Secret, pasted (Enter for none):");
    const release = deskRoutines.holdNext("routines.endpoints.set");
    await app.press(KEY.enter);
    await app.waitUntil(() => deskRoutines.heard("routines.endpoints.set").length === 1, "the save sent");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("Secret, pasted"), "the form left");
    await app.press("a");
    await app.waitFor("Name (lower-case letters, digits and hyphens):");
    await app.type("ntfy");
    release();
    await app.waitFor("Saved the endpoint matrix-relay on desk.");
    expect(app.frame()).toContain("Name (lower-case letters, digits and hyphens):");
    expect(app.frame()).toContain("ntfy");
  });
});

describe("a routine's notice", () => {
  it("shows on the activity line and in /notices, where Enter opens the firing's session", async () => {
    const { app, desk } = await launch({ desk: { routines: [listedRoutine(WATCH)] } }, { deskSessions: [{ id: FIRING_SESSION, title: "Watch firing" }] });
    desk.notice("routine.delivered", {
      routineId: WATCH,
      name: "Upstream watch",
      entryId: "0199dd00-0000-4000-8000-0000000000e9",
      entryKind: "firing",
      sessionId: FIRING_SESSION,
      outcome: "succeeded",
      summary: "Two sources moved: see the digest.",
      body: "Two sources moved: see the digest.",
    });
    await app.waitFor("Upstream watch on desk: Two sources moved: see the digest.");
    expect(app.rows().at(-1)).toContain("Upstream watch on desk: Two sources moved: see the digest.");

    await openRoutines(app, "/notices");
    await app.waitFor("Notices");
    // The newest notice, under the cursor.
    expect(app.rows().some((row) => /› .*Upstream watch on desk: Two sources moved/.test(row))).toBe(true);
    await app.press(KEY.enter);
    await app.waitFor("Watch firing · ");
    expect(app.frame()).not.toContain("Notices");
  });
});

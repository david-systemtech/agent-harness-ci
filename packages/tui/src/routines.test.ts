import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type EnvironmentHandle, type RenderedApp, type RenderOptions } from "../test/harness.js";
import { listedRoutine, scriptRoutines, type RoutinesScript, type ScriptedRoutines } from "../test/routines.js";

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
    const { app } = await launch({
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
    });
    await openRoutines(app);
    await app.waitFor("Backup check");

    expect(rowWith(app, "desk · 2 routines")).toBeLessThan(rowWith(app, "Upstream watch"));
    expect(rowWith(app, "Upstream watch")).toBeLessThan(rowWith(app, "Morning digest"));
    expect(rowWith(app, "Morning digest")).toBeLessThan(rowWith(app, "laptop · 1 routine"));
    expect(rowWith(app, "laptop · 1 routine")).toBeLessThan(rowWith(app, "Backup check"));
    const watch = app.rows()[rowWith(app, "Upstream watch")] ?? "";
    expect(watch).toContain("Every Monday at 03:00 (Asia/Manila)");
    expect(watch).toMatch(/next \S+/);
    const digest = app.rows()[rowWith(app, "Morning digest")] ?? "";
    expect(digest).toContain("Monday to Friday at 08:30 (Europe/London)");
    expect(digest).toContain("disabled");
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

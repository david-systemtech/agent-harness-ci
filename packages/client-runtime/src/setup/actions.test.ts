import { describe, expect, it } from "vitest";
import type { Runtime } from "../runtime.js";
import { SETUP_ACTION_WORDS, outcomeWords, planSetupAction, pullSetupSources, restoreStep, setupActions, updateEnvironment } from "./actions.js";

const skills = { id: "skills", home: "knowledge.skills" } as const;
const sources = [
  { action: "pull-now", kind: "skill-source", id: "source-team", label: "team-skills" },
  { action: "pull-now", kind: "skill-source", id: "source-house", label: "house-skills" },
] as const;

describe("Set up actions on named items", () => {
  it("plans a pull of every named source in one button, excluding other kinds and verbs", () => {
    const targets = [...sources, { action: "update", kind: "tool", id: "gh", label: "gh" }, { action: "pull-now", kind: "account", id: "work", label: "Work" }] as const;
    expect(planSetupAction(skills, "pull-now", targets)).toEqual({ kind: "pull-sources", sources: [{ id: "source-team", label: "team-skills" }, { id: "source-house", label: "house-skills" }] });
    expect(setupActions(skills, { actions: ["pull-now"], targets: sources })).toMatchObject([{ words: "Update now: team-skills, house-skills", plan: { kind: "pull-sources" } }]);
    expect(planSetupAction(skills, "pull-now")).toEqual({ kind: "row", row: "knowledge.skills" });
  });
  it("plans Install and Update for each known tool, naming the tool terminal, and keeps machine updates separate", () => {
    const forges = { id: "forges", home: "access.forges" } as const;
    const targets = [{ action: "update", kind: "tool", id: "gh", label: "gh" }, { action: "update", kind: "tool", id: "bao", label: "bao" }] as const;
    expect(setupActions(forges, { actions: ["update"], targets })).toMatchObject([
      { words: "Update gh in a tool terminal", plan: { kind: "run-tool", tool: "gh", action: "update" } },
      { words: "Update bao in a tool terminal", plan: { kind: "run-tool", tool: "bao", action: "update" } },
    ]);
    expect(planSetupAction(forges, "install", [{ action: "install", kind: "tool", id: "gh", label: "gh" }])).toEqual({ kind: "run-tool", tool: "gh", action: "install" });
    expect(planSetupAction(forges, "update", [{ action: "update", kind: "tool", id: "future-tool", label: "Future" }])).toEqual({ kind: "managed-tools" });
    expect(planSetupAction({ id: "your-machines", home: "environments.machines" }, "update")).toEqual({ kind: "update" });
  });
  it("plans Check certificate for each key-manager connection it names on Key managers, where its certificate check is (#1852)", () => {
    const keyManager = { id: "key-manager", home: "access.key-managers" } as const;
    const target = { action: "check-certificate", kind: "key-manager-connection", id: "connection-1", label: "OpenBao at bao.example.test:8200" } as const;
    expect(setupActions(keyManager, { actions: ["check-again", "check-certificate"], targets: [target] })).toMatchObject([
      { words: "Check again", plan: { kind: "check", step: "key-manager" } },
      { words: "Check certificate: OpenBao at bao.example.test:8200", plan: { kind: "row", row: "access.key-managers" } },
    ]);
  });

  it("plans How to set it up on Your machines as the host updater's setup, and on any other step as its home row (#1883)", () => {
    const machines = { id: "your-machines", home: "environments.machines" } as const;
    expect(setupActions(machines, { actions: ["how-to-set-up", "check-again"] })).toMatchObject([
      { words: "How to set it up", plan: { kind: "host-updater-setup" } },
      { words: "Check again", plan: { kind: "check" } },
    ]);
    expect(planSetupAction(skills, "how-to-set-up")).toEqual({ kind: "row", row: "knowledge.skills" });
  });

  it("offers Choose folders for each collection whose folders moved, one button each, opening Skills where no card carries it out (#1855)", () => {
    const moved = sources.map((source) => ({ ...source, action: "choose-folders" as const }));
    expect(setupActions(skills, { actions: ["choose-folders"], targets: moved })).toMatchObject([
      { key: "choose-folders skill-source source-team", words: "Choose folders: team-skills", targets: [moved[0]], plan: { kind: "row", row: "knowledge.skills" } },
      { key: "choose-folders skill-source source-house", words: "Choose folders: house-skills", targets: [moved[1]], plan: { kind: "row", row: "knowledge.skills" } },
    ]);
  });
});

describe("Set up actions' words (setup-copy.md §3 and the steps)", () => {
  it("names each button by what it does", () => {
    expect(SETUP_ACTION_WORDS).toMatchObject({
      "check-again": "Check again",
      "pull-now": "Update now",
      "import-again": "Bring them over",
      "try-again": "Continue it",
      "start-over": "Start again",
      revise: "Fix the description",
    });
  });
});

/** A runtime whose every request answers `answer`. */
const answering = (answer: unknown): Pick<Runtime, "requests"> => ({ requests: { call: () => Promise.resolve(answer) } as unknown as Runtime["requests"] });
const refused = (code: string, message: string, data?: Record<string, unknown>) => answering({ ok: false, error: { code, message, ...(data && { data }) } });
const rejected = (code: string, message: string, data: Record<string, unknown>) =>
  answering({ ok: true, result: { receipt: { status: "rejected", sequence: 4, changed: false, reason: code, error: { code, message, data } } } });
const NOW = () => new Date("2026-10-08T12:00:00.000Z");

describe("Set up actions' refusals, in plain words", () => {
  it("says an update the environment refused through the refusal mapper, its raw words in Details", async () => {
    expect(await updateEnvironment(rejected("conflict", "laptop is pinned to 0.5.0.", { reason: "pinned" }), "env-a", "laptop", "c-1")).toEqual({
      ok: false,
      line: "This computer is pinned to another version. Change or clear the pin, then choose Update now.",
      details: ["conflict (pinned): laptop is pinned to 0.5.0."],
    });
    expect(await updateEnvironment(refused("timeout", "The environment did not answer updates.apply within 1200 seconds."), "env-a", "laptop", "c-1")).toMatchObject({
      ok: false,
      line: "There was no answer in time. Choose Update now to try again.",
    });
  });

  it("says a refused restore plainly, never the params' or the method's words", async () => {
    const outcome = await restoreStep(refused("invalid_params", "The params are not permissions.denylist.restorePresets's: bad section"), "env-a", "permissions", "c-1");
    expect(outcome).toEqual({
      ok: false,
      line: "agent-harness could not use what was sent. Check what you entered, then choose Restore.",
      details: ["invalid_params: The params are not permissions.denylist.restorePresets's: bad section"],
    });
    expect((await restoreStep(rejected("internal", "disk full", {}), "env-a", "appearance", "c-1")).line).toBe("agent-harness ran into a problem. Choose Restore to try again.");
  });

  it("says each collection's update: a refusal through the mapper, a failed or moved sync in the Skills step's words", async () => {
    const team = [{ id: "source-team", label: "team-skills" }];
    expect(await pullSetupSources(refused("unreachable", "The socket closed (1006) before the environment answered."), "env-a", team, NOW)).toEqual({
      ok: false,
      line: "team-skills: This app cannot reach that computer right now. Choose Update now to try again.",
      details: ["team-skills: unreachable: The socket closed (1006) before the environment answered."],
    });
    const synced = (sync: Record<string, unknown>) => answering({ ok: true, result: { receipt: { status: "applied", sequence: 4, changed: true }, result: { source: { sync } } } });
    expect(await pullSetupSources(synced({ outcome: "failed", line: "git: could not resolve host" }), "env-a", team, NOW)).toEqual({
      ok: false,
      line: "team-skills could not update. Choose Update now.",
      details: ["team-skills: git: could not resolve host"],
    });
    expect((await pullSetupSources(synced({ outcome: "layout_moved" }), "env-a", team, NOW)).line).toBe("team-skills no longer has skills where they were. Choose its folders again.");
    expect(await pullSetupSources(synced({ outcome: "ok" }), "env-a", team, NOW)).toEqual({ ok: true, line: "team-skills is up to date.", details: [] });
  });

  it("says an outcome on one line with its raw words after it as Details, and a line alone when it has none", () => {
    expect(outcomeWords({ ok: false, line: "team-skills could not update. Choose Update now.", details: ["git: could not resolve host", "internal: The disk is full."] })).toBe(
      "team-skills could not update. Choose Update now. Details: git: could not resolve host; internal: The disk is full.",
    );
    expect(outcomeWords({ ok: true, line: "team-skills is up to date.", details: [] })).toBe("team-skills is up to date.");
    expect(outcomeWords({ ok: true, line: "Restored the Default theme." })).toBe("Restored the Default theme.");
  });
});

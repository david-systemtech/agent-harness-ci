import { describe, expect, it } from "vitest";
import { planSetupAction, setupActions } from "./actions.js";

const skills = { id: "skills", home: "knowledge.skills" } as const;
const sources = [
  { action: "pull-now", kind: "skill-source", id: "source-team", label: "team-skills" },
  { action: "pull-now", kind: "skill-source", id: "source-house", label: "house-skills" },
] as const;

describe("Set up actions on named items", () => {
  it("plans a pull of every named source in one button, excluding other kinds and verbs", () => {
    const targets = [...sources, { action: "update", kind: "tool", id: "gh", label: "gh" }, { action: "pull-now", kind: "account", id: "work", label: "Work" }] as const;
    expect(planSetupAction(skills, "pull-now", targets)).toEqual({ kind: "pull-sources", sources: [{ id: "source-team", label: "team-skills" }, { id: "source-house", label: "house-skills" }] });
    expect(setupActions(skills, { actions: ["pull-now"], targets: sources })).toMatchObject([{ words: "Pull now: team-skills, house-skills", plan: { kind: "pull-sources" } }]);
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
});

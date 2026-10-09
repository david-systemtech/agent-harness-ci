import { CONTAINMENT_CAUSES, denylistPresets, type ContainmentCause, type ContainmentReport, type Denylist, type DenylistSection } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { containmentDefaultHolds, denylistHoldsPresets, runsAsNonRoot, type DenylistState } from "./step-checks.js";

/**
 * The Permissions step's three state checks as pure functions (#141): the
 * containment default against the probe's report, the denylist against its
 * presets and who last changed each section, and not-root. The wire tests
 * (`setup/setup.test.ts`) drive them through `setup.check`.
 */

const DATA_DIR = "/home/someone/.local/state/agent-harness";
const PRESETS = denylistPresets(DATA_DIR);
const PERSON = "client_session:3f1c2a4e-0b7d-4e8a-9c61-2d5f7a9e1b33";
const ENVIRONMENT = "system:permissions";

/** A report whose workspace levels are unavailable for `cause`, or available when `cause` is null. */
const reportFor = (cause: ContainmentCause | null, container = false): ContainmentReport => ({
  levels: [
    { level: "off", available: true, reason: null, cause: null },
    ...(["workspace", "workspace-no-network"] as const).map((level) =>
      cause === null ? { level, available: true as const, reason: null, cause: null } : { level, available: false as const, reason: `The probe says no (${cause}).`, cause },
    ),
  ],
  mechanism: cause === null ? "bubblewrap" : null,
  container: { declared: container, detected: container },
});

/** The check's input, open to the edits a test makes. */
type EditableState = { denylist: Denylist; changedBy: Record<DenylistSection, string | null> } & DenylistState;

/** The denylist as seeded, each section last changed by the environment. */
const seeded = (): EditableState => ({
  denylist: structuredClone(PRESETS),
  changedBy: { browserDomains: ENVIRONMENT, paths: ENVIRONMENT, commandPatterns: ENVIRONMENT, hosts: null },
});

describe("the containment default", () => {
  it("holds when the default can be enforced here, off always", () => {
    expect(containmentDefaultHolds("off", reportFor("binary_missing"))).toBe(true);
    expect(containmentDefaultHolds("workspace", reportFor(null))).toBe(true);
    expect(containmentDefaultHolds("workspace-no-network", reportFor(null))).toBe(true);
  });

  it("fails in setup-copy.md §5.12's one line, offering Turn the sandbox off, with the level, the probe's words and its cause in details, for every cause", () => {
    for (const cause of CONTAINMENT_CAUSES) {
      expect(containmentDefaultHolds("workspace", reportFor(cause)), cause).toEqual({
        reason: "The sandbox you chose does not work on this computer yet.",
        details: ["permissions.containment.default: workspace", `Probe: The probe says no (${cause}).`, `Cause: ${cause}`],
        actions: ["turn-sandbox-off"],
      });
    }
  });

  it("keeps what the failing command printed in details, apart from the probe's reason", () => {
    const report = reportFor("apparmor");
    const levels = report.levels.map((level) => (level.available ? level : { ...level, detail: "bwrap: setting up uid map: Permission denied" }));
    expect(containmentDefaultHolds("workspace-no-network", { ...report, levels })).toMatchObject({
      details: ["permissions.containment.default: workspace-no-network", "Probe: The probe says no (apparmor).", "Cause: apparmor", "What it printed: bwrap: setting up uid map: Permission denied"],
    });
  });

  it("fails on a report that does not name the level, as not probed", () => {
    const report: ContainmentReport = { ...reportFor(null), levels: [{ level: "off", available: true, reason: null, cause: null }] };
    expect(containmentDefaultHolds("workspace", report)).toMatchObject({
      reason: "The sandbox you chose does not work on this computer yet.",
      details: ["permissions.containment.default: workspace", "Probe: The containment probe did not report workspace, so it cannot be enforced.", "Cause: not_probed"],
    });
  });
});

describe("the denylist's presets", () => {
  it("hold when every section holds every one of its presets, disabled or edited ones included", () => {
    expect(denylistHoldsPresets(seeded(), PRESETS)).toBe(true);
    const state = seeded();
    state.denylist.paths = state.denylist.paths.map((entry, index) => (index === 0 ? { ...entry, enabled: false } : index === 1 ? { ...entry, pattern: "~/.gnupg/private-keys-v1.d" } : entry));
    state.denylist.hosts = [{ id: "own", pattern: "db.internal", note: "", preset: false, enabled: true }];
    expect(denylistHoldsPresets(state, PRESETS)).toBe(true);
  });

  it("hold for a section a person emptied on purpose, and for hosts, which has no presets", () => {
    const state = seeded();
    state.denylist.browserDomains = [];
    state.changedBy.browserDomains = PERSON;
    expect(denylistHoldsPresets(state, PRESETS)).toBe(true);
  });

  it("fail for a section missing some presets in setup-copy.md §5.12's line, its missing entries in details, three named and the rest counted, with Restore, which names the section as its target", () => {
    const state = seeded();
    state.denylist.paths = state.denylist.paths.slice(0, 11);
    state.changedBy.paths = PERSON;
    expect(denylistHoldsPresets(state, PRESETS)).toEqual({
      reason: "Some built-in entries are missing from the paths always-ask list.",
      details: [`paths: 4 built-in entries are missing: ${PRESETS.paths
        .slice(11, 14)
        .map((entry) => entry.pattern)
        .join(", ")} and 1 more.`],
      targets: [{ action: "restore", kind: "denylist-section", id: "paths", label: "paths" }],
    });
  });

  it("fail for a section that holds none of its presets and was not emptied by a person: never seeded, or emptied by the environment", () => {
    const never: DenylistState = {
      denylist: { browserDomains: [], paths: [], commandPatterns: [], hosts: [] },
      changedBy: { browserDomains: null, paths: null, commandPatterns: null, hosts: null },
    };
    expect(denylistHoldsPresets(never, PRESETS)).toEqual({
      reason: "Some built-in entries are missing from the browser domains, paths and command patterns always-ask lists.",
      details: [
        "browser domains: holds none of its built-in entries, and no person emptied it.",
        "paths: holds none of its built-in entries, and no person emptied it.",
        "command patterns: holds none of its built-in entries, and no person emptied it.",
      ],
      targets: [
        { action: "restore", kind: "denylist-section", id: "browserDomains", label: "browser domains" },
        { action: "restore", kind: "denylist-section", id: "paths", label: "paths" },
        { action: "restore", kind: "denylist-section", id: "commandPatterns", label: "command patterns" },
      ],
    });
    const state = seeded();
    state.denylist.commandPatterns = [];
    expect(denylistHoldsPresets(state, PRESETS)).toEqual({
      reason: "Some built-in entries are missing from the command patterns always-ask list.",
      details: ["command patterns: holds none of its built-in entries, and no person emptied it."],
      targets: [{ action: "restore", kind: "denylist-section", id: "commandPatterns", label: "command patterns" }],
    });
  });

  it("reads a preset by its id, so the data directory's entry counts as held wherever it points", () => {
    const moved: Denylist = denylistPresets("/srv/elsewhere");
    expect(denylistHoldsPresets(seeded(), moved)).toBe(true);
  });
});

describe("not root", () => {
  it("holds unless permissions.settings.get says the environment runs as root, said as setup-copy.md §5.4's root line with the facts in details", () => {
    expect(runsAsNonRoot(false)).toBe(true);
    expect(runsAsNonRoot(true)).toEqual({
      reason: "agent-harness runs as the administrator (root) account, which is unsafe. Restart it as your own user.",
      details: ["isRoot: true", "agent-harness serve refuses root; in a container, run it as the image's non-root USER."],
    });
  });
});

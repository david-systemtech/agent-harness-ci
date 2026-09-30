import { CONTAINMENT_CAUSES, denylistPresets, type ContainmentCause, type ContainmentReport, type Denylist, type DenylistSection } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { CONTAINMENT_LINUX_HINT, containmentDefaultHolds, denylistHoldsPresets, runsAsNonRoot, type DenylistState } from "./step-checks.js";

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
/** The causes the probe finds on the machine, which a package or a setting there can remove. */
const MACHINE_CAUSES = ["binary_missing", "socat_missing", "userns_blocked", "apparmor", "seccomp", "failed"] as const;

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

  it("fails naming the level and the probe's reason, with the Linux package hint for each cause the machine can fix", () => {
    for (const cause of MACHINE_CAUSES) {
      const answer = containmentDefaultHolds("workspace", reportFor(cause));
      expect(answer, cause).toEqual({ reason: expect.stringContaining(`The containment default workspace cannot be enforced here: The probe says no (${cause}). ${CONTAINMENT_LINUX_HINT}`) as unknown as string });
    }
    expect(CONTAINMENT_LINUX_HINT).toBe(
      "On Linux, install the bubblewrap and socat packages (sudo apt-get install bubblewrap socat); on Ubuntu 24.04 and later, where AppArmor restricts unprivileged user namespaces, also add an AppArmor profile that grants bwrap userns (/etc/apparmor.d/bwrap, as Claude Code's sandboxing documentation gives it) and reload AppArmor. Then restart the environment, which probes containment as it starts.",
    );
  });

  it("adds the seccomp profile a container needs when seccomp refused the namespace", () => {
    const answer = containmentDefaultHolds("workspace", reportFor("seccomp", true));
    expect(answer).toEqual({ reason: expect.stringMatching(/restart the environment, which probes containment as it starts\. In a container, start it with a seccomp profile that allows unshare\(CLONE_NEWUSER\)\.$/) as unknown as string });
  });

  it("gives no package hint where no package helps: the adapter, the platform, a probe that failed or never ran", () => {
    const without = ["adapter", "platform", "probe_failed", "not_probed"] as const;
    for (const cause of without) {
      expect(containmentDefaultHolds("workspace", reportFor(cause)), cause).toEqual({
        reason: `The containment default workspace cannot be enforced here: The probe says no (${cause}).`,
      });
    }
    // Every cause is in one list or the other: a new one fails here until it is placed.
    expect(new Set([...MACHINE_CAUSES, ...without])).toEqual(new Set(CONTAINMENT_CAUSES));
  });

  it("fails on a report that does not name the level, as not probed", () => {
    const report: ContainmentReport = { ...reportFor(null), levels: [{ level: "off", available: true, reason: null, cause: null }] };
    expect(containmentDefaultHolds("workspace", report)).toEqual({ reason: expect.stringMatching(/^The containment default workspace cannot be enforced here: The containment probe did not report workspace/) as unknown as string });
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

  it("fail for a section missing some presets, naming three and counting the rest, with Restore, which names the section as its target", () => {
    const state = seeded();
    state.denylist.paths = state.denylist.paths.slice(0, 11);
    state.changedBy.paths = PERSON;
    expect(denylistHoldsPresets(state, PRESETS)).toEqual({
      reason: `The paths section of the denylist is missing 4 of its presets (${PRESETS.paths
        .slice(11, 14)
        .map((entry) => entry.pattern)
        .join(", ")} and 1 more); Restore puts them back.`,
      targets: [{ action: "restore", kind: "denylist-section", id: "paths", label: "paths" }],
    });
  });

  it("fail for a section that holds none of its presets and was not emptied by a person: never seeded, or emptied by the environment", () => {
    const never: DenylistState = {
      denylist: { browserDomains: [], paths: [], commandPatterns: [], hosts: [] },
      changedBy: { browserDomains: null, paths: null, commandPatterns: null, hosts: null },
    };
    expect(denylistHoldsPresets(never, PRESETS)).toEqual({
      reason:
        "The browser domains section of the denylist holds none of its presets, and no person emptied it; Restore puts them back. The paths section of the denylist holds none of its presets, and no person emptied it; Restore puts them back. The command patterns section of the denylist holds none of its presets, and no person emptied it; Restore puts them back.",
      targets: [
        { action: "restore", kind: "denylist-section", id: "browserDomains", label: "browser domains" },
        { action: "restore", kind: "denylist-section", id: "paths", label: "paths" },
        { action: "restore", kind: "denylist-section", id: "commandPatterns", label: "command patterns" },
      ],
    });
    const state = seeded();
    state.denylist.commandPatterns = [];
    expect(denylistHoldsPresets(state, PRESETS)).toEqual({
      reason: "The command patterns section of the denylist holds none of its presets, and no person emptied it; Restore puts them back.",
      targets: [{ action: "restore", kind: "denylist-section", id: "commandPatterns", label: "command patterns" }],
    });
  });

  it("reads a preset by its id, so the data directory's entry counts as held wherever it points", () => {
    const moved: Denylist = denylistPresets("/srv/elsewhere");
    expect(denylistHoldsPresets(seeded(), moved)).toBe(true);
  });
});

describe("not root", () => {
  it("holds unless permissions.settings.get says the environment runs as root", () => {
    expect(runsAsNonRoot(false)).toBe(true);
    expect(runsAsNonRoot(true)).toEqual({ reason: "The environment runs as root, which it must never do: start it as an ordinary user (the container's non-root USER)." });
  });
});

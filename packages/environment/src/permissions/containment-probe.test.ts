import { describe, expect, it } from "vitest";
import { CONTAINER_MARKER_VARIABLE, probeContainment, type ContainmentProbe, type ProbeSystem } from "./containment-probe.js";

/**
 * The containment prober (permissions spec, "Mechanisms and the probe"),
 * with the machine scripted: what is on the PATH, what each command answers,
 * what the kernel's files say. Every outcome the probe can record is a case
 * here; the real machine is probed once, at startup, and never by a test.
 */

interface Scripted {
  readonly platform?: NodeJS.Platform;
  readonly env?: Record<string, string>;
  /** Commands on the PATH, by name. */
  readonly path?: readonly string[];
  /** What running a command answers, by its file; preset: success. */
  readonly answers?: Record<string, (args: readonly string[]) => { code: number | null; output: string }>;
  /** Files and their text. */
  readonly files?: Record<string, string>;
}

const OK = { code: 0, output: "" };

/** A scripted machine, recording every command it was asked to run. */
const machine = (scripted: Scripted = {}) => {
  const ran: string[][] = [];
  const system: ProbeSystem = {
    platform: scripted.platform ?? "linux",
    env: scripted.env ?? {},
    which: (name) => ((scripted.path ?? []).includes(name) ? `/usr/bin/${name}` : null),
    run: async (file, args) => {
      ran.push([file, ...args]);
      const name = file.split("/").pop() ?? file;
      return scripted.answers?.[name]?.(args) ?? OK;
    },
    exists: (path) => scripted.files?.[path] !== undefined,
    read: (path) => scripted.files?.[path],
  };
  return { system, ran };
};

const LINUX_TOOLS = ["bwrap", "socat", "unshare"];
const EPERM = { code: 1, output: "bwrap: setting up uid map: Permission denied\n" };
const UNSHARE_EPERM = { code: 1, output: "unshare: unshare failed: Operation not permitted\n" };

const both = (probe: ContainmentProbe) => [probe.levels.workspace, probe.levels["workspace-no-network"]];

describe("the containment probe on Linux and WSL2", () => {
  it("offers both workspace levels through bubblewrap when bwrap runs a trivial command in an unshared user namespace with a read-only root, and socat is there", async () => {
    const { system, ran } = machine({ path: LINUX_TOOLS });
    const probe = await probeContainment(system);
    expect(probe).toEqual({
      mechanism: "bubblewrap",
      levels: {
        workspace: { available: true, reason: null, cause: null },
        "workspace-no-network": { available: true, reason: null, cause: null },
      },
      container: { declared: false, detected: false },
    });
    expect(ran).toEqual([
      ["/usr/bin/bwrap", "--unshare-user", "--ro-bind", "/", "/", "--", "true"],
      ["/usr/bin/bwrap", "--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "--", "true"],
    ]);
  });

  it("records bubblewrap missing when bwrap is not on the PATH, and offers neither level", async () => {
    const { system, ran } = machine({ path: ["socat"] });
    const probe = await probeContainment(system);
    expect(probe.mechanism).toBeNull();
    for (const level of both(probe)) {
      expect(level).toMatchObject({ available: false, cause: "binary_missing" });
      expect(level.reason).toMatch(/bwrap/);
    }
    expect(ran).toEqual([]);
  });

  it("says, with bwrap missing, when user namespaces are refused here too, so installing it would not be enough", async () => {
    const { system, ran } = machine({
      path: ["unshare"],
      answers: { unshare: () => UNSHARE_EPERM },
      files: { "/.dockerenv": "", "/proc/self/status": "Name:\tnode\nSeccomp:\t2\nSeccomp_filters:\t1\n", "/proc/sys/user/max_user_namespaces": "255810\n" },
    });
    const probe = await probeContainment(system);
    expect(ran).toEqual([["/usr/bin/unshare", "--user", "--map-root-user", "true"]]);
    expect(probe.levels.workspace).toMatchObject({ available: false, cause: "binary_missing" });
    expect(probe.levels.workspace.reason).toMatch(/not be enough/);
    expect(probe.levels.workspace.reason).toMatch(/seccomp/);
    expect(probe.levels.workspace.reason).toMatch(/socat/);
    expect(probe.container).toEqual({ declared: false, detected: true });
  });

  it("records user namespaces blocked by the kernel", async () => {
    for (const files of [{ "/proc/sys/kernel/unprivileged_userns_clone": "0\n" }, { "/proc/sys/user/max_user_namespaces": "0\n" }]) {
      const { system } = machine({ path: LINUX_TOOLS, answers: { bwrap: () => EPERM }, files });
      const probe = await probeContainment(system);
      expect(probe.mechanism, JSON.stringify(files)).toBeNull();
      for (const level of both(probe)) expect(level, JSON.stringify(files)).toMatchObject({ available: false, cause: "userns_blocked" });
      expect(probe.levels.workspace.reason).toMatch(/kernel/);
      expect(probe.levels.workspace.reason).toMatch(/setting up uid map/);
    }
  });

  it("records AppArmor's restriction of unprivileged user namespaces, as on Ubuntu 24.04", async () => {
    const { system } = machine({ path: LINUX_TOOLS, answers: { bwrap: () => EPERM }, files: { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n" } });
    const probe = await probeContainment(system);
    for (const level of both(probe)) expect(level).toMatchObject({ available: false, cause: "apparmor" });
    expect(probe.levels.workspace.reason).toMatch(/AppArmor/);
  });

  it("records the container's seccomp profile refusing user namespaces, and reports the container as the outer boundary", async () => {
    const { system } = machine({
      path: LINUX_TOOLS,
      env: { [CONTAINER_MARKER_VARIABLE]: "1" },
      answers: { bwrap: () => ({ code: 1, output: "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.\n" }) },
      files: { "/run/.containerenv": "", "/proc/self/status": "Seccomp:\t2\n" },
    });
    const probe = await probeContainment(system);
    for (const level of both(probe)) expect(level).toMatchObject({ available: false, cause: "seccomp" });
    expect(probe.levels.workspace.reason).toMatch(/container's seccomp profile/);
    expect(probe.levels.workspace.reason).toMatch(/outer boundary/);
    expect(probe.container).toEqual({ declared: true, detected: true });
  });

  it("records any other bwrap failure with what bwrap said", async () => {
    const { system } = machine({ path: LINUX_TOOLS, answers: { bwrap: () => ({ code: 1, output: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n" }) } });
    const probe = await probeContainment(system);
    for (const level of both(probe)) expect(level).toMatchObject({ available: false, cause: "failed" });
    expect(probe.levels.workspace.reason).toMatch(/Can't mount proc/);
  });

  it("records a bwrap that cannot be started at all as a failure", async () => {
    const { system } = machine({ path: LINUX_TOOLS, answers: { bwrap: () => ({ code: null, output: "spawn /usr/bin/bwrap EACCES" }) } });
    const probe = await probeContainment(system);
    expect(probe.levels.workspace).toMatchObject({ available: false, cause: "failed" });
    expect(probe.levels.workspace.reason).toMatch(/EACCES/);
  });

  it("records socat missing, which Claude's sandbox needs on Linux beside bubblewrap, and offers neither level", async () => {
    const { system, ran } = machine({ path: ["bwrap"] });
    const probe = await probeContainment(system);
    expect(probe.mechanism).toBeNull();
    for (const level of both(probe)) {
      expect(level).toMatchObject({ available: false, cause: "socat_missing" });
      expect(level.reason).toMatch(/socat/);
    }
    // The user namespace was still tried, so a second problem would be named too.
    expect(ran[0]).toEqual(["/usr/bin/bwrap", "--unshare-user", "--ro-bind", "/", "/", "--", "true"]);
  });

  it("names every problem it found: a bwrap failure and socat missing both", async () => {
    const { system } = machine({ path: ["bwrap"], answers: { bwrap: () => EPERM }, files: { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1" } });
    const probe = await probeContainment(system);
    expect(probe.levels.workspace).toMatchObject({ available: false, cause: "apparmor" });
    expect(probe.levels.workspace.reason).toMatch(/AppArmor/);
    expect(probe.levels.workspace.reason).toMatch(/socat/);
  });

  it("offers workspace without no-network when bubblewrap cannot unshare the network namespace", async () => {
    const { system } = machine({
      path: LINUX_TOOLS,
      answers: { bwrap: (args) => (args.includes("--unshare-net") ? { code: 1, output: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n" } : OK) },
    });
    const probe = await probeContainment(system);
    expect(probe.mechanism).toBe("bubblewrap");
    expect(probe.levels.workspace).toEqual({ available: true, reason: null, cause: null });
    expect(probe.levels["workspace-no-network"]).toMatchObject({ available: false, cause: "failed" });
    expect(probe.levels["workspace-no-network"].reason).toMatch(/network/);
    expect(probe.levels["workspace-no-network"].reason).toMatch(/RTM_NEWADDR/);
  });

  it("offers a level inside a container when bubblewrap works there: the container enforces nothing, and prevents nothing", async () => {
    const { system } = machine({ path: LINUX_TOOLS, files: { "/.dockerenv": "" } });
    const probe = await probeContainment(system);
    expect(probe.mechanism).toBe("bubblewrap");
    expect(probe.levels.workspace.available).toBe(true);
    expect(probe.container).toEqual({ declared: false, detected: true });
  });

  it("detects a container by PID 1's cgroup when no marker file is there, and a declared one by the compose's marker variable alone", async () => {
    const byCgroup = await probeContainment(machine({ path: LINUX_TOOLS, files: { "/proc/1/cgroup": "0::/docker/0123abcd\n" } }).system);
    expect(byCgroup.container).toEqual({ declared: false, detected: true });
    const declared = await probeContainment(machine({ path: LINUX_TOOLS, env: { [CONTAINER_MARKER_VARIABLE]: "1" } }).system);
    expect(declared.container).toEqual({ declared: true, detected: false });
    const empty = await probeContainment(machine({ path: LINUX_TOOLS, env: { [CONTAINER_MARKER_VARIABLE]: "" } }).system);
    expect(empty.container.declared).toBe(false);
  });
});

describe("the containment probe on macOS", () => {
  it("offers both levels through Seatbelt when sandbox-exec runs a trivial command under a profile that denies the network", async () => {
    const { system, ran } = machine({ platform: "darwin", path: ["sandbox-exec"] });
    const probe = await probeContainment(system);
    expect(probe).toEqual({
      mechanism: "seatbelt",
      levels: {
        workspace: { available: true, reason: null, cause: null },
        "workspace-no-network": { available: true, reason: null, cause: null },
      },
      container: { declared: false, detected: false },
    });
    expect(ran).toEqual([["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"]]);
  });

  it("records sandbox-exec missing, and a Seatbelt that fails with what it said", async () => {
    const missing = await probeContainment(machine({ platform: "darwin" }).system);
    expect(missing.mechanism).toBeNull();
    for (const level of both(missing)) expect(level).toMatchObject({ available: false, cause: "binary_missing" });
    const failing = await probeContainment(machine({ platform: "darwin", path: ["sandbox-exec"], answers: { "sandbox-exec": () => ({ code: 71, output: "sandbox-exec: sandbox_apply: Operation not permitted\n" }) } }).system);
    for (const level of both(failing)) expect(level).toMatchObject({ available: false, cause: "failed" });
    expect(failing.levels.workspace.reason).toMatch(/sandbox_apply/);
  });
});

describe("the containment probe elsewhere", () => {
  it("reports none on native Windows, pointing at WSL2, and runs nothing", async () => {
    const { system, ran } = machine({ platform: "win32", path: LINUX_TOOLS });
    const probe = await probeContainment(system);
    expect(probe.mechanism).toBeNull();
    for (const level of both(probe)) expect(level).toMatchObject({ available: false, cause: "platform" });
    expect(probe.levels.workspace.reason).toMatch(/WSL2/);
    expect(ran).toEqual([]);
  });

  it("reports none on a platform with no mechanism the harness supports", async () => {
    const probe = await probeContainment(machine({ platform: "freebsd" }).system);
    expect(probe.mechanism).toBeNull();
    expect(probe.levels.workspace).toMatchObject({ available: false, cause: "platform" });
    expect(probe.levels.workspace.reason).toMatch(/freebsd/);
  });
});

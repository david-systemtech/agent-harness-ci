import { describe, expect, it } from "vitest";
import { CONTAINER_MARKER_VARIABLE, processContainerDetector } from "./container.js";

describe("the container detector", () => {
  it("finds a container from its runtime's marker files, or a container runtime in PID 1's cgroup", () => {
    const probe = (files: Record<string, string>) =>
      processContainerDetector({ exists: (path) => path in files, read: (path) => files[path] });
    expect(probe({ "/.dockerenv": "" }).inContainer()).toBe(true);
    expect(probe({ "/run/.containerenv": "" }).inContainer()).toBe(true);
    expect(probe({ "/proc/1/cgroup": "0::/kubepods/besteffort/pod1\n" }).inContainer()).toBe(true);
    expect(probe({ "/proc/1/cgroup": "12:pids:/docker/abc\n" }).inContainer()).toBe(true);
    expect(probe({ "/proc/1/cgroup": "0::/init.scope\n" }).inContainer()).toBe(false);
    expect(probe({}).inContainer()).toBe(false);
  });

  it("takes a container the install declared (its compose sets AGENT_HARNESS_CONTAINER) for one, as the containment probe does", () => {
    const declared = (value: string | undefined) =>
      processContainerDetector({ exists: () => false, read: () => undefined, env: { [CONTAINER_MARKER_VARIABLE]: value } }).inContainer();
    expect(CONTAINER_MARKER_VARIABLE).toBe("AGENT_HARNESS_CONTAINER");
    expect(declared("1")).toBe(true);
    expect(declared("")).toBe(false);
    expect(declared(undefined)).toBe(false);
  });

  it("says a container was declared only when the install declared it, not when a runtime left its trace", () => {
    const detector = (env: Record<string, string>, files: Record<string, string>) =>
      processContainerDetector({ exists: (path) => path in files, read: (path) => files[path], env });
    expect(detector({ [CONTAINER_MARKER_VARIABLE]: "1" }, {}).declared?.()).toBe(true);
    expect(detector({ [CONTAINER_MARKER_VARIABLE]: " " }, { "/.dockerenv": "" }).declared?.()).toBe(false);
    expect(detector({}, { "/.dockerenv": "" }).declared?.()).toBe(false);
  });
});

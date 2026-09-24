import { describe, expect, it } from "vitest";
import { processContainerDetector } from "./container.js";

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
});

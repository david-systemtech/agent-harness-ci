import { describe, expect, it } from "vitest";
import { releaseRunOf } from "./run.js";

describe("a GitHub release run", () => {
  it.each([
    ["refs/tags/v1.2.3", { tag: "v1.2.3", version: "1.2.3", prerelease: false, publish: true }],
    ["refs/tags/v1.2.3-beta.2", { tag: "v1.2.3-beta.2", version: "1.2.3-beta.2", prerelease: true, publish: true }],
  ])("takes the version and prerelease flag from %s", (ref, expected) => {
    expect(releaseRunOf({ GITHUB_EVENT_NAME: "push", GITHUB_REF: ref })).toEqual(expected);
  });

  it("builds a synthetic prerelease on manual dispatch even when dispatching a stable tag, without publishing", () => {
    expect(releaseRunOf({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/v1.2.3", GITHUB_RUN_NUMBER: "42" })).toEqual({
      tag: "v0.0.0-ci.42", version: "0.0.0-ci.42", prerelease: true, publish: false,
    });
  });

  it("builds a synthetic prerelease without publishing when a main merge's smoke calls it, whatever the caller's event (#1769)", () => {
    for (const event of ["repository_dispatch", "push"]) {
      expect(releaseRunOf({ GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/workflows", GITHUB_RUN_NUMBER: "7", RELEASE_SMOKE_SHA: "a".repeat(40) })).toEqual({
        tag: "v0.0.0-ci.7", version: "0.0.0-ci.7", prerelease: true, publish: false,
      });
    }
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "repository_dispatch", RELEASE_SMOKE_SHA: "a".repeat(40) })).toThrow();
  });

  it.each(["refs/heads/main", "refs/tags/1.2.3", "refs/tags/v01.2.3", "refs/tags/v1.2", "refs/tags/v1.2.3-beta.01", "refs/tags/v1.2.3+build.1"])("refuses %s before building or pushing an image", (ref) => {
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "push", GITHUB_REF: ref })).toThrow();
  });

  it("refuses unsupported events and a dispatch without a run number", () => {
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "pull_request" })).toThrow();
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "workflow_dispatch" })).toThrow();
  });
});

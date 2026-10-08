import { describe, expect, it } from "vitest";
import { publishedTagsOf, releaseRunOf, syntheticTag } from "./run.js";

/** What a tag's run is handed for the published releases: a tag's version never depends on them. */
const unread = (): never => {
  throw new Error("A tag's push must not read the published releases.");
};

describe("a GitHub release run", () => {
  it.each([
    ["refs/tags/v1.2.3", { tag: "v1.2.3", version: "1.2.3", prerelease: false, publish: true }],
    ["refs/tags/v1.2.3-beta.2", { tag: "v1.2.3-beta.2", version: "1.2.3-beta.2", prerelease: true, publish: true }],
  ])("takes the version and prerelease flag from %s, without reading the published releases", (ref, expected) => {
    expect(releaseRunOf({ GITHUB_EVENT_NAME: "push", GITHUB_REF: ref }, unread)).toEqual(expected);
  });

  it("builds a synthetic prerelease on manual dispatch even when dispatching a stable tag, without publishing", () => {
    expect(releaseRunOf({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/v1.2.3", GITHUB_RUN_NUMBER: "42" }, () => [])).toEqual({
      tag: "v0.0.0-ci.42", version: "0.0.0-ci.42", prerelease: true, publish: false,
    });
  });

  it("builds a synthetic prerelease without publishing when a main merge's smoke calls it, whatever the caller's event (#1769)", () => {
    for (const event of ["repository_dispatch", "push"]) {
      expect(releaseRunOf({ GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/workflows", GITHUB_RUN_NUMBER: "7", RELEASE_SMOKE_SHA: "a".repeat(40) }, () => [])).toEqual({
        tag: "v0.0.0-ci.7", version: "0.0.0-ci.7", prerelease: true, publish: false,
      });
    }
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "repository_dispatch", RELEASE_SMOKE_SHA: "a".repeat(40) }, () => [])).toThrow();
  });

  it("builds a dry run above every published release, so the build under test takes none as its update (#1880)", () => {
    const published = () => ["v0.1.1", "v0.1.8", "v0.1.5"];
    expect(releaseRunOf({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/workflows", GITHUB_RUN_NUMBER: "38", RELEASE_SMOKE_SHA: "a".repeat(40) }, published)).toEqual({
      tag: "v0.1.9-ci.38", version: "0.1.9-ci.38", prerelease: true, publish: false,
    });
    expect(releaseRunOf({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/v0.1.8", GITHUB_RUN_NUMBER: "4" }, published).version).toBe("0.1.9-ci.4");
  });

  it("fails a dry run before any build when the published releases cannot be read (#1880)", () => {
    expect(() =>
      releaseRunOf({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_NUMBER: "4" }, () => {
        throw new Error("ls-remote failed");
      }),
    ).toThrow("ls-remote failed");
  });

  it.each(["refs/heads/main", "refs/tags/1.2.3", "refs/tags/v01.2.3", "refs/tags/v1.2", "refs/tags/v1.2.3-beta.01", "refs/tags/v1.2.3+build.1"])("refuses %s before building or pushing an image", (ref) => {
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "push", GITHUB_REF: ref }, unread)).toThrow();
  });

  it("refuses unsupported events and a dispatch without a run number", () => {
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "pull_request" }, unread)).toThrow();
    expect(() => releaseRunOf({ GITHUB_EVENT_NAME: "workflow_dispatch" }, () => [])).toThrow();
  });
});

describe("a dry run's synthetic tag (#1880)", () => {
  it("is 0.0.0's while no release is published", () => {
    expect(syntheticTag([], "7")).toBe("v0.0.0-ci.7");
  });

  it("is a prerelease of the patch after the newest stable release, by SemVer precedence rather than tag order", () => {
    expect(syntheticTag(["v0.9.0", "v0.10.2", "v0.10.10"], "3")).toBe("v0.10.11-ci.3");
    expect(syntheticTag(["v1.0.0"], "12")).toBe("v1.0.1-ci.12");
    expect(syntheticTag(["v0.4.0+build.1"], "2")).toBe("v0.4.1-ci.2");
  });

  it("is above a newest prerelease and above the release that prerelease leads to", () => {
    expect(syntheticTag(["v0.1.8", "v0.2.0-beta.2"], "5")).toBe("v0.2.1-ci.5");
  });

  it("passes over tags that name no release version", () => {
    expect(syntheticTag(["latest", "v1", "v01.2.3", "1.4.0", "v0.3.0"], "9")).toBe("v0.3.1-ci.9");
    expect(syntheticTag(["latest"], "9")).toBe("v0.0.0-ci.9");
  });
});

describe("the published tags git ls-remote lists", () => {
  it("are the tag names of its refs/tags lines", () => {
    const listed = [`${"a".repeat(40)}\trefs/tags/v0.1.1`, `${"b".repeat(40)}\trefs/tags/v0.1.8`, `${"c".repeat(40)}\trefs/heads/main`, ""].join("\n");
    expect(publishedTagsOf(listed)).toEqual(["v0.1.1", "v0.1.8"]);
  });
});

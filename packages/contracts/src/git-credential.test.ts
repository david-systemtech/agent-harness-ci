import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_ADDRESS_VARIABLE,
  ForgeAccountMissingError,
  GIT_CREDENTIAL_PATH,
  GIT_CREDENTIAL_TIMEOUT_MS,
  GitCredentialAnswer,
  GitCredentialError,
  GitCredentialRequest,
  RUN_SECRET_VARIABLE,
} from "./index.js";

/**
 * The credential route and git's credential helper (forge spec, "The helper
 * and the credential route"; ADR 0020; #314): where the helper finds the
 * environment and its run-scoped secret, what it posts, what the route
 * answers, and the refusal a harness operation makes on an origin no forge
 * account covers.
 */

describe("the credential route", () => {
  it("is POST /api/internal/git-credential, and the helper gives it fifteen seconds", () => {
    expect(GIT_CREDENTIAL_PATH).toBe("/api/internal/git-credential");
    expect(GIT_CREDENTIAL_TIMEOUT_MS).toBe(15_000);
  });

  it("is found through two process-only variables: the environment's loopback address and the run-scoped secret", () => {
    expect(ENVIRONMENT_ADDRESS_VARIABLE).toBe("AGENT_HARNESS_ADDRESS");
    expect(RUN_SECRET_VARIABLE).toBe("AGENT_HARNESS_RUN_SECRET");
    // The Claude adapter's scrub removes every name holding _TOKEN: neither may.
    expect(`${ENVIRONMENT_ADDRESS_VARIABLE} ${RUN_SECRET_VARIABLE}`).not.toContain("_TOKEN");
  });

  it("takes git's verb, the helper's slug and git's protocol and host, and nothing of a password", () => {
    const get = { action: "get", slug: "git_systemtech_dev", protocol: "https", host: "git.systemtech.dev:5526" };
    expect(GitCredentialRequest.parse(get)).toEqual(get);
    expect(GitCredentialRequest.parse({ ...get, action: "erase", protocol: "http", host: "100.64.0.7:3000" })).toMatchObject({ action: "erase" });
    for (const invalid of [
      { ...get, action: "store" },
      { ...get, protocol: "ssh" },
      { ...get, slug: "Not A Slug" },
      { ...get, host: "" },
      { ...get, host: "git.systemtech.dev/david" },
      { ...get, host: "david@git.systemtech.dev" },
      { ...get, password: "token-for-tests" },
    ]) {
      expect(GitCredentialRequest.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it("answers git's username and password, each one line", () => {
    const answer = { username: "x-access-token", password: "token-for-tests" };
    expect(GitCredentialAnswer.parse(answer)).toEqual(answer);
    expect(GitCredentialAnswer.safeParse({ ...answer, password: "token\nquit=1" }).success).toBe(false);
    expect(GitCredentialAnswer.safeParse({ ...answer, username: "" }).success).toBe(false);
  });

  it("refuses unauthorized, rate_limited, invalid_params, credential_unavailable naming the origin, or internal", () => {
    const refusal = (code: string, data: Record<string, unknown>) => GitCredentialError.safeParse({ code, message: "m", data }).success;
    expect(refusal("unauthorized", {})).toBe(true);
    expect(refusal("rate_limited", { retryAfterMs: 400 })).toBe(true);
    expect(refusal("invalid_params", { issues: [] })).toBe(true);
    expect(refusal("credential_unavailable", { origin: "https://github.com" })).toBe(true);
    expect(refusal("credential_unavailable", {})).toBe(false);
    expect(refusal("internal", {})).toBe(true);
    expect(refusal("forbidden", { scope: "admin" })).toBe(false);
  });
});

describe("forge_account_missing", () => {
  it("names the origin no forge account covers and the Forges step to deep-link", () => {
    const error = { code: "forge_account_missing", message: "m", data: { origin: "https://codeberg.org", step: "forges" } };
    expect(ForgeAccountMissingError.parse(error)).toEqual(error);
    expect(ForgeAccountMissingError.safeParse({ ...error, data: { origin: "https://codeberg.org", step: "memory-bank" } }).success).toBe(false);
    expect(ForgeAccountMissingError.safeParse({ ...error, data: { step: "forges" } }).success).toBe(false);
  });
});

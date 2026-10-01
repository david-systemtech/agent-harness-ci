import { describe, expect, it } from "vitest";
import { AuthExpiredError, RateLimitExceededError, serviceAccountToken } from "../../test/fake-onepassword.js";
import { accountUrlOf, onePasswordFailure } from "./onepassword.js";

/**
 * Below the in-process seam (#378): reading the account URL a 1Password
 * service-account token names, and sorting what the SDK throws into the
 * provider's categories, with the SDK's own messages and error classes'
 * names. The tokens are built at run time; none is a real one.
 */

describe("the account URL a service-account token names", () => {
  it("is its sign-in address as an https origin, kept in lower case", () => {
    expect(accountUrlOf(serviceAccountToken())).toBe("https://example.1password.com");
    expect(accountUrlOf(serviceAccountToken("team", "Team.1Password.EU"))).toBe("https://team.1password.eu");
  });

  it("is none for anything that is no service-account token", () => {
    const encoded = (payload: unknown): string => ["ops", "_", Buffer.from(JSON.stringify(payload)).toString("base64")].join("");
    for (const token of ["token-for-tests", "ops_not-base64-json", encoded({ email: "agents@example.test" }), encoded({ signInAddress: "https://example.1password.com/path" }), encoded("text")]) {
      expect(accountUrlOf(token), token).toBeNull();
    }
  });
});

describe("an SDK failure", () => {
  it.each([
    [new RateLimitExceededError("too many requests"), "rate-limited"],
    [new Error("rate limit exceeded"), "rate-limited"],
    [new AuthExpiredError("the session expired"), "credential-rejected"],
    [new Error("bad service account token, please rotate it: revoked"), "credential-rejected"],
    [new Error("you are not authenticated"), "credential-rejected"],
    [new Error("you don't have the right permissions to access this resource"), "denied"],
    [new Error("error resolving secret reference: no vault matched the secret reference query"), "not-found"],
    [new Error("error resolving secret reference: the specified field cannot be found within the item"), "not-found"],
    [new Error("resource not found"), "not-found"],
    [new Error("error sending request for url (https://example.1password.com/api/v1/vaults)"), "unreachable"],
    [new Error("request timeout"), "unreachable"],
  ] as const)("%s is %s", (error, outcome) => {
    expect(onePasswordFailure("Listing the vaults", error)).toEqual({ outcome, message: `Listing the vaults failed: ${error.message}` });
  });
});

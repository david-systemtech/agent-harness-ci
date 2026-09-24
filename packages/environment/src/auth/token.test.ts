import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readToken, signToken, type TokenClaims } from "./token.js";

const key = randomBytes(32);
const claims: TokenClaims = {
  sid: "0f8fad5b-d9cb-469f-a165-70867728950e",
  env: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  iat: Date.parse("2026-09-24T00:00:00.000Z"),
};

describe("client session tokens", () => {
  it("read back the claims they were signed with, under the same key", () => {
    expect(readToken(key, signToken(key, claims))).toEqual(claims);
  });

  it("carry only the client session, the environment and when they were issued: the table holds the rest", () => {
    const [, payload] = signToken(key, claims).split(".") as [string, string, string];
    expect(Object.keys(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as object).sort()).toEqual(["env", "iat", "sid"]);
  });

  it("are three base64url parts with the version first, and nothing a URL would escape", () => {
    expect(signToken(key, claims)).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("are refused under another key", () => {
    expect(readToken(randomBytes(32), signToken(key, claims))).toBeUndefined();
  });

  it("are refused when any part is changed", () => {
    const [version, payload, signature] = signToken(key, claims).split(".") as [string, string, string];
    const otherPayload = Buffer.from(JSON.stringify({ ...claims, sid: "another" })).toString("base64url");
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    for (const token of [
      `v2.${payload}.${signature}`,
      `${version}.${otherPayload}.${signature}`,
      `${version}.${payload}.${flipped}`,
      `${version}.${payload}`,
      `${version}.${payload}.${signature}.extra`,
      "",
    ]) {
      expect(readToken(key, token), token).toBeUndefined();
    }
  });

  it("are refused when the signature is right but the claims are not claims", () => {
    for (const bad of [{ ...claims, sid: "" }, { ...claims, env: "not-a-uuid" }, { ...claims, iat: "now" }, { ...claims, iat: -1 }, "text"]) {
      expect(readToken(key, signToken(key, bad as TokenClaims)), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

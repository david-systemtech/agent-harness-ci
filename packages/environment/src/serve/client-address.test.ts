import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { forwardedClientAddress, peerAddress } from "./client-address.js";

const WEB_ORIGIN = "https://web.example:8443";

const request = (remoteAddress: string | undefined, headers: Record<string, string | string[]>): IncomingMessage =>
  ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

const proxied = (headers: Record<string, string | string[]> = {}) =>
  request("127.0.0.1", { host: "web.example:8443", ...headers });

describe("the client address behind the HTTPS origin", () => {
  const resolve = forwardedClientAddress(WEB_ORIGIN);

  it("takes X-Forwarded-For and the Tailscale login from loopback when the Host is the web origin", () => {
    expect(resolve(proxied({ "x-forwarded-for": "100.64.0.7", "tailscale-user-login": "owner@example.test" }))).toEqual({
      address: "100.64.0.7",
      login: "owner@example.test",
    });
    expect(resolve(request("::ffff:127.0.0.1", { host: "WEB.example", "x-forwarded-for": "fd7a:115c:a1e0::7" }))).toEqual({ address: "fd7a:115c:a1e0::7" });
  });

  it("takes the last X-Forwarded-For entry, the one the proxy wrote, not one a client sent ahead of it", () => {
    expect(resolve(proxied({ "x-forwarded-for": "100.64.0.99, 100.64.0.7" }))).toEqual({ address: "100.64.0.7" });
  });

  it("ignores a forged X-Forwarded-For from a peer that is not loopback", () => {
    const forged = request("100.64.0.5", { host: "web.example:8443", "x-forwarded-for": "100.64.0.7", "tailscale-user-login": "owner@example.test" });
    expect(resolve(forged)).toEqual({ address: "100.64.0.5" });
  });

  it("ignores the header from loopback when the Host is not the web origin", () => {
    for (const host of ["127.0.0.1:7433", "localhost", "web.example.evil", "other.example:8443"]) {
      expect(resolve(request("127.0.0.1", { host, "x-forwarded-for": "100.64.0.7" }))).toEqual({ address: "127.0.0.1" });
    }
    expect(resolve(request("127.0.0.1", { "x-forwarded-for": "100.64.0.7" }))).toEqual({ address: "127.0.0.1" });
  });

  it("keeps the peer when the header is missing or is not an address", () => {
    expect(resolve(proxied())).toEqual({ address: "127.0.0.1" });
    expect(resolve(proxied({ "tailscale-user-login": "owner@example.test" }))).toEqual({ address: "127.0.0.1" });
    for (const value of ["", " ", "100.64.0.7, ", "not-an-address", "100.64.0.7:41641"]) {
      expect(resolve(proxied({ "x-forwarded-for": value }))).toEqual({ address: "127.0.0.1" });
    }
  });

  it("reads the header a setting names in place of X-Forwarded-For", () => {
    const named = forwardedClientAddress(WEB_ORIGIN, "X-Real-IP");
    expect(named(proxied({ "x-real-ip": "100.64.0.8", "x-forwarded-for": "100.64.0.7" }))).toEqual({ address: "100.64.0.8" });
    expect(named(proxied({ "x-forwarded-for": "100.64.0.7" }))).toEqual({ address: "127.0.0.1" });
  });

  it("is the TCP peer when no web origin is configured", () => {
    const resolveWithout = forwardedClientAddress(undefined);
    expect(resolveWithout(request("127.0.0.1", { host: "web.example:8443", "x-forwarded-for": "100.64.0.7" }))).toEqual({ address: "127.0.0.1" });
    expect(peerAddress(request(undefined, {}))).toEqual({ address: undefined });
  });
});

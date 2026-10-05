import { describe, expect, it } from "vitest";
import {
  ACCESS_EVENT_PAYLOADS,
  ACCESS_EVENT_TYPES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  PairError,
  formatPairingCode,
  normalisePairingCode,
  pairingLink,
  parsePairingLink,
} from "./index.js";

describe("pairing codes", () => {
  it("are ten characters of an alphabet without 0, 1, I, L, O or U, valid for ten minutes", () => {
    expect(PAIRING_CODE_LENGTH).toBe(10);
    expect(PAIRING_CODE_ALPHABET).toHaveLength(30);
    for (const confusable of "01ILOU") expect(PAIRING_CODE_ALPHABET).not.toContain(confusable);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(PAIRING_CODE_ALPHABET.length);
    expect(PAIRING_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("are read in any case, with the spaces and hyphens people type, to one canonical form", () => {
    for (const typed of ["K7Q2MXH4RT", "k7q2m-xh4rt", " K7Q2M XH4RT ", "k7q2-mxh-4rt"]) {
      expect(normalisePairingCode(typed), typed).toBe("K7Q2MXH4RT");
    }
  });

  it("refuse anything that is not a code", () => {
    for (const typed of ["", "K7Q2MXH4R", "K7Q2MXH4RTA", "K7Q2MXH4R0", "K7Q2MXH4RI", "K7Q2MXH4R!", "K7Q2M_XH4RT"]) {
      expect(normalisePairingCode(typed), typed).toBeUndefined();
    }
  });

  it("are shown in two groups of five", () => {
    expect(formatPairingCode("K7Q2MXH4RT")).toBe("K7Q2M-XH4RT");
    expect(normalisePairingCode(formatPairingCode("K7Q2MXH4RT"))).toBe("K7Q2MXH4RT");
  });
});

describe("pairing links", () => {
  it("carry the code in the fragment, so it never reaches a log", () => {
    const link = pairingLink("http://desk.tail1234.ts.net:7433", "K7Q2MXH4RT");
    expect(link).toBe("http://desk.tail1234.ts.net:7433/pair#K7Q2MXH4RT");
    const url = new URL(link);
    expect(url.pathname + url.search).not.toContain("K7Q2MXH4RT");
  });

  it("are parsed back to the environment's origin and the code", () => {
    expect(parsePairingLink("http://desk.tail1234.ts.net:7433/pair#K7Q2MXH4RT")).toEqual({
      origin: "http://desk.tail1234.ts.net:7433",
      code: "K7Q2MXH4RT",
    });
    expect(parsePairingLink("http://127.0.0.1:7433/pair#k7q2m-xh4rt")).toEqual({ origin: "http://127.0.0.1:7433", code: "K7Q2MXH4RT" });
  });

  it("are refused when they are not one", () => {
    for (const link of ["not a link", "http://host/pair", "http://host/elsewhere#K7Q2MXH4RT", "ftp://host/pair#K7Q2MXH4RT", "http://host/pair#nope"]) {
      expect(parsePairingLink(link), link).toBeUndefined();
    }
  });
});

describe("the pairing exchange's errors", () => {
  it("tell an unknown code from an expired and a used one, and a protocol mismatch from all three", () => {
    const codes = PairError.options.map((member) => member.shape.code.value);
    expect(codes).toEqual([
      "pairing_invalid",
      "pairing_expired",
      "pairing_used",
      "protocol_mismatch",
      "invalid_params",
      "rate_limited",
      "unavailable",
      "internal",
    ]);
  });
});

describe("the access log", () => {
  it("has a payload schema for every event type the env spec lists, then the permissions spec's", () => {
    expect(ACCESS_EVENT_TYPES).toEqual([
      "pairing.created",
      "pairing.exchanged",
      "pairing.expired",
      "client-session.created",
      "client-session.refreshed",
      "client-session.revoked",
      "socket.opened",
      "socket.closed",
      "scope.granted",
      "access.changed",
      "ceiling.changed",
      "bypass.acknowledged",
      "settings.changed",
      "denylist.changed",
    ]);
    expect(Object.keys(ACCESS_EVENT_PAYLOADS)).toEqual([...ACCESS_EVENT_TYPES]);
  });
});

describe("formatHostPort", () => {
  it("brackets an IPv6 address, and adds the port when there is one", async () => {
    const { formatHostPort } = await import("./index.js");
    expect(formatHostPort("127.0.0.1", 7433)).toBe("127.0.0.1:7433");
    expect(formatHostPort("desk.tail1234.ts.net", 7433)).toBe("desk.tail1234.ts.net:7433");
    expect(formatHostPort("fd7a:115c:a1e0::1", 7433)).toBe("[fd7a:115c:a1e0::1]:7433");
    expect(formatHostPort("::1")).toBe("[::1]");
    expect(formatHostPort("100.64.0.1")).toBe("100.64.0.1");
  });
});

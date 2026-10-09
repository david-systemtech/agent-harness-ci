import { describe, expect, it } from "vitest";
import { parsePairingInput, pairingDeepLink } from "./pairing.js";

describe("pairing origins", () => {
  it.each([
    ["https://environment.example", "https://environment.example"],
    ["https://environment.example:443", "https://environment.example"],
    ["https://environment.example:8443", "https://environment.example:8443"],
    ["http://environment.example", "http://environment.example:7433"],
  ])("keeps the documented origin for links and address/code inputs at %s", (address, origin) => {
    const link = `${address}/pair#K7Q2MXH4RT`;
    const expected = { ok: true, origin, code: "K7Q2MXH4RT" };
    expect(parsePairingInput({ link })).toEqual(expected);
    expect(parsePairingInput({ address, code: "K7Q2M-XH4RT" })).toEqual(expected);
    expect(parsePairingInput({ link: pairingDeepLink(link) })).toEqual(expected);
  });

  it("keeps the native HTTP default for a bare address", () => {
    expect(parsePairingInput({ address: "environment.example", code: "K7Q2MXH4RT" })).toEqual({
      ok: true, origin: "http://environment.example:7433", code: "K7Q2MXH4RT",
    });
  });
});

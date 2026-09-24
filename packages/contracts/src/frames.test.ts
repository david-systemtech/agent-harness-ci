import { describe, expect, it } from "vitest";
import { malformedFrames, validFrames } from "../test/fixtures.js";
import {
  BYE_REASONS,
  ContractError,
  END_REASONS,
  FRAME_TYPES,
  Frame,
  InvalidParamsError,
  decodeFrame,
  encodeFrame,
  type InvalidParamsError as InvalidParams,
} from "./index.js";

/** The `invalid_params` error `decode` threw, checked against the error's own schema. */
const rejection = (decode: () => unknown): InvalidParams => {
  let thrown: unknown;
  try {
    decode();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  const wire = (thrown as ContractError).toWire();
  expect(wire.code).toBe("invalid_params");
  const parsed = InvalidParamsError.parse(wire);
  expect(parsed.data.issues.length).toBeGreaterThan(0);
  return parsed;
};

describe("the frame kinds", () => {
  it("are the thirteen the env spec names", () => {
    expect(FRAME_TYPES).toEqual([
      "auth",
      "hello",
      "request",
      "response",
      "subscribed",
      "snapshot",
      "event",
      "synchronized",
      "end",
      "unsubscribe",
      "ping",
      "pong",
      "bye",
    ]);
    expect(Object.keys(validFrames).sort()).toEqual([...FRAME_TYPES].sort());
    expect(Object.keys(malformedFrames).sort()).toEqual([...FRAME_TYPES].sort());
  });

  it("end a subscription for one of four reasons, and a connection for one of six", () => {
    expect(END_REASONS).toEqual(["unsubscribed", "overflow", "revoked", "closed"]);
    expect(BYE_REASONS).toEqual(["unauthorized", "expired", "revoked", "protocol", "draining", "updating"]);
  });
});

describe("the frame codec", () => {
  it.each(FRAME_TYPES)("round-trips every valid %s frame", (kind) => {
    for (const fixture of validFrames[kind]) {
      const frame = decodeFrame(JSON.stringify(fixture));
      expect(frame).toEqual(fixture);
      expect(decodeFrame(encodeFrame(frame))).toEqual(fixture);
    }
  });

  it.each(FRAME_TYPES)("rejects every malformed %s frame with invalid_params", (kind) => {
    expect(malformedFrames[kind].length).toBeGreaterThan(0);
    for (const text of malformedFrames[kind]) {
      rejection(() => decodeFrame(text));
      // The decoder and the exported Frame schema agree on what a frame is.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      expect(Frame.safeParse(parsed).success, text).toBe(false);
    }
  });

  it("rejects text that is not JSON, naming the parse failure", () => {
    const { data } = rejection(() => decodeFrame("{nope"));
    expect(data.issues[0]?.path).toEqual([]);
    expect(data.issues[0]?.message).toMatch(/JSON/);
  });

  it("rejects a frame of no known kind, naming the kinds it knows", () => {
    const { data } = rejection(() => decodeFrame(JSON.stringify({ type: "shout", text: "hi" })));
    expect(data.issues[0]?.path).toEqual(["type"]);
  });

  it("names the field at fault in a frame of a known kind", () => {
    const { data } = rejection(() =>
      decodeFrame(JSON.stringify({ type: "auth", token: "t", protocolVersion: "1", clientKind: "tui", harnessVersion: "0" })),
    );
    expect(data.issues.map((i) => i.path)).toEqual([["protocolVersion"]]);
  });

  it("accepts a frame carrying a field it does not know, so adding an optional field never bumps the protocol", () => {
    expect(decodeFrame(JSON.stringify({ type: "ping", sentAt: "2026-09-24T00:00:00Z" }))).toEqual({ type: "ping" });
  });

  it("refuses a response with both a result and an error, or with neither", () => {
    const error = { code: "not_found", message: "gone", data: {} };
    rejection(() => decodeFrame(JSON.stringify({ type: "response", id: "1", result: {}, error })));
    rejection(() => decodeFrame(JSON.stringify({ type: "response", id: "1" })));
  });

  it("refuses an event frame whose sequence is not its event's", () => {
    const [valid] = validFrames.event as [{ event: { sequence: number } }];
    const { data } = rejection(() => decodeFrame(JSON.stringify({ ...valid, sequence: valid.event.sequence - 1 })));
    expect(data.issues.map((i) => i.path)).toEqual([["sequence"]]);
    rejection(() => decodeFrame(JSON.stringify({ ...valid, sequence: 0, event: { ...valid.event, sequence: 0 } })));
  });

  it("tells a result response from an error response", () => {
    const [result, error] = validFrames.response;
    expect(decodeFrame(JSON.stringify(result))).toHaveProperty("result");
    expect(decodeFrame(JSON.stringify(error))).toHaveProperty("error.code", "not_found");
  });
});

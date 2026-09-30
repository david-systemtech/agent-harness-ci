import { describe, expect, it } from "vitest";
import {
  DIFF_CAP,
  EventEnvelope,
  EventFrame,
  FILES_LIST_CAP,
  FILES_READ_CAP,
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  TERMINAL_SCROLLBACK,
  TERMINAL_STREAM_KIND,
  TerminalEnvironment,
  TerminalExitedPayload,
  TerminalId,
  TerminalSnapshot,
  registry,
} from "./index.js";

const terminalId = "0b9c7b8e-4a51-4f0c-9d55-6f1d3c2b7a10";
const sessionId = "5f0e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("the terminal vocabulary", () => {
  it("caps scrollback at 5,000 lines or 8 MiB, files.list at 20,000, files.read at 2 MiB and diffs at 8 MiB, as the tui spec chose", () => {
    expect(TERMINAL_SCROLLBACK).toEqual({ lines: 5000, bytes: 8 * 1024 * 1024 });
    expect(FILES_LIST_CAP).toBe(20_000);
    expect(FILES_READ_CAP).toBe(2 * 1024 * 1024);
    expect(DIFF_CAP).toBe(8 * 1024 * 1024);
  });

  it("takes a client-minted version 4 UUID as a terminal's id", () => {
    expect(TerminalId.safeParse(terminalId).success).toBe(true);
    expect(TerminalId.safeParse("terminal-1").success).toBe(false);
  });

  it("takes environment variables a shell accepts, and refuses bad names, NUL and more than 100", () => {
    expect(TerminalEnvironment.safeParse({ FOO: "bar", _X1: "" }).success).toBe(true);
    expect(TerminalEnvironment.safeParse({ "1FOO": "bar" }).success).toBe(false);
    expect(TerminalEnvironment.safeParse({ "A=B": "bar" }).success).toBe(false);
    expect(TerminalEnvironment.safeParse({ FOO: "a\0b" }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`V${i}`, "x"]));
    expect(TerminalEnvironment.safeParse(many).success).toBe(false);
  });

  it("carries a terminal's output in an event frame whose envelope names the terminal stream and the terminal's own sequence", () => {
    const envelope = {
      sequence: 3,
      eventId: "3f1d2c4b-5a6e-4f70-8a91-b2c3d4e5f607",
      streamKind: TERMINAL_STREAM_KIND,
      streamId: terminalId,
      streamVersion: 3,
      type: TERMINAL_OUTPUT_TYPE,
      occurredAt: "2026-09-24T00:00:00.000Z",
      commandId: null,
      causationId: null,
      correlationId: null,
      actor: { kind: "system", id: "terminals" },
      payload: { data: "hello\r\n" },
      metadata: {},
    };
    expect(EventEnvelope.safeParse(envelope).success).toBe(true);
    expect(EventFrame.safeParse({ type: "event", subscription: "sub-1", sequence: 3, event: envelope }).success).toBe(true);
    expect(TerminalExitedPayload.safeParse({ exitCode: 0, signal: null, cause: "exited" }).success).toBe(true);
    expect(TERMINAL_EXITED_TYPE).toBe("terminal.exited");
  });

  it("snapshots a terminal with its retained scrollback and the sequences it spans", () => {
    const snapshot = {
      terminal: { id: terminalId, owner: "session", sessionId, openedAt: "2026-09-24T00:00:00.000Z", cols: 80, rows: 24, exitCode: null, signal: null },
      scrollback: "$ ",
      firstSequence: 1,
      lastSequence: 1,
      truncated: false,
    };
    expect(TerminalSnapshot.safeParse(snapshot).success).toBe(true);
    expect(registry["terminals.subscribe"].result).toBe(TerminalSnapshot);
  });

  it("takes a commandId and the terminal's id on every terminal command", () => {
    for (const name of ["terminals.open", "terminals.write", "terminals.resize", "terminals.close"] as const) {
      expect(registry[name].params.shape, name).toHaveProperty("commandId");
      expect(registry[name].params.shape, name).toHaveProperty("id");
    }
  });
});

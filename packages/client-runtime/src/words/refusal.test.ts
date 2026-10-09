import {
  BANK_CONFLICT_REASONS,
  FILE_UNDO_CONFLICT_REASONS,
  FORBIDDEN_REASONS,
  KEY_MANAGER_VERIFICATION_FAILURES,
  ROUTINE_CONFLICT_REASONS,
  SHARED_ERROR_CODES,
  TOOL_RUN_CONFLICT_REASONS,
  UPDATE_CONFLICT_REASONS,
  registry,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { plainRefusal } from "./refusal.js";

const UNKNOWN = "Something went wrong. Choose Check again to try again.";

/** Every error code a method of the registry may answer, the shared ones among them. */
const methodCodes = (): readonly string[] => {
  const codes = new Set<string>(SHARED_ERROR_CODES);
  for (const method of Object.values(registry)) for (const member of method.errors) codes.add(member.shape.code.value);
  return [...codes];
};

/** The codes answered outside the methods: the pairing exchange's, a rate limit's, an update route's and a key-manager move's. */
const EXCHANGE_CODES = ["pairing_invalid", "pairing_expired", "pairing_used", "protocol_mismatch", "rate_limited", "cannot_write"] as const;

/** Each wire code's reasons, carried as `data.reason` (or, for `unavailable`, `data.readiness`). */
const REASONS: readonly (readonly [code: string, reasons: readonly string[]])[] = [
  ["forbidden", FORBIDDEN_REASONS],
  ["unavailable", ["starting", "draining"]],
  ["verification_failed", KEY_MANAGER_VERIFICATION_FAILURES],
  ["conflict", [...UPDATE_CONFLICT_REASONS, ...BANK_CONFLICT_REASONS, ...ROUTINE_CONFLICT_REASONS, ...TOOL_RUN_CONFLICT_REASONS, ...FILE_UNDO_CONFLICT_REASONS, "target_exists", "no_source", "import_in_progress"]],
];

/** A line of its own that says nothing raw: no code in snake case, no braces, no member names, no "params". */
const expectPlain = (line: string): void => {
  expect(line).not.toBe(UNKNOWN);
  expect(line).not.toMatch(/params|[{}]|shell\.|_/);
};

describe("plainRefusal", () => {
  it.each([...methodCodes(), ...EXCHANGE_CODES])("words the wire code %s plainly and keeps it in the details", (code) => {
    const plain = plainRefusal({ code, message: `The raw words for ${code}.`, data: {} }, "Check again");
    expectPlain(plain.line);
    expect(plain.details).toEqual([`${code}: The raw words for ${code}.`]);
  });

  it.each(REASONS.flatMap(([code, reasons]) => reasons.map((reason) => [code, reason] as const)))("words %s with the reason %s on its own line", (code, reason) => {
    const key = code === "unavailable" ? "readiness" : "reason";
    const plain = plainRefusal({ code, message: "Raw.", data: { [key]: reason } }, "Check again");
    expectPlain(plain.line);
    expect(plain.line).not.toBe(plainRefusal({ code, message: "Raw.", data: {} }, "Check again").line);
    expect(plain.details).toEqual([`${code} (${reason}): Raw.`]);
  });

  it("gives each reason its own line, apart from the code's", () => {
    const scope = plainRefusal({ code: "forbidden", message: "m", data: { scope: "admin" } }, "Save");
    const ceiling = plainRefusal({ code: "forbidden", message: "m", data: { scope: "admin", reason: "ceiling" } }, "Save");
    expect(scope.line).toBe("This app has limited access to that computer, so it cannot do this. Pair again with full access to change this.");
    expect(ceiling.line).toBe("This app itself has limited access, so it cannot give more.");
    expect(plainRefusal({ code: "conflict", message: "laptop is pinned to 0.5.0.", data: { reason: "pinned" } }, "Update now").line).toBe(
      "This computer is pinned to another version. Change or clear the pin, then choose Update now.",
    );
    expect(plainRefusal({ code: "conflict", message: "m", data: {} }, "Update now").line).toBe("This cannot be done right now. Wait a moment, then choose Update now.");
  });

  it("words the request layer's own failures, which carry no data", () => {
    expect(plainRefusal({ code: "timeout", message: "The environment did not answer setup.check within 30 seconds." }, "Check again")).toEqual({
      line: "There was no answer in time. Choose Check again to try again.",
      details: ["timeout: The environment did not answer setup.check within 30 seconds."],
    });
    expect(plainRefusal({ code: "malformed", message: "The environment's answer to setup.check is not the method's." }, "Check again").line).toBe(
      "agent-harness answered in a way this app cannot read. Update this app, then choose Check again.",
    );
    expect(plainRefusal({ code: "unreachable", message: "The socket closed (1006) before the environment answered." }, "Check again").line).toBe(
      "This app cannot reach that computer right now. Choose Check again to try again.",
    );
    // A capability's absence is said in the capability's own plain line, which names the environment.
    const limited = "This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.";
    expect(plainRefusal({ code: "scope", message: limited }, "Save")).toEqual({ line: limited, details: [`scope: ${limited}`] });
    expect(plainRefusal({ code: "unsupported", message: "desk runs an older agent-harness without this. Update desk to use it." }, "Save").line).toBe(
      "desk runs an older agent-harness without this. Update desk to use it.",
    );
    expect(plainRefusal({ code: "no-shell", message: "This app cannot use the clipboard here." }, "Copy").line).toBe("This app cannot use the clipboard here.");
  });

  it("never shows a params refusal's raw words, from this client or from the environment", () => {
    const line = "agent-harness could not use what was sent. Check what you entered, then choose Save.";
    const own = plainRefusal({ code: "invalid_params", message: "The params are not settings.update's: Expected string" }, "Save");
    const wire = plainRefusal({ code: "invalid_params", message: "The input does not match the schema.", data: { issues: [] } }, "Save");
    expect([own.line, wire.line]).toEqual([line, line]);
    expect(own.details).toEqual(["invalid_params: The params are not settings.update's: Expected string"]);
  });

  it("tells unreachable on the wire, a site that did not answer, from this client losing its connection", () => {
    const wire = plainRefusal({ code: "unreachable", message: "https://forge.home.test did not answer.", data: { origin: "https://forge.home.test" } }, "Check again");
    expect(wire.line).toBe("The site did not answer. Check the address and your connection, then choose Check again.");
  });

  it("says an unknown code or reason with the verb to try again", () => {
    expect(plainRefusal({ code: "frob_jammed", message: "The frob jammed.", data: { attempts: 2 } }, "Check again")).toEqual({ line: UNKNOWN, details: ["frob_jammed: The frob jammed."] });
    expect(plainRefusal({ code: "outbox", message: "x is a sessions:write command." }, "Start").line).toBe("Something went wrong. Choose Start to try again.");
    expect(plainRefusal({ code: "conflict", message: "m", data: { reason: "brand_new" } }, "Save").line).toBe("This cannot be done right now. Wait a moment, then choose Save.");
  });
});

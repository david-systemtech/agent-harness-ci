import type { CapabilityAnswer, EnvironmentView, Runtime } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { afterReach, readOnlyLine } from "./generic-editor.js";

/**
 * What a Settings pane says of an environment it cannot write to (#1772):
 * the connection's line, then what the window holds of it. A block's or a
 * limited pairing's line says what to do in a sentence of its own, so what
 * follows it is a sentence of its own rather than a third clause.
 */

const LAPTOP = { environmentId: "env-laptop", name: "laptop", unreachableSince: null } as EnvironmentView;

const answering = (message: string) => ({ capability: (): CapabilityAnswer => ({ status: "absent", reason: "unreachable", message }) }) as unknown as Runtime;

describe("the read-only line of an environment never reached", () => {
  it("follows a block's sentences with a sentence of its own", () => {
    const runtime = answering("This app cannot read its saved key for laptop. Pair again.");
    expect(readOnlyLine(runtime, LAPTOP, false)).toBe("This app cannot read its saved key for laptop. Pair again. This window has read none of its values.");
    expect(readOnlyLine(runtime, LAPTOP, true)).toBe("This app cannot read its saved key for laptop. Pair again. The values this window last read, read-only.");
    const limited = answering("This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.");
    expect(readOnlyLine(limited, LAPTOP, false)).toBe(
      "This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this. This window has read none of its values.",
    );
  });

  it("follows any other line with one clause after a colon", () => {
    const runtime = answering("laptop is starting.");
    expect(readOnlyLine(runtime, LAPTOP, false)).toBe("laptop is starting: this window has read none of its values.");
  });
});

describe("what follows the connection's line", () => {
  it("is a clause after a colon, or a sentence after a line that already has one", () => {
    expect(afterReach("Unreachable since 09:30", "read-only.")).toBe("Unreachable since 09:30: read-only.");
    expect(afterReach("This app's access to laptop has run out. Pair again", "read-only.")).toBe("This app's access to laptop has run out. Pair again. Read-only.");
  });
});

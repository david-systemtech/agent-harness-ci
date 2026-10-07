import type { CapabilityAnswer, EnvironmentView, Runtime } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { afterReach, readOnlyLine } from "./generic-editor.js";

/**
 * What a Settings pane says of an environment it cannot write to (#1772):
 * the connection's line, then what the window holds of it. A block's
 * sentence says what to do after a colon of its own, so what follows it is a
 * sentence of its own rather than a third clause.
 */

const LAPTOP = { environmentId: "env-laptop", name: "laptop", unreachableSince: null } as EnvironmentView;

const answering = (message: string) => ({ capability: (): CapabilityAnswer => ({ status: "absent", reason: "unreachable", message }) }) as unknown as Runtime;

describe("the read-only line of an environment never reached", () => {
  it("follows a block's sentence with a sentence of its own", () => {
    const runtime = answering("Stored credentials for laptop could not be read: pair it again.");
    expect(readOnlyLine(runtime, LAPTOP, false)).toBe("Stored credentials for laptop could not be read: pair it again. This window has read none of its values.");
    expect(readOnlyLine(runtime, LAPTOP, true)).toBe("Stored credentials for laptop could not be read: pair it again. The values this window last read, read-only.");
  });

  it("follows any other line with one clause after a colon", () => {
    const runtime = answering("This client was paired with laptop without the admin scope.");
    expect(readOnlyLine(runtime, LAPTOP, false)).toBe("This client was paired with laptop without the admin scope: this window has read none of its values.");
  });
});

describe("what follows the connection's line", () => {
  it("is a clause after a colon, or a sentence after a line that already has one", () => {
    expect(afterReach("Unreachable since 09:30", "read-only.")).toBe("Unreachable since 09:30: read-only.");
    expect(afterReach("This client's access to laptop expired: pair it again", "read-only.")).toBe("This client's access to laptop expired: pair it again. Read-only.");
  });
});

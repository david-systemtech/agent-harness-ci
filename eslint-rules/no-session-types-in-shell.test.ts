import { rule } from "./no-session-types-in-shell.js";
import { clientRuntime, ruleTester } from "./rule-tester.js";

const shell = clientRuntime("shell.ts");

ruleTester.run("no-session-types-in-shell", rule, {
  valid: [
    { filename: shell, code: `export interface Shell {}` },
    { filename: shell, code: `import type { EnvironmentId, PairingLink } from "@agent-harness/contracts";` },
    { filename: shell, code: `import { PROTOCOL_VERSION } from "@agent-harness/contracts";` },
    // Runtime is not Run; a client session is the pairing credential, not a Session.
    { filename: shell, code: `import type { RuntimeInfo, ClientSessionToken } from "@agent-harness/contracts";` },
    { filename: shell, code: `import type { CapabilityReason } from "./capability.js";` },
  ],
  invalid: [
    {
      filename: shell,
      code: `import type { SessionSummary } from "@agent-harness/contracts";`,
      errors: [{ messageId: "sessionType", data: { name: "SessionSummary" } }],
    },
    {
      filename: shell,
      code: `import { type RunState, type GroupId, EnvironmentId } from "@agent-harness/contracts";`,
      errors: [
        { messageId: "sessionType", data: { name: "RunState" } },
        { messageId: "sessionType", data: { name: "GroupId" } },
      ],
    },
    {
      filename: shell,
      code: `import type { Sessions as Things } from "@agent-harness/contracts/sessions";`,
      errors: [{ messageId: "sessionType", data: { name: "Sessions" } }],
    },
    {
      filename: shell,
      code: `export type { SummaryPatch } from "@agent-harness/contracts";`,
      errors: [{ messageId: "sessionType", data: { name: "SummaryPatch" } }],
    },
    {
      filename: shell,
      code: `import type { EventEnvelope } from "@agent-harness/contracts";`,
      errors: [{ messageId: "sessionType", data: { name: "EventEnvelope" } }],
    },
    {
      filename: shell,
      code: `export interface Shell { open(id: import("@agent-harness/contracts").SessionId): void }`,
      errors: [{ messageId: "sessionType", data: { name: "SessionId" } }],
    },
    // A re-export through another module is the same leak.
    {
      filename: shell,
      code: `import type { SessionSummary } from "./projections.js";`,
      errors: [{ messageId: "sessionType", data: { name: "SessionSummary" } }],
    },
    // A namespace or default import cannot be checked name by name, whatever its source.
    {
      filename: shell,
      code: `import * as contracts from "@agent-harness/contracts";`,
      errors: [{ messageId: "wholeModule" }],
    },
    {
      filename: shell,
      code: `import * as projections from "./projections.js";`,
      errors: [{ messageId: "wholeModule" }],
    },
    {
      filename: shell,
      code: `export * from "./projections.js";`,
      errors: [{ messageId: "wholeModule" }],
    },
    {
      filename: shell,
      code: `export type Projections = import("./projections.js");`,
      errors: [{ messageId: "wholeModule" }],
    },
  ],
});

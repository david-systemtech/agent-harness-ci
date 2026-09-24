import { PROTOCOL_VERSION } from "@agent-harness/contracts";

export type { Shell } from "./shell.js";

/** The protocol version this client runtime speaks. */
export const CLIENT_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

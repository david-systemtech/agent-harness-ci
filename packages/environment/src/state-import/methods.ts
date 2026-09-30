import type { MethodHandler, MethodHandlers } from "../serve/methods.js";
import { detectSource, type SourceMachine } from "./source/folders.js";

/**
 * The state import's methods (setup spec, "2. Carry over"; ADR 0036):
 * `stateImport.detect` answers whether a source data folder or a
 * terminal-client state folder is on the environment's machine, and what
 * the data folder holds by kind, read by the source reader each time it is
 * asked (#581). `stateImport.run` is the switch-over build's (#94), which
 * serves it and offers the `stateImport` flag.
 */

export interface StateImportOptions {
  /** The machine the source reader looks at: this process's environment, platform and home. */
  readonly machine: SourceMachine;
}

export const stateImportMethods = ({ machine }: StateImportOptions): MethodHandlers => {
  const detect: MethodHandler<"stateImport.detect"> = () => detectSource(machine);
  return { "stateImport.detect": detect };
};

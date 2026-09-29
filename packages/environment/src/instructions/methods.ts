import { ContractError, invalidParams } from "@agent-harness/contracts";
import type { AdapterHost, InstructionTarget } from "../adapter/host.js";
import type { MethodHandlers } from "../serve/methods.js";

/**
 * The standing-instruction reads on the method table (skills-instructions
 * spec, "Standing instructions and the composer"): `instructions.preview` at
 * `read`, what a run would be handed now, composed by the host as a run's
 * launch composes it (`AdapterHost.previewInstructions`): each part with its
 * layer, id, title and text, the text, and the manifest.
 */

export interface InstructionMethodsOptions {
  readonly host: AdapterHost;
}

export const instructionMethods = (options: InstructionMethodsOptions): MethodHandlers => {
  const { host } = options;

  return {
    "instructions.preview": async ({ sessionId, accountId, workspace }) => {
      // The params' schema takes a session, or an account and a workspace, never both.
      const target: InstructionTarget | undefined =
        sessionId !== undefined ? { sessionId } : accountId !== undefined && workspace !== undefined ? { accountId, workspace } : undefined;
      if (target === undefined) {
        const message = "Name a session, or an account and a workspace, not both.";
        throw new ContractError(invalidParams([{ code: "custom", path: [], message }], message));
      }
      const composed = await host.previewInstructions(target);
      return {
        parts: composed.parts.map(({ layer, id, title, text }) => ({ layer, id, title, text })),
        text: composed.text,
        manifest: composed.manifest,
      };
    },
  };
};

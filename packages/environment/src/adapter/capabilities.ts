import { ContractError, invalidParams, type AdapterCapabilityFlag } from "@agent-harness/contracts";
import type { AdapterDescriptor } from "./contract.js";

/**
 * The refusal of a call the adapter's descriptor does not cover. The spec
 * names it `invalid_request`, which is not in the env spec's error union;
 * it is the union's `invalid_params`, since what the caller asked for is
 * not something this adapter takes, with the issue at the param that asked
 * and `data.reason` `unsupported` naming the missing flag, so a client tells
 * it from a malformed request and degrades absent-with-reason.
 */
export const unsupported = (
  descriptor: AdapterDescriptor,
  flag: AdapterCapabilityFlag,
  path: readonly (string | number)[],
  what: string,
  why = `it does not declare ${flag}`,
): ContractError => {
  const message = `The ${descriptor.displayName} adapter cannot ${what}: ${why}.`;
  const error = invalidParams([{ code: "custom", path: [...path], message }], message);
  return new ContractError({ ...error, data: { ...error.data, reason: "unsupported", capability: flag, provider: descriptor.provider } });
};

/** Throws `unsupported` unless the descriptor declares `flag`. */
export const requireCapability = (
  descriptor: AdapterDescriptor,
  flag: AdapterCapabilityFlag,
  path: readonly (string | number)[],
  what: string,
): void => {
  if (!descriptor[flag]) throw unsupported(descriptor, flag, path, what);
};

/**
 * Throws `unsupported` unless the descriptor declares `flag` and the adapter
 * has the method that pairs with it, and hands the method back: a flag
 * without its method is the adapter's bug, refused the same way.
 */
export const capability = <F>(
  descriptor: AdapterDescriptor,
  flag: AdapterCapabilityFlag,
  method: F | undefined,
  what: string,
  methodName = "its method",
): F => {
  requireCapability(descriptor, flag, [], what);
  if (method === undefined) throw unsupported(descriptor, flag, [], what, `it declares ${flag} but has no ${methodName}`);
  return method;
};

import type { Clock } from "../serve/clock.js";
import { runCommand, type CommandAnswer } from "./run.js";

/**
 * The system package that owns a file (key-managers spec, "Managed tools";
 * ADR 0026): `dpkg -S`, then `rpm -qf`, on Linux, where a tool the
 * distribution's package manager installed is updated through it. Elsewhere
 * no system package manager owns a tool's file.
 */

/** What the package managers answered for a file. */
export type PackageOwner =
  /** A package owns it: which manager's, and its name. */
  | { readonly kind: "owned"; readonly manager: "dpkg" | "rpm"; readonly package: string }
  /** No package owns it, or there is no package manager to ask. */
  | { readonly kind: "none" }
  /** A package manager could not answer: its time ran out, or it failed another way. */
  | { readonly kind: "unknown"; readonly why: string };

/** Asks which package owns the file at `realpath`. Never rejects. */
export type PackageOwnerLookup = (realpath: string) => Promise<PackageOwner>;

export interface SystemPackageOwnerOptions {
  readonly clock: Clock;
  /** The environment the package managers run in. */
  readonly env: () => Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

/** What one manager said: owned by a package, owned by none (it said so, or it is not installed), or it could not say. */
const readAnswer = (manager: "dpkg" | "rpm", answer: CommandAnswer): PackageOwner => {
  if (answer.outcome === "missing") return { kind: "none" };
  if (answer.outcome === "failed") return { kind: "unknown", why: `${manager} gave ${answer.why}` };
  if (answer.code === 1) return { kind: "none" };
  if (answer.code !== 0) return { kind: "unknown", why: `${manager} exited with code ${answer.code ?? "none"}` };
  // dpkg -S: `gh: /usr/bin/gh` (a diversion's line names no package); rpm -qf: `gh-2.40.0-1.x86_64`, or it says it owns none.
  const line = answer.stdout.split("\n").find((candidate) => candidate.trim() !== "" && !candidate.startsWith("diversion by")) ?? "";
  const name = manager === "dpkg" ? line.split(":")[0]?.trim() : / is not owned by any package/.test(line) ? "" : line.trim();
  return name === undefined || name === "" ? { kind: "none" } : { kind: "owned", manager, package: name };
};

/** The preset lookup: dpkg's answer, else rpm's, on Linux; none elsewhere. */
export const systemPackageOwner =
  (options: SystemPackageOwnerOptions): PackageOwnerLookup =>
  async (realpath) => {
    if ((options.platform ?? process.platform) !== "linux") return { kind: "none" };
    const ask = (file: string, args: readonly string[]) =>
      runCommand(file, [...args, realpath], { env: options.env(), clock: options.clock, timeoutMs: options.timeoutMs, ...(options.signal !== undefined && { signal: options.signal }) });
    const dpkg = readAnswer("dpkg", await ask("dpkg", ["-S"]));
    if (dpkg.kind === "owned") return dpkg;
    const rpm = readAnswer("rpm", await ask("rpm", ["-qf"]));
    if (rpm.kind === "owned") return rpm;
    return dpkg.kind === "unknown" ? dpkg : rpm;
  };

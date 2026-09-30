import { stripVTControlCharacters } from "node:util";
import type { DoctorToolName, ManagedToolDetail, ManagedToolInstallMethod, ToolDoctorField, ToolDoctorReport, ToolDoctorWarning } from "@agent-harness/contracts";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { ManagedTools } from "./registry.js";
import { runCommand, type CommandAnswer } from "./run.js";

/**
 * A tool's detail (key-managers spec, "Managed tools"; ADR 0026; #374):
 * its row beside what its `doctor` says. `doctor` is slow (Claude Code's
 * waits on its remote settings), so it runs only when a client asks
 * (`tools.detail`, a row's detail opening) and when Update is clicked
 * (#376), never on a probe. It runs where the row found the tool, in the
 * registry's command environment, from the home directory, since `claude
 * doctor` reads the settings of the directory it runs in without a trust
 * prompt. With no terminal, Claude Code 2.1.283 (the pinned SDK's) prints
 * a title, a summary of `Name: value` lines (`Running: <how installed>
 * (<version>)`, `Package manager:` when that is how, `Path`, `Invoked`,
 * `Config install method`, `Search`, `Auto-updates`, `Auto-update channel`,
 * `Last update attempt`, `Managed settings (remote)`, `Organization
 * policy`), sections, and its warnings as `- <issue>` lines each followed
 * by `  Fix: <fix>`. The summary's fields and the warnings are read, after
 * the scrub registry has passed over the output; `Running` gives the
 * install method it reports, set beside the one the registry detected,
 * since it misreports it on ordinary machines (ADR 0026).
 */

/** How long `doctor` may take on the environment's clock: it waits on the network. */
export const DOCTOR_TIMEOUT_MS = 30_000;

export interface ToolDoctorOptions {
  /** The Managed tools registry: the tool's row, and the environment it runs a tool in. */
  readonly tools: Pick<ManagedTools, "row" | "commandEnvironment">;
  readonly scrub: Pick<ScrubRegistry, "scrubOutput">;
  readonly clock: Clock;
  /** Preset `DOCTOR_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

export interface ToolDoctor {
  /** Runs `tool`'s doctor now and answers its detail: `tools.detail`, and Update on the tool (#376). */
  detail(tool: DoctorToolName): Promise<ManagedToolDetail>;
  /** Kills every doctor under way: the environment's close. */
  close(): void;
}

/** A line of the summary: a name that starts with no space and holds no colon, a colon, a space, and its value. */
const FIELD = /^([^\s:][^:]{0,63}): (.*)$/;

/** The line the warnings follow: `1 warning found`, `2 warnings found`. */
const WARNINGS_HEADING = /^\d+ warnings? found$/;

/** The longest text a field or warning keeps, as the contract bounds it. */
const TEXT_LENGTH = 1024;

/** The longest line a failure keeps of what the command printed. */
const SAID_LENGTH = 300;

const cut = (text: string, length: number): string => (text.length <= length ? text : `${text.slice(0, length - 1)}…`);

/** How Claude Code's `Running` field names an install, in the registry's words; a package manager's by its own name. */
const REPORTED_METHODS: Readonly<Record<string, ManagedToolInstallMethod>> = {
  native: "native",
  "npm-global": "npm",
  "npm-local": "npm",
  unknown: "unknown",
};

/** The package managers Claude Code names under `Package manager`, in the registry's words: `deb` is dpkg's, which is `apt`, and `rpm` is `dnf`. */
const REPORTED_MANAGERS: Readonly<Record<string, ManagedToolInstallMethod>> = {
  homebrew: "homebrew",
  winget: "winget",
  mise: "mise",
  asdf: "asdf",
  deb: "apt",
  rpm: "dnf",
};

/** The install method the summary reports, in the registry's words; null for words it has none for (a development build, pacman, apk). */
const reportedMethod = (fields: readonly ToolDoctorField[]): ManagedToolInstallMethod | null => {
  const value = (name: string): string | undefined => fields.find((field) => field.name === name)?.value;
  const running = value("Running")?.replace(/\s*\(.*\)$/, "");
  if (running === undefined) return null;
  if (running === "package-manager") return REPORTED_MANAGERS[value("Package manager") ?? ""] ?? null;
  return REPORTED_METHODS[running] ?? null;
};

/** The summary's fields and the warnings in what `doctor` printed; no fields when it printed no summary. */
const readDoctor = (printed: string): { readonly fields: ToolDoctorField[]; readonly warnings: ToolDoctorWarning[] } => {
  const lines = stripVTControlCharacters(printed).split(/\r?\n/);
  const fields: ToolDoctorField[] = [];
  // The summary: the first run of field lines, ended by a blank line.
  const first = lines.findIndex((line) => FIELD.test(line));
  for (let at = first; first !== -1 && at < lines.length && lines[at]?.trim() !== ""; at += 1) {
    const [, name = "", value = ""] = FIELD.exec(lines[at] ?? "") ?? [];
    if (name !== "" && fields.length < 64) fields.push({ name: name.trimEnd(), value: cut(value.trim(), TEXT_LENGTH) });
  }
  const warnings: ToolDoctorWarning[] = [];
  const heading = lines.findIndex((line) => WARNINGS_HEADING.test(line.trim()));
  for (let at = heading + 1; heading !== -1 && at < lines.length && lines[at]?.trim() !== ""; at += 1) {
    const line = lines[at] ?? "";
    const fix = /^\s+Fix:\s*(.+)$/.exec(line)?.[1];
    const last = warnings.at(-1);
    if (line.startsWith("- ") && line.slice(2).trim() !== "" && warnings.length < 32) warnings.push({ issue: cut(line.slice(2).trim(), TEXT_LENGTH), fix: null });
    else if (fix !== undefined && last !== undefined && last.fix === null) warnings[warnings.length - 1] = { ...last, fix: cut(fix.trim(), TEXT_LENGTH) };
  }
  return { fields, warnings };
};

export const createToolDoctor = (options: ToolDoctorOptions): ToolDoctor => {
  const { tools, scrub, clock } = options;
  const timeoutMs = options.timeoutMs ?? DOCTOR_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  const closing = new AbortController();

  /** The first line of what a command that failed printed on standard error, scrubbed, or nothing. */
  const said = (answer: Extract<CommandAnswer, { outcome: "exited" }>): string => {
    const line = scrub
      .scrubOutput(stripVTControlCharacters(answer.stderr))
      .split(/\r?\n/)
      .map((each) => each.trim())
      .find((each) => each !== "");
    return line === undefined ? "" : `: ${cut(line.replace(/\.$/, ""), SAID_LENGTH)}`;
  };

  const report = (tool: DoctorToolName, answer: CommandAnswer): ToolDoctorReport => {
    if (answer.outcome === "missing") return { outcome: "not-installed" };
    if (answer.outcome === "failed") return { outcome: "failed", reason: `${tool} doctor failed: ${answer.why}.` };
    if (answer.code !== 0) return { outcome: "failed", reason: `${tool} doctor exited with code ${answer.code ?? "none"}${said(answer)}.` };
    const { fields, warnings } = readDoctor(scrub.scrubOutput(answer.stdout));
    if (fields.length === 0) return { outcome: "failed", reason: `${tool} doctor printed no summary to read.` };
    return { outcome: "read", method: reportedMethod(fields), fields, warnings };
  };

  const detail = async (tool: DoctorToolName): Promise<ManagedToolDetail> => {
    const row = await tools.row(tool);
    if (row.path === null) return { tool, row, doctor: { outcome: "not-installed" } };
    const env = await tools.commandEnvironment();
    const answer = await runCommand(row.path, ["doctor"], { env, clock, timeoutMs, signal: closing.signal, platform, ...(env["HOME"] !== undefined && { cwd: env["HOME"] }) });
    return { tool, row, doctor: report(tool, answer) };
  };

  return { detail, close: () => closing.abort() };
};

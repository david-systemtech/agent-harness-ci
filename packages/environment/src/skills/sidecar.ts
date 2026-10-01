import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ReadinessDeclaration, SKILL_READINESS_SIDECAR } from "@agent-harness/contracts";
import { parse } from "yaml";

/**
 * A skill's readiness sidecar (skills spec, "Readiness"; ADR 0009):
 * `agents/agent-harness.yaml` beside its `SKILL.md`, after Codex's
 * `agents/openai.yaml`, holding the declaration the contracts' schema reads.
 * The reader reads it for the member's warning, and the readiness
 * evaluator for its checks. A sidecar that is not there is none; one that
 * leads out of the skill's folder, is larger than 64 KiB, does not parse as
 * YAML or is not a declaration is invalid, which `skills.get` shows as a
 * warning on the member and which counts as none.
 */

/** The most of a sidecar read: a declaration is a few dozen lines. */
const MAX_SIDECAR_BYTES = 64 * 1024;

export type SidecarReading =
  | { readonly kind: "none" }
  | { readonly kind: "declared"; readonly declaration: ReadinessDeclaration }
  | { readonly kind: "invalid"; readonly message: string };

const NONE: SidecarReading = { kind: "none" };

/** Whether `path` lies in `tree` or is it. */
const within = (tree: string, path: string): boolean => {
  const rel = relative(tree, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** An invalid sidecar, saying why. */
const invalid = (why: string): SidecarReading => ({ kind: "invalid", message: `Its readiness sidecar, ${SKILL_READINESS_SIDECAR}, ${why}, so it counts as none.` });

/** Reads the sidecar of the skill whose `SKILL.md` lies in `folder`. */
export const readSidecar = async (folder: string): Promise<SidecarReading> => {
  let file: string;
  let tree: string;
  try {
    tree = await realpath(folder);
    file = await realpath(join(folder, ...SKILL_READINESS_SIDECAR.split("/")));
  } catch {
    return NONE;
  }
  if (!within(tree, file)) return invalid("leads out of the skill's folder");
  let text: string;
  try {
    // A file only: opening a pipe would wait for a writer.
    if (!(await stat(file)).isFile()) return invalid("is not a file");
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(MAX_SIDECAR_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_SIDECAR_BYTES) return invalid(`is larger than ${MAX_SIDECAR_BYTES / 1024} KiB`);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return invalid(`could not be read (${(error as NodeJS.ErrnoException).code ?? "an error"})`);
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return invalid(`does not parse as YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const declaration = ReadinessDeclaration.safeParse(data);
  if (!declaration.success) {
    const [issue] = declaration.error.issues;
    const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
    return invalid(`is not a readiness declaration${where}: ${issue?.message ?? "it does not read"}`);
  }
  return { kind: "declared", declaration: declaration.data };
};

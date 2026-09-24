import { describe, expect, it } from "vitest";
import { Group, SESSION_WRITE_COMMANDS, SessionSummary, registry, type WriteCommandKind } from "./index.js";

/**
 * The outbox's contract test (client-runtime spec, "Coalescing" and
 * "Contract tests in the contracts package"): every `sessions:write` method
 * is either an absolute setter, whose fields a later command of the same
 * method and target overwrites whatever the session held, so a client's
 * outbox may keep only the later one, or an ordered command, which is sent
 * as queued. The check is a plain function over the table, shown failing on
 * tables broken on purpose.
 */

type LooseKind = { readonly setter: { readonly target: string; readonly fields: readonly string[] } } | { readonly ordered: string };

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  session: Object.keys(SessionSummary.shape),
  group: Object.keys(Group.shape),
};

/** What is wrong with a write-command table against the registry. */
const writeCommandProblems = (table: Readonly<Record<string, LooseKind>>, methods: Readonly<Record<string, { readonly scope: string; readonly kind: string }>>): string[] => {
  const problems: string[] = [];
  for (const [name, method] of Object.entries(methods)) {
    if (method.scope === "sessions:write" && method.kind === "command" && !Object.hasOwn(table, name)) problems.push(`${name}: neither a setter nor ordered`);
  }
  for (const [name, kind] of Object.entries(table)) {
    const method = Object.hasOwn(methods, name) ? methods[name] : undefined;
    if (method === undefined) problems.push(`${name}: not registered`);
    else if (method.scope !== "sessions:write" || method.kind !== "command") problems.push(`${name}: not a sessions:write command`);
    if ("ordered" in kind) {
      if (kind.ordered.trim() === "") problems.push(`${name}: ordered without a reason`);
      continue;
    }
    const known = FIELDS[kind.setter.target];
    if (known === undefined) {
      problems.push(`${name}: sets a ${kind.setter.target}, which has no fields`);
      continue;
    }
    if (kind.setter.fields.length === 0) problems.push(`${name}: a setter of no field`);
    for (const field of kind.setter.fields) if (!known.includes(field)) problems.push(`${name}: ${field} is not a ${kind.setter.target} field`);
  }
  return problems;
};

describe("the sessions:write commands", () => {
  it("are each an absolute setter or an ordered command", () => {
    expect(writeCommandProblems(SESSION_WRITE_COMMANDS, registry)).toEqual([]);
  });

  it("fail the check when a sessions:write method is neither", () => {
    const rest: Record<string, LooseKind> = { ...SESSION_WRITE_COMMANDS };
    delete rest["sessions.setDraft"];
    expect(writeCommandProblems(rest, registry)).toEqual(["sessions.setDraft: neither a setter nor ordered"]);
  });

  it("fail the check when a setter names a field its target does not have, or no field", () => {
    const broken = {
      ...SESSION_WRITE_COMMANDS,
      "sessions.rename": { setter: { target: "session", fields: ["heading"] } },
      "groups.rename": { setter: { target: "group", fields: [] } },
    };
    expect(writeCommandProblems(broken, registry)).toEqual(["sessions.rename: heading is not a session field", "groups.rename: a setter of no field"]);
  });

  it("fail the check for a method that is not a sessions:write command", () => {
    const broken = { ...SESSION_WRITE_COMMANDS, "runs.send": { ordered: "a run's input" }, "sessions.list": { ordered: "a query" } };
    expect(writeCommandProblems(broken, registry)).toEqual(["runs.send: not a sessions:write command", "sessions.list: not a sessions:write command"]);
  });

  it("make the draft an absolute setter, which an outbox coalesces (conflict X3)", () => {
    const draft: WriteCommandKind = SESSION_WRITE_COMMANDS["sessions.setDraft"];
    expect(draft).toEqual({ setter: { target: "session", fields: ["draft"] } });
  });

  it("keep a command whose effect depends on what the session held ordered: a pin's companions, a tag added to the set", () => {
    for (const name of ["sessions.pin", "sessions.settle", "sessions.tag", "sessions.untag", "groups.create", "sessions.delete"] as const) {
      expect(SESSION_WRITE_COMMANDS[name]).toHaveProperty("ordered");
    }
  });
});

import { randomUUID } from "node:crypto";
import { SkillsViewSource } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { usePaired } from "../test/paired.js";
import { flush } from "./testing/fake-wire.js";

const { pairedMany } = usePaired();
const emptySkills = { ownDirectory: "/own", sources: [], choices: [], accountId: null, accounts: [], members: [] };

describe("the runtime's bulk copy on unavailable and refusing targets", () => {
  it("continues dismissals when a target refuses to list instructions, preserving each item's report", async () => {
    const { runtime, wires, ids } = await pairedMany([], [{ name: "source" }, { name: "target" }]);
    const id = randomUUID();
    const catalogueId = "coding.fresh-checkout";
    wires[0]!.answer("instructions.list", () => ({ result: { orientation: { enabled: true, text: null, unreadRegistries: [], accounts: [] }, instructions: [], dismissed: [catalogueId] } }));
    wires[1]!.answer("instructions.list", () => ({ error: { code: "internal", message: "Cannot list now.", data: {} } }));
    wires[1]!.answer("instructions.dismissSuggestion", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { catalogueId, dismissed: true } } }));
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { instructionIds: [id], dismissed: true }, [ids[1]!])).toMatchObject([{ status: "copied", result: [
      { kind: "instruction", id, status: "refused", error: { code: "internal" } },
      { kind: "dismissed", id: catalogueId, status: "copied" },
    ] }]);
  });
  it("copies a dismissal without depending on either environment's account registry", async () => {
    const { runtime, wires, ids } = await pairedMany([], [{ name: "source" }, { name: "target" }]);
    const catalogueId = "coding.fresh-checkout";
    wires[0]!.answer("instructions.list", () => ({ result: { orientation: { enabled: true, text: "# Orientation", unreadRegistries: [], accounts: [] }, instructions: [], dismissed: [catalogueId] } }));
    wires[1]!.answer("instructions.dismissSuggestion", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { catalogueId, dismissed: true } } }));
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { dismissed: true }, [ids[1]!])).toMatchObject([{ status: "copied", result: [{ kind: "dismissed", id: catalogueId, status: "copied" }] }]);
    for (const wire of wires) expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method === "accounts.list")).toEqual([]);
  });
  it("refuses unreachable and non-admin connections without sending, reports a source limit, and continues other targets and items", async () => {
    const { runtime, wires, ids, clock } = await pairedMany([], [{ name: "source" }, { name: "down" }, { name: "limited" }, { name: "read-only", scopes: ["read"] }, { name: "good" }]);
    const [source, down, limited, readOnly, good] = ids as [string, string, string, string, string];
    const sourceRecord = SkillsViewSource.parse({ id: randomUUID(), url: "https://skills.test/owner/skills", identity: "https://skills.test/owner/skills", folder: ".", follow: { kind: "branch", branch: "main" }, position: 1, addedBy: { kind: "client_session", id: randomUUID() }, addedAt: clock.now().toISOString(), commit: "a".repeat(40), skillCount: 1, sync: { outcome: "ok", since: clock.now().toISOString() }, attemptedAt: clock.now().toISOString() });
    wires[0]!.answer("skills.get", () => ({ result: { ...emptySkills, sources: [sourceRecord], choices: [{ kind: "enabled", name: "tdd", accountId: null, enabled: false }] } }));
    for (const wire of wires) wire.answer("accounts.list", () => ({ result: { accounts: [] } }));
    const accepted = { status: "accepted", sequence: 1, changed: true };
    wires[2]!.answer("skills.sources.add", () => ({ result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "Twenty sources already.", data: { reason: "source_limit" } } } } }));
    wires[4]!.answer("skills.sources.add", () => ({ result: { receipt: accepted, result: { source: sourceRecord } } }));
    for (const wire of [wires[2]!, wires[4]!]) wire.answer("skills.setEnabled", () => ({ result: { receipt: accepted, result: { choice: { kind: "enabled", name: "tdd", accountId: null, enabled: false } } } }));
    wires[1]!.discovery("unreachable");
    wires[1]!.server.drop();
    await flush();
    const beforeDown = wires[1]!.server.received().length;
    const beforeReadOnly = wires[3]!.server.received().length;
    const reports = await runtime.commands.copyToEnvironments(source, { sources: true, choices: true }, [down, limited, readOnly, good, good]);
    expect(reports).toMatchObject([
      { environmentId: down, status: "refused", error: { code: "unreachable" } },
      { environmentId: limited, status: "copied", result: [
        { kind: "source", id: sourceRecord.id, status: "refused", error: { code: "conflict", data: { reason: "source_limit" } } },
        { kind: "choice", id: "tdd", status: "copied" },
      ] },
      { environmentId: readOnly, status: "refused", error: { code: "scope" } },
      { environmentId: good, status: "copied", result: [{ kind: "source", status: "copied" }, { kind: "choice", status: "copied" }] },
    ]);
    expect(wires[1]!.server.received()).toHaveLength(beforeDown);
    expect(wires[3]!.server.received()).toHaveLength(beforeReadOnly);
    for (const wire of [wires[2]!, wires[4]!]) {
      const requests = wire.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("skills."));
      expect(JSON.stringify(requests)).not.toContain(source);
      expect(JSON.stringify(requests)).not.toContain(down);
      expect(JSON.stringify(requests)).not.toContain("copiedFrom");
    }
  });

  it("refuses an unreachable target before reading a source that would hang", async () => {
    const { runtime, wires, ids } = await pairedMany([], [{ name: "source" }, { name: "down" }]);
    wires[0]!.answer("skills.get", () => undefined);
    wires[1]!.server.drop();
    await flush();
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { sources: true }, [ids[1]!])).toMatchObject([{ status: "refused", error: { code: "unreachable" } }]);
    expect(wires[0]!.server.received().filter((frame) => frame.type === "request" && frame.method === "skills.get")).toEqual([]);
  });
});

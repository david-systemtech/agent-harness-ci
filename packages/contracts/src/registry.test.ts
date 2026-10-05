import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import {
  CommandId,
  CommandReceipt,
  OWED_HANDLERS,
  type CommandMethodName,
  METHOD_KINDS,
  SCOPES,
  Sequence,
  defineMethod,
  errorSchema,
  isCommand,
  isMethodName,
  methods,
  registry,
  type ErrorOf,
  type MethodName,
  type MintedPairing,
  type ParamsOf,
  type ResponseOf,
  type ResultOf,
  type SharedErrorCode,
} from "./index.js";

const unscoped = {
  name: "example.unscoped",
  params: z.object({}),
  result: z.object({}),
  errors: [],
  kind: "query",
} as const;

describe("the method registry", () => {
  it("registers each populated future web slot exactly once", async () => {
    const origin = defineMethod({ ...unscoped, name: "web.origins.fixture", scope: "read" });
    const attention = defineMethod({ ...unscoped, name: "web.attention.fixture", scope: "read" });
    vi.resetModules();
    vi.doMock("./web/origin-policy.js", () => ({ webOriginMethods: [origin] }));
    vi.doMock("./web/attention.js", () => ({ webAttentionMethods: [attention] }));
    try {
      const populated = await import("./registry.js");
      const registered: readonly { readonly name: string }[] = populated.methods;
      for (const method of [origin, attention]) {
        expect(registered.filter(candidate => candidate.name === method.name)).toEqual([method]);
      }
    } finally {
      vi.doUnmock("./web/origin-policy.js");
      vi.doUnmock("./web/attention.js");
      vi.resetModules();
    }
  });

  // Modelled on T3 Code's RpcAuthorization test: the scope table and the
  // method table are one table, so a method cannot exist without its scope.
  it("declares exactly one scope for every registered method", () => {
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(typeof method.scope, method.name).toBe("string");
      expect(SCOPES, method.name).toContain(method.scope);
    }
  });

  it("is keyed by each method's own name, with no name registered twice", () => {
    const names = methods.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(registry).sort()).toEqual([...names].sort());
    for (const method of methods) expect(registry[method.name]).toBe(method);
  });

  it("gives the environment's own methods the scopes the env spec gives them", () => {
    const environmentMethods = methods.filter((m) => m.name.startsWith("environment.") || m.name.startsWith("access."));
    expect(Object.fromEntries(environmentMethods.map((m) => [m.name, m.scope]))).toEqual({
      "environment.status": "read",
      "environment.subscribe": "read",
      "environment.drain": "admin",
      "environment.rebuildProjections": "admin",
      "environment.rename": "admin",
      "environment.setIcon": "admin",
      "environment.setColour": "admin",
      // Known environments (key-managers spec, "Wire methods"; #382): refused forbidden to a program all the same.
      "environment.knownEnvironments.report": "read",
      "access.pairings.create": "admin",
      "access.sessions.list": "admin",
      "access.sessions.revoke": "admin",
      "access.sessions.refresh": "read",
      "access.sessions.setCeiling": "admin",
      "access.sessions.setAccess": "admin",
      "access.log.list": "admin",
    });
  });

  it("gives the session and group methods the scopes the session-state spec gives them: organisation commands sessions:write, reads read", () => {
    const sessionMethods = methods.filter((m) => m.name.startsWith("sessions.") || m.name.startsWith("groups."));
    expect(Object.fromEntries(sessionMethods.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "sessions.create": ["command", "sessions:write"],
      // Giving a missing session a new workspace (workspace-picker spec, "Missing workspaces"; #328).
      "sessions.setWorkspace": ["command", "sessions:write"],
      "sessions.rename": ["command", "sessions:write"],
      "sessions.archive": ["command", "sessions:write"],
      "sessions.unarchive": ["command", "sessions:write"],
      "sessions.pin": ["command", "sessions:write"],
      "sessions.unpin": ["command", "sessions:write"],
      "sessions.reorderPinned": ["command", "sessions:write"],
      "sessions.reorderActive": ["command", "sessions:write"],
      "sessions.tag": ["command", "sessions:write"],
      "sessions.untag": ["command", "sessions:write"],
      "sessions.setDraft": ["command", "sessions:write"],
      "sessions.setGroup": ["command", "sessions:write"],
      "sessions.settle": ["command", "sessions:write"],
      "sessions.unsettle": ["command", "sessions:write"],
      "sessions.snooze": ["command", "sessions:write"],
      "sessions.unsnooze": ["command", "sessions:write"],
      "sessions.delete": ["command", "sessions:write"],
      "sessions.restore": ["command", "sessions:write"],
      "sessions.purge": ["command", "sessions:write"],
      "sessions.fork": ["command", "sessions:write"],
      // Rewinding changes what the next run does rather than a summary field (claude-adapter spec, a chosen default).
      "sessions.rewind": ["command", "runs:drive"],
      // Undoing one, beside it (ADR 0022, #218).
      "sessions.undoRewind": ["command", "runs:drive"],
      // Setting a session's own instructions, as rewinding, changes what its next run does (#506).
      "sessions.setInstructions": ["command", "runs:drive"],
      // The session's browser chooses what its next run may drive (browser spec, "The browser as a session field"; #550).
      "sessions.setBrowser": ["command", "runs:drive"],
      "groups.create": ["command", "sessions:write"],
      "groups.rename": ["command", "sessions:write"],
      "groups.reorder": ["command", "sessions:write"],
      "groups.delete": ["command", "sessions:write"],
      "sessions.list": ["query", "read"],
      "sessions.get": ["query", "read"],
      "sessions.listDeleted": ["query", "read"],
      "groups.list": ["query", "read"],
      "sessions.subscribe": ["stream", "read"],
      "sessions.subscribeSession": ["stream", "read"],
      "sessions.subagentTranscript": ["query", "read"],
    });
  });

  it("gives the run methods the claude-adapter spec's scope, runs:drive, each a command", () => {
    const runMethods = methods.filter((m) => m.name.startsWith("runs."));
    expect(Object.fromEntries(runMethods.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "runs.start": ["command", "runs:drive"],
      "runs.send": ["command", "runs:drive"],
      "runs.interrupt": ["command", "runs:drive"],
      "runs.stopTask": ["command", "runs:drive"],
      // ADR 0022's queue verbs (#228).
      "runs.readNow": ["command", "runs:drive"],
      "runs.withdraw": ["command", "runs:drive"],
    });
    // Conflict X1: the prompt's answer is the permissions workstream's `permissions.prompts.answer` (#130), never `runs.answerPrompt`.
    expect(isMethodName("runs.answerPrompt")).toBe(false);
  });

  it("gives the terminal, file and diff methods the terminal scope the tui spec gives them, the mutating ones as commands", () => {
    const terminalMethods = methods.filter((m) => /^(terminals|files|diffs)\./.test(m.name));
    expect(Object.fromEntries(terminalMethods.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "terminals.open": ["command", "terminal"],
      "terminals.run": ["command", "terminal"],
      "terminals.write": ["command", "terminal"],
      "terminals.resize": ["command", "terminal"],
      "terminals.close": ["command", "terminal"],
      "terminals.list": ["query", "terminal"],
      "terminals.subscribe": ["stream", "terminal"],
      "files.list": ["query", "terminal"],
      "files.read": ["query", "terminal"],
      "files.undo": ["command", "terminal"],
      "diffs.workingTree": ["query", "terminal"],
      "diffs.session": ["query", "terminal"],
    });
  });

  it("gives browsing and inspecting an environment's directories the scope of files.*, terminal, each a query (workspace-picker spec)", () => {
    const workspaceMethods = methods.filter((m) => m.name.startsWith("workspaces."));
    expect(Object.fromEntries(workspaceMethods.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "workspaces.browse": ["query", "terminal"],
      "workspaces.inspect": ["query", "terminal"],
    });
  });

  it("gives the providers methods the claude-adapter spec's scopes: the list at read, the processes at admin", () => {
    const providerMethods = methods.filter((m) => m.name.startsWith("providers."));
    expect(Object.fromEntries(providerMethods.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "providers.list": ["query", "read"],
      "providers.processes.list": ["query", "admin"],
      "providers.processes.stop": ["command", "admin"],
    });
  });

  it("gives the updates methods the launcher-update spec's scopes: the status and the check at read, the rest at admin, the desktop's stage a query", () => {
    const updateMethods = methods.filter((m) => m.name.startsWith("updates."));
    expect(Object.fromEntries(updateMethods.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "updates.status": ["query", "read"],
      "updates.check": ["query", "read"],
      "updates.apply": ["command", "admin"],
      "updates.cancel": ["command", "admin"],
      "updates.settings.set": ["command", "admin"],
      "updates.begin": ["command", "admin"],
      "updates.desktop.stage": ["query", "admin"],
    });
  });

  it("owes no updates method's handler: #335 registered them with none, and #342, #343, #346, #348 and #354 serve them all", () => {
    expect(Object.keys(OWED_HANDLERS).filter((name) => name.startsWith("updates."))).toEqual([]);
  });

  it("owes a handler only for a registered method, each to a named ticket", () => {
    for (const [name, ticket] of Object.entries(OWED_HANDLERS)) {
      expect(isMethodName(name), name).toBe(true);
      expect(ticket, name).toMatch(/^#\d+$/);
    }
  });

  it("names the command methods in a type of their own, which a query or a stream is not", () => {
    expectTypeOf<"sessions.create">().toExtend<CommandMethodName>();
    expectTypeOf<"sessions.list">().not.toExtend<CommandMethodName>();
    expectTypeOf<"sessions.subscribe">().not.toExtend<CommandMethodName>();
  });

  it("names every method area.verb", () => {
    for (const method of methods) expect(method.name).toMatch(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/);
  });

  it("is a query, a command or a stream", () => {
    expect(METHOD_KINDS).toEqual(["query", "command", "stream"]);
    for (const method of methods) expect(METHOD_KINDS, method.name).toContain(method.kind);
  });

  it("takes a commandId UUID in the params of every command", () => {
    for (const method of methods.filter((m) => m.kind === "command")) {
      expect(method.params.shape, method.name).toHaveProperty("commandId", CommandId);
    }
    expect(methods.filter((m) => m.kind === "command").map((m) => m.name)).toEqual([
      "web.origins.set",
      "attention.targets.set",
      "attention.targets.remove",
      "attention.routes.set",
      "attention.routes.remove",
      "attention.targets.configure",
      "attention.routes.configure",
      "environment.drain",
      "environment.rebuildProjections",
      "environment.rename",
      "environment.setIcon",
      "environment.setColour",
      "access.pairings.create",
      "access.sessions.revoke",
      "access.sessions.refresh",
      "access.sessions.setCeiling",
      "access.sessions.setAccess",
      ...methods.filter((m) => m.kind === "command" && /^(sessions|groups)\./.test(m.name)).map((m) => m.name),
      "runs.start",
      "runs.send",
      "runs.interrupt",
      "runs.stopTask",
      "runs.readNow",
      "runs.withdraw",
      "providers.processes.stop",
      "accounts.adopt",
      "accounts.add",
      "accounts.relabel",
      "accounts.remove",
      "accounts.signin.start",
      "accounts.signin.code",
      "accounts.signin.cancel",
      "instructions.create",
      "instructions.edit",
      "instructions.setScope",
      "instructions.setEnabled",
      "instructions.move",
      "instructions.resolveVersion",
      "instructions.remove",
      "instructions.dismissSuggestion",
      "instructions.restoreSuggestion",
      "instructions.import",
      "forge.accounts.add",
      "forge.accounts.update",
      "forge.accounts.remove",
      "forge.accounts.setPrimary",
      "forge.pullRequests.link",
      "forge.pullRequests.unlink",
      "banks.split.apply",
      "banks.migrate",
      "banks.validator.update",
      "banks.join",
      "banks.register",
      "banks.credential.set",
      "banks.credential.swap",
      "banks.create",
      "banks.publish",
      "banks.registry.update",
      "banks.pin",
      "banks.forget",
      "keyManagers.connections.add",
      "keyManagers.connections.signIn",
      "keyManagers.connections.update",
      "keyManagers.connections.setPolicies",
      "keyManagers.connections.setBasePath",
      "keyManagers.connections.setInjected",
      "keyManagers.connections.signOut",
      "keyManagers.connections.remove",
      "keyManagers.move",
      "keyManagers.move.copyValue",
      "tools.run",
      "settings.update",
      "permissions.mode.set",
      "permissions.containment.set",
      "permissions.settings.set",
      "permissions.prompts.answer",
      "permissions.review.seen",
      "permissions.denylist.set",
      "permissions.denylist.restorePresets",
      "setup.mint",
      "carryOver.run",
      "carryOver.assignMemory",
      "stateImport.run",
      "terminals.open",
      "terminals.run",
      "terminals.write",
      "terminals.resize",
      "terminals.close",
      "checks.set",
      "checks.run",
      "files.undo",
      "updates.apply",
      "updates.cancel",
      "updates.settings.set",
      "updates.begin",
      "routines.create",
      "routines.update",
      "routines.enable",
      "routines.disable",
      "routines.delete",
      "routines.import",
      "routines.runNow",
      "routines.endpoints.set",
      "routines.endpoints.remove",
      "skills.own.create",
      "skills.own.remove",
      "skills.carryOver",
      "skills.setAlwaysOn",
      "skills.setEnabled",
      "skills.sources.add",
      "skills.sources.remove",
      "skills.sources.pull",
      "skills.sources.setFollow",
      "trust.decide",
      "trust.revoke",
      "browser.chromes.rename",
      "browser.chromes.unpair",
    ]);
  });

  it("answers every command with its receipt beside its result, which a retry or a rejection leaves out", () => {
    const receipt = { status: "accepted", sequence: 3, changed: true } as const;
    for (const method of methods) {
      if (method.kind !== "command") {
        expect("response" in method, method.name).toBe(false);
        continue;
      }
      expect(method.response.shape.receipt, method.name).toBe(CommandReceipt);
      expect(method.response.safeParse({ receipt }).success, method.name).toBe(true);
      expect(method.response.safeParse({}).success, method.name).toBe(false);
    }
    const drain = registry["environment.drain"].response;
    expect(drain.safeParse({ receipt, result: { drainingSince: "2026-09-24T00:00:00.000Z", trigger: "command" } }).success).toBe(true);
    expect(drain.safeParse({ receipt, result: { trigger: "command" } }).success).toBe(false);
  });

  it("types a command's response as its receipt and an optional result, and a query's as its result", () => {
    expectTypeOf<ResponseOf<"access.pairings.create">>().toEqualTypeOf<{ receipt: CommandReceipt; result?: MintedPairing | undefined }>();
    expectTypeOf<ResultOf<"access.pairings.create">>().toEqualTypeOf<MintedPairing>();
    expectTypeOf<ResponseOf<"environment.status">>().toEqualTypeOf<ResultOf<"environment.status">>();
  });

  it("tells a command from its entry, narrowing it to one with a response", () => {
    expect(methods.filter(isCommand).map((m) => m.name)).toEqual(
      methods.filter((m) => m.kind === "command").map((m) => m.name),
    );
    const entry = registry["access.sessions.revoke"] as (typeof methods)[number];
    if (!isCommand(entry)) throw new Error("access.sessions.revoke is a command");
    expectTypeOf(entry.response.shape.receipt).toEqualTypeOf<typeof CommandReceipt>();
    expect(isCommand(registry["environment.status"])).toBe(false);
    expect(isCommand(registry["environment.subscribe"])).toBe(false);
  });

  it("takes an afterSequence cursor in the params of every stream", () => {
    const streams = methods.filter((m) => m.kind === "stream");
    expect(streams.map((m) => m.name)).toEqual(["environment.subscribe", "sessions.subscribe", "sessions.subscribeSession", "terminals.subscribe"]);
    for (const method of streams) expect(method.params.shape, method.name).toHaveProperty("afterSequence", Sequence);
  });

  it("recognises registered names only, never Object.prototype's", () => {
    expect(isMethodName("environment.status")).toBe(true);
    for (const name of ["environment.nope", "toString", "constructor", "__proto__", "hasOwnProperty", ""]) {
      expect(isMethodName(name), name).toBe(false);
    }
  });

  it("gives every method the shared error union plus its own members", () => {
    const method = defineMethod({
      name: "example.frob",
      scope: "read",
      params: z.object({}),
      result: z.object({}),
      errors: [errorSchema("frob_jammed", z.object({ attempts: z.int() }))],
      kind: "query",
    });
    expect(method.error.safeParse({ code: "frob_jammed", message: "m", data: { attempts: 2 } }).success).toBe(true);
    expect(method.error.safeParse({ code: "frob_jammed", message: "m", data: {} }).success).toBe(false);
    expect(method.error.safeParse({ code: "conflict", message: "m", data: {} }).success).toBe(true);
    expect(method.error.safeParse({ code: "jammed", message: "m", data: {} }).success).toBe(false);
    expectTypeOf<z.infer<typeof method.error>["code"]>().toEqualTypeOf<SharedErrorCode | "frob_jammed">();
    expectTypeOf<ErrorOf<"environment.status">["code"]>().toEqualTypeOf<SharedErrorCode>();
  });

  it("refuses a method's own error that reuses a shared code", () => {
    expect(() =>
      defineMethod({ ...unscoped, scope: "read", errors: [errorSchema("conflict", z.object({ with: z.string() }))] }),
    ).toThrow(/conflict/);
  });

  it("types params and results from the table", () => {
    expectTypeOf<MethodName>().toEqualTypeOf<
      | "attention.push.key"
      | "attention.push.test"
      | "web.origins.get"
      | "web.origins.set"
      | "attention.targets.list"
      | "attention.targets.set"
      | "attention.targets.remove"
      | "attention.routes.set"
      | "attention.routes.remove"
      | "attention.targets.configure"
      | "attention.routes.configure"
      | "environment.status"
      | "environment.subscribe"
      | "environment.drain"
      | "environment.rebuildProjections"
      | "environment.rename"
      | "environment.setIcon"
      | "environment.setColour"
      | "environment.knownEnvironments.report"
      | "access.pairings.create"
      | "access.sessions.list"
      | "access.sessions.revoke"
      | "access.sessions.refresh"
      | "access.sessions.setCeiling"
      | "access.sessions.setAccess"
      | "access.log.list"
      | "sessions.create"
      | "sessions.setWorkspace"
      | "sessions.rename"
      | "sessions.archive"
      | "sessions.unarchive"
      | "sessions.pin"
      | "sessions.unpin"
      | "sessions.reorderPinned"
      | "sessions.reorderActive"
      | "sessions.tag"
      | "sessions.untag"
      | "sessions.setDraft"
      | "sessions.setBrowser"
      | "sessions.setGroup"
      | "sessions.settle"
      | "sessions.unsettle"
      | "sessions.snooze"
      | "sessions.unsnooze"
      | "sessions.delete"
      | "sessions.restore"
      | "sessions.purge"
      | "sessions.fork"
      | "sessions.rewind"
      | "sessions.undoRewind"
      | "sessions.setInstructions"
      | "groups.create"
      | "groups.rename"
      | "groups.reorder"
      | "groups.delete"
      | "sessions.list"
      | "sessions.get"
      | "sessions.listDeleted"
      | "groups.list"
      | "sessions.subscribe"
      | "sessions.subscribeSession"
      | "sessions.subagentTranscript"
      | "runs.start"
      | "runs.send"
      | "runs.interrupt"
      | "runs.stopTask"
      | "runs.readNow"
      | "runs.withdraw"
      | "providers.list"
      | "providers.processes.list"
      | "providers.processes.stop"
      | "accounts.list"
      | "accounts.probe"
      | "accounts.refresh"
      | "accounts.adopt"
      | "accounts.add"
      | "accounts.relabel"
      | "accounts.remove"
      | "accounts.signin.get"
      | "accounts.signin.start"
      | "accounts.signin.code"
      | "accounts.signin.cancel"
      | "accounts.usage"
      | "accounts.handoff.recommend"
      | "models.list"
      | "commands.list"
      | "instructions.preview"
      | "instructions.list"
      | "instructions.diff"
      | "instructions.create"
      | "instructions.edit"
      | "instructions.setScope"
      | "instructions.setEnabled"
      | "instructions.move"
      | "instructions.resolveVersion"
      | "instructions.remove"
      | "instructions.dismissSuggestion"
      | "instructions.restoreSuggestion"
      | "instructions.import"
      | "forge.accounts.list"
      | "forge.accounts.add"
      | "forge.accounts.update"
      | "forge.accounts.remove"
      | "forge.accounts.setPrimary"
      | "forge.accounts.verify"
      | "forge.gh.probe"
      | "forge.detect"
      | "forge.orgs.list"
      | "forge.pullRequests.link"
      | "forge.pullRequests.unlink"
      | "forge.pullRequests.refresh"
      | "banks.split.propose"
      | "banks.split.apply"
      | "banks.migrate"
      | "banks.validator.update"
      | "banks.join"
      | "banks.join.preview"
      | "banks.drafts.list"
      | "banks.memory.search"
      | "banks.memory.read"
      | "banks.memory.draft"
      | "banks.memory.promote"
      | "banks.list"
      | "banks.get"
      | "banks.register"
      | "banks.registry.update"
      | "banks.pin"
      | "banks.forget"
      | "banks.credential.set"
      | "banks.credential.swap"
      | "banks.create"
      | "banks.publish"
      | "banks.verify"
      | "banks.sync"
      | "keyManagers.list"
      | "keyManagers.connections.add"
      | "keyManagers.connections.signIn"
      | "keyManagers.connections.update"
      | "keyManagers.connections.setPolicies"
      | "keyManagers.connections.signOut"
      | "keyManagers.connections.remove"
      | "keyManagers.connections.verify"
      | "keyManagers.certificate.preview"
      | "keyManagers.references.check"
      | "keyManagers.references.browse"
      | "keyManagers.connections.setBasePath"
      | "keyManagers.connections.setInjected"
      | "keyManagers.move.list"
      | "keyManagers.move"
      | "keyManagers.move.copyValue"
      | "tools.list"
      | "tools.detail"
      | "tools.verify"
      | "tools.run"
      | "settings.get"
      | "settings.update"
      | "permissions.mode.set"
      | "permissions.containment.set"
      | "permissions.settings.get"
      | "permissions.settings.set"
      | "permissions.prompts.list"
      | "permissions.prompts.answer"
      | "permissions.review.list"
      | "permissions.review.seen"
      | "permissions.denylist.get"
      | "permissions.denylist.set"
      | "permissions.denylist.restorePresets"
      | "permissions.denylist.test"
      | "setup.check"
      | "setup.mint"
      | "carryOver.inventory"
      | "carryOver.run"
      | "carryOver.assignMemory"
      | "stateImport.detect"
      | "stateImport.run"
      | "terminals.open"
      | "terminals.run"
      | "terminals.write"
      | "terminals.resize"
      | "terminals.close"
      | "terminals.list"
      | "terminals.subscribe"
      | "checks.get"
      | "checks.set"
      | "checks.run"
      | "files.list"
      | "files.read"
      | "files.undo"
      | "diffs.workingTree"
      | "diffs.session"
      | "workspaces.browse"
      | "workspaces.inspect"
      | "updates.status"
      | "updates.check"
      | "updates.apply"
      | "updates.cancel"
      | "updates.settings.set"
      | "updates.begin"
      | "updates.desktop.stage"
      | "routines.list"
      | "routines.history"
      | "routines.export"
      | "routines.checkImport"
      | "routines.scripts.list"
      | "routines.endpoints.list"
      | "routines.create"
      | "routines.update"
      | "routines.enable"
      | "routines.disable"
      | "routines.delete"
      | "routines.import"
      | "routines.runNow"
      | "routines.testPreCheck"
      | "routines.endpoints.set"
      | "routines.endpoints.remove"
      | "routines.endpoints.test"
      | "skills.get"
      | "skills.probe"
      | "skills.own.create"
      | "skills.own.remove"
      | "skills.carryOver"
      | "skills.setAlwaysOn"
      | "skills.setEnabled"
      | "skills.sources.add"
      | "skills.sources.remove"
      | "skills.sources.pull"
      | "skills.sources.setFollow"
      | "skills.readiness"
      | "trust.get"
      | "trust.list"
      | "trust.decide"
      | "trust.revoke"
      | "browser.status"
      | "browser.pairing.code"
      | "browser.chromes.list"
      | "browser.chromes.rename"
      | "browser.chromes.unpair"
      | "browser.chromes.perform"
      | "client.answer"
    >();
    expectTypeOf<ParamsOf<"access.sessions.revoke">>().toEqualTypeOf<{ commandId: string; clientSessionId: string }>();
  });

  it("does not compile a method without exactly one scope, and refuses one at run time too", () => {
    // @ts-expect-error: a method without a scope is a type error.
    expect(() => defineMethod(unscoped)).toThrow(/scope/);
    // @ts-expect-error: exactly one scope, not a list of them.
    expect(() => defineMethod({ ...unscoped, scope: ["read", "admin"] })).toThrow(/scope/);
    // @ts-expect-error: only the five scopes exist.
    expect(() => defineMethod({ ...unscoped, scope: "write" })).toThrow(/scope/);
  });

  it("does not compile a command without a commandId, or a stream without a cursor, and refuses them at run time", () => {
    // @ts-expect-error: a command takes a commandId.
    expect(() => defineMethod({ ...unscoped, scope: "admin", kind: "command" })).toThrow(/commandId/);
    // @ts-expect-error: a stream takes an afterSequence cursor.
    expect(() => defineMethod({ ...unscoped, scope: "read", kind: "stream" })).toThrow(/afterSequence/);
    // @ts-expect-error: there are three kinds of method.
    expect(() => defineMethod({ ...unscoped, scope: "read", kind: "notification" })).toThrow(/kind/);
  });
});

import { act, screen, waitFor, within } from "@testing-library/react";
import type { SkillsView, SkillsViewMember, SkillsViewSource } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

const member: SkillsViewMember = {
  name: "draft",
  kind: "skill",
  path: "skills/draft",
  description: "Draft a clear note.",
  invocation: "model+slash",
  userInvocable: true,
  argumentHint: null,
  whileActive: [],
  origin: null,
  layer: { kind: "own" },
  size: 400,
  tokens: 100,
  problems: [],
  warnings: [],
  shadowedBy: null,
  native: false,
  enabled: true,
  alwaysOn: false,
  choices: [],
};
const initial = (): SkillsView => ({
  ownDirectory: "/home/milo/skills/own",
  sources: [],
  choices: [],
  accountId: "writer",
  accounts: [{ accountId: "writer", channel: "system-prompt-append", reason: null }],
  members: [member],
});
const opened = async (configure?: (app: Awaited<ReturnType<typeof renderApp>>) => void, script: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ id: "writer", label: "Writer" }, { id: "local", label: "Local" }], sessions: [{ title: "Notes", accountId: "writer" }], ...script }] });
  const env = app.environment("desk");
  let value = initial();
  env.wire.answer("skills.get", () => ({ result: value }));
  env.wire.answer("trust.list", () => ({ result: { trusted: [], declined: [] } }));
  env.wire.answer("skills.own.create", (params) => {
    const added = { ...member, name: String(params.name), description: String(params.description), path: `skills/${String(params.name)}` };
    value = { ...value, members: [...value.members, added] };
    env.notice("skills.updated", {});
    return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { member: added } } };
  });
  configure?.(app);
  await app.user.keyboard("{Control>},{/Control}");
  await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Skills" }));
  return {
    app,
    env,
    update: (next: SkillsView) => {
      value = next;
      env.notice("skills.updated", {});
    },
  };
};
const pane = () => within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: "Skills" });

describe("the Skills row", () => {
  it("reads the own directory from the runtime and shows a created skill after the environment's notice", async () => {
    const { app, update } = await opened();
    await within(pane()).findByText("/home/milo/skills/own");
    expect(within(pane()).getByText("Draft a clear note.")).toBeDefined();
    await app.user.type(within(pane()).getByRole("textbox", { name: "Skill name" }), "release");
    await app.user.type(within(pane()).getByRole("textbox", { name: "Skill description" }), "Prepare a release.");
    await app.user.click(within(pane()).getByRole("button", { name: "Create skill" }));
    await within(pane()).findByText("Prepare a release.");
    update({ ...initial(), members: [] });
    await waitFor(() => expect(within(pane()).queryByText("Draft a clear note.")).toBeNull());
  });
});

const source: SkillsViewSource = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  url: "https://git.example.test/david/skills",
  identity: "https://git.example.test/david/skills",
  folder: ".",
  follow: { kind: "branch", branch: null },
  position: 1,
  addedBy: { kind: "client_session", id: "desk" },
  addedAt: "2026-09-29T10:00:00.000Z",
  commit: "c".repeat(40),
  skillCount: 1,
  sync: { outcome: "ok", since: "2026-09-29T10:00:00.000Z" },
  attemptedAt: "2026-09-29T10:00:00.000Z",
};
const accepted = (result: Record<string, unknown>) => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result } });

it("probes a URL, lets a person track the root skill, and shows Pull now's sync outcome from the live cache", async () => {
  const { app, update } = await opened((app) => {
    app.environment("desk").wire.answer("skills.probe", () => ({
      result: {
        probeId: source.id,
        identity: source.identity,
        branch: "main",
        commit: source.commit,
        root: {
          folder: ".",
          count: 1,
          licence: null,
          members: [{ name: "draft", path: ".", description: "Draft a clear note.", invocation: "model+slash", problems: [] }],
        },
        folders: [],
        truncated: false,
      },
    }));
  });
  const env = app.environment("desk");
  env.wire.answer("skills.sources.add", (params) => {
    expect(params).toMatchObject({ url: source.url, folder: ".", probeId: source.id, follow: { kind: "branch", branch: null } });
    update({ ...initial(), sources: [source] });
    return accepted({ source });
  });
  env.wire.answer("skills.sources.pull", () => {
    const failed = {
      ...source,
      sync: { outcome: "failed" as const, since: source.addedAt, problem: "network" as const, line: "Could not reach the repository." },
    };
    update({ ...initial(), sources: [failed] });
    return accepted({ source: failed });
  });
  await app.user.type(within(pane()).getByRole("textbox", { name: "Source URL" }), source.url);
  await app.user.click(within(pane()).getByRole("button", { name: "Probe repository" }));
  await app.user.click(await within(pane()).findByRole("checkbox", { name: /Track .: 1 skill/ }));
  await app.user.click(within(pane()).getByRole("button", { name: "Track selected folders" }));
  const card = await within(pane()).findByRole("region", { name: `${source.identity} — .` });
  expect(within(card).getByText("Default branch")).toBeDefined();
  await app.user.click(within(card).getByRole("button", { name: "Pull now" }));
  await within(card).findByText("Could not reach the repository.");
  expect(within(card).getByText(source.commit)).toBeDefined();
});

it("changes enabled and always-on choices through the runtime, explains readiness, and removes an own skill after confirmation", async () => {
  const { app, update } = await opened((app) => {
    app.open("desk");
    app.environment("desk").wire.answer("skills.readiness", () => ({
      result: {
        skills: [
          {
            name: "draft",
            state: "setup-needed",
            declaredBy: "sidecar",
            failing: [{ check: { kind: "file", paths: ["tracker.md"] }, outcome: "failed", message: "tracker.md is missing." }],
            why: "Create the tracker first.",
            fix: "/setup-tracker",
          },
        ],
      },
    }));
  });
  const env = app.environment("desk");
  env.wire.answer("skills.setEnabled", (params) => {
    expect(params).toMatchObject({ name: "draft", accountId: null, enabled: false });
    update({ ...initial(), choices: [{ kind: "enabled", name: "draft", accountId: null, enabled: false }], members: [{ ...member, enabled: false }] });
    return accepted({ choice: { kind: "enabled", name: "draft", accountId: null, enabled: false } });
  });
  env.wire.answer("skills.setAlwaysOn", (params) => {
    expect(params).toMatchObject({ name: "draft", accountId: "writer", on: true });
    update({
      ...initial(),
      choices: [{ kind: "always-on", name: "draft", accountId: "writer", on: true }],
      members: [{ ...member, alwaysOn: true, choices: [{ kind: "always-on", name: "draft", accountId: "writer", on: true }] }],
    });
    return accepted({ choice: { kind: "always-on", name: "draft", accountId: "writer", on: true } });
  });
  env.wire.answer("skills.own.remove", () => {
    update({ ...initial(), members: [] });
    return accepted({ member });
  });
  await within(pane()).findByText("Create the tracker first.");
  expect(within(pane()).getByText("tracker.md is missing.")).toBeDefined();
  expect(within(pane()).getByText("Fix: /setup-tracker")).toBeDefined();
  const enabled = within(pane()).getByRole("switch", { name: "Enabled draft on this environment" });
  await app.user.click(enabled);
  await waitFor(() => expect(enabled.getAttribute("aria-checked")).toBe("false"));
  const always = within(pane()).getByRole("switch", { name: "Every prompt draft on Writer" });
  await app.user.click(always);
  await waitFor(() => expect(always.getAttribute("aria-checked")).toBe("true"));
  expect(within(pane()).getByText(/400 characters · approximately 100 tokens on every prompt/)).toBeDefined();
  const skillsPane = pane();
  await app.user.click(within(skillsPane).getByRole("button", { name: "Remove own skill" }));
  expect(within(skillsPane).getByText("Draft a clear note.")).toBeDefined();
  await app.user.click(within(await screen.findByRole("dialog", { name: "Remove own skill draft" })).getByRole("button", { name: "Confirm remove skill" }));
  await waitFor(() => expect(within(pane()).queryByText("Draft a clear note.")).toBeNull());
});

it("shows the repository's trust question in its session and lists the granted decision with Revoke in Skills", async () => {
  const key = "https://git.example.test/david/notes";
  const { app } = await opened((app) => {
    const env = app.environment("desk");
    let trusted = false;
    env.wire.answer("trust.get", () => ({
      result: {
        key,
        keyKind: "identity",
        decision: trusted ? "trusted" : "undecided",
        offer: {
          instructionFiles: ["AGENTS.md"],
          skillRoots: [{ root: ".agents/skills", directory: ".", members: 2 }],
          commands: 1,
          hooks: [{ event: "PreToolUse", hooks: 1 }],
          permissionRules: { allow: 1, ask: 0, deny: 0 },
          subagents: 1,
          mcpServers: [{ name: "outside", loaded: false }],
        },
      },
    }));
    const record = {
      key,
      keyKind: "identity",
      decision: "trusted",
      decidedAt: "2026-09-29T10:00:00.000Z",
      clientSessionId: "desk",
      clientLabel: "Desk window",
      sessionId: null,
    };
    env.wire.answer("trust.list", () => ({ result: { trusted: trusted ? [record] : [], declined: [] } }));
    env.wire.answer("trust.decide", (params) => {
      expect(params.decision).toBe("trusted");
      trusted = true;
      env.notice("trust.updated", {});
      return accepted({ record });
    });
    env.wire.answer("trust.revoke", () => {
      trusted = false;
      env.notice("trust.updated", {});
      return accepted({ record });
    });
    app.open("desk");
  });
  await app.user.click(within(screen.getByRole("region", { name: "Settings" })).getByRole("button", { name: "Close Settings" }));
  const question = await screen.findByRole("region", { name: "Trust this repository?" });
  expect(within(question).getByText("AGENTS.md")).toBeDefined();
  expect(within(question).getByText("outside: not loaded")).toBeDefined();
  await app.user.click(within(question).getByRole("button", { name: "Trust repository" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Trust this repository?" })).toBeNull());
  await app.user.keyboard("{Control>},{/Control}");
  const trusted = await within(pane()).findByRole("region", { name: `Trusted: ${key}` });
  expect(within(trusted).getByText(/Desk window/)).toBeDefined();
  await app.user.click(within(trusted).getByRole("button", { name: "Revoke trust" }));
  await waitFor(() => expect(within(pane()).queryByRole("region", { name: `Trusted: ${key}` })).toBeNull());
});

it("names each account's switches, their tooltips and accessible names by the account's label, never its id (ticket 1752)", async () => {
  const accounts = [
    { id: "0bcb960d-1b0b-48d8-81f6-49fe44341431", label: "Personal mail" },
    { id: "da2d4db4-7bec-465c-b7ec-91938a15e3d2", label: "Team" },
    { id: "175f15dd-2b8e-4c3a-9d41-6a7e0f3c2b19", label: "Second" },
  ];
  const first = accounts[0]!.id;
  const { app, update } = await opened(undefined, { accounts, sessions: [{ title: "Notes", accountId: first }] });
  update({ ...initial(), accountId: first, accounts: accounts.map(({ id }) => ({ accountId: id, channel: "system-prompt-append", reason: null })) });
  for (const { label } of accounts) {
    expect(await within(pane()).findByRole("switch", { name: `Enabled draft on ${label}` })).toBeDefined();
    expect(within(pane()).getByText(`Enabled on ${label}`)).toBeDefined();
    // A tooltip opens on a keyboard's focus; it renders outside the pane, so its words are read on their own.
    await app.user.keyboard("{Shift}");
    for (const [control, words] of [[`Enabled draft on ${label}`, `Enabled on ${label}`], [`Every prompt draft on ${label}`, `Every prompt on ${label}`]] as const) {
      act(() => within(pane()).getByRole("switch", { name: control }).focus());
      await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain(words));
      expect(screen.getByRole("tooltip").textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  }
  expect(pane().textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  for (const control of within(pane()).getAllByRole("switch")) expect(control.getAttribute("aria-label")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
});

it("keeps admin verbs visible and dim with their scope reason, and keeps cached skills marked stale when disconnected", async () => {
  const { app, env, update } = await opened(undefined, { scopes: ["read"] });
  await within(pane()).findByText("Draft a clear note.");
  expect(within(pane()).getByRole("button", { name: "Create skill" }).hasAttribute("disabled")).toBe(true);
  expect(within(pane()).getByRole("button", { name: "Probe repository" }).hasAttribute("disabled")).toBe(true);
  expect(within(pane()).getAllByText(/admin/).length).toBeGreaterThan(0);
  update({ ...initial(), accounts: [...initial().accounts, { accountId: "local", channel: "none", reason: "This adapter cannot append instructions." }] });
  await within(pane()).findByText("This adapter cannot append instructions.");
  expect(within(pane()).getByRole("switch", { name: "Every prompt draft on Local" }).hasAttribute("disabled")).toBe(true);
  env.discovery("nothing");
  env.server.drop();
  await within(pane()).findByText(/^Stale:/);
  expect(within(pane()).getByText("Draft a clear note.")).toBeDefined();
  expect(within(pane()).getByRole("button", { name: "Create skill" }).hasAttribute("disabled")).toBe(true);
  expect(app.presentation.values.read()).not.toHaveProperty("skills");
});

it("reaches the form by keyboard, creates with Enter, and lists Skills actions in Keyboard shortcuts", async () => {
  const { app } = await opened();
  const name = within(pane()).getByRole("textbox", { name: "Skill name" });
  name.focus();
  await app.user.keyboard("release{Tab}Prepare a release.{Tab}{Enter}");
  await within(pane()).findByText("Prepare a release.");
  await app.user.click(within(screen.getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Keyboard shortcuts" }));
  const help = await screen.findByRole("region", { name: "Skills actions" });
  expect(within(help).getByText("Probe a skill repository and track selected folders")).toBeDefined();
  expect(within(help).getByText("Pull a source now, change its branch, pin or remove it")).toBeDefined();
  expect(within(help).getByText("Decide repository trust or revoke it")).toBeDefined();
});

it("refreshes a session's skills and readiness when its repository trust changes", async () => {
  let granted = false;
  const { app } = await opened((app) => {
    const env = app.environment("desk");
    env.wire.answer("skills.get", () => ({
      result: { ...initial(), members: granted ? [{ ...member, name: "repository-skill", description: "From the trusted repository." }] : [member] },
    }));
    env.wire.answer("skills.readiness", () => ({ result: { skills: [{ name: granted ? "repository-skill" : "draft", state: "ready", declaredBy: null }] } }));
    app.open("desk");
  });
  await within(pane()).findByText("Draft a clear note.");
  await within(pane()).findByText("Ready");
  granted = true;
  app.environment("desk").notice("trust.updated", {});
  await within(pane()).findByText("From the trusted repository.");
  expect(within(pane()).getByText("Ready")).toBeDefined();
  expect(within(pane()).queryByText("Draft a clear note.")).toBeNull();
});

it("pins and unpins a source, follows a named branch and removes it only after confirmation", async () => {
  const { app, update } = await opened();
  update({ ...initial(), sources: [source] });
  const env = app.environment("desk");
  env.wire.answer("skills.sources.setFollow", (params) => {
    const changed = { ...source, follow: params.follow };
    update({ ...initial(), sources: [changed as SkillsViewSource] });
    return accepted({ source: changed });
  });
  env.wire.answer("skills.sources.remove", () => {
    update(initial());
    return accepted({ source });
  });
  const card = await within(pane()).findByRole("region", { name: `${source.identity} — .` });
  await app.user.click(within(card).getByRole("button", { name: "Pin current commit" }));
  await within(card).findByText("Pinned commit");
  expect(within(card).getByRole("button", { name: "Pull now" }).hasAttribute("disabled")).toBe(true);
  expect(within(card).getByText("Pinned sources do not sync; unpin first.")).toBeDefined();
  await app.user.click(within(card).getByRole("button", { name: "Unpin" }));
  await within(card).findByText("Default branch");
  await app.user.type(within(card).getByRole("textbox", { name: /^Branch for/ }), "stable");
  await app.user.click(within(card).getByRole("button", { name: "Follow branch" }));
  await within(card).findByText("stable");
  await app.user.click(within(card).getByRole("button", { name: "Remove source" }));
  await app.user.click(within(await screen.findByRole("dialog", { name: "Remove skill source" })).getByRole("button", { name: "Confirm remove source" }));
  await waitFor(() => expect(within(pane()).queryByRole("region", { name: `${source.identity} — .` })).toBeNull());
});

it("shows a command's rejected receipt as one line and preserves the form for correction", async () => {
  const { app } = await opened();
  app.environment("desk").wire.answer("skills.own.create", () => ({
    result: {
      receipt: {
        status: "rejected",
        sequence: 1,
        changed: false,
        reason: "conflict",
        error: { code: "conflict", message: "That skill already exists.\nChoose another name.", data: { reason: "exists" } },
      },
    },
  }));
  await app.user.type(within(pane()).getByRole("textbox", { name: "Skill name" }), "draft");
  await app.user.type(within(pane()).getByRole("textbox", { name: "Skill description" }), "Another draft.");
  await app.user.click(within(pane()).getByRole("button", { name: "Create skill" }));
  await within(pane()).findByText("That skill already exists. Choose another name.");
  expect((within(pane()).getByRole("textbox", { name: "Skill name" }) as HTMLInputElement).value).toBe("draft");
  expect(within(pane()).queryByText("Another draft.")).toBeNull();
});

it("keeps a removal refusal visible inside its confirmation dialog", async () => {
  const { app } = await opened();
  app.environment("desk").wire.answer("skills.own.remove", () => ({
    result: {
      receipt: {
        status: "rejected",
        sequence: 1,
        changed: false,
        reason: "conflict",
        error: { code: "conflict", message: "The own directory is one root skill.", data: { reason: "root_skill" } },
      },
    },
  }));
  await within(pane()).findByText("Draft a clear note.");
  await app.user.click(within(pane()).getByRole("button", { name: "Remove own skill" }));
  const confirm = await screen.findByRole("dialog", { name: "Remove own skill draft" });
  await app.user.click(within(confirm).getByRole("button", { name: "Confirm remove skill" }));
  await within(confirm).findByText("The own directory is one root skill.");
  expect(within(confirm).getByRole("button", { name: "Cancel" })).toBeDefined();
});

it("refreshes readiness and skills when a session starts using another account", async () => {
  let account = "writer";
  const { app } = await opened((app) => {
    const env = app.environment("desk");
    env.wire.answer("skills.get", () => ({ result: { ...initial(), accountId: account, members: [{ ...member, description: `For ${account}.` }] } }));
    env.wire.answer("skills.readiness", () => ({
      result: {
        skills:
          account === "writer"
            ? [{ name: "draft", state: "ready", declaredBy: null }]
            : [
                {
                  name: "draft",
                  state: "unsupported",
                  declaredBy: "sidecar",
                  failing: [{ check: { kind: "provider", providers: ["claude"] }, outcome: "failed", message: "Use the writer account." }],
                  why: "This provider is unsupported.",
                  fix: null,
                },
              ],
      },
    }));
    app.open("desk");
  });
  await within(pane()).findByText("For writer.");
  await within(pane()).findByText("Ready");
  account = "other";
  const env = app.environment("desk");
  const sessionId = env.sessionId();
  env.emit(
    sessionId,
    "run.started",
    {
      runId: source.id,
      accountId: "other",
      identity: null,
      model: "model",
      effort: null,
      mode: { requested: null, effective: "acceptEdits", clamped: false },
      workspace: env.summary(sessionId).workspace,
      origin: "client",
      promptMessageId: null,
      queuedMessageIds: [],
      resumedFrom: null,
      forkedFrom: null,
    },
    { fields: { accountId: "other" } },
  );
  await within(pane()).findByText("For other.");
  await within(pane()).findByText("This provider is unsupported.");
});

it("keeps a shadowed own command visible without letting Remove delete its winning skill instead", async () => {
  const { update } = await opened();
  update({
    ...initial(),
    members: [
      member,
      {
        ...member,
        kind: "command",
        path: "commands/draft.md",
        description: "The command is shadowed.",
        shadowedBy: { layer: { kind: "own" }, path: "skills/draft" },
      },
    ],
  });
  await within(pane()).findByText("The command is shadowed.");
  const card = within(pane())
    .getAllByRole("region", { name: "draft" })
    .find((region) => within(region).queryByText("The command is shadowed.") !== null);
  expect(card).toBeDefined();
  expect(within(card!).getByRole("button", { name: "Remove own skill" }).hasAttribute("disabled")).toBe(true);
  expect(within(card!).getByText("Another own member wins this name; remove that member first.")).toBeDefined();
});

it("keeps a saved choice visible when its skill disappears from the set", async () => {
  const { update } = await opened();
  await within(pane()).findByText("Draft a clear note.");
  update({ ...initial(), choices: [{ kind: "enabled", name: "missing-procedure", accountId: null, enabled: true }] });
  const missing = await within(pane()).findByRole("region", { name: "Missing skill missing-procedure" });
  expect(missing.textContent).toContain("Saved choices apply when this skill is available again.");
});

it("places trusted and declined repository cards in the same responsive collection", async () => {
  await opened((app) => {
    const record = { keyKind: "identity", decidedAt: "2026-10-02T00:00:00.000Z", clientSessionId: "desk", clientLabel: "Desk window", sessionId: null };
    app.environment("desk").wire.answer("trust.list", () => ({ result: {
      trusted: [{ ...record, key: "https://git.example.test/team/procedures", decision: "trusted" }],
      declined: [{ ...record, key: "https://git.example.test/team/guides", decision: "declined" }],
    } }));
  });
  const trusted = await within(pane()).findByRole("region", { name: "Trusted: https://git.example.test/team/procedures" });
  const declined = await within(pane()).findByRole("region", { name: "Declined: https://git.example.test/team/guides" });
  const grid = trusted.parentElement!;
  expect(grid.hasAttribute("data-settings-card-grid")).toBe(true);
  expect(declined.parentElement).toBe(grid);
  expect(within(trusted).getByRole("button", { name: "Revoke trust" })).toBeDefined();
  expect(within(declined).getByRole("button", { name: "Trust repository" })).toBeDefined();
});

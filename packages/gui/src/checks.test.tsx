import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["workspaceChecks"], sessions: [{ title: "Checks", workspace: { kind: "directory", path: "/repo" } }, { title: "Other", workspace: { kind: "directory", path: "/repo" } }], ...more }] });
  const env = app.environment("desk");
  let command: string | null = null;
  env.wire.answer("checks.get", () => ({ result: { workspace: "/canonical/repo", command } }));
  env.wire.answer("checks.set", (params) => {
    command = params["command"] as string | null;
    return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { workspace: "/canonical/repo", command } } };
  });
  app.open("desk");
  await screen.findByRole("region", { name: "Transcript" });
  return { app, env, session: env.sessionId(), configured: () => command, change: (text: string | null) => { command = text; env.notice("checks.changed", { workspace: "/canonical/repo", command }); } };
};
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const enter = async (app: Awaited<ReturnType<typeof opened>>["app"], text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  act(() => box().focus());
  await app.user.keyboard("{Enter}");
};

describe("Workspace checks in the GUI", () => {
  it("gets, saves verbatim and clears the canonical directory command across Sessions and Client notices", async () => {
    const { app, env, configured, change } = await opened();
    await enter(app, "/check");
    await screen.findByText("After-edit check: off for /canonical/repo.");
    const command = "  pnpm test  &&\nprintf 'done'  ";
    await enter(app, `/check ${command}`);
    await waitFor(() => expect(configured()).toBe(command));
    const configuration = await screen.findByRole("region", { name: "Workspace check" });
    expect(configuration.textContent).toBe(`After-edit check: $ ${command}`);
    app.open("desk", 1);
    await waitFor(() => expect(screen.getByRole("region", { name: "Workspace check" }).textContent).toContain(command));
    act(() => change("saved on the laptop"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Workspace check" }).textContent).toContain("saved on the laptop"));
    await enter(app, "/check off");
    await waitFor(() => expect(configured()).toBeNull());
    expect(env.requests("runs.start")).toHaveLength(0);
    expect(env.requests("terminals.run")).toHaveLength(0);
  });

  it("says above the composer what the check is, in one labelled line, with the workspace and how to turn it on in its tooltip", async () => {
    const { app, change } = await opened();
    const strip = await screen.findByRole("region", { name: "Workspace check" });
    await waitFor(() => expect(strip.textContent).toBe("After-edit check: off"));
    expect(strip.querySelectorAll("p")).toHaveLength(1);
    act(() => within(strip).getByText("After-edit check: off").focus());
    const tooltip = (await screen.findByRole("tooltip")).textContent;
    expect(tooltip).toContain("Workspace: /canonical/repo.");
    expect(tooltip).toContain("after the agent edits files");
    expect(tooltip).toContain("/check <command> turns it on");
    act(() => change("pnpm test"));
    await waitFor(() => expect(strip.textContent).toBe("After-edit check: $ pnpm test"));
    expect(strip.textContent).not.toContain("/canonical/repo");
    await enter(app, "/check");
    await screen.findByText("After-edit check: $ pnpm test", { selector: '[role="status"]' });
    act(() => (strip.querySelector("[tabindex]") as HTMLElement).focus());
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toMatch(/^\$ pnpm test · Workspace: \/canonical\/repo\./));
  });

  it("names the after-edit check when the Environment cannot run it, rather than showing a bare reason", async () => {
    await opened({ capabilities: [] });
    const strip = await screen.findByRole("region", { name: "Workspace check" });
    expect(strip.textContent).toBe("After-edit check: desk runs an older agent-harness without this. Update desk to use it.");
  });

  it("names the after-edit check when reading it fails", async () => {
    const { app, env } = await opened();
    env.wire.answer("checks.get", () => ({ error: { code: "forbidden", message: "Reading the check was refused.", data: {} } }));
    app.open("desk", 1);
    await waitFor(() => expect(screen.getByRole("region", { name: "Workspace check" }).textContent).toBe("After-edit check: Reading the check was refused."));
  });
});

const TERMINAL = "0199aa00-0000-4000-8000-000000000003";
const RUN = "0199aa00-0000-4000-8000-000000000004";
const started = { terminalId: TERMINAL, command: "pnpm test", sourceRunId: null };
const finished = { ...started, output: "failed assertion", truncated: false, exitCode: 1, signal: null, timedOut: false, failure: null };

it("renders manual and automatic dollar-command rows, streaming output, pass, timeout, exit and truncation", async () => {
  const { app, env, session, change } = await opened({ terminals: [{ id: TERMINAL, output: "live check output" }] });
  act(() => change("pnpm test"));
  act(() => env.emit(session, "checks.started", started));
  const row = await screen.findByRole("article", { name: "Workspace check" });
  await within(row).findByText("live check output");
  expect(row.textContent).toContain("$ pnpm test");
  expect(row.textContent).toContain("running");
  act(() => env.terminalOutput(TERMINAL, "\nmore output"));
  await waitFor(() => expect(row.textContent).toContain("more output"));
  act(() => env.emit(session, "checks.finished", { ...finished, output: "durable result", exitCode: 0 }));
  await within(row).findByText("durable result");
  expect(row.textContent).toContain("passed");
  expect(row.textContent).toContain("exit 0");
  act(() => env.emit(session, "checks.finished", { ...finished, terminalId: RUN, sourceRunId: RUN, timedOut: true, exitCode: null, truncated: true }));
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Workspace check" })).toHaveLength(2));
  const rows = screen.getAllByRole("article", { name: "Workspace check" });
  await within(rows[1]!).findByText("failed assertion");
  expect(rows[1]!.textContent).toContain("timed out");
  expect(rows[1]!.textContent).toContain("exit none");
  expect(rows[1]!.textContent).toContain("Earlier output omitted");
  await screen.findByRole("button", { name: "Send failure" });
  expect(env.requests("runs.start")).toHaveLength(0);
  expect(env.requests("terminals.run")).toHaveLength(0);
  expect(env.requests("terminals.subscribe")).toHaveLength(1);
  expect(app.shell.calls.some(([member]) => String(member).startsWith("terminal."))).toBe(false);
});

it.each([
  { capabilities: [] as const, scopes: undefined, reason: "unsupported" },
  { capabilities: ["workspaceChecks"] as const, scopes: ["read", "sessions:write", "runs:drive"] as const, reason: "scope" },
])("dims /check with the shared reason when $reason is absent and dispatches nothing", async ({ capabilities, scopes }) => {
  const { app, env } = await opened({ capabilities: [...capabilities], ...(scopes === undefined ? {} : { scopes: [...scopes] }) });
  fireEvent.change(box(), { target: { value: "/check" } });
  const option = await screen.findByRole("option", { name: /\/check/ });
  const availability = app.runtime.projections.checks(env.environmentId, env.sessionId()).read().availability;
  if (availability.status !== "absent") throw new Error("Checks should be absent.");
  expect(option.getAttribute("aria-disabled")).toBe("true");
  expect(option.textContent).toContain(availability.message);
  await enter(app, "/check now");
  await screen.findByText(`After-edit check: ${availability.message}`, { selector: '[role="status"]' });
  expect(env.requests("checks.run")).toHaveLength(0);
  expect(env.requests("checks.set")).toHaveLength(0);
});

it("reports unset, busy, refused and accepted manual execution without local shell work", async () => {
  const { app, env } = await opened();
  for (const reason of ["check_unset", "check_running", "workspace_missing"]) {
    env.wire.answer("checks.run", () => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: "conflict", error: { code: "conflict", message: "The check cannot run.", data: { reason } } } } }));
    await enter(app, "/check now");
    await screen.findByText(`${reason}: The check cannot run.`);
  }
  env.wire.answer("checks.run", () => ({ error: { code: "forbidden", message: "Terminal grant revoked.", data: { scope: "terminal" } } }));
  await enter(app, "/check now");
  await screen.findByText("forbidden: Terminal grant revoked.");
  env.wire.answer("checks.run", () => ({ result: { receipt: { status: "accepted", sequence: 3, changed: true }, result: { terminalId: TERMINAL } } }));
  await enter(app, "/check now");
  await screen.findByText("After-edit check running on the Environment.");
  expect(env.requests("checks.run")).toHaveLength(5);
  expect(env.requests("terminals.run")).toHaveLength(0);
  expect(env.requests("runs.start")).toHaveLength(0);
});

it("sends a replayed failure once on empty Enter and never replaces a retained draft", async () => {
  const { app, env, session, change } = await opened();
  act(() => change("pnpm test"));
  app.open("desk", 1);
  await waitFor(() => expect(app.shown()?.sessionId).toBe(env.sessionId(1)));
  act(() => env.emit(session, "checks.finished", { ...finished, sourceRunId: RUN }));
  app.open("desk", 0);
  await screen.findByRole("button", { name: "Send failure" });
  expect(screen.getByRole("article", { name: "Workspace check" }).textContent?.match(/exit 1/g)).toHaveLength(1);
  expect(env.requests("runs.start")).toHaveLength(0);
  fireEvent.change(box(), { target: { value: "keep this draft" } });
  await app.user.click(screen.getByRole("button", { name: "Send failure" }));
  await waitFor(() => expect(env.requests("runs.start")).toHaveLength(1));
  expect(box().value).toBe("keep this draft");
  expect(env.requests("runs.start")[0]?.params).toMatchObject({ text: "$ pnpm test\nCheck failure; exit 1\nfailed assertion" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull());
  act(() => env.emit(session, "checks.finished", { ...finished, sourceRunId: RUN, terminalId: "0199aa00-0000-4000-8000-000000000007" }));
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Workspace check" })).toHaveLength(2));
  expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull();
  act(() => env.emit(session, "checks.finished", { ...finished, sourceRunId: RUN, exitCode: 0, terminalId: "0199aa00-0000-4000-8000-000000000008" }));
  act(() => env.emit(session, "checks.finished", { ...finished, sourceRunId: RUN, terminalId: "0199aa00-0000-4000-8000-000000000009" }));
  await screen.findByRole("button", { name: "Send failure" });
  expect(box().value).toBe("keep this draft");
  act(() => change(null));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull());
  act(() => change("pnpm test"));
  await waitFor(() => expect(screen.getByRole("region", { name: "Workspace check" }).textContent).toContain("pnpm test"));
  expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull();
  act(() => env.emit(session, "checks.finished", { ...finished, sourceRunId: RUN, terminalId: "0199aa00-0000-4000-8000-000000000010" }));
  await screen.findByRole("button", { name: "Send failure" });
  await enter(app, "");
  await waitFor(() => expect(env.requests("runs.send")).toHaveLength(1));
  expect(env.requests("runs.start")).toHaveLength(1);
  expect(box().value).toBe("");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull());
  act(() => box().focus());
  await app.user.keyboard("{Enter}");
  expect(env.requests("runs.send")).toHaveLength(1);
});

it("dims checks while unreachable and does not enqueue configuration or execution", async () => {
  const { app, env } = await opened();
  env.autoAccept(false);
  env.discovery("nothing");
  env.server.drop();
  await screen.findByText("Locked: desk cannot be reached.");
  await enter(app, "/check now");
  const optionReason = app.runtime.projections.checks(env.environmentId, env.sessionId()).read().availability;
  if (optionReason.status !== "absent") throw new Error("Checks should be unreachable.");
  await screen.findByText(`After-edit check: ${optionReason.message}`, { selector: '[role="status"]' });
  await enter(app, "/check printf never");
  expect(env.requests("checks.run")).toHaveLength(0);
  expect(env.requests("checks.set")).toHaveLength(0);
});

it("invalidates changed commands and manual now resets identical automatic failures", async () => {
  const { app, env, session, change } = await opened();
  act(() => change("pnpm test"));
  act(() => env.emit(session, "checks.finished", { ...finished, sourceRunId: RUN }));
  await screen.findByRole("button", { name: "Send failure" });
  act(() => change("pnpm lint"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull());
  await enter(app, "/check pnpm test");
  await screen.findByText("After-edit check saved for this Workspace.");
  expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull();
  act(() => env.emit(session, "checks.finished", { ...finished, sourceRunId: RUN, terminalId: "0199aa00-0000-4000-8000-000000000007" }));
  await screen.findByRole("button", { name: "Send failure" });
  env.wire.answer("checks.run", () => {
    const terminalId = "0199aa00-0000-4000-8000-000000000008";
    const event = env.emit(session, "checks.started", { ...started, terminalId });
    return { result: { receipt: { status: "accepted", sequence: event.sequence, changed: true }, result: { terminalId } } };
  });
  await enter(app, "/check now");
  await screen.findByText("After-edit check running on the Environment.");
  expect(screen.queryByRole("button", { name: "Send failure" })).toBeNull();
  act(() => env.emit(session, "checks.finished", { ...finished, terminalId: "0199aa00-0000-4000-8000-000000000008" }));
  await screen.findByRole("button", { name: "Send failure" });
  expect(env.requests("runs.start")).toHaveLength(0);
});

it("keeps a refused failure offer and draft, and renders an explicit launch failure", async () => {
  const { app, env, session, change } = await opened();
  act(() => change("pnpm test"));
  act(() => env.emit(session, "checks.finished", { ...finished, failure: "launch_failed", output: "Workspace no longer exists", exitCode: null }));
  await screen.findByText("Workspace no longer exists");
  await screen.findByRole("button", { name: "Send failure" });
  env.wire.answer("runs.start", () => ({ error: { code: "conflict", message: "Cannot start this Run.", data: {} } }));
  fireEvent.change(box(), { target: { value: "my draft" } });
  await app.user.click(screen.getByRole("button", { name: "Send failure" }));
  await screen.findByText(/Cannot start this Run/);
  expect(box().value).toBe("my draft");
  expect(screen.getByRole("button", { name: "Send failure" })).toBeTruthy();
});

it("leaves imported after-edit text inert until a person explicitly saves it", async () => {
  const { app, env, configured } = await opened();
  await app.platform.documents.set("terminal.afterEdit", { "/canonical/repo": "imported command" });
  await enter(app, "/check");
  await screen.findByText("After-edit check: off for /canonical/repo.");
  env.wire.answer("checks.run", () => ({ error: { code: "conflict", message: "The check is unset.", data: { reason: "check_unset" } } }));
  await enter(app, "/check now");
  await screen.findByText("check_unset: The check is unset.");
  expect(env.requests("checks.set")).toHaveLength(0);
  expect(env.requests("terminals.run")).toHaveLength(0);
  await enter(app, "/check imported command");
  await waitFor(() => expect(configured()).toBe("imported command"));
});

it("requires an actually empty composer for Enter to send failure output", async () => {
  const { app, env, session, change } = await opened();
  act(() => change("pnpm test"));
  act(() => env.emit(session, "checks.finished", finished));
  await screen.findByRole("button", { name: "Send failure" });
  fireEvent.change(box(), { target: { value: "  \n" } });
  act(() => box().focus());
  await app.user.keyboard("{Enter}");
  expect(env.requests("runs.start")).toHaveLength(0);
  expect(box().value).toBe("  \n");
  expect(screen.getByRole("button", { name: "Send failure" })).toBeTruthy();
});

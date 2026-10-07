// @vitest-environment jsdom-on-node
import { act, render, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DRAFT_DEBOUNCE_MS, createRuntime, uuidv4, type Runtime } from "@agent-harness/client-runtime";
import { fakeShell, inMemoryPlatform, type InMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { deltaShown, holdBackLastOf } from "../../environment/test/delta-hold-back.js";
import { end, fakeAdapter, gate, say, type Script } from "../../environment/test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { workspace } from "../../environment/test/sessions.js";
import { App } from "../src/app.js";
import { showSession } from "../src/grid/layout.js";
import { openPresentation } from "../src/presentation.js";

/**
 * The composer through the real spine (docs/specs/gui.md, "Testing
 * Decisions"; #400), serial: the #108 in-process environment on a temporary
 * data directory and loopback port 0, with the scripted fake provider; the
 * real client runtime over a real WebSocket; and the window rendered in
 * jsdom over it. A send streams through the fake provider into the rendered
 * transcript, and the composer's text reaches a second runtime of the same
 * environment as the session's draft, whose own draft comes back into the
 * composer only while nothing was typed over what the window held. A
 * message queued during a run and taken back with Edit (#401) comes back
 * through the draft into the window's composer and a second window's.
 */

const { onCleanup } = useCleanups();

/** A runtime on the in-memory platform over the real network, paired with `t`'s environment. */
const pairedRuntime = async (t: TestEnvironment, platform: InMemoryPlatform): Promise<Runtime> => {
  const runtime = createRuntime(platform);
  onCleanup(() => runtime.close());
  await runtime.start();
  const outcome = await runtime.connections.add({ link: (await t.createPairing()).link });
  if (outcome.status !== "paired") throw new Error(`The runtime could not pair: ${JSON.stringify(outcome)}.`);
  return runtime;
};

/**
 * A window over its own runtime, paired with `t`'s environment, with a session open in its pane: `sessionId`, made
 * there by another window, or one it makes. Its parts are found within it, so two windows can be open side by side.
 */
const openWindow = async (t: TestEnvironment, opening?: { readonly sessionId: string }) => {
  const platform = inMemoryPlatform({ kind: "desktop", shell: fakeShell() });
  const runtime = await pairedRuntime(t, platform);
  const presentation = await openPresentation(platform.documents, platform.reportError);
  onCleanup(() => presentation.close());
  // A window launched before, whose Set up was closed: the first launch's would take the whole window (#413).
  presentation.set("firstLaunchDone", true);
  const view = render(<App runtime={runtime} presentation={presentation} clock={platform.clock} version={platform.client.version} macOS={false} shell={platform.shell} />);
  onCleanup(() => view.unmount());

  const environmentId = t.env.id;
  const sessionId = opening?.sessionId ?? uuidv4();
  if (opening === undefined) {
    const created = await runtime.commands.dispatch(environmentId, "sessions.create", { id: sessionId, workspace });
    if (!created.ok) throw new Error(`The session was not made: ${created.error.message}`);
  }
  const layout = presentation.values.read().paneLayout;
  act(() => presentation.set("paneLayout", showSession(layout, layout.focused, { environmentId, sessionId })));
  const inWindow = within(view.container);
  const transcript = await inWindow.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.", {}, { timeout: 5000 });
  const box = inWindow.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  const user = userEvent.setup();
  return {
    platform,
    environmentId,
    sessionId,
    inWindow,
    user,
    transcript,
    box,
    /** Keys typed into the composer, focused first: jsdom lays nothing out, so a click would land on the sidebar's divider. */
    async write(keys: string) {
      act(() => box.focus());
      await user.keyboard(keys);
    },
  };
};

/** A second runtime of the same environment, following the session's projection as another client's composer would. */
const secondClient = async (t: TestEnvironment, environmentId: string, sessionId: string) => {
  const runtime = await pairedRuntime(t, inMemoryPlatform({ kind: "tui" }));
  const session = runtime.projections.session(environmentId, sessionId);
  onCleanup(session.subscribe(() => undefined));
  return { runtime, draft: () => session.read().draft };
};

describe("the composer through the real spine", { concurrent: false }, () => {
  it("streams a send through the fake provider into the rendered transcript, and its draft reaches a second runtime", async () => {
    const t = await startTestEnvironment({ name: "smoke-composer" });
    onCleanup(() => t.close());
    holdBackLastOf(t, "Looking at ");
    const streamed = gate();
    const script: Script = async function* () {
      yield { type: "assistant.delta", payload: { itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] } };
      await streamed.opened;
      yield say("Looking at the receipts.", "i-1");
      yield end();
    };
    t.adapter.nextScripts.push(script);
    const window = await openWindow(t);

    await window.write("Fix the receipts{Enter}");
    const message = await within(window.transcript).findByRole("article", { name: "Your message" }, { timeout: 5000 });
    expect(message.textContent).toBe("Fix the receipts");
    // Streamed: the words the delta brought, before the reply settles, as markdown draws them (a paragraph's end trimmed).
    const reply = () => within(window.transcript).getAllByRole("article", { name: "Reply" }).at(-1)?.textContent;
    const shows = (prefix: string) => waitFor(() => expect(reply()?.slice(0, prefix.trimEnd().length)).toBe(prefix.trimEnd()), { timeout: 5000 });
    await deltaShown(t, "Looking at ", shows);
    expect(reply()).toBe("Looking at");
    streamed.open();
    await waitFor(() => expect(reply()).toBe("Looking at the receipts."), { timeout: 5000 });
    await window.inWindow.findByRole("button", { name: "Send" });

    // The text is the session's draft: typed in the window, it is in another runtime of the same environment.
    const other = await secondClient(t, window.environmentId, window.sessionId);
    await window.write("half a thought");
    act(() => window.platform.clock.advance(DRAFT_DEBOUNCE_MS));
    await waitFor(() => expect(other.draft()).toBe("half a thought"), { timeout: 5000 });
  });

  it("takes a second runtime's draft while nothing was typed over what the window held, and keeps what was typed over it", async () => {
    const t = await startTestEnvironment({ name: "smoke-draft" });
    onCleanup(() => t.close());
    const window = await openWindow(t);
    const other = await secondClient(t, window.environmentId, window.sessionId);

    other.runtime.drafts.set(window.environmentId, window.sessionId, "typed on the laptop");
    other.runtime.drafts.flush();
    await waitFor(() => expect(window.box.value).toBe("typed on the laptop"), { timeout: 5000 });

    // Typed over here, waiting its second: the laptop's next draft does not replace it, and it goes out after.
    await window.write(", and more");
    other.runtime.drafts.set(window.environmentId, window.sessionId, "typed on the laptop again");
    other.runtime.drafts.flush();
    await waitFor(() => expect(other.draft()).toBe("typed on the laptop again"), { timeout: 5000 });
    expect(window.box.value).toBe("typed on the laptop, and more");

    act(() => window.platform.clock.advance(DRAFT_DEBOUNCE_MS));
    await waitFor(() => expect(other.draft()).toBe("typed on the laptop, and more"), { timeout: 5000 });
    expect(window.box.value).toBe("typed on the laptop, and more");
  });

  it("takes a queued message back with Edit: its text comes into this window's composer and a second window's open on the session", async () => {
    // A provider without a queue of its own: the environment holds what is sent during a run, and takes it back itself.
    const t = await startTestEnvironment({ name: "smoke-withdraw", adapter: fakeAdapter({ capabilities: { providerQueue: false, steering: false } }) });
    onCleanup(() => t.close());
    const working = gate();
    t.adapter.nextScripts.push(async function* () {
      await working.opened;
      yield say("Done.");
      yield end();
    });
    const window = await openWindow(t);
    const other = await openWindow(t, { sessionId: window.sessionId });

    await window.write("Fix the receipts{Enter}");
    await window.inWindow.findByRole("button", { name: "Stop" }, { timeout: 5000 });
    await window.write("and the tests{Enter}");
    const queued = await within(window.transcript).findByRole("article", { name: "Queued message" }, { timeout: 5000 });
    await within(other.transcript).findByRole("article", { name: "Queued message" }, { timeout: 5000 });

    await window.user.click(within(queued).getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(window.box.value).toBe("and the tests"), { timeout: 5000 });
    await waitFor(() => expect(other.box.value).toBe("and the tests"), { timeout: 5000 });
    expect(within(window.transcript).queryByRole("article", { name: "Queued message" })).toBeNull();
    expect(within(other.transcript).queryByRole("article", { name: "Queued message" })).toBeNull();
    working.open();
  });
});

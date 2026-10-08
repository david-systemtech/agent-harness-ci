import { StoredCredentialUnavailableError } from "@agent-harness/client-runtime";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openHeaderMenu } from "../test/header-actions.js";
import { renderApp } from "../test/harness.js";
import { sideColumnKey } from "./presentation.js";

/**
 * A blocked environment's capability line (#1772): every surface that asks
 * for a capability the block leaves absent says the block as the sidebar
 * does, a sentence with what to do, and never the reason's id.
 */

const STORED_CREDENTIALS = "This app cannot read its saved key for laptop. Pair again.";

/** A session open on the paired laptop, whose stored credentials then cannot be read. */
const blockedLaptop = async () => {
  const app = await renderApp({
    environments: [
      { name: "desk", reach: "local", sessions: [{ title: "Receipts" }] },
      { name: "laptop", reach: "paired", sessions: [{ title: "Parser" }] },
    ],
  });
  app.open("laptop");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  const laptop = app.environment("laptop");
  app.shell.answer("secrets.get", () => { throw new StoredCredentialUnavailableError("OS approval was unavailable."); });
  await act(async () => app.runtime.connections.retryNow(laptop.environmentId));
  await waitFor(() => expect(app.runtime.projections.environments.read().find((view) => view.environmentId === laptop.environmentId)).toMatchObject({ phase: "blocked", blocked: "credential-unavailable" }));
  return app;
};

describe("an environment blocked because its stored credentials could not be read", () => {
  it("says so in words in the composer's lock, the Terminal pane and Restore a deleted session, never as credential-unavailable", async () => {
    const app = await blockedLaptop();

    expect(await screen.findByText(`Locked: ${STORED_CREDENTIALS}`)).toBeDefined();

    const menu = await openHeaderMenu(app);
    expect(within(menu).getByRole("menuitem", { name: "Terminal" }).textContent).toContain(STORED_CREDENTIALS);
    await app.user.keyboard("{Escape}");
    // The pane as a relaunch finds it, open from before the block (#1772's QA): it opens no terminal and says why.
    act(() => app.presentation.set("sideColumns", { [sideColumnKey(app.shown()!)]: { open: ["terminal"], shown: "terminal", hidden: false } }));
    const terminal = within(await screen.findByRole("complementary", { name: "Side column" })).getByRole("region", { name: "Terminal", hidden: true });
    await waitFor(() => expect(within(terminal).queryByRole("status")?.textContent).toBe(`No terminal: ${STORED_CREDENTIALS}`));
    expect(app.environment("laptop").requests("terminals.open")).toEqual([]);

    await app.user.click(within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("button", { name: "Restore a deleted session…" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore a deleted session" });
    expect(await within(dialog).findByText(`laptop could not be asked: ${STORED_CREDENTIALS}`)).toBeDefined();

    expect(document.body.textContent).not.toContain("credential-unavailable");
  });
});

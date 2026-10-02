// @vitest-environment jsdom-on-node
import { act, screen, waitFor } from "@testing-library/react";
import { fakeShell, type FakeShell } from "@agent-harness/client-runtime/testing";
import { type PageCommand } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp } from "../test/harness.js";
import { dockPeer } from "../test/dock-peer.js";

const callDock = async (app: RenderedApp, command: PageCommand) => {
  const env = app.environment("desk");
  const callId = crypto.randomUUID();
  env.notice("client.call", {
    callId,
    clientSessionId: env.wire.credential()!.clientSessionId,
    kind: "browser.dock",
    payload: {
      pageKey: `${env.environmentId}/${env.sessionId()}`,
      command,
      deadline: new Date(app.runtime.environmentNow(env.environmentId).getTime() + 60_000).toISOString(),
    },
  });
  await waitFor(() => expect(env.requests("client.answer").some((request) => request.params["callId"] === callId)).toBe(true));
  return env.requests("client.answer").find((request) => request.params["callId"] === callId)!.params;
};

describe("the dock's client-call driver", () => {
  it("creates a hidden page on a call, and opening the pane shows that same page", async () => {
    const { shell, peer } = dockPeer();
    const app = await renderApp(
      {
        environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }],
      },
      { shell },
    );
    app.open("desk");
    const answer = await callDock(app, {
      verb: "open",
      args: { url: "https://example.org/receipts" },
    });
    expect(answer).toMatchObject({
      ok: true,
      result: { ok: true, value: { url: "https://example.org/receipts" } },
    });
    expect(shell.calls.some(([name]) => name === "webView.attach")).toBe(false);
    expect(peer.targets().filter((target) => target.type === "page")).toHaveLength(1);
    await app.user.click(await screen.findByRole("button", { name: "Browser" }));
    await waitFor(() => expect(shell.calls.some(([name]) => name === "webView.attach")).toBe(true));
    expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("https://example.org/receipts");
    expect(shell.calls.filter(([name]) => name === "webView.create")).toHaveLength(1);
  });
  it("answers unsupported when the view has no debugger channel", async () => {
    const shell = {
      ...fakeShell(),
      webView: { ...fakeShell().webView, debugger: undefined },
    } as unknown as FakeShell;
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{}] }] }, { shell });
    expect(await callDock(app, { verb: "snapshot", args: {} })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(shell.calls.some(([name]) => name === "webView.create")).toBe(false);
  });

  it("refuses deep verbs before sending anything to the peer", async () => {
    const { shell, peer } = dockPeer();
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{}] }] }, { shell });
    for (const verb of ["console", "network", "cookies", "storage", "evaluate"] as const) {
      expect(
        await callDock(app, {
          verb,
          args: verb === "evaluate" ? { expression: "1" } : {},
        } as PageCommand),
      ).toMatchObject({
        ok: true,
        result: {
          ok: false,
          reason: expect.stringContaining(`has no ${verb} verb`),
        },
      });
    }
    expect(peer.sent).toEqual([]);
  });

  it("reads the home denylist, refreshes it on a change and refuses a listed sub-frame whole", async () => {
    const { shell, peer } = dockPeer();
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{}] }] }, { shell });
    app.open("desk");
    expect(
      await callDock(app, {
        verb: "open",
        args: { url: "https://shop.example/" },
      }),
    ).toMatchObject({ result: { ok: true } });
    act(() =>
      app.environment("desk").setDenylist({
        browserDomains: [
          {
            id: "listed-for-tests",
            pattern: "*.payments.example",
            note: "Payments",
            preset: false,
            enabled: true,
          },
        ],
      }),
    );
    const cache = app.runtime.requests.cached(app.environment("desk").environmentId, "permissions.denylist.get", {});
    await waitFor(() => expect(cache.read().result?.denylist.browserDomains[0]?.id).toBe("listed-for-tests"));
    const held = await callDock(app, {
      verb: "navigate",
      args: { url: "https://payments.example/" },
    });
    expect(held).toMatchObject({
      result: {
        ok: false,
        reason: expect.stringContaining("denylist"),
        denylist: {
          frame: "top-level",
          match: { entry: { id: "listed-for-tests" } },
        },
      },
    });
    expect(peer.sentOf("Page.navigate").some(({ params }) => params["url"] === "https://payments.example/")).toBe(false);
    peer
      .targets()
      .find((target) => target.type === "page")!
      .navigate("https://payments.example/redirect");
    expect(await callDock(app, { verb: "snapshot", args: {} })).toMatchObject({
      result: {
        ok: false,
        denylist: {
          frame: "top-level",
          match: { entry: { id: "listed-for-tests" } },
        },
      },
    });
    peer.document("https://shop.example/checkout", {
      frames: [{ url: "https://payments.example/embed", crossSite: true }],
    });
    expect(
      await callDock(app, {
        verb: "navigate",
        args: { url: "https://shop.example/checkout" },
      }),
    ).toMatchObject({
      result: { ok: false, reason: expect.stringContaining("frame") },
    });
  });
});

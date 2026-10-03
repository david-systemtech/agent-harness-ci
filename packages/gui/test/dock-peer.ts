import { cdpConnection, pipeTransport, type CdpSession } from "@agent-harness/browser";
import { scriptedCdpPeer } from "@agent-harness/browser/testing";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { onTestFinished } from "vitest";

/** A recording shell whose debugger speaks the real CDP wire to the scripted peer. */
export const dockPeer = () => {
  const peer = scriptedCdpPeer();
  const connection = cdpConnection(pipeTransport(peer.pipe()));
  const shell = fakeShell();
  const sessions = new Map<string, CdpSession>();
  const targets = new Map<string, string>();
  const events = new Set<Parameters<NonNullable<typeof shell.webView.debugger>["onEvent"]>[0]>();
  const detached = new Set<Parameters<NonNullable<typeof shell.webView.debugger>["onDetach"]>[0]>();
  shell.answer("webView.create", async ({ url }) => {
    const target = peer.createPage(url);
    const id = `view-${targets.size + 1}`;
    targets.set(id, target.targetId);
    return id;
  });
  shell.answer("webView.state", async (id) => ({
    url: peer.target(targets.get(id)!).url,
    canGoBack: false,
    canGoForward: false,
    loading: false,
  }));
  shell.answer("webView.debugger.attach", async (id) => {
    const session = await connection.attach(targets.get(id)!);
    sessions.set(id, session);
    session.onEvent((event) => {
      for (const listener of events) listener(id, event);
    });
    session.onDetach((reason) => {
      for (const listener of detached) listener(id, reason);
    });
  });
  shell.answer("webView.debugger.send", (id, method, params, child) => sessions.get(id)!.send(method, params, child));
  shell.answer("webView.debugger.detach", async (id) => {
    await sessions.get(id)?.detach();
    sessions.delete(id);
  });
  shell.answer("webView.debugger.onEvent", (listener) => {
    events.add(listener);
    return () => void events.delete(listener);
  });
  shell.answer("webView.debugger.onDetach", (listener) => {
    detached.add(listener);
    return () => void detached.delete(listener);
  });
  shell.answer("webView.destroy", (id) => peer.target(targets.get(id)!).close());
  onTestFinished(async () => {
    connection.close();
    await peer.close();
  });
  return { shell, peer, targets };
};

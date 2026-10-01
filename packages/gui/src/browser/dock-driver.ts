import { CdpError, cdpPageDriver, type CdpSession } from "@agent-harness/browser";
import type { Runtime, ShellWebView } from "@agent-harness/client-runtime";
import { BrowserDockCall, SessionId, type PageCall, type PagePolicy } from "@agent-harness/contracts";
import type { PaneSession } from "../presentation.js";

/** Registers the dock's client-call handler while following the home environment's live browser policy. */
export const registerDockDriver = (runtime: Runtime, views: ShellWebView, homeId: string, page: (session: PaneSession) => Promise<string>): (() => void) => {
  const debug = views.debugger!;
  const cached = runtime.requests.cached(homeId, "permissions.denylist.get", {});
  const stopPolicy = cached.subscribe(() => undefined);
  const attached = new Set<CdpSession>();
  let closed = false;
  const policy = (): PagePolicy => ({
    devSites: [],
    deepReadEverywhere: false,
    evaluateEverywhere: false,
    browserDomains: cached.read().result?.denylist.browserDomains ?? [],
  });
  const driver = cdpPageDriver({
    kind: "dock",
    policy,
    host: {
      async attach(pageKey) {
        if (closed) throw new Error("The desktop window closed.");
        const [environmentId, sessionId] = pageKey.split("/");
        const id = await page({
          environmentId: environmentId!,
          sessionId: sessionId!,
        });
        if (closed) throw new Error("The desktop window closed.");
        await debug.attach(id);
        if (closed) {
          await debug.detach(id);
          throw new Error("The desktop window closed.");
        }
        const stops = new Set<() => void>();
        const session: CdpSession = {
          send: async (method, params, child) => {
            try {
              return await debug.send(id, method, params, child);
            } catch (error) {
              throw new CdpError(error instanceof Error ? error.message : String(error));
            }
          },
          onEvent: (listener) => {
            const stop = debug.onEvent((viewId, event) => {
              if (viewId === id) listener(event);
            });
            stops.add(stop);
            return () => {
              stops.delete(stop);
              stop();
            };
          },
          onDetach: (listener) => {
            const stop = debug.onDetach((viewId, reason) => {
              if (viewId === id) listener(reason);
            });
            stops.add(stop);
            return () => {
              stops.delete(stop);
              stop();
            };
          },
          async detach() {
            attached.delete(session);
            for (const stop of stops) stop();
            stops.clear();
            await debug.detach(id);
          },
        };
        attached.add(session);
        return session;
      },
    },
  });
  const readyPolicy = async (): Promise<boolean> => {
    if (!cached.read().loading && (cached.read().result !== null || cached.read().error !== null)) return true;
    return new Promise((resolve) => {
      const stop = cached.subscribe(() => {
        if (!cached.read().loading) {
          stop();
          pending.delete(cancel);
          resolve(!closed);
        }
      });
      const cancel = () => {
        stop();
        resolve(false);
      };
      pending.add(cancel);
    });
  };
  const pending = new Set<() => void>();
  const stopCalls = runtime.clientCalls.register("browser.dock", async (call) => {
    const parsed = BrowserDockCall.safeParse(call.payload);
    if (!parsed.success) throw new Error("The call does not name a dock page and verb this desktop can read.");
    const asked = parsed.data;
    const sessionId = asked.pageKey.slice(call.environmentId.length + 1);
    if (!asked.pageKey.startsWith(`${call.environmentId}/`) || !SessionId.safeParse(sessionId).success)
      throw new Error("The dock's page key must name a session of the calling environment.");
    const expired = () => runtime.environmentNow(call.environmentId).getTime() >= Date.parse(asked.deadline);
    if (expired()) throw new Error("The call came after its deadline, so the dock did not perform it.");
    if (!(await readyPolicy()) || closed) throw new Error("The desktop window closed.");
    if (cached.read().error || cached.read().result === null) throw new Error("The home environment's browser denylist could not be read, so the dock did not perform the verb.");
    if (expired()) throw new Error("The call passed its deadline before the dock could perform it.");
    return driver.perform(asked as PageCall);
  });
  return () => {
    closed = true;
    stopCalls();
    stopPolicy();
    for (const cancel of pending) cancel();
    pending.clear();
    for (const session of attached) void session.detach().catch(() => undefined);
  };
};

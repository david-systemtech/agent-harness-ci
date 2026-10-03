import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../src/app.js";
import type { AccessSettingsDetail } from "./access-settings-details.js";
import { prepareWorld, startWorld } from "./world.js";

async function openAccessWorld(row: "access.permissions" | "access.browser", detail: AccessSettingsDetail | undefined, ladder: LadderName) {
  const prepared = await prepareWorld({ environments: [{
    name: "desk", reach: "local", accounts: [{ label: "Personal" }],
    ...(detail === undefined ? {} : {
      settings: { "browser.devSites": ["app.example.test"] },
      review: [{
        counts: { toolCalls: 2, autoApproved: 1, denied: 1, answeredByPerson: 0, expired: 0 },
        denials: [{ toolCallId: "test-call", tool: "Read", summary: "Read /test/private/report.txt", decidedBy: "denylist" as const, reason: "Protected test folder." }],
      }],
    }),
  }] }, { presentation: { settingsRow: row, lightOrDark: ladder } });
  const desk = prepared.world.environment("desk");
  desk.wire.answer("browser.status", () => ({ result: {
    listener: { state: "listening", port: 47615 },
    folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: true,
    headless: { allowRuns: false, availability: { available: true, source: { kind: "launched", executable: "/test/chromium" } }, liveContexts: 0 },
  } }));
  desk.wire.answer("browser.chromes.list", () => ({ result: { chromes: detail?.pairing === true ? [] : [{
    id: "0199aa00-0000-4000-8000-000000000041", name: "Project Chrome", connected: true, outdated: false,
    pairedAt: "2026-09-24T00:00:00.000Z", lastConnectedAt: "2026-09-24T00:00:00.000Z", lastReportedVersion: "0.1.0",
  }] } }));
  desk.wire.answer("browser.pairing.code", () => ({ result: { code: "ABCD2345", expiresAt: new Date(prepared.clock.now().getTime() + 300_000).toISOString() } }));
  if (detail !== undefined) {
    const entry = (id: string, pattern: string) => ({ id, pattern, note: "Protected test resource.", enabled: true, preset: false });
    desk.wire.answer("permissions.denylist.get", () => ({ result: { denylist: {
      browserDomains: [entry("test-domain", "private.example.test")],
      paths: [entry("test-path", "/test/private/**")],
      commandPatterns: [entry("test-command", "sudo *")],
      hosts: [entry("test-host", "protected.example.test")],
    } } }));
  }
  return { ...prepared, ...await startWorld(prepared, prepared.paired) };
}

type AccessWorld = Awaited<ReturnType<typeof openAccessWorld>>;
const closeAccessWorld = (world: AccessWorld) => {
  world.stopFollowing();
  void world.presentation.close();
  void world.runtime.close();
};

/** Real Settings, a fresh held-clock world per mount, and explicit scroll/state captures. */
export function accessSettingsScene(row: "access.permissions" | "access.browser", detail?: AccessSettingsDetail) {
  return function AccessSettingsScene({ ladder }: { readonly ladder: LadderName }) {
    const [world, setWorld] = useState<AccessWorld>();
    const [ready, markReady] = useState(false);
    useEffect(() => {
      let active = true;
      let opened: AccessWorld | undefined;
      void openAccessWorld(row, detail, ladder).then((next) => {
        if (!active) return closeAccessWorld(next);
        opened = next;
        setWorld(next);
      });
      return () => { active = false; if (opened !== undefined) closeAccessWorld(opened); };
    }, [ladder]);
    useEffect(() => {
      if (world === undefined) return;
      world.shell.openDeepLink(settingsDeepLink(row));
      let pairing = false;
      const check = () => {
        const pane = document.querySelector<HTMLElement>(`section[aria-label="${row === "access.browser" ? "Browser" : "Permissions"}"]`);
        if (pane === null) return;
        if (row === "access.browser" && (detail === undefined || detail.pairing === true) && !pairing) {
          const button = [...pane.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Pair another Chrome");
          if (button !== undefined && !button.disabled) { pairing = true; button.click(); }
        }
        const selector = row === "access.browser" && (detail === undefined || detail.pairing === true)
          ? 'input[aria-label="Pairing code"]' : row === "access.permissions" ? 'form[aria-label="Add to Hosts"]' : 'select[aria-label="Default browser for Personal"]';
        if (pane.querySelector(selector) === null) return;
        if (detail !== undefined) {
          if (detail.visible.some((target) => pane.querySelector(target) === null)) return;
          const anchor = pane.querySelector<HTMLElement>(detail.anchor);
          if (anchor === null) return;
          // Scroll only the body. Leave 20px above the target, matching the pane's inset.
          pane.scrollTop += anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20;
          anchor.dataset["accessScrollAnchor"] = "";
        }
        observer.disconnect();
        markReady(true);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
      return () => observer.disconnect();
    }, [world]);
    return <>{world !== undefined && <App {...world} />}{ready && <span data-access-scene-ready hidden />}</>;
  };
}

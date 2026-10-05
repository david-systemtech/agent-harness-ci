import { settingsDeepLink } from "@agent-harness/client-runtime";
import type { SkillsView } from "@agent-harness/contracts";
import type { LadderName } from "@agent-harness/theme";
import { useEffect, useState } from "react";
import { App } from "../../src/app.js";
import { settingsGeometry } from "../settings-scene.js";
import type { SceneViewport } from "../scene-registry.js";
import { prepareWorld, startWorld } from "../world.js";

const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Personal" }] }] });
const skills: SkillsView = {
  ownDirectory: "/home/example/skills/own", sources: ["procedures", "guides"].map((name, index) => ({
    id: `0199dd00-0000-4000-8000-00000000000${index + 1}`,
    url: `https://git.example.test/team/${name}`, identity: `https://git.example.test/team/${name}`,
    folder: ".", follow: { kind: "branch", branch: null }, position: index + 1,
    addedBy: { kind: "client_session", id: "desk" }, addedAt: "2026-10-02T00:00:00.000Z",
    commit: "c".repeat(40), skillCount: 1, sync: { outcome: "ok", since: "2026-10-02T00:00:00.000Z" },
    attemptedAt: "2026-10-02T00:00:00.000Z",
  })), choices: [], accountId: "personal",
  accounts: [{ accountId: "personal", channel: "system-prompt-append", reason: null }],
  members: [{ name: "review", kind: "skill", path: "skills/review", description: "Read the change and explain what matters.", invocation: "model+slash", userInvocable: true, argumentHint: null, whileActive: [],
    origin: { kind: "manifest", repository: "https://git.example.test/team/procedures", path: "skills/review", commit: null, licence: "MIT" },
    layer: { kind: "own" }, size: 800, tokens: 200, problems: [], warnings: [], shadowedBy: null, native: false, enabled: true, alwaysOn: false, choices: [] }],
};
prepared.world.environment("desk").wire.answer("skills.get", () => ({ result: skills }));
prepared.world.environment("desk").wire.answer("trust.list", () => ({ result: {
  trusted: [{ key: "https://git.example.test/team/procedures", keyKind: "identity", decision: "trusted", decidedAt: "2026-10-02T00:00:00.000Z", clientSessionId: "desk", clientLabel: "Desk window", sessionId: null }],
  declined: [{ key: "https://git.example.test/team/guides", keyKind: "identity", decision: "declined", decidedAt: "2026-10-02T00:00:00.000Z", clientSessionId: "desk", clientLabel: "Desk window", sessionId: null }],
} }));
const world = await startWorld(prepared, prepared.paired);
export default function SkillsScene({ ladder }: { readonly ladder: LadderName }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    world.presentation.set("lightOrDark", ladder);
    prepared.shell.openDeepLink(settingsDeepLink("knowledge.skills"));
    const drawn = () => {
      if (document.querySelector('[aria-label="Every prompt review on personal"]') === null
      || document.querySelector('[aria-label="Declined: https://git.example.test/team/guides"]') === null) return;
      observer.disconnect();
      setReady(true);
    };
    const observer = new MutationObserver(drawn);
    observer.observe(document.body, { childList: true, subtree: true });
    drawn();
    return () => observer.disconnect();
  }, [ladder]);
  useEffect(() => () => { world.stopFollowing(); void world.presentation.close(); void world.runtime.close(); }, []);
  return <><App {...world} clock={prepared.clock} shell={prepared.shell} version={prepared.version} macOS={false} />{ready && <span hidden data-skills-scene-ready="true" />}</>;
}
export const readySelector = '[data-skills-scene-ready="true"]';
/** look.md §12.1–12.3 and §5: Settings cap, 32px fields and 32×18.4 switches. */
export const geometry = (viewport: SceneViewport) => [
  ...settingsGeometry(viewport),
  { selector: 'input[aria-label="Source URL"]', height: 32 },
  { selector: '[data-settings-card-grid] > section:is([aria-label^="Trusted:"], [aria-label^="Declined:"])', width: viewport.width >= 1280 ? 541 : 720, contentFits: true },
  { selector: '[data-settings-card-grid] > section[aria-label^="https://git.example.test/team/"]', width: viewport.width >= 1280 ? 541 : 720, contentFits: true },
  { selector: '[aria-label="Every prompt review on personal"]', width: 32, height: 18.4 },
];

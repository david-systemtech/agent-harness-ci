import { DEFAULT_THEME } from "@agent-harness/contracts";
import { cssVariables, derive, type LadderName } from "@agent-harness/theme";
import type { CSSProperties, ReactNode } from "react";
import type { DetailsReport } from "../src/setup/details.js";
import type { SetupState } from "../src/setup/health-dot.js";
import { MoreOptions } from "../src/setup/more-options.js";
import { SetupNotice, type NoticeTone } from "../src/setup/notice.js";
import { StateBadge } from "../src/setup/state-badge.js";
import { StepIntro } from "../src/setup/step-intro.js";
import { Button } from "../src/ui/index.js";
import type { SceneGeometry, SceneViewport } from "./scene-registry.js";

const copy = async () => {};
const report: DetailsReport = {
  app: { version: "0.9.2", platform: "Linux x64" },
  computer: { name: "desk", version: "0.9.1" },
  step: { label: "Forges", id: "forges", state: "needs-attention" },
  checkedAt: "2026-10-08T06:24:00.000Z",
  line: "GitHub does not accept the saved token.",
  failing: ["forges.token"],
  details: ["github.com answered HTTP 401"],
};
const NOTICES: readonly { readonly tone: NoticeTone; readonly heading: string; readonly description: string; readonly action: string }[] = [
  { tone: "info", heading: "Checked just now", description: "Nothing changed since the last check.", action: "Check again" },
  { tone: "warning", heading: "Chrome is not connected", description: "Open Chrome to let agents use it.", action: "Try again" },
  { tone: "error", heading: "GitHub needs a new token", description: "Make a new token on GitHub and paste it here.", action: "Add token" },
];
const STATES: readonly SetupState[] = ["done", "needs-attention", "skipped", "pending", "unchecked", "unavailable"];

const Part = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => <section aria-label={title} className="flex min-w-0 flex-col gap-3"><h2 className="text-xs font-medium text-ink-muted">{title}</h2>{children}</section>;

/**
 * Set up's shared parts (#1835): each notice tone with Details shut and open,
 * a step's intro with More options, and every state badge.
 */
export const SetupPartsScene = ({ ladder = "dark" }: { readonly ladder?: LadderName }) => (
  <main data-scene="setup-parts" data-ladder={ladder} style={{ ...cssVariables(derive(DEFAULT_THEME)[ladder]), colorScheme: ladder } as CSSProperties} className="min-h-screen bg-abyss p-4 text-sm text-ink">
    <h1 className="mb-3 text-lg font-medium">Set up parts</h1>
    <div className="grid grid-cols-3 gap-5">
      {NOTICES.map(({ tone, heading, description, action }) => (
        <Part key={tone} title={`Notice: ${tone}`}>
          {[false, true].map((open) => <SetupNotice key={String(open)} tone={tone} title={heading} description={description} actions={<Button variant="outline" size="sm">{action}</Button>} details={{ report, copy, defaultOpen: open }} />)}
        </Part>
      ))}
      <Part title="Step intro">
        <StepIntro step="forges" title="Where do you keep your code?" why="Agents use it to read and push your projects." what="A forge is a website that keeps your code, like GitHub, Forgejo or Gitea." />
        <MoreOptions step="forges"><p>Agents push to a branch of their own.</p></MoreOptions>
        <MoreOptions step="permissions" label="More safety settings"><p>Paths agents must ask about.</p></MoreOptions>
      </Part>
      <Part title="State words">
        <ul className="flex flex-col gap-2">{STATES.map((state) => <li key={state}><StateBadge state={state} /></li>)}</ul>
      </Part>
    </div>
  </main>
);

/** look.md §5.3's Alert and §13's step intro, at the default 16px root. */
export const setupPartsGeometry = ({ width, height }: SceneViewport): readonly SceneGeometry[] => [
  { selector: "main[data-scene=setup-parts]", width, minimumHeight: height, tolerance: 0.1 },
  { selector: "[data-notice-tone]", paddingLeft: 10, paddingTop: 8, contentFits: true },
  { selector: "[data-notice-tone] > svg", width: 16, height: 16 },
  { selector: "[data-step-intro] > p:first-child", fontSize: 11 },
  { selector: "[data-step-intro] > h2", fontSize: 20 },
  { selector: "[data-state-badge] > [data-state-word]", unbroken: true },
];

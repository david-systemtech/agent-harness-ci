import { hostileHtml, hostileSvg } from "./phone-preview-fixtures.js";
import type { SceneModule } from "./scene-registry.js";
import { presentation as dockPresentation, script as dockScript } from "./scenes/dock-diff.js";
import { arrange as documents } from "./scenes/dock-documents.js";
import { arrange as tasks } from "./scenes/dock-tasks.js";
import { sideColumnKey, type SidePane } from "../src/presentation.js";

export type PhonePaneScene = "files" | "file" | "diff" | "documents" | "tasks" | "agent" | "preview" | "markdown" | "scope";

/** The actual retained dock, over browser storage and the environment wire, at each phone profile. */
export const phonePaneScene = (kind: PhonePaneScene): SceneModule => {
  const session = dockPresentation.paneLayout!.rows[0]!.panes[0]!.session!;
  const shown: SidePane = kind === "file" || kind === "scope" ? "files" : kind === "agent" ? "tasks" : kind === "preview" || kind === "markdown" ? "documents" : kind;
  const selectors: Record<PhonePaneScene, string> = {
    files: "[data-file-row]", file: "[data-file-code]", diff: "[data-diff]",
    documents: "[data-document-actions]", tasks: '[aria-label="Live work"]', agent: '[aria-label="The agent\'s transcript"]',
    preview: 'iframe[title="Preview of site/index.html"]', markdown: "[data-preview-markdown]", scope: '[aria-label="Files"] p',
  };
  return {
    platform: "web",
    script: { environments: dockScript.environments.map(env => ({
      ...env, reach: "paired", scopes: kind === "scope" ? ["read", "sessions:write", "runs:drive"] : ["read", "sessions:write", "runs:drive", "terminal"],
      provider: { subagentTranscripts: true },
      subagentTranscripts: { "call-running": [{ type: "assistant", uuid: "agent-reply", message: { role: "assistant", content: "The parser is in src/parser.ts.\n\n" + "Read the fixtures before changing the parser. ".repeat(30) } }] },
      files: [...(env.files ?? []), "totals.ts"],
      fileContents: { "totals.ts": "const total = " + "1 + ".repeat(80) + "0;\nexport { total };\n" },
    })) },
    presentation: { ...dockPresentation, sidebarShown: false, sideColumns: { [sideColumnKey(session)]: { open: ["files", "diff", "documents", "tasks"], shown, hidden: false } } },
    arrangeWeb: world => {
      documents(world);
      tasks(world);
      const env = world.environment("desk");
      const { runId } = env.startRun(session.sessionId, "Draw a static receipt summary");
      env.writeFile(session.sessionId, runId, "site/index.html", kind === "preview" ? hostileHtml : '<!doctype html><h1>Receipt summary</h1><p>Totals are checked in integer cents.</p><script>parent.document.body.textContent="unsafe";fetch("https://example.test/pixel")</script><img src="https://example.test/pixel"><form action="https://example.test"><input></form>');
      if (kind === "preview") env.writeFile(session.sessionId, runId, "chart.svg", hostileSvg);
      env.endRun(session.sessionId, runId);
    },
    activate: () => {
      let reopened = false, clicked = false;
      const observer = new MutationObserver(() => click());
      const click = () => {
        // A phone opens the session with the sheet it left open hidden (#1903): the scene opens it again from the header's control.
        const handle = document.querySelector<HTMLButtonElement>("[data-dock-reopen]");
        if (!reopened && handle) { reopened = true; handle.click(); }
        if (clicked) return;
        const selector = kind === "file" ? '[data-file-row]' : kind === "agent" ? '[aria-label="Explore: Find the parser"] button' : kind === "preview" ? '[aria-label="site/index.html"] button' : kind === "markdown" ? '[aria-label="notes.md"] button' : null;
        if (!selector) return;
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
        const button = kind === "file" ? buttons.find(b => b.textContent?.includes("totals.ts")) : buttons[0];
        if (!button) return;
        clicked = true;
        button.click();
      };
      observer.observe(document.body, { childList: true, subtree: true });
      click();
      return () => { observer.disconnect(); };
    },
    readySelector: selectors[kind],
    geometry: [
      { selector: "[data-dock-sheet]", maxWidth: 480, contentFits: true, visibleWithin: "[data-web-client]" },
      { selector: "[data-dock-rail]", width: 52 },
      { selector: '[data-dock-sheet] :is(button, a[download])', renderedOnly: true, minimumWidth: 44, minimumHeight: 44 },
      { selector: '[aria-label="Close side sheet"]', visibleWithin: "[data-web-client]" },
      { selector: selectors[kind], renderedOnly: true },
    ],
  };
};

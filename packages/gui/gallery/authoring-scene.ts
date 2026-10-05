import type { ScriptedPrompt } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneGeometry, SceneModule } from "./scene-registry.js";
import { notebook } from "./bank-scene.js";

/** Deliberately exceeds both desktop and phone scrollports, with independent answer text. */
export const authoringQuestions: ScriptedPrompt = {
  kind: "question", input: null, summary: "Which facts should this bank retain?",
  questions: Array.from({ length: 8 }, (_, at) => ({
    header: `Topic ${at + 1}`, question: `What should topic ${at + 1} retain?`, multiSelect: false,
    options: [
      { label: "Working agreements", description: "Keep the team's conventions and explain when to apply each agreement." },
      { label: "Project decisions", description: "Keep the reasons behind decisions and the evidence that could change them." },
      { label: "Useful discoveries", description: "Keep repeatable observations, useful commands and the context needed to use them." },
    ],
  })),
};

export const authoringGeometry: readonly SceneGeometry[] = [
  { selector: "[data-authoring-dialog]", visibleWithin: "body", contentFits: true },
  { selector: '[data-authoring-frame] [aria-label="Transcript"]', minimumHeight: 44, visibleWithin: "[data-authoring-dialog]" },
  { selector: '[aria-label="Questions"]', minimumHeight: 44, visibleWithin: '[aria-label="Parked prompt"]' },
  { selector: '[aria-label="Question decision"]', visibleWithin: '[aria-label="Parked prompt"]' },
  { selector: '[aria-label="Question decision"] button', visibleWithin: "[data-authoring-dialog]", hitTestable: true },
  { selector: '[data-authoring-frame] [aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-authoring-dialog]", hitTestable: true },
];

/** Real Settings bank card and mint boundary; phones use the browser platform and a paired environment. */
export function bankAuthoringScene(phone = false): SceneModule {
  const arrange: NonNullable<SceneModule["arrangeWeb"]> = world => {
    const environment = world.environment("desk");
    const sessionId = environment.sessionId();
    const bank = notebook();
    environment.wire.answer("banks.list", () => ({ result: { banks: [bank] } }));
    environment.wire.answer("setup.mint", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { sessionId } } }));
    const { runId } = environment.startRun(sessionId, "Describe the project memory bank.");
    environment.emit(sessionId, "assistant.text", { runId, itemId: "bank-introduction", text: "Let's describe the bank's working agreements, decisions and useful discoveries.", aborted: false });
    environment.openPrompt(sessionId, authoringQuestions);
  };
  return {
    ...(phone ? { platform: "web", arrangeWeb: arrange } : { arrange: world => arrange(world) }),
    script: { environments: [{ name: "desk", reach: phone ? "paired" : "local", capabilities: ["banks", "setup"], accounts: [{ label: "Project" }], sessions: [{ title: "Describe project-memory" }] }] },
    presentation: { settingsRow: "knowledge.banks" },
    activate: () => {
      let opened = false, minted = false;
      const advance = () => {
        const settings = document.querySelector<HTMLButtonElement>('[aria-label="Settings"]');
        if (!opened && settings) { opened = true; settings.click(); }
        const describe = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-bank-card] button")).find(button => button.textContent === "Describe this bank");
        if (!minted && describe && !describe.disabled) { minted = true; describe.click(); }
      };
      const observer = new MutationObserver(advance);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      advance();
      return () => observer.disconnect();
    },
    readySelector: '[data-authoring-dialog] [aria-label="Send answers"]',
    geometry: authoringGeometry,
  };
}

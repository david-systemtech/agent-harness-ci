import { adminCall, clientLocalImportValues, uuidv7, type AdminOutcome } from "@agent-harness/client-runtime";
import { TEXT_SIZE_LEAST, TEXT_SIZE_MOST } from "../presentation.js";
import { useClock, usePresentation, useRuntime } from "../window-context.js";

/**
 * Brings the earlier work over for real (`stateImport.run`, ADR 0036) from
 * the Carry over card's own buttons, Bring them over and Continue bringing it
 * over (setup-copy.md §5.3), and applies the window preferences the import
 * hands this app, as the earlier-work section's Import does.
 */
export const useBringOverEarlierWork = (environmentId: string): (() => Promise<AdminOutcome<"stateImport.run">>) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [, setMode] = usePresentation("lightOrDark");
  const [, setFontSize] = usePresentation("textSize");
  const [, setWidth] = usePresentation("readingWidth");
  const [, setThinking] = usePresentation("reasoningShown");
  const [, setSettingsRow] = usePresentation("settingsRow");
  return async () => {
    const answer = await adminCall(() => runtime.requests.call(environmentId, "stateImport.run", { commandId: uuidv7(clock.now()), dryRun: false }));
    const values = answer.ok ? clientLocalImportValues(runtime, environmentId, false, answer.result) : null;
    if (values !== null) {
      if (values.mode !== undefined) setMode(values.mode);
      if (values.fontSize !== undefined) setFontSize(Math.min(TEXT_SIZE_MOST, Math.max(TEXT_SIZE_LEAST, values.fontSize)));
      if (values.conversationWidth !== undefined) setWidth(values.conversationWidth);
      if (values.showThinking !== undefined) setThinking(values.showThinking);
      if (values.settingsRow !== undefined) setSettingsRow(values.settingsRow);
    }
    return answer;
  };
};

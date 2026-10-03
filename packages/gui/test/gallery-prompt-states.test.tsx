import type { PromptKind } from "@agent-harness/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { PromptScene } from "../gallery/prompt-scene.js";

it.each<PromptKind>(["permission", "question", "plan", "denylist"])("captures %s while sending, after a refusal and once settled", async (kind) => {
  for (const state of ["busy", "error", "settled"] as const) {
    const view = render(<PromptScene kind={kind} state={state} ladder="dark" />);
    try {
      await waitFor(() => expect(view.container.querySelector(`[data-prompt-state="${state}"]`)).not.toBeNull());
      if (state === "error") expect(screen.getByRole("region", { name: "Parked prompt" }).textContent).toContain("Not answered: The prompt was already answered.");
      else expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull();
      if (state === "settled") expect(screen.getByRole("article", { name: kind === "plan" ? "Plan" : kind === "question" ? "Question" : "Permission" })).toBeTruthy();
    } finally { view.unmount(); }
  }
});

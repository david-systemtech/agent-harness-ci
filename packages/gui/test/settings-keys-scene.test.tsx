import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import SettingsKeysScene from "../gallery/scenes/settings-keys.js";

describe("the settings keys scene", () => {
  it("names each form in words and allows edits through the labelled controls", async () => {
    const user = userEvent.setup();
    render(<SettingsKeysScene />);
    const idle = screen.getByRole("textbox", { name: "Settle idle sessions" });
    await user.clear(idle);
    await user.type(idle, "2 weeks");
    await user.click(within(screen.getByRole("group", { name: "Settle idle sessions" })).getByRole("button", { name: "Save" }));
    expect((screen.getByRole("textbox", { name: "Settle idle sessions" }) as HTMLInputElement).value).toBe("2 weeks");
    const merge = screen.getByRole("switch", { name: "Settle sessions after merge" });
    await user.click(merge);
    expect(merge.getAttribute("aria-checked")).toBe("true");
    const ceiling = screen.getByRole("combobox", { name: "How much agents may do without asking" });
    await user.selectOptions(ceiling, within(ceiling).getByRole("option", { name: "plan" }));
    expect(within(ceiling).getByRole("option", { selected: true }).textContent).toBe("plan");
    expect(screen.getByText("sessions.autoSettleAfterIdle").classList.contains("text-ink-faint")).toBe(true);
  });
});

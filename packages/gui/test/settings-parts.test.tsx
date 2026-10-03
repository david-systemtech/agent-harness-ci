import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { ChoiceList, SettingsGroup } from "../src/settings/part.js";

it("names choices and their descriptions, changes the selected value, and explains a disabled choice", async () => {
  const user = userEvent.setup();
  function Form() {
    const [value, setValue] = useState("narrow");
    return <SettingsGroup title="Reading width"><ChoiceList label="Reading width" value={value} onValueChange={setValue} choices={[
      { value: "narrow", label: "Narrow", note: "Keep lines short." },
      { value: "wide", label: "Wide", note: "Use more of the pane." },
      { value: "full", label: "Full", note: "Fill the pane.", disabledReason: "Unavailable for this view." },
    ]} /></SettingsGroup>;
  }
  render(<Form />);
  const choices = within(screen.getByRole("radiogroup", { name: "Reading width" }));
  expect(choices.getByRole("radio", { name: "Narrow" }).getAttribute("aria-checked")).toBe("true");
  await user.click(choices.getByRole("radio", { name: "Wide" }));
  expect(choices.getByRole("radio", { name: "Wide" }).getAttribute("aria-checked")).toBe("true");
  const full = choices.getByRole("radio", { name: "Full" });
  expect(full.hasAttribute("disabled")).toBe(true);
  expect(document.getElementById(full.getAttribute("aria-describedby") ?? "")?.textContent).toContain("Unavailable for this view.");
});

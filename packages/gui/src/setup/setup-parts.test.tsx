import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../ui/index.js";
import { detailsText, TechnicalDetails, type DetailsReport } from "./details.js";
import { HealthDot } from "./health-dot.js";
import { MoreOptions } from "./more-options.js";
import { SetupNotice } from "./notice.js";
import { StateBadge } from "./state-badge.js";
import { StepIntro } from "./step-intro.js";

const report: DetailsReport = {
  app: { version: "0.9.2", platform: "Linux x64" },
  computer: { name: "desk", version: "0.9.1" },
  step: { label: "Forges", id: "forges", state: "needs-attention" },
  checkedAt: "2026-10-08T06:24:00.000Z",
  line: "GitHub does not accept the saved token.",
  failing: ["forges.reach", "forges.token"],
  details: ["github.com answered HTTP 401", "token-for-tests was refused"],
};
const copied: string[] = [];
const copy = async (text: string) => { copied.push(text); };

describe("Copy details (setup-copy.md §3)", () => {
  it("says the app, the computer, the step and its state, when it was checked, the line, the failing checks and the details, one per line", () => {
    expect(detailsText(report)).toEqual([
      "agent-harness 0.9.2 on Linux x64",
      "Computer: desk (agent-harness 0.9.1)",
      "Step: Forges (forges): Needs a fix",
      "Checked: 2026-10-08T06:24:00.000Z",
      "What we saw: GitHub does not accept the saved token.",
      "Checks: forges.reach, forges.token",
      "Details:",
      "github.com answered HTTP 401",
      "token-for-tests was refused",
    ]);
  });

  it("leaves out what is not known: no step, no check time, no failing checks and no details", () => {
    expect(detailsText({ app: { version: "0.9.2", platform: "macOS arm64" }, computer: { name: "this computer" }, line: "The background service did not start." })).toEqual([
      "agent-harness 0.9.2 on macOS arm64",
      "Computer: this computer",
      "What we saw: The background service did not start.",
    ]);
  });
});

describe("TechnicalDetails", () => {
  it("is a Details fold opened and shut from the keyboard, holding the lines in mono and Copy details", async () => {
    const user = userEvent.setup();
    render(<TechnicalDetails report={report} copy={copy} />);
    const fold = screen.getByRole("button", { name: "Details" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Copy details" })).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(fold);
    await user.keyboard("{Enter}");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    const lines = screen.getByText("Checks: forges.reach, forges.token", { exact: false }).closest("pre");
    expect(lines?.className).toContain("font-mono");
    expect(lines?.textContent).toBe(detailsText(report).join("\n"));
    await user.keyboard(" ");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Checks: forges.reach, forges.token", { exact: false })).toBeNull();
  });

  it("copies the text of §3 and says Copied. for 1.5 seconds", async () => {
    vi.useFakeTimers();
    try {
      copied.length = 0;
      render(<TechnicalDetails report={report} copy={copy} defaultOpen />);
      await act(async () => { screen.getByRole("button", { name: "Copy details" }).click(); });
      expect(copied).toEqual([detailsText(report).join("\n")]);
      expect(screen.getByRole("status").textContent).toBe("Copied.");
      act(() => vi.advanceTimersByTime(1499));
      expect(screen.getByRole("status").textContent).toBe("Copied.");
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("status").textContent).toBe("");
    } finally { vi.useRealTimers(); }
  });

  it("says a refused copy in visible words and leaves the text to select", async () => {
    const user = userEvent.setup();
    render(<TechnicalDetails report={report} copy={() => Promise.reject(new Error("denied"))} defaultOpen />);
    await user.click(screen.getByRole("button", { name: "Copy details" }));
    expect(await screen.findByText("Could not copy. Select the text instead.")).toBeDefined();
    expect(screen.getByText("What we saw: GitHub does not accept the saved token.", { exact: false })).toBeDefined();
  });
});

describe("SetupNotice", () => {
  it("is an alert with a hidden Error: prefix in the error tone, its buttons and its Details", () => {
    render(<SetupNotice tone="error" title="GitHub needs a new token" description="Make a new token on GitHub and paste it here." actions={<Button>Add token</Button>} details={{ report, copy }} />);
    const alert = screen.getByRole("alert");
    const title = within(alert).getByRole("heading", { name: "Error: GitHub needs a new token" });
    expect(title.querySelector(".sr-only")?.textContent).toBe("Error:");
    expect(within(alert).getByText("Make a new token on GitHub and paste it here.")).toBeDefined();
    expect(within(alert).getByRole("button", { name: "Add token" })).toBeDefined();
    expect(within(alert).getByRole("button", { name: "Details" })).toBeDefined();
    expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is an alert without the prefix in the warning tone, and a status in the info tone", () => {
    render(<><SetupNotice tone="warning" title="Chrome is not connected" /><SetupNotice tone="info" title="Checked just now" description="Nothing changed." /></>);
    expect(within(screen.getByRole("alert")).getByRole("heading", { name: "Chrome is not connected" })).toBeDefined();
    const status = screen.getByRole("status");
    expect(within(status).getByRole("heading", { name: "Checked just now" })).toBeDefined();
    expect(within(status).getByText("Nothing changed.")).toBeDefined();
    expect(screen.queryByText("Error:", { exact: false })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });
});

describe("StepIntro", () => {
  it("says the step's place, heads the card with its title, says why, and folds What is this? from the keyboard", async () => {
    const user = userEvent.setup();
    render(<StepIntro step="forges" title="Where do you keep your code?" why="Agents use it to read and push your projects." what="A forge is a website that keeps your code, like GitHub, Forgejo or Gitea." />);
    const place = screen.getByText("Step 4 of 11");
    expect(place.className).toContain("text-ink-muted");
    expect(screen.getByRole("heading", { level: 2, name: "Where do you keep your code?" })).toBeDefined();
    expect(screen.getByText("Agents use it to read and push your projects.")).toBeDefined();
    const fold = screen.getByRole("button", { name: "What is this?" });
    await user.tab();
    expect(document.activeElement).toBe(fold);
    await user.keyboard("{Enter}");
    expect(screen.getByText("A forge is a website that keeps your code, like GitHub, Forgejo or Gitea.")).toBeDefined();
    await user.keyboard(" ");
    expect(screen.queryByText("A forge is a website that keeps your code, like GitHub, Forgejo or Gitea.")).toBeNull();
  });
});

describe("StateBadge and HealthDot", () => {
  it.each([
    ["done", "Done"], ["needs-attention", "Needs a fix"], ["skipped", "Not set up"], ["pending", "Checking"], ["unchecked", "Not checked yet"], ["unavailable", "Not available"],
  ] as const)("draws %s as the word %s beside its dot and icon", (state, word) => {
    const { container } = render(<StateBadge state={state} />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.textContent).toBe(word);
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(badge.querySelector("[data-health-dot]")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each([
    ["done", "Permissions: Done"], ["needs-attention", "Permissions: Needs a fix"], ["skipped", "Permissions: Not set up"], ["pending", "Permissions: Checking"], ["unchecked", "Permissions: Not checked yet"], ["unavailable", "Permissions: Not available"],
  ] as const)("names a %s dot %s", (state, name) => {
    render(<HealthDot state={state} of="Permissions" />);
    expect(screen.getByRole("img", { name })).toBeDefined();
  });
});

describe("MoreOptions", () => {
  it("is one fold, More options unless named otherwise, operated from the keyboard", async () => {
    const user = userEvent.setup();
    render(<><MoreOptions step="skills"><p>Update collections every day</p></MoreOptions><MoreOptions step="permissions" label="More safety settings"><p>Paths agents must ask about</p></MoreOptions></>);
    const fold = screen.getByRole("button", { name: "More options" });
    expect(screen.getByRole("button", { name: "More safety settings" })).toBeDefined();
    await user.tab();
    expect(document.activeElement).toBe(fold);
    await user.keyboard("{Enter}");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Update collections every day")).toBeDefined();
    await user.keyboard(" ");
    expect(screen.queryByText("Update collections every day")).toBeNull();
  });

  it("keeps each step's open state while the window lives, after its card unmounts", async () => {
    const user = userEvent.setup();
    const first = render(<MoreOptions step="browser"><p>Chrome profile</p></MoreOptions>);
    await user.click(screen.getByRole("button", { name: "More options" }));
    first.unmount();
    render(<><MoreOptions step="browser"><p>Chrome profile</p></MoreOptions><MoreOptions step="appearance"><p>Text size</p></MoreOptions></>);
    expect(screen.getByText("Chrome profile")).toBeDefined();
    expect(screen.queryByText("Text size")).toBeNull();
  });

  it("is never nested: a More options inside another draws its contents in place, with no second fold", async () => {
    const user = userEvent.setup();
    render(<MoreOptions step="instructions"><MoreOptions step="instructions" label="Even more"><p>Notes order</p></MoreOptions></MoreOptions>);
    await user.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByText("Notes order")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Even more" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

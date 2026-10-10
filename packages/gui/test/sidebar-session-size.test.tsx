// @vitest-environment jsdom-on-node
import { act, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import { expect, it, onTestFinished } from "vitest";
import { renderApp } from "./harness.js";

const stylesheet = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const theme = /@theme \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";

it.each([14, 15, 16, 17, 18, 19, 20])("keeps session metadata at its natural height and keyboard selection at text size %i", async (textSize) => {
  const app = await renderApp({ environments: [{
    name: "desk", reach: "local", hello: { environmentIcon: "desktop" },
    accounts: [{ id: "account-for-tests", label: "Work" }],
    sessions: [{ title: "First task", accountId: "account-for-tests", tags: ["ui"] }, { title: "Next task" }],
  }] }, { presentation: { textSize } });
  const sidebar = screen.getByRole("navigation", { name: "Sessions" });
  const row = await within(sidebar).findByRole("button", { name: /desk First task/ });
  await within(row).findByText("Work");
  const style = document.createElement("style");
  const candidates = [...sidebar.querySelectorAll("[class]")].flatMap(element => [...element.classList]);
  style.textContent = (await compile(`@theme { --spacing: 0.25rem; }\n${theme}\n@tailwind utilities;`)).build(candidates);
  document.head.append(style);
  onTestFinished(() => style.remove());

  // A shrinking flex item with overflow hidden cuts off the account and tags vertically.
  // jsdom resolves the real utilities; hosted gallery geometry checks their rendered bounds.
  const details = row.querySelector("[data-sidebar-details]")!;
  expect(getComputedStyle(details).flexShrink).toBe("0");
  expect(getComputedStyle(row.firstElementChild!.lastElementChild!).lineHeight).toBe("18px");
  expect(within(details as HTMLElement).getByRole("img", { name: "desk" })).toBeDefined();
  expect(within(details as HTMLElement).getByText("#ui")).toBeDefined();
  expect(getComputedStyle(row.closest("li")!).height).toBe("54px");
  expect(getComputedStyle(row.closest("li")!).paddingBlock).toBe("2px");

  act(() => row.focus());
  await app.user.keyboard("{Enter}");
  expect(app.shown()?.sessionId).toBe(app.environment("desk").sessionId());
  expect(row.getAttribute("aria-current")).toBe("true");
  expect(getComputedStyle(sidebar.querySelector("[data-sidebar-scroll]")!).overflowY).toBe("auto");
});

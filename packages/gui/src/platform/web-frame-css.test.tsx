// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { WebViewport } from "./web-frame.js";

it("keeps the safe-area frame and its complete grant disclosure in their own rows", () => {
  const app = render(<WebViewport narrow><header>Actions</header><div data-limited-access>Limited access · Details</div><main>Conversation</main></WebViewport>);
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(new URL("./web-frame.css", import.meta.url), "utf8");
  document.head.append(stylesheet);
  try {
    const frame = app.container.querySelector<HTMLElement>("[data-web-client]")!;
    const grant = frame.querySelector<HTMLElement>("[data-limited-access]")!;
    // eslint-disable-next-line agent-harness/no-unmapped-colour-class -- CSS box-sizing uses this keyword.
    expect(getComputedStyle(frame).boxSizing).toBe("border-box");
    expect(getComputedStyle(frame).overflow).toBe("hidden");
    expect(getComputedStyle(grant).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(grant).whiteSpace).toBe("normal");
    expect(getComputedStyle(grant).margin).toBe("0px");
    expect(getComputedStyle(grant).flexShrink).toBe("0");
  } finally { stylesheet.remove(); }
});

// @vitest-environment jsdom-on-node
import { render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import type { ReactElement } from "react";
import { describe, expect, it, onTestFinished } from "vitest";
import { Checkbox } from "./checkbox.js";
import { RadioGroup, RadioGroupItem } from "./radio-group.js";
import { Switch } from "./switch.js";
import { Tooltip } from "./tooltip.js";

/**
 * A tooltip's trigger stamps its own `data-state` (closed, delayed-open) onto the control it wraps,
 * so a control's checked look must come from what only the control writes (#1697).
 */
const stylesheet = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const theme = /@theme inline \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";
const variants = stylesheet.match(/^@custom-variant .*$/gm)?.join("\n") ?? "";

/** Renders the controls with the utilities their classes compile to, so jsdom resolves the cascade. */
const renderStyled = async (controls: ReactElement) => {
  const { container } = render(controls);
  const classes = [...container.querySelectorAll("[class]")].flatMap((element) => [...element.classList]);
  const style = document.createElement("style");
  style.textContent = (await compile(`${variants}\n${theme}\n@tailwind utilities;`)).build(classes);
  document.head.append(style);
  onTestFinished(() => style.remove());
};

const background = (label: string) => getComputedStyle(screen.getByLabelText(label)).backgroundColor;

describe("a checked control inside a tooltip", () => {
  it("keeps the switch's beam track, as the same switch has without one", async () => {
    await renderStyled(<>
      <Switch aria-label="Bare" checked />
      <Tooltip content="Updates install themselves"><Switch aria-label="Hinted" checked /></Tooltip>
      <Tooltip content="Updates install themselves"><Switch aria-label="Hinted off" checked={false} /></Tooltip>
    </>);
    expect(screen.getByLabelText("Hinted").getAttribute("data-state")).toBe("closed");
    expect(background("Bare")).toBe("var(--beam)");
    expect(background("Hinted")).toBe("var(--beam)");
    expect(background("Hinted off")).toBe("var(--hairline-strong)");
    const thumb = (label: string) => getComputedStyle(screen.getByLabelText(label).firstElementChild!).backgroundColor;
    expect(thumb("Hinted")).toBe("var(--beam-ink)");
    expect(thumb("Hinted off")).toBe("var(--abyss)");
  });

  it("keeps the checkbox's beam fill when checked or mixed, and only the mixed mark for mixed", async () => {
    await renderStyled(<>
      <Tooltip content="Also delete its history"><Checkbox aria-label="Checked" checked /></Tooltip>
      <Tooltip content="Some are selected"><Checkbox aria-label="Mixed" checked="indeterminate" /></Tooltip>
      <Tooltip content="Also delete its history"><Checkbox aria-label="Unchecked" checked={false} /></Tooltip>
    </>);
    expect(background("Checked")).toBe("var(--beam)");
    expect(background("Mixed")).toBe("var(--beam)");
    expect(background("Unchecked")).not.toBe("var(--beam)");
    const marks = (label: string) => [...screen.getByLabelText(label).querySelectorAll("svg")].map((mark) => getComputedStyle(mark).display);
    expect(marks("Checked")).toEqual(["inline", "none"]);
    expect(marks("Mixed")).toEqual(["none", "block"]);
  });

  it("keeps the chosen radio's beam fill", async () => {
    await renderStyled(<RadioGroup aria-label="Scope" value="all">
      <Tooltip content="Every workspace"><RadioGroupItem aria-label="All" value="all" /></Tooltip>
      <Tooltip content="This workspace only"><RadioGroupItem aria-label="One" value="one" /></Tooltip>
    </RadioGroup>);
    expect(background("All")).toBe("var(--beam)");
    expect(background("One")).not.toBe("var(--beam)");
  });

  it("is styled from aria-checked everywhere, never from a data-state a tooltip can overwrite", () => {
    const source = new URL("..", import.meta.url);
    const offenders = readdirSync(source, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.tsx"))
      .filter((file) => /data-\[state=(checked|unchecked|indeterminate)\]|data-(checked|unchecked):/.test(readFileSync(new URL(file, source), "utf8")));
    expect(offenders).toEqual([]);
  });
});

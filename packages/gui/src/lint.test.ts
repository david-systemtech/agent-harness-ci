// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { WHOLE_PACKAGE_LINT_MS } from "../../../eslint-rules/package-lint.js";

/**
 * The repository's own lint configuration, run on this package from its
 * first commit: ADR 0003's organisation-state rule, ADR 0023's literal-colour
 * rule over its scripts, its stylesheet and its document, and the import rule
 * that keeps its bundle to what a browser tab runs.
 */
const root = join(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });
const ORGANISATION = "agent-harness/no-client-organisation-state";
const COLOUR = "agent-harness/no-literal-colour";

const ruleIds = async (file: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

/** A literal colour and a class of Tailwind's palette, each written from its parts so this file holds neither. */
const hex = ["#", "fff"].join("");
const paletteClass = ["bg", "red", "500"].join("-");

describe("the GUI under the repository's lint", () => {
  it("passes every rule on every source, test, harness, stylesheet, SVG asset and document file", async () => {
    const results = await eslint.lintFiles(["packages/gui/src/**/*.{ts,tsx,css,svg}", "packages/gui/test/**/*.{ts,tsx}", "packages/gui/*.{ts,html}"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.some((r) => r.filePath.endsWith("styles.css"))).toBe(true);
    expect(results.some((r) => r.filePath.endsWith("index.html"))).toBe(true);
    expect(results.length).toBeGreaterThan(20);
  }, WHOLE_PACKAGE_LINT_MS);

  it("refuses a store named after session state in a component, and one the presentation module does not list", async () => {
    expect(await ruleIds("packages/gui/src/frame/sidebar-region.tsx", "export const SidebarRegion = () => { const [groups, setGroups] = useState([]); return null; };\n")).toContain(ORGANISATION);
    const file = "packages/gui/src/presentation.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(await ruleIds(file, source)).not.toContain(ORGANISATION);
    expect(await ruleIds(file, `${source}\nexport const pinnedSessions = writable([]);\n`)).toContain(ORGANISATION);
  });

  it("allows the terminal pane's fallback theme its literal colours, and refuses the same theme in any other module", async () => {
    const file = "packages/gui/src/terminal/xterm-fallback-theme.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(source).toContain(hex.replace("fff", ""));
    expect(await ruleIds(file, source)).not.toContain(COLOUR);
    expect(await ruleIds("packages/gui/src/terminal/terminal-theme.ts", source)).toContain(COLOUR);
  });

  it("refuses a literal colour in a primitive, in the stylesheet and in the document", async () => {
    const button = "packages/gui/src/ui/button.tsx";
    expect(await ruleIds(button, readFileSync(join(root, button), "utf8"))).not.toContain(COLOUR);
    expect(await ruleIds(button, `export const edge = "1px solid ${hex}";\n`)).toContain(COLOUR);
    expect(await ruleIds(button, `export const tone = "${paletteClass}";\n`)).toContain(COLOUR);
    expect(await ruleIds("packages/gui/src/styles.css", `.edge { border: 1px solid ${hex}; }\n`)).toContain(COLOUR);
    const page = "packages/gui/index.html";
    const markup = readFileSync(join(root, page), "utf8");
    expect(await ruleIds(page, markup)).not.toContain(COLOUR);
    expect(await ruleIds(page, markup.replace("<head>", `<head><meta name="theme-color" content="${hex}" />`))).toContain(COLOUR);
  });
});


/** JSX controls must use the window's variants after the surface migration. */
it("has no remaining Button tone aliases", () => {
  const problems: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!file.endsWith(".tsx")) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /Button$/.test(node.tagName.getText(source))) {
          for (const attribute of node.attributes.properties) {
            if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "tone") problems.push(`${file}:${source.getLineAndCharacterOfPosition(attribute.getStart()).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(join(root, "packages/gui/src"));
  expect(problems).toEqual([]);
});

const GLYPHS = new Set(["✕", "×", "»", "›", "▸", "▾", "←", "→", "↻", "+", "★", "⑂", "⚠"]);

/** Read literal JSX content, including wrappers and conditional branches; icons count as content. */
function glyphControls(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const contents = (node: ts.Node): string[] => {
    if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text.trim()];
    if (ts.isJsxExpression(node)) return node.expression === undefined ? [""] : contents(node.expression);
    if (ts.isParenthesizedExpression(node)) return contents(node.expression);
    if (ts.isConditionalExpression(node)) return [...contents(node.whenTrue), ...contents(node.whenFalse)];
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      return node.children.reduce<string[]>((texts, child) => texts.flatMap((text) => contents(child).map((next) => text + next)), [""]);
    }
    return ["[nonliteral content]"];
  };
  const problems: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const name = node.openingElement.tagName.getText(source);
      const role = node.openingElement.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "role");
      const control = /^(button|a)$|Button$|MenuItem$|MenuEntry$|Trigger$/.test(name) || /"(button|link|menuitem|tab)"/.test(role?.getText(source) ?? "");
      if (control && contents(node).some((text) => GLYPHS.has(text.trim()))) problems.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

it.each([...GLYPHS])("refuses %s as a control's whole content, even through wrappers or expressions", (glyph) => {
  for (const code of [`<button>${glyph}</button>`, `<IconButton label="Action"><span>{"${glyph}"}</span></IconButton>`, `<div role="button">{open ? "${glyph}" : "Open"}</div>`]) {
    expect(glyphControls("fixture.tsx", code)).toEqual(["fixture.tsx:1"]);
  }
  expect(glyphControls("fixture.tsx", `<button><Plus /> Add</button><span>${glyph}</span><button>{"${glyph}  Add"}</button>`)).toEqual([]);
});

it("leaves no text glyph standing for a control icon in the renderer", () => {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return walk(file);
    return file.endsWith(".tsx") && !file.endsWith(".test.tsx") ? glyphControls(file, readFileSync(file, "utf8")) : [];
  });
  expect(walk(join(root, "packages/gui/src"))).toEqual([]);
});

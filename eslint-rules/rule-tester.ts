import css from "@eslint/css";
import html from "@html-eslint/eslint-plugin";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { RuleTester as EslintRuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

// Both rule testers drive whichever test framework hands them these hooks.
RuleTester.afterAll = afterAll;
for (const tester of [RuleTester, EslintRuleTester]) {
  tester.describe = describe;
  tester.it = it;
  tester.itOnly = it.only;
}

export const ruleTester = new RuleTester();

/** ESLint's own rule tester on its CSS language, for a rule that also reads stylesheets; tolerant, as the configuration parses them. */
export const stylesheetTester = new EslintRuleTester({ plugins: { css }, language: "css/css", languageOptions: { tolerant: true } });

/** ESLint's own rule tester on html-eslint's HTML language, for a rule that also reads SVG assets and HTML documents. */
export const markupTester = new EslintRuleTester({ plugins: { html }, language: "html/html" });

export const clientRuntime = (module: string) => `/repo/packages/client-runtime/src/${module}`;
export const tui = (module: string) => `/repo/packages/tui/src/${module}`;
export const gui = (module: string) => `/repo/packages/gui/src/${module}`;

import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

// RuleTester drives whichever test framework hands it these hooks.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

export const ruleTester = new RuleTester();

export const clientRuntime = (module: string) => `/repo/packages/client-runtime/src/${module}`;
export const tui = (module: string) => `/repo/packages/tui/src/${module}`;

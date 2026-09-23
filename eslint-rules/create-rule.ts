import { ESLintUtils } from "@typescript-eslint/utils";

export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://git.systemtech.dev:5526/david/agent-harness/src/branch/main/eslint-rules/${name}.ts`,
);

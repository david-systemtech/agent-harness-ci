import { rule } from "./no-relative-import-into.js";
import { ruleTester } from "./rule-tester.js";

const because = "The environment depends on contracts, never on a client or the CLI.";
const options = [{ root: "/repo", packages: ["tui", "cli"], because }] as const;
const file = "/repo/packages/environment/src/terminals/x.ts";
const valid = (code: string) => ({ filename: file, code, options });
/** `code` refused for its one specifier, which resolves into packages/`name`. */
const invalid = (code: string, name: string) => ({
  filename: file,
  code,
  options,
  errors: [{ messageId: "into" as const, data: { source: /"([^"]+)"/.exec(code)?.[1], name, because } }],
});

ruleTester.run("no-relative-import-into", rule, {
  valid: [
    valid(`import { x } from "./y.js";`),
    valid(`import { x } from "../../test/helper.js";`),
    // A folder of the environment's own named like a refused package is not that package.
    valid(`import { x } from "../cli/x.js";`),
    valid(`import { x } from "./tui/x.js";`),
    // Into a package not named, however it climbs.
    valid(`import { x } from "../../../contracts/src/x.js";`),
    valid(`import { x } from "../../../tui/../contracts/src/x.js";`),
    // Not relative: the configuration's name patterns decide these.
    valid(`import { x } from "@agent-harness/tui";`),
    valid(`const m = import(name);`),
  ],
  invalid: [
    invalid(`import { x } from "../../../tui/src/x.js";`, "tui"),
    invalid(`import { x } from "./../../../tui/src/x.js";`, "tui"),
    invalid(`import { x } from "..//..//../cli/src/main.js";`, "cli"),
    invalid(`import { x } from "../../../../packages/cli/src/main.js";`, "cli"),
    // An interior `.` or `..` after the climb, which a pattern over the specifier as written misses.
    invalid(`import { x } from "../../../contracts/../cli/src/main.js";`, "cli"),
    invalid(`import { x } from "../../../../packages/contracts/../cli/src/main.js";`, "cli"),
    invalid(`import { x } from "../../.././tui/src/x.js";`, "tui"),
    // Out of the repository and in again by its folder's name.
    invalid(`import { x } from "../../../../../repo/packages/tui/src/x.js";`, "tui"),
    // The package itself.
    invalid(`import x from "../../../tui";`, "tui"),
    invalid(`export { x } from "../../../tui/src/x.js";`, "tui"),
    invalid(`export * from "../../../cli/src/main.js";`, "cli"),
    invalid(`const m = import("../../../cli/src/main.js");`, "cli"),
  ],
});

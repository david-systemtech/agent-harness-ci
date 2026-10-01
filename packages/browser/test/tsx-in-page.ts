import * as driverInPage from "../src/driver/in-page.js";
import * as readerInPage from "../src/reader-in-page.js";
import * as snapshotInPage from "../src/snapshot/in-page.js";

/**
 * Prints the in-page functions' source texts as tsx makes them (#966), for a
 * test that loads the package as a development run does:
 * `node --conditions=@agent-harness/source --import tsx test/tsx-in-page.ts`.
 * tsx's transform keeps each function's name with a helper of its own,
 * `__name`, declared in the module, which no page has.
 */

/** What the script prints: each exported function's source text, and each composed declaration's, by name. */
export interface TsxInPage {
  readonly functions: Readonly<Record<string, string>>;
  readonly declarations: Readonly<Record<string, string>>;
}

const functions: Record<string, string> = {};
const declarations: Record<string, string> = {};
for (const [name, value] of Object.entries({ ...driverInPage, ...readerInPage, ...snapshotInPage })) {
  if (typeof value === "function") functions[name] = value.toString();
  else if ("declaration" in value) declarations[name] = value.declaration;
}
process.stdout.write(JSON.stringify({ functions, declarations } satisfies TsxInPage));

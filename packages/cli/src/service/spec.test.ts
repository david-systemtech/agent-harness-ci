import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test/service-helpers.js";
import { resolveProgram, serveArguments, SERVICE_LABEL } from "./spec.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

describe("the program a service runs", () => {
  it("is node and the real path of the CLI's entry, so a symlinked bin still names the installed files", () => {
    const dir = makeTempDir();
    cleanups.push(dir.remove);
    mkdirSync(join(dir.path, "0.1.0", "dist"), { recursive: true });
    const entry = join(dir.path, "0.1.0", "dist", "main.js");
    writeFileSync(entry, "");
    const link = join(dir.path, "agent-harness");
    symlinkSync(entry, link);

    expect(resolveProgram({ execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", link, "service", "install"] })).toEqual([
      "/usr/bin/node",
      entry,
    ]);
  });

  it("keeps node's own flags, so a CLI run from source installs a service that runs from source", () => {
    const dir = makeTempDir();
    cleanups.push(dir.remove);
    const entry = join(dir.path, "main.ts");
    writeFileSync(entry, "");
    const execArgv = ["--conditions=@agent-harness/source", "--import", "/repo/node_modules/tsx/dist/loader.mjs"];
    expect(resolveProgram({ execPath: "/usr/bin/node", execArgv, argv: ["/usr/bin/node", entry] })).toEqual([
      "/usr/bin/node",
      ...execArgv,
      entry,
    ]);
  });

  it("is the executable alone when the artefact is a single executable", () => {
    expect(resolveProgram({ execPath: "/opt/agent-harness/agent-harness", execArgv: [], argv: ["/opt/agent-harness/agent-harness", "/opt/agent-harness/agent-harness"] })).toEqual([
      "/opt/agent-harness/agent-harness",
    ]);
    expect(resolveProgram({ execPath: "/opt/agent-harness/agent-harness", execArgv: [], argv: ["/opt/agent-harness/agent-harness"] })).toEqual([
      "/opt/agent-harness/agent-harness",
    ]);
  });
});

describe("the serve command line", () => {
  it("is the program, then serve with the data directory and the port", () => {
    expect(serveArguments({ label: SERVICE_LABEL, program: ["/n", "/m.js"], dataDir: "/d", port: 7433 })).toEqual([
      "/n",
      "/m.js",
      "serve",
      "--data-dir",
      "/d",
      "--port",
      "7433",
    ]);
  });
});

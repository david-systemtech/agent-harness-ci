import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { exportWindowsPtyBuild } from "./release/windows-pty.js";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Export the Windows node-pty build on a Windows x64 runner.");
const destination = process.argv[2];
if (!destination) throw new Error("Pass the destination for the compiled Windows node-pty payload.");
const environment = createRequire(new URL("../../environment/package.json", import.meta.url));
exportWindowsPtyBuild(dirname(environment.resolve("node-pty/package.json")), resolve(destination));

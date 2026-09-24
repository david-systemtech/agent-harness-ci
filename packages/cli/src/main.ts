#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2));
// A launcher's IPC channel would keep the process alive after the environment has closed.
if (process.connected) process.disconnect();

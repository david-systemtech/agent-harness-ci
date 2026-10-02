import { appendFileSync } from "node:fs";
import { releaseRunOf } from "./release/run.js";

/** GitHub Actions outputs for the run, checked before any build or publish job starts. */
const output = process.env["GITHUB_OUTPUT"];
if (!output) throw new Error("GITHUB_OUTPUT is needed to prepare a release run.");
const run = releaseRunOf(process.env);
appendFileSync(output, Object.entries(run).map(([key, value]) => `${key}=${value}\n`).join(""));

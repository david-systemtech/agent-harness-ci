import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { RELEASE_SOURCE } from "../../environment/src/updates/channel.js";
import { publishedTagsOf, releaseRunOf } from "./release/run.js";

/** GitHub Actions outputs for the run, checked before any build or publish job starts. */
const output = process.env["GITHUB_OUTPUT"];
if (!output) throw new Error("GITHUB_OUTPUT is needed to prepare a release run.");
// The releases the build's channel offers, read without credentials from the release source compiled into it (#1880).
const published = () =>
  publishedTagsOf(
    execFileSync("git", ["ls-remote", "--tags", "--refs", `${RELEASE_SOURCE.origin}/${RELEASE_SOURCE.repository}.git`], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }),
  );
const run = releaseRunOf(process.env, published);
appendFileSync(output, Object.entries(run).map(([key, value]) => `${key}=${value}\n`).join(""));

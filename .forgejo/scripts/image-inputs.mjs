// A PR's image decision. Checkout supplies the full head and origin/main history.
import console from "node:console";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

// Docker compiles the CLI and stages the GUI. Follow workspace dependencies
// rather than letting a newly introduced dependency silently miss the check.
const packages = new Map(readdirSync("packages").map(directory => {
  const manifest = JSON.parse(readFileSync(`packages/${directory}/package.json`, "utf8"));
  return [manifest.name, { directory, manifest }];
}));
const inputs = new Set();
function include(name) {
  const { directory, manifest } = packages.get(name);
  if (inputs.has(directory)) return;
  inputs.add(directory);
  for (const [dependency, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies })) {
    if (version.startsWith("workspace:")) include(dependency);
  }
}
include("agent-harness");
include("@agent-harness/gui");

function imageInput(path) {
  // GUI text is scanned by Tailwind, including tests and gallery scenes.
  // PNG captures are binary and cannot contribute CSS candidates.
  if (/(^|\/)(test|tests|gallery|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/.test(path)) {
    return path.startsWith("packages/gui/") && !path.endsWith(".png");
  }
  if (/^packages\/[^/]+\/package\.json$/.test(path)) return true; // pnpm installs every workspace manifest.
  if (/^packages\//.test(path)) return inputs.has(path.split("/")[1]);
  return /^(Dockerfile|\.dockerignore|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig[^/]*\.json)$/.test(path)
    || /^scripts\/(image-[^/]+|stage-web-client\.mjs|compose\.yaml|host-updater\.sh|install\.(sh|ps1))$/.test(path)
    || /^\.forgejo\/scripts\/image[^/]*$/.test(path)
    || /^\.forgejo\/(github-)?workflows\/(image|release|smoke)\.yml$/.test(path)
    || path === "public/.github-workflows/release.yml";
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const force = (event.pull_request.labels ?? []).some(label => label.name === "image");
// --no-renames includes both paths of moves; -z keeps newlines in filenames intact.
const changed = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", "origin/main...HEAD"], { encoding: "utf8" }).split("\0").filter(Boolean);
const build = force || changed.some(imageInput);
console.log(force ? "image label: build forced" : build ? "image input changed: build required" : "no image input changed: build skipped");
appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);

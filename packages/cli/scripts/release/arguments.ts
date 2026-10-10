import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { OtherAsset } from "./assets.js";
import type { BuildOptions } from "./build.js";
import type { ReleaseRepository } from "./publish.js";

/** How the release build is run, for its usage line. */
export const BUILD_USAGE =
  "usage: pnpm --filter agent-harness build-artefacts --tag v<version> --out <folder> --image-reference <reference> --image-digest sha256:<hex> [--windows-pty-build <folder>] [--platform <os>-<arch>]... [--asset <kind>[:<platform>:<format>]=<path>]...";

/** Arguments the build cannot take: the message says which. */
export class ArgumentsError extends Error {
  override readonly name = "ArgumentsError";
}

/**
 * An `--asset` argument, `<kind>=<path>`, or `<kind>:<platform>:<format>=<path>`
 * for an asset built for one platform (a desktop build), its path read from
 * `cwd`.
 */
const otherAssetOf = (argument: string, cwd: string): OtherAsset => {
  const at = argument.indexOf("=");
  const [kind, platform, format, ...more] = argument.slice(0, Math.max(at, 0)).split(":");
  if (!kind || at === argument.length - 1 || more.length > 0 || (platform !== undefined && (!platform || !format))) {
    throw new ArgumentsError(`--asset takes <kind>=<path> or <kind>:<platform>:<format>=<path>, not ${JSON.stringify(argument)}.`);
  }
  const path = resolve(cwd, argument.slice(at + 1));
  return platform && format ? { kind, path, target: { platform, format } } : { kind, path };
};

/**
 * The build's options from its command line `args`, a relative `--out` or
 * `--asset` path read from `cwd` (where pnpm was run, which pnpm passes a
 * script as `INIT_CWD`). An option missing, unknown or malformed is an
 * `ArgumentsError`.
 */
export const buildOptionsOf = (args: readonly string[], cwd: string): BuildOptions => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        tag: { type: "string" },
        out: { type: "string" },
        "windows-pty-build": { type: "string" },
        "image-reference": { type: "string" },
        "image-digest": { type: "string" },
        platform: { type: "string", multiple: true },
        asset: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ArgumentsError(error instanceof Error ? error.message : String(error));
  }
  const { tag, out, "image-reference": reference, "image-digest": digest, platform, asset } = values;
  if (tag === undefined || out === undefined) throw new ArgumentsError("--tag and --out are needed: the release's tag, and the folder its assets are written to.");
  if (reference === undefined || digest === undefined) throw new ArgumentsError("--image-reference and --image-digest are needed: the release manifest names the release's image.");
  return {
    tag,
    out: resolve(cwd, out),
    image: { reference, digest },
    ...(values["windows-pty-build"] !== undefined && { windowsPtyBuild: resolve(cwd, values["windows-pty-build"]) }),
    ...(platform !== undefined && { platforms: platform }),
    ...(asset !== undefined && { assets: asset.map((argument) => otherAssetOf(argument, cwd)) }),
  };
};

/** How the publisher is run, for its usage line. */
export const PUBLISH_USAGE = "usage: pnpm --filter agent-harness publish-release --tag v<version> (--from <folder> | --check), with GITHUB_SERVER_URL, GITHUB_REPOSITORY and RELEASE_TOKEN set";

/** What the publisher's command line asks: publish `folder`, or with none only check that the tag's release is unpublished. */
export interface PublishCommand {
  readonly tag: string;
  readonly folder: string | null;
  readonly forge: ReleaseRepository;
}

/**
 * The publisher's command from its `args` and the job's `env` (the forge's
 * origin and repository as Forgejo Actions names them, and `RELEASE_TOKEN`),
 * a relative `--from` read from `cwd`. An option missing, unknown or clashing
 * is an `ArgumentsError`.
 */
export const publishOptionsOf = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): PublishCommand => {
  let values;
  try {
    ({ values } = parseArgs({ args: [...args], options: { tag: { type: "string" }, from: { type: "string" }, check: { type: "boolean" } }, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new ArgumentsError(error instanceof Error ? error.message : String(error));
  }
  const { tag, from, check } = values;
  if (tag === undefined) throw new ArgumentsError("--tag is needed: the release's tag.");
  if ((from === undefined) === (check !== true)) throw new ArgumentsError("Either --from <folder> or --check is needed: publish the folder the build wrote, or only check that the tag's release is unpublished.");
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, RELEASE_TOKEN: token } = env;
  if (server === undefined || server === "" || repository === undefined || repository === "") throw new ArgumentsError("GITHUB_SERVER_URL and GITHUB_REPOSITORY are needed: the forge and repository the release is published on.");
  if (token === undefined || token === "") throw new ArgumentsError("RELEASE_TOKEN is empty: publishing needs a token that can write the repository's releases.");
  return { tag, folder: from === undefined ? null : resolve(cwd, from), forge: { server, repository, token, ...(server === "https://github.com" && { kind: "github" as const }) } };
};

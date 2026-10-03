/**
 * The container image (`Dockerfile`) and the published compose file
 * (`scripts/compose.yaml`), read as text (#141; permissions spec, "Never
 * root"; launcher-update spec, "Containers: the host-side updater", #349):
 * no image is built or run here. The image runs the environment as a
 * non-root user that owns the volumes' mount points, the compose file runs
 * that user on named volumes with the drain's stop grace and the release's
 * image, the image ships ssh for the skill probe (#874), and neither sets
 * `IS_SANDBOX` or `CLAUDE_CODE_BUBBLEWRAP`. It passes a new environment's
 * name and channel in from compose's own variables, which Add a machine's
 * container snippet sets (#846). What only
 * a real build and run can show is the Container section of
 * `docs/agents/service-install-checklist.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installLines } from "../packages/client-runtime/src/setup/install-lines.js";

const root = join(import.meta.dirname, "..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const compose = readFileSync(join(root, "scripts", "compose.yaml"), "utf8");

/** The Dockerfile's instructions, comments dropped and continuation lines joined. */
const instructions = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "");

/** The instructions of the image's last stage, from its `FROM`: what the container runs. */
const finalStage = (): string[] => {
  const all = instructions(dockerfile);
  const last = all.findLastIndex((line) => /^FROM /i.test(line));
  if (last === -1) throw new Error("The Dockerfile has no FROM line, so it has no stage.");
  return all.slice(last);
};

/** The Dockerfile's header, its comment lines before the first line that is not one, read as one line of prose. */
const dockerfileHeader = (): string => {
  const lines = dockerfile.split("\n");
  return lines
    .slice(0, lines.findIndex((line) => !line.startsWith("#")))
    .map((line) => line.replace(/^#\s*/, ""))
    .join(" ");
};

/** The compose file without its comments. */
const composeLines = (): string[] =>
  compose
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
    .filter((line) => line.trim() !== "");

/** One service's published properties, read without running a container. */
const composeService = (name: string): string[] => {
  const lines = composeLines();
  const first = lines.indexOf(`  ${name}:`);
  if (first === -1) return [];
  const next = lines.findIndex((line, index) => index > first && /^\S|^ {2}\S/.test(line));
  return lines.slice(first + 1, next === -1 ? undefined : next);
};

/** The compose file's header: its comment lines before the first line that is not one. */
const composeHeader = (): string => {
  const lines = compose.split("\n");
  return lines.slice(0, lines.findIndex((line) => !line.startsWith("#"))).join("\n");
};

/**
 * The image the compose file names in the repository: the registry path the
 * release's image takes (its manifest's reference,
 * git.systemtech.dev:5526/david/agent-harness:<version>), tagged with a
 * placeholder no release version is. The release workflow writes the
 * release's reference in its place (#358).
 */
const UNRELEASED_IMAGE = "git.systemtech.dev:5526/david/agent-harness:unreleased";

/** The uid and gid the image gives its user. */
const imageUser = (): { name: string; uid: string; gid: string } => {
  const stage = finalStage().join("\n");
  const user = /useradd [^\n]*--uid (\d+) [^\n]*?(\S+)(?: &&|$)/m.exec(stage);
  const group = /groupadd --gid (\d+) (\S+)/.exec(stage);
  if (!user || !group) throw new Error("The image creates no user with a fixed uid and group with a fixed gid.");
  return { name: user[2] as string, uid: user[1] as string, gid: group[1] as string };
};

describe("the container image", () => {
  it("fetches into a persistent cache before installing offline with the frozen lockfile", () => {
    const build = instructions(dockerfile).find((line) => line.startsWith("RUN --mount=type=cache"));
    expect(build).toBeDefined();
    expect(build).toContain("id=agent-harness-pnpm-linux-amd64,target=/pnpm/store,sharing=shared");
    expect(build).toContain("bash scripts/image-deps.sh && pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store");
    expect(build).toContain("pnpm exec tsc -b packages/cli");
    expect(build).toContain("pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store --prod");
  });

  it("checks the required SDK after the production install before copying the image", () => {
    const build = instructions(dockerfile).find((line) => line.startsWith("RUN --mount=type=cache"));
    expect(build).toMatch(/--prod .*&& node scripts\/image-sdk-cache\.mjs check && rm -rf/);
  });

  it("has a last stage that starts at a FROM", () => {
    expect(finalStage()[0]).toBe("FROM node:24-bookworm-slim");
  });

  it("runs its last stage as the non-root user it creates, with a fixed uid and gid", () => {
    const { name, uid, gid } = imageUser();
    expect(name).toBe("agent-harness");
    expect(uid).toBe("10001");
    expect(gid).toBe("10001");
    const users = finalStage().filter((line) => /^USER /i.test(line));
    expect(users.at(-1)).toBe(`USER ${name}`);
    for (const line of users) expect(line, line).not.toMatch(/^USER (root|0)(:|$)/i);
  });

  it("gives that user the mount points of its two volumes before declaring them, so a named volume starts owned by it", () => {
    const stage = finalStage();
    const chown = stage.findIndex((line) => /chown agent-harness:agent-harness \/data \/work/.test(line));
    const volume = stage.findIndex((line) => line === 'VOLUME ["/data", "/work"]');
    expect(chown).toBeGreaterThanOrEqual(0);
    expect(volume).toBeGreaterThan(chown);
  });

  it("says, in its header, that a v tag's release publishes it by that exact version, for linux/amd64 only", () => {
    const header = dockerfileHeader();
    expect(header).not.toMatch(/no release publishes/i);
    expect(header).toContain(".forgejo/workflows/release.yml");
    expect(header).toContain("git.systemtech.dev:5526/david/agent-harness:<version>");
    expect(header).toContain("linux/amd64");
  });

  it("installs openssh-client in its last stage, so an ssh or scp URL no forge account covers is probed over ssh as written (#874)", () => {
    const installed = finalStage()
      .filter((line) => /^RUN .*\bapt-get install\b/.test(line))
      .flatMap((line) => line.split(/\s+/));
    expect(installed).toContain("openssh-client");
  });

  it("starts the environment with serve on /data, as that user", () => {
    const stage = finalStage();
    expect(stage.at(-2)).toBe('ENTRYPOINT ["agent-harness"]');
    expect(stage.at(-1)).toBe('CMD ["serve", "--data-dir", "/data"]');
    expect(stage.findIndex((line) => line === "USER agent-harness")).toBeLessThan(stage.length - 2);
  });
});

describe("the published compose file", () => {
  it("runs the image's user, by the uid and gid the image gives it", () => {
    const { uid, gid } = imageUser();
    const user = composeService("environment").filter((line) => /^\s+user:/.test(line));
    expect(user).toEqual([`    user: "${uid}:${gid}"`]);
    expect(uid).not.toBe("0");
  });

  it("shares the Linux host's Tailscale interface without a CLI, daemon socket or added privileges (#1265)", () => {
    const lines = composeService("environment");
    expect(lines).toContain("    network_mode: host");
    expect(lines.join("\n")).not.toMatch(/ports:|tailscaled\.sock|\/dev\/net\/tun|privileged:|cap_add:/);
    const installed = finalStage()
      .filter((line) => /^RUN .*\bapt-get install\b/.test(line))
      .flatMap((line) => line.split(/\s+/));
    expect(installed).not.toContain("tailscale");
    const header = composeHeader();
    expect(header).toContain("name starts with tailscale (tailscale0, tailscale1, ...)");
    expect(header).toContain("100.64.0.0/10");
    expect(header).toContain("lowest-numbered interface first");
    expect(header).toContain("kernel TUN mode");
    expect(header).toContain("same tailnet");
  });

  it("mounts /data and /work as named volumes, which Docker creates owned by the image's user", () => {
    const lines = composeLines();
    expect(lines).toContain("      - data:/data");
    expect(lines).toContain("      - work:/work");
    const top = lines.slice(lines.indexOf("volumes:"));
    expect(top).toEqual(["volumes:", "  data:", "  work:"]);
  });

  it("keeps #141's 31-minute stop grace, so a stop waits out the drain's 30 minutes rather than Docker's ten seconds", () => {
    expect(composeLines().filter((line) => /^\s+stop_grace_period:/.test(line))).toEqual(["    stop_grace_period: 31m"]);
  });

  it("defaults its image to the release's reference, which the release workflow writes in, and takes AGENT_HARNESS_IMAGE, the host-side updater's, over it", () => {
    expect(composeService("environment").filter((line) => /^\s+image:/.test(line))).toEqual([`    image: \${AGENT_HARNESS_IMAGE:-${UNRELEASED_IMAGE}}`]);
    // The placeholder is written once, so the workflow's substitution changes the image and nothing else.
    expect(compose.split(UNRELEASED_IMAGE)).toHaveLength(2);
  });

  it("names, in its header, the public image without registry login and the host-side updater's documentation", () => {
    const header = composeHeader();
    expect(header).toContain("ghcr.io/david-systemtech/agent-harness");
    expect(header).toContain("no registry login is required");
    expect(header).toContain("https://github.com/david-systemtech/agent-harness/blob/main/docs/host-updater.md");
    expect(header).toContain("host-updater.sh");
  });

  it("names, in its header, the data directory the image's serve runs on for every verb it shows in the container", () => {
    const serveDir = /"--data-dir", "([^"]+)"/.exec(finalStage().at(-1) ?? "")?.[1];
    expect(serveDir).toBe("/data");
    const verbs = composeHeader()
      .split("\n")
      .filter((line) => /exec environment agent-harness /.test(line));
    expect(verbs.length).toBeGreaterThan(0);
    for (const line of verbs) expect(line, line).toMatch(new RegExp(`--data-dir ${serveDir}( |$)`));
  });

  it("passes a new environment's name and channel into the container from compose's own variables, blank when unset, which serve reads as not given (#846)", () => {
    const lines = composeLines();
    expect(lines).toContain("      AGENT_HARNESS_NAME: ${AGENT_HARNESS_NAME:-}");
    expect(lines).toContain("      AGENT_HARNESS_CHANNEL: ${AGENT_HARNESS_CHANNEL:-}");
  });

  it("takes every variable Add a machine's container snippet sets on its up line", () => {
    const releaseSource = { origin: "https://git.systemtech.dev:5526", kind: "forgejo", repository: "david/agent-harness" } as const;
    const up = installLines({ releaseSource, version: "0.4.2", channel: "beta", name: "Build box" }).compose.find((line) => line.endsWith(" docker compose up -d")) ?? "";
    const set = [...up.matchAll(/(?:^| )([A-Z][A-Z0-9_]*)=/g)].map((match) => match[1]);
    expect(set).toEqual(["AGENT_HARNESS_CHANNEL", "AGENT_HARNESS_NAME"]);
    for (const variable of set) expect(composeLines(), variable).toContain(`      ${variable}: \${${variable}:-}`);
  });

  it("says, in its header, how the first start takes a name and the beta channel, and that later starts keep what it took", () => {
    const header = composeHeader();
    expect(header).toContain("#   AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME=build-box docker compose up -d");
    expect(header).toMatch(/later start[^.]*keeps?/i);
  });

  it("declares the container to the environment and asks for no privilege", () => {
    const lines = composeLines();
    expect(lines).toContain('      AGENT_HARNESS_CONTAINER: "1"');
    for (const line of lines) expect(line, line).not.toMatch(/privileged|cap_add|security_opt|userns_mode/);
  });
});

describe("the opt-in headless browser service", () => {
  it("runs upstream Debian Chromium under new headless, pinned for Renovate, with a non-root user, init, restart, a GiB limit and a loopback port", () => {
    const lines = composeService("browser");
    const text = lines.join("\n");
    expect(text).toMatch(/image: docker\.io\/linuxserver\/chromium:latest@sha256:[a-f0-9]{64}/);
    expect(lines).toContain('    profiles: ["browser"]');
    expect(lines).toContain('    user: "10001:10001"');
    expect(lines).toContain("    init: true");
    expect(lines).toContain("    restart: unless-stopped");
    expect(lines).toContain("    mem_limit: 1g");
    expect(lines).toContain('      - "127.0.0.1:9222:9222"');
    expect(text).toContain("/usr/lib/chromium/chromium");
    expect(text).toContain("--headless=new");
    expect(text).not.toMatch(/build:|SYS_ADMIN|privileged:/);
    expect(composeHeader()).toContain("browser.headless.endpoint");
    expect(composeHeader()).toContain("http://127.0.0.1:9222");
    expect(composeHeader()).toContain("--profile browser");
    const renovate = JSON.parse(readFileSync(join(root, "renovate.json"), "utf8")) as { packageRules: unknown[] };
    expect(renovate.packageRules).toContainEqual({ matchManagers: ["docker-compose"], matchPackageNames: ["docker.io/linuxserver/chromium"], pinDigests: true });
  });
});

describe("the image and the compose file", () => {
  it("set neither IS_SANDBOX nor CLAUDE_CODE_BUBBLEWRAP", () => {
    for (const [file, text] of [
      ["Dockerfile", instructions(dockerfile).join("\n")],
      ["scripts/compose.yaml", composeLines().join("\n")],
    ] as const) {
      expect(text, file).not.toMatch(/IS_SANDBOX|CLAUDE_CODE_BUBBLEWRAP/);
    }
  });
});

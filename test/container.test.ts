/**
 * The container image (`Dockerfile`) and the install script's compose file
 * (`scripts/compose.yaml`), read as text (#141; permissions spec, "Never
 * root"): no image is built or run here. The image runs the environment as a
 * non-root user that owns the volumes' mount points, the compose file runs
 * that user on named volumes, and neither sets `IS_SANDBOX` or
 * `CLAUDE_CODE_BUBBLEWRAP`. What only a real build and run can show is the
 * manual check in the pull request.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

/** The instructions of the image's last stage: what the container runs. */
const finalStage = (): string[] => {
  const all = instructions(dockerfile);
  const from = all.map((line, index) => (/^FROM /i.test(line) ? index : -1)).filter((index) => index >= 0);
  return all.slice(from.at(-1));
};

/** The compose file without its comments. */
const composeLines = (): string[] =>
  compose
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
    .filter((line) => line.trim() !== "");

/** The uid and gid the image gives its user. */
const imageUser = (): { name: string; uid: string; gid: string } => {
  const stage = finalStage().join("\n");
  const user = /useradd [^\n]*--uid (\d+) [^\n]*?(\S+)(?: &&|$)/m.exec(stage);
  const group = /groupadd --gid (\d+) (\S+)/.exec(stage);
  if (!user || !group) throw new Error("The image creates no user with a fixed uid and group with a fixed gid.");
  return { name: user[2] as string, uid: user[1] as string, gid: group[1] as string };
};

describe("the container image", () => {
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

  it("starts the environment with serve on /data, as that user", () => {
    const stage = finalStage();
    expect(stage.at(-2)).toBe('ENTRYPOINT ["agent-harness"]');
    expect(stage.at(-1)).toBe('CMD ["serve", "--data-dir", "/data"]');
    expect(stage.findIndex((line) => line === "USER agent-harness")).toBeLessThan(stage.length - 2);
  });
});

describe("the install script's compose file", () => {
  it("runs the image's user, by the uid and gid the image gives it", () => {
    const { uid, gid } = imageUser();
    const user = composeLines().filter((line) => /^\s+user:/.test(line));
    expect(user).toEqual([`    user: "${uid}:${gid}"`]);
    expect(uid).not.toBe("0");
  });

  it("mounts /data and /work as named volumes, which Docker creates owned by the image's user", () => {
    const lines = composeLines();
    expect(lines).toContain("      - data:/data");
    expect(lines).toContain("      - work:/work");
    const top = lines.slice(lines.indexOf("volumes:"));
    expect(top).toEqual(["volumes:", "  data:", "  work:"]);
  });

  it("declares the container to the environment and asks for no privilege", () => {
    const lines = composeLines();
    expect(lines).toContain('      AGENT_HARNESS_CONTAINER: "1"');
    for (const line of lines) expect(line, line).not.toMatch(/privileged|cap_add|security_opt|userns_mode/);
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

import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { hostname, userInfo } from "node:os";

/**
 * Who this terminal UI is, as the environment lists its client session
 * (`access.sessions.list`): `<user>@<hostname>:<tty>`, so two terminals on
 * one machine are told apart by their terminal device. A chosen default.
 */
export interface TerminalIdentity {
  readonly user: string;
  readonly host: string;
  /** The terminal device without `/dev/` (`pts/3`, `ttys004`), `console` on Windows, `-` with no terminal. */
  readonly tty: string;
}

export const clientLabel = (identity: TerminalIdentity): string => `${identity.user}@${identity.host}:${identity.tty}`;

const deviceName = (path: string): string | undefined => {
  const trimmed = path.trim();
  return trimmed.startsWith("/dev/") ? trimmed.slice("/dev/".length) : undefined;
};

/** The terminal on standard input: `/proc` on Linux, the `tty` command elsewhere. */
export const ttyName = (): string => {
  if (process.platform === "win32") return "console";
  if (process.platform === "linux") {
    try {
      const name = deviceName(readlinkSync("/proc/self/fd/0"));
      if (name) return name;
    } catch {
      // No /proc: ask `tty`.
    }
  }
  const answer = spawnSync("tty", [], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8", timeout: 2000 });
  return (answer.status === 0 && deviceName(answer.stdout)) || "-";
};

const userName = (): string => {
  try {
    return userInfo().username;
  } catch {
    return process.env["USER"] ?? process.env["USERNAME"] ?? "user";
  }
};

export const currentIdentity = (): TerminalIdentity => ({ user: userName(), host: hostname(), tty: ttyName() });

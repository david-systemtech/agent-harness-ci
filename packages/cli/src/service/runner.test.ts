import { describe, expect, it } from "vitest";
import { ServiceCommandError, ServiceError } from "./errors.js";
import { COMMAND_TIMEOUT_MS, CommandTimeoutError, processRunner, serviceCommands, STOP_COMMAND_TIMEOUT_MS, type CommandRunner } from "./runner.js";

/** A Node program that outlives any timeout a test gives it, and one that exits with `code`. */
const lingering = ["-e", "setTimeout(() => {}, 600_000)"];
const exiting = (code: number) => ["-e", `process.exit(${code})`];

describe("the service manager command timeouts", () => {
  it("give a command 30 seconds, and one that stops the service the definitions' 31-minute stop timeout and a minute", () => {
    expect(COMMAND_TIMEOUT_MS).toBe(30_000);
    expect(STOP_COMMAND_TIMEOUT_MS).toBe(32 * 60_000);
  });
});

describe("processRunner", () => {
  it("kills a command that outlives the timeout it was given and rejects with that timeout", { timeout: 60_000 }, async () => {
    const outcome = processRunner(process.execPath, lingering, 50);
    await expect(outcome).rejects.toBeInstanceOf(CommandTimeoutError);
    await expect(outcome).rejects.toMatchObject({ timeoutMs: 50 });
  });

  it("resolves with the exit code of a command that ends within its timeout, whatever the code", { timeout: 60_000 }, async () => {
    expect(await processRunner(process.execPath, exiting(3), 60_000)).toMatchObject({ code: 3 });
  });
});

describe("serviceCommands", () => {
  /** A runner whose every command outlives its timeout, as the real one reports it. */
  const timingOut: CommandRunner = async (_, __, timeoutMs) => {
    throw new CommandTimeoutError(timeoutMs);
  };

  it("runs stop with the stop's timeout and every other way with 30 seconds", async () => {
    const given: number[] = [];
    const commands = serviceCommands(async (_, __, timeoutMs) => {
      given.push(timeoutMs);
      return { code: 0, stdout: "", stderr: "" };
    });
    await commands.query("systemctl", ["--user", "is-active", "box.service"]);
    await commands.probe("systemctl", ["--user", "is-enabled", "box.service"]);
    await commands.run("systemctl", ["--user", "daemon-reload"]);
    await commands.attempt("systemctl", ["--user", "start", "box.service"]);
    await commands.stop("systemctl", ["--user", "disable", "--now", "box.service"]);
    expect(given).toEqual([COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS, STOP_COMMAND_TIMEOUT_MS]);
  });

  it("says in one sentence that a stop which outlived its timeout may still be going on", async () => {
    const outcome = serviceCommands(timingOut).stop("systemctl", ["--user", "disable", "--now", "box.service"]);
    await expect(outcome).rejects.toBeInstanceOf(ServiceError);
    await expect(outcome).rejects.toThrow(
      "systemctl --user disable --now box.service did not finish within 32 minutes, so the service may still be stopping: " +
        "`agent-harness service status` says whether it still runs.",
    );
  });

  it("says in one sentence which command did not finish within 30 seconds", async () => {
    await expect(serviceCommands(timingOut).run("systemctl", ["--user", "daemon-reload"])).rejects.toThrow(
      new ServiceError("systemctl --user daemon-reload did not finish within 30 seconds."),
    );
  });

  it("fails a stop the service manager refused with what it said", async () => {
    const refusing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "Access denied" });
    await expect(serviceCommands(refusing).stop("launchctl", ["bootout", "gui/501/box"])).rejects.toBeInstanceOf(ServiceCommandError);
  });
});

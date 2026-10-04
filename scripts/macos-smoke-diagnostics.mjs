import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Known fixture credentials plus credential-bearing structured output never enter uploaded text. */
export function redactDiagnostic(text, secrets = []) {
  let clean = String(text);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const value of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) clean = clean.split(value).join("<REDACTED>");
  }
  clean = clean.replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s"']+/gi, "$1<REDACTED>");
  clean = clean.replace(/(["']?(?:token|secret|password|authorization|pairingCode|bootstrapSecret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1\"<REDACTED>\"");
  return clean;
}

export const executeDiagnostic = (command, args, { timeout = 20_000 } = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

/** Saves only sanitized output; the raw desktop log stays in the smoke's private scratch directory. */
export function persistDesktopLog(directory, privateDirectory, secrets) {
  const path = join(privateDirectory, "desktop.log");
  if (existsSync(path)) writeFileSync(join(directory, "desktop.log"), redactDiagnostic(readFileSync(path, "utf8"), secrets), { mode: 0o600 });
}

/** Records failures even when setup or cleanup did not create a timeout artifact. */
export function persistSmokeFailure(directory, error, secrets) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(join(directory, "failure.txt"), redactDiagnostic(error.stack ?? String(error), secrets) + "\n", { mode: 0o600 });
}

/** Collects bounded native evidence before the failed desktop is stopped. */
export async function collectMacosSmokeDiagnostics({ directory, privateDirectory, pid, error, secrets = [], execute = executeDiagnostic }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const save = (name, value) => writeFileSync(join(directory, name), redactDiagnostic(value, secrets), { mode: 0o600 });
  const saveJson = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value,
    (_key, entry) => typeof entry === "string" ? redactDiagnostic(entry, secrets) : entry, 2), { mode: 0o600 });
  saveJson("timeout.json", { stage: error.stage, expression: error.expression, error: error.message, pid, time: new Date().toISOString() });
  persistDesktopLog(directory, privateDirectory, secrets);
  const capture = async (name, command, args, json = false) => {
    try {
      const output = await execute(command, args);
      if (json) saveJson(name, JSON.parse(output.stdout));
      else save(name, output.stdout + (output.stderr ? "\n" + output.stderr : ""));
    } catch (failure) { save(name + ".error.txt", `collect ${name}; command: ${command} ${JSON.stringify(args)}\n${failure.message}`); }
  };
  const rawScreen = join(privateDirectory, "runner-screen.png");
  const screen = join(directory, "screenshot.png");
  await Promise.all([
    pid ? capture("sample.txt", "/usr/bin/sample", [String(pid), "2", "1"]) : Promise.resolve(save("sample.txt.error.txt", "No desktop PID was available")),
    capture("windows.json", "/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import('CoreGraphics'); JSON.stringify(ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(0, 0)).map(w => ({ owner: w.kCGWindowOwnerName, title: w.kCGWindowName, pid: w.kCGWindowOwnerPID, bounds: w.kCGWindowBounds })))`], true),
    (async () => {
      try {
        await execute("/usr/sbin/screencapture", ["-x", rawScreen]);
        // Mask every recognized text region, including credentials not known to the script.
        // The sanitized window list retains dialog titles; the screenshot retains the dialog's shape.
        await execute("/usr/bin/swift", [fileURLToPath(new globalThis.URL("./redact-macos-smoke-screen.swift", import.meta.url)), rawScreen, screen]);
      } catch (failure) {
        rmSync(screen, { force: true });
        save("screenshot.png.error.txt", failure.message);
      } finally { rmSync(rawScreen, { force: true }); }
    })(),
  ]);
}

/** Attempts every cleanup operation while retaining the original smoke failure. */
export async function finishSmoke(original, cleanup, report) {
  const failures = [];
  for (const operation of cleanup) {
    try { await operation(); } catch (error) {
      failures.push(error);
      // Persist evidence while private captures still exist, before later cleanup removes them.
      try { await report(error); } catch (reportError) { failures.push(reportError); }
    }
  }
  if (original) throw original;
  if (failures.length) throw new AggregateError(failures, "Packaged smoke cleanup failed");
}

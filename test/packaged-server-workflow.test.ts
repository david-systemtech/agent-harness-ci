import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseWorkflowInput } from "./release-workflow-input.js";

const { hosted, recovery } = releaseWorkflowInput(join(import.meta.dirname, ".."));
const workflows: readonly (readonly [string, string])[] = [["public", hosted], ...(recovery === undefined ? [] : [["recovery", recovery] as const])];

/** The workflows are checked as text; actual installers and packaged Node run on hosted runners. */
const job = (workflow: string, name: string): string => {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, name).toBeGreaterThan(lines.indexOf("jobs:"));
  const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
};

describe.each(workflows)("the %s release's packed servers", (_name, workflow) => {
  it("checks contracts in each packed desktop before handing it to the release job", () => {
    const mac = job(workflow, "desktop-macos");
    const linux = job(workflow, "desktop-arch");
    const windows = job(workflow, "desktop-windows");
    expect(mac).toContain('test -f "$app/Contents/Resources/server/node_modules/@agent-harness/contracts/package.json"');
    expect(linux).toContain("test -f unpacked/opt/agent-harness/resources/server/node_modules/@agent-harness/contracts/package.json");
    expect(windows).toContain("sevenzip=$(bash scripts/7zip.sh)");
    expect(windows).toContain('"$sevenzip" x -y desktop/agent-harness-desktop-win32-x64-setup.exe -ounpacked-setup');
    expect(windows).toContain("-name 'app-64.7z'");
    expect(windows).toContain('test -f "$payload"');
    expect(windows).toContain('"$sevenzip" x -y "$payload" -ounpacked-windows');
    expect(windows).toContain("test -f unpacked-windows/resources/server/node_modules/@agent-harness/contracts/package.json");
    for (const body of [mac, linux, windows]) {
      expect(body.indexOf("server/node_modules/@agent-harness/contracts/package.json")).toBeLessThan(body.search(/- name: (Keep the desktop build|Hand the desktop to the release job)/));
    }
  });

  it("fails the macOS desktop when its bundled server's Node is signed otherwise than the server artefact's, before handing it on (#1724)", () => {
    const mac = job(workflow, "desktop-macos");
    expect(mac).toContain("tar -xzf server/agent-harness-darwin-arm64.tar.gz -C tarball");
    expect(mac).toContain("bundled=$(codesign -d -r- unzipped/agent-harness.app/Contents/Resources/server/node/bin/node 2>&1 | grep '^designated => ')");
    expect(mac).toContain("artefact=$(codesign -d -r- tarball/node/bin/node 2>&1 | grep '^designated => ')");
    expect(mac).toContain('test "$bundled" = "$artefact"');
    expect(mac).toContain("rm -rf server desktop unzipped tarball");
    expect(mac.indexOf('test "$bundled" = "$artefact"')).toBeLessThan(mac.search(/- name: (Keep the desktop build|Hand the desktop to the release job)/));
  });
});

describe("the public release's packaged server smoke tests", () => {
  it("uploads Windows failure evidence retained before the ordinary user's fixture is removed", () => {
    const body = job(hosted, "smoke-windows");
    expect(body).toContain("Copy-Item -LiteralPath (Resolve-Path 'scripts/windows-smoke-diagnostics.ps1').Path");
    expect(body).toContain("wevtutil.exe sl Microsoft-Windows-TaskScheduler/Operational /e:true");
    expect(body.indexOf("$childDiagnostics = Join-Path $work 'diagnostics'")).toBeLessThan(body.indexOf("if ($created) { Remove-LocalUser"));
    expect(body).toMatch(/name: Keep Windows smoke failure diagnostics\n\s+if: \$\{\{ failure\(\) \}\}\n\s+uses: actions\/upload-artifact@[a-f0-9]{40}/);
    expect(body).toContain("path: windows-smoke-diagnostics");
    expect(body).toContain("if-no-files-found: error");
  });

  it.each(["smoke-windows", "smoke-macos", "smoke-linux"])("checks replay handling in the packaged provider listener with its own Node in %s", name => {
    const body = job(hosted, name);
    expect(body).toContain(name === "smoke-windows"
      ? "& $node scripts/check-packaged-provider-sign-in.mjs $server"
      : '"$server/node/bin/node" scripts/check-packaged-provider-sign-in.mjs "$server"');
    if (name === "smoke-windows") {
      expect(body).toContain("Copy-Item -LiteralPath (Resolve-Path 'scripts/check-packaged-provider-sign-in.mjs').Path -Destination (Join-Path $work 'scripts')");
      expect(body).toContain("if ($LASTEXITCODE -ne 0) { throw 'Packaged provider sign-in check failed' }");
    }
  });

  it("checks a packaged macOS replacement with a kept credential separately from fresh server starts", () => {
    const body = job(hosted, "smoke-macos");
    expect(body).toContain("- name: Replace the packaged desktop with an existing client credential");
    expect(body).toContain("uses: actions/checkout@");
    expect(body).toContain('"$server/node/bin/node" scripts/macos-desktop-update-smoke.mjs');
    expect(body).toContain('"unzipped/agent-harness.app"');
  });

  it.each(["smoke-windows", "smoke-macos", "smoke-linux"])("checks packaged and materialized extension assets after readiness in %s", (name) => {
    const body = job(hosted, name);
    const check = "scripts/check-packaged-extension.mjs";
    expect(body).toMatch(/uses: actions\/checkout@[a-f0-9]{40}/);
    expect(body).toContain(check);
    expect(body.lastIndexOf(check)).toBeGreaterThan(body.indexOf(name === "smoke-windows" ? "Wait-Ready $defect" : 'if [ "$ready" != true ]'));
    expect(body).toContain(name === "smoke-windows"
      ? '& $node scripts/check-packaged-extension.mjs $server $dataDir $env:VERSION'
      : '"$node" scripts/check-packaged-extension.mjs "$server" "$data_dir" "$VERSION"');
    if (name === "smoke-windows") {
      expect(body).toContain("if ($LASTEXITCODE -ne 0) { throw 'Packaged browser extension check failed' }");
      expect(body).toContain("Copy-Item -LiteralPath (Resolve-Path 'scripts/check-packaged-extension.mjs').Path -Destination (Join-Path $work 'scripts')");
    }
  });

  it("exercises Mac tunnel ownership with the packaged environment and its bundled Node", () => {
    const body = job(hosted, "smoke-macos");
    expect(body).toContain("- name: Verify packaged macOS tunnel ownership");
    expect(body).toContain('"$server/node/bin/node" --input-type=module');
    expect(body).toContain("node_modules/@agent-harness/environment/dist/serve/interfaces.js");
    expect(body).toContain("tailscaleDetector");
    expect(body).toContain('"Stopped", "NeedsLogin"');
  });

  it.each([
    ["smoke-windows", "windows-latest", "desktop-windows", "desktop-win32-x64"],
    ["smoke-macos", "macos-latest", "desktop-macos", "desktop-darwin-arm64"],
    ["smoke-linux", "ubuntu-latest", "desktop-arch", "desktop-linux-x64"],
  ] as const)("gates publishing on %s using the existing desktop artifact", (name, runner, build, artifact) => {
    const body = job(hosted, name);
    expect(body).toContain(`runs-on: ${runner}`);
    expect(body).toContain(`needs: [prepare, ${build}]`);
    expect(body).toMatch(/uses: actions\/download-artifact@[a-f0-9]{40}/);
    expect(body).toContain(`name: ${artifact}`);
    expect(body).toContain("VERSION: ${{ needs.prepare.outputs.version }}");
    expect(body).toContain("--version");
    expect(body).toContain("service status");
    expect(body).toContain("No service is installed");
    expect(body).not.toContain("service start");
    expect(job(hosted, "release").split("\n").find((line) => line.includes("needs:"))).toContain(name);
  });

  it.each(["smoke-macos", "smoke-linux"])("requires two ready starts of the same environment in %s and cleans up on failure", (name) => {
    const body = job(hosted, name);
    expect(body).toContain('data_dir=$(mktemp -d)');
    expect(body).toContain('for attempt in 1 2; do');
    expect(body).toContain('serve --data-dir "$data_dir" --port "$port"');
    expect(body).toContain('/.well-known/agent-harness/environment');
    expect(body).toContain('discovery.harnessVersion !== process.env.VERSION');
    expect(body).toContain('discovery.readiness !== "ready"');
    expect(body).toContain('second start/keychain read (#1381)');
    expect(body).toContain('trap cleanup EXIT');
    expect(body).toContain('kill -KILL -- "-$pid"');
    expect(body).toContain('service uninstall --data-dir "$data_dir"');
  });

  it("starts Windows twice in one data directory, then runs the generated entry directly and always uninstalls", () => {
    const body = job(hosted, "smoke-windows");
    expect(body).toContain('Join-Path $env:LOCALAPPDATA "agent-harness"');
    expect(body).toContain('[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)');
    expect(body).toContain('foreach ($attempt in 1, 2)');
    expect(body).toContain('serve --data-dir');
    expect(body).toContain('/.well-known/agent-harness/environment');
    expect(body).toContain('$discovery.harnessVersion -eq $env:VERSION');
    expect(body).toContain('$discovery.readiness -eq "ready"');
    expect(body).toContain('second start/keychain read (#1381)');
    expect(body).toContain('service install --data-dir');
    expect(body).toContain('"launcher-entry.cmd"');
    expect(body).toContain('-FilePath $env:ComSpec');
    expect(body).toContain('/d /s /c');
    expect(body).toContain('"$env:VERSION`n"');
    expect(body).toContain('names no version');
    expect(body).toContain('launcher-entry version check (#1382)');
    expect(body).toContain('finally {');
    expect(body).toContain('Stop-OwnedProcessTree -Root $process');
    expect(body).toContain(". (Join-Path $PSScriptRoot 'scripts/stop-windows-process-tree.ps1')");
    expect(body).toContain("Copy-Item -LiteralPath (Resolve-Path 'scripts/stop-windows-process-tree.ps1').Path -Destination (Join-Path $work 'scripts')");
    expect(body).not.toContain('service uninstall --data-dir $dataDir');
    expect(body).toContain('"Uninstall agent-harness.exe"');
    expect(body).toContain('$uninstall.ExitCode -ne 0');
    expect(body).toContain('Get-ScheduledTask -TaskName agent-harness');
    expect(body).toContain("throw 'Desktop uninstall left the environment task registered'");
    expect(body).toContain("throw 'Desktop uninstall deleted personal environment data'");
    expect(body).toContain("throw 'Desktop uninstall left service launch scripts behind'");
    expect(body).toContain("throw 'Desktop uninstall left app resources behind'");
    expect(body).toContain('Remove-Item -LiteralPath $dataDir -Recurse -Force');
  });

  it("fails Windows staging at a stated 90-second bound, rather than allowing the four-minute copy", () => {
    const body = job(hosted, "smoke-windows");
    expect(body).toContain('$stagingLimitSeconds = 90');
    expect(body).toContain('$stagingTimer = [Diagnostics.Stopwatch]::StartNew()');
    expect(body).toContain('$process.WaitForExit($stagingLimitSeconds * 1000)');
    expect(body).toContain('$stagingTimer.Elapsed.TotalSeconds -gt $stagingLimitSeconds');
    expect(body).toContain('Windows staging (#1383) exceeded');
    expect(body).toContain('Windows staging took');
  });

  it("uninstalls a live scheduled-task environment before checking process exit and port closure", () => {
    const body = job(hosted, "smoke-windows");
    const liveStart = body.indexOf("Start-ScheduledTask -TaskName agent-harness");
    const uninstall = body.indexOf("$uninstall = Start-Process");
    const checked = body.indexOf("throw 'Desktop uninstall left the environment port open'");
    expect(liveStart).toBeGreaterThan(-1);
    expect(uninstall).toBeGreaterThan(liveStart);
    expect(checked).toBeGreaterThan(uninstall);
    expect(body.slice(liveStart, uninstall).split("\n").filter((line) => !line.trim().startsWith("#")).join("\n")).not.toContain("Stop-Tree");
    expect(body).toContain("Wait-Ready 'scheduled-task start before uninstall (#1478)'");
    expect(body).toContain("throw 'Desktop uninstall left an owned process running'");
    expect(body).toContain("throw 'Desktop uninstall stopped an unrelated Node process'");
    expect(body).toContain("$unrelatedNode = Join-Path $PSScriptRoot 'unrelated-node.exe'");
    expect(body).toContain("Copy-Item -LiteralPath $node -Destination $unrelatedNode");
    expect(body).toContain("$unrelated = Start-Process -FilePath $unrelatedNode");
  });

  it("ends the scheduled task as Task Scheduler does, finds the launcher and the environment gone, and starts it again into one chain (#1712)", () => {
    const body = job(hosted, "smoke-windows");
    const ready = body.indexOf("Wait-Ready 'scheduled-task start before uninstall (#1478)'");
    const stop = body.indexOf("Stop-ScheduledTask -TaskName agent-harness");
    const portClosed = body.indexOf("throw 'Stop-ScheduledTask left the environment port open (#1712)'");
    const processesGone = body.indexOf('throw "Stop-ScheduledTask left $($left.Count) launcher-entry, launcher or environment processes running (#1712)"');
    const restart = body.indexOf("Start-ScheduledTask -TaskName agent-harness", stop);
    const readyAgain = body.indexOf("Wait-Ready 'scheduled-task start after Stop-ScheduledTask (#1712)'");
    const oneChain = body.indexOf("not one of each (#1712)");
    const uninstall = body.indexOf("$uninstall = Start-Process");
    expect(ready).toBeGreaterThan(-1);
    expect([ready, stop, portClosed, processesGone, restart, readyAgain, oneChain, uninstall]).toEqual(
      [ready, stop, portClosed, processesGone, restart, readyAgain, oneChain, uninstall].toSorted((a, b) => a - b),
    );
    expect(Math.min(stop, portClosed, processesGone, restart, readyAgain, oneChain)).toBeGreaterThan(-1);
    expect(body).toContain("'which started the launcher entry, has ended, so the launcher stops'");
    expect(body).toContain("$launchers[0].ParentProcessId -ne $entries[0].ProcessId");
  });

  it("waits for the silent per-user Windows setup and uses its installed Node and CLI", () => {
    const body = job(hosted, "smoke-windows");
    expect(body).toContain("shell: pwsh");
    expect(body).toContain("Start-Process");
    expect(body).toContain("-ArgumentList '/S' -Wait -PassThru");
    expect(body).toContain("$setup.ExitCode -ne 0");
    expect(body).toContain('$env:LOCALAPPDATA "Programs\\agent-harness-desktop\\resources\\server"');
    expect(body).toContain('Join-Path $server "node\\node.exe"');
    expect(body).toContain('Join-Path $server "packages\\cli\\dist\\main.js"');
    expect(body).toContain('"agent-harness $env:VERSION"');
    expect(body).toContain("$code -ne 3");
    expect(body).toContain("exit 0");
  });

  it("unpacks the macOS zip and Linux package, then checks the bundled Node's CLI version and exit 3 status", () => {
    const mac = job(hosted, "smoke-macos");
    const linux = job(hosted, "smoke-linux");
    expect(mac).toContain("ditto -x -k desktop/agent-harness-desktop-darwin-arm64.zip unzipped");
    expect(mac).toContain("server=unzipped/agent-harness.app/Contents/Resources/server");
    expect(mac).toContain('codesign --verify --deep --strict "unzipped/agent-harness.app"');
    expect(linux).toContain("bsdtar -xf desktop/agent-harness-desktop-linux-x64.pacman -C unpacked");
    expect(linux).toContain("server=unpacked/opt/agent-harness/resources/server");
    for (const body of [mac, linux]) {
      expect(body).toContain('"$server/node/bin/node" "$server/packages/cli/dist/main.js" --version');
      expect(body).toContain('= "agent-harness $VERSION"');
      expect(body).toContain('"$server/node/bin/node" "$server/packages/cli/dist/main.js" service status');
      expect(body).toContain('test "$code" -eq 3');
    }
  });
});

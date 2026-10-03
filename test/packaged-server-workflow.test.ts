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
    expect(windows).toContain("7z x -y desktop/agent-harness-desktop-win32-x64-setup.exe -ounpacked-setup");
    expect(windows).toContain("-name 'app-64.7z'");
    expect(windows).toContain('test -f "$payload"');
    expect(windows).toContain('7z x -y "$payload" -ounpacked-windows');
    expect(windows).toContain("test -f unpacked-windows/resources/server/node_modules/@agent-harness/contracts/package.json");
    for (const body of [mac, linux, windows]) {
      expect(body.indexOf("server/node_modules/@agent-harness/contracts/package.json")).toBeLessThan(body.search(/- name: (Keep the desktop build|Hand the desktop to the release job)/));
    }
  });
});

describe("the public release's packaged server smoke tests", () => {
  it.each([
    ["smoke-windows", "windows-latest", "desktop-windows", "desktop-win32-x64"],
    ["smoke-macos", "macos-latest", "desktop-macos", "desktop-darwin-arm64"],
    ["smoke-linux", "ubuntu-latest", "desktop-arch", "desktop-linux-x64"],
  ] as const)("gates publishing on %s using the existing desktop artifact", (name, runner, build, artifact) => {
    const body = job(hosted, name);
    expect(body).toContain(`runs-on: ${runner}`);
    expect(body).toContain(`needs: [check, ${build}]`);
    expect(body).toMatch(/uses: actions\/download-artifact@[a-f0-9]{40}/);
    expect(body).toContain(`name: ${artifact}`);
    expect(body).toContain("VERSION: ${{ needs.check.outputs.version }}");
    expect(body).toContain("--version");
    expect(body).toContain("service status");
    expect(body).toContain("No service is installed");
    expect(body).not.toMatch(/service (?:install|start)/);
    expect(job(hosted, "release").split("\n").find((line) => line.includes("needs:"))).toContain(name);
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

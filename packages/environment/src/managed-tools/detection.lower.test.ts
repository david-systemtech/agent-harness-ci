import { describe, expect, it } from "vitest";
import { heldBySystem, methodFromShape } from "./detection.js";

/**
 * Where a file no dpkg or rpm owns may still be another package manager's
 * (#1833): pacman's and apk's under `/usr`, MacPorts', Nix's, snap's,
 * cargo's and Chocolatey's, which a bare binary's update must not replace.
 */
describe("heldBySystem", () => {
  it("is a system directory a package manager may own, and cargo's or Chocolatey's", () => {
    for (const file of ["/usr/bin/bao", "/usr/sbin/bao", "/bin/doppler", "/sbin/bao", "/opt/local/bin/gh", "/nix/store/abc-openbao-2.1.1/bin/bao", "/snap/bin/doppler", "/home/a/.cargo/bin/bao", "C:\\ProgramData\\chocolatey\\bin\\doppler.exe"]) {
      expect(heldBySystem(file), file).toBe(true);
    }
  });

  it("is not where a person or a vendor's installer puts a bare binary", () => {
    for (const file of ["/usr/local/bin/bao", "/home/a/.local/bin/claude", "/home/a/bin/doppler", "/opt/bao/bao", "C:\\Users\\a\\.local\\bin\\claude.exe", "C:\\Program Files\\Doppler\\doppler.exe"]) {
      expect(heldBySystem(file), file).toBe(false);
    }
  });
});

/**
 * A shim directory on the PATH names its manager before the realpath's shape
 * does (#1876): mise's shims are links to mise itself, which may be in another
 * manager's directory, such as Homebrew's Cellar.
 */
describe("methodFromShape", () => {
  it("is the manager of the shim directory a tool was found in, wherever the shim resolves to", () => {
    const shims = [
      ["/home/a/.local/share/mise/shims/gh", "/opt/homebrew/Cellar/mise/2025.1.0/bin/mise", "mise"],
      ["/home/a/.local/share/mise/shims/gh", "/home/a/.local/share/mise/installs/node/22.11.0/lib/node_modules/mise/bin/mise", "mise"],
      ["/home/a/.asdf/shims/vault", "/home/linuxbrew/.linuxbrew/Cellar/asdf/0.16.0/libexec/shims/vault", "asdf"],
      ["C:\\Users\\a\\scoop\\shims\\gh.exe", "C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Scoop\\shim.exe", "scoop"],
    ] as const;
    for (const [path, realpath, method] of shims) expect(methodFromShape("gh", { path, realpath }), path).toBe(method);
  });

  it("is still the realpath's shape for a tool found anywhere else", () => {
    expect(methodFromShape("gh", { path: "/opt/homebrew/bin/gh", realpath: "/opt/homebrew/Cellar/gh/2.63.2/bin/gh" })).toBe("homebrew");
    expect(methodFromShape("gh", { path: "/home/a/bin/gh", realpath: "/home/a/.local/share/mise/installs/gh/2.63.2/bin/gh" })).toBe("mise");
    expect(methodFromShape("gh", { path: "/home/a/bin/gh", realpath: "/home/a/bin/gh" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { heldBySystem } from "./detection.js";

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

import { describe, expect, it } from "vitest";
import { ADDRESS_CLASSES, PagePolicy, addressClassOf, denylistPresets, standingOf, type DenylistEntry } from "./index.js";

/**
 * The page policy and an address's standing under it, and the address
 * classes (browser spec, "The extension, its folder and its listener" and
 * "The headless Chromium"; #541): pure functions over hosts and addresses,
 * read with the denylist's matcher (#132), so the extension, the drivers and
 * the gate read an address alike.
 */

const presets = denylistPresets("/data").browserDomains;
const paypal = presets.find((entry) => entry.pattern === "*.paypal.com") as DenylistEntry;

const policy = (overrides: Partial<PagePolicy> = {}): PagePolicy => ({
  devSites: ["*.myapp.test", "staging.example.com"],
  evaluateEverywhere: false,
  deepReadEverywhere: false,
  browserDomains: presets,
  ...overrides,
});

describe("an address's class", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.8.9.10", "loopback"],
    ["localhost", "loopback"],
    ["LocalHost.", "loopback"],
    ["app.localhost", "loopback"],
    ["::1", "loopback"],
    ["[::1]:8080", "loopback"],
    ["0.0.0.0", "loopback"],
    ["::", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.10", "private"],
    ["169.254.1.1", "link-local"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.254", "cgnat"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["printer.local", "local-name"],
    ["db.internal", "local-name"],
    ["NAS.LAN", "local-name"],
    ["169.254.169.254", "metadata"],
    ["169.254.170.2", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["metadata.google.internal", "metadata"],
    ["metadata.goog", "metadata"],
    ["metadata", "metadata"],
    ["example.com", "public"],
    ["8.8.8.8", "public"],
    ["172.32.0.1", "public"],
    ["100.128.0.1", "public"],
    ["2001:4860:4860::8888", "public"],
    ["local", "public"],
  ] as const)("classes %s as %s", (host, expected) => {
    expect(addressClassOf(host)).toBe(expected);
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/", "metadata"],
    ["HTTP://169.254.169.254.:80/", "metadata"],
    ["2852039166", "metadata"],
    ["0xa9fea9fe", "metadata"],
    ["0251.0376.0251.0376", "metadata"],
    ["169.254.43518", "metadata"],
    ["[::ffff:169.254.169.254]", "metadata"],
    ["http://[::ffff:a9fe:a9fe]/", "metadata"],
    ["[0:0:0:0:0:ffff:a9fe:a9fe]", "metadata"],
    ["https://metadata.google.internal./computeMetadata/v1/", "metadata"],
    ["2130706433", "loopback"],
    ["0x7f.1", "loopback"],
    ["017700000001", "loopback"],
    ["http://[::ffff:127.0.0.1]:3000/", "loopback"],
    ["http://[::ffff:10.0.0.5]/", "private"],
    ["https://user@192.168.1.10:8443/admin", "private"],
    ["ｐｒｉｎｔｅｒ．ｌｏｃａｌ", "local-name"],
    ["https://example.com@10.0.0.1/", "private"],
    ["http://10.0.0.1@example.com/", "public"],
  ] as const)("reads %s in the matcher's spelling as %s", (address, expected) => {
    expect(addressClassOf(address)).toBe(expected);
  });

  it("answers null where the matcher reads no host", () => {
    for (const address of ["", "javascript:alert(1)", "file:///etc/passwd", "1.2.3.4.5", "http://"]) expect(addressClassOf(address), address).toBeNull();
  });

  it("names every class, the cloud metadata addresses a class of their own", () => {
    expect(ADDRESS_CLASSES).toEqual(["public", "loopback", "private", "link-local", "cgnat", "unique-local", "local-name", "metadata"]);
  });
});

describe("an address's standing under a page policy", () => {
  it("is the matching entry of the denylist's browser section, in every spelling the matcher reads", () => {
    const listed = { kind: "denylisted", match: { section: "browserDomains", entry: paypal, matched: "https://www.paypal.com/signin" } };
    expect(standingOf("https://www.paypal.com/signin", policy())).toEqual(listed);
    for (const address of ["HTTP://PayPal.com.", "https://ｐａｙｐａｌ．ｃｏｍ/", "paypal.com", "https://paypal.com:443/x", "https://evil.test@paypal.com/"]) {
      expect(standingOf(address, policy()), address).toEqual({ ...listed, match: { ...listed.match, matched: address } });
    }
  });

  it("reads the host after the userinfo, so a listed name before an @ is not the host", () => {
    expect(standingOf("https://paypal.com@evil.test/", policy())).toEqual({ kind: "ordinary", deepRead: false, evaluate: false, spendsAllowance: false });
  });

  it("never matches a disabled entry", () => {
    const disabled = presets.map((entry) => (entry === paypal ? { ...entry, enabled: false } : entry));
    expect(standingOf("https://www.paypal.com/", policy({ browserDomains: disabled })).kind).toBe("ordinary");
  });

  it("refuses the Chrome Web Store under every policy, a one-time allowance for it included", () => {
    const open = policy({ devSites: ["chromewebstore.google.com", "*.google.com"], evaluateEverywhere: true, deepReadEverywhere: true, browserDomains: [] });
    for (const address of ["https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/detail/x", "https://CHROMEWEBSTORE.google.com."]) {
      expect(standingOf(address, open), address).toEqual({ kind: "web-store" });
      expect(standingOf(address, open, { host: "chromewebstore.google.com" }), address).toEqual({ kind: "web-store" });
      expect(standingOf(address, policy()), address).toEqual({ kind: "web-store" });
    }
  });

  it("stands loopback and private addresses as dev sites without their being listed, and a listed host pattern", () => {
    const dev = { kind: "dev-site", deepRead: true, evaluate: true, spendsAllowance: false };
    for (const address of [
      "http://localhost:3000/",
      "http://127.0.0.1:5173",
      "http://[::1]:8080/",
      "http://10.0.0.5/",
      "http://192.168.1.10/",
      "http://172.20.1.1/",
      "http://100.100.1.2:8123/",
      "http://[fd12::1]/",
      "http://[fe80::1]/",
      "http://homeassistant.local:8123/lovelace",
      "http://db.internal/",
      "http://nas.lan/",
      "https://api.myapp.test/v1",
      "https://myapp.test/",
      "https://staging.example.com/",
    ]) {
      expect(standingOf(address, policy()), address).toEqual(dev);
    }
  });

  it("stands a cloud metadata address and a public site as ordinary, with the everywhere switches deciding deep reads and evaluate", () => {
    for (const address of ["http://169.254.169.254/", "https://example.com/", "https://www.example.com/", "https://api.myapp.test.example.com/"]) {
      expect(standingOf(address, policy()), address).toEqual({ kind: "ordinary", deepRead: false, evaluate: false, spendsAllowance: false });
    }
    expect(standingOf("https://example.com/", policy({ deepReadEverywhere: true }))).toEqual({ kind: "ordinary", deepRead: true, evaluate: false, spendsAllowance: false });
    expect(standingOf("https://example.com/", policy({ evaluateEverywhere: true }))).toEqual({ kind: "ordinary", deepRead: false, evaluate: true, spendsAllowance: false });
  });

  it("opens one listed host with a one-time allowance for it, and says the allowance is spent", () => {
    const allowance = { host: "www.paypal.com" };
    expect(standingOf("https://www.paypal.com/checkout", policy(), allowance)).toEqual({ kind: "ordinary", deepRead: false, evaluate: false, spendsAllowance: true });
    expect(standingOf("https://WWW.PayPal.com./", policy(), { host: "WWW.paypal.COM." })).toMatchObject({ kind: "ordinary", spendsAllowance: true });
    expect(standingOf("https://paypal.com/", policy(), allowance).kind).toBe("denylisted");
    expect(standingOf("https://api.paypal.com/", policy(), allowance).kind).toBe("denylisted");
    expect(standingOf("https://example.com/", policy(), allowance)).toEqual({ kind: "ordinary", deepRead: false, evaluate: false, spendsAllowance: false });
  });

  it("stands an address that is no http or https page as unsupported, and a bare host as the page it names", () => {
    for (const address of ["", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "about:blank", "data:text/html,x", "ws://localhost:1/", "http://", "1.2.3.4.5"]) {
      expect(standingOf(address, policy()), address).toEqual({ kind: "unsupported" });
    }
    expect(standingOf("localhost:3000", policy()).kind).toBe("dev-site");
    expect(standingOf("example.com/path", policy()).kind).toBe("ordinary");
  });

  it("puts the Web Store before the denylist and the denylist before dev sites", () => {
    const store = { id: "store", pattern: "*.google.com", note: "", preset: false, enabled: true };
    expect(standingOf("https://chromewebstore.google.com/", policy({ browserDomains: [store] }))).toEqual({ kind: "web-store" });
    const router = { id: "router", pattern: "192.168.1.1", note: "The router's admin page.", preset: false, enabled: true };
    expect(standingOf("http://192.168.1.1/", policy({ browserDomains: [router] }))).toEqual({
      kind: "denylisted",
      match: { section: "browserDomains", entry: router, matched: "http://192.168.1.1/" },
    });
  });

  it("holds the policy's shape: dev sites as host patterns, the two switches, and denylist entries", () => {
    expect(PagePolicy.safeParse(policy()).success).toBe(true);
    expect(PagePolicy.safeParse({ ...policy(), devSites: ["https://myapp.test"] }).success).toBe(false);
    expect(PagePolicy.safeParse({ ...policy(), evaluateEverywhere: "yes" }).success).toBe(false);
    expect(PagePolicy.safeParse({ ...policy(), browserDomains: [{ pattern: "*.paypal.com" }] }).success).toBe(false);
  });
});

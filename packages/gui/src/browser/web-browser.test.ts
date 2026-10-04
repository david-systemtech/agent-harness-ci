import { expect, it, vi } from "vitest";
import { openBrowserPage } from "../platform/web-browser.js";

it("opens a typed web address in a separate page with no opener", () => {
  const open = vi.fn();
  openBrowserPage("example.org:8443/receipts", { open });
  expect(open).toHaveBeenCalledWith("https://example.org:8443/receipts", "_blank", "noopener,noreferrer");
});

it.each(["javascript:alert(1)", "data:text/html,test", "file:///test/page", "https://user:password@example.org", "", "https://"])("refuses unsafe or invalid page input %s", address => {
  const open = vi.fn();
  expect(() => openBrowserPage(address, { open })).toThrow();
  expect(open).not.toHaveBeenCalled();
});

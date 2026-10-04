// @vitest-environment node
import { expect, it } from "vitest";
import { assertPreviewIsolation, previewNetworkRequests } from "../gallery/phone-preview-isolation.js";

const isolated = { scriptRan: false, parentReadable: false, parentMutated: false, requests: [] };

it("accepts the hosted reading only when scripts, parent access and network are isolated", () => {
  expect(() => assertPreviewIsolation("site/index.html", isolated)).not.toThrow();
});
it.each([
  { scriptRan: true },
  { parentReadable: true },
  { parentMutated: true },
  { requests: ["https://example.test/preview-isolation-html-network"] },
])("fails a hosted isolation violation: %j", reading => {
  expect(() => assertPreviewIsolation("site/index.html", { ...isolated, ...reading })).toThrow(/site\/index.html/);
});

it("accepts only Chromium's CSP denial, keeping aborted, failed and pending HTTP attempts as violations", () => {
  const observed = (errorText: string | null) => ({
    url: () => "https://example.test/preview-isolation-html-style",
    failure: () => errorText === null ? null : { errorText },
  });
  expect(previewNetworkRequests([observed("net::ERR_BLOCKED_BY_CSP"), observed("csp")])).toEqual([]);
  for (const reason of [null, "CSP", "cors", "net::ERR_BLOCKED_BY_CSP_suffix", "net::ERR_FAILED", "net::ERR_ABORTED", "net::ERR_NAME_NOT_RESOLVED"]) {
    expect(() => assertPreviewIsolation("site/index.html", {
      ...isolated, requests: previewNetworkRequests([observed(reason)]),
    })).toThrow("network request");
  }
});

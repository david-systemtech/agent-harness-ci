// @vitest-environment node
import { expect, it } from "vitest";
import { assertPreviewIsolation } from "../gallery/phone-preview-isolation.js";

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

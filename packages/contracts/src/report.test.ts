import { expect, it } from "vitest";
import { REPORT_FILE_BYTES } from "./methods/reports.js";
import { registry } from "./registry.js";

it("requires admin, a bug severity or feature importance, and bounded media for public reports", () => {
  const method = registry["reports.submit"];
  expect(method).toBeDefined();
  expect(method.scope).toBe("admin");
  expect(method.kind).toBe("command");
  const report = { commandId: "0f8fad5b-d9cb-469f-a165-70867728950e", kind: "bug", level: "major", name: "Reporter", description: "The window freezes.", client: { version: "0.1.0", kind: "gui" }, attachments: [] };
  expect(method.params.safeParse({ commandId: report.commandId, report }).success).toBe(true);
  expect(method.params.safeParse({ commandId: report.commandId, report: { ...report, kind: "feature", level: "major" } }).success).toBe(false);
  expect(method.params.safeParse({ commandId: report.commandId, report: { ...report, attachments: [{ name: "script.svg", mediaType: "image/svg+xml", content: "dGVzdA==" }] } }).success).toBe(false);
});


it("accepts a 5 MiB attachment and refuses larger files, more than four files or more than 9 MiB total", () => {
  const method = registry["reports.submit"];
  const file = { name: "capture.png", mediaType: "image/png", content: Buffer.alloc(REPORT_FILE_BYTES).toString("base64") };
  const params = { commandId: "0f8fad5b-d9cb-469f-a165-70867728950e", report: { kind: "bug", level: "minor", name: "Reporter", description: "The sidebar freezes.", client: { version: "0.1.0", kind: "gui" }, attachments: [file] } };
  expect(method.params.safeParse(params).success).toBe(true);
  expect(method.params.safeParse({ ...params, report: { ...params.report, attachments: [{ ...file, content: Buffer.alloc(REPORT_FILE_BYTES + 1).toString("base64") }] } }).success).toBe(false);
  expect(method.params.safeParse({ ...params, report: { ...params.report, attachments: [file, file] } }).success).toBe(false);
  expect(method.params.safeParse({ ...params, report: { ...params.report, attachments: Array.from({ length: 5 }, () => ({ ...file, content: "dGVzdA==" })) } }).success).toBe(false);
});

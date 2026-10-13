import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

it("opens Report bug / Request feature below pairing and explains missing GitHub access", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["forge"] }] });
  const sidebar = await screen.findByRole("navigation", { name: "Sessions" });
  const report = within(sidebar).getByRole("button", { name: "Report bug / Request feature" });
  expect(within(sidebar).getByRole("button", { name: "Pair with an environment…" }).compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await app.user.click(report);
  const dialog = await screen.findByRole("dialog", { name: "Report bug / Request feature" });
  expect(await within(dialog).findByText(/Connect a GitHub account in Settings/)).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Submit report" }).hasAttribute("disabled")).toBe(true);
});

it("submits a feature with a video through the chosen environment and remembers the name on this client", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["forge"], forges: { accounts: [{}] } }] });
  app.environment("desk").wire.answer("reports.submit", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: false }, result: { number: 17, url: "https://github.com/example/project/issues/17" } } }));
  await app.user.click(await screen.findByRole("button", { name: "Report bug / Request feature" }));
  const dialog = await screen.findByRole("dialog", { name: "Report bug / Request feature" });
  await app.user.selectOptions(within(dialog).getByRole("combobox", { name: "Type" }), "feature");
  expect(within(dialog).queryByRole("combobox", { name: "Severity" })).toBeNull();
  await app.user.selectOptions(within(dialog).getByRole("combobox", { name: "Importance" }), "high");
  await app.user.type(within(dialog).getByRole("textbox", { name: "Your name" }), "Reporter");
  await app.user.type(within(dialog).getByRole("textbox", { name: "Description" }), "Add a report shortcut.");
  await app.user.upload(within(dialog).getByLabelText("Screenshots or videos"), new File(["movie-for-tests"], "recording.webm", { type: "video/webm" }));
  await app.user.click(within(dialog).getByRole("button", { name: "Submit report" }));
  expect(await within(dialog).findByRole("button", { name: "Open issue #17" })).toBeDefined();
  const request = app.environment("desk").requests("reports.submit")[0];
  expect(request?.params).toMatchObject({ report: { name: "Reporter", kind: "feature", level: "high", description: "Add a report shortcut.", client: { kind: "desktop" }, attachments: [{ name: "recording.webm", mediaType: "video/webm", content: "bW92aWUtZm9yLXRlc3Rz" }] } });
  expect(app.presentation.values.read().reporterName).toBe("Reporter");
  await app.user.click(within(dialog).getByRole("button", { name: "Close" }));
  const reopened = await app.remount();
  await reopened.user.click(await screen.findByRole("button", { name: "Report bug / Request feature" }));
  expect((within(await screen.findByRole("dialog", { name: "Report bug / Request feature" })).getByRole("textbox", { name: "Your name" }) as HTMLInputElement).value).toBe("Reporter");
});

it("keeps reports unavailable to a read-only client even with a GitHub account", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["forge"], scopes: ["read"], forges: { accounts: [{}] } }] });
  await app.user.click(await screen.findByRole("button", { name: "Report bug / Request feature" }));
  const dialog = await screen.findByRole("dialog", { name: "Report bug / Request feature" });
  expect(within(dialog).getByRole("button", { name: "Submit report" }).hasAttribute("disabled")).toBe(true);
  expect(app.environment("desk").requests("reports.submit")).toHaveLength(0);
});

it("marks a receipt replay as submitted instead of offering another submission", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["forge"], forges: { accounts: [{}] } }] });
  app.environment("desk").wire.answer("reports.submit", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: false } } }));
  await app.user.click(await screen.findByRole("button", { name: "Report bug / Request feature" }));
  const dialog = await screen.findByRole("dialog", { name: "Report bug / Request feature" });
  await app.user.type(within(dialog).getByRole("textbox", { name: "Your name" }), "Reporter");
  await app.user.type(within(dialog).getByRole("textbox", { name: "Description" }), "A bug.");
  await app.user.click(within(dialog).getByRole("button", { name: "Submit report" }));
  expect(await within(dialog).findByText(/This report was already submitted/)).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Submit report" }).hasAttribute("disabled")).toBe(true);
});

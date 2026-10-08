import { act, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { registry } from "@agent-harness/contracts";
import { settingsDeepLink } from "@agent-harness/client-runtime";
import { renderApp } from "../../test/harness.js";
import { routineFixture } from "../../gallery/routine-fixtures.js";

it("lists routines under both environments without a picker and keeps an unreachable list marked cached", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] }, {}, (world) => {
    for (const name of ["desk", "laptop"]) world.environment(name).wire.answer("routines.list", () => ({ result: { routines: [routineFixture(name === "desk" ? "Morning digest" : "Backup check")] } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  expect(within(pane).queryByRole("combobox", { name: "Environment" })).toBeNull();
  expect(await within(pane).findByRole("region", { name: "Morning digest" })).toBeDefined();
  const laptop = await within(pane).findByRole("region", { name: "laptop" });
  expect(await within(laptop).findByRole("region", { name: "Backup check" })).toBeDefined();
  act(() => app.environment("laptop").server.drop());
  expect(await within(laptop).findByText("Cached: what this window last saw.")).toBeDefined();
  expect(within(laptop).getByRole("button", { name: "Run now" }).hasAttribute("disabled")).toBe(true);
});

it("shows four scheduled routines and opens the pane from the overflow link", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, {}, (world) => {
    world.environment("desk").wire.answer("routines.list", () => ({ result: { routines: Array.from({ length: 6 }, (_,index) => routineFixture(`Digest ${index + 1}`, index + 1)) } }));
  });
  const strip = await screen.findByRole("region", { name: "Scheduled" });
  expect(await within(strip).findByRole("button", { name: /Digest 4/ })).toBeDefined();
  expect(within(strip).queryByRole("button", { name: /Digest 5/ })).toBeNull();
  await app.user.click(within(strip).getByRole("button", { name: "and 2 more…" }));
  expect(await screen.findByRole("region", { name: "Routines" })).toBeDefined();
});

it("validates the inline form and creates an appointment with the selected account and schedule", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Project", identity: { provider: "claude", email: "sample@example.test", organisation: null } }] }] }, {}, (world) => {
    const desk = world.environment("desk");
    desk.wire.answer("routines.list", () => ({ result: { routines: [] } }));
    desk.wire.answer("routines.create", (raw) => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { routine: { ...routineFixture(), definition: { ...routineFixture().definition, ...registry["routines.create"].params.parse(raw).definition }, state: { ...routineFixture().state, id: registry["routines.create"].params.parse(raw).routineId } } } } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  await app.user.click(within(pane).getByRole("button", { name: "New routine" }));
  const form = within(pane).getByRole("form", { name: "New routine" });
  await app.user.click(within(form).getByRole("button", { name: "Create" }));
  expect(within(form).getByRole("alert")).toBeDefined();
  expect(app.environment("desk").requests("routines.create")).toHaveLength(0);
  await app.user.type(within(form).getByRole("textbox", { name: "Name" }), "Weekly check");
  await app.user.type(within(form).getByRole("textbox", { name: "Workspace" }), "/projects/sample");
  await app.user.type(within(form).getByRole("textbox", { name: "Instructions" }), "Review the project.");
  await app.user.selectOptions(within(form).getByRole("combobox", { name: "Account" }), within(form).getByRole("option", { name: "Project" }));
  await app.user.selectOptions(within(form).getByRole("combobox", { name: "Schedule" }), "weekly");
  await app.user.selectOptions(within(form).getByRole("combobox", { name: "Weekday" }), "friday");
  await app.user.click(within(form).getByRole("button", { name: "Create" }));
  expect(await within(pane).findByRole("region", { name: "Weekly check" })).toBeDefined();
  expect(app.environment("desk").requests("routines.create")).toHaveLength(1);
  expect(app.environment("desk").requests("routines.create")[0]?.params).toMatchObject({ definition: { name: "Weekly check", account: { email: expect.any(String) }, schedule: { kind: "weekly", day: "friday", at: "09:00" }, workspace: { kind: "directory", path: "/projects/sample" }, instructions: "Review the project." } });
});

it("edits only form fields, reads history, and sends the card actions once", async () => {
  const routine = routineFixture();
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, {}, (world) => {
    const desk = world.environment("desk");
    desk.wire.answer("routines.list", () => ({ result: { routines: [routine] } }));
    for (const method of ["routines.update", "routines.disable", "routines.delete", "routines.runNow"]) desk.wire.answer(method, () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: method === "routines.delete" ? { routineId: routine.state.id } : method === "routines.runNow" ? { entryId: routine.state.id } : { routine } } }));
    desk.wire.answer("routines.history", () => ({ result: { entries: [{ kind: "skip", id: "20000000-0000-4000-8000-000000000001", trigger: "schedule", count: 1, preCheck: null, deliveries: [], dueAt: "2026-10-03T09:00:00.000Z", at: "2026-10-03T09:00:00.000Z", reason: "no-change", cannotStart: null, detail: "No project changes." }] } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  const card = await within(pane).findByRole("region", { name: "Morning digest" });
  await app.user.click(within(card).getByRole("button", { name: "Edit" }));
  const form = within(card).getByRole("form", { name: "Edit routine" });
  expect(within(form).getByRole("combobox", { name: "Where" }).hasAttribute("disabled")).toBe(true);
  await app.user.clear(within(form).getByRole("textbox", { name: "Name" }));
  await app.user.type(within(form).getByRole("textbox", { name: "Name" }), "Evening digest");
  await app.user.click(within(form).getByRole("button", { name: "Save" }));
  const update = app.environment("desk").requests("routines.update")[0]?.params;
  expect(update).toMatchObject({ routineId: routine.state.id, fields: { name: "Evening digest" } });
  expect(update?.["fields"]).not.toHaveProperty("preCheck");
  await app.user.click(within(card).getByRole("button", { name: "History" }));
  expect(await within(card).findByText("No project changes.")).toBeDefined();
  for (const label of ["Run now", "Pause", "Delete", "Confirm delete"]) await app.user.click(within(card).getByRole("button", { name: label }));
  for (const method of ["routines.update", "routines.disable", "routines.runNow", "routines.delete"]) expect(app.environment("desk").requests(method)).toHaveLength(1);
});

it("keeps model choices across accounts when the environment default is selected", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Unidentified" }, { label: "Project", identity: { provider: "claude", email: "sample@example.test", organisation: null } }], models: [
    { accountId: "account-1", models: [{ id: "small", family: "small", tier: 1, efforts: [], label: "Small" }] },
    { accountId: "account-2", models: [{ id: "large", family: "large", tier: 2, efforts: ["high"], label: "Large" }] },
  ] }] });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  await app.user.click(within(pane).getByRole("button", { name: "New routine" }));
  const form = within(pane).getByRole("form", { name: "New routine" });
  expect(await within(form).findByRole("option", { name: "Large (large)" })).toBeDefined();
  expect(within(form).getByRole("option", { name: "Small (small)" })).toBeDefined();
});

it("names models and efforts as the pickers do and stores the model id and the raw effort", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", models: [
    { accountId: "account-1", models: [{ id: "fable", family: "fable", tier: 3, efforts: ["high", "xhigh"], label: "Fable" }] },
  ] }] });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  await app.user.click(within(pane).getByRole("button", { name: "New routine" }));
  const form = within(pane).getByRole("form", { name: "New routine" });
  await app.user.type(within(form).getByRole("textbox", { name: "Name" }), "Weekly check");
  await app.user.type(within(form).getByRole("textbox", { name: "Workspace" }), "/projects/sample");
  await app.user.type(within(form).getByRole("textbox", { name: "Instructions" }), "Review the project.");
  await app.user.selectOptions(within(form).getByRole("combobox", { name: "Model" }), await within(form).findByRole("option", { name: "Fable 5.1 (fable)" }));
  expect(within(form).getByRole("option", { name: "Extra high" })).toBeDefined();
  await app.user.selectOptions(within(form).getByRole("combobox", { name: "Effort" }), within(form).getByRole("option", { name: "High" }));
  await app.user.click(within(form).getByRole("button", { name: "Create" }));
  expect(app.environment("desk").requests("routines.create")[0]?.params).toMatchObject({ definition: { model: "fable", effort: "high" } });
});

it("names a saved model and effort the environment no longer offers as the pickers do", async () => {
  const routine = routineFixture();
  routine.definition.model = "claude-opus-5-5";
  routine.definition.effort = "xhigh";
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, {}, (world) => {
    world.environment("desk").wire.answer("routines.list", () => ({ result: { routines: [routine] } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  const card = await within(pane).findByRole("region", { name: "Morning digest" });
  await app.user.click(within(card).getByRole("button", { name: "Edit" }));
  const form = within(card).getByRole("form", { name: "Edit routine" });
  expect(within(form).getByRole("option", { name: "Opus 5.5 (unavailable)" })).toBeDefined();
  expect(within(form).getByRole("option", { name: "Extra high (unavailable)" })).toBeDefined();
});

it("requires an explicit time zone when editing a saved routine", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, {}, (world) => {
    world.environment("desk").wire.answer("routines.list", () => ({ result: { routines: [routineFixture()] } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  const card = await within(pane).findByRole("region", { name: "Morning digest" });
  await app.user.click(within(card).getByRole("button", { name: "Edit" }));
  const form = within(card).getByRole("form", { name: "Edit routine" });
  await app.user.clear(within(form).getByRole("textbox", { name: "Time zone" }));
  await app.user.click(within(form).getByRole("button", { name: "Save" }));
  expect(await within(form).findByText("Choose a time zone when editing a routine.")).toBeDefined();
  expect(app.environment("desk").requests("routines.update")).toHaveLength(0);
});

it.each(["loading", "failed"])("does not assert there are no appointments while a list is %s", async (phase) => {
  let release: () => void = () => undefined;
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, {}, (world) => {
    world.environment("desk").wire.answer("routines.list", () => phase === "failed" ? { error: { code: "internal", message: "List unavailable.", data: {} } } : new Promise((resolve) => { release = () => resolve({ result: { routines: [] } }); }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  expect(await within(pane).findByText(phase === "loading" ? "Loading routines…" : "List unavailable.")).toBeDefined();
  expect(within(pane).queryByText(/^Nothing scheduled/)).toBeNull();
  act(release);
  if (phase === "loading") expect(await within(pane).findByText(/^Nothing scheduled/)).toBeDefined();
});

it("opens a firing's session and closes Settings so the result is visible", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Digest result" }] }] }, {}, (world) => {
    const desk = world.environment("desk");
    desk.wire.answer("routines.list", () => ({ result: { routines: [routineFixture()] } }));
    desk.wire.answer("routines.history", () => ({ result: { entries: [{ kind: "firing", id: "20000000-0000-4000-8000-000000000001", trigger: "schedule", count: 1, preCheck: null, deliveries: [], dueAt: "2026-10-03T09:00:00.000Z", startedAt: "2026-10-03T09:00:00.000Z", endedAt: "2026-10-03T09:00:02.000Z", sessionId: desk.sessionId(), runId: "30000000-0000-4000-8000-000000000001", requestedBy: null, targets: [], outcome: "succeeded", reason: null, text: "The project is up to date.", usage: null, durationMs: 2000, baselineAdvanced: false }] } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  const card = await within(pane).findByRole("region", { name: "Morning digest" });
  await app.user.click(within(card).getByRole("button", { name: "History" }));
  const open = await within(card).findByRole("button", { name: "Open session" });
  expect(within(card).getByText("The project is up to date.")).toBeDefined();
  await app.user.click(open);
  expect(app.shown()).toEqual({ environmentId: app.environment("desk").wire.environmentId, sessionId: app.environment("desk").sessionId() });
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
});

it.each(["Account", "Model"])("preserves saved overrides when the unavailable %s option is reselected", async (label) => {
  const routine = routineFixture();
  routine.definition.account = { provider: "claude", email: "missing@example.test", organisation: null };
  routine.definition.model = "custom-model";
  routine.definition.effort = "custom-effort";
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Project", identity: { provider: "claude", email: "sample@example.test", organisation: null } }] }] }, {}, (world) => {
    const desk = world.environment("desk");
    desk.wire.answer("routines.list", () => ({ result: { routines: [routine] } }));
    desk.wire.answer("routines.update", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { routine } } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  const card = await within(pane).findByRole("region", { name: "Morning digest" });
  await app.user.click(within(card).getByRole("button", { name: "Edit" }));
  const form = within(card).getByRole("form", { name: "Edit routine" });
  const select = within(form).getByRole("combobox", { name: label });
  await app.user.selectOptions(select, within(select).getByRole("option", { name: /unavailable/ }));
  await app.user.click(within(form).getByRole("button", { name: "Save" }));
  expect(app.environment("desk").requests("routines.update")[0]?.params).toMatchObject({ fields: { account: routine.definition.account, model: "custom-model", effort: "custom-effort" } });
});

it("shows a history fetch error without claiming the routine has never run", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, {}, (world) => {
    const desk = world.environment("desk");
    desk.wire.answer("routines.list", () => ({ result: { routines: [routineFixture()] } }));
    desk.wire.answer("routines.history", () => ({ error: { code: "internal", message: "History unavailable.", data: {} } }));
  });
  act(() => app.shell.openDeepLink(settingsDeepLink("routines.routines")));
  const pane = await screen.findByRole("region", { name: "Routines" });
  const card = await within(pane).findByRole("region", { name: "Morning digest" });
  await app.user.click(within(card).getByRole("button", { name: "History" }));
  expect(await within(card).findByText("History unavailable.")).toBeDefined();
  expect(within(card).queryByText("No runs yet.")).toBeNull();
});

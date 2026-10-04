import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { UpdateController, UpdateNotice } from "./updates.js";

it("offers an update without reloading, refuses composition, saves before activation and reloads only on request", async () => {
  const container = new EventTarget();
  const log: string[] = [];
  const controller = new UpdateController(container, async () => { log.push("saved"); }, () => { log.push("reloaded"); });
  render(<UpdateNotice controller={controller} />);
  act(() => controller.offer({ postMessage: () => { log.push("activated"); } }));
  await act(async () => { container.dispatchEvent(new Event("compositionstart")); });
  expect(screen.getByRole("button", { name: "Reload client" })).toHaveProperty("disabled", true);
  expect(await controller.reload()).toBe(false);
  expect(log).toEqual([]);
  await act(async () => { container.dispatchEvent(new Event("compositionend")); });
  await act(async () => { await controller.reload(); });
  expect(log).toEqual(["saved", "activated"]);
  container.dispatchEvent(new Event("controllerchange"));
  expect(log).toEqual(["saved", "activated", "reloaded"]);
  controller.dispose();
});

it("keeps the draft and waiting version when persistence fails", async () => {
  const controller = new UpdateController(new EventTarget(), async () => { throw new Error("storage denied"); }, vi.fn());
  const worker = { postMessage: vi.fn() };
  controller.offer(worker);
  expect(await controller.reload()).toBe(false);
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(controller.read().error).toMatch(/draft/);
  controller.dispose();
});

it("does not reload a composing tab when another tab activates the update", async () => {
  const events = new EventTarget();
  const reload = vi.fn();
  const worker = { postMessage: vi.fn() };
  const save = vi.fn(async () => undefined);
  const controller = new UpdateController(events, save, reload);
  controller.offer(worker);
  events.dispatchEvent(new Event("compositionstart"));
  events.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
  events.dispatchEvent(new Event("compositionend"));
  await controller.reload();
  expect(save).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  expect(worker.postMessage).not.toHaveBeenCalled();
  controller.dispose();
});

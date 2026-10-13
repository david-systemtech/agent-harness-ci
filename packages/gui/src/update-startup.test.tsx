import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../test/harness.js";
import { App } from "./app.js";

it("keeps update progress visible after mounting while the local environment has not answered", async () => {
  const app = await renderApp({ environments: [] });
  app.view.rerender(<App runtime={app.runtime} presentation={app.presentation} clock={app.clock} version="0.6.0" macOS={false} shell={app.shell} afterUpdate />);
  expect(screen.getByText("Updating the local environment, about a minute…").getAttribute("role")).toBe("status");
});

it("ends update progress when the local environment is ready", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
  app.view.rerender(<App runtime={app.runtime} presentation={app.presentation} clock={app.clock} version="0.6.0" macOS={false} shell={app.shell} afterUpdate />);
  expect(screen.queryByText("Updating the local environment, about a minute…")).toBeNull();
});

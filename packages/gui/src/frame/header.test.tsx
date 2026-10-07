import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderApp } from "../../test/harness.js";

/**
 * The window header's breadcrumb (look §9.1; #1790): the focused session's
 * environment, its workspace by name, and its title. A scratch workspace is
 * named scratch, never by its folder's identifier, which took the room the
 * title needs; a worktree by its repository, as the pane's caption says it.
 */

const SCRATCH_FOLDER = "/data/scratch/0199ee00-0000-4000-8000-00000000a5c1";

const script = { environments: [{ name: "desk", reach: "local" as const, sessions: [
  { title: "Reply on the paired server", workspace: { kind: "scratch" as const, path: SCRATCH_FOLDER } },
  { title: "Tidy the notes", workspace: { kind: "directory" as const, path: "/home/milo/notes" } },
  { title: "Fix the login", workspace: { kind: "worktree" as const, path: "/data/worktrees/w1", repository: "/home/milo/harness", branch: "fix/login" } },
] }] };

const header = () => document.querySelector<HTMLElement>("[data-window-header]")!;
const breadcrumb = () => Array.from(header().querySelectorAll<HTMLElement>("[data-header-workspace], [data-header-session-title]"), (part) => [part.textContent, part.title]);

afterEach(() => vi.restoreAllMocks());

it.each([
  [0, "scratch", SCRATCH_FOLDER, "Reply on the paired server"],
  [1, "notes", "/home/milo/notes", "Tidy the notes"],
  [2, "harness", "/data/worktrees/w1", "Fix the login"],
])("names session %i's workspace %s in the header, its path on hover", async (index, name, path, title) => {
  const app = await renderApp(script);
  app.open("desk", index);
  await waitFor(() => expect(breadcrumb()).toEqual([[name, path], [title, title]]));
  expect(header().textContent).toContain(`desk${name}${title}`);
  expect(header().textContent).not.toContain("0199ee00");
});

it("keeps the phone header to the session's title", async () => {
  const query = Object.assign(new EventTarget(), { matches: true, media: "(width < 640px)", onchange: null, addListener: () => undefined, removeListener: () => undefined });
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((value) => (value === query.media ? query : original(value)));
  const app = await renderApp(script);
  app.open("desk", 0);
  await waitFor(() => expect(header().querySelector("[data-header-session-title]")?.textContent).toBe("Reply on the paired server"));
  expect(header().querySelector("[data-header-workspace]")).toBeNull();
  expect(header().textContent).not.toContain("scratch");
});

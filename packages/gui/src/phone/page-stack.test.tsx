// @vitest-environment jsdom-on-node
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { sessionLink } from "../platform/browser-boot.js";
import { nextStack, pageLink, pageOfHash, SESSIONS_PAGE, stackOfEntry, usePhonePageStack, type PhonePage } from "./page-stack.js";

afterEach(() => { history.replaceState(null, "", "/"); });

const a: PhonePage = { kind: "session", session: { environmentId: "env", sessionId: "a" } };
const b: PhonePage = { kind: "session", session: { environmentId: "env", sessionId: "b" } };
const settings: PhonePage = { kind: "settings" };
const kinds = (pages: readonly PhonePage[]) => pages.map(page => page.kind === "session" ? page.session.sessionId : page.kind);
const back = async () => { await act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 20)); }); };

it("names every page by an address and reads it back", () => {
  for (const page of [SESSIONS_PAGE, a, settings, { kind: "new-session" } as const]) expect(pageOfHash(new URL(pageLink(page), location.origin).hash)).toEqual(page);
  expect(pageOfHash("#/unrecognized")).toBeUndefined();
  expect(stackOfEntry(null, new URL(sessionLink(a.kind === "session" ? a.session : { environmentId: "", sessionId: "" }), location.origin).hash)).toEqual([SESSIONS_PAGE, a]);
  expect(stackOfEntry({ phonePages: [{ kind: "bogus" }] }, "")).toEqual([SESSIONS_PAGE]);
});

it("swaps one conversation for another and deepens the stack for anything else", () => {
  expect(nextStack([SESSIONS_PAGE], a)).toEqual({ pages: [SESSIONS_PAGE, a], mode: "push" });
  expect(nextStack([SESSIONS_PAGE, a], b)).toEqual({ pages: [SESSIONS_PAGE, b], mode: "replace" });
  expect(nextStack([SESSIONS_PAGE, a], { kind: "new-session" })?.mode).toBe("replace");
  expect(nextStack([SESSIONS_PAGE, a], settings)).toEqual({ pages: [SESSIONS_PAGE, a, settings], mode: "push" });
  expect(nextStack([SESSIONS_PAGE, a], { kind: "session", session: { environmentId: "env", sessionId: "A" } })).toBeUndefined();
});

it("pushes pages as history entries and pops them with the browser's back", async () => {
  const { result } = renderHook(() => usePhonePageStack(true));
  expect(kinds(result.current.pages)).toEqual(["sessions"]);
  act(() => result.current.open(a));
  act(() => result.current.open(settings));
  expect(kinds(result.current.pages)).toEqual(["sessions", "a", "settings"]);
  expect(location.hash).toBe("#/settings");
  await back();
  await waitFor(() => expect(kinds(result.current.pages)).toEqual(["sessions", "a"]));
  expect(location.hash).toBe(new URL(pageLink(a), location.origin).hash);
  act(() => result.current.back());
  await waitFor(() => expect(kinds(result.current.pages)).toEqual(["sessions"]));
  // The root has nothing beneath it: the bar's back does nothing there.
  const length = history.length;
  act(() => result.current.back());
  expect(history.length).toBe(length);
  expect(location.hash).toBe("");
});

it("seeds the sessions entry under a handed link, so back reaches the list", async () => {
  history.replaceState(null, "", pageLink(a));
  const { result } = renderHook(() => usePhonePageStack(true));
  expect(kinds(result.current.pages)).toEqual(["sessions", "a"]);
  expect((history.state as { phonePages: unknown[] }).phonePages).toHaveLength(2);
  await back();
  await waitFor(() => expect(kinds(result.current.pages)).toEqual(["sessions"]));
});

it("restores the whole stack an entry holds when history moves to it", async () => {
  const { result } = renderHook(() => usePhonePageStack(true));
  act(() => result.current.open(a));
  act(() => result.current.open(b));
  act(() => result.current.open(settings));
  await back();
  await waitFor(() => expect(kinds(result.current.pages)).toEqual(["sessions", "b"]));
  await act(async () => { history.forward(); await new Promise(resolve => setTimeout(resolve, 20)); });
  await waitFor(() => expect(kinds(result.current.pages)).toEqual(["sessions", "b", "settings"]));
});

it("lets an open sheet take a back first and keeps the stack where it was", async () => {
  let sheet = true;
  const { result } = renderHook(() => usePhonePageStack(true, { interceptBack: () => { const open = sheet; sheet = false; return open; } }));
  act(() => result.current.open(a));
  await back();
  expect(sheet).toBe(false);
  expect(kinds(result.current.pages)).toEqual(["sessions", "a"]);
  expect(location.hash).toBe(new URL(pageLink(a), location.origin).hash);
  await back();
  await waitFor(() => expect(kinds(result.current.pages)).toEqual(["sessions"]));
});

it("leaves history alone while off (the desktop frame)", () => {
  const length = history.length;
  const { result } = renderHook(() => usePhonePageStack(false));
  expect(kinds(result.current.pages)).toEqual(["sessions"]);
  expect(history.length).toBe(length);
  expect(history.state).toBeNull();
});

it("lets the startup route name the first page over a stale entry", () => {
  history.replaceState({ phonePages: [SESSIONS_PAGE, settings] }, "", pageLink(settings));
  const { result } = renderHook(() => usePhonePageStack(true, { initial: b }));
  expect(kinds(result.current.pages)).toEqual(["sessions", "b"]);
  expect(location.hash).toBe(new URL(pageLink(b), location.origin).hash);
  // An entry whose stack no longer ends at its address is read from the address.
  expect(stackOfEntry({ phonePages: [SESSIONS_PAGE, settings] }, "")).toEqual([SESSIONS_PAGE]);
});

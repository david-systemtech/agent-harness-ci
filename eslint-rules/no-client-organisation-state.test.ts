import { rule } from "./no-client-organisation-state.js";
import { clientRuntime, ruleTester, tui } from "./rule-tester.js";

const error = (name: string, word: string) => ({
  messageId: "organisationState" as const,
  data: { name, word },
});

ruleTester.run("no-client-organisation-state", rule, {
  valid: [
    // Names that carry no session-organisation word.
    { filename: tui("app.ts"), code: `const connections = createStore([]);` },
    { filename: tui("app.ts"), code: `const preferences = { theme: "dark", fontSize: 14 };` },
    { filename: tui("app.ts"), code: `localStorage.setItem("lastEnvironment", "a");` },
    // A forbidden word outside a store, preference or storage key is not this rule's business.
    { filename: tui("app.ts"), code: `const pinned = summary.pinnedAt !== undefined;` },
    { filename: tui("app.ts"), code: `function renderTitle(title: string) { return title; }` },
    { filename: tui("app.ts"), code: `dispatch({ type: "sessions.pin", pinOrderKey: "a0" });` },
    { filename: tui("app.ts"), code: `const [renaming, setRenaming] = useState(false);` },
    // The projection cache and the outbox may hold any name.
    { filename: clientRuntime("projection-cache.ts"), code: `const pinnedSessions = createStore([]);` },
    { filename: clientRuntime("projection-cache/list.ts"), code: `localStorage.setItem("archived", "1");` },
    { filename: clientRuntime("outbox.ts"), code: `const preferences = { sessionGroups: [] };` },
    { filename: clientRuntime("outbox/queue.ts"), code: `const pendingTagsStore = createStore([]);` },
    // The presentation module passes its enumerated keys.
    {
      filename: tui("presentation.ts"),
      code: `const preferences = { collapsedHeadings: [], paneLayout: {}, sidebarWidth: 32 };`,
    },
    {
      filename: tui("presentation.ts"),
      code: `interface PresentationSettings { collapsedHeadings: string[]; paneLayout: unknown; sidebarWidth: number }`,
    },
  ],
  invalid: [
    // The three the specification names.
    {
      filename: clientRuntime("sessions.ts"),
      code: `const pinnedSessions = createStore([]);`,
      errors: [error("pinnedSessions", "pin")],
    },
    {
      filename: tui("preferences.ts"),
      code: `const preferences = { sessionGroups: [] };`,
      errors: [error("sessionGroups", "group")],
    },
    {
      filename: tui("app.ts"),
      code: `localStorage.setItem("archived", "1");`,
      errors: [error("archived", "archive")],
    },
    // Stores: by factory, by name suffix, destructured signals.
    {
      filename: tui("app.ts"),
      code: `const sessionOrder = atom([]);`,
      errors: [error("sessionOrder", "order")],
    },
    {
      filename: tui("app.ts"),
      code: `export const titles = observable(new Map());`,
      errors: [error("titles", "title")],
    },
    {
      filename: tui("app.ts"),
      code: `const snoozeStore = new Map();`,
      errors: [error("snoozeStore", "snooze")],
    },
    {
      filename: tui("app.ts"),
      code: `const [settledIds, setSettledIds] = createSignal([]);`,
      errors: [error("settledIds", "settle"), error("setSettledIds", "settle")],
    },
    {
      filename: tui("app.ts"),
      code: `class Sidebar { private readonly tagStore = new Set(); }`,
      errors: [error("tagStore", "tag")],
    },
    // Atoms: the name, and a persisted atom's storage key.
    {
      filename: tui("app.ts"),
      code: `const layout = atomWithStorage("renameDraft", "");`,
      errors: [error("renameDraft", "rename")],
    },
    // Slices and reducer keys.
    {
      filename: tui("app.ts"),
      code: `const slice = createSlice({ name: "pins", initialState: [], reducers: { archiveSession() {} } });`,
      errors: [error("pins", "pin"), error("archiveSession", "archive")],
    },
    {
      filename: tui("app.ts"),
      code: `const reducer = combineReducers({ groups: groupsReducer, connections });`,
      errors: [error("groups", "group")],
    },
    {
      filename: tui("app.ts"),
      code: `const store = configureStore({ reducer: { Tags: tagsReducer } });`,
      errors: [error("Tags", "tag")],
    },
    // Preferences and settings keys: object literals, nested, types, and storage calls.
    {
      filename: tui("app.ts"),
      code: `const defaultSettings = { sidebar: { pinnedFirst: true } } satisfies Settings;`,
      errors: [error("pinnedFirst", "pin")],
    },
    {
      filename: tui("app.ts"),
      code: `interface TuiPreferences { "session-titles": Record<string, string> }`,
      errors: [error("session-titles", "title")],
    },
    {
      filename: tui("app.ts"),
      code: `type Prefs = { lastSnoozeChoice: string };`,
      errors: [error("lastSnoozeChoice", "snooze")],
    },
    {
      filename: tui("app.ts"),
      code: `preferences.set("groupOrder", []);`,
      errors: [error("groupOrder", "order")],
    },
    {
      filename: clientRuntime("connections.ts"),
      code: `await platform.storage.put("archiveCursor", doc);`,
      errors: [error("archiveCursor", "archive")],
    },
    // Web storage and IndexedDB object stores.
    {
      filename: tui("app.ts"),
      code: `window.sessionStorage.getItem(\`pinOrder\`);`,
      errors: [error("pinOrder", "pin")],
    },
    {
      filename: tui("app.ts"),
      code: `localStorage.ARCHIVE = "1"; localStorage["tags"] = "x";`,
      errors: [error("ARCHIVE", "archive"), error("tags", "tag")],
    },
    {
      filename: tui("app.ts"),
      code: `db.createObjectStore("groups"); tx.objectStore("titles");`,
      errors: [error("groups", "group"), error("titles", "title")],
    },
    // The presentation module passes only its enumerated keys.
    {
      filename: tui("presentation.ts"),
      code: `const preferences = { collapsedHeadings: [], collapsedGroups: [] };`,
      errors: [error("collapsedGroups", "group")],
    },
    // Only the client runtime's own cache and outbox are allowlisted, not a renderer's module of that name.
    {
      filename: tui("outbox.ts"),
      code: `const pinnedSessions = createStore([]);`,
      errors: [error("pinnedSessions", "pin")],
    },
  ],
});

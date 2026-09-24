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
    { filename: clientRuntime("runtime.ts"), code: `function make() { const connections = writable([]); return derived([connections], (c) => c); }` },
    { filename: clientRuntime("runtime.ts"), code: `await platform.documents.set("environments.sequence", []);` },
    // Module-scope functions, classes and constant literals are not stores.
    { filename: tui("app.ts"), code: `export function titleOf(summary: { title: string }) { return summary.title; }` },
    { filename: tui("app.ts"), code: `export const titleOf = (summary: { title: string }) => summary.title;` },
    { filename: tui("app.ts"), code: `export class PinButton {} export const TagChip = class {};` },
    { filename: tui("app.ts"), code: `const TITLE_MAX = 80; const pinGlyph = "*"; const archivedLabel = \`Archived\`; const tagsShown = true;` },
    // Rendering code reading a summary field is not a store.
    { filename: tui("app.ts"), code: `function row(summary: { title: string }) { const title = summary.title; return title; }` },
    { filename: tui("app.ts"), code: `function row(summary: { pinnedAt?: number }) { const pinned = summary.pinnedAt !== undefined; return pinned; }` },
    { filename: tui("app.ts"), code: `function Row() { const { title, tags } = useSession(id); return [title, tags]; }` },
    { filename: tui("app.ts"), code: `function row() { const cell = { title: "t" }; return cell; }` },
    // A forbidden word outside a store, preference or storage key is not this rule's business.
    { filename: tui("app.ts"), code: `function renderTitle(title: string) { return title; }` },
    { filename: tui("app.ts"), code: `dispatch({ type: "sessions.pin", pinOrderKey: "a0" });` },
    // The projection cache and the outbox may hold any name.
    { filename: clientRuntime("projection-cache.ts"), code: `const pinnedSessions = createStore([]);` },
    { filename: clientRuntime("projection-cache/list.ts"), code: `localStorage.setItem("archived", "1");` },
    { filename: clientRuntime("outbox.ts"), code: `const preferences = { sessionGroups: [] };` },
    { filename: clientRuntime("outbox/queue.ts"), code: `const pendingTagsStore = createStore([]);` },
    // The draft's one-second debounce is the outbox's.
    { filename: clientRuntime("outbox/drafts.ts"), code: `const pendingDrafts = new Map();` },
    // The presentation module passes its enumerated keys.
    {
      filename: tui("presentation.ts"),
      code: `const preferences = { collapsedHeadings: [], paneLayout: {}, sidebarWidth: 32 };`,
    },
    {
      filename: tui("presentation.ts"),
      code: `interface PresentationSettings { collapsedHeadings: string[]; paneLayout: unknown; sidebarWidth: number }`,
    },
    // A listed key with a forbidden word passes inside the presentation module.
    {
      filename: tui("presentation.ts"),
      code: `export const presentation = { collapsedGroups: [] };`,
      options: [{ presentationKeys: ["collapsedGroups"] }],
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
    // Stores: any module-scope binding that is not a function, class or constant literal.
    {
      filename: tui("app.ts"),
      code: `export const pinnedSessions2 = new Map();`,
      errors: [error("pinnedSessions2", "pin")],
    },
    {
      filename: tui("app.ts"),
      code: `const usePinnedSessions = create(() => ({ ids: [] }));`,
      errors: [error("usePinnedSessions", "pin")],
    },
    {
      filename: tui("app.ts"),
      code: `let pinnedCount = 0;`,
      errors: [error("pinnedCount", "pin")],
    },
    {
      filename: tui("app.ts"),
      code: `const [settledIds, setSettledIds] = createSignal([]);`,
      errors: [error("settledIds", "settle"), error("setSettledIds", "settle")],
    },
    {
      filename: tui("app.ts"),
      code: `const snoozeStore = new Map();`,
      errors: [error("snoozeStore", "snooze")],
    },
    // Stores in any scope: by factory, and by name suffix on a class property.
    {
      filename: tui("app.ts"),
      code: `function make() { const sessionOrder = atom([]); return sessionOrder; }`,
      errors: [error("sessionOrder", "order")],
    },
    {
      filename: tui("app.ts"),
      code: `export const titles = observable(new Map());`,
      errors: [error("titles", "title")],
    },
    // The client runtime's own observables are stores wherever they are made.
    {
      filename: clientRuntime("connections/registry.ts"),
      code: `function make() { const pinnedSessions = writable([]); return pinnedSessions; }`,
      errors: [error("pinnedSessions", "pin")],
    },
    {
      filename: clientRuntime("projections/list.ts"),
      code: `function make(list) { const archivedRows = derived([list], (rows) => rows); return archivedRows; }`,
      errors: [error("archivedRows", "archive")],
    },
    {
      filename: tui("app.ts"),
      code: `class Sidebar { private readonly tagStore = new Set(); }`,
      errors: [error("tagStore", "tag")],
    },
    // Component state: the bindings of useState, useReducer and useRef.
    {
      filename: tui("app.ts"),
      code: `function Sidebar() { const [pinnedIds, setPinnedIds] = useState([]); }`,
      errors: [error("pinnedIds", "pin"), error("setPinnedIds", "pin")],
    },
    {
      filename: tui("app.ts"),
      code: `function Sidebar() { const [groupState, dispatch] = useReducer(reducer, []); }`,
      errors: [error("groupState", "group")],
    },
    {
      filename: tui("app.ts"),
      code: `function Sidebar() { const titleRef = React.useRef(""); }`,
      errors: [error("titleRef", "title")],
    },
    {
      filename: tui("app.ts"),
      code: `function Row() { const [renameTarget, setRenameTarget] = useState(null); }`,
      errors: [error("renameTarget", "rename"), error("setRenameTarget", "rename")],
    },
    // The composer draft is a session field: no client keeps its own.
    {
      filename: tui("app.ts"),
      code: `function Composer() { const [draft, setDraft] = useState(""); }`,
      errors: [error("draft", "draft"), error("setDraft", "draft")],
    },
    {
      filename: tui("app.ts"),
      code: `localStorage.setItem("sessionDrafts", "{}");`,
      errors: [error("sessionDrafts", "draft")],
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
      code: `function make() { return configureStore({ reducer: { Tags: tagsReducer } }); }`,
      errors: [error("Tags", "tag")],
    },
    // Keys of any module-scope object literal, nested ones included.
    {
      filename: tui("app.ts"),
      code: `const config = { sessionGroups: [] };`,
      errors: [error("sessionGroups", "group")],
    },
    {
      filename: tui("app.ts"),
      code: `export const layout = [{ sidebar: { tagFilter: "" } }];`,
      errors: [error("tagFilter", "tag")],
    },
    // Preferences and settings keys: in any scope, object literals, nested, types, and storage calls.
    {
      filename: tui("app.ts"),
      code: `function load() { const defaultSettings = { sidebar: { pinnedFirst: true } } satisfies Settings; return defaultSettings; }`,
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
    // The platform's document storage, as the client runtime names it.
    {
      filename: clientRuntime("connections/registry.ts"),
      code: `await platform.documents.set("session.pins", []);`,
      errors: [error("session.pins", "pin")],
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
    {
      filename: tui("presentation.ts"),
      code: `export const presentation = { collapsedGroups: [], pinnedFirst: true };`,
      options: [{ presentationKeys: ["collapsedGroups"] }],
      errors: [error("pinnedFirst", "pin")],
    },
    // A listed key is allowed in the presentation module only.
    {
      filename: tui("app.ts"),
      code: `export const presentation = { collapsedGroups: [] };`,
      options: [{ presentationKeys: ["collapsedGroups"] }],
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

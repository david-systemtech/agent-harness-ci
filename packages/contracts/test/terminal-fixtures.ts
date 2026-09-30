/**
 * Fixtures for the terminal, file and diff vocabulary (#124): a valid and an
 * invalid instance of every schema of theirs the export writes, and params
 * and results for every terminal, file and diff method. `fixtures.ts` folds
 * them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const id = "4d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
/** A version 1 UUID: a UUID, but not the version 4 a terminal id must be. */
const v1 = "c232ab00-9414-11ec-b3c8-9f6bdeced846";
const at = "2026-09-24T01:02:03.456Z";

const terminal = { id, owner: "session", sessionId, openedAt: at, cols: 80, rows: 24, exitCode: null, signal: null };
const exitedTerminal = { ...terminal, exitCode: 130, signal: 2 };
/** A tool terminal (#362): the Managed tools registry's, naming no session. */
const toolTerminal = { ...terminal, owner: "managed-tools", sessionId: null };
const snapshot = { terminal, scrollback: "$ ls\r\nREADME.md\r\n$ ", firstSequence: 1, lastSequence: 4, truncated: false };
const change = { runId, toolCallId: "toolu_1", tool: "Edit", status: "ok" };
const file = { path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n", changes: [change] };

export const terminalSchemaFixtures: Record<string, Fixtures> = {
  "terminals/terminal-id.json": { valid: [id], invalid: ["t-1", "", v1] },
  "terminals/terminal-columns.json": { valid: [1, 80, 1000], invalid: [0, 1001, 2.5] },
  "terminals/terminal-rows.json": { valid: [1, 24, 1000], invalid: [0, 1001, "24"] },
  "terminals/terminal-environment.json": {
    valid: [{}, { FOO: "bar", _Y2: "" }],
    invalid: [{ "1X": "a" }, { "A-B": "a" }, { A: 1 }],
  },
  "terminals/terminal-exit-cause.json": { valid: ["exited", "closed", "deleted", "failed"], invalid: ["killed", ""] },
  "terminals/terminal-info.json": {
    valid: [terminal, exitedTerminal, toolTerminal, { ...toolTerminal, exitCode: 0 }],
    invalid: [
      { ...terminal, cols: 0 },
      { ...terminal, rows: 1001 },
      { ...terminal, exitCode: undefined },
      { ...terminal, id: "t-1" },
      { ...terminal, owner: undefined },
      { ...terminal, owner: "tools" },
      { ...terminal, sessionId: null },
      { ...toolTerminal, sessionId },
      { ...toolTerminal, sessionId: undefined },
    ],
  },
  "terminals/terminal-snapshot.json": {
    valid: [
      snapshot,
      { terminal: exitedTerminal, scrollback: "", firstSequence: 0, lastSequence: 0, truncated: false },
      { ...snapshot, terminal: toolTerminal },
    ],
    invalid: [{ ...snapshot, truncated: undefined }, { ...snapshot, firstSequence: -1 }, { ...snapshot, terminal: {} }],
  },
  "terminals/events/terminal.output.json": { valid: [{ data: "hi\r\n" }, { data: "" }], invalid: [{}, { data: 1 }] },
  "terminals/events/terminal.exited.json": {
    valid: [
      { exitCode: 0, signal: null, cause: "exited" },
      { exitCode: 0, signal: 1, cause: "deleted" },
    ],
    invalid: [{ exitCode: null, signal: null, cause: "exited" }, { exitCode: 0, signal: null, cause: "gone" }],
  },
  "files/workspace-path.json": { valid: ["src/a.ts", "README.md"], invalid: ["", 3] },
  "files/files-list-source.json": { valid: ["git", "walk"], invalid: ["find", ""] },
  "diffs/session-diff-change.json": {
    valid: [change, { ...change, status: "error" }],
    invalid: [{ ...change, status: "running" }, { ...change, runId: "r-1" }, { ...change, tool: "" }],
  },
  "diffs/session-diff-file.json": {
    valid: [file, { path: "/tmp/outside.txt", diff: "", changes: [] }],
    invalid: [{ ...file, path: "" }, { ...file, changes: [{}] }, { path: "a", diff: 1, changes: [] }],
  },
};

const onTerminal = { commandId, id };
const noTerminal = [{ commandId }, { id }, { commandId, id: "t-1" }, { commandId, id: v1 }];

export const terminalMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "terminals.open": {
    params: {
      valid: [
        { commandId, id, sessionId },
        { commandId, id, sessionId, cols: 120, rows: 40, env: { EDITOR: "vi" } },
      ],
      invalid: [
        { commandId, id },
        { commandId, sessionId },
        { commandId, id, sessionId, cols: 0 },
        { commandId, id, sessionId, rows: 2.5 },
        { commandId, id, sessionId, env: { "BAD NAME": "x" } },
      ],
    },
    result: { valid: [{ terminal }], invalid: [{}, { terminal: { id } }] },
  },
  "terminals.write": {
    params: { valid: [{ ...onTerminal, data: "ls\r" }], invalid: [...noTerminal, { ...onTerminal, data: "" }, { ...onTerminal, data: 5 }] },
    result: { valid: [{ id }], invalid: [{}, { id: "t-1" }] },
  },
  "terminals.resize": {
    params: {
      valid: [{ ...onTerminal, cols: 100, rows: 30 }],
      invalid: [{ ...onTerminal, cols: 100 }, { ...onTerminal, cols: 0, rows: 30 }, { commandId, cols: 100, rows: 30 }],
    },
    result: { valid: [{ terminal }, { terminal: exitedTerminal }, { terminal: toolTerminal }], invalid: [{}, { terminal: { ...terminal, cols: -1 } }] },
  },
  "terminals.close": {
    params: { valid: [onTerminal], invalid: noTerminal },
    result: { valid: [{ id }], invalid: [{}, { id: 3 }] },
  },
  "terminals.list": {
    params: { valid: [{ sessionId }], invalid: [{}, { sessionId: "s-1" }] },
    result: { valid: [{ terminals: [] }, { terminals: [terminal, exitedTerminal] }], invalid: [{}, { terminals: [{}] }, { terminals: [{ ...terminal, owner: undefined }] }] },
  },
  "terminals.subscribe": {
    params: { valid: [{ afterSequence: 0, id }, { afterSequence: 12, id }], invalid: [{ id }, { afterSequence: 0 }, { afterSequence: -1, id }] },
    result: terminalSchemaFixtures["terminals/terminal-snapshot.json"] as Fixtures,
  },
  "files.list": {
    params: { valid: [{ sessionId }], invalid: [{}, { sessionId: v1 }] },
    result: {
      valid: [
        { files: [], truncated: false, source: "walk" },
        { files: ["README.md", "src/a.ts"], truncated: true, source: "git" },
      ],
      invalid: [{ files: [""], truncated: false, source: "git" }, { files: [], source: "git" }, { files: [], truncated: false, source: "find" }],
    },
  },
  "files.read": {
    params: { valid: [{ sessionId, path: "src/a.ts" }], invalid: [{ sessionId }, { sessionId, path: "" }, { path: "a" }] },
    result: {
      valid: [
        { path: "src/a.ts", size: 12, binary: false, truncated: false, text: "export {};\n" },
        { path: "logo.png", size: 2048, binary: true, truncated: false, text: null },
      ],
      invalid: [{ path: "a", size: -1, binary: false, truncated: false, text: "" }, { path: "a", size: 1, binary: false, truncated: false }],
    },
  },
  "diffs.workingTree": {
    params: { valid: [{ sessionId }], invalid: [{}, { sessionId: "s" }] },
    result: {
      valid: [
        { diff: "", truncated: false, repository: false },
        { diff: "diff --git a/a b/a\n", truncated: true, repository: true },
      ],
      invalid: [{ diff: "", truncated: false }, { diff: 1, truncated: false, repository: true }],
    },
  },
  "diffs.session": {
    params: { valid: [{ sessionId }], invalid: [{}, { sessionId: "s" }] },
    result: {
      valid: [
        { files: [], truncated: false },
        { files: [file], truncated: true },
      ],
      invalid: [{ files: [] }, { files: [{ path: "a" }], truncated: false }],
    },
  },
};

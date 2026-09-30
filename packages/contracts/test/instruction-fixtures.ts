/**
 * Fixtures for the standing-instruction schemas (#493): the layer, the
 * manifest and its parts, `run.instructions.composed` on the session stream,
 * the preview's parts, and `instructions.preview`'s params and result;
 * owned instructions (#505): the record and its parts, the instructions
 * stream's payloads, the notice's, the list's rows, and the commands'
 * params and results; suggested instructions (#509): the version choice,
 * the diff, the new events, and the new methods' params and results. A
 * valid and an invalid instance of each file the export writes;
 * `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const workspace = { kind: "directory", path: "/home/david/work/agent-harness" };
const digest = "a".repeat(64);

const orientationPart = { id: "orientation", version: null, characters: 42 };
const sessionPart = { id: sessionId, version: null, characters: 17 };
const userLayer = { layer: "user", characters: 42, parts: [orientationPart] };
const sessionLayer = { layer: "session", characters: 17, parts: [sessionPart] };
const alwaysOnSkill = {
  name: "grilling",
  origin: { kind: "repository", repository: "https://github.com/mattpocock/skills", path: "skills/grilling" },
  commit: "0123456789abcdef0123456789abcdef01234567",
};

/** A composition with two layers, an unread registry and nothing left out. */
export const composedManifest = {
  channel: "system-prompt-append",
  layers: [userLayer, sessionLayer],
  alwaysOn: [],
  skillSetFingerprint: null,
  unreadRegistries: ["forges"],
  leftOut: [],
};

/** A composition for an account whose adapter has no instruction channel: nothing handed, each part left out. */
const channelNoneManifest = {
  channel: "none",
  layers: [],
  alwaysOn: [],
  skillSetFingerprint: null,
  unreadRegistries: [],
  leftOut: [
    { layer: "user", id: "orientation", reason: "channel-none" },
    { layer: "session", id: sessionId, reason: "channel-none" },
  ],
};

const instructionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const commandId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const owned = { id: instructionId, title: "Coding style", body: "Prefer small modules.", origin: null, scope: "all", enabled: true, position: "n" };
const ticked = { ...owned, origin: { catalogueId: "coding.small-modules", version: 2 }, scope: ["claude-max", "claude-work"], enabled: false, position: "nb" };
const channelAccount = { accountId: "claude-max", label: "Claude Max", channel: { kind: "system-prompt-append", maxCharacters: null }, reason: null };
const noChannelAccount = {
  accountId: "local",
  label: "Local",
  channel: { kind: "none", maxCharacters: null },
  reason: "Local has no instruction channel: its runs are handed no standing instructions.",
};
const orientationRow = { enabled: true, text: "# Orientation\n\n## This environment", unreadRegistries: [], accounts: [channelAccount, noChannelAccount] };
const ownedRow = { ...owned, newerVersion: null, accounts: [channelAccount, noChannelAccount] };
const tickedRow = { ...ticked, newerVersion: 3, accounts: [] };
const diff = { catalogueId: "coding.small-modules", fromVersion: 2, toVersion: 3, from: "Prefer small modules.", to: "Prefer small, deep modules.", body: "Prefer small modules, mostly." };

const previewPart = { layer: "user", id: "orientation", title: "Orientation", text: "You are on SYSTEM-SERVER, a Linux machine." };

export const instructionSchemaFixtures: Record<string, Fixtures> = {
  "instructions/layer.json": { valid: ["user", "team-bank", "project", "session", "persona", "always-on"], invalid: ["orientation", "bank", ""] },
  "instructions/manifest-part.json": {
    valid: [orientationPart, { id: "coding-style", version: "3", characters: 0 }],
    invalid: [{ id: "", version: null, characters: 1 }, { id: "orientation", version: "", characters: 1 }, { id: "orientation", characters: 1 }, { ...orientationPart, characters: -1 }],
  },
  "instructions/manifest-layer.json": {
    valid: [userLayer, { layer: "persona", characters: 30, parts: [{ id: "reviewer", version: null, characters: 30 }] }],
    invalid: [{ layer: "user", characters: 42, parts: [] }, { layer: "user", characters: 0, parts: [orientationPart] }, { layer: "bank", characters: 42, parts: [orientationPart] }],
  },
  "instructions/always-on-skill.json": {
    valid: [alwaysOnSkill, { name: "unslop", origin: null, commit: null }],
    invalid: [
      { name: "", origin: null, commit: null },
      { name: "grilling", origin: null },
      { ...alwaysOnSkill, name: "Grilling" },
      { ...alwaysOnSkill, origin: "https://github.com/mattpocock/skills" },
      { ...alwaysOnSkill, commit: "0123abc" },
    ],
  },
  "instructions/left-out-reason.json": { valid: ["channel-none", "over-cap"], invalid: ["cap", ""] },
  "instructions/left-out.json": {
    valid: [{ layer: "user", id: "orientation", reason: "channel-none" }],
    invalid: [{ layer: "user", id: "orientation" }, { layer: "user", id: "", reason: "channel-none" }, { layer: "user", id: "orientation", reason: "disabled" }],
  },
  "instructions/manifest.json": {
    valid: [composedManifest, channelNoneManifest, { ...composedManifest, alwaysOn: [alwaysOnSkill], skillSetFingerprint: "fingerprint-for-tests", unreadRegistries: [] }],
    invalid: [
      { ...composedManifest, channel: "stdin" },
      { ...composedManifest, unreadRegistries: [""] },
      { ...composedManifest, skillSetFingerprint: "" },
      // No leftOut.
      { channel: "none", layers: [], alwaysOn: [], skillSetFingerprint: null, unreadRegistries: [] },
    ],
  },
  "instructions/preview-part.json": {
    valid: [previewPart, { layer: "session", id: sessionId, title: "Instructions for this session", text: "Answer in French." }],
    invalid: [{ ...previewPart, text: "" }, { ...previewPart, title: "" }, { layer: "user", id: "orientation", title: "Orientation" }],
  },
  "instructions/instruction-id.json": { valid: [instructionId], invalid: ["i-1", "", "0F8FAD5B-D9CB-469F-A165-70867728950"] },
  "instructions/title.json": { valid: ["Coding style", "t".repeat(120), "  Padded  "], invalid: ["", "   ", "t".repeat(121), "zero\u200bwidth"] },
  "instructions/body.json": { valid: ["", "Prefer **small** modules.", "b".repeat(20000)], invalid: ["b".repeat(20001), 7] },
  "instructions/origin.json": {
    valid: [{ catalogueId: "coding.small-modules", version: 1 }],
    invalid: [{ catalogueId: "", version: 1 }, { catalogueId: "coding.small-modules", version: 0 }, { catalogueId: "coding.small-modules" }],
  },
  "instructions/reach.json": { valid: ["all", ["claude-max"], ["claude-max", "local"]], invalid: ["some", [], [""]] },
  "instructions/owned-instruction.json": {
    valid: [owned, ticked],
    invalid: [{ ...owned, title: "" }, { ...owned, body: "b".repeat(20001) }, { ...owned, scope: [] }, { ...owned, position: "na" }, { ...owned, enabled: undefined }],
  },
  "instructions/event-type.json": {
    valid: [
      "instructions.created",
      "instructions.edited",
      "instructions.scope-set",
      "instructions.enabled-set",
      "instructions.moved",
      "instructions.version-resolved",
      "instructions.removed",
      "instructions.suggestion-dismissed",
      "instructions.suggestion-restored",
    ],
    invalid: ["instructions.updated", "instructions.dismissed", ""],
  },
  "instructions/events/instructions.version-resolved.json": {
    valid: [
      { id: instructionId, choice: "replace", version: 3, body: "Prefer small, deep modules." },
      { id: instructionId, choice: "keep", version: 3 },
    ],
    invalid: [{ id: instructionId, choice: "replace", version: 3 }, { id: instructionId, choice: "merge", version: 3 }, { id: instructionId, choice: "keep", version: 0 }],
  },
  "instructions/events/instructions.suggestion-dismissed.json": { valid: [{ catalogueId: "coding.small-modules" }], invalid: [{}, { catalogueId: "" }] },
  "instructions/events/instructions.suggestion-restored.json": { valid: [{ catalogueId: "coding.small-modules" }], invalid: [{}, { catalogueId: "" }] },
  "instructions/version-choice.json": { valid: ["replace", "keep"], invalid: ["merge", ""] },
  "instructions/diff.json": {
    valid: [diff, { ...diff, from: null }],
    invalid: [{ ...diff, to: undefined }, { ...diff, fromVersion: 0 }, { ...diff, body: "b".repeat(20001) }],
  },
  "instructions/events/instructions.created.json": { valid: [owned, ticked], invalid: [{ ...owned, id: "i-1" }, { id: instructionId }] },
  "instructions/events/instructions.edited.json": {
    valid: [{ id: instructionId, title: "Coding style", body: "" }],
    invalid: [{ id: instructionId, title: "" , body: "" }, { id: instructionId, title: "Coding style" }],
  },
  "instructions/events/instructions.scope-set.json": { valid: [{ id: instructionId, scope: "all" }, { id: instructionId, scope: ["local"] }], invalid: [{ id: instructionId, scope: [] }] },
  "instructions/events/instructions.enabled-set.json": { valid: [{ id: instructionId, enabled: false }], invalid: [{ id: instructionId, enabled: "no" }] },
  "instructions/events/instructions.moved.json": { valid: [{ id: instructionId, position: "b" }], invalid: [{ id: instructionId, position: "" }] },
  "instructions/events/instructions.removed.json": { valid: [{ id: instructionId }], invalid: [{}, { id: "i-1" }] },
  "instructions/instructions-updated.json": { valid: [{}], invalid: [null, "updated"] },
  "instructions/account.json": {
    valid: [channelAccount, noChannelAccount, { ...channelAccount, channel: { kind: "prompt", maxCharacters: 8000 } }],
    invalid: [{ ...channelAccount, reason: "" }, { ...channelAccount, channel: { kind: "stdin", maxCharacters: null } }, { accountId: "claude-max", label: "Claude Max" }],
  },
  "instructions/orientation-row.json": {
    valid: [orientationRow, { ...orientationRow, enabled: false, text: null, unreadRegistries: ["forges"], accounts: [] }],
    invalid: [{ ...orientationRow, id: instructionId }, { ...orientationRow, enabled: undefined }, { ...orientationRow, unreadRegistries: [""] }],
  },
  "instructions/owned-instruction-row.json": {
    valid: [ownedRow, tickedRow],
    invalid: [{ ...ownedRow, id: undefined }, { ...ownedRow, accounts: undefined }, { ...ownedRow, title: "" }, { ...ownedRow, newerVersion: undefined }, { ...tickedRow, newerVersion: 0 }],
  },
  "sessions/events/run.instructions.composed.json": {
    valid: [
      { runId, manifest: composedManifest, digest },
      { runId, manifest: channelNoneManifest, digest: "e".repeat(64) },
    ],
    invalid: [
      { runId, manifest: composedManifest },
      { runId, manifest: composedManifest, digest: "A".repeat(64) },
      { runId: "r-1", manifest: composedManifest, digest },
    ],
  },
};

const instructionResult = { valid: [{ instruction: owned }, { instruction: ticked }], invalid: [{}, { instruction: { ...owned, id: "i-1" } }] };

/** Params and results for `instructions.preview`, `instructions.list` and the owned instructions' commands. */
export const instructionMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "instructions.preview": {
    params: {
      valid: [{ sessionId }, { accountId: "claude-max", workspace }, { accountId: "claude-max", workspace: { kind: "scratch", path: "/tmp/agent-harness/scratch/1" } }],
      invalid: [{}, { accountId: "claude-max" }, { workspace }, { sessionId, accountId: "claude-max" }, { sessionId, workspace }, { sessionId, accountId: "claude-max", workspace }, { sessionId: "s-1" }],
    },
    result: {
      valid: [
        { parts: [previewPart], text: previewPart.text, manifest: composedManifest },
        { parts: [], text: "", manifest: channelNoneManifest },
      ],
      invalid: [{ parts: [previewPart], text: previewPart.text }, { parts: [{ ...previewPart, layer: "orientation" }], text: "", manifest: composedManifest }, {}],
    },
  },
  "instructions.list": {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [
        { orientation: orientationRow, instructions: [], dismissed: [] },
        { orientation: orientationRow, instructions: [ownedRow, { ...tickedRow, accounts: orientationRow.accounts }], dismissed: ["working.plain-answers"] },
      ],
      invalid: [
        { instructions: [ownedRow], dismissed: [] },
        { orientation: orientationRow, dismissed: [] },
        { orientation: orientationRow, instructions: [] },
        { orientation: ownedRow, instructions: [], dismissed: [] },
        { orientation: orientationRow, instructions: [orientationRow], dismissed: [] },
        { orientation: orientationRow, instructions: [], dismissed: ["Not an id"] },
      ],
    },
  },
  "instructions.create": {
    params: {
      valid: [
        { commandId, id: instructionId, title: "Coding style", body: "Prefer small modules." },
        { commandId, id: instructionId, title: "Coding style", body: "", scope: ["local"], enabled: false, position: "c" },
        { commandId, id: instructionId, catalogueId: "coding.small-modules" },
        { commandId, id: instructionId, catalogueId: "setup.about-my-setup", scope: ["local"], enabled: false },
      ],
      invalid: [
        { id: instructionId, title: "Coding style", body: "" },
        { commandId, id: instructionId, title: "Coding style" },
        { commandId, id: instructionId },
        { commandId, id: instructionId, catalogueId: "coding.small-modules", title: "Coding style", body: "" },
        { commandId, id: instructionId, catalogueId: "coding.small-modules", body: "" },
        { commandId, id: instructionId, catalogueId: "Coding.Small" },
        { commandId, id: instructionId, title: "", body: "" },
        { commandId, id: instructionId, title: "Coding style", body: "b".repeat(20001) },
        { commandId, id: instructionId, title: "Coding style", body: "", scope: [] },
      ],
    },
    result: instructionResult,
  },
  "instructions.edit": {
    params: {
      valid: [{ commandId, instructionId, title: "Coding style", body: "Prefer small modules." }],
      invalid: [{ commandId, instructionId, title: "Coding style" }, { commandId, instructionId, title: "t".repeat(121), body: "" }],
    },
    result: instructionResult,
  },
  "instructions.setScope": {
    params: { valid: [{ commandId, instructionId, scope: "all" }, { commandId, instructionId, scope: ["claude-max"] }], invalid: [{ commandId, instructionId, scope: [] }, { commandId, instructionId }] },
    result: instructionResult,
  },
  "instructions.setEnabled": {
    params: { valid: [{ commandId, instructionId, enabled: false }], invalid: [{ commandId, instructionId }, { commandId, instructionId, enabled: 1 }] },
    result: instructionResult,
  },
  "instructions.move": {
    params: { valid: [{ commandId, instructionId, position: "b" }], invalid: [{ commandId, instructionId, position: "ba" }, { commandId, instructionId }] },
    result: instructionResult,
  },
  "instructions.remove": {
    params: { valid: [{ commandId, instructionId }], invalid: [{ commandId }, { commandId, instructionId: "i-1" }] },
    result: { valid: [{ instructionId }], invalid: [{}, { instructionId: "i-1" }] },
  },
  "instructions.diff": {
    params: { valid: [{ instructionId }], invalid: [{}, { instructionId: "i-1" }] },
    result: { valid: [diff], invalid: [{}, { ...diff, toVersion: undefined }] },
  },
  "instructions.resolveVersion": {
    params: { valid: [{ commandId, instructionId, choice: "replace" }, { commandId, instructionId, choice: "keep" }], invalid: [{ commandId, instructionId }, { commandId, instructionId, choice: "merge" }] },
    result: instructionResult,
  },
  "instructions.dismissSuggestion": {
    params: { valid: [{ commandId, catalogueId: "working.plain-answers" }], invalid: [{ commandId }, { commandId, catalogueId: "plain-answers" }] },
    result: { valid: [{ catalogueId: "working.plain-answers", dismissed: true }], invalid: [{ catalogueId: "working.plain-answers" }, { dismissed: true }] },
  },
  "instructions.restoreSuggestion": {
    params: { valid: [{ commandId, catalogueId: "working.plain-answers" }], invalid: [{ commandId }, { catalogueId: "working.plain-answers" }] },
    result: { valid: [{ catalogueId: "working.plain-answers", dismissed: false }], invalid: [{}, { catalogueId: "", dismissed: false }] },
  },
  "instructions.import": {
    params: {
      valid: [
        { commandId, id: instructionId, sessionId, path: "instruction.md" },
        { commandId, id: instructionId, sessionId, path: "/data/scratch/7c9e6679/out/instruction.md", catalogueId: "coding.small-modules" },
      ],
      invalid: [{ commandId, id: instructionId, sessionId }, { commandId, id: instructionId, sessionId, path: "" }, { commandId, id: instructionId, path: "instruction.md" }, { commandId, sessionId, path: "a.md" }],
    },
    result: instructionResult,
  },
};

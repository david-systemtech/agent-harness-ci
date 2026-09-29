/**
 * Fixtures for the standing-instruction schemas (#493): the layer, the
 * manifest and its parts, `run.instructions.composed` on the session stream,
 * the preview's parts, and `instructions.preview`'s params and result. A
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

const orientationPart = { id: "orientation", version: null, characters: 40 };
const sessionPart = { id: sessionId, version: null, characters: 17 };
const userLayer = { layer: "user", characters: 40, parts: [orientationPart] };
const sessionLayer = { layer: "session", characters: 17, parts: [sessionPart] };
const alwaysOnSkill = { name: "grilling", origin: "https://github.com/mattpocock/skills skills/grilling", commit: "0123456789abcdef0123456789abcdef01234567" };

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

const previewPart = { layer: "user", id: "orientation", title: "Orientation", text: "You are on SYSTEM-SERVER, a Linux machine." };

export const instructionSchemaFixtures: Record<string, Fixtures> = {
  "instructions/layer.json": { valid: ["user", "team-bank", "project", "session", "persona", "always-on"], invalid: ["orientation", "bank", ""] },
  "instructions/manifest-part.json": {
    valid: [orientationPart, { id: "coding-style", version: "3", characters: 0 }],
    invalid: [{ id: "", version: null, characters: 1 }, { id: "orientation", version: "", characters: 1 }, { id: "orientation", characters: 1 }, { ...orientationPart, characters: -1 }],
  },
  "instructions/manifest-layer.json": {
    valid: [userLayer, { layer: "persona", characters: 30, parts: [{ id: "reviewer", version: null, characters: 30 }] }],
    invalid: [{ layer: "user", characters: 40, parts: [] }, { layer: "user", characters: 0, parts: [orientationPart] }, { layer: "bank", characters: 40, parts: [orientationPart] }],
  },
  "instructions/always-on-skill.json": {
    valid: [alwaysOnSkill, { name: "unslop", origin: null, commit: null }],
    invalid: [{ name: "", origin: null, commit: null }, { name: "grilling", origin: null }, { name: "grilling", origin: "", commit: null }],
  },
  "instructions/left-out-reason.json": { valid: ["channel-none"], invalid: ["cap", ""] },
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
      { channel: "none", layers: [], alwaysOn: [], skillSetFingerprint: null, unreadRegistries: [] },
    ],
  },
  "instructions/preview-part.json": {
    valid: [previewPart, { layer: "session", id: sessionId, title: "Instructions for this session", text: "Answer in French." }],
    invalid: [{ ...previewPart, text: "" }, { ...previewPart, title: "" }, { layer: "user", id: "orientation", title: "Orientation" }],
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

/** Params and results for `instructions.preview`. */
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
};

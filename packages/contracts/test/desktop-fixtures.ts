/**
 * Fixtures for the desktop-driver contract (#2161): a valid and an invalid
 * instance of every desktop schema the export writes (the session's desktop,
 * a run's resolution, the computer members' inputs and the driver's
 * operations). `fixtures.ts` folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const done: Fixtures = { valid: [{}], invalid: [null] };
const point = { x: 10, y: 20 };
const geometry = { displayId: "main", width: 2560, height: 1600, originX: 0, originY: 0 };
const image = { mimeType: "image/png", width: 1280, height: 800, data: "iVBORw0KGgo=" };
const click: Fixtures = { valid: [{}, { coordinate: [10, 20] }, { coordinate: [0, 0], text: "shift" }], invalid: [{ coordinate: [-1, 0] }, { coordinate: [1, 2, 3] }, { text: "" }, { x: 1 }] };
const none: Fixtures = { valid: [{}], invalid: [{ coordinate: [1, 2] }] };

const members: Record<string, Fixtures> = {
  screenshot: none,
  zoom: { valid: [{ region: [0, 0, 100, 50] }], invalid: [{}, { region: [0, 0, 100] }, { region: [-1, 0, 1, 1] }] },
  cursor_position: none,
  left_click: click,
  right_click: click,
  middle_click: click,
  double_click: click,
  triple_click: click,
  left_click_drag: { valid: [{ start_coordinate: [0, 0], coordinate: [5, 5] }, { start_coordinate: [0, 0], coordinate: [5, 5], text: "alt" }], invalid: [{ coordinate: [5, 5] }, { start_coordinate: [0], coordinate: [5, 5] }] },
  mouse_move: { valid: [{ coordinate: [3, 4] }], invalid: [{}, { coordinate: [3.5, 4] }] },
  scroll: { valid: [{ scroll_direction: "down", scroll_amount: 3 }, { scroll_direction: "left", scroll_amount: 1, coordinate: [5, 5], text: "shift" }], invalid: [{ scroll_direction: "down" }, { scroll_direction: "in", scroll_amount: 1 }, { scroll_direction: "up", scroll_amount: 0 }] },
  type: { valid: [{ text: "hello" }], invalid: [{}, { text: "" }] },
  key: { valid: [{ text: "Return" }, { text: "ctrl+a Delete", repeat: 100 }], invalid: [{ text: "" }, { text: "a", repeat: 0 }, { text: "a", repeat: 101 }] },
  hold_key: { valid: [{ text: "shift", duration: 0 }, { text: "ctrl+a", duration: 300 }], invalid: [{ text: "shift" }, { text: "shift", duration: 301 }] },
  wait: { valid: [{ duration: 0 }, { duration: 2.5 }], invalid: [{}, { duration: -1 }, { duration: 301 }] },
  left_mouse_down: none,
  left_mouse_up: none,
};

const operations: Record<string, { readonly args: Fixtures; readonly value: Fixtures }> = {
  geometry: { args: { valid: [{}], invalid: [null] }, value: { valid: [geometry, { ...geometry, originX: -1920 }], invalid: [{ ...geometry, width: 0 }, {}] } },
  capture: { args: { valid: [{ longEdge: 1280 }], invalid: [{}, { longEdge: 10 }] }, value: { valid: [{ image, geometry }], invalid: [{ image }, { image: { ...image, data: "not base64!" }, geometry }] } },
  zoom: { args: { valid: [{ region: { x0: 0, y0: 0, x1: 10, y1: 10 }, longEdge: 1280 }], invalid: [{ region: { x0: 0, y0: 0, x1: 10 }, longEdge: 1280 }, { longEdge: 1280 }] }, value: { valid: [image], invalid: [{ ...image, mimeType: "image/gif" }] } },
  cursor: { args: { valid: [{}], invalid: [null] }, value: { valid: [point], invalid: [{ x: -1, y: 0 }, {}] } },
  click: { args: { valid: [{ button: "left", count: 1, modifiers: [] }, { button: "right", count: 3, at: point, modifiers: ["shift"] }], invalid: [{ button: "left", count: 4, modifiers: [] }, { button: "back", count: 1, modifiers: [] }] }, value: done },
  drag: { args: { valid: [{ from: point, to: point, modifiers: [] }], invalid: [{ from: point, modifiers: [] }] }, value: done },
  move: { args: { valid: [{ to: point }], invalid: [{}] }, value: done },
  scroll: { args: { valid: [{ direction: "down", amount: 3, modifiers: [] }, { direction: "up", amount: 1, at: point, modifiers: ["ctrl"] }], invalid: [{ direction: "down", amount: 0, modifiers: [] }, { direction: "down", amount: 1 }] }, value: done },
  type: { args: { valid: [{ text: "hi" }], invalid: [{ text: "" }] }, value: done },
  key: { args: { valid: [{ chords: [["ctrl", "a"], ["Delete"]], repeat: 1 }], invalid: [{ chords: [], repeat: 1 }, { chords: [["a"]], repeat: 0 }] }, value: done },
  hold_key: { args: { valid: [{ keys: ["shift"], durationMs: 1000 }], invalid: [{ keys: [], durationMs: 1000 }, { keys: ["a"], durationMs: 300_001 }] }, value: done },
  mouse_down: { args: { valid: [{ button: "left" }], invalid: [{ button: "right" }] }, value: done },
  mouse_up: { args: { valid: [{ button: "left" }], invalid: [{}] }, value: done },
  release: { args: { valid: [{}], invalid: [null] }, value: done },
};

export const desktopSchemaFixtures: Record<string, Fixtures> = {
  "desktop/kind.json": { valid: ["none", "contained", "local"], invalid: ["vnc", ""] },
  "desktop/resolution-reason.json": { valid: ["selected", "unattended", "containment"], invalid: ["because", ""] },
  "desktop/session-desktop.json": { valid: [{ kind: "none" }, { kind: "local" }], invalid: [{}, { kind: "remote" }] },
  "desktop/run-desktop-resolution.json": {
    valid: [{ requested: { kind: "contained" }, desktop: { kind: "contained" }, reason: "selected", message: "The run drives the contained desktop." }],
    invalid: [{ requested: { kind: "local" }, desktop: { kind: "none" }, reason: "because", message: "x" }, { requested: { kind: "local" }, desktop: { kind: "none" }, reason: "unattended", message: "" }],
  },
  ...Object.fromEntries(Object.entries(members).map(([member, fixtures]) => [`desktop/members/${member}.json`, fixtures])),
  ...Object.fromEntries(
    Object.entries(operations).flatMap(([operation, { args, value }]) => [
      [`desktop/operations/${operation}/args.json`, args],
      [`desktop/operations/${operation}/value.json`, value],
    ]),
  ),
  "desktop/member.json": { valid: ["screenshot", "left_click_drag"], invalid: ["click", ""] },
  "desktop/point.json": { valid: [point], invalid: [{ x: 1 }] },
  "desktop/geometry.json": { valid: [geometry], invalid: [{ ...geometry, height: 0 }] },
  "desktop/image.json": { valid: [image], invalid: [{ ...image, width: 0 }] },
  "desktop/capture.json": { valid: [{ image, geometry }], invalid: [{ geometry }] },
  "desktop/command.json": {
    valid: [{ operation: "capture", args: { longEdge: 1280 } }, { operation: "release", args: {} }],
    invalid: [{ operation: "teleport", args: {} }, { operation: "click", args: {} }, { operation: "capture" }],
  },
  "desktop/refusal.json": { valid: [{ ok: false, code: "stale_geometry", reason: "The display changed; take a screenshot." }], invalid: [{ ok: false, code: "stale_geometry", reason: "" }, { ok: false, code: "nope", reason: "x" }] },
  "desktop/outcome.json": { valid: [{ ok: true, value: {} }, { ok: false, code: "failed", reason: "It failed." }], invalid: [{ ok: true }, { ok: false, reason: "x" }] },
};

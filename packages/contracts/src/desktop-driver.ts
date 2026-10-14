import { z } from "zod";
import type { Mode } from "./permissions-modes.js";

/**
 * The desktop-driver contract (computer spec, "Driver and tool surface";
 * ADR 0038; #2161): the session's desktop choice and a run's resolution of
 * it, the computer toolset's members with their inputs as the model gives
 * them, and the operations a desktop driver performs in physical display
 * pixels, each with its arguments and its value. A driver never rejects:
 * whatever goes wrong is a refusal, a sentence the model can act on.
 *
 * Its types are plain data, free of Node, DOM and Electron types, so the
 * contained driver, the live helper and a relayed client all build against it.
 */

// The session's desktop -------------------------------------------------------

/** none (no desktop), contained (the endpoint configured on the run's environment), local (this person's live desktop). */
export const DESKTOP_KINDS = ["none", "contained", "local"] as const;
export const DesktopKind = z.enum(DESKTOP_KINDS).meta({
  description: "Which desktop a session's runs may drive: none, contained (the run environment's configured contained desktop) or local (this person's live desktop).",
});
export type DesktopKind = z.infer<typeof DesktopKind>;

export const SessionDesktop = z.object({ kind: DesktopKind }).meta({ description: "The desktop a session's next run may drive; omitted, none." });
export type SessionDesktop = z.infer<typeof SessionDesktop>;

/** Why a run's desktop resolved as it did. */
export const DESKTOP_RESOLUTION_REASONS = ["selected", "none", "operator-disabled", "unavailable", "unattended", "containment", "relay-unavailable"] as const;
export const DesktopResolutionReason = z.enum(DESKTOP_RESOLUTION_REASONS).meta({
  description:
    "Why the run's desktop is what it is: selected (as requested), none (none requested), operator-disabled (desktop.contained.allowRuns is off), unavailable, unattended (a live desktop on an unattended run), containment (a live desktop under workspace containment), relay-unavailable.",
});
export type DesktopResolutionReason = z.infer<typeof DesktopResolutionReason>;

export const RunDesktopResolution = z
  .object({
    requested: SessionDesktop,
    desktop: SessionDesktop.meta({ description: "The desktop the run drives, fixed for the run; never another than requested, only none in its place." }),
    reason: DesktopResolutionReason,
    message: z.string().min(1).meta({ description: "The sentence the model and the person read about the resolution." }),
  })
  .meta({ description: "A run's desktop, resolved once at its start beside its policy." });
export type RunDesktopResolution = z.infer<typeof RunDesktopResolution>;

// The members, as the model gives them -----------------------------------------

/** The computer toolset's members, as the reference names them (read 2026-10-13); tools are `mcp__computer__<member>`. */
export const COMPUTER_MEMBERS = [
  "screenshot",
  "zoom",
  "cursor_position",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "mouse_move",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "left_mouse_down",
  "left_mouse_up",
] as const;
export const ComputerMember = z.enum(COMPUTER_MEMBERS).meta({ description: "A member of the computer toolset." });
export type ComputerMember = z.infer<typeof ComputerMember>;

/** Most seconds a `hold_key` or `wait` lasts. */
export const COMPUTER_MAX_DURATION_SECONDS = 300;
/** Most repeats of one `key`. */
export const COMPUTER_MAX_KEY_REPEAT = 100;
/** Most wheel steps of one `scroll`. */
export const COMPUTER_MAX_SCROLL_AMOUNT = 100;
const MAX_TEXT = 16_384;

const Coordinate = z.tuple([z.int().min(0), z.int().min(0)]).meta({ description: "[x, y] in full-display screenshot pixels, even after a zoom." });
const Modifiers = z.string().min(1).max(128).meta({ description: "Modifier keys held during the action, +-joined (shift, ctrl+alt)." });
const KeyCombination = z.string().min(1).max(256).meta({ description: "A key or a +-joined combination (Return, ctrl+s); for key, several separated by spaces are pressed in turn (ctrl+a Delete)." });
const Seconds = z.number().min(0).max(COMPUTER_MAX_DURATION_SECONDS);
export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
const ScrollDirection = z.enum(SCROLL_DIRECTIONS).meta({ description: "Which way the wheel turns: up, down, left or right." });
const noInput = z.strictObject({}).meta({ description: "No input." });
const clickInput = (what: string) =>
  z.strictObject({ coordinate: Coordinate.optional().meta({ description: "Where to click; absent, at the cursor." }), text: Modifiers.optional() }).meta({ description: what });

/** Each member's input, as the toolset shapes it. */
export const COMPUTER_MEMBER_INPUTS = {
  screenshot: noInput,
  zoom: z
    .strictObject({ region: z.tuple([z.int().min(0), z.int().min(0), z.int().min(0), z.int().min(0)]).meta({ description: "[x0, y0, x1, y1] in full-display screenshot pixels; x1 > x0 and y1 > y0." }) })
    .meta({ description: "zoom: a region of the display at a readable scale." }),
  cursor_position: noInput,
  left_click: clickInput("left_click: a left click."),
  right_click: clickInput("right_click: a right click."),
  middle_click: clickInput("middle_click: a middle click."),
  double_click: clickInput("double_click: two left clicks."),
  triple_click: clickInput("triple_click: three left clicks."),
  left_click_drag: z.strictObject({ start_coordinate: Coordinate, coordinate: Coordinate, text: Modifiers.optional() }).meta({ description: "left_click_drag: press at start_coordinate, move to coordinate, release." }),
  mouse_move: z.strictObject({ coordinate: Coordinate }).meta({ description: "mouse_move: move the pointer, keeping held buttons." }),
  scroll: z
    .strictObject({ scroll_direction: ScrollDirection, scroll_amount: z.int().min(1).max(COMPUTER_MAX_SCROLL_AMOUNT), coordinate: Coordinate.optional(), text: Modifiers.optional() })
    .meta({ description: "scroll: turn the wheel scroll_amount steps, at coordinate or the cursor." }),
  type: z.strictObject({ text: z.string().min(1).max(MAX_TEXT) }).meta({ description: "type: type literal text at the focus." }),
  key: z.strictObject({ text: KeyCombination, repeat: z.int().min(1).max(COMPUTER_MAX_KEY_REPEAT).optional() }).meta({ description: "key: press a key or combination, repeat times (default 1)." }),
  hold_key: z.strictObject({ text: KeyCombination, duration: Seconds }).meta({ description: "hold_key: hold a key or combination for duration seconds." }),
  wait: z.strictObject({ duration: Seconds }).meta({ description: "wait: wait duration seconds, then take a screenshot." }),
  left_mouse_down: noInput,
  left_mouse_up: noInput,
} as const satisfies { readonly [M in ComputerMember]: z.ZodType };
export type ComputerMemberInput<M extends ComputerMember> = z.infer<(typeof COMPUTER_MEMBER_INPUTS)[M]>;

// The driver's operations, in physical pixels ----------------------------------

const Pixel = z.int().min(0);
export const DesktopPoint = z.object({ x: Pixel, y: Pixel }).meta({ description: "A point on the display, in physical pixels from its top-left." });
export type DesktopPoint = z.infer<typeof DesktopPoint>;

export const DisplayGeometry = z
  .object({
    displayId: z.string().min(1).max(256).meta({ description: "The display the driver captures and drives." }),
    width: z.int().min(1),
    height: z.int().min(1),
    originX: z.int().meta({ description: "The display's left edge on the virtual desktop." }),
    originY: z.int().meta({ description: "The display's top edge on the virtual desktop." }),
  })
  .meta({ description: "The captured display's physical size and its place on the virtual desktop; a change invalidates the screenshot mapping." });
export type DisplayGeometry = z.infer<typeof DisplayGeometry>;

export const DesktopImage = z
  .object({
    mimeType: z.enum(["image/png", "image/jpeg"]).meta({ description: "The image's type." }),
    width: z.int().min(1),
    height: z.int().min(1),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .meta({ description: "The image, base64." }),
  })
  .meta({ description: "An image of the display or a region, with its pixel size." });
export type DesktopImage = z.infer<typeof DesktopImage>;

const LongEdge = z.int().min(64).max(8192).meta({ description: "The longest edge the image may have, in pixels; the aspect ratio is kept." });
export const DesktopCapture = z
  .object({ image: DesktopImage, geometry: DisplayGeometry })
  .meta({ description: "A full-display screenshot, downsampled to the long edge, and the display it was taken of: image pixels per physical pixel is the mapping's scale." });
export type DesktopCapture = z.infer<typeof DesktopCapture>;

export const DESKTOP_BUTTONS = ["left", "right", "middle"] as const;
const Button = z.enum(DESKTOP_BUTTONS).meta({ description: "Which mouse button: left, right or middle." });
const Keys = z.array(z.string().min(1).max(64)).min(1).max(8).meta({ description: "The keys of one combination, pressed in order and released in reverse." });
const ModifierKeys = z.array(z.string().min(1).max(64)).max(8).meta({ description: "Modifier keys held during the action." });
const Ack = z.object({}).meta({ description: "Done." });

/** What each operation asks for and answers. */
export const DESKTOP_OPERATION_SCHEMAS = {
  geometry: { args: z.object({}), value: DisplayGeometry },
  capture: { args: z.object({ longEdge: LongEdge }), value: DesktopCapture },
  zoom: {
    args: z.object({ region: z.object({ x0: Pixel, y0: Pixel, x1: Pixel, y1: Pixel }).meta({ description: "A physical region of the display, x1 > x0 and y1 > y0." }), longEdge: LongEdge }),
    value: DesktopImage,
  },
  cursor: { args: z.object({}), value: DesktopPoint },
  click: { args: z.object({ button: Button, count: z.int().min(1).max(3), at: DesktopPoint.optional(), modifiers: ModifierKeys }), value: Ack },
  drag: { args: z.object({ from: DesktopPoint, to: DesktopPoint, modifiers: ModifierKeys }), value: Ack },
  move: { args: z.object({ to: DesktopPoint }), value: Ack },
  scroll: { args: z.object({ direction: ScrollDirection, amount: z.int().min(1).max(COMPUTER_MAX_SCROLL_AMOUNT), at: DesktopPoint.optional(), modifiers: ModifierKeys }), value: Ack },
  type: { args: z.object({ text: z.string().min(1).max(MAX_TEXT) }), value: Ack },
  key: { args: z.object({ chords: z.array(Keys).min(1).max(16).meta({ description: "Combinations pressed in turn." }), repeat: z.int().min(1).max(COMPUTER_MAX_KEY_REPEAT) }), value: Ack },
  hold_key: { args: z.object({ keys: Keys, durationMs: z.int().min(0).max(COMPUTER_MAX_DURATION_SECONDS * 1_000) }), value: Ack },
  mouse_down: { args: z.object({ button: z.literal("left") }), value: Ack },
  mouse_up: { args: z.object({ button: z.literal("left") }), value: Ack },
  release: { args: z.object({}).meta({ description: "Release every held button and key." }), value: Ack },
} as const;
export const DESKTOP_OPERATIONS = Object.keys(DESKTOP_OPERATION_SCHEMAS) as readonly DesktopOperation[];
export type DesktopOperation = keyof typeof DESKTOP_OPERATION_SCHEMAS;
export type DesktopArgs<O extends DesktopOperation> = z.infer<(typeof DESKTOP_OPERATION_SCHEMAS)[O]["args"]>;
export type DesktopValue<O extends DesktopOperation> = z.infer<(typeof DESKTOP_OPERATION_SCHEMAS)[O]["value"]>;

export const DesktopCommand = z
  .discriminatedUnion(
    "operation",
    (Object.keys(DESKTOP_OPERATION_SCHEMAS) as DesktopOperation[]).map((operation) => z.object({ operation: z.literal(operation), args: DESKTOP_OPERATION_SCHEMAS[operation].args })) as unknown as [
      z.ZodObject<{ operation: z.ZodLiteral<DesktopOperation>; args: z.ZodType }>,
      ...z.ZodObject<{ operation: z.ZodLiteral<DesktopOperation>; args: z.ZodType }>[],
    ],
  )
  .meta({ description: "One desktop operation and its arguments." });
export type DesktopCommand = { readonly [O in DesktopOperation]: { readonly operation: O; readonly args: DesktopArgs<O> } }[DesktopOperation];
export type DesktopCommandOf<O extends DesktopOperation> = { readonly operation: O; readonly args: DesktopArgs<O> };

export const DESKTOP_REFUSAL_CODES = ["unavailable", "unsupported", "out_of_bounds", "stale_geometry", "locked", "cancelled", "failed"] as const;
export const DesktopRefusal = z
  .object({
    ok: z.literal(false),
    code: z.enum(DESKTOP_REFUSAL_CODES).meta({
      description:
        "Why: unavailable (no such desktop here), unsupported (this driver cannot), out_of_bounds (a coordinate outside the screenshot), stale_geometry (the display changed since the last screenshot), locked (the desktop is locked), cancelled, failed.",
    }),
    reason: z.string().min(1).meta({ description: "The sentence the model reads: what went wrong and what it can do instead." }),
  })
  .meta({ description: "An operation that did not happen: a sentence the model can act on, never an exception." });
export type DesktopRefusal = z.infer<typeof DesktopRefusal>;

export const DesktopOutcome = z
  .union([z.object({ ok: z.literal(true), value: z.json() }), DesktopRefusal])
  .meta({ description: "An operation's answer on a wire that does not know the operation: its value, or a refusal." });
export type DesktopOutcome = z.infer<typeof DesktopOutcome>;
export type DesktopResult<O extends DesktopOperation> = { readonly ok: true; readonly value: DesktopValue<O> } | DesktopRefusal;

/** What a driver can do; a member needing what it cannot is reported unsupported, never faked. */
export const DESKTOP_ABILITIES = ["capture", "zoom", "pointer", "keyboard", "hold", "buttons"] as const;
export type DesktopAbility = (typeof DESKTOP_ABILITIES)[number];

/** The drivers: contained (#2162's VNC client), local (#2164/#2165's helper, or #2166's relay) and scripted (tests). */
export const DESKTOP_DRIVER_KINDS = ["contained", "local", "scripted"] as const;
export type DesktopDriverKind = (typeof DESKTOP_DRIVER_KINDS)[number];

/**
 * One desktop's hands: an operation in, its value or a refusal out. It never
 * rejects. Operations on one desktop are performed one at a time, except
 * `release`, which may arrive during a `hold_key`: it ends the hold early
 * and lets go of every held button and key (a cancelled call, Stop).
 */
export interface DesktopDriver {
  readonly kind: DesktopDriverKind;
  readonly abilities: readonly DesktopAbility[];
  perform<O extends DesktopOperation>(command: DesktopCommandOf<O>): Promise<DesktopResult<O>>;
}

// Members, operations and the run's mode ----------------------------------------

/** What a member does to the desktop: observe (screenshot, zoom, cursor, wait), pointer, or keyboard. */
export const COMPUTER_MEMBER_CATEGORIES = ["observe", "pointer", "keyboard"] as const;
export type ComputerMemberCategory = (typeof COMPUTER_MEMBER_CATEGORIES)[number];

export const COMPUTER_MEMBER_CATEGORY: { readonly [M in ComputerMember]: ComputerMemberCategory } = {
  screenshot: "observe",
  zoom: "observe",
  cursor_position: "observe",
  wait: "observe",
  left_click: "pointer",
  right_click: "pointer",
  middle_click: "pointer",
  double_click: "pointer",
  triple_click: "pointer",
  left_click_drag: "pointer",
  mouse_move: "pointer",
  scroll: "pointer",
  left_mouse_down: "pointer",
  left_mouse_up: "pointer",
  type: "keyboard",
  key: "keyboard",
  hold_key: "keyboard",
};

/** The ability each member needs of its driver. */
export const COMPUTER_MEMBER_ABILITY: { readonly [M in ComputerMember]: DesktopAbility } = {
  screenshot: "capture",
  zoom: "zoom",
  cursor_position: "pointer",
  wait: "capture",
  left_click: "pointer",
  right_click: "pointer",
  middle_click: "pointer",
  double_click: "pointer",
  triple_click: "pointer",
  left_click_drag: "pointer",
  mouse_move: "pointer",
  scroll: "pointer",
  left_mouse_down: "buttons",
  left_mouse_up: "buttons",
  type: "keyboard",
  key: "keyboard",
  hold_key: "hold",
};

/**
 * What the run's effective mode makes of a member, after hard refusals and
 * denylist checks (computer spec, "Modes, denylist and containment"): allow
 * (proceeds without a mode prompt), ask (through the permission broker),
 * review (the account's reviewer and rules decide) or deny. A denylist match
 * still asks the person in every mode; that is the gate's, not this table's.
 */
export type ComputerModeRuling = "allow" | "ask" | "review" | "deny";

export const computerModeRuling = (mode: Mode, member: ComputerMember): ComputerModeRuling => {
  const category = COMPUTER_MEMBER_CATEGORY[member];
  switch (mode) {
    case "plan":
      return category === "observe" ? "allow" : "deny";
    case "acceptEdits":
      return category === "keyboard" ? "ask" : "allow";
    case "auto":
      return category === "observe" ? "allow" : "review";
    case "bypassPermissions":
      return "allow";
  }
};

/** A +-joined combination's keys (ctrl+shift+t is ctrl, shift, t); a lone + is the plus key, and a trailing one (ctrl++) too. */
export const keyCombination = (text: string): string[] => {
  const trimmed = text.trim();
  if (trimmed === "+") return ["+"];
  const keys = trimmed.split("+").filter((key) => key !== "");
  return trimmed.endsWith("++") ? [...keys, "+"] : keys;
};

/** A key member's combinations, separated by spaces and pressed in turn (ctrl+a Delete). */
export const keySequence = (text: string): string[][] =>
  text
    .trim()
    .split(/\s+/)
    .filter((chord) => chord !== "")
    .map(keyCombination);

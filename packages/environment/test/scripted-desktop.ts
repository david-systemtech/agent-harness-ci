import { DESKTOP_ABILITIES, type DesktopAbility, type DesktopCommand, type DesktopCommandOf, type DesktopDriver, type DesktopImage, type DesktopOperation, type DesktopPoint, type DesktopRefusal, type DesktopResult, type DisplayGeometry } from "@agent-harness/contracts";

/**
 * A scripted desktop for tests (computer spec, "Implementation plan and
 * proof"; #2161): a fake display that answers screenshots with a scripted
 * image, keeps a pointer, and records every input in an event log. A test
 * changes the display, scripts a refusal for an operation, or takes away
 * abilities to see what the tool server makes of it. Nothing here touches a
 * real display.
 */

export interface ScriptedDesktopOptions {
  readonly geometry?: DisplayGeometry;
  /** The screenshot answered at `capture`, already at the long edge; absent, a 1280×800 one for a 2560×1600 display. */
  readonly screen?: DesktopImage;
  /** The image answered at `zoom`; absent, the screen. */
  readonly zoomed?: DesktopImage;
  readonly abilities?: readonly DesktopAbility[];
}

export interface ScriptedDesktop extends DesktopDriver {
  /** Every operation performed, in order, with its arguments. */
  readonly log: DesktopCommand[];
  /** Where the pointer is, in physical pixels. */
  readonly pointer: DesktopPoint;
  /** Changes the display, as a resolution or monitor change would. */
  setGeometry(geometry: DisplayGeometry): void;
  /** Answers the next `operation` with this refusal (once). */
  refuseNext(operation: DesktopOperation, refusal: Omit<DesktopRefusal, "ok">): void;
  /** Holds `hold_key` until `release` arrives, as a long hold would. */
  holdUntilReleased(): void;
}

export const SCRIPTED_GEOMETRY: DisplayGeometry = { displayId: "scripted", width: 2560, height: 1600, originX: 0, originY: 0 };
export const SCRIPTED_SCREEN: DesktopImage = { mimeType: "image/png", width: 1280, height: 800, data: Buffer.from("scripted screen").toString("base64") };

export const scriptedDesktop = (options: ScriptedDesktopOptions = {}): ScriptedDesktop => {
  const log: DesktopCommand[] = [];
  let geometry = options.geometry ?? SCRIPTED_GEOMETRY;
  let pointer: DesktopPoint = { x: 0, y: 0 };
  const refusals = new Map<DesktopOperation, Omit<DesktopRefusal, "ok">>();
  let holding = false;
  let releaseHold: (() => void) | null = null;
  const screen = options.screen ?? SCRIPTED_SCREEN;

  const answer = <O extends DesktopOperation>(command: DesktopCommandOf<O>): DesktopResult<DesktopOperation> => {
    switch (command.operation) {
      case "geometry":
        return { ok: true, value: geometry };
      case "capture":
        return { ok: true, value: { image: screen, geometry } };
      case "zoom":
        return { ok: true, value: options.zoomed ?? screen };
      case "cursor":
        return { ok: true, value: pointer };
      default:
        return { ok: true, value: {} };
    }
  };

  const driver: ScriptedDesktop = {
    kind: "scripted",
    abilities: options.abilities ?? DESKTOP_ABILITIES,
    log,
    get pointer() {
      return pointer;
    },
    setGeometry: (next) => {
      geometry = next;
    },
    refuseNext: (operation, refusal) => {
      refusals.set(operation, refusal);
    },
    holdUntilReleased: () => {
      holding = true;
    },
    perform: async <O extends DesktopOperation>(command: DesktopCommandOf<O>): Promise<DesktopResult<O>> => {
      log.push(command as DesktopCommand);
      const refused = refusals.get(command.operation);
      if (refused !== undefined) {
        refusals.delete(command.operation);
        return { ok: false, ...refused };
      }
      const known = command as DesktopCommand;
      if (known.operation === "release") {
        releaseHold?.();
        releaseHold = null;
      }
      if (known.operation === "hold_key" && holding) await new Promise<void>((resolve) => (releaseHold = resolve));
      if ((known.operation === "click" || known.operation === "scroll") && known.args.at !== undefined) pointer = known.args.at;
      if (known.operation === "move") pointer = known.args.to;
      if (known.operation === "drag") pointer = known.args.to;
      return answer(command) as DesktopResult<O>;
    },
  };
  return driver;
};

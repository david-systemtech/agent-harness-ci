import type { FakeShell } from "@agent-harness/client-runtime/testing";
import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { LadderName } from "@agent-harness/theme";
import type { ComponentType } from "react";
import type { BrowserRoute } from "../src/platform/browser-boot.js";
import type { PresentationValues } from "../src/presentation.js";

/** Every matching element must have these dimensions; missing selectors fail capture. */
export interface SceneGeometry {
  readonly selector: string;
  /** Apply this measurement only at the named capture viewport width. */
  readonly viewport?: number;
  /** Ignore controls that have no rendered box or are hidden by visibility. */
  readonly renderedOnly?: boolean;
  /** Require the whole element inside this scrollport and the capture viewport. */
  readonly visibleWithin?: string;
  /** Require wrapping content to fit its own box, not only the enclosing control. */
  readonly contentFits?: boolean;
  /** Require this row to start after every rendered element matching the selector. */
  readonly below?: string;
  /** Keep the top of a surface below a scene's simulated status bar or notch. */
  readonly minimumTop?: number;
  /** The control must receive a pointer at its centre, including through clipping ancestors. */
  readonly hitTestable?: boolean;
  /** No word in the element's text may wrap mid-word onto another line; wraps between words and at hyphens are fine. */
  readonly wordsIntact?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly paddingLeft?: number;
  readonly paddingTop?: number;
  readonly fontSize?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly tolerance?: number;
  /** Content may grow beyond a scene’s viewport-height floor. */
  readonly minimumHeight?: number;
  readonly minimumWidth?: number;
}

export interface SceneViewport {
  readonly width: number;
  readonly height: number;
}

/** A scene file exports a default component or an app script, plus optional geometry. */
export interface SceneModule {
  /** Web scenes use the actual browser platform and never receive a desktop shell. */
  readonly platform?: "web";
  readonly route?: (world: ScriptedWorld) => BrowserRoute;
  readonly arrangeWeb?: (world: ScriptedWorld) => void;
  readonly default?: ComponentType<{ readonly ladder: LadderName }>;
  readonly script?: Script;
  /** Arrange readings or run events on each fresh world before the app mounts. */
  readonly arrange?: (world: ScriptedWorld, shell: FakeShell) => void;
  readonly presentation?: Partial<PresentationValues>;
  /** Run scene steps once the window and its event handlers have mounted. */
  readonly activate?: () => void | (() => void);
  readonly geometry?: readonly SceneGeometry[] | ((viewport: SceneViewport) => readonly SceneGeometry[]);
  /** Wait for asynchronously drawn pane content before measuring or capturing it. */
  readonly readySelector?: string;
}
export type SceneRegistry = Readonly<Record<string, SceneModule>>;

export function discoverScenes(modules: Readonly<Record<string, SceneModule>>): SceneRegistry {
  const registry = new Map<string, SceneModule>();
  for (const [path, scene] of Object.entries(modules)) {
    const name = sceneName(path);
    if (registry.has(name)) throw new Error(`Duplicate gallery scene: ${name}`);
    if (scene.default === undefined && scene.script === undefined) throw new Error(`Gallery scene ${name} exports neither a component nor a script.`);
    if (name.startsWith("phone-") && scene.platform !== "web") throw new Error(`Phone gallery scene ${name} must declare platform: web.`);
    if (scene.platform === "web" && scene.arrange !== undefined) throw new Error(`Web gallery scene ${name} must use arrangeWeb without a desktop shell.`);
    registry.set(name, scene);
  }
  return Object.fromEntries(registry);
}

/** Shared with the Node capture manifest, which never imports renderer components. */
export function sceneName(path: string): string {
  const name = path.split("/").at(-1)?.replace(/\.tsx$/, "") ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid gallery scene file: ${path}`);
  return name;
}

import type { AriaNodeJSON } from "./vendor/aria-types.js";

/**
 * Stitching (browser spec, "One page driver for three browsers": the
 * driver stitches its frames' results into one): every frame's tree under
 * the iframe that holds it in its parent's tree, so the page reads as one
 * tree in document order, same-site frames and cross-site frames' child
 * targets alike.
 */

/** One frame's tree, and where it sits: its parent frame, and its owner iframe's place among the frame owners the parent's snapshot met. */
export interface FrameTree {
  readonly frameId: string;
  readonly parentId?: string;
  /** Absent when the parent's snapshot did not meet the frame's owner (it is hidden, or the parent was not read). */
  readonly ownerKey?: number;
  readonly nodes: readonly AriaNodeJSON[];
}

/** The page as one tree from its frames' trees: each frame's under its owner iframe; a frame whose owner the tree does not show is left out. */
export const stitchFrames = (topFrameId: string, frames: readonly FrameTree[]): AriaNodeJSON[] => {
  const inFrame = (frame: FrameTree): AriaNodeJSON[] => {
    const owned = new Map<number, FrameTree>();
    for (const child of frames) if (child.parentId === frame.frameId && child.ownerKey !== undefined) owned.set(child.ownerKey, child);
    const place = (node: AriaNodeJSON | string): AriaNodeJSON | string => {
      if (typeof node === "string") return node;
      const child = node.frame === undefined ? undefined : owned.get(node.frame);
      if (child) return { ...node, children: inFrame(child) };
      return node.children === undefined ? node : { ...node, children: node.children.map(place) };
    };
    return frame.nodes.map((node) => place(node) as AriaNodeJSON);
  };
  const top = frames.find((frame) => frame.frameId === topFrameId);
  return top ? inFrame(top) : [];
};

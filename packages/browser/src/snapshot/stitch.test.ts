import { describe, expect, it } from "vitest";
import { stitchFrames } from "./stitch.js";

/**
 * Stitching (browser spec, "The tools": frames stitched): each frame's tree
 * goes under the iframe that holds it in its parent's tree, so the page
 * reads as one tree in document order, however the frames were read.
 */

describe("stitchFrames", () => {
  it("puts each frame's tree under its owner iframe, frames inside frames included, whatever order the frames come in", () => {
    const stitched = stitchFrames("top", [
      { frameId: "payment", parentId: "top", ownerKey: 1, nodes: [{ role: "paragraph", ref: "f2e1", text: "Card accepted." }, { role: "iframe", ref: "f2e2", frame: 0 }] },
      {
        frameId: "top",
        nodes: [
          { role: "heading", name: "Checkout", level: 1, ref: "e1" },
          { role: "iframe", ref: "e2", frame: 0 },
          { role: "iframe", ref: "e3", frame: 1 },
        ],
      },
      { frameId: "card-field", parentId: "payment", ownerKey: 0, nodes: [{ role: "textbox", name: "Card number", ref: "f3e1" }] },
      { frameId: "reviews", parentId: "top", ownerKey: 0, nodes: [{ role: "paragraph", ref: "f1e1", text: "Five stars." }] },
    ]);
    expect(stitched).toEqual([
      { role: "heading", name: "Checkout", level: 1, ref: "e1" },
      { role: "iframe", ref: "e2", frame: 0, children: [{ role: "paragraph", ref: "f1e1", text: "Five stars." }] },
      {
        role: "iframe",
        ref: "e3",
        frame: 1,
        children: [
          { role: "paragraph", ref: "f2e1", text: "Card accepted." },
          { role: "iframe", ref: "f2e2", frame: 0, children: [{ role: "textbox", name: "Card number", ref: "f3e1" }] },
        ],
      },
    ]);
  });

  it("finds an owner iframe anywhere in its parent's tree, inside other elements and shadow content alike", () => {
    expect(
      stitchFrames("top", [
        { frameId: "top", nodes: [{ role: "main", children: [{ role: "generic", children: ["Weather", { role: "iframe", frame: 0 }] }] }] },
        { frameId: "forecast", parentId: "top", ownerKey: 0, nodes: [{ role: "paragraph", text: "Rain." }] },
      ]),
    ).toEqual([{ role: "main", children: [{ role: "generic", children: ["Weather", { role: "iframe", frame: 0, children: [{ role: "paragraph", text: "Rain." }] }] }] }]);
  });

  it("leaves out a frame whose owner its parent's tree does not show, and an iframe whose frame was not read stays empty", () => {
    expect(
      stitchFrames("top", [
        { frameId: "top", nodes: [{ role: "iframe", ref: "e1", frame: 0 }] },
        { frameId: "hidden-ad", parentId: "top", ownerKey: 3, nodes: [{ role: "link", name: "Buy now", ref: "f1e1" }] },
        { frameId: "unplaced", parentId: "top", nodes: [{ role: "link", name: "Elsewhere", ref: "f2e1" }] },
      ]),
    ).toEqual([{ role: "iframe", ref: "e1", frame: 0 }]);
  });

  it("answers no tree when the top frame was not read", () => {
    expect(stitchFrames("top", [{ frameId: "reviews", parentId: "top", ownerKey: 0, nodes: [{ role: "paragraph", text: "Five stars." }] }])).toEqual([]);
  });
});

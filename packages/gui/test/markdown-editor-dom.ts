/** jsdom has no hit testing or Range geometry. Rich editing uses an empty layout, like the rest of the harness. */
if (typeof document !== "undefined") {
  document.elementFromPoint = () => null;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
}

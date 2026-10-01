/**
 * Ref names (browser spec, "The tools"): what a page's snapshots have given,
 * frame by frame, as the driver keeps it. The in-page snapshot names each
 * element it can act on `<prefix>e<n>`; the top frame's prefix is empty and
 * each other frame's `f1`, `f2` and so on, in the order the page's
 * snapshots first met it, never given twice, so a ref names its frame. Each
 * frame's next snapshot numbers past the highest ref the frame has given,
 * whichever document it gave it in, so a ref an older snapshot gave never
 * names another element.
 */

/** A ref as the in-page snapshot writes it: an optional frame prefix, then `e` and a number. */
const REF = /^(f\d+)?e\d+$/;

export class RefBook {
  private readonly prefixes = new Map<string, string>();
  private readonly frames = new Map<string, string>();
  private readonly highest = new Map<string, number>();
  private framesMet = 0;

  /** The prefix of the frame `frameId`'s refs: none for the page's top frame. */
  prefixOf(frameId: string, top: boolean): string {
    let prefix = top ? "" : this.prefixes.get(frameId);
    if (prefix === undefined) {
      prefix = `f${++this.framesMet}`;
      this.prefixes.set(frameId, prefix);
    }
    this.frames.set(prefix, frameId);
    return prefix;
  }

  /** The frame a ref is from, by its prefix; none for a string no snapshot of this page could have given. */
  frameOf(ref: string): string | undefined {
    const match = REF.exec(ref);
    return match ? this.frames.get(match[1] ?? "") : undefined;
  }

  /** The least number the frame's next snapshot may give a new ref. */
  firstRefOf(frameId: string): number {
    return (this.highest.get(frameId) ?? 0) + 1;
  }

  /** Notes the highest ref number a snapshot of the frame has given. */
  gave(frameId: string, lastRef: number): void {
    this.highest.set(frameId, Math.max(lastRef, this.highest.get(frameId) ?? 0));
  }
}

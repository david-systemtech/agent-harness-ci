/** Hosted layout proof. The scene keeps a tall layout viewport and changes only VisualViewport. */
export function verifyKeyboardDock(height: number, offset: number, latest = true): void {
  const frame = document.querySelector<HTMLElement>("[data-web-client]")!;
  const dock = document.querySelector<HTMLElement>("[data-composer-column]")!;
  const transcript = document.querySelector<HTMLElement>('[aria-label="Transcript"]')!;
  const header = document.querySelector<HTMLElement>("[data-window-header]")!;
  const field = document.querySelector<HTMLElement>('[aria-label="Message"]')!;
  const bounds = frame.getBoundingClientRect();
  const dockBounds = dock.getBoundingClientRect();
  const near = (actual: number, expected: number, name: string) => {
    if (Math.abs(actual - expected) > 1) throw new Error(`Keyboard dock ${name}: ${actual}, expected ${expected}`);
  };
  near(bounds.top, offset, "top"); near(bounds.height, height, "height");
  near(dock.getBoundingClientRect().bottom, offset + height - parseFloat(getComputedStyle(frame).paddingBottom), "bottom");
  if (header.getBoundingClientRect().top < offset || header.getBoundingClientRect().bottom > offset + height) throw new Error("Keyboard clipped the header");
  const visible = transcript.getBoundingClientRect();
  if (visible.height < 3 * parseFloat(getComputedStyle(transcript).lineHeight)) throw new Error("Keyboard leaves fewer than three readable transcript lines");
  for (const element of [field, ...frame.querySelectorAll<HTMLElement>('[aria-label="Send"], [aria-label="Stop"]')]) {
    const rect = element.getBoundingClientRect();
    if (rect.top < offset || rect.bottom > offset + height) throw new Error(`Keyboard hides ${element.getAttribute("aria-label")}: ${JSON.stringify({
      height, offset, control: rect.toJSON(), dock: dockBounds.toJSON(), dockScrollTop: dock.scrollTop,
      parked: !!frame.querySelector('[aria-label="Parked prompt"]'), notices: !!frame.querySelector('[aria-label="Notifications"]'),
    })}`);
    if (rect.top < dockBounds.top || rect.bottom > dockBounds.bottom + 1) throw new Error(`Keyboard clips ${element.getAttribute("aria-label")} inside the dock`);
  }
  if (latest) {
    const reply = Array.from(transcript.querySelectorAll('[aria-label="Reply"]')).at(-1);
    if (reply) {
      const texts = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT);
      let last: Text | undefined;
      while (texts.nextNode()) if (texts.currentNode.textContent?.trim()) last = texts.currentNode as Text;
      if (last) {
        const line = document.createRange(); line.setStart(last, Math.max(0, last.length - 1)); line.setEnd(last, last.length);
        const rect = line.getBoundingClientRect();
        if (rect.top < visible.top || rect.bottom > visible.bottom) throw new Error("Keyboard clips the latest reply line");
      }
    }
  }
  if (latest && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 1) throw new Error("Keyboard lost latest transcript line");
  if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) throw new Error("Keyboard moved the document");
}


/** The filled dock must leave three complete text line boxes, excluding column padding. */
export function verifyReadableReplyLines(): void {
  const transcript = document.querySelector<HTMLElement>('[aria-label="Transcript"]')!;
  const reply = Array.from(transcript.querySelectorAll('[aria-label="Reply"]')).at(-1)!;
  const paragraph = reply.querySelector<HTMLElement>(".caret, .markdown > p:last-child")!;
  const bounds = paragraph.getBoundingClientRect(), visible = transcript.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(paragraph).lineHeight);
  if (bounds.height < 3 * lineHeight) throw new Error("Filled dock proof needs at least three reply lines");
  if (bounds.bottom - 3 * lineHeight < visible.top || bounds.bottom > visible.bottom) {
    throw new Error(`Keyboard clips three reply line boxes: ${JSON.stringify({ lineHeight, paragraph: bounds.toJSON(), transcript: visible.toJSON() })}`);
  }
}

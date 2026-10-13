import { useEffect, useRef, useState } from "react";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { useRuntime } from "../window-context.js";
import { classes } from "../ui/classes.js";
import { pictureUrl, type Picture, type StoredPicture } from "./images.js";
import type { RowFacts } from "./rows.js";

const IMAGE_CLASS = "max-h-96 max-w-full self-start rounded-md border border-hairline object-contain";

/** Inline bytes remain readable for imported/provider transcripts; retained images are fetched only at the viewport. */
export const ToolPicture = ({ picture, name, target }: { readonly picture: Picture | StoredPicture; readonly name: string; readonly target: RowFacts["imageTarget"] }) => {
  if (!("hash" in picture)) return <img src={pictureUrl(picture)} alt={name} loading="lazy" className={IMAGE_CLASS} />;
  if (target === undefined) return <p className="text-xs text-ink-faint">Image unavailable</p>;
  return <RetainedPicture key={`${target.environmentId} ${target.sessionId} ${picture.hash}`} picture={picture} name={name} target={target} />;
};

const RetainedPicture = ({ picture, name, target }: { readonly picture: StoredPicture; readonly name: string; readonly target: NonNullable<RowFacts["imageTarget"]> }) => {
  const runtime = useRuntime();
  const { narrow } = usePhoneFrame();
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState<Picture | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    if (box.current !== null) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void runtime.requests.call(target.environmentId, "transcript.image", { sessionId: target.sessionId, hash: picture.hash }).then((read) => {
      if (!current) return;
      if (read.ok) setAnswer(read.result.image);
      else setFailed(true);
    });
    return () => { current = false; };
  }, [runtime, target.environmentId, target.sessionId, picture.hash, visible]);
  const blurred = narrow && picture.sensitive && !revealed;
  return <div ref={box} className="min-h-12 max-w-full self-start">
    {answer === undefined && !failed && <p className="text-xs text-ink-faint">Image loading…</p>}
    {answer === null && <p className="text-xs text-ink-faint">Image no longer retained</p>}
    {failed && <p className="text-xs text-ink-faint">Image unavailable</p>}
    {answer != null && <>
      <img src={pictureUrl(answer)} alt={name} className={classes(IMAGE_CLASS, blurred && "blur-md")} />
      {blurred && <button type="button" onClick={() => setRevealed(true)} className="mt-1 text-xs text-cyan">Show sensitive image</button>}
    </>}
  </div>;
};

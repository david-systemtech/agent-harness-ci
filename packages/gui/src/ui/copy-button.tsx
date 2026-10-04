import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "./button.js";

/** Clipboard access belongs to the caller's platform; confirmation follows its promise. */
export const CopyButton = ({ text, copy, label = "Copy" }: { readonly text: string; readonly copy: (text: string) => Promise<void>; readonly label?: string }) => {
  const [status, setStatus] = useState<"ready" | "copying" | "copied" | "failed">("ready");
  const request = useRef(0);
  useEffect(() => { request.current += 1; setStatus("ready"); return () => { request.current += 1; }; }, [text]);
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("ready"), 1500);
    return () => clearTimeout(timer);
  }, [status]);
  const run = async () => {
    const current = ++request.current;
    setStatus("copying");
    try { await copy(text.replace(/\n$/, "")); if (current === request.current) setStatus("copied"); }
    catch { if (current === request.current) setStatus("failed"); }
  };
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
    <IconButton label={label} variant="outline" size="icon-xs" disabled={status === "copying"} onClick={() => { void run(); }}>
      {status === "copied" ? <Check aria-hidden="true" className="text-mint" /> : status === "failed" ? <TriangleAlert aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </IconButton>
    <span role="status" className={status === "failed" ? "text-xs text-signal" : "sr-only"}>{status === "copied" ? "Copied" : status === "failed" ? "Could not copy. Select the text and copy it manually." : ""}</span>
    {status === "failed" && <textarea data-ui-input aria-label="Text to copy manually" readOnly value={text} onFocus={event => event.currentTarget.select()} onClick={event => event.currentTarget.select()} className="max-h-40 w-full min-w-0 resize-y border border-hairline bg-inset p-2 font-mono text-base text-ink" />}
  </span>;
};

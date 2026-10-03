import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "./button.js";

/** Clipboard access belongs to the caller's platform; confirmation follows its promise. */
export const CopyButton = ({ text, copy, label = "Copy" }: { readonly text: string; readonly copy: (text: string) => Promise<void>; readonly label?: string }) => {
  const [status, setStatus] = useState<"ready" | "copying" | "copied" | "failed">("ready");
  const request = useRef(0);
  useEffect(() => { request.current += 1; setStatus("ready"); return () => { request.current += 1; }; }, [text]);
  const run = async () => {
    const current = ++request.current;
    setStatus("copying");
    try { await copy(text); if (current === request.current) setStatus("copied"); }
    catch { if (current === request.current) setStatus("failed"); }
  };
  return <span className="inline-flex items-center gap-1">
    <IconButton label={label} variant="outline" size="icon-xs" disabled={status === "copying"} onClick={() => { void run(); }}>
      {status === "copied" ? <Check aria-hidden="true" /> : status === "failed" ? <TriangleAlert aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </IconButton>
    <span role="status" className="sr-only">{status === "copied" ? "Copied" : status === "failed" ? "Could not copy" : ""}</span>
  </span>;
};

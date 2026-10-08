import { useMemo } from "react";
import { encode } from "uqr";

/** The provider's unchanged manual URL, with the four-module quiet zone a camera needs, captioned for a phone (setup-copy.md §5.2). */
export const SignInQr = ({ url }: { readonly url: string }) => {
  const data = useMemo(() => {
    try { return encode(url, { border: 4 }).data; }
    catch { return null; }
  }, [url]);
  if (data === null) return <p className="text-xs text-ink-faint">This link is too long for a QR code. Choose Copy link instead.</p>;
  return <figure className="flex flex-col items-center gap-1 self-center">
    <svg role="img" aria-label="QR code of the Claude sign-in page" viewBox={`0 0 ${data.length} ${data.length}`} shapeRendering="crispEdges" fill="currentColor"
      className="size-44 shrink-0 rounded-lg border border-hairline"
      style={{ color: "light-dark(var(--ink), var(--abyss))", backgroundColor: "light-dark(var(--abyss), var(--ink))" }}>
      {data.flatMap((line, y) => line.flatMap((dark, x) => dark ? [<rect key={`${x},${y}`} x={x} y={y} width={1} height={1} />] : []))}
    </svg>
    <figcaption className="text-xs text-ink-muted">Or scan this with your phone.</figcaption>
  </figure>;
};

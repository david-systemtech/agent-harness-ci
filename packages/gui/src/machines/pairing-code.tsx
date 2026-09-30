import { adminCall, clockTime, grantWords, uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import { formatPairingCode, parsePairingLink, type Ceiling, type MintedPairing, type Scope } from "@agent-harness/contracts";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { Button } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** The quiet zone around a QR code, in modules: the four the standard asks for, so a camera finds its edge. */
const QUIET_ZONE = 4;

/**
 * The QR code of `link` (ADR 0025: the QR encodes the link), one square per
 * dark module. Dark on light in both ladders, as a camera reads best: the
 * darker of the Canvas and the ink on the lighter, chosen by the colour
 * scheme the theme paints (`light-dark()`), never a literal (ADR 0023).
 */
const PairingQr = ({ link }: { readonly link: string }) => {
  const { data } = useMemo(() => encode(link, { border: QUIET_ZONE }), [link]);
  return (
    <svg
      role="img"
      aria-label="QR code of the pairing link"
      viewBox={`0 0 ${data.length} ${data.length}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      className="size-44 shrink-0 rounded-sm"
      style={{ color: "light-dark(var(--ink), var(--abyss))", backgroundColor: "light-dark(var(--abyss), var(--ink))" }}
    >
      {data.flatMap((line, y) => line.flatMap((dark, x) => (dark ? [<rect key={`${x},${y}`} data-module="" x={x} y={y} width={1} height={1} />] : [])))}
    </svg>
  );
};

/** A code minted, with when it expires on this client's clock. */
interface Minted {
  readonly pairing: MintedPairing;
  /** When it expires, on this client's clock: the environment's expiry moved by how far its clock is from this one's. */
  readonly until: Date;
}

/** What a pairing code is asked to grant: its scopes and its ceiling. */
export interface PairingGrant {
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
}

interface PairingCodeProps {
  readonly view: EnvironmentView;
  readonly writable: boolean;
  /** What the code grants, said beside it; preset the environment's defaults, every scope and its default ceiling. */
  readonly grant?: PairingGrant;
  /** What the button that makes one says: preset "Make a pairing code". */
  readonly action?: string;
}

/**
 * A pairing code for another client (ADR 0025; #416): `access.pairings.create`
 * at `admin` with the environment's defaults, every scope and its default
 * ceiling (the presets are #577's), or with the grant asked, which is then
 * said beside it (a program's, #417); then the link, the address and the
 * code to type, the QR of the link, and when it expires, ten minutes on and
 * for one use; once it has, that it has, and no code that no longer pairs.
 */
export const PairingCode = ({ view, writable, grant, action = "Make a pairing code" }: PairingCodeProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [minted, setMinted] = useState<Minted | undefined>(undefined);
  const [expired, setExpired] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (minted === undefined) return undefined;
    const timer = clock.setTimeout(() => setExpired(true), Math.max(0, minted.until.getTime() - clock.now().getTime()));
    return () => timer.cancel();
  }, [clock, minted]);

  const mint = async () => {
    setRefused(undefined);
    const asked = grant === undefined ? {} : { scopes: [...grant.scopes], ceiling: grant.ceiling };
    const outcome = await adminCall(() => runtime.requests.call(view.environmentId, "access.pairings.create", { commandId: uuidv7(clock.now()), ...asked }));
    if (!outcome.ok || outcome.result === undefined) return setRefused(`No pairing code: ${outcome.ok ? "the environment answered none." : outcome.line}`);
    const left = Date.parse(outcome.result.expiresAt) - runtime.environmentNow(view.environmentId).getTime();
    setExpired(false);
    setMinted({ pairing: outcome.result, until: new Date(clock.now().getTime() + left) });
  };

  const live = expired ? undefined : minted;
  const origin = live === undefined ? undefined : parsePairingLink(live.pairing.link)?.origin;
  return (
    <>
      {live !== undefined && (
        <div className="flex flex-wrap items-start gap-4">
          <PairingQr link={live.pairing.link} />
          <div className="flex min-w-0 flex-col gap-1 text-sm text-ink">
            <p className="text-ink-muted">Open the link on the other client, scan the QR there, or type the address and code.</p>
            <code className="font-mono text-xs break-all select-all">{live.pairing.link}</code>
            {origin !== undefined && <p>Address: {origin.replace(/^http:\/\//, "")}</p>}
            <p>Code: {formatPairingCode(live.pairing.code)}</p>
            {grant !== undefined && <p>{grantWords(live.pairing.scopes, live.pairing.ceiling)}</p>}
            <p className="text-ink-muted">Expires at {clockTime(live.until.toISOString())}, for one use.</p>
          </div>
        </div>
      )}
      {minted !== undefined && expired && <p className="text-sm text-ink-muted">This code expired at {clockTime(minted.until.toISOString())}: make another.</p>}
      {refused !== undefined && <p className="text-sm text-signal">{refused}</p>}
      <div>
        <Button disabled={!writable} onClick={() => void mint()}>
          {action}
        </Button>
      </div>
    </>
  );
};

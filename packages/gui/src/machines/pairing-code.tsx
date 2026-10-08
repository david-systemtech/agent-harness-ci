import { COUNTDOWN_TICK_MS, adminCall, grantWords, pairingLinkIsLocal, uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import { formatPairingCode, parsePairingLink, type Ceiling, type MintedPairing, type Scope } from "@agent-harness/contracts";
import { KeyRound } from "lucide-react";
import { CopyLine } from "../settings/copy-line.js";
import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { encode } from "uqr";
import { PairingRefusal } from "../connections/pairing.js";
import { nameOf } from "../connections/words.js";
import { Button, Fold } from "../ui/index.js";
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
      className="size-44 shrink-0 rounded-lg border border-hairline"
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
  /** How long it was made to last, in whole minutes. */
  readonly minutes: number;
}

/** What a pairing code is asked to grant: its scopes and its ceiling. */
export interface PairingGrant {
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
}

interface PairingCodeProps {
  readonly view: EnvironmentView;
  readonly writable: boolean;
  /** What the code is asked to grant, sent explicit. */
  readonly grant: PairingGrant;
  /** What the button that makes one says: preset "Make a pairing code". */
  readonly action?: string;
  /** A line above the button, where the computer has one: that other devices cannot reach it yet. */
  readonly warning?: ReactNode;
  /** Whether the code made says what it grants as the environment answered it, in scope and mode ids: Settings' Access pane does, Add a device does not. */
  readonly grantShown?: boolean;
  /** Whether the code made says how to use it on another device's agent-harness: Add a device's does, a program's code does not, as a program has no Connect to another computer. */
  readonly forDevice?: boolean;
}

/** How a code reaching another device is used there (setup-copy.md §5.5). */
export const HOW_TO_USE = "On the new device, open agent-harness and choose Connect to another computer. Scan this code or paste the link.";

const MINUTE_MS = 60_000;

/** The line a code that reaches only this computer reads in place of how to use it on another device (setup-copy.md §5.5). */
export const ONLY_HERE = "This code only works on this computer.";

/**
 * How many whole minutes a code minted has before it expires, rounded up,
 * counted down on this client's clock and drawn again every second while it
 * runs, so the minute turns when it does.
 */
const useMinutesLeft = (until: Date | undefined): number | undefined => {
  const clock = useClock();
  const [tick, redraw] = useReducer((count: number) => count + 1, 0);
  const left = until === undefined ? undefined : until.getTime() - clock.now().getTime();
  const running = left !== undefined && left > 0;
  useEffect(() => {
    if (!running) return undefined;
    const timer = clock.setTimeout(redraw, COUNTDOWN_TICK_MS);
    return () => timer.cancel();
  }, [clock, running, tick]);
  return left === undefined ? undefined : Math.max(0, Math.ceil(left / MINUTE_MS));
};

/**
 * A pairing code for another device (setup-copy.md §5.5; ADR 0025; #416,
 * #577, #1847): `access.pairings.create` at `admin` with the grant asked, its
 * scopes and ceiling explicit (a preset's, or a program's on Access, #417);
 * then how to use it on the new device, the QR of the link, the link with
 * Copy, and in a fold the address and code to type, and how long it lasts,
 * counted down; once it has run out, that it has, and Make a new code. A
 * link whose address is loopback, which the computer hands out while it is
 * reachable only from itself, is never offered to another device: it says
 * so, with no QR (#1847).
 */
export const PairingCode = ({ view, writable, grant, action = "Make a pairing code", warning, grantShown = false, forDevice = false }: PairingCodeProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [minted, setMinted] = useState<Minted | undefined>(undefined);
  const [expired, setExpired] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (minted === undefined) return undefined;
    const timer = clock.setTimeout(() => setExpired(true), Math.max(0, minted.until.getTime() - clock.now().getTime()));
    return () => timer.cancel();
  }, [clock, minted]);

  const mint = async () => {
    setRefused(undefined);
    const asked = { scopes: [...grant.scopes], ceiling: grant.ceiling };
    const outcome = await adminCall(() => runtime.requests.call(view.environmentId, "access.pairings.create", { commandId: uuidv7(clock.now()), ...asked }));
    if (!outcome.ok || outcome.result === undefined) return setRefused(outcome.ok ? "The computer answered with no code." : outcome.line);
    const left = Date.parse(outcome.result.expiresAt) - runtime.environmentNow(view.environmentId).getTime();
    setExpired(false);
    setManual(false);
    setMinted({ pairing: outcome.result, until: new Date(clock.now().getTime() + left), minutes: Math.max(1, Math.round(left / MINUTE_MS)) });
  };

  const live = expired ? undefined : minted;
  const left = useMinutesLeft(live?.until);
  const origin = live === undefined ? undefined : parsePairingLink(live.pairing.link)?.origin;
  const local = live !== undefined && pairingLinkIsLocal(live.pairing.link);
  return (
    <>
      {live !== undefined && (
        <div role="group" aria-label="Pairing code" className="flex flex-wrap items-start gap-4">
          {!local && <PairingQr link={live.pairing.link} />}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm text-ink">
            {local ? <p className="text-amber">{ONLY_HERE}</p> : forDevice && <p className="text-ink">{HOW_TO_USE}</p>}
            <CopyLine label="Pairing link" text={live.pairing.link} copyLabel="Copy pairing link" />
            <Fold summary="Type it instead" open={manual} onOpenChange={setManual}>
              <div className="flex flex-col gap-1">
                {origin !== undefined && <CopyLine label="Address" text={origin.replace(/^https?:\/\//, "")} copyLabel="Copy address" />}
                <CopyLine label="Code" text={formatPairingCode(live.pairing.code)} copyLabel="Copy pairing code" />
              </div>
            </Fold>
            {grantShown && <p>{grantWords(live.pairing.scopes, live.pairing.ceiling)}</p>}
            <p role="timer" className="text-ink-muted">
              This code works once, for {live.minutes} minutes. {left} min left.
            </p>
          </div>
        </div>
      )}
      {minted !== undefined && expired && <p className="text-sm text-ink-muted">This code has run out.</p>}
      {refused !== undefined && <PairingRefusal line={`Something went wrong. Choose ${action} to try again.`} details={[refused]} computer={nameOf(view)} />}
      {warning}
      <div>
        <Button variant="outline" title={`${minted !== undefined && expired ? "Make a new code" : action} (Enter or Space)`} disabled={!writable} onClick={() => void mint()}>
          <KeyRound aria-hidden="true" data-icon="inline-start" />{minted !== undefined && expired ? "Make a new code" : action}
        </Button>
      </div>
    </>
  );
};

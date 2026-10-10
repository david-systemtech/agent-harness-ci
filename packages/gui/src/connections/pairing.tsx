import {
  isCredentialAccessUnanswered,
  LOCAL_PLACEHOLDER_ID,
  PairingCodeSpentError,
  parsePairingInput,
  type EnvironmentView,
  type PairingInput,
  type PairingOptions,
  type PairingOutcome,
} from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertTitle, Dialog, DialogClose, DialogContent, Fold, Input } from "../ui/index.js";
import { useClientVersion, useClock, useObservable, useRuntime, useShell } from "../window-context.js";
import { KEYCHAIN_NOTICE_DELAY_MS } from "../notices/credential-notice.js";
import { DialogFooter } from "../ui/dialog.js";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { CircleAlert, Globe, KeyRound, Link, ListChecks, QrCode, RotateCw, X } from "lucide-react";
import "./phone-pairing.css";
import { webCameraFor } from "../platform/web-camera.js";
import { nameOf } from "./words.js";
import { unlistedBy } from "./browser-reach.js";
import { useWindowFrame } from "../frame/window-controls.js";
import { useSetUpThisMachine } from "../machines/set-up-offer.js";
import { TechnicalDetails } from "../setup/details.js";

/**
 * Connecting this app to agent-harness on another computer (setup-copy.md
 * §4.2; docs/specs/gui.md, "The local environment, pairing and updates"): a
 * pairing link pasted or handed to the desktop as an `agent-harness://` deep
 * link, or, in a fold, an address and its code, through `connections.add`.
 * Each refusal is the runtime's plain line as an alert, the raw failure in
 * Details; a link for a computer connected already offers to connect again
 * in place, and a revoked or expired connection is paired again in place
 * from its heading. The form is the window's first view with "Run an
 * environment on this machine" off, Part 2 of Add a device, and a dialog
 * anywhere else. While macOS asks the person to let the app use its key,
 * the form says where to answer; a prompt left unanswered is said again in
 * the past tense, with Try again, which pairs with the same code: the
 * runtime asks before it spends it (#1693). In a browser tab, a link whose
 * origin the page may not contact is refused before any fetch (#1713), each
 * origin a run that wraps whole; whatever the form says is scrolled into
 * view, below the fold on a phone as it may be, and there takes the full
 * width above its actions (#1739).
 */

/** What the form says while the token's OS store waits on macOS's Keychain prompt, and once that prompt went unanswered, before or after the code was spent. */
const KEYCHAIN_ASKING = "Your Mac is asking to use agent-harness's saved key. Find the Mac's dialog and choose Always Allow.";
const KEYCHAIN_UNANSWERED = "Your Mac's question was not answered, so pairing stopped. Choose Always Allow, then Try again.";
const KEYCHAIN_UNANSWERED_SPENT = "Your Mac's question was not answered, so pairing stopped. Choose Always Allow, then make a new code: this one was used.";

/** The visible hint under the link's field: where a pairing link comes from. */
export const PAIRING_LINK_HINT = "To get one, open Set up on that computer and choose Add a device. On a server, run agent-harness pair.";

/** A refusal as the form says it: the plain line, and the raw failure for Details. */
interface Refusal {
  readonly line: string;
  readonly details: readonly string[];
}

/** What the form says after a pairing: under way, connected, refused, or the offer to connect again in place. */
type Said =
  | { readonly kind: "pairing" }
  | { readonly kind: "connected"; readonly line: string; readonly environmentId: string; readonly name: string }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | { readonly kind: "offer"; readonly line: string; readonly input: PairingInput; readonly environmentId: string }
  | { readonly kind: "unanswered"; readonly input: PairingInput; readonly options: PairingOptions | undefined; readonly details: readonly string[] }
  | { readonly kind: "unlisted"; readonly refused: Unlisted; readonly environmentId: string };

/** An origin the serving environment's Allowed connection origins leave out: the origin, the serving environment's name, and this page's origin. */
interface Unlisted {
  readonly origin: string;
  readonly serving: string;
  readonly pageOrigin: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** An origin or host in the form's line: a code run that wraps whole, never at a hyphen inside its host name (#1739). */
const Origin = ({ children }: { readonly children: string }) => <code data-pairing-origin className="font-mono">{children}</code>;

/** The host of an origin, as the line names the computer before it has answered. */
const hostOf = (origin: string): string => origin.replace(/^[a-z]+:\/\//i, "");

/** Both lists to change for an origin the serving environment's Allowed connection origins leave out, for Details. */
const unlistedDetails = ({ origin, serving, pageOrigin }: Unlisted): readonly string[] => [
  `Add ${origin} to ${serving}'s Allowed connection origins (Your machines, Browser origins), then reload this page.`,
  `Add this page's origin, ${pageOrigin}, to the Allowed client origins of the agent-harness at ${origin}.`,
];

/** A pairing's outcome as the form says it, the computer named as the window names it. */
const saidOf = (outcome: PairingOutcome, input: PairingInput, views: readonly EnvironmentView[]): Said => {
  switch (outcome.status) {
    case "paired": {
      const view = views.find((candidate) => candidate.environmentId === outcome.environmentId);
      const name = view ? nameOf(view) : "the other computer";
      const replaced = outcome.replaced && !outcome.replaced.revoked ? ` ${outcome.replaced.message}` : "";
      const storage = outcome.credentialStorage === "fresh-item" ? " Stored credentials in a fresh protected item." :
        outcome.credentialStorage === "retained-item" ? " Stored credentials using the existing protected item." : "";
      return { kind: "connected", line: `Connected to ${name}.${storage}${replaced}`, environmentId: outcome.environmentId, name };
    }
    case "re-pair-offered":
      return { kind: "offer", line: `${outcome.name} is already connected. Connect again?`, input, environmentId: outcome.environmentId };
    case "failed":
      return { kind: "refused", refusal: { line: outcome.failure.message, details: outcome.failure.details ?? [] } };
  }
};

/** A pairing that threw: Try again only while the code is unspent, the runtime having asked the store before the exchange. */
const saidOfFailure = (error: unknown, input: PairingInput, options: PairingOptions | undefined): Said => {
  const details = [messageOf(error)];
  if (!isCredentialAccessUnanswered(error)) return { kind: "refused", refusal: { line: "Pairing did not work. Try again.", details } };
  return error instanceof PairingCodeSpentError ? { kind: "refused", refusal: { line: KEYCHAIN_UNANSWERED_SPENT, details } } : { kind: "unanswered", input, options, details };
};

interface PairingRefusalProps {
  /** The plain line: a string, or text with origins that wrap whole. */
  readonly line: ReactNode;
  /** The raw failure, one line each. */
  readonly details: readonly string[];
  /** The buttons that fix it, in place. */
  readonly actions?: ReactNode;
  /** The computer the refusal came from, where it is known. */
  readonly computer?: string;
}

/**
 * A pairing refusal (setup-copy.md §1 rules 7 and 15): text and colour, an
 * alert read with a hidden "Error: " first, the buttons that fix it in place,
 * and Details with the raw failure and Copy details.
 */
export const PairingRefusal = ({ line, details, actions, computer }: PairingRefusalProps) => {
  const shell = useShell();
  const version = useClientVersion();
  const frame = useWindowFrame();
  const text = typeof line === "string" ? line : (details[0] ?? "");
  return (
    <Alert role="alert" variant="destructive" data-pairing-refusal>
      <CircleAlert aria-hidden="true" />
      <AlertTitle data-pairing-line><span className="sr-only">Error:</span> {line}</AlertTitle>
      {actions !== undefined && <div className="col-start-2 mt-1.5 flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      {details.length > 0 && (
        <div className="col-start-2 mt-1 min-w-0 text-ink">
          <TechnicalDetails
            report={{ app: { version, platform: frame?.platform ?? "unknown" }, ...(computer !== undefined && { computer: { name: computer } }), line: text, details }}
            copy={(copied) => (shell?.clipboard === undefined ? Promise.reject(new Error("This app has no clipboard.")) : shell.clipboard.writeText(copied))}
          />
        </div>
      )}
    </Alert>
  );
};

export interface PairingFormProps {
  /** Pairs again in place: the connection whose client session a pairing replaces. */
  readonly rePair?: string | undefined;
  /** A link to pair with as the form opens: the deep link the desktop was handed. */
  readonly link?: string | undefined;
  /** Hears each environment a pairing from the form made or paired again, by its id. */
  readonly onPaired?: ((environmentId: string) => void) | undefined;
  /** Reads a pairing link from a QR code with the camera the platform gives the window, offered as Scan a QR code; none where it gives none. */
  readonly scanQr?: (() => Promise<string | undefined>) | undefined;
  /** Whether the link's field takes the focus as the form opens. */
  readonly autoFocus?: boolean;
  /** Require a verified full grant before accepting this replacement. */
  readonly fullAccess?: boolean;
  /** Goes to an environment's Browser origins lists, offered beside an origin they leave out; none where the form cannot reach Settings. */
  readonly toBrowserOrigins?: ((environmentId: string) => void) | undefined;
  /** Opens Set up on the computer just connected, offered as Set up {name}; none where the place already offers it. */
  readonly onSetUp?: ((environmentId: string) => void) | undefined;
}

/** A pairing link, or an address and code in a fold (or a QR scanned, where the window has a camera), and what the pairing came to. */
export const PairingForm = ({ rePair, link: handed, onPaired, scanQr, autoFocus = false, fullAccess = false, toBrowserOrigins, onSetUp }: PairingFormProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const clock = useClock();
  const camera = webCameraFor(runtime);
  const scanner = scanQr ?? (camera ? () => camera.scanQr() : undefined);
  useEffect(() => () => camera?.cancel(), [camera]);
  const [link, setLink] = useState(handed ?? "");
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const pairing = said?.kind === "pairing";
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (said !== undefined && said.kind !== "pairing" && typeof status.current?.scrollIntoView === "function") status.current.scrollIntoView({ block: "nearest" });
  }, [said]);
  // Whether the pairing under way waits on the OS's credential prompt, said after the same delay as the window's notice.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!pairing) return undefined;
    let timer: ReturnType<typeof clock.setTimeout> | undefined;
    const stop = shell?.secrets?.onAccess?.((state) => {
      timer?.cancel();
      setAsking(false);
      if (state === "waiting") timer = clock.setTimeout(() => setAsking(true), KEYCHAIN_NOTICE_DELAY_MS);
    });
    return () => {
      timer?.cancel();
      stop?.();
      setAsking(false);
    };
  }, [pairing, shell, clock]);
  const linkField = useId();
  const linkHint = useId();
  const addressField = useId();
  const codeField = useId();

  const pair = useCallback(
    async (input: PairingInput, options?: PairingOptions) => {
      const parsed = parsePairingInput(input);
      if (shell === undefined && parsed.ok && !parsed.origin.startsWith("https://")) {
        setSaid({ kind: "refused", refusal: { line: "Use the other computer's HTTPS pairing link or HTTPS address. This page cannot connect over HTTP.", details: [parsed.origin] } });
        return;
      }
      setSaid({ kind: "pairing" });
      if (shell === undefined && parsed.ok) {
        const pageOrigin = window.location.origin;
        const unlisted = await unlistedBy(runtime, parsed.origin, pageOrigin);
        if (unlisted !== undefined) {
          const serving = runtime.projections.environments.read().find((view) => view.environmentId === unlisted);
          setSaid({ kind: "unlisted", refused: { origin: parsed.origin, serving: serving ? nameOf(serving) : "this environment", pageOrigin }, environmentId: unlisted });
          return;
        }
      }
      await runtime.connections.add(input, { ...(options ?? (rePair === undefined ? {} : { rePair })), ...(fullAccess && { fullAccess: true }) }).then(
        (outcome) => {
          setSaid(saidOf(outcome, input, runtime.projections.environments.read()));
          if (outcome.status === "paired") onPaired?.(outcome.environmentId);
        },
        (error: unknown) => setSaid(saidOfFailure(error, input, options)),
      );
    },
    [runtime, rePair, onPaired, shell, fullAccess],
  );

  // A deep link pairs as it is opened, as a link pasted and sent would.
  const pairedHanded = useRef(false);
  useEffect(() => {
    if (handed === undefined || pairedHanded.current) return;
    pairedHanded.current = true;
    void pair({ link: handed });
  }, [handed, pair]);

  const byLink = (event: FormEvent) => {
    event.preventDefault();
    if (link.trim() !== "") void pair({ link });
  };
  const byCode = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim() !== "" || code.trim() !== "") void pair({ address, code });
  };
  const scan = async () => {
    let scanned: string | undefined;
    try {
      scanned = await scanner?.();
    } catch (error) {
      return setSaid({ kind: "refused", refusal: { line: "The QR code could not be read. Paste the link instead.", details: [messageOf(error)] } });
    }
    if (scanned === undefined) return;
    setLink(scanned);
    await pair({ link: scanned });
  };

  return (
    <div data-phone-pairing className="flex min-w-0 flex-col gap-4">
      <form aria-label="Pair by link" className="flex flex-col gap-1.5" onSubmit={byLink}>
        <label className="flex items-center gap-2 text-xs text-ink-muted" htmlFor={linkField}>
          <Link aria-hidden="true" className="size-4" />Pairing link
        </label>
        <Input title="Pairing link (paste; Enter to pair)" id={linkField} aria-describedby={linkHint} value={link} onChange={(event) => setLink(event.target.value)} disabled={pairing} autoFocus={autoFocus} className="font-mono" />
        <p id={linkHint} className="text-xs text-ink-muted">{PAIRING_LINK_HINT}</p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button icon={Link} keys="Enter" type="submit" variant="default" disabled={pairing}>Pair</Button>
          {scanner !== undefined && <Button icon={QrCode} disabled={pairing} onClick={() => void scan()}>Scan a QR code</Button>}
        </div>
      </form>
      <Fold summary="Type an address and code instead" open={manual} onOpenChange={setManual}>
        <form aria-label="Pair by address and code" className="flex flex-col gap-2 rounded-lg border border-hairline bg-inset/60 p-3" onSubmit={byCode}>
          <label className="flex items-center gap-2 text-xs text-ink-muted" htmlFor={addressField}><Link aria-hidden="true" className="size-4" />Address</label>
          <Input title="Address (type the other computer's address)" id={addressField} value={address} onChange={(event) => setAddress(event.target.value)} disabled={pairing} className="font-mono" />
          <label className="flex items-center gap-2 text-xs text-ink-muted" htmlFor={codeField}><KeyRound aria-hidden="true" className="size-4" />Pairing code</label>
          <Input title="Pairing code (type; Enter to pair)" id={codeField} value={code} onChange={(event) => setCode(event.target.value)} disabled={pairing} className="font-mono" />
          <Button icon={Link} keys="Enter" type="submit" disabled={pairing} className="self-start mt-2">Pair</Button>
        </form>
      </Fold>
      <div ref={status} className="flex min-w-0 flex-col gap-2">
        <div role="status" className="flex min-h-8 items-center gap-2 text-sm text-ink">
          {said?.kind === "pairing" && <span>{asking ? KEYCHAIN_ASKING : "Pairing…"}</span>}
          {said?.kind === "connected" && (
            <>
              <span>{said.line}</span>
              {onSetUp !== undefined && (
                <Button icon={ListChecks} variant="default" onClick={() => onSetUp(said.environmentId)}>
                  {`Set up ${said.name}`}
                </Button>
              )}
            </>
          )}
          {said?.kind === "offer" && (
            <>
              <span>{said.line}</span>
              <Button variant="default" onClick={() => void pair(said.input, { rePair: said.environmentId })}>
                Connect again
              </Button>
              <Button onClick={() => setSaid(undefined)}>Cancel</Button>
            </>
          )}
        </div>
        {said?.kind === "refused" && <PairingRefusal line={said.refusal.line} details={said.refusal.details} />}
        {said?.kind === "unanswered" && (
          <PairingRefusal
            line={KEYCHAIN_UNANSWERED}
            details={said.details}
            actions={<Button icon={RotateCw} variant="default" onClick={() => void pair(said.input, said.options)}>Try again</Button>}
          />
        )}
        {said?.kind === "unlisted" && (
          <PairingRefusal
            line={<>This page is not allowed to connect to <Origin>{hostOf(said.refused.origin)}</Origin>. Ask whoever runs <Origin>{hostOf(said.refused.origin)}</Origin> to allow this page.</>}
            details={unlistedDetails(said.refused)}
            actions={toBrowserOrigins !== undefined && (
              <Button icon={Globe} onClick={() => toBrowserOrigins(said.environmentId)}>
                Browser origins
              </Button>
            )}
          />
        )}
      </div>
    </div>
  );
};


export const FULL_ACCESS_GUIDANCE = "Make a full-access code on a paired desktop: Settings → Your machines → this environment’s card → Me. Or run agent-harness pair --preset own-client on the environment’s command line. Paste its link here or scan its QR. This replaces this phone’s pairing when it succeeds.";

/** What opens the pairing dialog: pairing again in place, or a deep link to pair with. */
export interface PairingRequest {
  readonly rePair?: string;
  readonly link?: string;
  /** Deliberate replacement with a full-access code minted by a trusted client. */
  readonly fullAccess?: boolean;
}

/** A request as the dialog holds it: with Set up, from the place that opened it, which sits inside Set up's providers as the dialog does not. */
type HeldRequest = PairingRequest & { readonly setUp?: (environmentId: string) => void };

const PairingContext = createContext<((request?: HeldRequest) => void) | null>(null);

/** Opens the pairing dialog, anywhere in the window; once connected, it offers Set up on the computer through the opener's Set up. */
export const useOpenPairing = (): ((request?: PairingRequest) => void) => {
  const open = use(PairingContext);
  if (open === null) throw new Error("Pairing is opened inside the PairingProvider, which the App holds.");
  const setUp = useSetUpThisMachine();
  return useCallback((request: PairingRequest = {}) => open({ ...request, setUp: (environmentId) => void setUp(environmentId) }), [open, setUp]);
};

/**
 * The window's pairing dialog, which a sidebar button, a heading's Pair
 * again and a pairing deep link open. A deep link the desktop is handed
 * (`shell.deepLinks.onOpen`) that carries a pairing link opens it and pairs.
 */
export const PairingProvider = ({ children }: { readonly children: ReactNode }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const views = useObservable(runtime.projections.environments);
  const [request, setRequest] = useState<(HeldRequest & { readonly opened: number }) | undefined>(undefined);
  const openings = useRef(0);
  const open = useCallback((next: HeldRequest = {}) => setRequest({ ...next, opened: ++openings.current }), []);

  useEffect(() => {
    if (runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.deepLinks.onOpen").status !== "present") return undefined;
    return shell?.deepLinks?.onOpen?.((url) => {
      if (parsePairingInput({ link: url }).ok) open({ link: url });
    });
  }, [runtime, shell, open]);

  const again = request?.rePair === undefined ? undefined : views.find((view) => view.environmentId === request.rePair);
  return (
    <PairingContext value={open}>
      {children}
      <Dialog open={request !== undefined} onOpenChange={(opened) => !opened && setRequest(undefined)}>
        {request !== undefined && (
          <DialogContent
            title={request.fullAccess ? "Give this phone full access" : again ? `Pair ${nameOf(again)} again` : "Connect to another computer"}
            description={request.fullAccess ? FULL_ACCESS_GUIDANCE : "Paste the pairing link from the other computer."}
            className="max-w-[32rem] max-h-[calc(100dvh-4rem)] overflow-y-auto"
          >
            <PairingForm
              key={request.opened}
              fullAccess={request.fullAccess ?? false}
              rePair={request.rePair}
              link={request.link}
              onPaired={request.fullAccess ? () => setRequest(undefined) : undefined}
              onSetUp={request.setUp === undefined ? undefined : (environmentId) => { setRequest(undefined); request.setUp?.(environmentId); }}
            />
            <DialogFooter><DialogClose asChild><Button icon={X} keys="Enter / Space / Escape">Close</Button></DialogClose></DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </PairingContext>
  );
};

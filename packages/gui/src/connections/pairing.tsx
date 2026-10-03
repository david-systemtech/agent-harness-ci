import {
  LOCAL_PLACEHOLDER_ID,
  parsePairingInput,
  type EnvironmentView,
  type PairingInput,
  type PairingOptions,
  type PairingOutcome,
} from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Dialog, DialogClose, DialogContent, Input } from "../ui/index.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { DialogFooter } from "../ui/dialog.js";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { Link, QrCode, X } from "lucide-react";
import { nameOf } from "./words.js";

/**
 * Pairing this window with an environment (docs/specs/gui.md, "The local
 * environment, pairing and updates"): a pairing link pasted or handed to the
 * desktop as an `agent-harness://` deep link, or an address and its code,
 * through `connections.add`. Each typed failure is one line, in the
 * runtime's words; a link for an environment paired already offers to pair
 * it again in place, and a revoked or expired connection is paired again in
 * place from its heading. The form is the window's first view with "Run an
 * environment on this machine" off, and a dialog anywhere else.
 */

/** What the form says after a pairing: under way, done, failed, or the offer to pair again in place. */
type Said =
  | { readonly kind: "pairing" }
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "offer"; readonly line: string; readonly input: PairingInput; readonly environmentId: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A pairing's outcome as the form says it, the environment named as the window names it. */
const saidOf = (outcome: PairingOutcome, input: PairingInput, views: readonly EnvironmentView[]): Said => {
  switch (outcome.status) {
    case "paired": {
      const view = views.find((candidate) => candidate.environmentId === outcome.environmentId);
      const replaced = outcome.replaced && !outcome.replaced.revoked ? ` ${outcome.replaced.message}` : "";
      return { kind: "line", line: `Paired with ${view ? nameOf(view) : "the environment"}.${replaced}` };
    }
    case "re-pair-offered":
      return { kind: "offer", line: `${outcome.name} is paired already. Pair it again in place?`, input, environmentId: outcome.environmentId };
    case "failed":
      return { kind: "line", line: `Not paired: ${outcome.failure.message}` };
  }
};

export interface PairingFormProps {
  /** Pairs again in place: the connection whose client session a pairing replaces. */
  readonly rePair?: string | undefined;
  /** A link to pair with as the form opens: the deep link the desktop was handed. */
  readonly link?: string | undefined;
  /** Hears each environment a pairing from the form made or paired again, by its id. */
  readonly onPaired?: (environmentId: string) => void;
  /** Reads a pairing link from a QR code with the camera the platform gives the window, offered as Scan a QR; none where it gives none. */
  readonly scanQr?: (() => Promise<string | undefined>) | undefined;
  /** Whether the link's field takes the focus as the form opens. */
  readonly autoFocus?: boolean;
}

/** A pairing link, or an address and code (or a QR scanned, where the window has a camera), and the one line that says how the pairing went. */
export const PairingForm = ({ rePair, link: handed, onPaired, scanQr, autoFocus = false }: PairingFormProps) => {
  const runtime = useRuntime();
  const [link, setLink] = useState(handed ?? "");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const pairing = said?.kind === "pairing";
  const linkField = useId();
  const addressField = useId();
  const codeField = useId();

  const pair = useCallback(
    (input: PairingInput, options?: PairingOptions) => {
      setSaid({ kind: "pairing" });
      runtime.connections.add(input, options ?? (rePair === undefined ? undefined : { rePair })).then(
        (outcome) => {
          setSaid(saidOf(outcome, input, runtime.projections.environments.read()));
          if (outcome.status === "paired") onPaired?.(outcome.environmentId);
        },
        (error: unknown) => setSaid({ kind: "line", line: `Not paired: ${messageOf(error)}` }),
      );
    },
    [runtime, rePair, onPaired],
  );

  // A deep link pairs as it is opened, as a link pasted and sent would.
  const pairedHanded = useRef(false);
  useEffect(() => {
    if (handed === undefined || pairedHanded.current) return;
    pairedHanded.current = true;
    pair({ link: handed });
  }, [handed, pair]);

  const byLink = (event: FormEvent) => {
    event.preventDefault();
    if (link.trim() !== "") pair({ link });
  };
  const byCode = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim() !== "" || code.trim() !== "") pair({ address, code });
  };
  const scan = async () => {
    let scanned: string | undefined;
    try {
      scanned = await scanQr?.();
    } catch (error) {
      return setSaid({ kind: "line", line: `Not scanned: ${messageOf(error)}` });
    }
    if (scanned === undefined) return;
    setLink(scanned);
    pair({ link: scanned });
  };

  return (
    <div className="flex flex-col gap-4">
      <form aria-label="Pair by link" className="flex flex-col gap-1.5" onSubmit={byLink}>
        <label className="text-sm text-ink-muted" htmlFor={linkField}>
          Pairing link
        </label>
        <Input id={linkField} value={link} placeholder="http://desk:7433/pair#K7Q2M-XH4RT" onChange={(event) => setLink(event.target.value)} disabled={pairing} autoFocus={autoFocus} className="font-mono" />
        <div className="flex flex-wrap gap-2 pt-2">
          <Button icon={Link} keys="Enter" type="submit" tone="primary" disabled={pairing}>Pair</Button>
          {scanQr !== undefined && <Button icon={QrCode} disabled={pairing} onClick={() => void scan()}>Scan a QR</Button>}
        </div>
      </form>
      <form aria-label="Pair by address and code" className="flex flex-col gap-2 rounded-lg border border-hairline bg-inset/60 p-3" onSubmit={byCode}>
        <p className="text-sm text-ink-muted">Or the environment's address and its code</p>
        <label className="text-sm font-medium" htmlFor={addressField}>Address</label>
        <Input id={addressField} value={address} placeholder="desk:7433" onChange={(event) => setAddress(event.target.value)} disabled={pairing} className="font-mono" />
        <label className="text-sm font-medium" htmlFor={codeField}>Pairing code</label>
        <Input id={codeField} value={code} placeholder="K7Q2M-XH4RT" onChange={(event) => setCode(event.target.value)} disabled={pairing} className="font-mono" />
        <Button icon={Link} keys="Enter" type="submit" disabled={pairing} className="self-start mt-2">Pair with the code</Button>
      </form>
      <div role="status" className="flex min-h-8 items-center gap-2 text-sm text-ink">
        {said?.kind === "pairing" && <span>Pairing…</span>}
        {said?.kind === "line" && <span>{said.line}</span>}
        {said?.kind === "offer" && (
          <>
            <span>{said.line}</span>
            <Button tone="primary" onClick={() => pair(said.input, { rePair: said.environmentId })}>
              Pair again
            </Button>
            <Button onClick={() => setSaid(undefined)}>Cancel</Button>
          </>
        )}
      </div>
    </div>
  );
};

/** What opens the pairing dialog: pairing again in place, or a deep link to pair with. */
export interface PairingRequest {
  readonly rePair?: string;
  readonly link?: string;
}

const PairingContext = createContext<((request?: PairingRequest) => void) | null>(null);

/** Opens the pairing dialog, anywhere in the window. */
export const useOpenPairing = (): ((request?: PairingRequest) => void) => {
  const open = use(PairingContext);
  if (open === null) throw new Error("Pairing is opened inside the PairingProvider, which the App holds.");
  return open;
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
  const [request, setRequest] = useState<(PairingRequest & { readonly opened: number }) | undefined>(undefined);
  const openings = useRef(0);
  const open = useCallback((next: PairingRequest = {}) => setRequest({ ...next, opened: ++openings.current }), []);

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
            title={again ? `Pair ${nameOf(again)} again` : "Pair with an environment"}
            description="Paste the pairing link another client made, or type the environment's address and its code."
            className="max-w-[32rem] max-h-[calc(100dvh-4rem)] overflow-y-auto"
          >
            <PairingForm key={request.opened} rePair={request.rePair} link={request.link} />
            <DialogFooter><DialogClose asChild><Button icon={X} keys="Escape">Close</Button></DialogClose></DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </PairingContext>
  );
};

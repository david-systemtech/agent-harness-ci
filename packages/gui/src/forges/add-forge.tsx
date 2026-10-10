import { RadioGroup as KindRadio } from "radix-ui";
import { ExternalLink as ExternalLinkIcon, GitPullRequest, Plus, RefreshCw, X } from "lucide-react";
import { ActionButton as Button, AccessField as Field } from "../key-managers/action-button.js";
import { ADDRESS_EXAMPLE, FORGE_KIND_WORDS, addPastedForge, detectForge, tokenPermissionWords, typedSite, type ForgeRefused } from "@agent-harness/client-runtime";
import { forgeTokenPages, normaliseRemote, type ForgeKind, type ForgeTokenPage, type ResultOf } from "@agent-harness/contracts";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Input, RadioGroup } from "../ui/index.js";
import { ExternalLink } from "../session/external-link.js";
import { useClock, useRuntime } from "../window-context.js";
import { RefusalLine } from "./refusal-line.js";

/**
 * The `gh` paths the Forges list offers first (ADR 0032; setup-copy.md
 * §5.6): this computer's `gh`, its token handed over once, and the
 * environment's own, read on every use.
 */
export interface AddForgeGh {
  /** Use the gh sign-in from this computer: the Forges row offers it on every environment, the Forges step on a remote one (#589). */
  readonly computer: boolean;
  /** Use gh, the environment's own from `forge.gh.probe`, or Install gh or Update gh where it cannot: the Forges step's (#589). */
  readonly machine: boolean;
}

export interface AddForgeProps {
  readonly environmentId: string;
  readonly environmentName: string;
  /** The computer the token is kept on, as a line names it: `this computer`, or the environment's name. */
  readonly computer: string;
  readonly close: () => void;
  /** Says one line in the pane: where the forge account added stands. */
  readonly say: (line: string) => void;
}

/** A kind a forge account is added for: GitLab is not yet (ADR 0033). */
type AddableKind = Exclude<ForgeKind, "gitlab">;

const ADDABLE_KINDS: readonly AddableKind[] = ["github", "forgejo", "gitea"];

/** How long typing pauses before the address is looked up. */
export const DETECT_PAUSE_MS = 500;

/** Where looking up the typed address stands: not asked, on its way, found, or refused (`unrecognised` when the person names the kind). */
type Lookup =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "found"; readonly found: ResultOf<"forge.detect"> }
  | ({ readonly state: "refused"; readonly unrecognised: boolean } & Pick<ForgeRefused, "line" | "details">);

/**
 * Add a forge (setup-copy.md §5.6; forge spec, "Credentials" and "Wire
 * methods"; ADR 0020; #419, #1849): one address field, whose kind
 * `forge.detect` finds once typing pauses and again on Check address; a site
 * it does not recognise asks what it runs, GitHub, Forgejo or Gitea, and that
 * kind is sent with the add. Once the kind is known the numbered token steps
 * name the site, open its token page and say the permissions in that page's
 * words; the token, sent once in `forge.accounts.add`, stays in the form
 * while the kind changes, the address is checked again or the add is
 * refused, and is never kept on the client. A refusal is one plain line with
 * Details; an add closes the form, saying where the forge account stands.
 */
export const AddForge = ({ environmentId, environmentName, computer, close, say }: AddForgeProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [url, setUrl] = useState("");
  // The address as typed now, which a lookup's answer is checked against when it lands.
  const typed = useRef(url);
  const [token, setToken] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const [chosen, setChosen] = useState<AddableKind | undefined>(undefined);
  const [refused, setRefused] = useState<Pick<ForgeRefused, "line" | "details"> | undefined>(undefined);
  const [sending, setSending] = useState(false);

  // The pause the last keystroke started, cancelled by any check: an address checked at once is not asked again.
  const pause = useRef<{ readonly cancel: () => void } | undefined>(undefined);

  const check = (asked: string) => {
    pause.current?.cancel();
    setLookup({ state: "checking" });
    void detectForge(runtime, environmentId, asked).then((detection) => {
      // An answer for an address edited since is for none in the form: it is dropped.
      if (typed.current !== asked) return;
      setLookup(detection.ok ? { state: "found", found: detection.found } : { state: "refused", unrecognised: detection.unrecognised, line: detection.line, details: detection.details });
    });
  };
  // The kind is found once typing pauses.
  useEffect(() => {
    if (url.trim() === "") return;
    const timer = clock.setTimeout(() => check(url), DETECT_PAUSE_MS);
    pause.current = timer;
    return () => timer.cancel();
    // `check` reads only the runtime, the environment, refs and setters beside the address.
  }, [clock, url]);

  const type = (next: string) => {
    typed.current = next;
    setUrl(next);
    // What was found and the kind chosen are for the address they were found at.
    setLookup({ state: "idle" });
    setChosen(undefined);
    setRefused(undefined);
  };

  const origin = normaliseRemote(url.trim())?.origin;
  const found = lookup.state === "found" ? lookup.found : undefined;
  const kind: AddableKind | undefined = found?.kind ?? (lookup.state === "refused" && lookup.unrecognised ? chosen : undefined);
  const site = typedSite(found?.origin ?? url);
  const pages = found?.tokenPages ?? (kind !== undefined && origin !== undefined ? forgeTokenPages(kind, origin) : []);

  // Check address, pressed or Enter before the kind is known: an empty field says what to enter.
  const checkTyped = () => (url.trim() === "" ? setRefused({ line: `Enter an address like ${ADDRESS_EXAMPLE}.`, details: [] }) : check(url));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === undefined) return checkTyped();
    if (token.trim() === "") return setRefused({ line: "Paste the token here.", details: [] });
    setRefused(undefined);
    setSending(true);
    void addPastedForge({ runtime, clock }, environmentId, { url, token, kind }).then((added) => {
      setSending(false);
      // The token stays typed after a refusal (setup-copy.md §1 rule 17); it lives in this form alone.
      if (!added.ok) return setRefused(added);
      close();
      say(added.line);
    });
  };

  return (
    <section aria-label={`Add a forge on ${environmentName}`} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
      <h3 className="text-xs font-semibold">Add a forge on {environmentName}</h3>
      <form aria-label="Add a forge" className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Address of the site or of one of your repositories" description={`For example ${ADDRESS_EXAMPLE}`}>
          <Input autoFocus value={url} placeholder={ADDRESS_EXAMPLE} onChange={(event) => type(event.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {/* Never dimmed for an empty field, which would leave its reason unsaid: the press says what to enter. */}
          <Button icon={RefreshCw} label="Check address" disabled={lookup.state === "checking"} onClick={checkTyped}>
            Check address
          </Button>
        </div>
        {lookup.state === "checking" && <p role="status" className="text-xs text-ink-muted">Checking…</p>}
        {found !== undefined && <p className="text-sm text-ink">{site} runs {FORGE_KIND_WORDS[found.kind]}.</p>}
        {lookup.state === "refused" && lookup.unrecognised && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink">agent-harness does not recognise this site. Choose what it runs:</p>
            <RadioGroup aria-label="What the site runs" value={chosen ?? ""} onValueChange={(next) => setChosen(next as AddableKind)} className="grid grid-cols-3 gap-2">
              {ADDABLE_KINDS.map((each) => (
                <KindRadio.Item key={each} value={each} className="flex min-h-9 items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-xs text-ink-muted aria-checked:border-beam aria-checked:bg-wash-strong aria-checked:text-ink focus-visible:outline-2 focus-visible:outline-beam">
                  <GitPullRequest aria-hidden="true" className="size-4 shrink-0" />
                  {FORGE_KIND_WORDS[each]}
                </KindRadio.Item>
              ))}
            </RadioGroup>
          </div>
        )}
        {lookup.state === "refused" && !lookup.unrecognised && <RefusalLine refused={lookup} computer={environmentName} />}
        {kind !== undefined && (
          <TokenSteps site={site} page={pages[0]}>
            <Field label="Token">
              <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button icon={Plus} label={`Add ${site}`} variant="default" type="submit" disabled={sending}>
                Add {site}
              </Button>
            </div>
            <p className="text-xs text-ink-muted">The token is kept on {computer}, not in this window.</p>
          </TokenSteps>
        )}
        {refused !== undefined && <RefusalLine refused={refused} computer={environmentName} />}
        <div className="flex justify-end gap-2">
          <Button icon={X} label="Cancel" onClick={close}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
};

/**
 * The numbered token steps (setup-copy.md §5.6): create a token on the site,
 * Create a token opening its token page in the OS's browser, with the
 * permissions to give it in that page's words; then paste it, in the field
 * and button `children` draw.
 */
export const TokenSteps = ({ site, page, children }: { readonly site: string; readonly page: ForgeTokenPage | undefined; readonly children: ReactNode }) => (
  <ol aria-label="Token steps" className="flex flex-col gap-3 text-sm">
    <li className="flex flex-col items-start gap-1.5">
      <p className="text-ink">1. Create a token on {site}.</p>
      {page !== undefined && (
        <>
          <ExternalLink url={page.url} label="Create a token" look="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1 text-xs text-ink hover:bg-wash">
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            Create a token
          </ExternalLink>
          <p className="text-ink-muted">Give it these permissions: {tokenPermissionWords(page)}.</p>
        </>
      )}
    </li>
    <li className="flex flex-col gap-2">
      <p className="text-ink">2. Paste the token here.</p>
      {children}
    </li>
  </ol>
);

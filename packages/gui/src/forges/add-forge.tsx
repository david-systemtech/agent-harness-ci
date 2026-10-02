import { FORGE_KIND_WORDS, addFromGh, addFromMachineGh, addPastedForge, detectForge, machineGhAbsence, tokenPageWords, type ForgeOutcome } from "@agent-harness/client-runtime";
import type { ForgeTokenPage, GhProbe, ResultOf } from "@agent-harness/contracts";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Dialog, DialogContent, Field, Input } from "../ui/index.js";
import { ExternalLink } from "../session/external-link.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/**
 * The `gh` paths Add a forge offers (ADR 0032): this computer's `gh`, its
 * token handed over once, and the environment's own, read on every use.
 */
export interface AddForgeGh {
  /** Use the gh signed in on this computer: the Forges row offers it on every environment, the Forges step on a remote one (#589). */
  readonly computer: boolean;
  /** Use this machine's gh, from `forge.gh.probe`: the Forges step's (#589). */
  readonly machine: boolean;
}

export interface AddForgeProps {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly close: () => void;
  /** Says one line in the pane: where the forge account added stands. */
  readonly say: (line: string) => void;
  readonly gh: AddForgeGh;
}

/**
 * Add a forge (forge spec, "Credentials" and "Wire methods"; ADR 0020, ADR
 * 0032; #419): the forge's URL, Find the forge (`forge.detect`) naming its
 * kind and the pages to mint a token on with what to grant it, then either
 * a pasted token, sent once in `forge.accounts.add` and emptied from the
 * form as it is, or, as `gh` says, Use the gh signed in on this computer,
 * the desktop handing its `gh` token over once (absent with its reason
 * where the shell has no `gh`), and Use this machine's gh, the
 * environment's own as `forge.gh.probe` finds it (#589). A refusal stays in
 * the form in one line; an add closes it, saying where the forge account
 * stands.
 */
export const AddForge = ({ environmentId, environmentName, close, say, gh: paths }: AddForgeProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [url, setUrl] = useState("");
  // The URL as typed now, which an answer to Find the forge is checked against when it lands.
  const typed = useRef(url);
  const [token, setToken] = useState("");
  const [found, setFound] = useState<ResultOf<"forge.detect"> | undefined>(undefined);
  const [line, setLine] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const gh = runtime.capability(environmentId, "shell.gh");

  const type = (next: string) => {
    typed.current = next;
    setUrl(next);
    // What was found is for the URL it was found at.
    setFound(undefined);
  };
  /** Sends what adds the forge account, and closes the form once it is added. */
  const add = (adding: () => Promise<ForgeOutcome>) => {
    setLine(undefined);
    setSending(true);
    void adding().then((added) => {
      setSending(false);
      if (!added.ok) return setLine(added.line);
      close();
      say(added.line);
    });
  };
  const find = () => {
    if (url.trim() === "") return setLine("Give the forge's URL.");
    setLine(undefined);
    setSending(true);
    const asked = url;
    void detectForge(runtime, environmentId, asked).then((detection) => {
      setSending(false);
      // An answer for a URL edited since is for none in the form: it is dropped.
      if (typed.current !== asked) return;
      if (!detection.ok) return setLine(detection.line);
      setFound(detection.found);
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() === "") return setLine("Give the forge's URL.");
    if (token.trim() === "") return setLine("Paste the token you minted.");
    const pasted = { url, token, ...(found !== undefined && { kind: found.kind }) };
    // The token leaves the form as it is sent: a refusal asks for it again.
    setToken("");
    add(() => addPastedForge({ runtime, clock }, environmentId, pasted));
  };
  const handOver = () => {
    if (url.trim() === "") return setLine("Give the forge's URL.");
    add(() => addFromGh(runtime, environmentId, url, found?.kind));
  };
  const fromMachineGh = (probe: GhProbe) => {
    if (url.trim() === "") return setLine("Give the forge's URL.");
    add(() => addFromMachineGh({ runtime, clock }, environmentId, environmentName, probe, url, found?.kind));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Add a forge on ${environmentName}`} className="max-w-lg">
        <form aria-label="Add a forge" className="flex flex-col gap-3" onSubmit={submit}>
          <Field label="URL">
            <Input value={url} placeholder="https://github.com" onChange={(event) => type(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={sending} onClick={find}>
              Find the forge
            </Button>
          </div>
          {found !== undefined && (
            <section aria-label="The forge found" className="flex flex-col gap-1 text-sm text-ink">
              <p>
                {FORGE_KIND_WORDS[found.kind]} at {found.origin}
                {found.version === null ? "" : `, version ${found.version}`}.
              </p>
              <TokenPages pages={found.tokenPages} />
            </section>
          )}
          <Field label="Token">
            <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
          </Field>
          <p className="text-xs text-ink-muted">The token goes to {environmentName} once, which keeps it in its vault; this window keeps none.</p>
          {paths.machine && <MachineGh environmentId={environmentId} environmentName={environmentName} sending={sending} onUse={fromMachineGh} />}
          {paths.computer &&
            (gh.status === "present" ? (
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap gap-2">
                  <Button disabled={sending} onClick={handOver}>
                    Use the gh signed in on this computer
                  </Button>
                </div>
                <p className="text-xs text-ink-muted">Its token is handed over once and will not follow gh's rotations.</p>
              </div>
            ) : (
              <p className="text-xs text-ink-muted">{gh.message}</p>
            ))}
          {line !== undefined && <p className="text-sm text-signal">{line}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button tone="primary" type="submit" disabled={sending}>
              Add
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Where to mint a token and what to grant it, each page a link opened in the OS's browser (`forge.detect`'s, or a forge account's own kind's). */
export const TokenPages = ({ pages }: { readonly pages: readonly ForgeTokenPage[] }) => (
  <ul className="flex flex-col gap-1">
    {pages.map((page) => (
      <li key={page.url} className="text-ink-muted">
        {tokenPageWords(page)}: <ExternalLink url={page.url}>{page.url}</ExternalLink>
      </li>
    ))}
  </ul>
);

/**
 * Use this machine's gh (ADR 0032; #589): offered once `forge.gh.probe`,
 * from the request cache, finds the environment's own `gh` installed at the
 * minimum and signed in somewhere; else why not, in one line.
 */
const MachineGh = ({
  environmentId,
  environmentName,
  sending,
  onUse,
}: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly sending: boolean;
  readonly onUse: (probe: GhProbe) => void;
}) => {
  const runtime = useRuntime();
  const probed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "forge.gh.probe", {}), [runtime, environmentId]));
  const probe = probed.result;
  if (probe === null) return null;
  const absent = machineGhAbsence(probe, environmentName);
  if (absent !== null) return <p className="text-xs text-ink-muted">{absent}</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <Button disabled={sending} onClick={() => onUse(probe)}>
          Use this machine's gh
        </Button>
      </div>
      <p className="text-xs text-ink-muted">{environmentName}'s own gh, read on every use, so it follows gh's rotations.</p>
    </div>
  );
};

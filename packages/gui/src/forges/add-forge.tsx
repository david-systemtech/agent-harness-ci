import { FORGE_KIND_WORDS, addFromGh, addPastedForge, detectForge, tokenPageWords, type ForgeOutcome } from "@agent-harness/client-runtime";
import type { ResultOf } from "@agent-harness/contracts";
import { useState, type FormEvent } from "react";
import { Button, Dialog, DialogContent, Field, Input } from "../ui/index.js";
import { ExternalLink } from "../session/external-link.js";
import { useClock, useRuntime } from "../window-context.js";

export interface AddForgeProps {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly close: () => void;
  /** Says one line in the pane: where the forge account added stands. */
  readonly say: (line: string) => void;
}

/**
 * Add a forge (forge spec, "Credentials" and "Wire methods"; ADR 0020, ADR
 * 0032; #419): the forge's URL, Find the forge (`forge.detect`) naming its
 * kind and the pages to mint a token on with what to grant it, then either
 * a pasted token, sent once in `forge.accounts.add` and emptied from the
 * form as it is, or Use the gh signed in on this computer, the desktop
 * handing its `gh` token over once; absent with its reason where the shell
 * has no `gh`. A refusal stays in the form in one line; an add closes it,
 * saying where the forge account stands.
 */
export const AddForge = ({ environmentId, environmentName, close, say }: AddForgeProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [found, setFound] = useState<ResultOf<"forge.detect"> | undefined>(undefined);
  const [line, setLine] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const gh = runtime.capability(environmentId, "shell.gh");

  const type = (next: string) => {
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
    void detectForge(runtime, environmentId, url).then((detection) => {
      setSending(false);
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
              <ul className="flex flex-col gap-1">
                {found.tokenPages.map((page) => (
                  <li key={page.url} className="text-ink-muted">
                    {tokenPageWords(page)}: <ExternalLink url={page.url}>{page.url}</ExternalLink>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Field label="Token">
            <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
          </Field>
          <p className="text-xs text-ink-muted">The token goes to {environmentName} once, which keeps it in its vault; this window keeps none.</p>
          {gh.status === "present" ? (
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
          )}
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

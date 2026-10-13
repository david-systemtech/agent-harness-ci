import { uuidv4 } from "@agent-harness/client-runtime";
import { GITHUB_ORIGIN, REPORT_FILE_BYTES, REPORT_TOTAL_BYTES, REPORT_MEDIA_TYPES, type ParamsOf } from "@agent-harness/contracts";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Dialog, DialogContent, Button, Input, Select, Textarea } from "./ui/index.js";
import { ExternalLink } from "./session/external-link.js";
import { useClientVersion, useObservable, usePresentation, useRuntime, useShell } from "./window-context.js";

const encodeFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("The attachment could not be read."));
  reader.onerror = () => reject(new Error("The attachment could not be read."));
  reader.readAsDataURL(file);
});

type Report = ParamsOf<"reports.submit">["report"];
type Level = Report["level"];

export const ReportDialog = ({ close }: { readonly close: () => void }) => {
  const runtime = useRuntime();
  const version = useClientVersion();
  const shell = useShell();
  const environments = useObservable(runtime.projections.environments);
  const [environmentId, setEnvironment] = useState(() => environments.find((view) => view.phase === "ready")?.environmentId ?? environments[0]?.environmentId ?? "");
  const [remembered, remember] = usePresentation("reporterName");
  const [name, setName] = useState(remembered);
  const [kind, setKind] = useState<Report["kind"]>("bug");
  const [level, setLevel] = useState<Level>("major");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [busy, setBusy] = useState(false);
  const [line, say] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<{ number: number; url: string } | null>(null);
  // A retry after a lost reply uses the same command id and exact payload.
  const pending = useRef<{ environmentId: string; params: ParamsOf<"reports.submit"> } | null>(null);
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "forge.accounts.list", {}), [runtime, environmentId]));
  const github = listed.result?.accounts.some((account) => account.kind === "github" && account.origin === GITHUB_ORIGIN && account.identity !== null && account.credential.kind !== "none") ?? false;
  const capability = runtime.capability(environmentId, "reports.submit");
  const canSubmit = github && capability.status === "present";
  const retry = pending.current !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true);
    say("");
    try {
      if (pending.current === null) {
        if (files.length > 4 || files.some((file) => file.size > REPORT_FILE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > REPORT_TOTAL_BYTES) throw new Error("Choose at most 4 attachments, 5 MiB each and 9 MiB total.");
        const attachments: Report["attachments"] = [];
        for (const file of files) {
          const mediaType = REPORT_MEDIA_TYPES.find((allowed) => allowed === file.type);
          if (mediaType === undefined) throw new Error("Use PNG, JPEG, GIF, WebP, MP4, WebM or MOV attachments.");
          attachments.push({ name: file.name.replace(/[^\w .()-]/g, "_").slice(0, 120) || "attachment", mediaType, content: await encodeFile(file) });
        }
        const fields = { name: name.trim(), description: description.trim(), client: { version, kind: shell === undefined ? "web" as const : "desktop" as const }, attachments };
        const report: Report = kind === "bug" ? { ...fields, kind, level: level as "critical" | "major" | "minor" } : { ...fields, kind, level: level as "high" | "medium" | "low" };
        pending.current = { environmentId, params: { commandId: uuidv4(), report } };
        remember(name.trim());
      }
      const answer = await runtime.requests.call(pending.current.environmentId, "reports.submit", pending.current.params);
      if (!answer.ok) {
        if (!["timeout", "unreachable", "malformed"].includes(answer.error.code)) pending.current = null;
        say(answer.error.message);
      } else if (answer.result.receipt.status === "rejected") {
        pending.current = null;
        say(answer.result.receipt.error.message);
      } else {
        setSubmitted(true);
        setResult(answer.result.result ?? null);
        say(answer.result.result === undefined ? "This report was already submitted. Find it in the public repository's issues." : "Report submitted.");
        pending.current = null;
      }
    } catch (error) { say(error instanceof Error ? error.message : "The report could not be submitted."); }
    finally { setBusy(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent title="Report bug / Request feature" description="Reports and attachments are public. Review them before submitting." className="max-h-[calc(100dvh-4rem)] overflow-y-auto">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <fieldset disabled={busy || retry || submitted} className="flex flex-col gap-3">
          <label>Environment<Select aria-label="Environment" value={environmentId} onChange={(event) => setEnvironment(event.target.value)}>{environments.map((view) => <option key={view.environmentId} value={view.environmentId}>{view.name ?? "This machine"}</option>)}</Select></label>
          <label>Type<Select aria-label="Type" value={kind} onChange={(event) => { const next = event.target.value === "feature" ? "feature" : "bug"; setKind(next); setLevel(next === "bug" ? "major" : "medium"); }}><option value="bug">Bug</option><option value="feature">Feature</option></Select></label>
          <label>{kind === "bug" ? "Severity" : "Importance"}<Select aria-label={kind === "bug" ? "Severity" : "Importance"} value={level} onChange={(event) => setLevel(event.target.value as Level)}>{(kind === "bug" ? ["critical", "major", "minor"] : ["high", "medium", "low"]).map((value) => <option key={value} value={value}>{value}</option>)}</Select></label>
          <label>Your name<Input aria-label="Your name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Description<Textarea aria-label="Description" required maxLength={20000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>Screenshots or videos<Input aria-label="Screenshots or videos" type="file" accept={REPORT_MEDIA_TYPES.join(",")} multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /></label>
          <p className="text-xs text-ink-muted">Up to 4 files, 5 MiB each, 9 MiB total. Attachments are committed to a public agent-harness-report-attachments repository in your GitHub account. Submitting creates it if needed. Uploaded files remain public even if posting the issue fails.</p>
        </fieldset>
        {!github && <p role="status">{listed.loading ? "Checking the environment's GitHub account…" : "Connect a GitHub account in Settings → Forges on this environment to submit a report."}</p>}
        {capability.status === "absent" && <p role="status">{capability.message}</p>}
        {line && <p role="status">{line}</p>}
        {result !== null && <ExternalLink url={result.url} label={`Open issue #${result.number}`}>Open issue #{result.number}</ExternalLink>}
        <div className="flex justify-end gap-2"><Button type="button" disabled={busy} onClick={close}>Close</Button><Button type="submit" disabled={!canSubmit || busy || submitted}>{busy ? "Submitting…" : retry ? "Retry report" : "Submit report"}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
};

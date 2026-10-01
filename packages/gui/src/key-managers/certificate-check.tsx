import { caWords, certificateFacts, previewCertificate, type CertificatePreview } from "@agent-harness/client-runtime";
import { useEffect, useState } from "react";
import { Button, Dialog, DialogContent } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

export interface CertificateCheckProps {
  readonly environmentId: string;
  /** The key manager's address, whose certificate is read. */
  readonly address: string;
  /** Pins the anchor a person accepted, as PEM. */
  readonly trust: (pem: string) => void;
  readonly close: () => void;
}

/**
 * The certificate a key manager presents, before a person trusts it
 * (key-managers spec, "Providers"; #425): `keyManagers.certificate.preview`
 * read as the check opens, its anchor's SHA-256 fingerprint, subject, names,
 * expiry and whether it signs itself shown, and Trust this certificate
 * handing its PEM on to be pinned. Nothing is pinned without that press.
 */
export const CertificateCheck = ({ environmentId, address, trust, close }: CertificateCheckProps) => {
  const runtime = useRuntime();
  const now = useClock().now();
  const [preview, setPreview] = useState<CertificatePreview | undefined>(undefined);
  useEffect(() => {
    void previewCertificate(runtime, environmentId, address).then(setPreview);
  }, [runtime, environmentId, address]);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`The certificate ${address} presents`} className="max-w-lg">
        {preview === undefined && <p className="text-sm text-ink-faint">Reading its certificate…</p>}
        {preview?.ok === false && <p className="text-sm text-signal">{preview.line}</p>}
        {preview?.ok === true && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {certificateFacts(preview.certificate, now).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-ink-muted">{name}</dt>
                <dd className="min-w-0 break-all font-mono text-xs text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button
            tone="primary"
            disabled={preview?.ok !== true}
            onClick={() => {
              if (preview?.ok === true) trust(preview.certificate.pem);
              close();
            }}
          >
            Trust this certificate
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export interface CaChoiceProps {
  readonly environmentId: string;
  /** The address typed, whose certificate is read. */
  readonly address: string;
  /** The CA chosen, as PEM; null for none. */
  readonly ca: string | null;
  readonly choose: (ca: string | null) => void;
}

/**
 * The CA an OpenBao connection is to pin, in a form (key-managers spec,
 * "Providers"; ADR 0028; #425, #590): whether one is chosen, Read its
 * certificate, which shows the preview of the certificate an `https`
 * address presents (`CertificateCheck`) and chooses its anchor once a
 * person trusts it, and Unpin the CA. The form sends what is chosen.
 */
export const CaChoice = ({ environmentId, address, ca, choose }: CaChoiceProps) => {
  const [checking, setChecking] = useState(false);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-ink">CA</span>
      <span className="text-ink-muted">{caWords({ provider: "openbao", ca })}</span>
      <div className="flex gap-2">
        <Button disabled={!address.trim().startsWith("https://")} onClick={() => setChecking(true)}>
          Read its certificate
        </Button>
        {ca !== null && <Button onClick={() => choose(null)}>Unpin the CA</Button>}
      </div>
      {checking && <CertificateCheck environmentId={environmentId} address={address.trim()} trust={choose} close={() => setChecking(false)} />}
    </div>
  );
};

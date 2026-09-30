import {
  KEY_MANAGER_ADDRESS_PRESETS,
  KEY_MANAGER_LABEL_PRESETS,
  KEY_MANAGER_METHOD_WORDS,
  KEY_MANAGER_PROVIDER_WORDS,
  addConnection,
  credentialOf,
  formProblem,
  type TypedCredential,
} from "@agent-harness/client-runtime";
import { KEY_MANAGER_AUTH_METHODS, KEY_MANAGER_PROVIDERS, type KeyManagerAuthMethod, type KeyManagerProvider } from "@agent-harness/contracts";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Dialog, DialogContent, Input, Select } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** A field of a form: its name over its control. */
export const Field = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <label className="flex flex-col gap-1 text-sm text-ink">
    {label}
    {children}
  </label>
);

/** No credential typed. */
export const NO_CREDENTIAL: TypedCredential = { roleId: "", secretId: "", password: "", token: "" };

/**
 * The fields of a credential for how a connection signs in: an AppRole's
 * role id and secret id, a userpass password, or a token (every provider
 * but OpenBao takes one). What is typed is held only while the form is open
 * and emptied once it is sent.
 */
export const CredentialFields = ({
  provider,
  method,
  typed,
  type,
}: {
  readonly provider: KeyManagerProvider;
  readonly method: KeyManagerAuthMethod;
  readonly typed: TypedCredential;
  readonly type: (typed: TypedCredential) => void;
}) => {
  const secret = (label: string, key: keyof TypedCredential) => (
    <Field label={label}>
      <Input type="password" autoComplete="off" value={typed[key]} onChange={(event) => type({ ...typed, [key]: event.target.value })} />
    </Field>
  );
  if (provider !== "openbao" || method === "token") return secret("Token", "token");
  if (method === "userpass") return secret("Password", "password");
  return (
    <>
      <Field label="Role ID">
        <Input autoComplete="off" value={typed.roleId} onChange={(event) => type({ ...typed, roleId: event.target.value })} />
      </Field>
      {secret("Secret ID", "secretId")}
    </>
  );
};

export interface AddConnectionProps {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly close: () => void;
  /** Says one line in the pane: where the connection added stands. */
  readonly say: (line: string) => void;
}

/**
 * Add a key manager (key-managers spec, "Wire methods"; ADR 0028; #425):
 * the provider, a label, the address (preset for Doppler and Bitwarden),
 * and for OpenBao how it signs in, the mount (preset the method's name,
 * following it until typed at), the username for userpass and an optional
 * token role; then the credential. Add sends `keyManagers.connections.add`
 * directly; a refusal stays in the form in one line with the secret
 * emptied, and an add closes it, saying where the connection stands.
 */
export const AddConnection = ({ environmentId, environmentName, close, say }: AddConnectionProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [provider, setProvider] = useState<KeyManagerProvider>("openbao");
  const [label, setLabel] = useState(KEY_MANAGER_LABEL_PRESETS.openbao);
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState<KeyManagerAuthMethod>("approle");
  const [mount, setMount] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [tokenRole, setTokenRole] = useState("");
  const [typed, setTyped] = useState<TypedCredential>(NO_CREDENTIAL);
  const [line, setLine] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const openBao = provider === "openbao";

  const choose = (next: KeyManagerProvider) => {
    // A preset the person has not typed over follows the provider.
    if (label === KEY_MANAGER_LABEL_PRESETS[provider]) setLabel(KEY_MANAGER_LABEL_PRESETS[next]);
    if (address === KEY_MANAGER_ADDRESS_PRESETS[provider]) setAddress(KEY_MANAGER_ADDRESS_PRESETS[next]);
    setProvider(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const credential = credentialOf(provider, method, typed);
    const form = { provider, label, address, method, mount: mount ?? method, username, tokenRole };
    const problem = formProblem(form, credential);
    if (problem !== undefined) return setLine(problem);
    setLine(undefined);
    setSending(true);
    // The secret leaves the form as it is sent: a refusal asks for it again.
    setTyped({ ...NO_CREDENTIAL, roleId: typed.roleId });
    void addConnection({ runtime, clock }, environmentId, form, credential).then((added) => {
      setSending(false);
      if (!added.ok) return setLine(added.line);
      close();
      say(added.line);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Add a key manager on ${environmentName}`} className="max-w-lg">
        <form aria-label="Add a key manager" className="flex flex-col gap-3" onSubmit={submit}>
          <Field label="Provider">
            <Select value={provider} onChange={(event) => choose(event.target.value as KeyManagerProvider)}>
              {KEY_MANAGER_PROVIDERS.map((each) => (
                <option key={each} value={each}>
                  {KEY_MANAGER_PROVIDER_WORDS[each]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="Address">
            <Input value={address} placeholder={openBao ? "https://bao.example.com:8200" : undefined} onChange={(event) => setAddress(event.target.value)} />
          </Field>
          {openBao && (
            <>
              <Field label="Signs in by">
                <Select value={method} onChange={(event) => setMethod(event.target.value as KeyManagerAuthMethod)}>
                  {KEY_MANAGER_AUTH_METHODS.map((each) => (
                    <option key={each} value={each}>
                      {KEY_MANAGER_METHOD_WORDS[each]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Mount">
                <Input value={mount ?? method} onChange={(event) => setMount(event.target.value)} />
              </Field>
              {method === "userpass" && (
                <Field label="Username">
                  <Input value={username} onChange={(event) => setUsername(event.target.value)} />
                </Field>
              )}
              <Field label="Token role (optional)">
                <Input value={tokenRole} onChange={(event) => setTokenRole(event.target.value)} />
              </Field>
            </>
          )}
          <CredentialFields provider={provider} method={method} typed={typed} type={setTyped} />
          {!openBao && <p className="text-xs text-ink-muted">Create a read-only token for it: runs receive this token as it is.</p>}
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

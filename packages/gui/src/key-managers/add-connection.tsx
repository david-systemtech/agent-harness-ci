import { LogIn, Plus, X } from "lucide-react";
import { ActionButton as Button, AccessField as Field } from "./action-button.js";
import { RadioGroup as ProviderRadio } from "radix-ui";
import { Vault } from "lucide-react";
import {
  KEY_MANAGER_ADDRESS_PRESETS,
  KEY_MANAGER_LABEL_PRESETS,
  KEY_MANAGER_METHOD_WORDS,
  KEY_MANAGER_PROVIDER_WORDS,
  addConnection,
  asksAddress,
  credentialOf,
  formProblem,
  type TypedCredential,
} from "@agent-harness/client-runtime";
import { KEY_MANAGER_AUTH_METHODS, KEY_MANAGER_PROVIDERS, type KeyManagerAuthMethod, type KeyManagerProvider } from "@agent-harness/contracts";
import { useState, type FormEvent } from "react";
import { Input, Select, RadioGroup, Tooltip } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { CaChoice } from "./certificate-check.js";

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

export interface SignInFormProps {
  readonly environmentId: string;
  /** The providers it adds: every one in inline Add, which offers a choice of them; a provider's own on its tile. */
  readonly providers: readonly [KeyManagerProvider, ...KeyManagerProvider[]];
  /** What the form is called. */
  readonly name: string;
  /** What its send button says: Add, or Sign in. */
  readonly send: string;
  /** Lets the form go: Cancel, and an add. */
  readonly close: () => void;
  /** Says one line where the form was opened: where the connection added stands. */
  readonly say: (line: string) => void;
}

/**
 * A key manager's sign-in form (key-managers spec, "Wire methods"; ADR 0028;
 * #425, #590): the provider where it offers more than one, a label, the
 * address (preset for Doppler and Bitwarden; none for 1Password, whose token
 * names it, #1118), and for OpenBao the CA it is
 * to pin, read from the certificate the address presents (`CaChoice`), how
 * it signs in, the mount (preset the method's name, following it until
 * typed at), the username for userpass and an optional token role; then the
 * credential. Its send button sends `keyManagers.connections.add` directly;
 * a refusal stays in the form in one line with the secret emptied, and an
 * add lets it go, saying where the connection stands.
 */
export const SignInForm = ({ environmentId, providers, name, send, close, say }: SignInFormProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [provider, setProvider] = useState<KeyManagerProvider>(providers[0]);
  const [label, setLabel] = useState(KEY_MANAGER_LABEL_PRESETS[providers[0]]);
  const [address, setAddress] = useState(KEY_MANAGER_ADDRESS_PRESETS[providers[0]]);
  const [ca, setCa] = useState<string | null>(null);
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
    const form = { provider, label, address, method, mount: mount ?? method, username, tokenRole, ca: openBao ? ca : null };
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
    <form aria-label={name} className="flex flex-col gap-3" onSubmit={submit}>
      {providers.length > 1 && (
        <RadioGroup aria-label="Provider" value={provider} onValueChange={(next) => choose(next as KeyManagerProvider)} className="grid grid-cols-2 gap-2">
          {providers.map((each) => (
            <Tooltip key={each} content={KEY_MANAGER_PROVIDER_WORDS[each]} keys="Arrow keys to choose">
              <ProviderRadio.Item autoFocus={each === providers[0]} value={each} className="flex min-h-9 items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-xs text-ink-muted aria-checked:border-beam aria-checked:bg-wash-strong aria-checked:text-ink focus-visible:outline-2 focus-visible:outline-beam">
                <Vault aria-hidden="true" className="size-4 shrink-0" />
                {KEY_MANAGER_PROVIDER_WORDS[each]}
              </ProviderRadio.Item>
            </Tooltip>
          ))}
        </RadioGroup>
      )}
      <Field label="Label">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      {asksAddress(provider) ? (
        <Field label="Address">
          <Input value={address} placeholder={openBao ? "https://keys.example.test" : undefined} onChange={(event) => setAddress(event.target.value)} />
        </Field>
      ) : (
        <p className="text-xs text-ink-muted">No address: it is the account URL the token names, learned at sign-in.</p>
      )}
      {openBao && (
        <>
          <CaChoice environmentId={environmentId} address={address} ca={ca} choose={setCa} />
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
        <Button icon={X} label="Cancel" onClick={close}>Cancel</Button>
        <Button icon={send === "Add" ? Plus : LogIn} label={send} variant="default" type="submit" disabled={sending}>
          {send}
        </Button>
      </div>
    </form>
  );
};

export interface AddConnectionProps {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly close: () => void;
  /** Says one line in the pane: where the connection added stands. */
  readonly say: (line: string) => void;
}

/** Add inline, offering every provider with OpenBao selected first. */
export const AddConnection = ({ environmentId, environmentName, close, say }: AddConnectionProps) => (
  <section aria-label={`Add a key manager on ${environmentName}`} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
    <h3 className="text-xs font-semibold">Add a key manager on {environmentName}</h3>
    <SignInForm environmentId={environmentId} providers={KEY_MANAGER_PROVIDERS} name="Add a key manager" send="Add" close={close} say={say} />
  </section>
);

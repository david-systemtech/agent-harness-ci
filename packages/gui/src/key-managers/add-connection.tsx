import { LogIn, X } from "lucide-react";
import { ActionButton as Button, AccessField as Field } from "./action-button.js";
import { RadioGroup as ProviderRadio } from "radix-ui";
import { Vault } from "lucide-react";
import {
  KEY_MANAGER_ADDRESS_PRESETS,
  KEY_MANAGER_LABEL_PRESETS,
  KEY_MANAGER_PROVIDER_NAMES,
  KEY_MANAGER_PROVIDER_WORDS,
  addConnection,
  asksAddress,
  connectWords,
  credentialOf,
  formProblem,
  type TypedCredential,
} from "@agent-harness/client-runtime";
import { KEY_MANAGER_PROVIDERS, type KeyManagerAuthMethod, type KeyManagerProvider } from "@agent-harness/contracts";
import { useState, type FormEvent } from "react";
import { MoreOptions } from "../setup/more-options.js";
import { Input, RadioGroup, RadioGroupItem, Tooltip } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { CaChoice } from "./certificate-check.js";
import { RefusalLine } from "./refusal-line.js";

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
  /** The providers it connects: every one in Settings' Add, which offers a choice of them; the one chosen on the Key manager card. */
  readonly providers: readonly [KeyManagerProvider, ...KeyManagerProvider[]];
  /** What the form is called; `Connect {provider}` unless named. */
  readonly name?: string;
  /** Whether this client may send it: the environment reached, with `admin`. */
  readonly writable?: boolean;
  /** Hears a connection saved, with the one line saying where it stands. */
  readonly saved: (line: string) => void;
  /** Hears the code of a refusal of a provider (`provider_unavailable` marks the card's choice). */
  readonly refused?: (provider: KeyManagerProvider, code: string | undefined) => void;
  /** Lets the form go, where it can be: Cancel. */
  readonly cancel?: () => void;
}

/** How you sign in to OpenBao, in setup-copy.md §5.7's words and order, a token first. */
const SIGN_IN_WAYS: readonly (readonly [KeyManagerAuthMethod, string])[] = [
  ["token", "With a token"],
  ["approle", "With AppRole"],
  ["userpass", "With a username and password"],
];

/** `How do you sign in?` to OpenBao (setup-copy.md §5.7): with a token, with AppRole, or with a username and password. */
export const SignInWay = ({ method, choose }: { readonly method: KeyManagerAuthMethod; readonly choose: (method: KeyManagerAuthMethod) => void }) => (
  <div className="flex flex-col gap-2 text-sm">
    <span className="font-medium text-ink">How do you sign in?</span>
    <RadioGroup aria-label="How do you sign in?" value={method} onValueChange={(next) => choose(next as KeyManagerAuthMethod)} className="gap-1.5">
      {SIGN_IN_WAYS.map(([way, words]) => (
        <label key={way} className="flex items-center gap-2.5 text-sm text-ink">
          <Tooltip content={words} keys="Arrow keys to choose">
            <RadioGroupItem value={way} aria-label={words} />
          </Tooltip>
          {words}
        </label>
      ))}
    </RadioGroup>
  </div>
);

/** A refusal or a problem the form said, with the raw words for Details. */
interface Said {
  readonly line: string;
  readonly details?: readonly string[] | undefined;
}

/**
 * A key manager's connect form (setup-copy.md §5.7; key-managers spec,
 * "Wire methods"; ADR 0028; #425, #590, #1851): the provider where it offers
 * more than one; for OpenBao its address with the hint, `How do you sign
 * in?` with a token chosen, and the fields for that way, the username for a
 * username and password; for the others a read-only token alone. More
 * options holds what most people never change: the name (preset the
 * provider's), the address Doppler and Bitwarden are preset to (1Password's
 * token names its own, #1118), and OpenBao's mount (preset the way's name,
 * following it until typed at), token role and the certificate it is to
 * trust, read from the one the address presents (`CaChoice`). Connect
 * {provider} sends `keyManagers.connections.add` directly; a refusal stays in
 * the form as an alert with its Details, what was typed kept but the secret,
 * and a connection saved lets it go, saying where it stands.
 */
export const SignInForm = ({ environmentId, providers, name, writable = true, saved, refused, cancel }: SignInFormProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [provider, setProvider] = useState<KeyManagerProvider>(providers[0]);
  const [label, setLabel] = useState(KEY_MANAGER_LABEL_PRESETS[providers[0]]);
  const [address, setAddress] = useState(KEY_MANAGER_ADDRESS_PRESETS[providers[0]]);
  const [ca, setCa] = useState<string | null>(null);
  const [method, setMethod] = useState<KeyManagerAuthMethod>("token");
  const [mount, setMount] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [tokenRole, setTokenRole] = useState("");
  const [typed, setTyped] = useState<TypedCredential>(NO_CREDENTIAL);
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const openBao = provider === "openbao";
  const providerName = KEY_MANAGER_PROVIDER_NAMES[provider];
  const connect = connectWords(provider);

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
    if (problem !== undefined) return setSaid({ line: problem });
    setSaid(undefined);
    setSending(true);
    // The secret leaves the form as it is sent: a refusal asks for it again.
    setTyped({ ...NO_CREDENTIAL, roleId: typed.roleId });
    void addConnection({ runtime, clock }, environmentId, form, credential).then((added) => {
      setSending(false);
      if (added.ok) return saved(added.line);
      setSaid(added);
      refused?.(provider, added.code);
    });
  };

  return (
    <form aria-label={name ?? connect} className="flex flex-col gap-3" onSubmit={submit}>
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
      {openBao ? (
        <>
          <Field label="Address" description="The address you open it at, like https://vault.example.com">
            <Input value={address} onChange={(event) => setAddress(event.target.value)} />
          </Field>
          <SignInWay method={method} choose={setMethod} />
          {method === "userpass" && (
            <Field label="Username">
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </Field>
          )}
        </>
      ) : (
        <p className="text-sm text-ink-muted">Create a read-only token in {providerName} and paste it here.</p>
      )}
      <CredentialFields provider={provider} method={method} typed={typed} type={setTyped} />
      <MoreOptions step="key-manager">
        <Field label="Name">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        {!openBao && asksAddress(provider) && (
          <Field label="Address">
            <Input value={address} onChange={(event) => setAddress(event.target.value)} />
          </Field>
        )}
        {openBao && (
          <>
            <Field label="Mount">
              <Input value={mount ?? method} onChange={(event) => setMount(event.target.value)} />
            </Field>
            <Field label="Token role (optional)">
              <Input value={tokenRole} onChange={(event) => setTokenRole(event.target.value)} />
            </Field>
            <CaChoice environmentId={environmentId} address={address} ca={ca} choose={setCa} />
          </>
        )}
      </MoreOptions>
      {said !== undefined && <RefusalLine line={said.line} details={said.details} />}
      <div className="flex justify-end gap-2">
        {cancel !== undefined && <Button icon={X} label="Cancel" onClick={cancel}>Cancel</Button>}
        <Button icon={LogIn} label={connect} variant="default" type="submit" disabled={!writable || sending}>
          {connect}
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
    <SignInForm
      environmentId={environmentId}
      providers={KEY_MANAGER_PROVIDERS}
      name="Add a key manager"
      saved={(line) => {
        close();
        say(line);
      }}
      cancel={close}
    />
  </section>
);

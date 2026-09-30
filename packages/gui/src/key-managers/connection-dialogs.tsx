import {
  KEY_MANAGER_METHOD_WORDS,
  caWords,
  credentialOf,
  credentialTyped,
  removeConnection,
  signInAgain,
  signOutConnection,
  updateConnection,
  type ConnectionChanges,
  type TypedCredential,
} from "@agent-harness/client-runtime";
import { KEY_MANAGER_AUTH_METHODS, type KeyManagerAuthMethod, type KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { useState, type FormEvent } from "react";
import { Button, Dialog, DialogClose, DialogContent, Input, Select } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { CredentialFields, Field, NO_CREDENTIAL } from "./add-connection.js";
import { CertificateCheck } from "./certificate-check.js";

/** What every dialog of a card is given: the connection, where it is, and how to close it and say what it did in the pane. */
export interface ConnectionDialogProps {
  readonly environmentId: string;
  readonly connection: KeyManagerConnectionRecord;
  readonly close: () => void;
  readonly say: (line: string) => void;
}

/** The runtime and clock the key-manager actions are sent with. */
const useSender = () => ({ runtime: useRuntime(), clock: useClock() });

/**
 * Sign in, or sign in again (`keyManagers.connections.signIn`, sent
 * directly): how it signs in, preset to the connection's method, the
 * username for userpass, and the credential. A refusal stays in the form
 * in one line, the secret emptied; a sign-in closes it.
 */
export const SignInAgain = ({ environmentId, connection, close, say, again }: ConnectionDialogProps & { readonly again: boolean }) => {
  const sender = useSender();
  const [method, setMethod] = useState<KeyManagerAuthMethod>(connection.method ?? "token");
  const [username, setUsername] = useState(connection.username ?? "");
  const [typed, setTyped] = useState<TypedCredential>(NO_CREDENTIAL);
  const [line, setLine] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const openBao = connection.provider === "openbao";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const credential = credentialOf(connection.provider, method, typed);
    if (!credentialTyped(credential)) return setLine("Give the credential it signs in with.");
    if (credential.method === "userpass" && username.trim() === "") return setLine("Give the username it signs in as.");
    setLine(undefined);
    setSending(true);
    setTyped({ ...NO_CREDENTIAL, roleId: typed.roleId });
    void signInAgain(sender, environmentId, connection, credential, username).then((signed) => {
      setSending(false);
      if (!signed.ok) return setLine(signed.line);
      close();
      say(signed.line);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={again ? `Sign in to ${connection.label} again` : `Sign in to ${connection.label}`} className="max-w-lg">
        <form aria-label="Sign in again" className="flex flex-col gap-3" onSubmit={submit}>
          {openBao && (
            <Field label="Signs in by">
              <Select value={method} onChange={(event) => setMethod(event.target.value as KeyManagerAuthMethod)}>
                {KEY_MANAGER_AUTH_METHODS.map((each) => (
                  <option key={each} value={each}>
                    {KEY_MANAGER_METHOD_WORDS[each]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {openBao && method === "userpass" && (
            <Field label="Username">
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </Field>
          )}
          <CredentialFields provider={connection.provider} method={method} typed={typed} type={setTyped} />
          {line !== undefined && <p className="text-sm text-signal">{line}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button tone="primary" type="submit" disabled={sending}>
              Sign in
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Edit (`keyManagers.connections.update`): the label, the address, the token
 * role and the CA, pinned from the certificate the address presents once a
 * person trusts it, or unpinned. Save sends only what changed; a new address
 * or CA is signed in against by the environment first, and a refusal stays
 * in the form in one line.
 */
export const EditConnection = ({ environmentId, connection, close, say }: ConnectionDialogProps) => {
  const sender = useSender();
  const [label, setLabel] = useState(connection.label);
  const [address, setAddress] = useState(connection.address);
  const [tokenRole, setTokenRole] = useState(connection.tokenRole ?? "");
  const [ca, setCa] = useState<string | null>(connection.ca);
  const [checking, setChecking] = useState(false);
  const [line, setLine] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const openBao = connection.provider === "openbao";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const role = tokenRole.trim() === "" ? null : tokenRole.trim();
    const changes: ConnectionChanges = {
      ...(label.trim() !== connection.label && { label: label.trim() }),
      ...(address.trim() !== connection.address && { address: address.trim() }),
      ...(openBao && role !== connection.tokenRole && { tokenRole: role }),
      ...(ca !== connection.ca && { ca }),
    };
    if (Object.keys(changes).length === 0) return close();
    setLine(undefined);
    setSending(true);
    void updateConnection(sender, environmentId, connection, changes).then((updated) => {
      setSending(false);
      if (!updated.ok) return setLine(updated.line);
      close();
      say(updated.line);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Edit ${connection.label}`} className="max-w-lg">
        <form aria-label="Edit" className="flex flex-col gap-3" onSubmit={submit}>
          <Field label="Label">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="Address">
            <Input value={address} onChange={(event) => setAddress(event.target.value)} />
          </Field>
          {openBao && (
            <>
              <Field label="Token role (optional)">
                <Input value={tokenRole} onChange={(event) => setTokenRole(event.target.value)} />
              </Field>
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-ink">CA</span>
                <span className="text-ink-muted">{caWords({ provider: connection.provider, ca })}</span>
                <div className="flex gap-2">
                  <Button disabled={!address.trim().startsWith("https://")} onClick={() => setChecking(true)}>
                    Read its certificate
                  </Button>
                  {ca !== null && <Button onClick={() => setCa(null)}>Unpin the CA</Button>}
                </div>
              </div>
            </>
          )}
          {line !== undefined && <p className="text-sm text-signal">{line}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button tone="primary" type="submit" disabled={sending}>
              Save
            </Button>
          </div>
        </form>
        {checking && <CertificateCheck environmentId={environmentId} address={address.trim()} trust={setCa} close={() => setChecking(false)} />}
      </DialogContent>
    </Dialog>
  );
};

/** Sign out, once confirmed (`keyManagers.connections.signOut`). */
export const ConfirmSignOut = ({ environmentId, connection, close, say }: ConnectionDialogProps) => {
  const sender = useSender();
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={`Sign out of ${connection.label}?`}
        description="The environment revokes its login and deletes the credential it keeps; runs no longer receive its variables until it is signed in again."
      >
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            tone="danger"
            onClick={() => {
              close();
              void signOutConnection(sender, environmentId, connection).then((out) => say(out.line));
            }}
          >
            Sign out
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Remove, once confirmed (`keyManagers.connections.remove`). When references
 * name the connection the refusal says who holds them, and Remove anyway
 * removes it all the same, leaving them unable to resolve.
 */
export const ConfirmRemove = ({ environmentId, connection, close, say }: ConnectionDialogProps) => {
  const sender = useSender();
  const [refused, setRefused] = useState<{ readonly line: string; readonly referenced: boolean } | undefined>(undefined);
  const remove = (force: boolean) =>
    void removeConnection(sender, environmentId, connection, force).then((removed) => {
      if (!removed.ok) return setRefused(removed);
      close();
      say(removed.line);
    });
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Remove ${connection.label}?`} description="The environment revokes its login and deletes the credential it keeps, and holds the connection no more.">
        {refused !== undefined && <p className="text-sm text-signal">{refused.line}</p>}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          {refused?.referenced === true ? (
            <Button tone="danger" onClick={() => remove(true)}>
              Remove anyway
            </Button>
          ) : (
            <Button tone="danger" onClick={() => remove(false)}>
              Remove
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

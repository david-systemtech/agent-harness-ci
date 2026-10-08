import { LogIn, LogOut, Pencil, Trash2, X } from "lucide-react";
import { ActionButton as Button, AccessField as Field } from "./action-button.js";
import {
  asksAddress,
  credentialOf,
  credentialTyped,
  removeConnection,
  signInAgain,
  signOutConnection,
  updateConnection,
  type ConnectionChanges,
  type TypedCredential,
} from "@agent-harness/client-runtime";
import type { KeyManagerAuthMethod, KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { useState, type FormEvent } from "react";
import { Dialog, DialogClose, DialogContent, Input } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { CredentialFields, NO_CREDENTIAL, SignInWay } from "./add-connection.js";
import { CaChoice } from "./certificate-check.js";
import { RefusalLine } from "./refusal-line.js";

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
 * as an alert with its Details, the secret emptied; a sign-in closes it.
 */
export const SignInAgain = ({ environmentId, connection, close, say, again }: ConnectionDialogProps & { readonly again: boolean }) => {
  const sender = useSender();
  const [method, setMethod] = useState<KeyManagerAuthMethod>(connection.method ?? "token");
  const [username, setUsername] = useState(connection.username ?? "");
  const [typed, setTyped] = useState<TypedCredential>(NO_CREDENTIAL);
  const [said, setSaid] = useState<{ readonly line: string; readonly details?: readonly string[] | undefined } | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const openBao = connection.provider === "openbao";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const credential = credentialOf(connection.provider, method, typed);
    if (!credentialTyped(credential)) return setSaid({ line: "Give the credential it signs in with." });
    if (credential.method === "userpass" && username.trim() === "") return setSaid({ line: "Give the username it signs in as." });
    setSaid(undefined);
    setSending(true);
    setTyped({ ...NO_CREDENTIAL, roleId: typed.roleId });
    void signInAgain(sender, environmentId, connection, credential, username).then((signed) => {
      setSending(false);
      if (!signed.ok) return setSaid(signed);
      close();
      say(signed.line);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={again ? `Sign in to ${connection.label} again` : `Sign in to ${connection.label}`} className="max-w-lg">
        <form aria-label={again ? "Sign in again" : "Sign in"} className="flex flex-col gap-3" onSubmit={submit}>
          {openBao && <SignInWay method={method} choose={setMethod} />}
          {openBao && method === "userpass" && (
            <Field label="Username">
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </Field>
          )}
          <CredentialFields provider={connection.provider} method={method} typed={typed} type={setTyped} />
          {said !== undefined && <RefusalLine line={said.line} details={said.details} />}
          <div className="flex justify-end gap-2">
            <Button icon={X} label="Cancel" onClick={close}>Cancel</Button>
            <Button icon={LogIn} label="Sign in" variant="default" type="submit" disabled={sending}>
              Sign in
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Edit (`keyManagers.connections.update`): the label, the address (never
 * 1Password's, the account URL its token names, #1118), the token role and
 * the CA, pinned from the certificate the address presents once a person
 * trusts it, or unpinned. Save sends only what changed; a new address
 * or CA is signed in against by the environment first, and a refusal stays
 * in the form in one line.
 */
export const EditConnection = ({ environmentId, connection, close, say }: ConnectionDialogProps) => {
  const sender = useSender();
  const [label, setLabel] = useState(connection.label);
  const [address, setAddress] = useState(connection.address);
  const [tokenRole, setTokenRole] = useState(connection.tokenRole ?? "");
  const [ca, setCa] = useState<string | null>(connection.ca);
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
    void updateConnection(sender, environmentId, connection, changes, "Save").then((updated) => {
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
          {asksAddress(connection.provider) && (
            <Field label="Address">
              <Input value={address} onChange={(event) => setAddress(event.target.value)} />
            </Field>
          )}
          {openBao && (
            <>
              <Field label="Token role (optional)">
                <Input value={tokenRole} onChange={(event) => setTokenRole(event.target.value)} />
              </Field>
              <CaChoice environmentId={environmentId} address={address} ca={ca} choose={setCa} />
            </>
          )}
          {line !== undefined && <p className="text-sm text-signal">{line}</p>}
          <div className="flex justify-end gap-2">
            <Button icon={X} label="Cancel" onClick={close}>Cancel</Button>
            <Button icon={Pencil} label="Save" variant="default" type="submit" disabled={sending}>
              Save
            </Button>
          </div>
        </form>
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
            <Button icon={X} label="Cancel">Cancel</Button>
          </DialogClose>
          <Button icon={LogOut} label="Sign out"
            variant="destructive"
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
  const [sending, setSending] = useState(false);
  const remove = (force: boolean) => {
    setSending(true);
    void removeConnection(sender, environmentId, connection, force).then((removed) => {
      setSending(false);
      if (!removed.ok) return setRefused(removed);
      close();
      say(removed.line);
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Remove ${connection.label}?`} description="The environment revokes its login and deletes the credential it keeps, and holds the connection no more.">
        {refused !== undefined && <p className="text-sm text-signal">{refused.line}</p>}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button icon={X} label="Cancel">Cancel</Button>
          </DialogClose>
          {refused?.referenced === true ? (
            <Button icon={Trash2} label="Remove anyway" variant="destructive" disabled={sending} onClick={() => remove(true)}>
              Remove anyway
            </Button>
          ) : (
            <Button icon={Trash2} label="Remove" variant="destructive" disabled={sending} onClick={() => remove(false)}>
              Remove
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

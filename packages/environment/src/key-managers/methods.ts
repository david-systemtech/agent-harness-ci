import { keyManagerCliRow } from "@agent-harness/contracts";
import type { ManagedTools } from "../managed-tools/registry.js";
import type { MethodHandlers } from "../serve/methods.js";
import { previewCertificate } from "./certificate-preview.js";
import type { KeyManagerConnections } from "./connections.js";
import type { KeyManagerMoves } from "./moves.js";
import type { KeyManagerReferences } from "./references.js";

/**
 * The key-manager connection methods on the method table (key-managers
 * spec, "Wire methods"): `keyManagers.list` at `read`; add, signIn and
 * update, prepared commands that hear from the key manager first, and
 * setPolicies, setInjected (#368), signOut and remove, at `admin`, each appending to the
 * environment stream; verify, the certificate preview and the references'
 * check and browse (#370), `admin` queries; setBasePath, an `admin`
 * command, the items to move at `read`, and the Move, a prepared `admin`
 * command (#371), with the copy of a value its login cannot write, another
 * (#372). The rules are the connections', the references', the preview's
 * and the Move's own. The list gives each connection its CLI's Managed
 * tools row (#375), once any probe under way has ended: the first
 * installed of the tools serving its provider, `bao` else `vault` for
 * OpenBao.
 */
export const keyManagerMethods = (
  connections: KeyManagerConnections,
  references: KeyManagerReferences,
  moves: KeyManagerMoves,
  tools: Pick<ManagedTools, "list">,
  budgetMs?: number,
): MethodHandlers => ({
  "keyManagers.list": async () => {
    const rows = (await tools.list()).tools;
    return { connections: connections.list().map((connection) => ({ ...connection, cli: keyManagerCliRow(connection.provider, rows) })) };
  },
  "keyManagers.connections.add": connections.add,
  "keyManagers.connections.signIn": connections.signIn,
  "keyManagers.connections.update": connections.update,
  "keyManagers.connections.setPolicies": connections.setPolicies,
  "keyManagers.connections.setBasePath": connections.setBasePath,
  "keyManagers.connections.setInjected": connections.setInjected,
  "keyManagers.connections.signOut": connections.signOut,
  "keyManagers.connections.remove": connections.remove,
  "keyManagers.connections.verify": async ({ connectionId }) => ({ connections: await connections.verify(connectionId) }),
  "keyManagers.certificate.preview": (params) => previewCertificate(params, budgetMs),
  "keyManagers.references.check": references.check,
  "keyManagers.references.browse": references.browse,
  "keyManagers.move.list": () => moves.list(),
  "keyManagers.move": moves.move,
  "keyManagers.move.copyValue": moves.copyValue,
});

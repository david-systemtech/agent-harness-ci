import type { MethodHandlers } from "../serve/methods.js";
import { previewCertificate } from "./certificate-preview.js";
import type { KeyManagerConnections } from "./connections.js";
import type { KeyManagerMoves } from "./moves.js";
import type { KeyManagerReferences } from "./references.js";

/**
 * The key-manager connection methods on the method table (key-managers
 * spec, "Wire methods"): `keyManagers.list` at `read`; add, signIn and
 * update, prepared commands that hear from the key manager first, and
 * setPolicies, signOut and remove, at `admin`, each appending to the
 * environment stream; verify, the certificate preview and the references'
 * check and browse (#370), `admin` queries; setBasePath, an `admin`
 * command, the items to move at `read`, and the Move, a prepared `admin`
 * command (#371). The rules are the connections', the references', the
 * preview's and the Move's own.
 */
export const keyManagerMethods = (connections: KeyManagerConnections, references: KeyManagerReferences, moves: KeyManagerMoves, budgetMs?: number): MethodHandlers => ({
  "keyManagers.list": () => ({ connections: connections.list() }),
  "keyManagers.connections.add": connections.add,
  "keyManagers.connections.signIn": connections.signIn,
  "keyManagers.connections.update": connections.update,
  "keyManagers.connections.setPolicies": connections.setPolicies,
  "keyManagers.connections.setBasePath": connections.setBasePath,
  "keyManagers.connections.signOut": connections.signOut,
  "keyManagers.connections.remove": connections.remove,
  "keyManagers.connections.verify": async ({ connectionId }) => ({ connections: await connections.verify(connectionId) }),
  "keyManagers.certificate.preview": (params) => previewCertificate(params, budgetMs),
  "keyManagers.references.check": references.check,
  "keyManagers.references.browse": references.browse,
  "keyManagers.move.list": () => moves.list(),
  "keyManagers.move": moves.move,
});

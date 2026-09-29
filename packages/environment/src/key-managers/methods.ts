import type { MethodHandlers } from "../serve/methods.js";
import type { KeyManagerConnections } from "./connections.js";

/**
 * The key-manager connection methods on the method table (key-managers
 * spec, "Wire methods"): `keyManagers.list` at `read`; add, signIn and
 * update, prepared commands that hear from the key manager first, and
 * signOut and remove, at `admin`, each appending to the environment stream.
 * The rules are the connections'.
 */
export const keyManagerMethods = (connections: KeyManagerConnections): MethodHandlers => ({
  "keyManagers.list": () => ({ connections: connections.list() }),
  "keyManagers.connections.add": connections.add,
  "keyManagers.connections.signIn": connections.signIn,
  "keyManagers.connections.update": connections.update,
  "keyManagers.connections.signOut": connections.signOut,
  "keyManagers.connections.remove": connections.remove,
});

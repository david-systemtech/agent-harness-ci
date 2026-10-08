import type { BankRecord } from "@agent-harness/contracts";
import { bankScene } from "../bank-scene.js";
export { bankSettingsGeometry as geometry } from "../bank-scene.js";

/**
 * #1900: a team bank whose landing was refused for want of a forge account, after one on this environment came to
 * cover its origin and its verification read it reachable: the card carries no landing failure and no advice to add an
 * account.
 */
const cleared = (personal: BankRecord): BankRecord => ({
  ...personal, id: "0199aa00-0000-4000-8000-000000000005", name: "team-memory", kind: "team", defaultFor: [],
  location: { kind: "remote", origin: "https://git.example.test", repository: "project/team-memory" },
  validator: { installedVersion: 2, currentVersion: 2, needsUpdate: false },
  status: { ...personal.status, landing: { state: "ok", since: "2026-10-08T12:00:40.000Z" } },
});

// Listed beside the personal notebook, as the Banks row always shows it, so the cards keep their two-column width.
export default await bankScene(false, (personal) => [personal, cleared(personal)]);
export const readySelector = "[data-bank-scene-ready]";

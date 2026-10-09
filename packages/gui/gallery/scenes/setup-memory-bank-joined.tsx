import { bankScene } from "../bank-scene.js";
import { setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.8: a team notebook joined from its link, its badges in words and the rest in Details (#1853). */
export default await bankScene(true, (personal) => [{
  ...personal, id: "0199aa00-0000-4000-8000-000000000003", name: "team-memory", kind: "team", defaultFor: [],
  location: { kind: "remote", origin: "https://git.example.test", repository: "project/team-memory" },
  line: "Project agreements and useful discoveries.", validator: { installedVersion: 2, currentVersion: 2, needsUpdate: false },
}], { result: { state: "done", reason: "Your notebook is ready." } });
export const readySelector = "[data-bank-scene-ready]";
export const geometry = setupGeometry;

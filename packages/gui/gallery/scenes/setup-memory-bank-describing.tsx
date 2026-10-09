import { bankScene } from "../bank-scene.js";
import { setupGeometry } from "../setup-regions-scene.js";
/** setup-copy.md §5.8: a notebook just created, with no description yet: what Describe it does, beside it (#1853). */
export default await bankScene(true, (personal) => [{ ...personal, validator: { installedVersion: 2, currentVersion: 2, needsUpdate: false }, status: { ...personal.status, manifest: { state: "missing", since: personal.createdAt } } }], {
  result: { state: "needs-attention", reason: "project-memory needs a description." },
});
export const readySelector = "[data-bank-scene-ready]";
export const geometry = setupGeometry;

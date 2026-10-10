import { addADeviceGeometry, addADeviceReady, addADeviceScene } from "../add-a-device-scene.js";
/** Part 2's refusal when nothing answers: the plain line as an alert, the raw failure in Details (setup-copy.md §4.2). */
export default await addADeviceScene("refused");
export const readySelector = addADeviceReady;
export const geometry = addADeviceGeometry;

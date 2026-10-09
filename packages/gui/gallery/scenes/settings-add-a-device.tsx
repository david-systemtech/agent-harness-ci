import { addADeviceGeometry, addADeviceReady, addADeviceScene } from "../add-a-device-scene.js";
/** Add a device as it opens: who a code is for, Me pre-selected (setup-copy.md §5.5). */
export default await addADeviceScene("who");
export const readySelector = addADeviceReady;
export const geometry = addADeviceGeometry;

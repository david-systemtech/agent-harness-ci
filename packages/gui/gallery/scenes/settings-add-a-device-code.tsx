import { addADeviceGeometry, addADeviceReady, addADeviceScene } from "../add-a-device-scene.js";
/** Add a device with a code made: how to use it, its QR, the link to copy and its minutes (setup-copy.md §5.5). */
export default await addADeviceScene("code");
export const readySelector = addADeviceReady;
export const geometry = addADeviceGeometry;

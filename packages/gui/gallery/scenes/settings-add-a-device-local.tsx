import { addADeviceGeometry, addADeviceReady, addADeviceScene } from "../add-a-device-scene.js";
/** This computer reachable only from itself: the warning above the button, and a code made anyway that says it only works here (setup-copy.md §5.5). */
export default await addADeviceScene("local");
export const readySelector = addADeviceReady;
export const geometry = addADeviceGeometry;

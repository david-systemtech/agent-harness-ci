import { dialogGeometry, dialogScene } from "../dialog-scene.js";
export default await dialogScene("restore");
export const geometry = dialogGeometry(512);
export const readySelector = '[role="dialog"]';

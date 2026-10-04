import { phoneInstallScene, phoneInstallGeometry } from "../phone-install-scene.js";
export default phoneInstallScene("denial");
export const platform = "web";
export const geometry = phoneInstallGeometry(false);

export const readySelector = "[data-phone-install] [role=status]";

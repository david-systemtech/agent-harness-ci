import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * The app's identifier: the macOS bundle's `CFBundleIdentifier`, and on
 * Windows the Start menu shortcut's AppUserModelID, which a notification's
 * sender must match (#423, #405). Reverse DNS of the forge that publishes the
 * releases.
 */
export const APP_ID = `dev.systemtech.${PRODUCT_NAME}`;

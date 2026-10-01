import { optionalText, options, text } from "./arguments.js";
import { NOTIFICATION_CHANNEL } from "./channels.js";
import type { ElectronBrowserWindow, ElectronNotification, ElectronNotifications } from "./electron.js";
import { bringForward } from "./members.js";

/**
 * The shell's `notifications` (docs/specs/gui.md, "The desktop shell";
 * #405): an OS notification of the title and body the renderer composed. A
 * click brings the window forward and sends the tag it was shown with to the
 * window's page (`NOTIFICATION_CHANNEL`), whose preload hands it to each
 * `onActivate` listener; one shown without a tag hands nothing on. The tag is
 * a string of the renderer's own, never read here (ADR 0004).
 *
 * Electron lets a notification's click go unheard once nothing holds it, so
 * each is kept until it is clicked or goes, the newest `KEPT_NOTIFICATIONS`
 * at most, so a desktop whose OS never says one went keeps no more.
 */

/** How many shown notifications are kept for their clicks: the newest, a chosen default. */
export const KEPT_NOTIFICATIONS = 100;

export interface NotificationParts {
  readonly notification: ElectronNotifications;
  readonly window: ElectronBrowserWindow;
}

export const desktopNotifications = ({ notification, window }: NotificationParts) => {
  const kept = new Set<ElectronNotification>();
  return {
    /** Shows what the renderer sent, once it is a title and a body with an optional tag; refuses it where the OS shows none. */
    show(given: unknown): void {
      const chosen = options(given, "A notification");
      const title = text(chosen["title"], "A notification's title");
      const body = text(chosen["body"], "A notification's body");
      const tag = optionalText(chosen["tag"], "A notification's tag");
      if (!notification.isSupported()) throw new Error("This desktop cannot show notifications: the OS offers none to it.");
      const shown = notification.create({ title, body });
      const letGo = () => void kept.delete(shown);
      shown.on("click", () => {
        letGo();
        bringForward(window);
        if (tag !== undefined) window.webContents.send(NOTIFICATION_CHANNEL, tag);
      });
      shown.on("close", letGo);
      kept.add(shown);
      for (const oldest of kept) {
        if (kept.size <= KEPT_NOTIFICATIONS) break;
        kept.delete(oldest);
      }
      shown.show();
    },
  };
};
export type DesktopNotifications = ReturnType<typeof desktopNotifications>;

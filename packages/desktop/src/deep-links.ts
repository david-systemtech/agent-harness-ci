import { DEEP_LINK_CHANNEL } from "./channels.js";
import { APP_SCHEME } from "./schemes.js";

/** The first `agent-harness://` link on a command line, where Windows and Linux hand a launch its deep link. */
export const deepLinkIn = (argv: readonly string[]): string | undefined =>
  argv.find((arg) => arg.toLowerCase().startsWith(`${APP_SCHEME}://`));

/** The window's page, as deep links reach it. */
export interface LinkedPage {
  send(channel: string, url: string): void;
}

/**
 * The deep links opened with the app or into it (`deepLinks.onOpen`): held
 * until the renderer's page first listens, then sent to it as each is opened.
 * A page loaded again listens again and takes over. Nothing is forgotten on a
 * navigation's start: Electron reports one before `will-navigate` can refuse
 * it, so a link clicked out of the page would silence every later deep link.
 */
export const deepLinkInbox = () => {
  let held: string[] = [];
  let page: LinkedPage | undefined;
  return {
    open(url: string): void {
      if (page) page.send(DEEP_LINK_CHANNEL, url);
      else held.push(url);
    },
    /** `listening` now hears every link; answers the links held until now. */
    listen(listening: LinkedPage): readonly string[] {
      page = listening;
      const answered = held;
      held = [];
      return answered;
    },
  };
};
export type DeepLinkInbox = ReturnType<typeof deepLinkInbox>;

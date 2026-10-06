const BROWSERS: readonly (readonly [RegExp, string])[] = [[/Edg(?:A|iOS)?\//, "Edge"], [/OPR\//, "Opera"], [/SamsungBrowser\//, "Samsung Internet"], [/Firefox\/|FxiOS\//, "Firefox"], [/Chrome\/|CriOS\//, "Chrome"], [/Version\/.*Safari\//, "Safari"]];
const SYSTEMS: readonly (readonly [RegExp, string])[] = [[/Android/, "Android"], [/iPhone|iPod/, "iPhone"], [/iPad/, "iPad"], [/CrOS/, "ChromeOS"], [/Windows/, "Windows"], [/Macintosh/, "Mac"], [/Linux/, "Linux"]];
/** The systems whose installed web apps open from the Home Screen. */
const HOME_SCREENS: ReadonlySet<string> = new Set(["Android", "iPhone", "iPad"]);

const systemOf = (userAgent: string): string | undefined => SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];

/** A browser by its user agent, as a person names it: `Chrome on Android`, or as much of that as the user agent says. */
export const browserName = (userAgent: string): string => {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = systemOf(userAgent);
  return browser && system ? `${browser} on ${system}` : browser ?? (system ? `A browser on ${system}` : "A browser");
};

/** Whether the page runs as an installed web app rather than in a tab: the standalone display mode, or Safari's own `navigator.standalone`. */
export const runsInstalled = (view: Window): boolean =>
  (typeof view.matchMedia === "function" && view.matchMedia("(display-mode: standalone)").matches) || (view.navigator as Navigator & { readonly standalone?: boolean }).standalone === true;

/**
 * What a web client pairs as (#1740): its browser and system, and whether it
 * is installed or a tab, `Chrome on Android (Home Screen)`, so two phones'
 * Access rows are told apart the way their push registrations are (#1714).
 */
export const webClientLabel = (userAgent: string, installed: boolean): string => {
  const system = systemOf(userAgent);
  const how = !installed ? "tab" : system !== undefined && HOME_SCREENS.has(system) ? "Home Screen" : "installed app";
  return `${browserName(userAgent)} (${how})`;
};

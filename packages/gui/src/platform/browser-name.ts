const BROWSERS: readonly (readonly [RegExp, string])[] = [[/Edg(?:A|iOS)?\//, "Edge"], [/OPR\//, "Opera"], [/SamsungBrowser\//, "Samsung Internet"], [/Firefox\/|FxiOS\//, "Firefox"], [/Chrome\/|CriOS\//, "Chrome"], [/Version\/.*Safari\//, "Safari"]];
const SYSTEMS: readonly (readonly [RegExp, string])[] = [[/Android/, "Android"], [/iPhone|iPod/, "iPhone"], [/iPad/, "iPad"], [/CrOS/, "ChromeOS"], [/Windows/, "Windows"], [/Macintosh/, "Mac"], [/Linux/, "Linux"]];
/** The systems whose installed web apps open from the Home Screen. */
const HOME_SCREENS: ReadonlySet<string> = new Set(["Android", "iPhone", "iPad"]);

/** The system a user agent runs on; an iPad says Macintosh unless "Request Desktop Website" is off, and its touch screen gives it away. */
export const systemOf = (userAgent: string, touchPoints: number): string | undefined => {
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return system === "Mac" && touchPoints > 1 ? "iPad" : system;
};

/** A browser by its user agent and touch points, as a person names it: `Chrome on Android`, or as much of that as they say. */
export const browserName = (userAgent: string, touchPoints = 0): string => {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = systemOf(userAgent, touchPoints);
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
export const webClientLabel = (userAgent: string, touchPoints: number, installed: boolean): string => {
  const system = systemOf(userAgent, touchPoints);
  const how = !installed ? "tab" : system !== undefined && HOME_SCREENS.has(system) ? "Home Screen" : "installed app";
  return `${browserName(userAgent, touchPoints)} (${how})`;
};

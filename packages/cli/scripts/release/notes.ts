import type { ReleaseAsset } from "@agent-harness/contracts";
import { DESKTOP_KIND } from "./assets.js";

/**
 * A release's notes, the text its page shows above its assets (#359).
 * Milestone 1's desktop builds are unsigned (David, 2026-09-28, on #359), so
 * macOS's Gatekeeper and Windows' SmartScreen warn the first time one a
 * browser downloaded is opened: a release that publishes desktop builds says
 * so, and how to open each the first time. One that publishes none has no
 * notes.
 */

/** How to open the desktop build `name` the first time, by the format its shell installs. */
const FIRST_OPEN: Readonly<Record<string, (name: string) => string>> = {
  zip: (name) =>
    [
      `**macOS** (Apple silicon), \`${name}\`: unzip it and move \`agent-harness.app\` into Applications before you open it, so that it can update itself.`,
      "The first time, macOS says it cannot verify the app: choose Done, then in System Settings > Privacy & Security choose Open Anyway beside agent-harness, and confirm.",
      "Or clear the quarantine flag in Terminal before the first open: `xattr -dr com.apple.quarantine /Applications/agent-harness.app`.",
    ].join(" "),
  nsis: (name) =>
    [
      `**Windows** (x64), \`${name}\`: if the browser says the file is not commonly downloaded, keep it.`,
      "When the setup starts, Windows protected your PC appears: choose More info, then Run anyway.",
      "It installs for your user alone and needs no administrator.",
    ].join(" "),
  pacman: (name) => `**Arch Linux** (x64), \`${name}\`: install it with \`sudo pacman -U ${name}\`; nothing warns.`,
};

/** The notes of a release that publishes `assets` (see the module's comment), Markdown, or empty for none. */
export const releaseNotes = (assets: readonly ReleaseAsset[]): string => {
  const desktops = assets.filter((asset) => asset.kind === DESKTOP_KIND);
  if (desktops.length === 0) return "";
  const paragraphs = [
    "## The desktop builds are not signed",
    "macOS and Windows warn the first time one downloaded by a browser is opened. Once it is open, the desktop updates itself without a warning: it takes each later build from the environment on the same machine, which downloads it with no quarantine flag or Mark-of-the-Web.",
    ...desktops.map(({ name, platform, format }) => FIRST_OPEN[format ?? ""]?.(name) ?? `\`${name}\`: the desktop for ${platform ?? "any platform"}.`),
  ];
  return `${paragraphs.join("\n\n")}\n`;
};

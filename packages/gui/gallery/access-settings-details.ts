import type { SceneGeometry, SceneViewport } from "./scene-registry.js";
import { settingsGeometry } from "./settings-scene.js";

export interface AccessSettingsDetail {
  readonly row: "access.permissions" | "access.browser";
  readonly pairing?: boolean;
  readonly anchor: string;
  readonly visible: readonly string[];
  readonly controls?: readonly SceneGeometry[];
}

const unattended = '[role="group"]:has(input[aria-label="Edit files, ask for the rest"]):not(:has(input[aria-label="Ask before any change"]))';
const ttl = '[role="group"]:has(select[aria-label="Deny it after"])';
const containment = '[role="radiogroup"]:has(input[title^="Off ("])';
const sites = 'section[aria-label="Sites you are developing"]';
const test = 'form[aria-label="Test the always-ask list"]';

const denylist = (name: string): AccessSettingsDetail => {
  const group = `section:has(> form[aria-label="Add to ${name}"])`;
  return {
    row: "access.permissions", anchor: group,
    visible: [group],
    controls: [
      { selector: `${group} input:not([type=checkbox])`, height: 32 },
      { selector: `${group} [role=switch]`, width: 32, height: 18.4 },
    ],
  };
};

export const accessSettingsDetails = {
  pairing: {
    row: "access.browser", pairing: true, anchor: '[data-browser-step="5"]',
    visible: ['[data-browser-step="5"]'],
    controls: [{ selector: 'input[aria-label="Pairing code"]', width: 192, height: 32 }],
  },
  policy: {
    row: "access.browser", anchor: sites,
    visible: [sites],
    controls: [
      { selector: `${sites} textarea`, minimumHeight: 128 },
    ],
  },
  defaults: {
    row: "access.browser", anchor: 'section[aria-label="Headless browser"]',
    visible: ['section[aria-label="Headless browser"]', 'section[aria-label="Per-account default browser"]'],
    controls: [
      { selector: 'section[aria-label="Headless browser"] [role=switch]', width: 32, height: 18.4 },
      { selector: 'select[aria-label="Default browser for Personal"]', height: 32 },
    ],
  },
  unattended: {
    row: "access.permissions", anchor: unattended, visible: [unattended],
    controls: [
      { selector: `${unattended} label span.font-medium`, fontSize: 12 },
      { selector: `${unattended} label span.text-2xs`, fontSize: 11 },
    ],
  },
  containment: {
    row: "access.permissions", anchor: ttl, visible: [ttl, containment],
    controls: [{ selector: 'select[aria-label="Deny it after"]', height: 32 }],
  },
  domains: denylist("Browser domains"),
  paths: denylist("Paths"),
  commands: denylist("Command patterns"),
  hosts: denylist("Hosts"),
  review: {
    row: "access.permissions", anchor: test,
    visible: [test, 'section:has(> h3):has(ul[aria-label="Runs"])'],
    controls: [{ selector: `${test} input, ${test} select, ${test} button`, height: 32 }],
  },
} as const satisfies Readonly<Record<string, AccessSettingsDetail>>;

export const detailGeometry = (detail: AccessSettingsDetail, viewport: SceneViewport): readonly SceneGeometry[] => [
  ...settingsGeometry(viewport),
  ...(detail.controls ?? []),
  ...detail.visible.map((selector) => ({ selector, visibleWithin: `section[aria-label="${detail.row === "access.browser" ? "Browser" : "Permissions"}"]` })),
];

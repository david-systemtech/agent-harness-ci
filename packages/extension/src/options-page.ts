import type { ExtensionChrome } from "./chrome.js";
import type { PageRequest, PairOutcome } from "./messages.js";
import { readPortFile, type ReadOwnFile } from "./port.js";
import { describeStatus, STATUS_KEY, type WorkerStatus } from "./status.js";
import { isPort, PORT_OVERRIDE_KEY, readName, readPairing, readPortOverride } from "./stored.js";

/**
 * The options page (browser spec, "The extension, its folder and its
 * listener"; ADR 0024): what the worker says of its connection, the pair
 * form while the Chrome holds no pairing, whose code the worker sends as
 * `pair` on its announced socket, and the port: the one the port file
 * names, and the override for odd cases, which wins while it is set. It
 * reads what the worker keeps in Chrome's storage and draws again on each
 * change; opening it wakes the worker, which dials at once if it has no
 * socket.
 */

export interface OptionsPageSeams {
  readonly chrome: ExtensionChrome;
  readonly readOwnFile: ReadOwnFile;
}

const NO_ANSWER = "The extension's worker did not answer. Try again.";

/** The answer the worker gave a `pair`, or what went wrong asking it. */
const outcomeOf = (answer: unknown): PairOutcome => {
  if (typeof answer === "object" && answer !== null) {
    const { ok, reason } = answer as { readonly ok?: unknown; readonly reason?: unknown };
    if (ok === true) return { ok: true };
    if (ok === false && typeof reason === "string") return { ok: false, reason };
  }
  return { ok: false, reason: NO_ANSWER };
};

/** Starts the page in `document`; settles once it is first drawn. */
export const startOptionsPage = async (document: Document, { chrome, readOwnFile }: OptionsPageSeams): Promise<void> => {
  const element = <E extends HTMLElement>(id: string): E => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`The options page has no #${id}.`);
    return found as E;
  };
  const status = element("status");
  const pairForm = element<HTMLFormElement>("pair-form");
  const pairName = element<HTMLInputElement>("pair-name");
  const pairCode = element<HTMLInputElement>("pair-code");
  const pairResult = element("pair-result");
  const portFile = element("port-file");
  const overrideForm = element<HTMLFormElement>("override-form");
  const override = element<HTMLInputElement>("override");
  const overrideClear = element<HTMLButtonElement>("override-clear");
  const overrideProblem = element("override-problem");
  const overrideLine = element("override-line");
  const ask = (request: PageRequest): Promise<unknown> => chrome.runtime.sendMessage(request);

  const draw = async (): Promise<void> => {
    const [stored, pairing, overridden, reading] = await Promise.all([
      chrome.storage.session.get(STATUS_KEY),
      readPairing(chrome),
      readPortOverride(chrome),
      readPortFile(readOwnFile),
    ]);
    status.textContent = describeStatus((stored[STATUS_KEY] as WorkerStatus | undefined) ?? { state: "starting" });
    pairForm.hidden = pairing !== undefined;
    portFile.textContent = reading.ok ? `The port file names port ${reading.file.port}, where ${reading.file.environmentName} listens.` : reading.problem;
    overrideLine.textContent =
      overridden === undefined ? "No override is set, so the port file's port is used." : `The override, port ${overridden}, is used while it is set, whatever the port file names.`;
  };

  pairForm.addEventListener("submit", (event) => {
    event.preventDefault();
    pairResult.textContent = "Pairing.";
    void ask({ type: "pair", code: pairCode.value, name: pairName.value }).then(
      (answer) => {
        const outcome = outcomeOf(answer);
        pairResult.textContent = outcome.ok ? "Paired." : outcome.reason;
        if (outcome.ok) pairCode.value = "";
      },
      () => (pairResult.textContent = NO_ANSWER),
    );
  });

  overrideForm.addEventListener("submit", (event) => {
    event.preventDefault();
    // The field's own range refuses most; an empty one comes here.
    const port = override.value.trim() === "" ? Number.NaN : Number(override.value);
    overrideProblem.textContent = isPort(port) ? "" : "A port is a whole number from 1 to 65535.";
    if (isPort(port)) void chrome.storage.local.set({ [PORT_OVERRIDE_KEY]: port });
  });

  overrideClear.addEventListener("click", () => {
    override.value = "";
    overrideProblem.textContent = "";
    void chrome.storage.local.remove(PORT_OVERRIDE_KEY);
  });

  chrome.storage.session.onChanged.addListener(() => void draw());
  chrome.storage.local.onChanged.addListener(() => void draw());
  const [name, overridden] = await Promise.all([readName(chrome), readPortOverride(chrome)]);
  pairName.value = name;
  if (overridden !== undefined) override.value = String(overridden);
  // Opening the page wakes the worker, if Chrome stopped it, to dial at once.
  void ask({ type: "connect" }).catch(() => undefined);
  await draw();
};

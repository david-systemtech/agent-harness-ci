import { PRODUCT_NAME } from "@agent-harness/contracts";
import { PairingForm } from "./pairing.js";
import { RunHereSwitch } from "./run-here.js";

/**
 * The window's first view with "Run an environment on this machine" off and
 * nothing paired (docs/specs/gui.md, "The local environment, pairing and
 * updates"): pairing with an environment elsewhere, and the switch to run
 * one here instead.
 */
export const PairingPane = () => (
  <section aria-label="Pair with an environment" className="flex flex-1 flex-col justify-center gap-4 p-6">
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <h2 className="text-base font-semibold text-ink">Pair with an environment</h2>
      <p className="text-sm text-ink-muted">
        Paste the pairing link another client made (Your machines, or <code>{PRODUCT_NAME} pair</code> on the environment's machine), or type the environment's
        address and its code.
      </p>
      <PairingForm />
      <RunHereSwitch />
    </div>
  </section>
);

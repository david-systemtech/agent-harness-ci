import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { TrustDecision, TrustKey, TrustKeyKind, TrustOffer, TrustRecord, TrustState } from "../trust.js";

/**
 * The trust gate's methods (skills spec, "The trust gate" and "Wire
 * summary"; ADR 0009, ADR 0029): `trust.get` and `trust.list` at `read`,
 * `trust.decide` and `trust.revoke` at `admin` (chosen default: trust admits
 * hooks and permission rules that act outside modes and ceilings). Each
 * decision and revoke raises `trust.updated` on `environment.subscribe` once
 * it commits. A session the environment does not hold, or a deleted one, is
 * `not_found` (data `kind: session`); a key with no record is `not_found`
 * (data `kind: trust`).
 */

/**
 * A session's trust key, its standing and what its repository offers. A
 * client asks the question while the key is undecided and the offer is not
 * empty (`trustOfferEmpty`). A scratch workspace has no key, no offer, and
 * is never asked about.
 */
export const trustGet = defineMethod({
  name: "trust.get",
  scope: "read",
  kind: "query",
  params: z.object({ sessionId: SessionId.meta({ description: "The session whose repository's trust to read." }) }),
  result: z
    .object({
      key: TrustKey.nullable().meta({ description: "The session's trust key; null for a scratch workspace, which is never asked about." }),
      keyKind: TrustKeyKind.nullable().meta({ description: "What the key is; null with no key." }),
      decision: TrustState.meta({ description: "The key's standing; undecided with no key." }),
      offer: TrustOffer.nullable().meta({ description: "What trusting the repository would load, counted; null with no key." }),
    })
    .meta({ description: "A session's trust key and its kind, the decision recorded for it, and what its repository offers." }),
  errors: [],
});

/** The recorded decisions, for the Skills step's list: trusted keys with Revoke, declined ones with Trust. */
export const trustList = defineMethod({
  name: "trust.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z
    .object({
      trusted: z.array(TrustRecord).meta({ description: "The trusted keys, the latest decided first, each with when and from which client." }),
      declined: z.array(TrustRecord).meta({ description: "The declined keys, the latest decided first." }),
    })
    .meta({ description: "Every recorded decision, trusted and declined apart, one per key." }),
  errors: [],
});

/**
 * `trust.decide`: a session, whose key is decided and recorded as asked in
 * it; or a key already recorded, from the Skills step's list. The
 * refinement is zod's half; the `oneOf` the export's.
 */
const DecideParams = commandParams({
  sessionId: SessionId.optional().meta({ description: "The session asked in, whose key is decided; leave out key." }),
  key: TrustKey.optional().meta({ description: "A key already recorded, decided again; leave out sessionId." }),
  decision: TrustDecision,
})
  .refine((params) => (params.sessionId === undefined) !== (params.key === undefined), { message: "Name a session or a key, not both." })
  .meta({
    description: "A decision on a session's key, or on a key already recorded.",
    oneOf: [
      { required: ["sessionId"], properties: { sessionId: true, key: false } },
      { required: ["key"], properties: { sessionId: false, key: true } },
    ],
  });

/**
 * Records a decision: `trust.granted` or `trust.declined` on the trust
 * stream with the record's fields, then `trust.updated`. It reaches the
 * session's next run, never a live one. A decision already held appends
 * nothing (`changed: false`). A session whose workspace is scratch has no
 * key: `conflict`, reason `no_trust_key`.
 */
export const trustDecide = defineMethod({
  name: "trust.decide",
  scope: "admin",
  kind: "command",
  params: DecideParams,
  result: z.object({ record: TrustRecord.meta({ description: "The key's record now." }) }),
  errors: [],
});

/** Returns a key to undecided: `trust.revoked`, then `trust.updated`. A key with no record is `not_found` (data `kind: trust`). */
export const trustRevoke = defineMethod({
  name: "trust.revoke",
  scope: "admin",
  kind: "command",
  params: commandParams({ key: TrustKey.meta({ description: "The key to return to undecided, as trust.list or trust.get names it." }) }),
  result: z.object({ record: TrustRecord.meta({ description: "The record that was withdrawn." }) }),
  errors: [],
});

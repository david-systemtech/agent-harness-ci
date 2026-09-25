import { formatActor } from "../event-log/event-log.js";

/**
 * The permissions workstream's own actor, `system:permissions`: what the
 * environment records on its own account there (the TTL's answers, the
 * prompt notices, the denylist's seeded presets).
 */
export const PERMISSIONS_ACTOR = formatActor({ kind: "system", id: "permissions" });

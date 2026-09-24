import { z } from "zod";
import { CapabilityFlags, ProtocolVersion } from "./flags.js";
import { PRODUCT_NAME } from "./product.js";

/**
 * Whether an environment accepts work (the env spec's readiness; not a
 * skill's readiness, which the glossary's Readiness names): `starting` until its startup gate
 * (log open, migrations applied, projections caught up, listener bound,
 * `prepared` signalled), `ready` after it, `draining` once it refuses new
 * runs before a restart.
 */
export const ENVIRONMENT_READINESS = ["starting", "ready", "draining"] as const;
export const EnvironmentReadiness = z.enum(ENVIRONMENT_READINESS).meta({
  description:
    "Whether the environment accepts work: starting (before its startup gate), ready, or draining (refusing new runs before a restart).",
});
export type EnvironmentReadiness = z.infer<typeof EnvironmentReadiness>;

/**
 * How the environment is reached, derived from what it binds: `local-only`
 * when only loopback is bound, `tailnet` when the tailnet interface is too.
 * Under both, every request but discovery, health and the two exchanges needs
 * a client session; there is no unauthenticated policy.
 */
export const AUTH_POLICIES = ["local-only", "tailnet"] as const;
export const AuthPolicy = z.enum(AUTH_POLICIES).meta({
  description:
    "How the environment is reached: local-only when it binds loopback alone, tailnet when it binds its tailnet address too. Both require a client session.",
});
export type AuthPolicy = z.infer<typeof AuthPolicy>;

/** Where an environment answers, unauthenticated, who it is and whether it is ready. */
export const DISCOVERY_PATH = `/.well-known/${PRODUCT_NAME}/environment`;

/** Where an environment answers its readiness and version, for the launcher and the setup checklist. */
export const HEALTH_PATH = "/health";

/**
 * What `GET` on the discovery path answers, with no credential: enough for a
 * client or the setup checklist to tell which environment this is, whether it
 * speaks the client's protocol, and whether it is ready.
 */
export const DiscoveryDocument = z
  .object({
    environmentId: z.uuid().meta({ description: "The environment's persistent id, kept across address changes." }),
    environmentName: z.string().min(1),
    harnessVersion: z.string().min(1).meta({ description: "The version of the harness the environment runs." }),
    protocolVersion: ProtocolVersion,
    capabilities: CapabilityFlags,
    authPolicy: AuthPolicy,
    readiness: EnvironmentReadiness,
  })
  .meta({
    description:
      "The unauthenticated discovery document: who the environment is, what it speaks and offers, how it is reached and whether it is ready.",
  });
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>;

/** What `GET /health` answers: the readiness and the harness version, nothing else. */
export const HealthDocument = z
  .object({
    status: EnvironmentReadiness,
    version: z.string().min(1).meta({ description: "The version of the harness the environment runs." }),
  })
  .meta({ description: "The health answer: the environment's readiness as status, and the harness version." });
export type HealthDocument = z.infer<typeof HealthDocument>;

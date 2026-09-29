import { z } from "zod";
import { WireError, errorSchema } from "./errors.js";
import { KeyManagerConnectionId, KeyManagerReference } from "./key-managers.js";

/**
 * Move stored tokens (key-managers spec, "Move stored tokens"; ADR 0028;
 * #371): the items still holding a stored value, which `keyManagers.move`
 * writes into a key manager under the connection's base path, reads back,
 * swaps to a reference through their owner's own command and deletes. Each
 * owning service registers a Move source for its items: the forge for its
 * forge accounts now; banks (#90) and routine webhook endpoints (#92) with
 * their tickets. An item's target sits one level below the base path
 * (`<base>/forge-<slug>`). Nothing here ever holds a value: an item is named
 * by its kind and id, a target by its reference, and a stored value by
 * where its owner keeps it.
 */

/** What holds a stored value Move can take: a forge account's pasted token. */
export const KEY_MANAGER_MOVE_ITEM_KINDS = ["forge-account"] as const;
export const KeyManagerMoveItemKind = z.enum(KEY_MANAGER_MOVE_ITEM_KINDS).meta({
  description: "What holds a stored value Move can take: forge-account (a forge account's pasted token).",
});
export type KeyManagerMoveItemKind = z.infer<typeof KeyManagerMoveItemKind>;

/** An item as Move names it: its kind and its owner's id for it. */
export const KeyManagerMoveItemRef = z
  .object({
    kind: KeyManagerMoveItemKind,
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\p{Cc}]+$/u)
      .meta({ description: "The item's id with its owner: a forge account's id." }),
  })
  .meta({ description: "An item Move takes, by its kind and its owner's id for it." });
export type KeyManagerMoveItemRef = z.infer<typeof KeyManagerMoveItemRef>;

/** Where an item would go on one connection: the reference it is swapped to once moved there. */
export const KeyManagerMoveTarget = z
  .object({
    connectionId: KeyManagerConnectionId.meta({ description: "The connection the target is on." }),
    reference: KeyManagerReference.meta({ description: "The reference the item holds once moved there: for OpenBao, the base path's mount, <project>/<entry> under it (harness/forge-github) and the key." }),
  })
  .meta({ description: "Where an item would go on one connection with a base path: the reference it would hold once moved." });
export type KeyManagerMoveTarget = z.infer<typeof KeyManagerMoveTarget>;

/** An item holding a stored value, as `keyManagers.move.list` answers it: never the value. */
export const KeyManagerMoveItem = z
  .object({
    ...KeyManagerMoveItemRef.shape,
    name: z.string().min(1).meta({ description: "What people know the item by: a forge account's origin." }),
    targets: z.array(KeyManagerMoveTarget).meta({
      description: "Its target on each connection a Move can write to that has a base path, in the order the connections were added; empty while none has.",
    }),
  })
  .meta({ description: "An item holding a stored value: its kind and id, what people know it by, and its target on each connection with a base path. Never the value." });
export type KeyManagerMoveItem = z.infer<typeof KeyManagerMoveItem>;

/**
 * The steps a Move takes for an item, in order: reading the stored value,
 * writing it to the target, reading it back, and swapping the item to the
 * reference; the delete that follows never fails an item.
 */
export const KEY_MANAGER_MOVE_STEPS = ["read", "write", "read-back", "swap"] as const;
export const KeyManagerMoveStep = z.enum(KEY_MANAGER_MOVE_STEPS).meta({
  description: "The step a Move failed at: read (the stored value), write (it to the target), read-back (the value at the target, compared) or swap (the item to the reference, through its owner's command).",
});
export type KeyManagerMoveStep = z.infer<typeof KeyManagerMoveStep>;

/** A different value is at the target already, which a Move replaces only when asked to overwrite. */
export const KeyManagerTargetExistsError = errorSchema(
  "conflict",
  z.object({
    reason: z.literal("target_exists"),
    connectionId: KeyManagerConnectionId.meta({ description: "The connection the target is on." }),
    reference: KeyManagerReference.meta({ description: "The target, as the reference the item would hold." }),
  }),
).meta({
  description:
    "A different value is at the target already: nothing was written, and the item holds its stored value still. keyManagers.move with overwrite replaces it. The same value at the target is no conflict. Never either value.",
});
export type KeyManagerTargetExistsError = z.infer<typeof KeyManagerTargetExistsError>;

/** What a Move did with one item. */
export const KeyManagerMoveItemResult = z
  .discriminatedUnion("outcome", [
    z
      .object({
        item: KeyManagerMoveItemRef,
        outcome: z.literal("moved"),
        reference: KeyManagerReference.meta({ description: "The reference the item holds now." }),
        storedValueDeleted: z.boolean().meta({ description: "Whether the stored value was deleted; one whose delete failed is deleted at the next start." }),
        message: z.string().min(1).meta({ description: "One line for people: where it went, and whether the stored value was deleted." }),
      })
      .meta({ description: "The item was written, read back, swapped to its reference and its stored value deleted, or left for the next start to delete." }),
    z
      .object({
        item: KeyManagerMoveItemRef,
        outcome: z.literal("failed"),
        step: KeyManagerMoveStep,
        written: z.boolean().meta({ description: "Whether a copy was written to the target and left there: after a failed read-back or swap. The stored value is left in place either way." }),
        error: z.union([KeyManagerTargetExistsError, WireError]).meta({
          description:
            "Why: conflict reason target_exists at the write; not_found when the item holds no stored value now; unreachable, sealed, certificate_rejected or reference_denied from the key manager; credential_source_unavailable, reference_not_found or reference_denied, or conflict reason read_back_differs, at the read-back; the owner's command's refusal at the swap. Never the value.",
        }),
      })
      .meta({ description: "The item was not moved: the step it failed at, whether a copy was left at the target, and why. It holds its stored value still." }),
  ])
  .meta({ description: "What a Move did with one item: moved, or failed at a step. Never the value." });
export type KeyManagerMoveItemResult = z.infer<typeof KeyManagerMoveItemResult>;

/** Where an owning service keeps a stored value: a forge account's vault entry. Never the value. */
export const KeyManagerStoredAt = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u)
  .meta({ description: "Where an owning service keeps a stored value, never the value: a forge account's vault entry (forge:<forge account id>:<entry id>)." });
export type KeyManagerStoredAt = z.infer<typeof KeyManagerStoredAt>;

// Events ------------------------------------------------------------------------

export const KeyManagerMovedPayload = z
  .object({
    connectionId: KeyManagerConnectionId.meta({ description: "The connection the item was moved to." }),
    item: KeyManagerMoveItemRef,
    reference: KeyManagerReference.meta({ description: "Where it went: the reference the item holds now." }),
    undeleted: KeyManagerStoredAt.nullable().meta({ description: "Where the stored value is kept still when its delete failed, which the next start deletes; null once it was deleted." }),
  })
  .meta({ description: "key-manager.moved: an item's stored value was written to a key manager, read back, and the item swapped to the reference. Never the value." });
export type KeyManagerMovedPayload = z.infer<typeof KeyManagerMovedPayload>;

export const KeyManagerStoredValueDeletedPayload = z
  .object({
    item: KeyManagerMoveItemRef,
    storedAt: KeyManagerStoredAt.meta({ description: "Where the stored value was kept." }),
  })
  .meta({ description: "key-manager.stored-value-deleted: a stored value a move left behind, its delete having failed, was deleted at a later start; recorded as system:key-manager." });
export type KeyManagerStoredValueDeletedPayload = z.infer<typeof KeyManagerStoredValueDeletedPayload>;

/** The Move's events, on the environment stream, so every client hears them as it hears the connections'. */
export const KEY_MANAGER_MOVE_EVENT_PAYLOADS = {
  "key-manager.moved": KeyManagerMovedPayload,
  "key-manager.stored-value-deleted": KeyManagerStoredValueDeletedPayload,
} as const;

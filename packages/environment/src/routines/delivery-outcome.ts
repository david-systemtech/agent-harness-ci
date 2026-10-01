import type { DeliveredOutcome, DeliveryOn, RoutineEntry } from "@agent-harness/contracts";

/** How an ended entry is delivered: a succeeded firing as `succeeded`, a failed one or a failing skip as `failed`; null for what goes to no target. */
export const deliveredOutcome = (entry: RoutineEntry): DeliveredOutcome | null => {
  if (entry.kind === "skip") return entry.reason !== "pre-check-failed" && entry.reason !== "cannot-start" ? null : "failed";
  switch (entry.outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    default:
      return null;
  }
};

/** Whether a target on `on` takes a result delivered as `outcome`. */
export const takes = (on: DeliveryOn, outcome: DeliveredOutcome): boolean => {
  switch (on) {
    case "both":
      return true;
    case "success":
      return outcome === "succeeded";
    case "failure":
      return outcome === "failed";
  }
};


import { attentionTargetsConfigure, attentionRoutesConfigure, attentionRoutesRemove, attentionRoutesSet, attentionTargetsList, attentionTargetsRemove, attentionTargetsSet } from "../methods/attention.js";
/** Registration slot for durable attention and its transports. */
export const webAttentionMethods = [attentionTargetsList, attentionTargetsSet, attentionTargetsRemove, attentionRoutesSet, attentionRoutesRemove, attentionTargetsConfigure, attentionRoutesConfigure] as const;

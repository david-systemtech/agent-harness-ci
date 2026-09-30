/**
 * The browser package's testing exports (`@agent-harness/browser/testing`),
 * for the tests of every package that drives a page: the scripted CDP peer.
 * They run under Node; the package's shipped source never imports them.
 */
export {
  CdpFailure,
  SCRIPTED_SCREENSHOT,
  scriptedCdpPeer,
  type CommandAnswer,
  type CommandCall,
  type InPageCall,
  type ScriptedCdpPeer,
  type ScriptedDocument,
  type ScriptedFrame,
  type ScriptedTarget,
  type SentCommand,
} from "./scripted-cdp-peer.js";

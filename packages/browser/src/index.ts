/**
 * The browser package (browser spec, "Packages and pieces"): what runs in
 * every browser, so the extension, the drivers and the environment read a
 * page alike. It depends on contracts alone, Mozilla Readability vendored
 * (./vendor/), and imports no Node built-in and no environment code, so the
 * extension can depend on it.
 */
export { frameUntrusted } from "./frame.js";
export { TOKEN_SHAPES, redactTokens, redactedFieldValue, secretField, type FieldAttributes, type SecretField, type TokenShapeId } from "./redaction.js";
export { CHALLENGE_MARKERS, detectChallenge, type ChallengeMarkers } from "./challenge.js";
export { SHELL_TEXT_CHARS, isShell } from "./shell.js";
export { READ_PAGE_CHARS, pageStatement, pageText, type TextPage } from "./paging.js";
export { articleMarkdown, type MarkdownOptions, type ReaderArticle } from "./markdown.js";
export { readArticle, readFetchedPage, type FetchedPage } from "./reader.js";
export { CdpError, type CdpEvent, type CdpParams, type CdpSession, type CdpTransport } from "./cdp/session.js";
export { cdpConnection, type CdpConnection } from "./cdp/connection.js";
export { webSocketTransport } from "./cdp/web-socket.js";
export { pipeTransport, type CdpPipe } from "./cdp/pipe.js";
export { cdpPageDriver, type CdpPageDriverOptions, type PageHost } from "./driver/driver.js";
export { VIEWPORT, systemDriverClock, type DriverClock, type FrameArrival } from "./driver/page.js";

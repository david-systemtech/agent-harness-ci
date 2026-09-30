/**
 * The part of jsdom the extraction worker uses: jsdom ships no declarations
 * of its own. The environment has no DOM types, so the document is handed
 * to the browser package's reader, whose own declarations type it.
 */
declare module "jsdom" {
  export class VirtualConsole {}
  export class JSDOM {
    constructor(html: string | Uint8Array, options?: { readonly url?: string; readonly contentType?: string; readonly virtualConsole?: VirtualConsole });
    readonly window: { readonly document: Parameters<typeof import("@agent-harness/browser").readFetchedPage>[0] };
  }
}

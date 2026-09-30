/**
 * The part of jsdom the tests use, typed with the DOM's own types: jsdom
 * ships no declarations of its own, and a page is all the tests ask of it.
 */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { readonly url?: string; readonly runScripts?: "outside-only" | "dangerously"; readonly pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis;
  }
}

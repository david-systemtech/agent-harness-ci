/**
 * The part of jsdom the options page's tests use, typed with the DOM's own
 * types: jsdom ships no declarations of its own, and a window over the
 * page's markup is all the tests ask of it.
 */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}

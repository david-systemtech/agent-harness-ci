/** The camera tests' jsdom window, typed inside their DOM project alone. */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { readonly url?: string });
    readonly window: Window & typeof globalThis;
  }
}

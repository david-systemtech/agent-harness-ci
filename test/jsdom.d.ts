/** The smoke helper's DOM fixture; jsdom ships no declarations of its own. */
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string);
    readonly window: {
      readonly document: { querySelector(selector: string): { remove(): void } | null };
      close(): void;
    };
  }
}

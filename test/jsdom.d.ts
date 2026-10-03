/** The smoke helper's DOM fixture; jsdom ships no declarations of its own. */
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string);
    readonly window: {
      readonly document: {
        readonly body: { innerHTML: string };
        querySelector(selector: string): { remove(): void; addEventListener(type: string, listener: () => void): void } | null;
      };
      close(): void;
    };
  }
}

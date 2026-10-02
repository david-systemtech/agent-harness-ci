import { join } from "node:path";
import { DATA_FILES } from "./folders.js";
import { readStore } from "./stores.js";

/** Only the policy and an omission count leave the credential-bearing source store. */
export interface SourceBrowser {
  readonly devSites: readonly string[];
  readonly evaluateEverywhere?: boolean;
  readonly pairings: number;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const readSourceBrowser = (folder: string) =>
  readStore<SourceBrowser>(join(folder, DATA_FILES.browser), { name: "The Browser store", is: "is" }, (value) => {
    if (!record(value)) return { refused: "The Browser store holds no object." };
    const policy = value["policy"];
    const browsers = value["browsers"];
    return {
      devSites: record(policy) && Array.isArray(policy["devSites"]) ? policy["devSites"].filter((site): site is string => typeof site === "string" && site.length > 0) : [],
      ...(record(policy) && "evaluateEverywhere" in policy && { evaluateEverywhere: policy["evaluateEverywhere"] === true }),
      pairings: Array.isArray(browsers) ? browsers.length : 0,
    };
  }, { devSites: [], pairings: 0 });

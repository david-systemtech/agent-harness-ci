import type { AccountCatalogue, AccountRecord, ModelEntry } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { addFavourite, favouriteCandidates, favouriteModelIds, moveFavourite, pickerModels, pinWords, recommendedModels, removeFavourite } from "./favourites.js";

/** The account and model picker's order (#1821): the favourites first, the provider's recommended models without them, every other model under Other models. */

const model = (id: string, family: string, tier = 1): ModelEntry => ({ id, family, tier, efforts: [], label: null });
const ids = (models: readonly ModelEntry[]) => models.map((entry) => entry.id);

const WORK: AccountCatalogue = { accountId: "work", live: true, models: [model("opus-5", "opus", 2), model("opus-5-1m", "opus", 2), model("sonnet-5", "sonnet"), model("haiku-4", "haiku", 0), model("fable-5", "fable", 3)] };
const HOME: AccountCatalogue = { accountId: "home", live: false, models: [model("opus-5", "opus", 2), model("sonnet-4", "sonnet"), model("haiku-3", "haiku", 0)] };

describe("the picker's models", () => {
  it("lists the favourites the account offers first, in the person's order, and every other model it lists under Other models", () => {
    const picked = pickerModels([WORK, HOME], "work", ["sonnet-5", "retired-model", "opus-5"]);
    expect(picked.pinned).toBe(true);
    expect(ids(picked.quick)).toEqual(["sonnet-5", "opus-5"]);
    expect(picked.grouped).toBe(false);
    expect(picked.others.map((group) => [group.accountId, ids(group.models)])).toEqual([["work", ["opus-5-1m", "haiku-4", "fable-5"]]]);
  });

  it("offers the provider's recommended models, the first it lists of each family, while no favourite is pinned or none is listed", () => {
    expect(ids(recommendedModels(WORK.models))).toEqual(["opus-5", "sonnet-5", "haiku-4", "fable-5"]);
    for (const favourites of [[], ["sonnet-4"]]) {
      const picked = pickerModels([WORK, HOME], "work", favourites);
      expect(picked.pinned).toBe(false);
      expect(ids(picked.quick)).toEqual(["opus-5", "sonnet-5", "haiku-4", "fable-5"]);
      expect(picked.others.flatMap((group) => ids(group.models))).toEqual(["opus-5-1m"]);
    }
  });

  it("keeps the session's model among the quick picks, after the favourites, when it is not one", () => {
    const picked = pickerModels([WORK], "work", ["sonnet-5"], "haiku-4");
    expect(ids(picked.quick)).toEqual(["sonnet-5", "haiku-4"]);
    expect(picked.others.flatMap((group) => ids(group.models))).toEqual(["opus-5", "opus-5-1m", "fable-5"]);
    expect(ids(pickerModels([WORK], "work", ["sonnet-5"], "sonnet-5").quick)).toEqual(["sonnet-5"]);
    expect(ids(pickerModels([WORK], "work", ["sonnet-5"], "not-listed").quick)).toEqual(["sonnet-5"]);
  });

  it("groups Other models by account while the session has no account, each model once under the first account that lists it", () => {
    const picked = pickerModels([WORK, HOME], null, ["opus-5"]);
    expect(picked.grouped).toBe(true);
    expect(ids(picked.quick)).toEqual(["opus-5"]);
    expect(picked.others.map((group) => [group.accountId, ids(group.models)])).toEqual([
      ["work", ["opus-5-1m", "sonnet-5", "haiku-4", "fable-5"]],
      ["home", ["sonnet-4", "haiku-3"]],
    ]);
    expect(pickerModels([WORK], null, []).grouped).toBe(false);
    expect(pickerModels([], "work", ["opus-5"])).toEqual({ quick: [], pinned: false, grouped: false, others: [] });
  });

  it("offers a favourite an earlier carry over wrote as `<account>/<model>` as the model it names, each once (#1954)", () => {
    const picked = pickerModels([WORK, HOME], "work", ["home/sonnet-5", "work/opus-5", "sonnet-5", "home/retired-model"]);
    expect(picked.pinned).toBe(true);
    expect(ids(picked.quick)).toEqual(["sonnet-5", "opus-5"]);
    expect(picked.others.flatMap((group) => ids(group.models))).toEqual(["opus-5-1m", "haiku-4", "fable-5"]);
  });

  it("says how to pin favourites while the quick picks are the recommended ones", () => {
    expect(pinWords(pickerModels([WORK], "work", []), [])).toBe("Recommended models. Pin your favourites in Settings, Default account and model.");
    expect(pinWords(pickerModels([WORK], "work", ["sonnet-4"]), ["sonnet-4"])).toBe("None of your favourites is listed for this account: recommended models.");
    expect(pinWords(pickerModels([WORK], "work", ["sonnet-5"]), ["sonnet-5"])).toBeUndefined();
  });
});

describe("the favourite models in Settings", () => {
  const account = (id: string, state: AccountRecord["status"]["state"]) => ({ id, status: { state } }) as AccountRecord;

  it("adds from the models the signed-in accounts offer, each once, leaving out the favourites", () => {
    const candidates = favouriteCandidates([WORK, HOME], [account("work", "signed-in"), account("home", "signed-out")], ["opus-5", "sonnet-5"]);
    expect(candidates.map((group) => [group.accountId, ids(group.models)])).toEqual([["work", ["opus-5-1m", "haiku-4", "fable-5"]]]);
    const both = favouriteCandidates([WORK, HOME], [account("work", "signed-in"), account("home", "signed-in")], WORK.models.map((entry) => entry.id));
    expect(both.map((group) => [group.accountId, ids(group.models)])).toEqual([["home", ["sonnet-4", "haiku-3"]]]);
  });

  it("reads each favourite as the model id it names: itself when listed, else the part after its last `/`, each once (#1954)", () => {
    const listed = new Set(["opus-5", "vendor/model-1"]);
    expect(favouriteModelIds(["account-a/opus-5", "opus-5", "vendor/model-1", "account-b/retired-model", "plain"], listed)).toEqual(["opus-5", "vendor/model-1", "retired-model", "plain"]);
    expect(favouriteModelIds(["account-a/"], listed)).toEqual(["account-a/"]);
    const candidates = favouriteCandidates([WORK], [account("work", "signed-in")], ["account-a/opus-5", "account-a/sonnet-5"]);
    expect(candidates.flatMap((group) => ids(group.models))).toEqual(["opus-5-1m", "haiku-4", "fable-5"]);
  });

  it("adds at the end, removes, and moves one place up or down, keeping the rest in order", () => {
    expect(addFavourite(["opus-5"], "sonnet-5")).toEqual(["opus-5", "sonnet-5"]);
    expect(addFavourite(["opus-5"], "opus-5")).toEqual(["opus-5"]);
    expect(removeFavourite(["opus-5", "sonnet-5", "haiku-4"], "sonnet-5")).toEqual(["opus-5", "haiku-4"]);
    expect(moveFavourite(["opus-5", "sonnet-5", "haiku-4"], "haiku-4", -1)).toEqual(["opus-5", "haiku-4", "sonnet-5"]);
    expect(moveFavourite(["opus-5", "sonnet-5", "haiku-4"], "opus-5", 1)).toEqual(["sonnet-5", "opus-5", "haiku-4"]);
    expect(moveFavourite(["opus-5", "sonnet-5"], "opus-5", -1)).toEqual(["opus-5", "sonnet-5"]);
    expect(moveFavourite(["opus-5", "sonnet-5"], "sonnet-5", 1)).toEqual(["opus-5", "sonnet-5"]);
  });
});

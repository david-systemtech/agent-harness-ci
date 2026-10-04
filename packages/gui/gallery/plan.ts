import { resolve } from "node:path";
import { capturePlan, sceneFiles } from "./capture-plan.js";

// Planning reads scene filenames only; it runs no browser or component module.
const plan = capturePlan(await sceneFiles(resolve(import.meta.dirname, "scenes")));
if (plan.shards.length === 0) throw new Error("The gallery has no scenes.");
console.log(`matrix=${JSON.stringify({ include: plan.shards.map(shard => ({ shard: shard.index, artifact: shard.count === 1 ? "window-gallery" : `window-gallery-shard-${shard.index}` })) })}`);

import { capturePlan, sceneFiles } from "./capture-plan.js";

// Filename discovery runs on Node and never starts a browser or imports scene components.
const plan = capturePlan(await sceneFiles(new URL("./scenes", import.meta.url).pathname));
if (plan.shards.length === 0) throw new Error("The gallery has no scenes.");
console.log(JSON.stringify(plan.shards.map(shard => shard.id)));

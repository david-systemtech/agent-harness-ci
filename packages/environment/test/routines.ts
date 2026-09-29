import { randomUUID } from "node:crypto";
import {
  ROUTINE_STREAM_KIND,
  registry,
  type EventEnvelope,
  type EventFrame,
  type ListedRoutine,
  type ParamsOf,
  type Registry,
  type ResponseOf,
  type RoutineDefinitionInput,
} from "@agent-harness/contracts";
import type { z } from "zod";
import type { TestEnvironment } from "./helper.js";
import type { WireClient } from "./wire-client.js";

/**
 * What the routine suites share (routines spec; #521): a definition as a
 * client writes it, the routine commands sent as a client sends them, the
 * list, and the routine events and notices the log holds.
 */

/** A definition as a client writes it: every field without a preset, the rest left out. */
export const written = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => ({
  name: "Upstream watch",
  schedule: { kind: "weekly", day: "monday", at: "03:00" },
  instructions: "Read the sources and file a digest.",
  workspace: { kind: "scratch", repositoryIdentity: null },
  account: null,
  model: null,
  effort: null,
  mode: null,
  containment: null,
  skills: [],
  preCheck: null,
  enabled: true,
  ...overrides,
});

/** A routine command's params as a client writes them (what has a preset may be left out), but its command id, which the helpers mint unless given. */
type Params<N extends RoutineCommand> = Omit<z.input<Registry[N]["params"]>, "commandId"> & { commandId?: string };

/** The routine commands this suite drives. */
export type RoutineCommand = "routines.create" | "routines.update" | "routines.enable" | "routines.disable" | "routines.delete";

/** Sends a routine command with a fresh command id unless one is given; resolves with what its response carries, checked against its schema. */
export const routineCommand = async <N extends RoutineCommand>(client: WireClient, method: N, params: Params<N>): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Sends `routines.create` for a fresh routine id (or the one given); resolves with the id and what the response carries. */
export const createRoutine = async (client: WireClient, definition: RoutineDefinitionInput = written(), params: { routineId?: string; commandId?: string } = {}) => {
  const routineId = params.routineId ?? randomUUID();
  return { routineId, ...(await routineCommand(client, "routines.create", { ...params, routineId, definition })) };
};

/** The routine a create made; throws unless the create was accepted. */
export const created = async (client: WireClient, definition: RoutineDefinitionInput = written()): Promise<ListedRoutine> => {
  const answer = await createRoutine(client, definition);
  if (answer.result === undefined) throw new Error(`routines.create was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.routine;
};

/** Every routine `routines.list` answers, in its order. */
export const listRoutines = async (client: WireClient): Promise<ListedRoutine[]> => (await client.request("routines.list", {})).routines;

/** The routine `routines.list` answers under `routineId`; undefined when it lists none. */
export const listed = async (client: WireClient, routineId: string): Promise<ListedRoutine | undefined> =>
  (await listRoutines(client)).find((routine) => routine.state.id === routineId);

/** The events on the routines' streams, or on one routine's, each as its type, payload and actor. */
export const routineEvents = (t: TestEnvironment, routineId?: string) =>
  t.env.log
    .readStream({ kinds: [ROUTINE_STREAM_KIND] })
    .filter((event) => routineId === undefined || event.streamId === routineId)
    .map((event) => ({ type: event.type, payload: event.payload, actor: event.actor }));

/** The `routine.updated` notices a client reads on `environment.subscribe` after `afterSequence`, up to where it is synchronized. */
export const routineUpdates = async (client: WireClient, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type === "routine.updated");
    events.push((frame as EventFrame).event);
  }
};

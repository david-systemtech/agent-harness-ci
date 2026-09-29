import { createHash } from "node:crypto";
import {
  ENVIRONMENT_COLOURS,
  ENVIRONMENT_STREAM_KIND,
  EnvironmentColour,
  EnvironmentIcon,
  EnvironmentName,
  normaliseEnvironmentName,
  type EnvironmentLook,
} from "@agent-harness/contracts";
import type { EventLog, Projector, StreamRef } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * An environment's name, icon and colour (workspace-picker spec, "Name,
 * icon and colour"; ADR 0005, ADR 0025): a projection over the three
 * notices its commands append on the environment stream, starting from the
 * record's name and the presets. The record file keeps the id, the creation
 * time and the first name; nothing here writes it.
 */

/**
 * The name a new environment takes from its machine: the hostname's first
 * label (`mnl` of `mnl.tail1234.ts.net`), else the hostname whole.
 */
export const nameOfHostname = (hostname: string): string => {
  const whole = hostname.trim();
  return whole.split(".")[0] || whole;
};

/** The icon until one is set: `container` in a container (the env spec's rule), else a laptop on macOS, a desktop on Windows, a server on Linux and anything else. */
export const presetIcon = (inContainer: boolean, platform: NodeJS.Platform): EnvironmentIcon => {
  if (inContainer) return "container";
  if (platform === "darwin") return "laptop";
  return platform === "win32" ? "desktop" : "server";
};

/**
 * The colour until one is set: one of the twelve by a hash of the
 * environment's id (SHA-256's first four bytes, modulo twelve), so every
 * start, and every version, gives the same one.
 */
export const presetColour = (environmentId: string): EnvironmentColour =>
  ENVIRONMENT_COLOURS[createHash("sha256").update(environmentId.toLowerCase()).digest().readUInt32BE(0) % ENVIRONMENT_COLOURS.length] as EnvironmentColour;

/** Each notice, the field it sets and the schema its value is read back with. */
const FIELDS = {
  "environment.renamed": { field: "name", schema: EnvironmentName },
  "environment.icon-set": { field: "icon", schema: EnvironmentIcon },
  "environment.colour-set": { field: "colour", schema: EnvironmentColour },
} as const;
type LookNotice = keyof typeof FIELDS;

export const LOOK_PROJECTOR = "environment-look";

export const LOOK_TABLES = {
  environment_look: `CREATE TABLE environment_look (
    field TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
} as const;

/** The read model: one row per field a notice has set, its latest value. A field with no row holds its preset. */
export const lookProjector: Projector = {
  name: LOOK_PROJECTOR,
  tables: LOOK_TABLES,
  apply(event, db) {
    if (event.streamKind !== ENVIRONMENT_STREAM_KIND || !Object.hasOwn(FIELDS, event.type)) return;
    const { field } = FIELDS[event.type as LookNotice];
    db.run("INSERT INTO environment_look (field, value) VALUES (?, ?) ON CONFLICT (field) DO UPDATE SET value = excluded.value", field, String(event.payload[field]));
  },
};

/** The fields the notices set, each whose stored value still passes its schema. */
const readSet = (reader: Reader): Partial<EnvironmentLook> => {
  const set: Record<string, string> = {};
  for (const { field, value } of reader.all<{ field: string; value: string }>("SELECT field, value FROM environment_look")) {
    const entry = Object.values(FIELDS).find((candidate) => candidate.field === field);
    if (entry?.schema.safeParse(value).success === true) set[field] = value;
  }
  return set as Partial<EnvironmentLook>;
};

export interface EnvironmentLookOptions {
  readonly log: EventLog;
  /** The environment's own stream, where the notices go. */
  readonly stream: StreamRef;
  /** The look until a notice sets a field: the record's name, the preset icon and the preset colour. */
  readonly presets: EnvironmentLook;
}

export interface EnvironmentLookService {
  /** The look now: each field's latest notice, else its preset. Inside a command, as of that command's transaction. */
  read(): EnvironmentLook;
  /** The three commands, one per field (ADR 0003). */
  readonly handlers: Required<Pick<MethodHandlers, "environment.rename" | "environment.setIcon" | "environment.setColour">>;
}

export const createEnvironmentLook = (options: EnvironmentLookOptions): EnvironmentLookService => {
  const { log, stream, presets } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const read = (): EnvironmentLook => ({ ...presets, ...readSet(reader) });

  /** Sets one field by its notice: the look after it, with nothing appended for a value already held. */
  const set = <N extends LookNotice>(type: N, value: EnvironmentLook[(typeof FIELDS)[N]["field"]]) => {
    const { field } = FIELDS[type];
    const held = read();
    if (held[field] === value) return { aggregate: stream, result: held };
    return { aggregate: stream, result: { ...held, [field]: value }, events: [{ type, payload: { [field]: value } }] };
  };

  return {
    read,
    handlers: {
      "environment.rename": ({ name }) => set("environment.renamed", normaliseEnvironmentName(name)),
      "environment.setIcon": ({ icon }) => set("environment.icon-set", icon),
      "environment.setColour": ({ colour }) => set("environment.colour-set", colour),
    },
  };
};

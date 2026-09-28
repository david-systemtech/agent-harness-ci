import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceError } from "./errors.js";
import type { ServicePlatform } from "./platform.js";

/** The file in the data directory where `service install` records what it wrote, for `status` and `uninstall`. */
export const SERVICE_RECORD_FILE = "service.json";

/** What `service install` wrote, so `service status` asks on the right port and `service uninstall` removes exactly it. */
export interface ServiceRecord {
  readonly platform: ServicePlatform["kind"];
  readonly definitionPath: string;
  readonly port: number;
  /**
   * The launcher entry the definition runs. A record without one is from
   * before the launcher, whose definition runs `serve` directly, so its
   * service runs no launcher.
   */
  readonly launcherEntry?: string;
  /** Every folder install created, the data directory's included, outermost first; uninstall removes those left empty. */
  readonly createdDirectories: readonly string[];
}

const isRecord = (value: unknown): value is ServiceRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["platform"] === "string" &&
    typeof record["definitionPath"] === "string" &&
    Number.isInteger(record["port"]) &&
    (record["launcherEntry"] === undefined || typeof record["launcherEntry"] === "string") &&
    Array.isArray(record["createdDirectories"]) &&
    record["createdDirectories"].every((dir) => typeof dir === "string")
  );
};

/** The record in `dataDir`: undefined when there is none, a `ServiceError` when there is one that cannot be read. */
export const readServiceRecord = (dataDir: string): ServiceRecord | undefined => {
  const path = join(dataDir, SERVICE_RECORD_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ServiceError(`Could not read ${path}: ${reason}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) throw new ServiceError(`${path} is not a service record; remove it and run the install again.`);
  return parsed;
};

export const writeServiceRecord = (dataDir: string, record: ServiceRecord): void => {
  writeFileSync(join(dataDir, SERVICE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
};

export const removeServiceRecord = (dataDir: string): void => {
  rmSync(join(dataDir, SERVICE_RECORD_FILE), { force: true });
};

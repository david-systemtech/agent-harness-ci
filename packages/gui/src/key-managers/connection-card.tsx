import {
  KEY_MANAGER_PROVIDER_WORDS,
  KEY_MANAGER_STATUS_ADVICE,
  basePathWords,
  cliRowOf,
  cliWords,
  injectsWords,
  methodWords,
  mintWords,
  originWords,
  statusWords,
  tokenWords,
} from "@agent-harness/client-runtime";
import type { KeyManagerConnectionRecord, ManagedToolRow } from "@agent-harness/contracts";
import { useId, type ReactNode } from "react";
import { useClock } from "../window-context.js";

/** One fact of a card: its name and what the connection holds of it; nothing for a fact it holds none of. */
const Fact = ({ name, children }: { readonly name: string; readonly children: ReactNode }) =>
  children === null ? null : (
    <>
      <dt className="text-ink-muted">{name}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </>
  );

export interface ConnectionCardProps {
  readonly connection: KeyManagerConnectionRecord;
  /** The managed tools' rows, or the line saying why they cannot be read here. */
  readonly tools: readonly ManagedToolRow[] | string;
}

/**
 * A key-manager connection's card (key-managers spec, "The connection
 * record"; ADR 0028; #425), drawn from `keyManagers.list`'s record as the
 * request cache holds it: its provider, label and address; how it signs in;
 * its status with its since-time, the environment's line and what that
 * status asks; its token information; whether it can mint run tokens; its
 * base path, or the one suggested; whether runs receive its variables; its
 * CLI's Managed tools row; and where it was copied from.
 */
export const ConnectionCard = ({ connection, tools }: ConnectionCardProps) => {
  const heading = useId();
  const now = useClock().now();
  const advice = KEY_MANAGER_STATUS_ADVICE[connection.status.kind];
  const cli = typeof tools === "string" ? tools : cliRowOf(connection.provider, tools);
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id={heading} className="text-base font-semibold text-ink">
        {connection.label}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <Fact name="Provider">{KEY_MANAGER_PROVIDER_WORDS[connection.provider]}</Fact>
        <Fact name="Address">{connection.address}</Fact>
        <Fact name="Signs in by">{methodWords(connection)}</Fact>
        <Fact name="Status">{statusWords(connection.status, now)}</Fact>
        <Fact name="Token">{tokenWords(connection.tokenInformation, now)}</Fact>
        <Fact name="Run tokens">{mintWords(connection.canMint)}</Fact>
        <Fact name="Base path">{basePathWords(connection)}</Fact>
        <Fact name="Runs">{injectsWords(connection)}</Fact>
        <Fact name="CLI">{cli === undefined ? null : typeof cli === "string" ? cli : cliWords(cli)}</Fact>
        <Fact name="Copied from">{originWords(connection)}</Fact>
      </dl>
      <p className="text-sm text-ink">
        {connection.status.message}
        {advice !== null && <span className="text-ink-muted"> {advice}</span>}
      </p>
    </section>
  );
};

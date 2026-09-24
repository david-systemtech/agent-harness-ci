import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { actionWords, type ClientSessionRow, type EnvironmentAction } from "../commands/environment.js";
import type { MintedLines } from "../commands/pair.js";
import { clockTime, nameOf, phaseWords } from "../view.js";

/** The open card: `/environment`'s list, a connection's actions, its client sessions, a minted pairing code. */

const Row = (props: { readonly selected: boolean; readonly children: ReactNode; readonly dim?: boolean }) => (
  <Text wrap="truncate-end" inverse={props.selected} dimColor={props.dim ?? false}>
    {props.selected ? "› " : "  "}
    {props.children}
  </Text>
);

const pad = (text: string, width: number) => (text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width));

/** `/environment`: every saved connection with its kind, phase, version and "unreachable since". */
export const EnvironmentsCard = (props: { readonly views: readonly EnvironmentView[]; readonly cursor: number }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold>
      Environments <Text dimColor>↑↓ move · Enter actions · Esc close</Text>
    </Text>
    {props.views.length === 0 && <Text dimColor>No environment is saved: /pair one.</Text>}
    {props.views.map((view, index) => (
      <Box key={view.environmentId} flexDirection="column">
        <Row selected={index === props.cursor} dim={!view.enabled}>
          {pad(nameOf(view), 16)}
          {pad(view.kind, 8)}
          {pad(phaseWords(view), 24)}
          {pad(view.version ?? "unknown", 12)}
          {view.primary ? "primary" : ""}
        </Row>
        {view.unreachableSince !== null && (
          <Text dimColor wrap="truncate-end">
            {"    "}unreachable since {clockTime(view.unreachableSince)}
          </Text>
        )}
      </Box>
    ))}
  </Box>
);

/** A connection's actions: enable or disable, remove, set primary, client sessions. */
export const EnvironmentMenu = (props: { readonly view: EnvironmentView; readonly actions: readonly EnvironmentAction[]; readonly cursor: number }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold>
      {nameOf(props.view)} <Text dimColor>↑↓ move · Enter choose · Esc back</Text>
    </Text>
    {props.actions.map((action, index) => (
      <Row key={action} selected={index === props.cursor}>
        {actionWords[action]}
      </Row>
    ))}
  </Box>
);

/** The environment's live client sessions: `access.sessions.list`; Enter revokes one. */
export const ClientSessionsCard = (props: {
  readonly view: EnvironmentView;
  readonly rows: readonly ClientSessionRow[] | undefined;
  readonly own: string | null;
  readonly cursor: number;
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold>
      Client sessions on {nameOf(props.view)} <Text dimColor>↑↓ move · Enter revoke · Esc back</Text>
    </Text>
    {props.rows === undefined && <Text dimColor>Listing…</Text>}
    {props.rows?.map((row, index) => (
      <Row key={row.id} selected={index === props.cursor}>
        {pad(row.label, 20)}
        {pad(row.kind, 8)}
        {pad(row.local ? "local" : "paired", 7)}
        {row.lastSeenAt === null ? "never seen" : `seen ${clockTime(row.lastSeenAt)}`}
        {row.id === props.own ? "  (this terminal)" : ""}
      </Row>
    ))}
  </Box>
);

/** `/pair create`'s answer: the link, the short code and a QR of the link in block characters. */
export const MintedCard = (props: { readonly lines: MintedLines }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text wrap="truncate-end">{props.lines.heading}</Text>
    <Text wrap="truncate-end">{props.lines.link}</Text>
    <Text wrap="truncate-end">{props.lines.code}</Text>
    <Text>{props.lines.qr.join("\n")}</Text>
    <Text dimColor>Esc closes</Text>
  </Box>
);

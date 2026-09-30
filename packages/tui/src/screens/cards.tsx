import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { actionWords, type ClientSessionRow, type EnvironmentAction } from "../commands/environment.js";
import type { MintedLines } from "../commands/pair.js";
import type { HelpLine } from "../help.js";
import { clockTime, nameOf, phaseWords } from "../view.js";

/**
 * The open card: `/environment`'s list, a connection's actions, its client
 * sessions, a minted pairing code, the help overlay. Each card's hint line
 * is handed in, written from the keymap in force, so a remapped key is the
 * one it names.
 */

const Row = (props: { readonly selected: boolean; readonly children: ReactNode; readonly dim?: boolean }) => (
  <Text wrap="truncate-end" inverse={props.selected} dimColor={props.dim ?? false}>
    {props.selected ? "› " : "  "}
    {props.children}
  </Text>
);

const pad = (text: string, width: number) => (text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width));

/** `/environment`: every saved connection with its kind, phase, version and "unreachable since". */
export const EnvironmentsCard = (props: { readonly views: readonly EnvironmentView[]; readonly cursor: number; readonly hint: string }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold>
      Environments <Text dimColor>{props.hint}</Text>
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

/** A connection's actions: enable or disable, remove, set primary, client sessions, rename, icon and colour. */
export const EnvironmentMenu = (props: {
  readonly view: EnvironmentView;
  readonly actions: readonly EnvironmentAction[];
  readonly cursor: number;
  readonly hint: string;
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold>
      {nameOf(props.view)} <Text dimColor>{props.hint}</Text>
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
  readonly hint: string;
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold>
      Client sessions on {nameOf(props.view)} <Text dimColor>{props.hint}</Text>
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
export const MintedCard = (props: { readonly lines: MintedLines; readonly hint: string }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text wrap="truncate-end">{props.lines.heading}</Text>
    <Text wrap="truncate-end">{props.lines.link}</Text>
    <Text wrap="truncate-end">{props.lines.code}</Text>
    <Text>{props.lines.qr.join("\n")}</Text>
    <Text dimColor>{props.hint}</Text>
  </Box>
);

/** The widest key column the help overlay draws; a longer usage line pushes its description on. */
const HELP_KEY_WIDTH = 24;

/**
 * `/help` and `?`: the effective map, `height` lines of it from `top`:
 * a heading per group, a row per action with
 * its keys and what it does, a remapped row marked, a row not answered yet
 * dim with "(soon)", an absent row dim with its reason under it.
 */
export const HelpCard = (props: { readonly lines: readonly HelpLine[]; readonly top: number; readonly height: number; readonly hint: string }) => {
  const shown = props.lines.slice(props.top, props.top + props.height);
  const below = props.lines.length - props.top - shown.length;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">
        Keys <Text dimColor>everything the terminal answers · {props.hint}</Text>
      </Text>
      {shown.map((line, index) => {
        if (line.kind === "heading") {
          return (
            <Text key={index} bold wrap="truncate-end">
              {line.text}
            </Text>
          );
        }
        if (line.kind === "reason") {
          return (
            <Text key={index} dimColor wrap="truncate-end">
              {" ".repeat(HELP_KEY_WIDTH + 2)}absent: {line.text}
            </Text>
          );
        }
        const dim = line.state !== "answered";
        // A conditioned row says when its keys are answered, after them, as the spec's table writes it.
        const keys = line.condition === undefined ? line.keys : `${line.keys} (${line.condition})`;
        return (
          <Text key={index} wrap="truncate-end">
            <Text color="cyan" dimColor={dim}>
              {keys.length > HELP_KEY_WIDTH ? `${keys}  ` : keys.padEnd(HELP_KEY_WIDTH + 2)}
            </Text>
            <Text dimColor={dim}>
              {line.description}
              {line.remapped ? " (remapped)" : ""}
              {line.state === "soon" ? " (soon)" : ""}
            </Text>
          </Text>
        );
      })}
      <Text dimColor>{below > 0 ? `${below} more below` : " "}</Text>
    </Box>
  );
};

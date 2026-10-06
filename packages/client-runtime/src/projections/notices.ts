import { EnvironmentNotice, type AutoDecider, type EventEnvelope, type WorkspaceKeptReason } from "@agent-harness/contracts";
import type { Notice, NoticeInput, Notices } from "../notices.js";
import { credentialUpdateFailedWords } from "../updates/words.js";

/**
 * The notices `environment.subscribe` raises (docs/specs/client-runtime.md,
 * "Projections", `projections.notices`): what the environment's own stream
 * says that is news to this client (an event that applied after the stream
 * synchronized, or replayed onto a cursor it held; never a replay onto an
 * empty cache, which is history). Each notice's words are here, so every
 * renderer says the same:
 *
 * - `environment.updated`: `updated`, "<name> was updated from A to B." (#127);
 * - `environment.update-failed`: `update-failed`, "<name> could not be
 *   updated to B (<stage>: <reason>). It is running A." (#344);
 * - `environment.draining`: one `draining` condition per environment;
 * - `environment.started`: takes back that environment's obsolete drain, history too;
 * - `account.updated`: `account`, when the environment gives a warning (a
 *   login that reads as another identity, a sign-in refused as a duplicate)
 *   or the account's sign-in status changed; a relabel, an adoption, an
 *   addition or a removal it asked for itself is shown by
 *   `projections.accounts` and needs no notice;
 * - `prompt.parked`: `prompt-parked`, naming the session, run and prompt;
 * - `prompt.resolved`: the parked prompt's notice is taken back, since it
 *   asks for nothing any more (a resolution heard as history takes it back
 *   too, saying nothing: `settled`); and when nobody answered it (an automatic
 *   rule: its TTL, its run ending first, the provider cancelling it) while
 *   its notice was still showing, a `prompt-resolved` notice says how it was
 *   settled. A person's answer, from any client, raises none;
 * - `routine.delivered`: `routine`, "<routine> on <name>: <summary>" (#525),
 *   marked with its outcome, a success or a failure, and about the firing's
 *   session, which opening it opens; a skip's is about none;
 * - `workspace.kept`: `workspace-kept`, "<name> kept the worktree <path>
 *   (branch <branch>) when <title> was purged: <why>." (#330), about no
 *   session, since the one it was is gone.
 *
 * `signin.updated`, `signin.executable-chosen`, `environment.started` and
 * `usage.updated` (#136) raise none: the sign-in flow shows its own state, a
 * start is the connection's phase, and plan usage is `projections.usage`'s.
 * Nor do `environment.renamed`, `environment.icon-set` and
 * `environment.colour-set` (#323): the connection descriptor takes them, so
 * `projections.environments` redraws the badge, and a change another client
 * made is no news to announce.
 * An update's pending, started and cancelled notices (#335) raise none:
 * they change the card and About, which follow `updates.status` as the
 * request cache fetches it again on every update notice (#344). The
 * routines' other notices raise none: `routine.updated`,
 * `routine.endpoint-set` and `routine.endpoint-removed` change what
 * `routines.list` and `routines.endpoints.list` answer, which the routines'
 * projections follow (#532), and final webhook failures raise their own row (#529).
 * The forge's rows are
 * `forge-notices.ts`'s (#320). A key-manager connection's status rows (ADR
 * 0011: a failed verification raises a client notice) are
 * `key-manager-notices.ts`'s (#384); Move's events raise none, since its
 * answer and the cached `keyManagers.move.list` show them. `settings.changed`
 * (#391) raises none: what changed shows where the settings are read, which
 * the request cache fetches again on it. `skills.updated` (#494) raises
 * none: it refreshes the cached `skills.get`; nor does `trust.updated`
 * (#500), which refreshes the cached `trust.get` and `trust.list`; nor
 * does `instructions.updated` (#505), which refreshes the cached
 * `instructions.list` and `instructions.preview`; nor
 * `carry-over.imported` (#578) or `carry-over.memory-assigned` (#580),
 * which refresh the cached `carryOver.inventory`; nor
 * `state-import.finished` (#581), which
 * refreshes the cached `stateImport.detect`; nor `denylist.updated` and
 * `review.updated` (#811), which refresh the cached denylist, permission
 * settings and Unattended review.
 */

export interface EnvironmentNoticeContext {
  /** The environment's name, as its record has it. */
  readonly name: string;
  /** An account's label, when the runtime has read the environment's accounts; null otherwise. */
  readonly accountLabel: (accountId: string) => string | null;
  /** A session's title as the list shows it; null for one the list does not hold. */
  readonly title: (sessionId: string) => string | null;
}

/** Why the reaper kept a worktree, as a notice says it (#330). */
const KEPT_BECAUSE: Readonly<Record<WorkspaceKeptReason, string>> = {
  uncommitted_changes: "it has uncommitted changes",
  git_filters_refused: "its repository configures filters the environment will not run to check it",
  git_failed: "git could not check or remove it",
};

/** Why a prompt was settled with nobody answering it, as a notice says it. */
const AUTOMATIC: Readonly<Record<AutoDecider, string>> = {
  ttl: "nobody answered it before its time ran out",
  unattended: "nobody was present to answer it",
  bypass: "the run bypasses permissions",
  run_ended: "its run ended first",
  reviewer: "the provider's reviewer decided it",
  cancelled: "the provider withdrew it",
};

export interface EnvironmentNotices {
  /** Raises what `event`, news on the environment's stream, says, and takes back what it settles. */
  heard(environmentId: string, event: EventEnvelope, context: EnvironmentNoticeContext): void;
  /**
   * A parked prompt was resolved, heard as history (replayed onto a stream
   * that held nothing, as after the environment was removed and added
   * again): its notice, if one still shows, is taken back, and nothing is
   * raised, since the resolution is not news.
   */
  settled(environmentId: string, sessionId: string, promptId: string): void;
  /** A start supersedes the preceding drain, even when replayed as history. */
  restarted(environmentId: string, sequence: number): void;
  /** A ready snapshot supersedes drains even when the log head has been reset. */
  ready(environmentId: string): void;
}

export const createEnvironmentNotices = (notices: Notices): EnvironmentNotices => {
  // Associate the displayed condition with its stream position without retaining dismissed notices.
  const drainingSequences = new WeakMap<Notice, number>();
  /** What each parked prompt's notice was raised for, by notice id: the words its resolution says it with. */
  const parkedPrompts = new Map<string, { readonly title: string; readonly summary: string }>();

  /** Takes a parked prompt's notice off the queue: the notice, and the words it was raised with; undefined when none shows. */
  const takeBack = (environmentId: string, sessionId: string, promptId: string) => {
    const parked = (n: Notice) =>
      n.environmentId === environmentId && n.kind === "prompt-parked" && n.about?.promptId === promptId && n.about.sessionId.toLowerCase() === sessionId.toLowerCase();
    const [taken] = notices.retire(parked);
    if (taken === undefined) return undefined;
    const words = parkedPrompts.get(taken.id);
    parkedPrompts.delete(taken.id);
    return { taken, words };
  };

  return {
    ready(environmentId) {
      notices.retire((notice) => notice.environmentId === environmentId && notice.kind === "draining");
    },
    restarted(environmentId, sequence) {
      notices.retire((notice) => notice.environmentId === environmentId && notice.kind === "draining" && (drainingSequences.get(notice) ?? Infinity) < sequence);
    },
    heard(environmentId, event, context) {
      const parsed = EnvironmentNotice.safeParse(event);
      // A notice this client does not know (a newer environment's), or one that is not a notice at all (a client-addressed call), raises nothing.
      if (!parsed.success) return;
      const notice = parsed.data;
      const { name } = context;
      const raise = (draft: NoticeInput): Notice => notices.raise(environmentId, draft);
      switch (notice.type) {
        case "environment.updated":
          raise({ kind: "updated", message: `${name} was updated from ${notice.payload.fromVersion} to ${notice.payload.toVersion}.`, action: null });
          return;
        case "environment.update-failed": {
          const { fromVersion, toVersion, stage, reason } = notice.payload;
          if (reason === "credential") {
            // The desktop may have said it already, from the record the ended start left (#1689): this, which knows the version running, replaces it.
            const said = credentialUpdateFailedWords(name, toVersion);
            notices.retire((each) => each.environmentId === environmentId && each.kind === "update-failed" && each.message === said);
            raise({ kind: "update-failed", message: credentialUpdateFailedWords(name, toVersion, fromVersion), action: null });
            return;
          }
          raise({ kind: "update-failed", message: `${name} could not be updated to ${toVersion} (${stage}: ${reason}). It is running ${fromVersion}.`, action: null });
          return;
        }
        case "environment.draining": {
          const existing = notices.list.read().find((notice) => notice.environmentId === environmentId && notice.kind === "draining");
          const shown = existing ?? raise({ kind: "draining", message: `${name} is draining: it takes no new runs until it restarts.`, action: null });
          drainingSequences.set(shown, event.sequence);
          return;
        }
        case "account.updated": {
          const { accountId, change, warning } = notice.payload;
          if (warning !== null) raise({ kind: "account", message: `${name}: ${warning}`, action: null });
          else if (change === "status-changed") raise({ kind: "account", message: `${context.accountLabel(accountId) ?? "An account"} on ${name} changed its sign-in status.`, action: null });
          return;
        }
        case "prompt.parked": {
          const { sessionId, runId, promptId, title, summary } = notice.payload;
          const raised = raise({ kind: "prompt-parked", message: `${title} is waiting on ${name}: ${summary}`, action: null, about: { sessionId, runId, promptId } });
          // Only what the queue still shows is kept: a notice dismissed or pushed out is forgotten here too.
          const shown = new Set(notices.list.read().map((n) => n.id));
          for (const id of parkedPrompts.keys()) if (!shown.has(id)) parkedPrompts.delete(id);
          parkedPrompts.set(raised.id, { title, summary });
          return;
        }
        case "prompt.resolved": {
          const { sessionId, promptId, decision, decidedBy } = notice.payload;
          const back = takeBack(environmentId, sessionId, promptId);
          if (back === undefined) return;
          const { taken, words } = back;
          // A person answered it, from some client: nothing more to say.
          if (typeof decidedBy === "string" || words === undefined) return;
          raise({
            kind: "prompt-resolved",
            message: `${context.title(sessionId) ?? words.title}: ${words.summary} was ${decision === "allow" ? "allowed" : "denied"}: ${AUTOMATIC[decidedBy.auto]}.`,
            action: null,
            about: taken.about,
          });
          return;
        }
        case "environment.started":
        case "signin.updated":
        case "signin.executable-chosen":
        case "usage.updated":
          return;
        // The environment's name, icon and colour (#323): the descriptor takes them (`streams.ts`), and the badge redraws.
        case "environment.renamed":
        case "environment.icon-set":
        case "environment.colour-set":
          return;
        // The known environments' union changed (#382) raises none: the request cache reads instructions.list and
        // instructions.preview again, whose block lists it.
        case "environment.known-environments-updated":
          return;
        // An update's other steps change the card and About, which follow `updates.status` in the request cache (#344).
        case "environment.update-pending":
        case "environment.update-started":
        case "environment.update-cancelled":
          return;
        // The forge's rows (a failed capability, a new problem, a git rejection, a missing origin) are `forge-notices.ts`'s, which
        // reads history too (#320).
        case "forge.account.added":
        case "forge.account.updated":
        case "forge.account.primary-set":
        case "forge.account.verified":
        case "forge.account.capability-learned":
        case "forge.account.git-rejected":
        case "forge.account.removed":
        case "forge.origin-missing":
          return;
        // A key-manager connection's status rows (ADR 0011: a failed verification raises a notice) are `key-manager-notices.ts`'s,
        // which reads history too; Move's events raise none: its answer and the cached keyManagers.move.list show them (#384).
        case "key-manager.connection.added":
        case "key-manager.connection.signed-in":
        case "key-manager.connection.signed-out":
        case "key-manager.connection.updated":
        case "key-manager.connection.policies-set":
        case "key-manager.connection.base-path-set":
        case "key-manager.connection.injected-set":
        case "key-manager.connection.verified":
        case "key-manager.connection.removed":
        case "key-manager.moved":
        case "key-manager.stored-value-deleted":
        case "key-manager.value-copied":
          return;
        // A probe changing managed-tool rows raises none: a newer version is a badge, and a required tool missing or below
        // its minimum is its step's health failure (ADR 0026); tools.list's cache follows it (#384). A tool run's start and end
        // (#376) raise none either: the person who ran it watches its terminal, and its row changes through tools.updated.
        case "tools.updated":
        case "tool.run-started":
        case "tool.run-finished":
          return;
        // Settings changed (#391): the request cache reads them again; where they show says what changed.
        case "settings.changed":
          return;
        // The skill set changed (#494): the request cache reads skills.get again, and the Skills pane shows it.
        case "skills.updated":
          return;
        // A trust decision was recorded or revoked (#500): the request cache reads trust.get and trust.list again.
        case "trust.updated":
          return;
        // The denylist or the Unattended review changed (#811): the request cache reads them again, and the Permissions pane
        // and card show them.
        case "denylist.updated":
        case "review.updated":
          return;
        // An owned instruction changed (#505): the request cache reads instructions.list, instructions.preview and instructions.diff (#509) again.
        case "instructions.updated":
          return;
        // An unpaired extension seen (#547) raises none: the Browser card ticks its Load sub-step from browser.status.
        case "extension.seen":
          return;
        // An import of an adopted account's directory ended (#578): the request cache reads carryOver.inventory again,
        // and Carry over's card shows what it did.
        case "carry-over.imported":
          return;
        // A memory folder was assigned to a repository (#580): the request cache reads carryOver.inventory again, and Carry
        // over's card shows it copied.
        case "carry-over.memory-assigned":
          return;
        // A state import ended (#581): the request cache reads stateImport.detect again, and Carry over's card shows its report.
        case "state-import.finished":
          return;
        // A paired Chrome's change (#548) raises none: the request cache reads browser.chromes.list and browser.status again.
        case "chrome.updated":
          return;
        // A routine's result delivered to every connected client (#525): opening the notice opens the firing's session.
        case "routine.delivered": {
          const { name: routine, sessionId, outcome, summary } = notice.payload;
          raise({ kind: "routine", message: `${routine} on ${name}: ${summary}`, action: null, about: sessionId === null ? null : { sessionId, runId: null, promptId: null }, outcome });
          return;
        }
        case "routine.delivery-failed": {
          const { name: routine, endpoint, error } = notice.payload;
          raise({ kind: "routine-delivery-failed", message: `${routine} on ${name} could not deliver to ${endpoint}: ${error}`, action: null });
          return;
        }
        // A worktree kept at its last session's purge (#330): where it is, on which branch, whose it was and why.
        case "workspace.kept": {
          const { path, branch, title, reason } = notice.payload;
          const on = branch === null ? "" : ` (branch ${branch})`;
          raise({ kind: "workspace-kept", message: `${name} kept the worktree ${path}${on} when ${title} was purged: ${KEPT_BECAUSE[reason]}.`, action: null });
          return;
        }
        // The routines' other notices raise none: they change what routines.list and routines.endpoints.list answer, which the
        // routines' projections follow (#532).
        case "routine.updated":
        case "routine.endpoint-set":
        case "routine.endpoint-removed":
          return;
      }
    },
    settled(environmentId, sessionId, promptId) {
      takeBack(environmentId, sessionId, promptId);
    },
  };
};

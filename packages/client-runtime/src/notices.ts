import { uuidv7 } from "./ids.js";
import { writable, type Observable } from "./observable.js";
import type { Clock } from "./platform.js";
import type { ConnectionAction, ConnectionNoticeKind, NoticeDraft } from "./connections/state-machine.js";

/**
 * `projections.notices` (docs/specs/client-runtime.md, "Projections"): the
 * queue of what the runtime has to tell David, newest last, at most
 * `NOTICE_LIMIT` long; dismissal is client-local and never saved. The
 * connection raises its own now (revoked, expired, a protocol mismatch
 * either way, a failed token refresh); `environment.subscribe` (#127) and
 * the outbox's rejections (#128) join the same queue.
 */

/** How many notices are kept; the oldest goes first. A chosen default. */
export const NOTICE_LIMIT = 100;

export type NoticeKind = ConnectionNoticeKind;
export type NoticeAction = ConnectionAction;

export interface Notice {
  /** A UUIDv7, so ids sort by when they were raised. */
  readonly id: string;
  readonly environmentId: string;
  readonly kind: NoticeKind;
  /** One line for people, the same in every renderer. */
  readonly message: string;
  /** What David can do about it, a name the renderer maps to a call: `re-pair`, `update-client`, `update-environment`, `service.start`. */
  readonly action: NoticeAction | null;
  /** When it was raised. */
  readonly at: string;
}

export interface Notices {
  readonly list: Observable<readonly Notice[]>;
  raise(environmentId: string, draft: NoticeDraft): Notice;
  /** Takes a notice off the queue; an id not on it is ignored. */
  dismiss(id: string): void;
}

export const createNotices = (clock: Clock): Notices => {
  const list = writable<readonly Notice[]>([]);
  return {
    list,
    raise(environmentId, draft) {
      const now = clock.now();
      const notice: Notice = { id: uuidv7(now), environmentId, ...draft, at: now.toISOString() };
      list.update((current) => [...current, notice].slice(-NOTICE_LIMIT));
      return notice;
    },
    dismiss(id) {
      list.update((current) => (current.some((n) => n.id === id) ? current.filter((n) => n.id !== id) : current));
    },
  };
};

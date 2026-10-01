import {
  DENYLIST_SECTIONS,
  Denylist,
  ReviewRun,
  denylistPresets,
  denylistTestCall,
  invalidParams,
  matchDenylist,
  type DenylistEntry,
  type DenylistInput,
  type DenylistSection,
  type DenylistTestKind,
} from "@agent-harness/contracts";
import { uuidv4 } from "../ids.js";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";
import { SCRIPTED_HOME } from "./scripted-list.js";

/**
 * The scripted environment's denylist and Unattended review (permissions
 * spec, "The denylist", "The Unattended review view"; #132, #131; #415):
 * `permissions.denylist.get`, `set`, `restorePresets` and `test` over one
 * denylist seeded with the presets but those the script says it lost, each
 * answered as the environment's denylist methods answer them (an entry read
 * by its id within its section, `preset` from the id, a restored preset put
 * back at the end of its section, a test by the contracts' matcher on the
 * scripted home); and `permissions.review.list` and `seen` over the runs the
 * script lists, each decided at start, behind a watermark `seen` moves
 * forward and never back. Each change is said as the environment says it
 * (#811): `denylist.updated` naming the sections a write changed, and
 * `review.updated` when the watermark moves; and the handle makes the
 * changes another client or a run would, said the same way.
 */

export interface ScriptedPermissionsHandle {
  /** The denylist as the environment holds it now. */
  denylist(): Denylist;
  /** The position the Unattended review has been seen through: 0 until it has been. */
  reviewWatermark(): number;
  /** Holds every `permissions.denylist.set` unanswered and unapplied until the function it returns is called, each then applied and answered in the order sent. */
  holdDenylistWrites(): () => void;
  /** Changes the denylist as another client would: each section given becomes those entries, and `denylist.updated` names the ones that changed. */
  setDenylist(sections: Partial<Denylist>): void;
  /** Decides a run into the Unattended review as a run would, the newest it lists, said with `review.updated`. */
  decideReviewRun(run?: Partial<ReviewRun>): void;
  /** Marks the Unattended review seen through the head as another client would, said with `review.updated`. */
  seeReview(): void;
}

export interface PermissionsHost {
  readonly clock: ManualClock;
  readonly wire: FakeWire;
  /** The ids of the presets the denylist has lost at start. */
  readonly lostPresets: readonly string[] | undefined;
  /** The runs the review lists, each over a routine's unattended run in the first session. */
  readonly review: readonly Partial<ReviewRun>[] | undefined;
  /** The session a scripted run belongs to unless it names one: the first the environment holds. */
  sessionId(): string;
  /** The stream's head now, which an accepted receipt names and a list reads. */
  head(): number;
  /** Takes the next sequence: a change appended. */
  next(): number;
  /** A rejection the script names for `method`, if any. */
  refusal(method: string): FakeAnswer | undefined;
  /** Says a notice on the environment's own stream, at the next sequence. */
  notice(type: string, payload: Record<string, unknown>): void;
}

/** The commands this module answers itself, so a receipt the script names is its refusal rather than a generic answer. */
export const PERMISSION_COMMANDS: readonly string[] = ["permissions.denylist.set", "permissions.denylist.restorePresets", "permissions.review.seen"];

export const scriptedPermissions = (host: PermissionsHost): ScriptedPermissionsHandle & { readonly counts: () => Readonly<Record<DenylistSection, number>> } => {
  const { clock, wire } = host;
  const presets = denylistPresets(`${SCRIPTED_HOME}/.agent-harness`);
  const lost = new Set(host.lostPresets ?? []);
  let denylist: Denylist = Denylist.parse(Object.fromEntries(DENYLIST_SECTIONS.map((section) => [section, presets[section].filter((entry) => !lost.has(entry.id))])));
  /** An accepted receipt, naming the head: past the change and its notice when there was one. */
  const accepted = (result: Record<string, unknown>, changed: boolean): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence: host.head(), changed }, result } });
  /** Takes `next` as the denylist, and says the sections that changed with `denylist.updated`; answers whether any did. */
  const changeTo = (next: Record<DenylistSection, readonly DenylistEntry[]>): boolean => {
    const sections = DENYLIST_SECTIONS.filter((section) => JSON.stringify(next[section]) !== JSON.stringify(denylist[section]));
    denylist = Denylist.parse(next);
    if (sections.length > 0) host.notice("denylist.updated", { sections });
    return sections.length > 0;
  };

  wire.answer("permissions.denylist.get", () => ({ result: { denylist } }));

  // Each section given becomes exactly its entries: an id the section holds, or one of its presets', is that entry; any other is new.
  const setSections = (params: Record<string, unknown>): FakeAnswer => {
    const refused = host.refusal("permissions.denylist.set");
    if (refused) return refused;
    const given = params["sections"] as DenylistInput;
    const next: Record<DenylistSection, DenylistEntry[]> = { ...denylist };
    for (const section of DENYLIST_SECTIONS) {
      const entries = given[section];
      if (entries === undefined) continue;
      const ids = entries.flatMap((entry) => entry.id ?? []);
      const twice = ids.find((id, index) => ids.indexOf(id) !== index);
      if (twice !== undefined) {
        const message = `Two entries of ${section} are under the id ${twice}.`;
        return { error: invalidParams([{ code: "custom", path: ["sections", section], message }], "The denylist cannot take these sections.") };
      }
      const presetIds = new Set(presets[section].map((entry) => entry.id));
      next[section] = entries.map((entry) => {
        const id = entry.id ?? uuidv4();
        return { id, pattern: entry.pattern, note: entry.note ?? "", preset: presetIds.has(id), enabled: entry.enabled ?? true };
      });
    }
    const changed = changeTo(next);
    return accepted({ denylist }, changed);
  };
  // The writes a test holds (`holdDenylistWrites`), each applied at the release; undefined while none are held.
  let heldWrites: (() => void)[] | undefined;
  wire.answer("permissions.denylist.set", (params) => {
    const waiting = heldWrites;
    if (waiting === undefined) return setSections(params);
    return new Promise<FakeAnswer>((resolve) => waiting.push(() => resolve(setSections(params))));
  });
  const holdDenylistWrites = () => {
    heldWrites ??= [];
    return () => {
      const waiting = heldWrites ?? [];
      heldWrites = undefined;
      for (const release of waiting) release();
    };
  };

  // Every preset a section named no longer holds, by id, at its end; an edited or disabled one stays as it is.
  wire.answer("permissions.denylist.restorePresets", (params) => {
    const refused = host.refusal("permissions.denylist.restorePresets");
    if (refused) return refused;
    const named = params["sections"] as readonly DenylistSection[] | undefined;
    const restored = DENYLIST_SECTIONS.filter((section) => named === undefined || named.includes(section)).flatMap((section) =>
      presets[section].filter((entry) => !denylist[section].some((held) => held.id === entry.id)).map((entry) => ({ section, entry })),
    );
    const next: Record<DenylistSection, DenylistEntry[]> = { ...denylist };
    for (const { section, entry } of restored) next[section] = [...next[section], entry];
    const changed = changeTo(next);
    return accepted({ restored, denylist }, changed);
  });

  wire.answer("permissions.denylist.test", (params) => {
    const call = denylistTestCall(params["kind"] as DenylistTestKind, String(params["value"]));
    return { result: { matches: matchDenylist(denylist, call, { home: SCRIPTED_HOME, cwd: SCRIPTED_HOME }), unresolvable: [] } };
  });

  // The runs, newest first, each decided at start or as `decideReviewRun` decides it, listed while its decision is past the watermark.
  let runs = (host.review ?? []).map((run, i) => ({ decidedAt: host.next(), ranAt: clock.now().toISOString(), run, i }));
  const listed = ({ ranAt, run, i }: (typeof runs)[number]): ReviewRun =>
    ReviewRun.parse({
      sessionId: host.sessionId(),
      runId: `0199a900-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      ranAt,
      actor: { kind: "routine", name: "nightly" },
      attended: false,
      mode: { requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null },
      containment: { requested: null, effective: "workspace", mechanism: "bubblewrap", reason: null },
      counts: { toolCalls: 0, autoApproved: 0, denied: 0, answeredByPerson: 0, expired: 0 },
      denials: [],
      ...run,
    });
  let watermark = 0;
  wire.answer("permissions.review.list", () => ({
    result: { watermark, head: host.head(), runs: runs.filter(({ decidedAt }) => decidedAt > watermark).map(listed) },
  }));
  wire.answer("permissions.review.seen", (params) => {
    const refused = host.refusal("permissions.review.seen");
    if (refused) return refused;
    const through = (params["through"] as number | undefined) ?? host.head();
    if (through > host.head()) {
      const message = `The log's head is ${host.head()}: a position past it cannot have been seen.`;
      return { error: invalidParams([{ code: "custom", path: ["through"], message }], message) };
    }
    if (through <= watermark) return accepted({ watermark }, false);
    watermark = through;
    host.notice("review.updated", {});
    return accepted({ watermark }, true);
  });

  return {
    denylist: () => denylist,
    reviewWatermark: () => watermark,
    holdDenylistWrites,
    setDenylist: (sections) => void changeTo({ ...denylist, ...sections }),
    decideReviewRun: (run = {}) => {
      runs = [{ decidedAt: host.next(), ranAt: clock.now().toISOString(), run, i: runs.length }, ...runs];
      host.notice("review.updated", {});
    },
    seeReview: () => {
      watermark = host.head();
      host.notice("review.updated", {});
    },
    counts: () => Object.fromEntries(DENYLIST_SECTIONS.map((section) => [section, denylist[section].length])) as Record<DenylistSection, number>,
  };
};

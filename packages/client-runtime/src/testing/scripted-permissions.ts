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
 * forward and never back.
 */

export interface ScriptedPermissionsHandle {
  /** The denylist as the environment holds it now. */
  denylist(): Denylist;
  /** The position the Unattended review has been seen through: 0 until it has been. */
  reviewWatermark(): number;
  /** Holds every `permissions.denylist.set` unanswered and unapplied until the function it returns is called, each then applied and answered in the order sent. */
  holdDenylistWrites(): () => void;
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
}

/** The commands this module answers itself, so a receipt the script names is its refusal rather than a generic answer. */
export const PERMISSION_COMMANDS: readonly string[] = ["permissions.denylist.set", "permissions.denylist.restorePresets", "permissions.review.seen"];

export const scriptedPermissions = (host: PermissionsHost): ScriptedPermissionsHandle & { readonly counts: () => Readonly<Record<DenylistSection, number>> } => {
  const { clock, wire } = host;
  const presets = denylistPresets(`${SCRIPTED_HOME}/.agent-harness`);
  const lost = new Set(host.lostPresets ?? []);
  let denylist: Denylist = Denylist.parse(Object.fromEntries(DENYLIST_SECTIONS.map((section) => [section, presets[section].filter((entry) => !lost.has(entry.id))])));
  const accepted = (result: Record<string, unknown>, changed = true): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence: changed ? host.next() : host.head(), changed }, result } });

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
    const changed = JSON.stringify(next) !== JSON.stringify(denylist);
    denylist = Denylist.parse(next);
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
    denylist = Denylist.parse(next);
    return accepted({ restored, denylist }, restored.length > 0);
  });

  wire.answer("permissions.denylist.test", (params) => {
    const call = denylistTestCall(params["kind"] as DenylistTestKind, String(params["value"]));
    return { result: { matches: matchDenylist(denylist, call, { home: SCRIPTED_HOME, cwd: SCRIPTED_HOME }), unresolvable: [] } };
  });

  // The runs, each decided at start, listed while their decision is past the watermark.
  const runs = (host.review ?? []).map((run, i) => ({ decidedAt: host.next(), ranAt: clock.now().toISOString(), run, i }));
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
    return accepted({ watermark });
  });

  return {
    denylist: () => denylist,
    reviewWatermark: () => watermark,
    holdDenylistWrites,
    counts: () => Object.fromEntries(DENYLIST_SECTIONS.map((section) => [section, denylist[section].length])) as Record<DenylistSection, number>,
  };
};

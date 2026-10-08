import { z } from "zod";
import { setOf } from "./primitives.js";

/**
 * The denylist (permissions spec, "The denylist"; ADR 0006, ADR 0014): one
 * environment-owned list of browser domains, paths, command patterns and
 * hosts that no mode, rule or classifier ever approves without a person,
 * bypass included, and that never blocks a person's own explicit allow. Its
 * grammar, its presets and its matcher are here, pure, so a client previews
 * a match exactly as the environment's tool gate rules it
 * (`permissions.denylist.test` answers with the same function). The file
 * system is the caller's: the matcher follows symbolic links only through
 * the resolver it is handed. The methods are in `methods/permissions.ts`;
 * a change is `denylist.changed` on the access stream.
 */

/** The four sections, in the order a match names them. */
export const DENYLIST_SECTIONS = ["browserDomains", "paths", "commandPatterns", "hosts"] as const;
export const DenylistSection = z.enum(DENYLIST_SECTIONS).meta({
  description:
    "A section of the denylist: browserDomains (where a browser verb may not go unasked), paths (files and directories), commandPatterns (shell command lines), or hosts (what a command, a fetch, a search or one of the harness's own tools may not reach unasked).",
});
export type DenylistSection = z.infer<typeof DenylistSection>;

/** One DNS label: letters, digits, `-` and `_`, never starting or ending with `-`. */
const LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";

/** One group of an IPv6 literal. */
const H16 = "[0-9A-Fa-f]{1,4}";
/** A dotted IPv4 address, as the last 32 bits of an IPv6 literal may be written. */
const V4 = "(?:\\d{1,3}\\.){3}\\d{1,3}";

/**
 * An IPv6 literal as RFC 4291 writes it: eight groups, or fewer around one
 * `::`, the last two groups optionally a dotted IPv4 address, on either side
 * of the `::` (RFC 3986's grammar). `::::`, nine groups, and a `:` alone
 * before a dotted tail are refused.
 */
const IPV6 = [
  `(?:${H16}:){7}${H16}`,
  `(?:${H16}:){6}${V4}`,
  `(?:${H16}:){1,7}:`,
  `(?:${H16}:){1,6}:${H16}`,
  `(?:${H16}:){1,5}(?::${H16}){1,2}`,
  `(?:${H16}:){1,4}(?::${H16}){1,3}`,
  `(?:${H16}:){1,3}(?::${H16}){1,4}`,
  `(?:${H16}:){1,2}(?::${H16}){1,5}`,
  `${H16}:(?::${H16}){1,6}`,
  `:(?:(?::${H16}){1,7}|:)`,
  `::(?:${H16}:){0,5}${V4}`,
  // One to five groups before the `::`, and up to five less that many after it, then the dotted tail.
  ...[1, 2, 3, 4, 5].map((before) => `(?:${H16}:){${before - 1}}${H16}::(?:${H16}:){0,${5 - before}}${V4}`),
].join("|");

/** One to `max.length` digits, bounded by `max`, in decimal or octal. Kept as a regex so the exported grammar refuses unusable numeric entries too. */
const boundedDigits = (max: string, radix: 8 | 10): string => {
  const alternatives = [`[0-${radix - 1}]{1,${max.length - 1}}`, max];
  for (let index = 0; index < max.length; index++) {
    const digit = Number(max[index]);
    if (digit === 0) continue;
    const lower = digit === 1 ? "0" : `[0-${digit - 1}]`;
    alternatives.push(`${max.slice(0, index)}${lower}[0-${radix - 1}]{${max.length - index - 1}}`);
  }
  return `(?:${alternatives.join("|")})`;
};

/** All-digit IPv4 spellings: one to four decimal or octal parts, the last filling the bytes left (as `ipv4Of` reads them). */
const numericIpv4Part = (bytes: number): string => {
  const max = 256 ** bytes - 1;
  return `(?:(?!0[0-9])${boundedDigits(String(max), 10)}|0+${boundedDigits(max.toString(8), 8)})`;
};
const NUMERIC_IPV4 = [1, 2, 3, 4].map((parts) => `${numericIpv4Part(1)}\\.`.repeat(parts - 1) + numericIpv4Part(5 - parts)).join("|");
const NUMERIC_HOST = new RegExp(`^(?!(?:\\*\\.)?[0-9.]+$)|^(?:\\*\\.)?(?:${NUMERIC_IPV4})$`);

/**
 * A domain or host pattern: a host name, an IPv4 address or an IPv6 literal,
 * with an optional leading wildcard label (`*.paypal.com`: the domain and
 * every subdomain). No scheme, port, path or other wildcard. The browser's
 * host lists (`browser.devSites`, `browser.internalHosts`) take it too.
 */
export const HostPattern = z
  .string()
  .regex(new RegExp(`^(?:(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*|${IPV6})$`))
  .meta({ description: "A host name, IPv4 address or IPv6 literal, with an optional leading wildcard label (*.example.com): no scheme, port or path." });

/** New denylist input refuses unusable numeric entries; stored entries and historical events keep their original grammar. */
const HostPatternInput = HostPattern
  .regex(NUMERIC_HOST, { error: (issue) => `Host entry ${String(issue.input)} is not a valid IPv4 address.` })
  .meta({ description: "A host name, IPv4 address or IPv6 literal, with an optional leading wildcard label (*.example.com): no scheme, port or path. All-digit names must be valid IPv4 spellings." });

/**
 * A path pattern: absolute, or `~`-relative (the home directory of the
 * environment's user), with glob segments: `*` and `?` within a segment, and
 * `**` as a whole segment for any number of them. `~user` is refused.
 */
const PathPattern = z
  .string()
  .regex(/^(?:~|~[\\/][^\0]*|\/(?![\\/])[^\0]*|[A-Za-z]:[\\/][^\0]*)$/)
  .meta({ description: "A POSIX absolute, drive-letter absolute or ~-relative path; Windows accepts either separator and compares without regard to case. UNC, device and drive-relative patterns are refused. Glob segments: * and ? within a segment, ** for any number of segments." });

/** A command pattern: tokens separated by white space, a bare `*` any run of tokens, a `*` inside a token anything within it. */
const CommandPattern = z
  .string()
  .regex(/\S/)
  .meta({ description: "Tokens separated by white space: a bare * matches any run of tokens including none, a * inside a token anything within that token." });

const EntryId = z.string().min(1).max(200).meta({ description: "The entry's id, unique in its section: a preset's is the same on every environment." });
const EntryNote = z.string().max(500).meta({ description: "Why the entry is there, for people; empty for none." });

const entryShape = <P extends z.ZodString>(pattern: P) => ({
  id: EntryId,
  pattern,
  note: EntryNote,
  preset: z.boolean().meta({ description: "Whether it came from the presets (seeded on first start, or restored); an edited preset keeps it." }),
  enabled: z.boolean().meta({ description: "Whether it matches: a disabled entry never does." }),
});

/** An entry of any section, as a match or a change names it. */
export const DenylistEntry = z
  .object(entryShape(z.string().min(1).meta({ description: "The pattern, in its section's grammar." })))
  .meta({ description: "One entry of the denylist: its id, pattern, note, whether it is a preset, and whether it is enabled." });
export type DenylistEntry = z.infer<typeof DenylistEntry>;

/** The whole denylist, each section's entries in its own grammar, in the order they were given. */
export const Denylist = z
  .object({
    browserDomains: z.array(z.object(entryShape(HostPattern))).meta({ description: "Where a browser verb may not go unasked, by domain." }),
    paths: z.array(z.object(entryShape(PathPattern))).meta({ description: "Files and directories, and everything under a directory." }),
    commandPatterns: z.array(z.object(entryShape(CommandPattern))).meta({ description: "Shell command lines." }),
    hosts: z.array(z.object(entryShape(HostPattern))).meta({ description: "Hosts a command, a fetch, a search or one of the harness's own tools may not reach unasked." }),
  })
  .meta({ description: "The environment's denylist: its four sections, each an ordered list of entries in the section's grammar." });
export type Denylist = z.infer<typeof Denylist>;

const inputShape = <P extends z.ZodString>(pattern: P) => ({
  id: EntryId.optional().meta({
    description:
      "The entry's id, read within its section: the id of an entry the section holds keeps or edits that entry; the id of one of the section's presets puts it back or edits it; any other names a new entry. Minted when absent.",
  }),
  pattern,
  note: EntryNote.optional().meta({ description: "Why the entry is there; empty when absent." }),
  enabled: z.boolean().optional().meta({ description: "Whether it matches; true when absent." }),
});

/**
 * The sections `permissions.denylist.set` replaces, at least one, each the
 * entries it is to hold, in order. An entry is read by its id within its
 * section: an id the section holds is that entry, kept or edited; the id of
 * one of the section's presets is that preset, put back or edited; any
 * other id, one another section holds among them, is a new entry under it,
 * and an entry with none is new under a minted one. `preset` is the
 * environment's to say, from the id, and ignored when sent. At least one
 * section: the refinement is zod's half, the `anyOf` the same rule in the
 * export.
 */
export const DenylistInput = z
  .object({
    browserDomains: z.array(z.object(inputShape(HostPatternInput))),
    paths: z.array(z.object(inputShape(PathPattern))),
    commandPatterns: z.array(z.object(inputShape(CommandPattern))),
    hosts: z.array(z.object(inputShape(HostPatternInput))),
  })
  .partial()
  .refine((sections) => DENYLIST_SECTIONS.some((section) => sections[section] !== undefined), {
    message: "Name at least one section: browserDomains, paths, commandPatterns or hosts.",
  })
  .meta({
    description: "The sections of the denylist to replace, at least one, each with the entries given, in their order: one section, several, or all four.",
    // Each branch names its property too, as a strict validator (Ajv's `strictRequired`) asks of `required`.
    anyOf: DENYLIST_SECTIONS.map((section) => ({ required: [section], properties: { [section]: true } })),
  });
export type DenylistInput = z.infer<typeof DenylistInput>;

/** An entry that matched a call: its section, the entry, and the value it matched (a path, a command line, an address) as the call gave it. */
export const DenylistMatch = z
  .object({
    section: DenylistSection,
    entry: DenylistEntry,
    matched: z.string().meta({ description: "What the call gave that matched it: a path, a command line, an address." }),
  })
  .meta({ description: "One denylist entry a call matched: the section, the entry, and what matched it." });
export type DenylistMatch = z.infer<typeof DenylistMatch>;

/** What `permissions.denylist.test` takes a value as. */
export const DENYLIST_TEST_KINDS = ["browserDomain", "path", "command", "host"] as const;
export const DenylistTestKind = z.enum(DENYLIST_TEST_KINDS).meta({
  description:
    "What a tested value is: browserDomain (an address a browser verb opens), path (a file or directory), command (a shell command line), or host (a URL or host a call reaches).",
});
export type DenylistTestKind = z.infer<typeof DenylistTestKind>;

/** One edited entry, before and after. */
const EditedEntry = z.object({ before: DenylistEntry, after: DenylistEntry }).meta({ description: "An entry kept under its id with its pattern, note or enabled flag changed." });

/**
 * `denylist.changed` on the access stream (the spec's `access.denylist.changed`):
 * one per section a change touched, whoever made it (a person through
 * `permissions.denylist.set` or `restorePresets`, the environment seeding
 * the presets on first start), with what it added, removed and edited, and
 * the section after it, which is what the environment's denylist is read
 * from. The actor is the envelope's.
 */
export const DenylistChangedPayload = z
  .object({
    section: DenylistSection,
    added: z.array(DenylistEntry).meta({ description: "Entries the section did not hold before." }),
    removed: z.array(DenylistEntry).meta({ description: "Entries the section no longer holds." }),
    edited: z.array(EditedEntry).meta({ description: "Entries kept under their ids with something changed." }),
    entries: z.array(DenylistEntry).meta({ description: "The section after the change, in order." }),
  })
  .meta({ description: "denylist.changed: a section of the denylist changed; the entries added, removed and edited, and the section after." });
export type DenylistChangedPayload = z.infer<typeof DenylistChangedPayload>;

/**
 * The `denylist.updated` notice on the environment's own stream (#811): the
 * denylist changed through `permissions.denylist.set` or `restorePresets`,
 * appended in that command's transaction after its `denylist.changed`
 * events, naming the sections they changed. The access log, where the
 * change itself is, is a stream no client follows; this says to every
 * connected client that its cached `permissions.denylist.get` and
 * `permissions.settings.get` (whose section counts it changes) are stale.
 */
export const DenylistUpdatedPayload = z
  .object({
    sections: setOf(DenylistSection)
      .min(1)
      .meta({ description: "The sections that changed, each once, in section order." }),
  })
  .meta({ description: "denylist.updated: the denylist changed and has committed; the sections that did, which a client reads again." });
export type DenylistUpdatedPayload = z.infer<typeof DenylistUpdatedPayload>;

// ---------------------------------------------------------------------------
// The presets
// ---------------------------------------------------------------------------

/** The id of the preset that holds the environment's own data directory, whose path is each environment's. */
export const DATA_DIRECTORY_PRESET_ID = "preset:data-directory";

type PresetSeed = readonly [pattern: string, note: string];

const PASSWORDS = "A password manager: one wrong click costs every other password.";
const MONEY = "Payments and money movement.";
const BANK = "A large bank, by name: a start, not a fence.";
const RECOVERY = "Account recovery and security settings.";

/**
 * The browser preset list, in order: password managers, payments and money
 * movement, the large banks by name, account recovery.
 */
const BROWSER_DOMAIN_PRESETS: readonly PresetSeed[] = [
  ["*.1password.com", PASSWORDS],
  ["*.bitwarden.com", PASSWORDS],
  ["*.lastpass.com", PASSWORDS],
  ["*.dashlane.com", PASSWORDS],
  ["passwords.google.com", PASSWORDS],
  ["*.paypal.com", MONEY],
  ["*.stripe.com", MONEY],
  ["*.wise.com", MONEY],
  ["*.venmo.com", MONEY],
  ["*.coinbase.com", MONEY],
  ["*.binance.com", MONEY],
  ["*.kraken.com", MONEY],
  ["pay.google.com", MONEY],
  ["wallet.google.com", MONEY],
  ["*.chase.com", BANK],
  ["*.bankofamerica.com", BANK],
  ["*.wellsfargo.com", BANK],
  ["*.citi.com", BANK],
  ["*.capitalone.com", BANK],
  ["*.americanexpress.com", BANK],
  ["*.hsbc.com", BANK],
  ["*.barclays.co.uk", BANK],
  ["*.bdo.com.ph", BANK],
  ["*.bpi.com.ph", BANK],
  ["*.unionbankph.com", BANK],
  ["*.gcash.com", BANK],
  ["myaccount.google.com", RECOVERY],
  ["account.microsoft.com", RECOVERY],
  ["appleid.apple.com", RECOVERY],
];

/**
 * The spec's paths: the credential directories and files, then the
 * configuration directories of the 1Password CLI (`~/.op` of version 1,
 * `~/.config/op` of version 2, and `~/.config/.op`, which it also reads),
 * the Bitwarden CLI (Linux, then macOS) and the Doppler CLI. The data
 * directory is the last, added per environment.
 */
const PATH_PRESETS: readonly PresetSeed[] = [
  ["~/.ssh", "SSH keys and known hosts."],
  ["~/.gnupg", "GnuPG keys."],
  ["~/.aws", "AWS credentials and configuration."],
  ["~/.config/gcloud", "Google Cloud credentials."],
  ["~/.kube", "Kubernetes credentials."],
  ["~/.docker/config.json", "Docker registry credentials."],
  ["~/.netrc", "Machine logins for curl, git and ftp."],
  ["~/.vault-token", "A HashiCorp Vault token."],
  ["~/.op", "The 1Password CLI's configuration (version 1)."],
  ["~/.config/.op", "The 1Password CLI's configuration."],
  ["~/.config/op", "The 1Password CLI's configuration (version 2)."],
  ["~/.config/Bitwarden CLI", "The Bitwarden CLI's data (Linux)."],
  ["~/Library/Application Support/Bitwarden CLI", "The Bitwarden CLI's data (macOS)."],
  ["~/.doppler", "The Doppler CLI's configuration and tokens."],
];

const PRIVILEGE = "Runs a command as another user, root among them.";
const DISK = "Writes a file system or a device directly.";
const POWER = "Stops or restarts the machine.";
const PIPE = "Runs a script fetched from the network without reading it.";
const FORCE = "Overwrites a remote branch's history.";

/** The spec's command patterns, in its order. */
const COMMAND_PRESETS: readonly PresetSeed[] = [
  ["sudo *", PRIVILEGE],
  ["doas *", PRIVILEGE],
  ["su *", PRIVILEGE],
  ["mkfs* *", DISK],
  ["dd * of=/dev/* *", DISK],
  ["shutdown *", POWER],
  ["reboot *", POWER],
  ["curl * | *sh *", PIPE],
  ["curl * |*sh *", PIPE],
  ["curl * | sudo *sh *", PIPE],
  ["wget * | *sh *", PIPE],
  ["wget * |*sh *", PIPE],
  ["wget * | sudo *sh *", PIPE],
  ["git push * --force* *", FORCE],
  ["git push * -f *", FORCE],
];

const preset = ([pattern, note]: PresetSeed): DenylistEntry => ({ id: `preset:${pattern}`, pattern, note, preset: true, enabled: true });

/**
 * The presets, exactly as the spec lists them, for an environment whose
 * data directory is `dataDirectory` (absolute): every entry `preset: true`,
 * enabled, with a note, under an id the same on every environment. Hosts
 * start empty. The containment directories inside the data directory are
 * the matcher's exemption (`DenylistMatchContext.exempt`), not a change to
 * the entry.
 */
export const denylistPresets = (dataDirectory: string): Denylist => ({
  browserDomains: BROWSER_DOMAIN_PRESETS.map(preset),
  paths: [
    ...PATH_PRESETS.map(preset),
    {
      id: DATA_DIRECTORY_PRESET_ID,
      pattern: dataDirectory,
      note: "The harness's own data directory: its event log, keys and accounts.",
      preset: true,
      enabled: true,
    },
  ],
  commandPatterns: COMMAND_PRESETS.map(preset),
  hosts: [],
});

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/**
 * What a call touches, normalised from its tool's input by whoever asks
 * (the tool gate from the adapter's description, a client previewing).
 * Every list may be absent.
 */
export interface DenylistCall {
  /** Addresses a browser verb opens: matched against the browser domains and the hosts, a `file:` address against the paths. */
  readonly browserDomains?: readonly string[];
  /** Paths read or written: absolute, `~`-relative, or relative to the working directory. */
  readonly paths?: readonly string[];
  /** Whole shell command lines: matched against the command patterns, their path-like tokens against the paths, their URLs and hosts against the hosts. */
  readonly commands?: readonly string[];
  /** URLs, or hosts with or without a port, a call reaches (a fetch, a search, a tool server): matched against the hosts, a `file:` URL against the paths. */
  readonly hosts?: readonly string[];
}

/** Where the matcher reads paths from. */
export interface DenylistMatchContext {
  /** The home directory `~` stands for: absolute. */
  readonly home: string;
  /** The directory a relative path is read against: absolute. */
  readonly cwd: string;
  /**
   * An absolute path as the file system resolves it, every symbolic link
   * followed where it stands before any `..` after it; absent, paths are
   * matched as written only. Both the path as written and as resolved are
   * matched, and so is an entry's own literal part, so a link to a
   * denylisted directory and a denylisted link are both caught. Asked at
   * most once per path in a match.
   */
  readonly resolve?: ((path: string) => string) | undefined;
  /**
   * Directories no broader entry matches in: a path at or under one is not
   * matched by an entry that covers the directory itself (the data
   * directory's entry over the containment directories the environment's
   * runs write in), while an entry inside the directory still matches, and
   * so does a link there that leads out.
   */
  readonly exempt?: readonly string[] | undefined;
  /** The name of the user whose home `home` is: `~name/` reads as the home directory too. */
  readonly user?: string | undefined;
  /** The environment's path flavour, independent of the client or test host; preset: POSIX. */
  readonly pathStyle?: "posix" | "win32";
  /** Whether paths compare without regard to case (always true with Windows paths). */
  readonly caseInsensitive?: boolean | undefined;
}

/** `path` absolute: `~` (and `~user` for the context's own user) expanded, a relative path read against `cwd`. Not normalised. */
const absolute = (path: string, context: Pick<DenylistMatchContext, "home" | "cwd" | "user" | "pathStyle">): string => {
  const windows = context.pathStyle === "win32";
  if (windows) path = path.replace(/\\/g, "/");
  const home = windows ? context.home.replace(/\\/g, "/") : context.home;
  const cwd = windows ? context.cwd.replace(/\\/g, "/") : context.cwd;
  // Local file URLs carry a slash before their drive letter.
  if (windows && /^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  const own = context.user !== undefined && context.user !== "" ? `~${context.user}` : null;
  for (const tilde of own === null ? ["~"] : ["~", own]) {
    if (path === tilde) return home;
    if (path.startsWith(`${tilde}/`)) return `${home}/${path.slice(tilde.length + 1)}`;
  }
  if (windows && /^[A-Za-z]:\//.test(path)) return path;
  if (path.startsWith("/")) {
    // A rooted Windows path uses the working directory's drive. UNC remains distinct.
    const drive = windows && !path.startsWith("//") ? /^[A-Za-z]:/.exec(cwd)?.[0] : undefined;
    return drive === undefined ? path : `${drive}${path}`;
  }
  return `${cwd}/${path}`;
};

/** The segments of an absolute path with `..` applied as text. */
const lexical = (path: string): string[] => {
  const out: string[] = [];
  const rootLength = /^[A-Za-z]:\//.test(path) ? 1 : 0;
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > rootLength) out.pop();
    } else out.push(part);
  }
  return out;
};

/** Whether a path segment holds glob syntax. */
const isGlob = (segment: string): boolean => segment.includes("*") || segment.includes("?");

/**
 * Whether `text` matches `glob`, where `*` is any run of characters and,
 * when `question` is set, `?` any one character; everything else is itself.
 * Two pointers with one backtrack point, so at worst the glob's length
 * times the text's, and never exponential whatever the pattern.
 */
const wildcard = (glob: string, text: string, question: boolean): boolean => {
  let g = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const char = glob[g];
    if (g < glob.length && char !== "*" && (char === text[t] || (question && char === "?"))) {
      g++;
      t++;
    } else if (g < glob.length && char === "*") {
      star = g++;
      resume = t;
    } else if (star !== -1) {
      g = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (glob[g] === "*") g++;
  return g === glob.length;
};

/**
 * Whether `pattern` matches all of `items`, a `star` item standing for any
 * run of items (none included) and every other pattern item matching one
 * item by `same`: a table over positions, so any number of stars stays
 * quadratic at worst.
 */
const sequenceMatches = <T>(pattern: readonly string[], items: readonly T[], star: string, same: (pattern: string, item: T) => boolean): boolean => {
  const n = items.length;
  // `next[j]`: whether the pattern from the item after this one matches `items` from `j`.
  let next = Array.from({ length: n + 1 }, (_, j) => j === n);
  for (let i = pattern.length - 1; i >= 0; i--) {
    const token = pattern[i] as string;
    const current = Array<boolean>(n + 1).fill(false);
    for (let j = n; j >= 0; j--) {
      current[j] = token === star ? (next[j] as boolean) || (j < n && (current[j + 1] as boolean)) : j < n && (next[j + 1] as boolean) && same(token, items[j] as T);
    }
    next = current;
  }
  return next[0] as boolean;
};

const segmentMatches = (segment: string, part: string): boolean => (isGlob(segment) ? wildcard(segment, part, true) : segment === part);

/** Whether an entry's segments cover a path: the path is the entry or lies under it. `**` is any number of segments. */
const coversPath = (entry: readonly string[], path: readonly string[]): boolean => sequenceMatches([...entry, "**"], path, "**", segmentMatches);

/**
 * Whether a path written as a glob (`~/.s*h/id_rsa`, which the shell
 * expands) can name the entry's path or one under it: its first segments,
 * as globs, match the entry's literal ones, a leading dot matched only by a
 * dot as the shell expands it. An entry with globs of its own is left to
 * the literal comparison.
 */
const globReaches = (glob: readonly string[], entry: readonly string[]): boolean => {
  if (entry.some(isGlob)) return false;
  for (let index = 0; index < entry.length; index++) {
    const segment = glob[index];
    if (segment === undefined) return false;
    if (segment === "**") return true;
    const part = entry[index] as string;
    // A shell's `*` and `?` do not expand to a leading dot: `~/*` is not `~/.ssh`, `~/.*` is.
    if (part.startsWith(".") && !segment.startsWith(".")) return false;
    if (!segmentMatches(segment, part)) return false;
  }
  return true;
};

const sameSegments = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((part, index) => part === b[index]);

const dedupe = (forms: string[][]): string[][] => forms.filter((form, index) => forms.findIndex((other) => sameSegments(form, other)) === index);

/** Whether the path's form lies at or under a directory. */
const within = (directory: readonly string[], path: readonly string[]): boolean =>
  directory.length <= path.length && directory.every((part, index) => part === path[index]);

/**
 * A match's reading of paths: `~` and the working directory, the resolver
 * asked once per path, case folded where the file system folds it; and each
 * entry's forms, read once.
 */
const pathReader = (context: DenylistMatchContext) => {
  const resolved = new Map<string, string>();
  const resolve = context.resolve;
  const fold = context.pathStyle === "win32" || context.caseInsensitive === true ? (form: string[]) => form.map((part) => part.toLowerCase()) : (form: string[]) => form;
  const resolveOnce = (path: string): string => {
    let known = resolved.get(path);
    if (known === undefined) {
      known = (resolve as (path: string) => string)(path);
      resolved.set(path, known);
    }
    return known;
  };
  /** The forms of a path the matcher reads: as written (`..` applied as text), and as resolved when a resolver is given. */
  const forms = (path: string): string[][] => {
    const full = absolute(path, context);
    const read = [lexical(full)];
    if (resolve !== undefined) read.push(lexical(absolute(resolveOnce(full), context)));
    return dedupe(read.map(fold));
  };
  const entries = new Map<string, string[][]>();
  /** The forms of an entry's pattern: as written, and with its literal part before the first glob segment resolved. */
  const entryForms = (pattern: string): string[][] => {
    let known = entries.get(pattern);
    if (known === undefined) {
      const segments = lexical(absolute(pattern, context));
      const read = [segments];
      if (resolve !== undefined) {
        const firstGlob = segments.findIndex(isGlob);
        const literal = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
        const rest = firstGlob === -1 ? [] : segments.slice(firstGlob);
        const prefix = context.pathStyle === "win32" && /^[A-Za-z]:$/.test(literal[0] ?? "") ? "" : "/";
        const literalPath = `${prefix}${literal.join("/")}${literal.length === 1 && prefix === "" ? "/" : ""}`;
        read.push([...lexical(absolute(resolveOnce(literalPath), context)), ...rest]);
      }
      known = dedupe(read.map(fold));
      entries.set(pattern, known);
    }
    return known;
  };
  const exempt = dedupe((context.exempt ?? []).flatMap(forms));
  /** Whether the entry matches the path, leaving out a path in an exempt directory the entry covers as a whole. */
  const matches = (pattern: string, path: PathSubject): boolean =>
    path.forms.some((form) =>
      entryForms(pattern).some((entry) => {
        if (!coversPath(entry, form) && !(path.glob && globReaches(form, entry))) return false;
        return !exempt.some((directory) => within(directory, form) && coversPath(entry, directory));
      }),
    );
  return { forms, matches };
};

// Command lines -------------------------------------------------------------

/**
 * What splits a token as white space does: a substitution's or a group's
 * bracket, a redirection, a statement's end, a background `&`; each is a
 * token of its own. The longest spelling first at a position.
 */
const OPERATORS = /(\$\(|`|\(|\)|&>>|&>|>>|>&|>\||>|<<<|<<|<|;|&&|\|\||&)/;
const OPERATOR_TOKEN = new RegExp(`^${OPERATORS.source}$`);

/** A token with its quotes and escapes taken out, wherever they stand, and the brackets or punctuation that wrap it off. */
const unwrap = (token: string): string => token.replace(/["'\\]/g, "").replace(/^[{[]+/, "").replace(/[}\],]+$/, "");

// Shell expansions ------------------------------------------------------------

/** The most words one value's brace expansion is read as, word by word, and the longest value with a group it is read in. */
const BRACE_WORDS = 1_024;
const BRACE_TEXT = 1_024;

/** A brace sequence the shell expands: integers (`{1..3}`, `{01..10}`) or letters (`{a..e}`), with an optional step. */
const SEQUENCE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/;

/** A sequence's words, zero-padded when either end is written with a leading zero; null past BRACE_WORDS. */
const sequenceWords = (sequence: RegExpExecArray): string[] | null => {
  const [, fromNumber, toNumber, fromLetter, toLetter, stepText] = sequence;
  const step = Math.abs(Number(stepText ?? "1")) || 1;
  const numbers = fromNumber !== undefined && toNumber !== undefined;
  const from = numbers ? Number(fromNumber) : (fromLetter as string).charCodeAt(0);
  const to = numbers ? Number(toNumber) : (toLetter as string).charCodeAt(0);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || Math.abs(to - from) / step >= BRACE_WORDS) return null;
  const width = numbers && [fromNumber, toNumber].some((end) => /^-?0\d/.test(end)) ? Math.max(fromNumber.length, toNumber.length) : 0;
  const written = (value: number): string =>
    !numbers ? String.fromCharCode(value) : `${value < 0 ? "-" : ""}${String(Math.abs(value)).padStart(value < 0 ? width - 1 : width, "0")}`;
  const words: string[] = [];
  const direction = from <= to ? step : -step;
  for (let value = from; direction > 0 ? value <= to : value >= to; value += direction) words.push(written(value));
  return words;
};

/**
 * The first brace group of `text` the shell expands (the leftmost `{` whose
 * `}` holds a comma directly inside it, or a sequence) and its words: a
 * comma list's alternatives as written, nested groups left in them for the
 * next round, or a sequence's words (null past BRACE_WORDS). Null when there
 * is no group. One pass over the text. Read as a shell word (`shell`), a
 * brace or comma inside quotes or after a backslash is the character
 * itself, and `${` opens a parameter, not a group, as the shell reads them.
 */
const firstBraceGroup = (text: string, shell: boolean): { readonly start: number; readonly end: number; readonly words: string[] | null } | null => {
  const open: { readonly start: number; readonly commas: number[]; readonly parameter: boolean }[] = [];
  let first: { readonly start: number; readonly end: number; readonly words: string[] | null } | null = null;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (shell) {
      if (quote === "'") {
        if (char === "'") quote = null;
        continue;
      }
      if (char === "\\") {
        index++;
        continue;
      }
      if (quote === '"') {
        if (char === '"') quote = null;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
    }
    if (char === "{") open.push({ start: index, commas: [], parameter: shell && text[index - 1] === "$" });
    else if (char === "," && open.length > 0) open[open.length - 1]?.commas.push(index);
    else if (char === "}" && open.length > 0) {
      const { start, commas, parameter } = open.pop() as { readonly start: number; readonly commas: number[]; readonly parameter: boolean };
      if (parameter || (first !== null && first.start < start)) continue;
      if (commas.length > 0) {
        const bounds = [start, ...commas, index];
        first = { start, end: index, words: bounds.slice(1).map((bound, at) => text.slice((bounds[at] as number) + 1, bound)) };
        continue;
      }
      const inside = text.slice(start + 1, index);
      const sequence = inside.length <= 48 ? SEQUENCE.exec(inside) : null;
      if (sequence !== null) first = { start, end: index, words: sequenceWords(sequence) };
    }
  }
  return first;
};

/**
 * The words the shell's brace expansion makes of `text`: a comma list
 * (`~/{.ssh,.aws}`), a sequence of integers or letters (`.s{r..t}h`), nested
 * (`.n{e,{x,y}}trc`) and several in a row, an empty word dropped as the
 * shell drops it. `text` alone when it has no group; null when it makes
 * more than BRACE_WORDS words, takes more than two rounds a word to read,
 * or is longer than BRACE_TEXT with a group in it, so a value's cost stays
 * bounded. A shell word's quoted or escaped braces are left as they are,
 * as the shell leaves them (`shell`, `firstBraceGroup`); a glob tool's
 * pattern has no quoting, so its are read as groups.
 */
const braceWords = (text: string, shell: boolean): string[] | null => {
  if (!text.includes("{")) return [text];
  if (text.length > BRACE_TEXT) return firstBraceGroup(text, shell) === null ? [text] : null;
  const done: string[] = [];
  const pending = [text];
  for (let rounds = 0; pending.length > 0; rounds++) {
    if (rounds > 2 * BRACE_WORDS) return null;
    const word = pending.pop() as string;
    const group = firstBraceGroup(word, shell);
    if (group === null) {
      if (word !== "") done.push(word);
      continue;
    }
    if (group.words === null) return null;
    const before = word.slice(0, group.start);
    const after = word.slice(group.end + 1);
    for (let at = group.words.length - 1; at >= 0; at--) pending.push(`${before}${group.words[at] as string}${after}`);
    if (done.length + pending.length > BRACE_WORDS) return null;
  }
  return done;
};

/** A path whose braces make too many words to read one by one, read as everything under the directory before its first brace (`~/.{a..z}{a..z}{a..z}` as `~/**`). */
const pastBraces = (path: string): string => `${path.slice(0, path.lastIndexOf("/", path.indexOf("{")) + 1)}**`;

/** A bracket expression the shell reads as one character of a set (`[h]`, `[a-z]`, `[!x]`), within one path segment. */
const BRACKET = /\[[!^]?\]?[^\]/]*\]/g;

/**
 * The paths a path value names once the shell's brace and bracket
 * expansions are read: when `braces` (a call's own path, or a command
 * token too long to expand, whose words were not read), each brace word
 * (past the limit, everything under the directory before the braces, beside
 * the value as written); and each path also with its bracket expressions as
 * `?`, any one character, which reaches at least what the set does and, as
 * the shell's own, never a leading dot. A command line's words come already
 * expanded (`subjectsOf`), their quoted braces left as the shell leaves them.
 */
const expandedPaths = (value: string, braces: boolean): string[] => {
  const words = braces ? (braceWords(value, false) ?? [pastBraces(value), value]) : [value];
  return [...new Set(words.flatMap((word) => [word, word.replace(BRACKET, "?")]))];
};

/**
 * A command line's tokens: split on white space, then at every operator
 * (`$(`, a backtick, `(`, `)`, a redirection, `;`, `&&`, `||`, `&`), each
 * kept as a token, and a `|` inside a token starting a token (`x|sh` is `x`
 * and `|sh`), so a pattern meets the spellings a shell reads alike:
 * `x>~/.netrc`, `cat<key`, `x=$(sudo ls)`. A quote does not hide an
 * operator: the reading is of tokens, not of the shell's grammar.
 */
const tokensOf = (line: string, windows = false): string[] =>
  (windows ? (line.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []) : line.trim().split(/\s+/))
    .flatMap((token) => token.split(OPERATORS))
    .flatMap((token) => (OPERATOR_TOKEN.test(token) ? [token] : token.split(/(?=\|)/)))
    .filter((token) => token !== "");

/** Whether a pattern token matches a line token, as written or unwrapped: a `*` inside it matches anything within the token. */
const tokenMatches = (pattern: string, token: string): boolean => wildcard(pattern, token, false) || wildcard(pattern, unwrap(token), false);

/** Whether a command pattern matches a command line's tokens anywhere in it: a bare `*` any run of tokens, none included. */
const commandMatches = (pattern: string, tokens: readonly string[]): boolean => sequenceMatches(["*", ...pattern.trim().split(/\s+/), "*"], tokens, "*", tokenMatches);

/**
 * The tokens as the shell reads them further: each token's braces expanded
 * into its words (`{sudo,} reboot` as `sudo reboot`), and each pipe written
 * against the word after it split off it (`|sudo` as `|` and `sudo`); the
 * same array when the line has neither. A command pattern is matched
 * against both readings, so `x|sudo y` meets `sudo *` as `x | sudo y` does,
 * and `curl x |sh` still meets `curl * |*sh *`. `unbounded` when a token's
 * braces make more words than are read (`braceWords`): its words could be
 * anything, so the line is taken to meet every command pattern, the strict
 * reading, as a path past the limit is read as everything under its
 * directory.
 */
const shellRead = (tokens: readonly string[]): { readonly read: readonly string[]; readonly unbounded: boolean } => {
  const glued = (token: string): boolean => token.length > 1 && token.startsWith("|") && token !== "||";
  if (!tokens.some((token) => token.includes("{") || glued(token))) return { read: tokens, unbounded: false };
  let unbounded = false;
  const words = tokens.flatMap((token) => {
    const expanded = braceWords(token, true);
    if (expanded === null) unbounded = true;
    return expanded ?? [token];
  });
  return { read: words.flatMap((token) => (glued(token) ? ["|", token.slice(1)] : [token])), unbounded };
};

/**
 * A URL: a scheme and `//`, any `file:` address, which names a local path
 * with one slash as well as with three, or a special scheme with fewer
 * slashes, whose authority a browser and curl read all the same
 * (`http:/2852039166`).
 */
const URL_PREFIX = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|file:|(?:https?|wss?|ftp):)/i;

/** `$HOME` and `${HOME}` at a token's start read as `~`. */
const home = (token: string, windows = false): string => token.replace(windows ? /^(?:\$HOME|\$\{HOME\})(?=[\\/]|$)/ : /^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~");

/** Whether a token reads as a path: absolute, `~`, a dot file or a relative path with a slash in it. */
const isPathLike = (token: string): boolean => token.startsWith("/") || token.startsWith("~") || token.startsWith(".") || token.includes("/");

/** A token that reads as a host: a name with a dot, `localhost`, a bracketed IPv6 literal, each with an optional port. */
const HOST_TOKEN = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})+|localhost|\\[[0-9A-Fa-f:.]+\\])(?::\\d+)?$`);
const SINGLE_LABEL = new RegExp(`^${LABEL}(?::\\d+)?$`);
/** A bare IPv6 literal as RFC 4291 writes it (`::1`, `2001:db8::1`): no brackets, so no port. */
const BARE_IPV6 = new RegExp(`^(?:${IPV6})$`);

/**
 * A number that reaches a host as the network reads one: `0x` hex, or a
 * decimal above the first eight bits, as `inet_aton` takes `2852039166` for
 * 169.254.169.254 (a small number, an exit code or a count, is left alone).
 */
const numericHost = (token: string): boolean => {
  const bare = token.replace(/:\d+$/, "");
  if (/^0[xX][0-9A-Fa-f]{1,8}$/.test(bare)) return true;
  return /^[1-9][0-9]{7,9}$/.test(bare) && Number(bare) >= 2 ** 24 && Number(bare) < 2 ** 32;
};

/** Full-width and ideographic spellings read as ASCII, as a browser maps a host before it resolves it. */
const asciiHost = (text: string): string => text.normalize("NFKC").replace(/[\u3002\uff0e\uff61]/g, ".");

/**
 * The host a bare token reaches, or null: a name with a dot or a number the
 * network reads as an address, with an optional port; an IPv6 literal,
 * bracketed with an optional port or bare; after a user
 * (`admin@db.internal`, where a single label is a host too); before a path
 * (`169.254.169.254/latest`), a query or a fragment (`example.com?q=1`,
 * `example.com#top`, where an address's authority ends too) or scp's
 * `:path` (`git@host.example:repo.git`, `[2001:db8::1]:backup`). The host
 * is the one after the last `@` (ssh's reading); `shellSubjects` also
 * reads the one before a `?` or `#` that comes first (curl's). An absolute,
 * `~` or dot path, an option and a URL are not hosts. The port and a
 * trailing dot are dropped.
 */
export const hostToken = (token: string): string | null => {
  const text = asciiHost(token.trim());
  if (text === "" || /^[-/~.]/.test(text) || URL_PREFIX.test(text)) return null;
  let candidate = text.split("/")[0] as string;
  const user = candidate.lastIndexOf("@");
  candidate = candidate.slice(user + 1).split(/[?#]/)[0] as string;
  // A bare IPv6 literal, before its colons are read as scp's `host:path`.
  if (BARE_IPV6.test(candidate)) return candidate;
  // scp's `:path` after a bracketed literal (`admin@[2001:db8::1]:backup`); a port is the host grammar's.
  const bracketed = /^(\[[^\]]*\]):(.*)$/.exec(candidate);
  if (bracketed !== null && !/^\d+$/.test(bracketed[2] as string)) candidate = bracketed[1] as string;
  const scp = /^([^:[\]]+):(.*)$/.exec(candidate);
  if (scp !== null && !/^\d+$/.test(scp[2] as string)) candidate = scp[1] as string;
  // A fully qualified name's trailing dot (`169.254.169.254.`, `example.com.`) reaches the same host.
  candidate = candidate.replace(/\.(?=(?::\d+)?$)/, "");
  if (candidate === "") return null;
  if (HOST_TOKEN.test(candidate) || numericHost(candidate) || (user !== -1 && SINGLE_LABEL.test(candidate))) return candidate.replace(/:\d+$/, "");
  return null;
};

/**
 * The path-like tokens, URLs and hosts of a command line, as the matcher
 * reads them against the paths and the hosts: each token's braces expanded
 * into its words (`braceWords`), each word unwrapped (quotes
 * and escapes taken out wherever they stand), `$HOME` read as `~`, a
 * redirection's target a token of its own, an option's value (`--out=x`,
 * `of=/dev/sdb`) taken on its own. A path is absolute, `~`-relative, a dot
 * file, or has a slash in it; a host is a bare token `hostToken` reads as one.
 */
export const shellSubjects = (line: string): { paths: string[]; urls: string[]; hosts: string[] } => {
  const { paths, urls, hosts } = subjectsOf(tokensOf(line));
  return { paths, urls, hosts };
};

/** `shellSubjects`, and the path-like tokens whose braces make too many words to read, with their braces kept (`unbounded`). */
const subjectsOf = (tokens: readonly string[], windows = false): { paths: string[]; urls: string[]; hosts: string[]; unbounded: string[] } => {
  const unbounded: string[] = [];
  const paths: string[] = [];
  const urls: string[] = [];
  const hosts: string[] = [];
  const read = (raw: string): void => {
    // Unwrapping takes a bracket off either end, which an IPv6 literal needs as written (`[::1]:8080`, `admin@[::1]`,
    // scp's `[2001:db8::1]:backup`): a host read with its brackets stands for the token's own reading.
    const bracketed = raw.includes("[") ? hostToken(raw.replace(/["'\\]/g, "").replace(/^[^=[]*=/, "")) : null;
    if (bracketed !== null) hosts.push(bracketed);
    // Backslashes are Windows separators, not shell escape characters.
    const whole = home(windows ? raw.replace(/["']/g, "") : unwrap(raw), windows);
    const equals = whole.indexOf("=");
    // An option's value (`--out=x`), not a query's or a fragment's `=` (`169.254.169.254?x=1`), which is the whole token's.
    const candidates = equals > 0 && !URL_PREFIX.test(whole) && !/[?#]/.test(whole.slice(0, equals)) ? [home(whole.slice(equals + 1), windows)] : [whole];
    // An absolute path with `=` in it is a path too, beside what follows the `=`.
    if (candidates[0] !== whole && (whole.startsWith("/") || whole.startsWith("~/") || (windows && /^(?:[A-Za-z]:|~)[\\/]/.test(whole)))) candidates.unshift(whole);
    for (const token of candidates) {
      if (token === "" || token.startsWith("-")) continue;
      if (URL_PREFIX.test(token) && !(windows && /^[A-Za-z]:[\\/]/.test(token))) {
        urls.push(token);
        continue;
      }
      if (isPathLike(token) || (windows && token.includes("\\"))) paths.push(token);
      if (bracketed !== null) continue;
      const host = hostToken(token);
      if (host !== null) hosts.push(host);
      // A ? or # before the user: curl reads the host before it (`169.254.169.254?x@example.com`), ssh the one after.
      const query = token.search(/[?#]/);
      const before = query > 0 && query < token.lastIndexOf("@") ? hostToken(token.slice(0, query)) : null;
      if (before !== null) hosts.push(before);
    }
  };
  for (const token of tokens) {
    if (OPERATOR_TOKEN.test(token)) continue;
    const words = braceWords(token, true);
    if (words !== null) {
      words.forEach(read);
      continue;
    }
    // Too many words to read one by one: the token as written, and as a path with its braces kept, which the path
    // reading takes as everything under the directory before them (`expandedPaths`).
    read(token);
    const kept = home(token.replace(/["'\\]/g, ""));
    if (isPathLike(kept)) unbounded.push(kept);
  }
  return { paths, urls, hosts, unbounded };
};

// Addresses -----------------------------------------------------------------

/** Schemes a browser reads with an authority, backslashes as slashes, and IPv4 in any spelling (WHATWG's special schemes). */
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file"]);

/** An IPv4 part in any spelling the network reads: decimal, `0x` hex, or octal with a leading zero. */
const ipv4Part = (part: string): number | null => {
  if (/^0[xX][0-9A-Fa-f]*$/.test(part)) return part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
  if (/^(?:0|[1-9][0-9]*)$/.test(part)) return Number(part);
  return null;
};

/**
 * A host that ends in a number read as IPv4, as a browser and `inet_aton`
 * do: one to four parts, the last filling the bytes left. Undefined when it
 * does not end in a number (a name); null when it does and is no address.
 */
const ipv4Of = (host: string): string | null | undefined => {
  const parts = host.split(".");
  if (parts.at(-1) === "") parts.pop();
  const last = parts.at(-1) ?? "";
  if (ipv4Part(last) === null && !/^[0-9]+$/.test(last)) return undefined;
  if (parts.length > 4) return null;
  const numbers = parts.map(ipv4Part);
  if (numbers.some((value) => value === null)) return null;
  const values = numbers as number[];
  const head = values.slice(0, -1);
  const tail = values.at(-1) as number;
  if (head.some((value) => value > 255) || tail >= 256 ** (5 - values.length)) return null;
  let address = tail;
  head.forEach((value, index) => (address += value * 256 ** (3 - index)));
  return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join(".");
};

/** An IPv6 literal's eight groups, an embedded IPv4 tail read as two; null when it is not one. */
export const ipv6Groups = (literal: string): number[] | null => {
  let text = literal.toLowerCase();
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail !== null) {
    const v4 = ipv4Of(tail[2] as string);
    if (typeof v4 !== "string") return null;
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    text = `${tail[1] as string}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (half: string): number[] | null => {
    if (half === "") return [];
    const groups = half.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const front = read(halves[0] as string);
  const back = halves.length === 2 ? read(halves[1] as string) : [];
  if (front === null || back === null) return null;
  if (halves.length === 1) return front.length === 8 ? front : null;
  const missing = 8 - front.length - back.length;
  return missing < 1 ? null : [...front, ...Array<number>(missing).fill(0), ...back];
};

/** Eight groups as RFC 5952 writes them: lower case, no leading zeros, the longest run of two or more zero groups as `::`. */
const ipv6Text = (groups: readonly number[]): string => {
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; ) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length++;
    if (length > bestLength) [bestStart, bestLength] = [start, length];
    start += Math.max(length, 1);
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart === -1) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
};

/** A host as the network reads it: lower case, percent-decoded, no trailing dot, IPv4 and IPv6 in one spelling each. Null when it is none. */
const canonicalHost = (host: string): string | null => {
  let text = host;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.includes(":")) {
    const groups = ipv6Groups(text);
    return groups === null ? null : ipv6Text(groups);
  }
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  // Full-width letters and digits and the ideographic full stops read as ASCII, as a browser maps a host (UTS 46).
  text = asciiHost(text).toLowerCase().replace(/\.$/, "");
  if (text === "" || /[\s/\\?#@]/.test(text) || [...text].some(isControl)) return null;
  const v4 = ipv4Of(text);
  return v4 === undefined ? text : v4;
};

/** The IPv4 address an IPv4-mapped IPv6 host stands for (`::ffff:a9fe:a9fe`), which reaches the same machine; null for any other host. */
export const mappedIpv4 = (host: string): string | null => {
  const groups = ipv6Groups(host);
  if (groups === null || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return null;
  const [high, low] = groups.slice(6) as [number, number];
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
};

interface Address {
  readonly scheme: string | null;
  readonly host: string | null;
  /** A local `file:` address's path, percent-decoded. */
  readonly filePath: string | null;
}

const isControl = (char: string): boolean => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;

/**
 * An address as WHATWG's parser reads it before anything else: every tab,
 * CR and LF removed wherever it stands (`http://169.254.169\t.254/` is the
 * metadata address), control characters and spaces trimmed from both ends.
 * A control character left in the host makes it no host (`canonicalHost`);
 * one in the path is the path's.
 */
const cleanAddress = (address: string): string => {
  const chars = [...address].filter((char) => char !== "\t" && char !== "\n" && char !== "\r");
  let start = 0;
  let end = chars.length;
  while (start < end && ((chars[start] as string) === " " || isControl(chars[start] as string))) start++;
  while (end > start && ((chars[end - 1] as string) === " " || isControl(chars[end - 1] as string))) end--;
  return chars.slice(start, end).join("");
};

/**
 * How much of an address is read: its scheme and its authority are at its
 * front, so a longer one is read from its first characters, never refused,
 * and padding its path cannot hide its host.
 */
const ADDRESS_READ = 8_192;

/** Reads an address: a URL, or a bare host with an optional port. */
const readAddress = (address: string): Address | null => {
  const text = cleanAddress(address).slice(0, ADDRESS_READ);
  if (text === "") return null;
  const schemed = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(text);
  // `localhost:8080` and `db.internal:5432/x` are hosts with ports, and `fe80::1` an IPv6 literal, not schemes; a special
  // scheme is one before digits too (`http:2852039166`), whose authority WHATWG reads with no slashes.
  const bareIpv6 = /^[0-9A-Fa-f:.]+$/.test(text) && (text.match(/:/g)?.length ?? 0) >= 2;
  const isScheme =
    schemed !== null && !bareIpv6 && (SPECIAL_SCHEMES.has((schemed[1] as string).toLowerCase()) || !/^\d+(?:[/?#]|$)/.test(schemed[2] as string));
  const scheme = isScheme ? (schemed?.[1] as string).toLowerCase() : null;
  const special = scheme === null || SPECIAL_SCHEMES.has(scheme);
  let rest = isScheme ? (schemed?.[2] as string) : text;
  // A browser reads a backslash as a slash in a special scheme's address.
  if (special) rest = rest.replace(/\\/g, "/");
  if (scheme !== null) {
    if (special) rest = rest.replace(/^\/+/, "");
    else if (rest.startsWith("//")) rest = rest.slice(2);
    else return { scheme, host: null, filePath: null };
  }
  if (scheme === "file") {
    // `file:///p` and `file://localhost/p` are local; `file://host/p` is another machine's. A path with no slash before
    // it is read from the root, as WHATWG reads `file:etc/shadow` as `file:///etc/shadow`.
    const original = (schemed?.[2] as string).replace(/\\/g, "/");
    const remote = /^\/\/([^/?#]*)(\/[^?#]*)?/.exec(original);
    const authority = remote === null ? "" : (remote[1] as string);
    const written = remote === null ? (/^[^?#]*/.exec(original)?.[0] ?? "") : (remote[2] ?? "/");
    const path = written.startsWith("/") ? written : `/${written}`;
    if (authority !== "" && authority.toLowerCase() !== "localhost") return { scheme, host: canonicalHost(authority), filePath: null };
    try {
      return { scheme, host: null, filePath: decodeURIComponent(path) };
    } catch {
      return null;
    }
  }
  const authority = /^[^/?#]*/.exec(rest)?.[0] ?? "";
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  let host: string;
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    if (close === -1) return null;
    host = hostAndPort.slice(0, close + 1);
  } else if (scheme === null && (hostAndPort.match(/:/g)?.length ?? 0) >= 2) {
    host = hostAndPort; // A bare IPv6 literal: `::1`.
  } else {
    host = hostAndPort.replace(/:\d*$/, "");
  }
  return { scheme, host: canonicalHost(host), filePath: null };
};

/**
 * The host an address reaches, as a browser and the network read it: the
 * userinfo discarded (`https://paypal.com@evil.test/` is `evil.test`), a
 * backslash read as a slash, the port dropped, lower case, percent-decoded,
 * no trailing dot, IPv4 in any spelling as dotted decimal and IPv6 as RFC
 * 5952 writes it. Takes a URL or a bare host with an optional port; null
 * for an address with no host (`javascript:`, a local `file:` URL, an
 * empty string). Internationalised names are compared as given, not
 * converted to punycode.
 */
export const hostOf = (address: string): string | null => readAddress(address)?.host ?? null;

/**
 * The scheme and the host of an address, as `hostOf` reads the host: the
 * scheme lower case, null for a bare host with an optional port; the host
 * null for an address with none. Null for no address at all (an empty
 * string).
 */
export const addressOf = (address: string): { readonly scheme: string | null; readonly host: string | null } | null => {
  const read = readAddress(address);
  return read === null ? null : { scheme: read.scheme, host: read.host };
};

/** A host pattern read into its wildcard and its host. */
const hostPatternOf = (pattern: string): { readonly wildcard: boolean; readonly host: string | null } => {
  const wildcard = pattern.startsWith("*.");
  return { wildcard, host: canonicalHost(wildcard ? pattern.slice(2) : pattern) };
};

/** Whether a host pattern matches a host: `*.x` matches `x` and every subdomain of it, anything else the host alone. */
const hostMatches = ({ wildcard, host: target }: { readonly wildcard: boolean; readonly host: string | null }, host: string): boolean => {
  if (target === null) return false;
  const candidates = [host, mappedIpv4(host)].filter((value): value is string => value !== null);
  return candidates.some((candidate) => candidate === target || (wildcard && candidate.endsWith(`.${target}`)));
};

/**
 * Whether a host pattern of the browser domains' or the hosts' grammar
 * matches a host `hostOf` read, as `matchDenylist` matches both: `*.x` is
 * `x` and every subdomain of it, anything else the host alone, and an
 * IPv4-mapped IPv6 host is its IPv4 address too.
 */
export const hostPatternMatches = (pattern: string, host: string): boolean => hostMatches(hostPatternOf(pattern), host);

// The match -----------------------------------------------------------------

interface Subject {
  /** What the call gave. */
  readonly value: string;
}
interface PathSubject extends Subject {
  readonly forms: string[][];
  /** Whether the value holds glob syntax the shell expands (`~/.s*h/id_rsa`). */
  readonly glob: boolean;
}
interface HostSubject extends Subject {
  readonly host: string;
}
interface CommandSubject extends Subject {
  readonly tokens: readonly string[];
  /** The tokens with their braces expanded and a glued pipe split off the word after it (`shellRead`); `tokens` itself when there is neither. */
  readonly read: readonly string[];
  /** Whether a token's braces make more words than are read: the line is then taken to meet every command pattern. */
  readonly unbounded: boolean;
}

/** Keeps the first of each value. */
const unique = <S extends Subject>(subjects: readonly S[]): S[] => {
  const seen = new Set<string>();
  return subjects.filter((subject) => !seen.has(subject.value) && (seen.add(subject.value), true));
};

/**
 * Every enabled entry the call matches, once each, in section order and
 * each section in its own order, with the first value that matched it. A
 * call matches nothing when it names nothing an entry covers. Paths are
 * matched after `~` and the working directory, as written and after
 * symbolic links resolve (a path written as a glob also against what it
 * can expand to); command patterns against each whole command line; hosts
 * and domains against the host each address reaches. Each value is read
 * once, each entry's forms computed once and each path resolved once, so a
 * long command line costs its length, not its length times the list.
 */
export const matchDenylist = (denylist: Denylist, call: DenylistCall, context: DenylistMatchContext): DenylistMatch[] => {
  const commands: CommandSubject[] = unique(
    (call.commands ?? []).map((value) => {
      const tokens = tokensOf(value, context.pathStyle === "win32");
      return { value, tokens, ...shellRead(tokens) };
    }),
  );
  // A call's own paths may hold a glob tool's braces; a command line's come expanded, but for a token too long to expand.
  const pathValues: { readonly value: string; readonly braces: boolean }[] = (call.paths ?? []).map((value) => ({ value, braces: true }));
  const hostValues: string[] = [...(call.hosts ?? [])];
  const hostSubjects: HostSubject[] = [];
  const domainSubjects: HostSubject[] = [];
  const filePaths: string[] = [];

  for (const command of commands) {
    const found = subjectsOf(command.tokens, context.pathStyle === "win32");
    // An unbounded token first: the same token read as written must not stand for it (`unique` keeps the first).
    pathValues.push(...found.unbounded.map((value) => ({ value, braces: true })), ...found.paths.map((value) => ({ value, braces: false })));
    hostValues.push(...found.urls, ...found.hosts);
  }
  const readInto = (value: string, into: HostSubject[] | null): void => {
    const address = readAddress(value);
    if (address === null) return;
    if (address.filePath !== null) filePaths.push(address.filePath);
    if (address.host === null) return;
    hostSubjects.push({ value, host: address.host });
    into?.push({ value, host: address.host });
  };
  for (const value of call.browserDomains ?? []) readInto(value, domainSubjects);
  for (const value of hostValues) readInto(value, null);

  const paths = pathReader(context);
  const pathSubjects: PathSubject[] = unique([...pathValues, ...filePaths.map((value) => ({ value, braces: false }))]).flatMap(({ value, braces }) =>
    expandedPaths(value, braces).map((path) => ({ value, forms: paths.forms(path), glob: /[*?]/.test(path) })),
  );
  const hostPatterns = new Map<string, { readonly wildcard: boolean; readonly host: string | null }>();
  const hostMatchesEntry = (entry: DenylistEntry, subject: HostSubject): boolean => {
    let pattern = hostPatterns.get(entry.pattern);
    if (pattern === undefined) {
      pattern = hostPatternOf(entry.pattern);
      hostPatterns.set(entry.pattern, pattern);
    }
    return hostMatches(pattern, subject.host);
  };

  const matches: DenylistMatch[] = [];
  const take = <S extends Subject>(section: DenylistSection, subjects: readonly S[], matchesEntry: (entry: DenylistEntry, subject: S) => boolean): void => {
    if (subjects.length === 0) return;
    for (const entry of denylist[section]) {
      if (!entry.enabled) continue;
      const subject = subjects.find((candidate) => matchesEntry(entry, candidate));
      if (subject !== undefined) matches.push({ section, entry, matched: subject.value });
    }
  };
  take("browserDomains", unique(domainSubjects), hostMatchesEntry);
  take("paths", pathSubjects, (entry, subject) => paths.matches(entry.pattern, subject));
  take(
    "commandPatterns",
    commands,
    (entry, subject) => subject.unbounded || commandMatches(entry.pattern, subject.tokens) || (subject.read !== subject.tokens && commandMatches(entry.pattern, subject.read)),
  );
  take("hosts", unique(hostSubjects), hostMatchesEntry);
  return matches;
};

/** The call a tested value stands for (`permissions.denylist.test`): a kind and a value in, the one-list call out. */
export const denylistTestCall = (kind: DenylistTestKind, value: string): DenylistCall => {
  switch (kind) {
    case "browserDomain":
      return { browserDomains: [value] };
    case "path":
      return { paths: [value] };
    case "command":
      return { commands: [value] };
    case "host":
      return { hosts: [value] };
  }
};

const SECTION_NAMES: Readonly<Record<DenylistSection, string>> = {
  browserDomains: "browser domains",
  paths: "paths",
  commandPatterns: "command patterns",
  hosts: "hosts",
};

/** The longest a match's value is quoted in a sentence about it. */
const QUOTED_MAX = 60;

/**
 * What matched an entry on one short line, as a sentence about the match
 * quotes it: its first line with anything on it, white space collapsed, cut
 * with an ellipsis.
 */
export const quoteDenylistMatched = (value: string): string => {
  const line =
    value
      .split(/\r\n|\r|\n/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find((part) => part !== "") ?? "";
  return line.length <= QUOTED_MAX ? line : `${line.slice(0, QUOTED_MAX - 1).trimEnd()}…`;
};

/**
 * One line naming a match, for a prompt's summary and reason and the
 * model's message: the section and the entry, with what matched it cut to
 * one short line, so a long command or a heredoc is never repeated whole.
 */
export const describeDenylistMatch = (match: DenylistMatch): string => `${quoteDenylistMatched(match.matched)} is on the denylist (${SECTION_NAMES[match.section]}: ${match.entry.pattern})`;

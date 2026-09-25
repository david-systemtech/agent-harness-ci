import { z } from "zod";

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
 * `::`, the last two groups optionally a dotted IPv4 address. `::::` and
 * nine groups are refused.
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
  `(?:${H16}:){0,5}:${V4}`,
  `::(?:${H16}:){0,5}${V4}`,
].join("|");

/**
 * A domain or host pattern: a host name, an IPv4 address or an IPv6 literal,
 * with an optional leading wildcard label (`*.paypal.com`: the domain and
 * every subdomain). No scheme, port, path or other wildcard.
 */
const HostPattern = z
  .string()
  .regex(new RegExp(`^(?:(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*|${IPV6})$`))
  .meta({ description: "A host name, IPv4 address or IPv6 literal, with an optional leading wildcard label (*.example.com): no scheme, port or path." });

/**
 * A path pattern: absolute, or `~`-relative (the home directory of the
 * environment's user), with glob segments: `*` and `?` within a segment, and
 * `**` as a whole segment for any number of them. `~user` is refused.
 */
const PathPattern = z
  .string()
  .regex(/^(?:~|~\/[^\0]*|\/[^\0]*)$/)
  .meta({ description: "An absolute or ~-relative path, with glob segments: * and ? within a segment, ** for any number of segments." });

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
  id: EntryId.optional().meta({ description: "The entry's id: an existing entry's to keep or edit it, a preset's to put a preset back; minted when absent." }),
  pattern,
  note: EntryNote.optional().meta({ description: "Why the entry is there; empty when absent." }),
  enabled: z.boolean().optional().meta({ description: "Whether it matches; true when absent." }),
});

/**
 * A section's entries as `permissions.denylist.set` takes them: an entry
 * named by an id the section holds keeps it (edited or not), a preset's id
 * is a preset, anything else a new entry. `preset` is the environment's to
 * say, and ignored when sent.
 */
export const DenylistInput = z
  .object({
    browserDomains: z.array(z.object(inputShape(HostPattern))),
    paths: z.array(z.object(inputShape(PathPattern))),
    commandPatterns: z.array(z.object(inputShape(CommandPattern))),
    hosts: z.array(z.object(inputShape(HostPattern))),
  })
  .partial()
  .meta({ description: "Some sections of the denylist, each replaced by the entries given: one section, or all four." });
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
 * Artemis's browser list (`DEFAULT_BLOCKED_SITES` in its protocol's browser
 * driver at 443cf2e), in its order: password managers, payments and money
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
  /** Whether paths compare without regard to case, as the file systems of macOS and Windows do. */
  readonly caseInsensitive?: boolean | undefined;
}

/** `path` absolute: `~` (and `~user` for the context's own user) expanded, a relative path read against `cwd`. Not normalised. */
const absolute = (path: string, context: Pick<DenylistMatchContext, "home" | "cwd" | "user">): string => {
  const own = context.user !== undefined && context.user !== "" ? `~${context.user}` : null;
  for (const tilde of own === null ? ["~"] : ["~", own]) {
    if (path === tilde) return context.home;
    if (path.startsWith(`${tilde}/`)) return `${context.home}/${path.slice(tilde.length + 1)}`;
  }
  if (path.startsWith("/")) return path;
  return `${context.cwd}/${path}`;
};

/** The segments of an absolute path with `..` applied as text. */
const lexical = (path: string): string[] => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
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
  const fold = context.caseInsensitive === true ? (form: string[]) => form.map((part) => part.toLowerCase()) : (form: string[]) => form;
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
    if (resolve !== undefined) read.push(lexical(resolveOnce(full)));
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
        read.push([...lexical(resolveOnce(`/${literal.join("/")}`)), ...rest]);
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

/**
 * A command line's tokens: split on white space, then at every operator
 * (`$(`, a backtick, `(`, `)`, a redirection, `;`, `&&`, `||`, `&`), each
 * kept as a token, and a `|` inside a token starting a token (`x|sh` is `x`
 * and `|sh`), so a pattern meets the spellings a shell reads alike:
 * `x>~/.netrc`, `cat<key`, `x=$(sudo ls)`. A quote does not hide an
 * operator: the reading is of tokens, not of the shell's grammar.
 */
const tokensOf = (line: string): string[] =>
  line
    .trim()
    .split(/\s+/)
    .flatMap((token) => token.split(OPERATORS))
    .flatMap((token) => (OPERATOR_TOKEN.test(token) ? [token] : token.split(/(?=\|)/)))
    .filter((token) => token !== "");

/** Whether a pattern token matches a line token, as written or unwrapped: a `*` inside it matches anything within the token. */
const tokenMatches = (pattern: string, token: string): boolean => wildcard(pattern, token, false) || wildcard(pattern, unwrap(token), false);

/** Whether a command pattern matches a command line's tokens anywhere in it: a bare `*` any run of tokens, none included. */
const commandMatches = (pattern: string, tokens: readonly string[]): boolean => sequenceMatches(["*", ...pattern.trim().split(/\s+/), "*"], tokens, "*", tokenMatches);

/** A URL: a scheme and `//`, or any `file:` address, which names a local path with one slash as well as with three. */
const URL_PREFIX = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|file:)/i;

/** `$HOME` and `${HOME}` at a token's start read as `~`. */
const home = (token: string): string => token.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~");

/** Whether a token reads as a path: absolute, `~`, a dot file or a relative path with a slash in it. */
const isPathLike = (token: string): boolean => token.startsWith("/") || token.startsWith("~") || token.startsWith(".") || token.includes("/");

/** A token that reads as a host: a name with a dot, `localhost`, a bracketed IPv6 literal, each with an optional port. */
const HOST_TOKEN = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})+|localhost|\\[[0-9A-Fa-f:.]+\\])(?::\\d+)?$`);
const SINGLE_LABEL = new RegExp(`^${LABEL}(?::\\d+)?$`);

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
 * network reads as an address, with an optional port; after a user
 * (`admin@db.internal`, where a single label is a host too); before a path
 * (`169.254.169.254/latest`) or scp's `:path` (`git@host.example:repo.git`).
 * An absolute, `~` or dot path, an option and a URL are not hosts. The
 * port and a trailing dot are dropped.
 */
export const hostToken = (token: string): string | null => {
  const text = asciiHost(token.trim());
  if (text === "" || /^[-/~.]/.test(text) || URL_PREFIX.test(text)) return null;
  let candidate = text.split("/")[0] as string;
  const user = candidate.lastIndexOf("@");
  candidate = candidate.slice(user + 1);
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
 * reads them against the paths and the hosts: each token unwrapped (quotes
 * and escapes taken out wherever they stand), `$HOME` read as `~`, a
 * redirection's target a token of its own, an option's value (`--out=x`,
 * `of=/dev/sdb`) taken on its own. A path is absolute, `~`-relative, a dot
 * file, or has a slash in it; a host is a bare token `hostToken` reads as one.
 */
export const shellSubjects = (line: string): { paths: string[]; urls: string[]; hosts: string[] } => subjectsOf(tokensOf(line));

const subjectsOf = (tokens: readonly string[]): { paths: string[]; urls: string[]; hosts: string[] } => {
  const paths: string[] = [];
  const urls: string[] = [];
  const hosts: string[] = [];
  for (const raw of tokens) {
    if (OPERATOR_TOKEN.test(raw)) continue;
    const whole = home(unwrap(raw));
    const equals = whole.indexOf("=");
    const candidates = equals > 0 && !URL_PREFIX.test(whole) ? [home(whole.slice(equals + 1))] : [whole];
    // An absolute path with `=` in it is a path too, beside what follows the `=`.
    if (candidates[0] !== whole && (whole.startsWith("/") || whole.startsWith("~/"))) candidates.unshift(whole);
    for (const token of candidates) {
      if (token === "" || token.startsWith("-")) continue;
      if (URL_PREFIX.test(token)) {
        urls.push(token);
        continue;
      }
      if (isPathLike(token)) paths.push(token);
      const host = hostToken(token);
      if (host !== null) hosts.push(host);
    }
  }
  return { paths, urls, hosts };
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
const ipv6Groups = (literal: string): number[] | null => {
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
const canonicalHost = (host: string, special: boolean): string | null => {
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
  if (!special) return text;
  const v4 = ipv4Of(text);
  return v4 === undefined ? text : v4;
};

/** The IPv4 address an IPv4-mapped IPv6 host stands for (`::ffff:a9fe:a9fe`), which reaches the same machine. */
const mappedIpv4 = (host: string): string | null => {
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
  // `localhost:8080` and `db.internal:5432/x` are hosts with ports, and `fe80::1` an IPv6 literal, not schemes.
  const bareIpv6 = /^[0-9A-Fa-f:.]+$/.test(text) && (text.match(/:/g)?.length ?? 0) >= 2;
  const isScheme = schemed !== null && !bareIpv6 && !/^\d+(?:[/?#]|$)/.test(schemed[2] as string);
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
    // `file:///p` and `file://localhost/p` are local; `file://host/p` is another machine's.
    const original = (schemed?.[2] as string).replace(/\\/g, "/");
    const match = /^\/\/([^/?#]*)(\/[^?#]*)?/.exec(original) ?? /^(\/[^?#]*)/.exec(original);
    if (match === null) return { scheme, host: null, filePath: null };
    const authority = original.startsWith("//") ? (match[1] as string) : "";
    const path = original.startsWith("//") ? (match[2] ?? "/") : (match[1] as string);
    if (authority !== "" && authority.toLowerCase() !== "localhost") return { scheme, host: canonicalHost(authority, true), filePath: null };
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
  return { scheme, host: canonicalHost(host, special), filePath: null };
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

/** A host pattern read into its wildcard and its host. */
const hostPatternOf = (pattern: string): { readonly wildcard: boolean; readonly host: string | null } => {
  const wildcard = pattern.startsWith("*.");
  return { wildcard, host: canonicalHost(wildcard ? pattern.slice(2) : pattern, true) };
};

/** Whether a host pattern matches a host: `*.x` matches `x` and every subdomain of it, anything else the host alone. */
const hostMatches = ({ wildcard, host: target }: { readonly wildcard: boolean; readonly host: string | null }, host: string): boolean => {
  if (target === null) return false;
  const candidates = [host, mappedIpv4(host)].filter((value): value is string => value !== null);
  return candidates.some((candidate) => candidate === target || (wildcard && candidate.endsWith(`.${target}`)));
};

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
  const commands: CommandSubject[] = unique((call.commands ?? []).map((value) => ({ value, tokens: tokensOf(value) })));
  const pathValues: string[] = [...(call.paths ?? [])];
  const hostValues: string[] = [...(call.hosts ?? [])];
  const hostSubjects: HostSubject[] = [];
  const domainSubjects: HostSubject[] = [];
  const filePaths: string[] = [];

  for (const command of commands) {
    const found = subjectsOf(command.tokens);
    pathValues.push(...found.paths);
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
  const pathSubjects: PathSubject[] = unique([...pathValues, ...filePaths].map((value) => ({ value }))).map(({ value }) => ({
    value,
    forms: paths.forms(value),
    glob: /[*?]/.test(value),
  }));
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
  take("commandPatterns", commands, (entry, subject) => commandMatches(entry.pattern, subject.tokens));
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

/** A value on one short line: its first line with anything on it, white space collapsed, cut with an ellipsis. */
const quoted = (value: string): string => {
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
export const describeDenylistMatch = (match: DenylistMatch): string => `${quoted(match.matched)} is on the denylist (${SECTION_NAMES[match.section]}: ${match.entry.pattern})`;

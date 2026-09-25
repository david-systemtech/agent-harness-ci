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

/**
 * A domain or host pattern: a host name, an IPv4 address or an IPv6 literal,
 * with an optional leading wildcard label (`*.paypal.com`: the domain and
 * every subdomain). No scheme, port, path or other wildcard.
 */
const HostPattern = z
  .string()
  .regex(new RegExp(`^(?:(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*|[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)$`))
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
   * denylisted directory and a denylisted link are both caught.
   */
  readonly resolve?: ((path: string) => string) | undefined;
  /**
   * Directories no broader entry matches in: a path at or under one is not
   * matched by an entry that covers the directory itself (the data
   * directory's entry over the containment directories the environment's
   * runs write in), while an entry inside the directory still matches, and
   * so does a link there that leads out.
   */
  readonly exempt?: readonly string[];
}

/** `path` absolute: `~` expanded, a relative path read against `cwd`. Not normalised. */
const absolute = (path: string, context: Pick<DenylistMatchContext, "home" | "cwd">): string => {
  if (path === "~") return context.home;
  if (path.startsWith("~/")) return `${context.home}/${path.slice(2)}`;
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
 * Linear in practice: a `*` is backtracked to only once per position, so no
 * pattern can make a long token slow.
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

/** Whether an entry's segments cover a path: the path is the entry or lies under it. `**` is any number of segments. */
const coversPath = (entry: readonly string[], path: readonly string[]): boolean =>
  sequenceMatches([...entry, "**"], path, "**", (segment, part) => (isGlob(segment) ? wildcard(segment, part, true) : segment === part));

/** The forms of a path the matcher reads: as written (`..` applied as text), and as resolved when a resolver is given. */
const pathForms = (path: string, context: DenylistMatchContext): string[][] => {
  const full = absolute(path, context);
  const forms = [lexical(full)];
  if (context.resolve !== undefined) forms.push(lexical(context.resolve(full)));
  return forms;
};

/** The forms of an entry's pattern: as written, and with its literal part before the first glob segment resolved. */
const entryForms = (pattern: string, context: DenylistMatchContext): string[][] => {
  const segments = lexical(absolute(pattern, context));
  const forms = [segments];
  if (context.resolve !== undefined) {
    const firstGlob = segments.findIndex(isGlob);
    const literal = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
    const rest = firstGlob === -1 ? [] : segments.slice(firstGlob);
    forms.push([...lexical(context.resolve(`/${literal.join("/")}`)), ...rest]);
  }
  return forms;
};

const sameSegments = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((part, index) => part === b[index]);

const dedupe = (forms: string[][]): string[][] => forms.filter((form, index) => forms.findIndex((other) => sameSegments(form, other)) === index);

/** Whether the path's form lies at or under a directory. */
const within = (directory: readonly string[], path: readonly string[]): boolean =>
  directory.length <= path.length && directory.every((part, index) => part === path[index]);

/** Whether the entry matches the path, leaving out a path in an exempt directory the entry covers as a whole. */
const pathMatches = (entry: readonly string[][], path: readonly string[][], exempt: readonly string[][]): boolean =>
  path.some((form) =>
    entry.some((pattern) => {
      if (!coversPath(pattern, form)) return false;
      return !exempt.some((directory) => within(directory, form) && coversPath(pattern, directory));
    }),
  );

// Command lines -------------------------------------------------------------

/** What wraps a token without being part of it: quotes, brackets, a substitution's opening, a statement's end. */
const WRAPPING_START = /^(?:\$\(|[`"'({[<])+/;
const WRAPPING_END = /[`"')}\];,]+$/;

/** A token with its quotes and brackets taken off. */
const unwrap = (token: string): string => token.replace(WRAPPING_START, "").replace(WRAPPING_END, "");

/**
 * A command line's tokens: split on white space, then `;`, `&&`, `||` and
 * `&` split off as tokens of their own, and a `|` inside a token starting a
 * token (`x|sh` is `x` and `|sh`), so a pattern meets the spellings a shell
 * reads alike.
 */
const tokensOf = (line: string): string[] =>
  line
    .trim()
    .split(/\s+/)
    .flatMap((token) => token.split(/(;|&&|\|\||(?<!>)&(?![>&]))/))
    .flatMap((token) => (token === "||" ? [token] : token.split(/(?=\|)/)))
    .filter((token) => token !== "");

/** Whether a pattern token matches a line token, as written or unwrapped: a `*` inside it matches anything within the token. */
const tokenMatches = (pattern: string, token: string): boolean => wildcard(pattern, token, false) || wildcard(pattern, unwrap(token), false);

/** Whether a command pattern matches a command line anywhere in it: a bare `*` any run of tokens, none included. */
const commandMatches = (pattern: string, line: string): boolean => sequenceMatches(["*", ...pattern.trim().split(/\s+/), "*"], tokensOf(line), "*", tokenMatches);

const URL_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A redirection before a target (`2>`, `>>`, `&>`, `<`) or an option's name before its value (`--out=`, `of=`). */
const REDIRECTION = /^\d*(?:&>>?|>>?&?|<<?<?|>\|)/;

/** `$HOME` and `${HOME}` at a token's start read as `~`. */
const home = (token: string): string => token.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~");

/** Whether a token reads as a path: absolute, `~`, a dot file or a relative path with a slash in it. */
const isPathLike = (token: string): boolean => token.startsWith("/") || token === "~" || token.startsWith("~/") || token.startsWith(".") || token.includes("/");

/** Whether a bare token reads as a host: a name with a dot, an IPv4 address, `localhost`, a bracketed IPv6 literal, each with an optional port. */
const HOST_TOKEN = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})+|localhost|\\[[0-9A-Fa-f:.]+\\])(?::\\d+)?$`);

/**
 * The path-like tokens, URLs and hosts of a command line, as the matcher
 * reads them against the paths and the hosts: each token unwrapped, a
 * redirection's target and an option's value taken on their own. A path is
 * absolute, `~`-relative, a dot file, or has a slash in it; a host is a bare
 * token that reads as one (`10.0.0.5`, `api.example.com:443`,
 * `admin@db.internal`).
 */
export const shellSubjects = (line: string): { paths: string[]; urls: string[]; hosts: string[] } => {
  const paths: string[] = [];
  const urls: string[] = [];
  const hosts: string[] = [];
  for (const raw of tokensOf(line)) {
    const whole = home(unwrap(raw).replace(REDIRECTION, ""));
    const equals = whole.indexOf("=");
    const candidates = equals > 0 && !URL_PREFIX.test(whole) ? [home(unwrap(whole.slice(equals + 1)))] : [whole];
    // An absolute path with `=` in it is a path too, beside what follows the `=`.
    if (candidates[0] !== whole && (whole.startsWith("/") || whole.startsWith("~/"))) candidates.unshift(whole);
    for (const token of candidates) {
      if (token === "" || token.startsWith("-")) continue;
      if (URL_PREFIX.test(token)) {
        urls.push(token);
        continue;
      }
      if (isPathLike(token)) paths.push(token);
      if (token.startsWith("/") || token.startsWith("~") || token.startsWith(".")) continue;
      // A host before a path (`169.254.169.254/latest`), after a user (`admin@db.internal`), before scp's `:` (`host:file`).
      const host = (token.split("/")[0] as string).replace(/^.*@/, "").replace(/:$/, "");
      if (HOST_TOKEN.test(host)) hosts.push(host);
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
  text = text.toLowerCase().replace(/\.$/, "");
  if (text === "" || /[\s/\\?#@]/.test(text)) return null;
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

/** Reads an address: a URL, or a bare host with an optional port. */
const readAddress = (address: string): Address | null => {
  const text = address.trim();
  if (text === "" || text.length > 8_192 || [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return null;
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
const hostMatches = (pattern: string, host: string): boolean => {
  const { wildcard, host: target } = hostPatternOf(pattern);
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
}
interface HostSubject extends Subject {
  readonly host: string;
}

/**
 * Every enabled entry the call matches, once each, in section order and
 * each section in its own order, with the first value that matched it. A
 * call matches nothing when it names nothing an entry covers. Paths are
 * matched after `~` and the working directory, as written and after
 * symbolic links resolve; command patterns against each whole command line;
 * hosts and domains against the host each address reaches.
 */
export const matchDenylist = (denylist: Denylist, call: DenylistCall, context: DenylistMatchContext): DenylistMatch[] => {
  const pathValues: string[] = [...(call.paths ?? [])];
  const hostValues: string[] = [...(call.hosts ?? [])];
  const commandValues = call.commands ?? [];
  const domainValues = call.browserDomains ?? [];
  const hostSubjects: HostSubject[] = [];
  const domainSubjects: HostSubject[] = [];
  const filePaths: Subject[] = [];

  for (const line of commandValues) {
    const found = shellSubjects(line);
    pathValues.push(...found.paths);
    hostValues.push(...found.urls, ...found.hosts);
  }
  const readInto = (value: string, into: HostSubject[] | null): void => {
    const address = readAddress(value);
    if (address === null) return;
    if (address.filePath !== null) filePaths.push({ value });
    if (address.host === null) return;
    hostSubjects.push({ value, host: address.host });
    into?.push({ value, host: address.host });
  };
  for (const value of domainValues) readInto(value, domainSubjects);
  for (const value of hostValues) readInto(value, null);

  const pathSubjects: PathSubject[] = [
    ...pathValues.map((value) => ({ value, forms: dedupe(pathForms(value, context)) })),
    ...filePaths.map(({ value }) => ({ value, forms: dedupe(pathForms(readAddress(value)?.filePath ?? "/", context)) })),
  ];
  const exempt = dedupe((context.exempt ?? []).flatMap((directory) => pathForms(directory, context)));

  const matches: DenylistMatch[] = [];
  const take = <S extends Subject>(section: DenylistSection, subjects: readonly S[], matchesEntry: (entry: DenylistEntry, subject: S) => boolean): void => {
    for (const entry of denylist[section]) {
      if (!entry.enabled) continue;
      const subject = subjects.find((candidate) => matchesEntry(entry, candidate));
      if (subject !== undefined) matches.push({ section, entry, matched: subject.value });
    }
  };
  take("browserDomains", domainSubjects, (entry, subject) => hostMatches(entry.pattern, subject.host));
  take("paths", pathSubjects, (entry, subject) => pathMatches(dedupe(entryForms(entry.pattern, context)), subject.forms, exempt));
  take(
    "commandPatterns",
    commandValues.map((value) => ({ value })),
    (entry, subject) => commandMatches(entry.pattern, subject.value),
  );
  take("hosts", hostSubjects, (entry, subject) => hostMatches(entry.pattern, subject.host));
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

/** One line naming a match, for a prompt's summary and the model's message: the section and the entry. */
export const describeDenylistMatch = (match: DenylistMatch): string => `${match.matched} is on the denylist (${SECTION_NAMES[match.section]}: ${match.entry.pattern})`;

const SECTION_NAMES: Readonly<Record<DenylistSection, string>> = {
  browserDomains: "browser domains",
  paths: "paths",
  commandPatterns: "command patterns",
  hosts: "hosts",
};

/** Read-only command effects: fixed Git queries and bounded filesystem walks, never a shell. */
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { hostOf, shellSubjects } from '@agent-harness/contracts';

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Segments previewed from one command. Past this the rest are recognised but not read. */
export const MAX_PARTS = 8;

/** Directory entries counted before a count becomes `2000+`. */
export const MAX_ENTRIES = 2000;

/** Paths printed under a summary. The rest become `… +n more`. */
export const MAX_LISTED = 20;

/** How long any one child process gets. */
export const BLAST_TIMEOUT_MS = 5_000;

/** Directory reads across one {@link previewBlastRadius} call. */
export const MAX_READDIRS = 4_000;

/** How deep a walk or a `**` goes. A symlink loop cannot happen — links are not followed — but a deep tree can. */
const MAX_DEPTH = 24;

/** Paths one glob may match, so that `**` in a monorepo is not the whole monorepo. */
const MAX_MATCHES = 500;

/** Alternatives one `{a,b,c}` may expand to, counting nesting. */
const MAX_BRACES = 64;

/** Bigger than anything a dry run prints, and a bound on the pipe. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The verbs worth warning about.
 *
 * `other` is the escape hatch for a command that unmistakably destroys — `dd`,
 * `shred`, `mkfs`, `wipefs` — and for which there is no dry run to run and no
 * glob to expand. It still earns a line, because "this is destructive and
 * cannot be previewed" is information, and a silent card would be read as
 * "this is fine".
 */
export type DestructiveKind =
  | 'rm'
  | 'git-clean'
  | 'git-reset-hard'
  | 'git-push-force'
  | 'git-checkout-discard'
  | 'git-branch-delete'
  | 'drop'
  | 'truncate-redirect'
  | 'chmod-recursive'
  | 'find-delete'
  | 'shell-expansion'
  | 'other';

/** One segment of a command line that would destroy something. */
export interface Destructive {
  readonly kind: DestructiveKind;
  /** The segment as typed, comments and surrounding operators removed. */
  readonly text: string;
  /**
   * What the verb acts on: paths for `rm`, pathspecs for `git clean`, branch
   * names for `git branch -D`, object names for a `DROP`. Unexpanded — a glob
   * is still a glob here, and {@link previewBlastRadius} is what resolves it.
   *
   * A target that was quoted keeps its glob characters backslash-escaped, so
   * `rm '*'` names the file called `*` rather than everything in the directory.
   */
  readonly targets: readonly string[];
  /** The verb's own flags, as typed: `-rf` stays `-rf` rather than becoming two. */
  readonly flags: readonly string[];
  /** A source checkout or restore that replaces the index as well as the worktree. */
  readonly overwritesIndex?: boolean;
}

/** What one {@link Destructive} would do, read off the disk. */
export interface Preview {
  readonly kind: DestructiveKind;
  /** One sentence, the thing a person reads first: `3 files and 1 directory (412 files inside)`. */
  readonly summary: string;
  /** The detail under it, at most {@link MAX_LISTED} of them. */
  readonly lines: readonly string[];
  /** How many items {@link Preview.lines} is a window onto, when that is countable. */
  readonly count?: number;
  /** A count that hit {@link MAX_ENTRIES} and is therefore a floor, not a total. */
  readonly truncated?: boolean;
}

/** One entry of a directory, reduced to the two facts this module uses. */
export interface DirEntry {
  readonly name: string;
  readonly directory: boolean;
}

/** One path, reduced likewise. A symlink is a file: deleting one deletes the link. */
export interface FileInfo {
  readonly size: number;
  readonly directory: boolean;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly signal?: AbortSignal;
}

/** Run a program and hand back its stdout. Rejects on a non-zero exit. */
export type ExecFile = (file: string, args: readonly string[], options: ExecOptions) => Promise<string>;

/**
 * The disk and the child processes, injectable.
 *
 * Narrower than `node:fs/promises` on purpose: a test standing in for the disk
 * should write three small functions, and the narrowness is itself part of the
 * safety argument — there is no `writeFile` here to call by accident.
 */
export interface BlastRadiusDeps {
  readonly execFile: ExecFile;
  readonly readdir: (path: string) => Promise<readonly DirEntry[]>;
  /** Does not follow symlinks. */
  readonly stat: (path: string) => Promise<FileInfo>;
  readonly timeoutMs: number;
}

export const nodeBlastDeps: BlastRadiusDeps = {
  execFile: async (file, args, options) => {
    assertReadOnly(file, args);
    const { stdout } = await run(file, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      windowsHide: true,
      ...(options.signal !== undefined && { signal: options.signal }),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  },
  readdir: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
  stat: async (path) => {
    const info = await lstat(path);
    return { size: info.size, directory: info.isDirectory() };
  },
  timeoutMs: BLAST_TIMEOUT_MS,
};

// ===========================================================================
// The tokenizer
// ===========================================================================

/** One word of a command line, and whether any of it arrived quoted. */
interface Word {
  readonly text: string;
  readonly quoted: boolean;
  readonly operand: string;
}

type RedirectOp = '>' | '>>' | '<';

interface Redirect {
  readonly op: RedirectOp;
  readonly target: Word;
}

/** One command between two operators, with its redirections lifted out. */
interface Segment {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  /** The slice of the original line this came from, without any trailing comment. */
  readonly text: string;
  readonly unresolvedHereDoc?: boolean;
}

/**
 * Split a command line into the commands it is made of.
 *
 * Enough shell to be right about the things that change the answer, and no
 * more. Quotes, because `rm "my file"` is one path and not two. `&&`, `||`,
 * `;`, `|`, `&` and newlines, because the `rm` is often the second half of
 * something that begins innocently. `#`, because the rest of the line is not a
 * command at all and a `rm -rf /` inside a comment must not raise a warning.
 * Redirections are pulled out of the word list so that the filename of a `>`
 * is never mistaken for an operand of the command in front of it.
 *
 * Here-document bodies are data, skipped up to their literal delimiter.
 * Unquoted bodies can run command substitutions and earn a cannot-tell line.
 * Substitutions and expansions are never executed to discover their effects.
 */
function tokenize(command: string): readonly Segment[] {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let start = 0;
  /** One past the last character that was part of a command, so comments do not reach `text`. */
  let mark = 0;
  let text = '';
  let operand = '';
  let open = false;
  let quoted = false;
  let pending: RedirectOp | null = null;
  let pendingDup = false;
  let pendingDupFile = false;
  let pendingHereDoc: { readonly stripTabs: boolean } | null = null;
  const hereDocs: { readonly delimiter: string; readonly stripTabs: boolean; readonly quoted: boolean }[] = [];

  const pushWord = (): void => {
    if (!open) return;
    const word: Word = { text, quoted, operand };
    if (pending === null) words.push(word);
    else {
      if (!(pending === '>' && pendingDup && (!pendingDupFile || /^(?:\d+|-)$/.test(word.text)))) redirects.push({ op: pending, target: word });
      if (pendingHereDoc !== null) hereDocs.push({ delimiter: word.text, stripTabs: pendingHereDoc.stripTabs, quoted: word.quoted });
      pending = null;
      pendingDup = false;
      pendingDupFile = false;
      pendingHereDoc = null;
    }
    text = '';
    operand = '';
    open = false;
    quoted = false;
  };

  const pushSegment = (nextStart: number): void => {
    pushWord();
    if (words.length > 0 || redirects.length > 0) {
      segments.push({ words, redirects, text: command.slice(start, Math.max(start, mark)).trim() });
    }
    words = [];
    redirects = [];
    pending = null;
    pendingDup = false;
    pendingDupFile = false;
    pendingHereDoc = null;
    start = nextStart;
    mark = nextStart;
  };

  /** A word in front of a `>` that is only digits is a file descriptor, not an operand. */
  const flushBeforeRedirect = (): string | null => {
    if (open && /^\d+$/.test(text) && !quoted) {
      const fd = text;
      text = '';
      operand = '';
      open = false;
      quoted = false;
      return fd;
    }
    pushWord();
    return null;
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index] ?? '';

    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) {
        open = true;
        text += '\\';
        operand += '\\\\';
        index += 1;
        mark = index;
        continue;
      }
      // A backslash before a newline is a line continuation and joins the two.
      if (next !== '\n') {
        open = true;
        quoted = true;
        text += next;
        operand += escapeLiteral(next);
      }
      index += 2;
      mark = index;
      continue;
    }

    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const stop = close === -1 ? command.length : close;
      text += command.slice(index + 1, stop);
      operand += escapeLiteral(command.slice(index + 1, stop));
      open = true;
      quoted = true;
      index = stop + 1;
      mark = Math.min(index, command.length);
      continue;
    }

    if (char === '"') {
      let at = index + 1;
      while (at < command.length) {
        const inner = command[at] ?? '';
        if (inner === '"') break;
        if (inner === '\\') {
          const next = command[at + 1];
          // Inside double quotes a backslash is literal except before these four.
          if (next !== undefined && '"\\$`\n'.includes(next)) {
            if (next !== '\n') {
              text += next;
              operand += escapeLiteral(next);
            }
            at += 2;
            continue;
          }
          text += '\\';
          operand += '\\\\';
          at += 1;
          continue;
        }
        text += inner;
        operand += '$`'.includes(inner) ? inner : escapeLiteral(inner);
        at += 1;
      }
      open = true;
      quoted = true;
      index = Math.min(at + 1, command.length);
      mark = index;
      continue;
    }

    // A `#` only starts a comment where a word would start.
    if (char === '#' && !open) {
      const newline = command.indexOf('\n', index);
      index = newline === -1 ? command.length : newline;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\r') {
      pushWord();
      index += 1;
      continue;
    }

    if (char === '\n' || char === ';') {
      pushSegment(index + 1);
      index += 1;
      if (char === '\n') {
        // Bodies are data, even when they contain operators or unmatched quotes.
        for (const hereDoc of hereDocs.splice(0)) {
          let unresolved = false;
          while (index < command.length) {
            const newline = command.indexOf('\n', index);
            const stop = newline === -1 ? command.length : newline;
            const line = command.slice(index, stop);
            index = newline === -1 ? command.length : newline + 1;
            if ((hereDoc.stripTabs ? line.replace(/^\t+/, '') : line) === hereDoc.delimiter) break;
            if (!hereDoc.quoted && /(^|[^\\])(?:\\\\)*(?:\$\(|`)/.test(line)) unresolved = true;
          }
          if (unresolved) segments.push({ words: [], redirects: [], text: 'here-document command substitution', unresolvedHereDoc: true });
        }
        start = index;
        mark = index;
      }
      continue;
    }

    if (char === '&') {
      const next = command[index + 1];
      if (next === '&') {
        pushSegment(index + 2);
        index += 2;
        continue;
      }
      // A lone `&` backgrounds what came before it, and `&>file` falls out as a
      // segment that is nothing but a redirect, which is read the same way.
      pushSegment(index + 1);
      index += 1;
      continue;
    }

    if (char === '|') {
      const next = command[index + 1];
      const width = next === '|' ? 2 : 1;
      pushSegment(index + width);
      index += width;
      continue;
    }

    if (char === '>') {
      const fd = flushBeforeRedirect();
      const next = command[index + 1];
      // `>>` appends and destroys nothing; `>|` truncates past `noclobber`.
      if (next === '>') {
        pending = '>>';
        index += 2;
      } else if (next === '&') {
        pending = '>';
        pendingDup = true;
        pendingDupFile = fd === null || /^0*1$/.test(fd);
        index += 2;
      } else if (next === '|') {
        pending = '>';
        index += 2;
      } else {
        pending = '>';
        index += 1;
      }
      mark = index;
      continue;
    }

    if (char === '<') {
      flushBeforeRedirect();
      pending = '<';
      if (command[index + 1] === '<' && command[index + 2] !== '<') {
        pendingHereDoc = { stripTabs: command[index + 2] === '-' };
        index += pendingHereDoc.stripTabs ? 3 : 2;
      } else index += command[index + 1] === '<' ? 3 : 1;
      mark = index;
      continue;
    }

    open = true;
    text += char;
    operand += char;
    index += 1;
    mark = index;
  }

  pushSegment(command.length);
  return segments;
}

// ===========================================================================
// Recognising the verbs
// ===========================================================================

/** `FOO=bar rm …`: an assignment in front of the command is not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Wrappers that are not themselves the command, and are worth seeing through. */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'xargs']);

/** Prefix options that swallow the next word, so the command is not mistaken for their value. */
const PREFIX_VALUE_FLAGS = new Set(['-u', '-g', '-C', '--user', '--chdir', '-I']);
const XARGS_VALUE_FLAGS = new Set(['-n', '-P', '-L', '-a', '-s', '-d', '-E', '--max-args', '--max-procs', '--max-lines', '--arg-file', '--max-chars', '--delimiter']);

/** git's own options, before the subcommand. Those that take a separate value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** Destructive, with nothing mechanical to say about it beyond naming the paths. */
const OTHERS = new Set(['shred', 'dd', 'mkfs', 'wipefs']);

const baseName = (text: string): string => {
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut === -1 ? text : text.slice(cut + 1);
};

const isFlag = (word: Word): boolean => !word.quoted && word.text.length > 1 && word.text.startsWith('-');

/**
 * Split a word list into flags and operands, honouring `--`.
 *
 * Operands keep their quoting as a backslash escape: a quoted `*` is a
 * filename, an unquoted one is a pattern, and the difference is the whole
 * answer for `rm '*'`.
 */
function split(args: readonly Word[]): { readonly flags: readonly string[]; readonly operands: readonly string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  let literal = false;
  for (const word of args) {
    if (!literal && !word.quoted && word.text === '--') {
      literal = true;
      continue;
    }
    if (!literal && isFlag(word)) flags.push(word.text);
    else operands.push(operandOf(word));
  }
  return { flags, operands };
}

/** Quoting protects each character separately, including within a mixed word. */
const escapeLiteral = (text: string): string => text.replace(/[*?[\]{}\\$`~]/g, (char) => `\\${char}`);
const operandOf = (word: Word): string => word.operand;

/** Expansions needing a shell must never become a literal-path all-clear. */
const needsShell = (target: string): boolean => target.startsWith('~') || /(^|[^\\])(?:\\\\)*[$`]/.test(target);

/** Strip the command's wrappers and leading assignments; `null` when nothing is left. */
function invocationOf(segment: Segment): { readonly name: string; readonly args: readonly Word[] } | null {
  let words = segment.words;
  for (let guard = 0; guard < 8; guard += 1) {
    const head = words[0];
    if (head === undefined) return null;
    if (!head.quoted && ASSIGNMENT.test(head.text)) {
      words = words.slice(1);
      continue;
    }
    const name = baseName(head.text);
    if (!PREFIXES.has(name)) return { name, args: words.slice(1) };
    let at = 1;
    while (at < words.length) {
      const word = words[at];
      if (word === undefined || !isFlag(word)) break;
      at += PREFIX_VALUE_FLAGS.has(word.text) || (name === 'xargs' && XARGS_VALUE_FLAGS.has(word.text)) ? 2 : 1;
    }
    words = words.slice(at);
  }
  return null;
}

/**
 * The segments of a command that would destroy something.
 *
 * Pure: no disk, no processes, no shell. An unrecognised command yields
 * nothing, which is the common case and the one that keeps the card quiet.
 */
export function destructiveParts(command: string): readonly Destructive[] {
  const found: Destructive[] = [];
  for (const segment of tokenize(command)) {
    if (segment.unresolvedHereDoc === true) found.push({ kind: 'shell-expansion', text: segment.text, targets: [], flags: [] });
    const invocation = invocationOf(segment);
    if (invocation !== null) found.push(...classify(invocation.name, invocation.args, segment.text));
    for (const redirect of segment.redirects) {
      // `>>` appends, `<` reads, and `/dev/null` is not a file anybody loses.
      if (redirect.op !== '>') continue;
      const target = redirect.target.text;
      if (target.length === 0 || target.startsWith('/dev/')) continue;
      found.push({ kind: 'truncate-redirect', text: segment.text, targets: [operandOf(redirect.target)], flags: [] });
    }
  }
  return found;
}

/** Network destinations are read from arguments; the preview never contacts them. */
export function networkLines(command: string): readonly string[] {
  const lines: string[] = [];
  for (const segment of tokenize(command).slice(0, MAX_PARTS)) {
    const invocation = invocationOf(segment);
    if (invocation === null) continue;
    const { name, args } = invocation;
    if (!['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync'].includes(name) && !(name === 'git' && ['push', 'pull', 'fetch', 'clone'].includes(args[gitSubcommandAt(args)]?.text ?? ''))) continue;
    const subjects = shellSubjects(segment.text);
    const hosts = new Set([...subjects.hosts, ...subjects.urls.map((url) => hostOf(url)).filter((host): host is string => host !== null)]);
    lines.push(hosts.size === 0 ? `⚠ network: destination is resolved by ${name}` : `⚠ network: ${[...hosts].slice(0, MAX_LISTED).join(', ')}`);
  }
  return lines;
}

function classify(name: string, args: readonly Word[], text: string): readonly Destructive[] {
  switch (name) {
    case 'rm':
      return single(removeOf(args, text));
    case 'git':
      return single(gitOf(args, text));
    case 'chmod':
      return single(chmodOf(args, text));
    case 'find':
      return single(findOf(args, text));
    case 'psql':
    case 'mysql':
      return dropsOf(args, text);
    default:
      return OTHERS.has(name) ? single(otherOf(name, args, text)) : [];
  }
}

const single = (part: Destructive | null): readonly Destructive[] => (part === null ? [] : [part]);

/** `rm`, with or without flags. A delete of one named file is still a delete. */
function removeOf(args: readonly Word[], text: string): Destructive | null {
  const { flags, operands } = split(args);
  if (operands.length === 0) return null;
  return { kind: 'rm', text, targets: operands, flags };
}

function gitSubcommandAt(args: readonly Word[]): number {
  let at = 0;
  while (at < args.length) {
    const word = args[at];
    if (word === undefined || !isFlag(word)) break;
    at += GIT_VALUE_OPTIONS.has(word.text) ? 2 : 1;
  }
  return at;
}

function gitOf(args: readonly Word[], text: string): Destructive | null {
  const at = gitSubcommandAt(args);
  const subcommand = args[at]?.text;
  if (subcommand === undefined) return null;
  const rest = args.slice(at + 1);

  switch (subcommand) {
    case 'clean':
      return cleanOf(rest, text);
    case 'reset': {
      const { flags, operands } = split(rest);
      if (!flags.includes('--hard')) return null;
      return { kind: 'git-reset-hard', text, targets: operands, flags };
    }
    case 'push': {
      const { flags, operands } = split(rest);
      const forcing = flags.filter((flag) => flag === '-f' || flag === '--force' || flag.startsWith('--force-with-lease'));
      if (forcing.length === 0) return null;
      return { kind: 'git-push-force', text, targets: operands, flags };
    }
    case 'checkout': {
      const separator = rest.findIndex((word) => !word.quoted && word.text === '--');
      const { flags, operands } = split(rest);
      if (separator === -1) {
        if (flags.includes('-f') || flags.includes('--force')) return { kind: 'git-checkout-discard', text, targets: operands, flags };
        if (flags.some((flag) => ['-b', '-B', '--orphan'].includes(flag))) return null;
        // A branch name remains ambiguous; path-shaped operands can discard work.
        if (!operands.some((path) => path.includes('/') || path.includes('.') || isGlob(path))) return null;
      }
      const paths = separator === -1 ? operands : rest.slice(separator + 1).map(operandOf);
      if (paths.length === 0) return null;
      return { kind: 'git-checkout-discard', text, targets: paths, flags,
        overwritesIndex: separator !== -1 && split(rest.slice(0, separator)).operands.length > 0 };
    }
    case 'restore': {
      const { flags, operands } = split(rest);
      // `--staged` alone only unstages: the work tree keeps every byte.
      const staged = flags.includes('--staged') || flags.includes('-S');
      if (staged && !flags.includes('--worktree') && !flags.includes('-W')) return null;
      if (operands.length === 0) return null;
      return { kind: 'git-checkout-discard', text, targets: operands, flags, overwritesIndex: staged };
    }
    case 'branch': {
      const { flags, operands } = split(rest);
      // `-d` refuses to drop a branch whose commits are not reachable elsewhere,
      // so it destroys nothing git would not have kept. `-D` is the one to warn
      // about — and `--delete --force`, which is the same key with a long name.
      const forced = flags.includes('-D') || (flags.some((flag) => flag === '-d' || flag === '--delete') && flags.some((flag) => flag === '-f' || flag === '--force'));
      if (!forced || operands.length === 0) return null;
      return { kind: 'git-branch-delete', text, targets: operands, flags };
    }
    default:
      return null;
  }
}

/**
 * `git clean`, with `-e <pattern>` folded into `--exclude=<pattern>`.
 *
 * The fold is what lets the dry run be run from {@link Destructive.flags}
 * alone: an exclusion that arrived as two words would otherwise be a flag whose
 * value went missing, and a dry run without it lists paths that would survive.
 */
function cleanOf(args: readonly Word[], text: string): Destructive | null {
  const flags: string[] = [];
  const targets: string[] = [];
  let literal = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (word === undefined) continue;
    if (!literal && !word.quoted && word.text === '--') {
      literal = true;
      continue;
    }
    if (!literal && isFlag(word)) {
      if (word.text === '-e' || word.text === '--exclude') {
        const value = args[at + 1];
        if (value !== undefined) {
          flags.push(`--exclude=${value.text}`);
          at += 1;
        }
        continue;
      }
      flags.push(word.text);
      continue;
    }
    targets.push(operandOf(word));
  }
  if (flags.some((flag) => flag === '--dry-run' || /^-[A-Za-z]*n[A-Za-z]*$/.test(flag))) return null;
  return { kind: 'git-clean', text, targets, flags };
}

function chmodOf(args: readonly Word[], text: string): Destructive | null {
  const { flags, operands } = split(args);
  if (!flags.some((flag) => flag === '--recursive' || /^-[A-Za-z]*R/.test(flag))) return null;
  // The first operand is the mode, not a path.
  const targets = operands.slice(1);
  if (targets.length === 0) return null;
  return { kind: 'chmod-recursive', text, targets, flags };
}

/**
 * `find … -delete` and `find … -exec rm`.
 *
 * The paths are the words before the expression starts, which is the first word
 * beginning with `-`, `(` or `!` — find's own grammar, and the reason the
 * generic flag split is not used here.
 */
function findOf(args: readonly Word[], text: string): Destructive | null {
  const paths: string[] = [];
  let at = 0;
  while (at < args.length) {
    const word = args[at];
    if (word === undefined) break;
    if (!word.quoted && (word.text.startsWith('-') || word.text === '(' || word.text === '!')) break;
    paths.push(operandOf(word));
    at += 1;
  }
  const expression = args.slice(at).map((word) => word.text);
  const deleting = expression.includes('-delete');
  const running = expression.some((word, index) => (word === '-exec' || word === '-execdir') && baseName(expression[index + 1] ?? '') === 'rm');
  if (!deleting && !running) return null;
  return { kind: 'find-delete', text, targets: paths.length > 0 ? paths : ['.'], flags: deleting ? ['-delete'] : ['-exec', 'rm'] };
}

/** `DROP TABLE` / `DROP DATABASE` inside a `psql -c` or `mysql -e`. */
function dropsOf(args: readonly Word[], text: string): readonly Destructive[] {
  const statements: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (word === undefined) continue;
    const flag = word.text;
    if (flag === '-c' || flag === '-e' || flag === '--command' || flag === '--execute') {
      const value = args[at + 1];
      if (value !== undefined) {
        statements.push(value.text);
        at += 1;
      }
      continue;
    }
    if (flag.startsWith('--command=')) statements.push(flag.slice('--command='.length));
    else if (flag.startsWith('--execute=')) statements.push(flag.slice('--execute='.length));
  }

  const found: Destructive[] = [];
  for (const statement of statements) {
    const pattern = /\bdrop\s+(table|database)\b(?:\s+if\s+exists\b)?([^;]*)/gi;
    for (const match of statement.matchAll(pattern)) {
      const kindOfObject = (match[1] ?? 'table').toLowerCase();
      const names = objectNames(match[2] ?? '');
      if (names.length === 0) continue;
      found.push({ kind: 'drop', text, targets: names, flags: [kindOfObject] });
    }
  }
  return found;
}

/** The names after a `DROP TABLE`, comma-separated, unquoted, without `CASCADE`. */
function objectNames(tail: string): readonly string[] {
  const names: string[] = [];
  for (const piece of tail.split(',')) {
    const first = piece.trim().split(/\s+/)[0] ?? '';
    const name = first.replace(/^["`']|["`']$/g, '').trim();
    if (name.length === 0) continue;
    if (name.toLowerCase() === 'cascade' || name.toLowerCase() === 'restrict') continue;
    names.push(name);
  }
  return names;
}

function otherOf(name: string, args: readonly Word[], text: string): Destructive | null {
  const { flags, operands } = split(args);
  if (name === 'dd') {
    // dd's operands are `key=value`; only `of=` names something it overwrites.
    const targets = args.filter((word) => word.text.startsWith('of=')).map((word) => word.text.slice(3));
    if (targets.length === 0) return null;
    return { kind: 'other', text, targets, flags };
  }
  return { kind: 'other', text, targets: operands, flags };
}

// ===========================================================================
// The read-only guarantee
// ===========================================================================

/**
 * Every fixed argv this module is allowed to run.
 *
 * Exhaustive and exact: a preview builds one of these arrays literally, so an
 * exact-match check costs nothing and is the strongest form the rule can take.
 * The only argv not here is `git clean -n …`, whose pathspecs come from the
 * command being previewed and which {@link isDryRunClean} checks by shape.
 */
export const READ_ONLY_ARGV: readonly (readonly string[])[] = [
  ['status', '--porcelain'],
  ['log', '--oneline', '-1'],
  ['rev-parse', '--abbrev-ref', 'HEAD'],
  ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
  ['rev-list', '--count', 'HEAD..@{u}'],
  ['remote', '-v'],
  ['diff', '--name-only', '--relative'],
  ['diff', '--cached', '--name-only', '--relative'],
  ['branch', '--merged'],
];

/**
 * `git clean` is allowed only as a dry run.
 *
 * `-n` must come first, before anything a mistake could turn into a deletion,
 * and only three flags may follow it — `-f`, `-i` and everything else are
 * rejected rather than filtered, so a bug upstream in {@link cleanArgv} fails
 * loudly here instead of removing files.
 */
function isDryRunClean(args: readonly string[]): boolean {
  if (args[0] !== 'clean' || args[1] !== '-n') return false;
  let at = 2;
  while (at < args.length) {
    const arg = args[at];
    if (arg === undefined) return false;
    if (arg === '--') return true; // Everything past `--` is a pathspec, not an option.
    if (arg !== '-d' && arg !== '-x' && arg !== '-X' && !arg.startsWith('--exclude=')) return false;
    at += 1;
  }
  return true;
}

/**
 * Throws rather than returning false: this is a guarantee, not a preference.
 *
 * Exported so a test can pin it directly. The guarantee is the reason this
 * module is allowed to run anything at all, and a guarantee only reachable
 * through six layers of preview is one a refactor can quietly remove.
 */
export function assertReadOnly(file: string, args: readonly string[]): void {
  if (file !== 'git') throw new Error(`refused to run ${file}: only read-only git queries are allowed`);
  if (args[0] === 'clean') {
    if (!isDryRunClean(args)) throw new Error('refused: git clean is allowed only as a dry run');
    return;
  }
  const allowed = READ_ONLY_ARGV.some((candidate) => candidate.length === args.length && candidate.every((arg, index) => arg === args[index]));
  if (!allowed) throw new Error(`refused: git ${args.join(' ')} is not a known read-only query`);
}

// ===========================================================================
// Globs, expanded here rather than by a shell
// ===========================================================================

/** A budget shared by every walk of one preview call, so `**` cannot read the disk. */
interface Budget {
  readdirs: number;
  exhausted: boolean;
}

const isGlob = (text: string): boolean => {
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '\\') {
      at += 1;
      continue;
    }
    if (char === '*' || char === '?' || char === '[' || char === '{') return true;
  }
  return false;
};

/** Drop the backslashes a quoted operand carried, now that nothing will glob it. */
const unescape = (text: string): string => text.replace(/\\(.)/g, '$1');

/**
 * `{a,b}` into two patterns, recursively, bounded.
 *
 * Done before anything touches the disk, because each alternative is an
 * independent pattern and treating the braces as part of one regex makes `**`
 * inside a brace unreadable.
 */
function expandBraces(pattern: string): readonly string[] {
  const open = findUnescaped(pattern, '{', 0);
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  const pieces: string[] = [];
  let last = open + 1;
  for (let at = open; at < pattern.length; at += 1) {
    const char = pattern[at];
    if (char === '\\') {
      at += 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        pieces.push(pattern.slice(last, at));
        close = at;
        break;
      }
    } else if (char === ',' && depth === 1) {
      pieces.push(pattern.slice(last, at));
      last = at + 1;
    }
  }
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const piece of pieces) {
    for (const rest of expandBraces(`${head}${piece}${tail}`)) {
      if (out.length >= MAX_BRACES) return out;
      out.push(rest);
    }
  }
  return out;
}

function findUnescaped(text: string, char: string, from: number): number {
  for (let at = from; at < text.length; at += 1) {
    const here = text[at];
    if (here === '\\') {
      at += 1;
      continue;
    }
    if (here === char) return at;
  }
  return -1;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One path segment's pattern as a regular expression.
 *
 * `*` and `?` stop at a separator, which is what makes `src/*` one level deep
 * and `**` the only way down. A malformed character class compiles to nothing
 * useful, so it falls back to matching the pattern literally rather than
 * throwing out of a preview.
 */
function segmentMatcher(pattern: string): (name: string) => boolean {
  let source = '';
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at] ?? '';
    if (char === '\\') {
      const next = pattern[at + 1];
      source += next === undefined ? '\\\\' : escapeRegExp(next);
      at += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '[') {
      const close = pattern.indexOf(']', at + 1);
      if (close === -1) {
        source += '\\[';
        continue;
      }
      const body = pattern.slice(at + 1, close);
      source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      at = close;
      continue;
    }
    source += escapeRegExp(char);
  }
  try {
    const expression = new RegExp(`^${source}$`);
    return (name) => expression.test(name);
  } catch {
    const literal = unescape(pattern);
    return (name) => name === literal;
  }
}

async function entriesOf(directory: string, deps: BlastRadiusDeps, budget: Budget): Promise<readonly DirEntry[]> {
  if (budget.readdirs <= 0) {
    budget.exhausted = true;
    return [];
  }
  budget.readdirs -= 1;
  try {
    const entries = await deps.readdir(directory);
    return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    // Unreadable, gone, or not a directory: it contributes nothing.
    return [];
  }
}

/**
 * Every path a pattern matches, found by reading directories.
 *
 * A leading dot is matched only by a pattern that has one, which is the rule
 * every shell uses and the reason `rm *` does not claim it will take `.git`.
 * Symlinks are never descended: `directory` comes from a `lstat`-shaped entry,
 * so a link to a tree is a leaf here exactly as it is to `rm`.
 */
async function expandGlob(pattern: string, cwd: string, deps: BlastRadiusDeps, budget: Budget): Promise<readonly string[]> {
  const found = new Set<string>();

  for (const alternative of expandBraces(pattern)) {
    const absolute = isAbsolute(alternative);
    const parts = alternative.split('/').filter((part) => part.length > 0 && part !== '.');
    const base = absolute ? sep : cwd;

    const visit = async (directory: string, index: number, depth: number): Promise<void> => {
      if (found.size >= MAX_MATCHES || depth > MAX_DEPTH) return;
      const part = parts[index];
      if (part === undefined) {
        found.add(directory);
        return;
      }
      if (part === '**') {
        // `**` stands for any run of segments, the empty one included, so the
        // rest of the pattern is tried here first and then inside every
        // directory below. A trailing `**` matches the files too, which is why
        // the leaves are added rather than only descended into.
        await visit(directory, index + 1, depth);
        const trailing = index === parts.length - 1;
        for (const entry of await entriesOf(directory, deps, budget)) {
          if (found.size >= MAX_MATCHES) return;
          if (entry.name.startsWith('.')) continue;
          if (entry.directory) await visit(join(directory, entry.name), index, depth + 1);
          else if (trailing) found.add(join(directory, entry.name));
        }
        return;
      }
      if (!isGlob(part)) {
        await visit(join(directory, unescape(part)), index + 1, depth + 1);
        return;
      }
      const matches = segmentMatcher(part);
      const hidden = part.startsWith('.');
      const last = index === parts.length - 1;
      for (const entry of await entriesOf(directory, deps, budget)) {
        if (!hidden && entry.name.startsWith('.')) continue;
        if (!matches(entry.name)) continue;
        // A pattern with more segments to go can only continue through a directory.
        if (!last && !entry.directory) continue;
        await visit(join(directory, entry.name), index + 1, depth + 1);
      }
    };

    await visit(base, 0, 0);
  }

  return [...found].sort();
}

/** Everything under a directory, counted, stopping at {@link MAX_ENTRIES}. */
async function countUnder(root: string, deps: BlastRadiusDeps, budget: Budget): Promise<{ readonly files: number; readonly entries: number; readonly truncated: boolean }> {
  let files = 0;
  let entries = 0;
  const queue: { readonly directory: string; readonly depth: number }[] = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (next.depth > MAX_DEPTH) return { files, entries, truncated: true };
    for (const entry of await entriesOf(next.directory, deps, budget)) {
      entries += 1;
      if (entries > MAX_ENTRIES) return { files, entries: MAX_ENTRIES, truncated: true };
      if (entry.directory) queue.push({ directory: join(next.directory, entry.name), depth: next.depth + 1 });
      else files += 1;
    }
  }
  return { files, entries, truncated: budget.exhausted };
}

// ===========================================================================
// The previews
// ===========================================================================

/**
 * What each destructive part would actually do, read off the disk.
 *
 * In parallel, because the card is up and a person is waiting on it, and the
 * slowest part of any of these is one `git` process with a five second ceiling.
 * The order is the order of the command either way.
 *
 * Shorter than `parts` when a part turns out to destroy nothing: a `>` onto a
 * file that does not exist yet, or onto one that is already empty, creates
 * rather than destroys, and a warning about it is a warning people learn to
 * ignore.
 */
export async function previewBlastRadius(parts: readonly Destructive[], cwd: string, deps: Partial<BlastRadiusDeps> = {}): Promise<readonly Preview[]> {
  const full: BlastRadiusDeps = { ...nodeBlastDeps, ...deps };
  const budget: Budget = { readdirs: MAX_READDIRS, exhausted: false };
  const previews = await Promise.all(parts.slice(0, MAX_PARTS).map((part) => previewOne(part, cwd, full, budget)));
  return previews.filter((preview): preview is Preview => preview !== null);
}

async function previewOne(part: Destructive, cwd: string, deps: BlastRadiusDeps, budget: Budget): Promise<Preview | null> {
  try {
    switch (part.kind) {
      case 'rm':
        return await previewRemove(part, cwd, deps, budget);
      case 'git-clean':
        return await previewClean(part, cwd, deps);
      case 'git-reset-hard':
        return await previewResetHard(part, cwd, deps);
      case 'git-push-force':
        return await previewPushForce(part, cwd, deps);
      case 'git-checkout-discard':
        return await previewCheckoutDiscard(part, cwd, deps);
      case 'git-branch-delete':
        return await previewBranchDelete(part, cwd, deps);
      case 'drop':
        return previewDrop(part);
      case 'shell-expansion':
        return { kind: part.kind, summary: 'cannot tell: command substitution in a here-document needs the shell', lines: [] };
      case 'truncate-redirect':
        return await previewTruncate(part, cwd, deps, budget);
      case 'chmod-recursive':
      case 'find-delete':
        return await previewUnder(part, cwd, deps, budget);
      case 'other':
        return await previewOther(part, cwd, deps, budget);
    }
  } catch (error) {
    return { kind: part.kind, summary: `could not preview: ${reasonOf(error)}`, lines: [] };
  }
}

/** A `git` that has been through {@link assertReadOnly}, bound to one directory. */
const gitIn =
  (cwd: string, deps: BlastRadiusDeps) =>
  async (args: readonly string[]): Promise<string> => {
    assertReadOnly('git', args);
    return deps.execFile('git', args, { cwd, timeout: deps.timeoutMs });
  };

/** A query whose failure costs a line of detail rather than the whole preview. */
const soft = async (query: Promise<string>): Promise<string> => {
  try {
    return await query;
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------

async function previewRemove(part: Destructive, cwd: string, deps: BlastRadiusDeps, budget: Budget): Promise<Preview> {
  // `~/work` and `$BUILD` mean nothing without the shell, and resolving them
  // literally finds no file — which would read as "nothing would be deleted"
  // about a command that deletes a home directory. They are named instead.
  const unresolved = part.targets.filter(needsShell);
  const candidates = new Set<string>();
  for (const target of part.targets) {
    if (unresolved.includes(target)) continue;
    if (isGlob(target)) for (const match of await expandGlob(target, cwd, deps, budget)) candidates.add(match);
    else candidates.add(resolve(cwd, unescape(target)));
  }

  let files = 0;
  let directories = 0;
  let inside = 0;
  let truncated = false;
  const listed: string[] = [];

  /**
   * A path already inside a directory being removed, and so not a second thing
   * removed. `rm -rf build build/a.js` deletes one tree, and `build/**` names
   * every file under it; counting those again would report a blast several
   * times its own size. Sorting puts a directory in front of its own children,
   * so one variable is enough to recognise them.
   */
  let enclosing: string | null = null;

  for (const path of [...candidates].sort()) {
    if (enclosing !== null && path.startsWith(enclosing)) continue;
    const info = await statOf(path, deps);
    // A path that is not there cannot be deleted, so it is not part of the blast.
    if (info === null) continue;
    if (info.directory) {
      enclosing = path.endsWith(sep) ? path : `${path}${sep}`;
      directories += 1;
      const under = await countUnder(path, deps, budget);
      inside += under.files;
      truncated = truncated || under.truncated;
      listed.push(`${labelOf(path, cwd)}/`);
    } else {
      files += 1;
      listed.push(labelOf(path, cwd));
    }
  }

  for (const target of unresolved) listed.push(`${target} — needs the shell to expand`);

  const total = files + directories;
  if (total === 0) {
    if (unresolved.length === 0) return { kind: part.kind, summary: 'nothing matching is there, so nothing would be deleted', lines: [], count: 0 };
    const needs = unresolved.length === 1 ? 'needs' : 'need';
    return { kind: part.kind, summary: `cannot tell: ${plural(unresolved.length, 'path')} ${needs} the shell to expand`, lines: listed.slice(0, MAX_LISTED), count: listed.length };
  }

  const pieces: string[] = [];
  if (files > 0) pieces.push(plural(files, 'file'));
  if (directories > 0) pieces.push(plural(directories, 'directory', 'directories'));
  const within = directories > 0 ? ` (${truncated ? `${String(MAX_ENTRIES)}+ files` : plural(inside, 'file')} inside)` : '';
  const more = unresolved.length > 0 ? `, and ${plural(unresolved.length, 'path')} the shell would have to expand` : '';
  return { kind: part.kind, summary: `${pieces.join(' and ')}${within}${more}`, lines: listed.slice(0, MAX_LISTED), count: listed.length, truncated };
}

/**
 * `git clean`, run with `-n` and nothing else that could remove a file.
 *
 * `-f` and `-i` are dropped rather than forwarded. `-n` does win over `-f` in
 * git, but a preview that relies on the precedence rules of the command it is
 * previewing is one refactor away from being the deletion.
 */
async function previewClean(part: Destructive, cwd: string, deps: BlastRadiusDeps): Promise<Preview> {
  const stdout = await gitIn(cwd, deps)(cleanArgv(part));
  const paths = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^Would (?:remove|skip repository|not remove) /, ''));
  if (paths.length === 0) return { kind: part.kind, summary: 'git clean would remove nothing', lines: [], count: 0 };
  return { kind: part.kind, summary: `git clean would remove ${plural(paths.length, 'path')}`, lines: paths.slice(0, MAX_LISTED), count: paths.length };
}

/** The dry-run argv: `-n` first, the flags that only narrow the search, then the pathspecs. */
export function cleanArgv(part: Destructive): readonly string[] {
  const kept: string[] = [];
  for (const flag of part.flags) {
    if (flag.startsWith('--exclude=')) {
      kept.push(flag);
      continue;
    }
    if (flag === '--directory') kept.push('-d');
    // A cluster like `-dfx` is read letter by letter, and only three letters survive.
    if (!/^-[A-Za-z]+$/.test(flag)) continue;
    for (const letter of flag.slice(1)) {
      if ((letter === 'd' || letter === 'x' || letter === 'X') && !kept.includes(`-${letter}`)) kept.push(`-${letter}`);
    }
  }
  return ['clean', '-n', ...kept, ...(part.targets.length > 0 ? ['--', ...part.targets.map(unescape)] : [])];
}

async function previewResetHard(part: Destructive, cwd: string, deps: BlastRadiusDeps): Promise<Preview> {
  const git = gitIn(cwd, deps);
  const status = await git(['status', '--porcelain']);
  const head = (await soft(git(['log', '--oneline', '-1']))).trim().split('\n')[0] ?? '';
  const changes = status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !line.startsWith('??'));
  const target = part.targets[0];
  const back = head.length > 0 ? `, back to ${target === undefined ? head : `${target} — currently ${head}`}` : '';
  const tracked = changes.length === 0 ? `no tracked changes reported${back}` : `${plural(changes.length, 'uncommitted change')} would be lost${back}`;
  const summary = status.split('\n').some((line) => line.startsWith('??')) ? `${tracked}; untracked paths may be overwritten if they obstruct the reset` : tracked;
  const lines = changes.slice(0, MAX_LISTED);
  return { kind: part.kind, summary, lines, count: changes.length };
}

async function previewPushForce(part: Destructive, cwd: string, deps: BlastRadiusDeps): Promise<Preview> {
  const git = gitIn(cwd, deps);
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const remoteLine = ((await soft(git(['remote', '-v']))).split('\n')[0]?.trim() ?? '').replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/]+@/gi, '$1');
  // The remote the command names beats the first one configured, which is only a guess.
  const named = part.targets.find((target) => !target.startsWith('-'));
  const remote = named ?? remoteLine.split(/\s+/)[0] ?? 'the remote';
  const upstream = (await soft(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))).trim();
  const where = `force-push ${branch.length > 0 ? branch : 'HEAD'} to ${remote}`;
  const lines = remoteLine.length > 0 ? [remoteLine] : [];

  if (upstream.length === 0) {
    return { kind: part.kind, summary: `${where}: no upstream is set, so what is on the remote cannot be read`, lines };
  }
  const ahead = Number.parseInt((await soft(git(['rev-list', '--count', 'HEAD..@{u}']))).trim(), 10);
  if (!Number.isFinite(ahead)) return { kind: part.kind, summary: `${where}: could not count what is on ${upstream}`, lines: [`upstream: ${upstream}`, ...lines] };
  const verdict = ahead === 0 ? `${upstream} has nothing HEAD does not` : `would discard ${plural(ahead, 'remote commit')}`;
  return { kind: part.kind, summary: `${where}: ${verdict}`, lines: [`upstream: ${upstream}`, ...lines] };
}

async function previewCheckoutDiscard(part: Destructive, cwd: string, deps: BlastRadiusDeps): Promise<Preview> {
  if (part.flags.includes('-f') || part.flags.includes('--force')) {
    return { kind: part.kind, summary: 'forced checkout may discard local changes, including files obstructing the checkout', lines: [] };
  }
  if (part.targets.some((target) => needsShell(target) || isGlob(target))) {
    return { kind: part.kind, summary: 'cannot tell: checkout pathspecs may discard local changes', lines: [...part.targets].slice(0, MAX_LISTED) };
  }
  const git = gitIn(cwd, deps);
  const unstaged = await git(['diff', '--name-only', '--relative']);
  const staged = part.overwritesIndex === true ? await git(['diff', '--cached', '--name-only', '--relative']) : '';
  const changed = `${unstaged}\n${staged}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lines: string[] = [];
  let dirty = 0;
  for (const target of part.targets) {
    const path = unescape(target).replace(/^\.\//, '').replace(/\/$/, '');
    const touched = changed.some((file) => file === path || file.startsWith(`${path}/`) || path === '.');
    if (touched) dirty += 1;
    lines.push(`${target} — ${touched ? 'local changes would be lost' : 'no local changes'}`);
  }
  const summary = dirty === 0 ? 'none of these paths has local changes to lose' : `${String(dirty)} of ${plural(part.targets.length, 'path')} would lose local changes`;
  return { kind: part.kind, summary, lines: lines.slice(0, MAX_LISTED), count: lines.length };
}

async function previewBranchDelete(part: Destructive, cwd: string, deps: BlastRadiusDeps): Promise<Preview> {
  const merged = new Set(
    (await gitIn(cwd, deps)(['branch', '--merged']))
      .split('\n')
      .map((line) => line.replace(/^[*+]?\s*/, '').trim())
      // `(HEAD detached at …)` is a state, not a branch anybody named.
      .filter((line) => line.length > 0 && !line.startsWith('(')),
  );
  const lines: string[] = [];
  let unmerged = 0;
  for (const target of part.targets) {
    const name = unescape(target);
    const safe = merged.has(name);
    if (!safe) unmerged += 1;
    lines.push(`${name} — ${safe ? 'merged, nothing would become unreachable' : 'not merged into HEAD; its commits would become unreachable'}`);
  }
  const summary =
    unmerged === 0
      ? `${part.targets.length === 1 ? 'that branch is' : 'those branches are'} already merged`
      : `${String(unmerged)} of ${plural(part.targets.length, 'branch', 'branches')} not merged`;
  return { kind: part.kind, summary, lines: lines.slice(0, MAX_LISTED), count: lines.length };
}

function previewDrop(part: Destructive): Preview {
  const noun = part.flags[0] ?? 'table';
  return { kind: part.kind, summary: `would drop ${plural(part.targets.length, noun)}`, lines: [...part.targets].slice(0, MAX_LISTED), count: part.targets.length };
}

async function previewTruncate(part: Destructive, cwd: string, deps: BlastRadiusDeps, budget: Budget): Promise<Preview | null> {
  const target = part.targets[0];
  if (target === undefined) return null;
  if (needsShell(target)) return { kind: part.kind, summary: 'cannot tell: redirect target needs the shell to expand', lines: [] };
  const matches = isGlob(target) ? await expandGlob(target, cwd, deps, budget) : [resolve(cwd, unescape(target))];
  if (matches.length !== 1 || budget.exhausted) return { kind: part.kind, summary: 'cannot tell: redirect glob does not resolve to exactly one path', lines: [] };
  const path = matches[0];
  if (path === undefined) return null;
  const info = await statOf(path, deps);
  // Nothing there, a directory the redirect would fail on, or a file that is
  // already empty: in none of those cases does anything get thrown away.
  if (info === null || info.directory || info.size === 0) return null;
  return { kind: part.kind, summary: `${labelOf(path, cwd)} would be emptied, throwing away ${bytes(info.size)}`, lines: [] };
}

async function previewUnder(part: Destructive, cwd: string, deps: BlastRadiusDeps, budget: Budget): Promise<Preview> {
  const paths = await expandedPaths(part, cwd, deps, budget);
  if (paths === null) return { kind: part.kind, summary: 'cannot tell: destructive targets could not be fully expanded', lines: [] };
  const lines: string[] = [];
  let total = 0;
  let truncated = false;
  for (const path of paths) {
    const target = labelOf(path, cwd);
    const info = await statOf(path, deps);
    if (info === null) {
      lines.push(`${target} — not there`);
      continue;
    }
    if (!info.directory) {
      total += 1;
      lines.push(`${target} — one file`);
      continue;
    }
    const under = await countUnder(path, deps, budget);
    total += under.entries;
    truncated = truncated || under.truncated;
    lines.push(`${target} — ${under.truncated ? `${String(MAX_ENTRIES)}+` : String(under.entries)} entries`);
  }
  const count = truncated ? `${String(MAX_ENTRIES)}+ entries` : plural(total, 'entry', 'entries');
  const summary = part.kind === 'chmod-recursive' ? `chmod -R would change the mode of ${count}` : `find would walk ${count} and delete every match`;
  return { kind: part.kind, summary, lines: lines.slice(0, MAX_LISTED), count: lines.length, truncated };
}

async function previewOther(part: Destructive, cwd: string, deps: BlastRadiusDeps, budget: Budget): Promise<Preview> {
  const paths = await expandedPaths(part, cwd, deps, budget);
  if (paths === null) return { kind: part.kind, summary: 'cannot tell: destructive targets could not be fully expanded', lines: [] };
  const lines: string[] = [];
  for (const path of paths.slice(0, MAX_LISTED)) {
    const target = labelOf(path, cwd);
    const info = await statOf(path, deps);
    if (info === null) lines.push(`${target} — not there`);
    else if (info.directory) lines.push(`${target} — a directory`);
    else lines.push(`${target} — ${bytes(info.size)}`);
  }
  const summary = part.targets.length === 0 ? 'destructive, and there is no dry run for it' : `no dry run for this one; it would overwrite ${plural(paths.length, 'path')}`;
  return { kind: part.kind, summary, lines, count: paths.length };
}

async function expandedPaths(part: Destructive, cwd: string, deps: BlastRadiusDeps, budget: Budget): Promise<readonly string[] | null> {
  if (part.targets.some(needsShell)) return null;
  const paths = new Set<string>();
  for (const target of part.targets) {
    if (isGlob(target)) for (const path of await expandGlob(target, cwd, deps, budget)) paths.add(path);
    else paths.add(resolve(cwd, unescape(target)));
  }
  return budget.exhausted ? null : [...paths];
}

const statOf = async (path: string, deps: BlastRadiusDeps): Promise<FileInfo | null> => {
  try {
    return await deps.stat(path);
  } catch {
    return null;
  }
};

// ===========================================================================
// Drawing it
// ===========================================================================

/**
 * The block the permission card puts under the command.
 *
 * One `⚠` line per part, which is the summary and the thing that has to be
 * readable at a glance, then its detail indented under it. The indent is what
 * makes two parts of one command line legible as two answers rather than one
 * list, and the `… +n more` is there because a truthful count matters more than
 * the twenty-first path.
 */
export function blastRadiusLines(previews: readonly Preview[], columns: number = Number.POSITIVE_INFINITY): readonly string[] {
  const width = Number.isFinite(columns) ? Math.max(8, Math.floor(columns)) : Number.POSITIVE_INFINITY;
  const out: string[] = [];
  for (const preview of previews) {
    out.push(clip(`⚠ ${preview.summary}`, width));
    for (const line of preview.lines) out.push(clip(`  ${line}`, width));
    const total = preview.count;
    if (total !== undefined && total > preview.lines.length) out.push(clip(`  … +${String(total - preview.lines.length)} more`, width));
  }
  return out;
}

const clip = (text: string, width: number): string => {
  if (text.length <= width) return text;
  if (width <= 1) return '…';
  return `${text.slice(0, width - 1)}…`;
};

// ---------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/** Decimal units, as `ls -h` and every file manager say them. */
function bytes(size: number): string {
  if (size < 1000) return `${String(size)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = size / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'kB'}`;
}

const labelOf = (path: string, cwd: string): string => {
  const within = relative(cwd, path);
  if (within.length === 0) return '.';
  if (within.startsWith('..') || isAbsolute(within)) return path;
  return within.split(sep).join('/');
};

/** One line, short enough for a card, whatever the failure was. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const first = text.split('\n')[0]?.trim() ?? '';
  return first.length > 120 ? `${first.slice(0, 119)}…` : first.length > 0 ? first : 'unknown error';
}

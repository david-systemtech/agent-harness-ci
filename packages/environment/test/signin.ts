import type { AccountRecord } from "@agent-harness/contracts";
import { signInUnavailable, type SignInDirectorFactory, type SignInOutcome, type SignInPort } from "../src/accounts/signin-seam.js";
import type { SignInChild, SignInSpawn } from "../src/accounts/signin-process.js";
import { WAIT_MS } from "./wire-client.js";

/**
 * A scripted sign-in director (for the tests of #134): it says a sign-in
 * starts, records each account it is handed, and lets the test say when the
 * provider has signed the directory in (`finish`), which the account store
 * answers with the status read and the identity rule. What the directory
 * is signed in as is the fake adapter's status probe. The sign-in methods
 * it answers as the unavailable preset does.
 */
export interface ScriptedSignIn {
  readonly factory: SignInDirectorFactory;
  /** The accounts handed to the director, in order. */
  readonly started: readonly AccountRecord[];
  /** The provider signed `accountId`'s directory in: the store's answer. */
  finish(accountId: string): Promise<SignInOutcome>;
}

export const scriptedSignIn = (): ScriptedSignIn => {
  const started: AccountRecord[] = [];
  let port: SignInPort | undefined;
  return {
    factory: (given) => {
      port = given;
      return { ...signInUnavailable(given), ready: () => ({ started: true, message: null }), start: (account) => void started.push(account) };
    },
    started,
    finish: (accountId) => {
      if (port === undefined) throw new Error("The scripted sign-in was never handed to an environment.");
      return port.finished(accountId);
    },
  };
};

/**
 * A fake provider CLI for the sign-in director's tests (#135), through its
 * `spawn` seam: every process is recorded with its command, argv,
 * environment and working directory; a probe (`--help`) answers on its own,
 * as `probe` says; a login waits for the test to make it print, read what
 * was written to it, and exit. A kill ends it as a signal would.
 */
export interface FakeSignInProcess extends SignInChild {
  readonly command: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** What was written to its stdin, in order. */
  readonly written: string[];
  /** Whether `kill` was called. */
  readonly killed: boolean;
  /** Whether it has exited. */
  readonly exited: boolean;
  /** Prints `text` on stdout. */
  print(text: string): void;
  /** Prints `text` on stderr. */
  printError(text: string): void;
  /** Ends it with `code`; a null code with `error` is a process that could not run. */
  exit(code: number | null, error?: string | null): void;
}

/** What a probe of an executable answers. */
export interface ProbeAnswer {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr?: string;
}

/** The bundled 2.1.281's answer to `auth login --help`, verbatim. */
export const LOGIN_HELP = `Usage: claude auth login [options]

Sign in to your Anthropic account

Options:
  --claudeai       Use Claude subscription (default)
  --console        Use Anthropic Console (API usage billing) instead of Claude
                   subscription
  --email <email>  Pre-populate email address on the login page
  -h, --help       Display help for command
  --sso            Force SSO login flow
`;

/**
 * A made-up binary without `auth login`, not a recording: shaped from what
 * the bundled 2.1.281 answers to `auth <a command it lacks> --help` (its
 * parent's usage, exit 0) with the login line taken out.
 */
export const AUTH_HELP_WITHOUT_LOGIN = `Usage: claude auth [options] [command]

Manage authentication

Options:
  -h, --help        Display help for command

Commands:
  help [command]    display help for command
  status [options]  Show authentication status
`;

/** A verification URL shaped as the bundled 2.1.281 prints it. */
export const VERIFICATION_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=2aJo39dOa0h2WlTI5WjVmt1CvcVfP6wAT3jaonHxp_Y&code_challenge_method=S256&state=I90FU5eUqLNK";

/** What `auth login` prints before it waits for the code, verbatim from the bundled 2.1.281 (the prompt has no line break). */
export const loginBanner = (url: string = VERIFICATION_URL): string =>
  `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `;

export interface FakeSignInSpawner {
  readonly spawn: SignInSpawn;
  /** Every process started, probes included, in order. */
  readonly spawned: readonly FakeSignInProcess[];
  /** The probes started, in order. */
  probes(): FakeSignInProcess[];
  /** The logins started, in order. */
  logins(): FakeSignInProcess[];
  /** How a probe of `command` answers; preset: a binary that runs `auth login`. */
  probe: (command: string) => ProbeAnswer;
  /** Makes the next login's spawn throw this message. */
  failNext: string | undefined;
  /** Resolves with the next login not yet taken, now or when it starts; rejects after `WAIT_MS`. */
  nextLogin(): Promise<FakeSignInProcess>;
}

export const fakeSignInSpawner = (): FakeSignInSpawner => {
  const spawned: FakeSignInProcess[] = [];
  let taken = 0;
  const waiters: (() => void)[] = [];

  const make = (command: string, argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string): FakeSignInProcess => {
    const stdout: ((chunk: string) => void)[] = [];
    const stderr: ((chunk: string) => void)[] = [];
    const exits: ((code: number | null, error: string | null) => void)[] = [];
    const state = { killed: false, exited: false };
    const child: FakeSignInProcess = {
      command,
      argv: [...argv],
      env: { ...env },
      cwd,
      written: [],
      get killed() {
        return state.killed;
      },
      get exited() {
        return state.exited;
      },
      write: (text) => void child.written.push(text),
      kill: () => {
        if (state.exited) return;
        state.killed = true;
        // As a process does: the signal ends it a moment later.
        queueMicrotask(() => child.exit(null, "It was ended by SIGTERM."));
      },
      onStdout: (listener) => void stdout.push(listener),
      onStderr: (listener) => void stderr.push(listener),
      onExit: (listener) => void exits.push(listener),
      print: (text) => {
        for (const listener of stdout) listener(text);
      },
      printError: (text) => {
        for (const listener of stderr) listener(text);
      },
      exit: (code, error = null) => {
        if (state.exited) return;
        state.exited = true;
        for (const listener of exits) listener(code, error);
      },
    };
    return child;
  };

  const isProbe = (argv: readonly string[]): boolean => argv.includes("--help");

  const spawner: FakeSignInSpawner = {
    spawned,
    probe: () => ({ code: 0, stdout: LOGIN_HELP }),
    failNext: undefined,
    probes: () => spawned.filter((child) => isProbe(child.argv)),
    logins: () => spawned.filter((child) => !isProbe(child.argv)),
    spawn: (command, argv, options) => {
      if (!isProbe(argv) && spawner.failNext !== undefined) {
        const message = spawner.failNext;
        spawner.failNext = undefined;
        throw new Error(message);
      }
      const child = make(command, argv, options.env, options.cwd);
      spawned.push(child);
      if (isProbe(argv)) {
        const answer = spawner.probe(command);
        // After the caller has attached its listeners, as a real process answers.
        setImmediate(() => {
          child.print(answer.stdout);
          if (answer.stderr !== undefined) child.printError(answer.stderr);
          child.exit(answer.code);
        });
      } else for (const wake of waiters.splice(0)) wake();
      return child;
    },
    async nextLogin() {
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const logins = spawner.logins();
        if (logins.length > taken) return logins[taken++] as FakeSignInProcess;
        if (Date.now() > deadline) throw new Error(`No sign-in process started within ${WAIT_MS} ms.`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 10);
        });
      }
    },
  };
  return spawner;
};

/** A spawn no test should reach: the helper's preset, so no test ever starts the real binary. */
export const refusingSpawn: SignInSpawn = (command) => {
  throw new Error(`A test started ${command} without scripting the sign-in's processes (fakeSignInSpawner).`);
};

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountRecord, AmbientProbe, SignIn } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { fakeAdapter, signedInAs } from "../../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../../test/helper.js";
import { fakeSignInSpawner } from "../../../test/signin.js";
import {
  CODEX_LOGIN_ARGV,
  CODEX_MODELS,
  ambientCodexHome,
  codexFallback,
  codexSignInEnvironment,
  codexUserCode,
  codexVerificationUrl,
  createCodexAccountProvider,
  readCodexStatus,
  runsCodexLogin,
} from "./account.js";

const { onCleanup, tempDir } = useCleanups();

const NOW = Date.parse("2026-10-14T12:00:00Z");

const jwt = (claims: Record<string, unknown>): string =>
  [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

const ID_TOKEN = jwt({ email: "david@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acc-1" } });

/** A Codex home as `codex login` leaves it: auth.json with a ChatGPT login, config.toml, a session. */
const codexHome = (auth: unknown = { OPENAI_API_KEY: null, tokens: { id_token: ID_TOKEN, access_token: jwt({ exp: NOW / 1000 - 60 }), refresh_token: "rt-1", account_id: "acc-1" }, last_refresh: "2026-10-13T10:00:00Z" }): string => {
  const directory = join(tempDir(), randomUUID(), ".codex");
  mkdirSync(join(directory, "sessions"), { recursive: true });
  if (auth !== null) writeFileSync(join(directory, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth), { mode: 0o600 });
  writeFileSync(join(directory, "config.toml"), 'model = "gpt-5-codex"\n');
  return directory;
};

describe("a Codex home's status, read from auth.json", () => {
  it("is signed in for a ChatGPT login, naming its email and plan, though its access token has lapsed while a refresh token remains", async () => {
    expect(await readCodexStatus(codexHome(), () => NOW)).toEqual({ signedIn: true, authMethod: "ChatGPT", email: "david@example.com", orgName: null, subscriptionType: "pro", error: null });
  });

  it("is expired when the access token has lapsed and no refresh token is left", async () => {
    const home = codexHome({ tokens: { id_token: ID_TOKEN, access_token: jwt({ exp: NOW / 1000 - 1 }) } });
    expect(await readCodexStatus(home, () => NOW)).toMatchObject({ signedIn: false, expired: true, email: "david@example.com" });
  });

  it("is signed out with no auth.json or no login in it, signed in by an API key, and unreadable when it is not JSON", async () => {
    expect(await readCodexStatus(codexHome(null))).toMatchObject({ signedIn: false, error: null });
    expect(await readCodexStatus(codexHome({ OPENAI_API_KEY: null, tokens: null }))).toMatchObject({ signedIn: false, error: null });
    expect(await readCodexStatus(codexHome({ OPENAI_API_KEY: "sk-test" }))).toMatchObject({ signedIn: true, authMethod: "API key", email: null });
    expect((await readCodexStatus(codexHome("{not json"))).error).toContain("is not JSON");
  });

  it("finds the machine's own home at CODEX_HOME, else .codex in the home directory", () => {
    expect(ambientCodexHome({ CODEX_HOME: "/srv/codex", HOME: "/home/david" })).toBe("/srv/codex");
    expect(ambientCodexHome({ CODEX_HOME: "", HOME: "/home/david" })).toBe(join("/home/david", ".codex"));
    expect(ambientCodexHome({ USERPROFILE: "C:\\Users\\david" })).toBe(join("C:\\Users\\david", ".codex"));
  });

  it("observes the directory's identity from the id token without running anything", async () => {
    const provider = createCodexAccountProvider({ hostEnv: { HOME: tempDir() } });
    expect(await provider.observeIdentity(codexHome())).toEqual({ provider: "codex", email: "david@example.com", organisation: null });
    expect(await provider.observeIdentity(codexHome(null))).toBeNull();
    expect((await provider.models({ id: "a", directory: null })).models.map((model) => model.id)).toContain("gpt-5-codex");
  });
});

const DEVICE_OUTPUT =
  "\nWelcome to Codex [v0.46.0]\n\u001b[90mOpenAI's command-line coding agent\u001b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-EFGHJ\u001b[0m\n\n";

describe("the Codex models (#2224)", () => {
  it("are the fixed list, marked not live, since the codex CLI has no listing command; the provider answers it without running anything", async () => {
    expect(CODEX_MODELS.live).toBe(false);
    expect(CODEX_MODELS.models.map((model) => model.id)).toEqual(["gpt-5-codex", "gpt-5"]);
    const provider = createCodexAccountProvider({ hostEnv: { CODEX_HOME: "/nowhere" } });
    expect(await provider.models({ id: "codex-1", directory: { path: "/nowhere" } } as never)).toBe(CODEX_MODELS);
  });
});

describe("the Codex sign-in program", () => {
  it("reads the device page and its one-time code through the colour sequences", () => {
    expect(codexVerificationUrl(DEVICE_OUTPUT)).toBe("https://auth.openai.com/codex/device");
    expect(codexUserCode(DEVICE_OUTPUT)).toBe("ABCD-EFGHJ");
    expect(codexVerificationUrl("Follow these steps")).toBeNull();
    expect(codexUserCode("1. Open this link https://auth.openai.com/codex/device\n")).toBeNull();
  });

  it("runs codex login --device-auth only where the help offers it, in the account's home, without an API key", () => {
    expect(CODEX_LOGIN_ARGV).toEqual(["login", "--device-auth"]);
    expect(runsCodexLogin({ code: 0, stdout: "Usage: codex login [OPTIONS]\n      --device-auth\n", stderr: "" })).toBe(true);
    expect(runsCodexLogin({ code: 0, stdout: "Usage: codex login [OPTIONS]\n", stderr: "" })).toBe(false);
    const env = codexSignInEnvironment({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-x", CODEX_HOME: "/elsewhere", GITHUB_TOKEN: "t" }, "/data/accounts/a");
    expect(env).toEqual({ PATH: "/usr/bin", CODEX_HOME: "/data/accounts/a" });
    expect(codexFallback("/data/accounts/it's", "codex")).toEqual({
      posix: "CODEX_HOME='/data/accounts/it'\\''s' codex login --device-auth",
      powershell: "$env:CODEX_HOME = '/data/accounts/it''s'; & 'codex' login --device-auth",
    });
  });
});

const WAIT_MS = 5_000;

describe("Codex accounts on an environment", () => {
  const start = async (home: string, spawner = fakeSignInSpawner()): Promise<TestEnvironment> => {
    spawner.probe = () => ({ code: 0, stdout: "Usage: codex login [OPTIONS]\n      --device-auth  Sign in with a device code\n" });
    const t = await startTestEnvironment({
      accounts: [],
      adapter: fakeAdapter({ provider: "claude", status: () => signedInAs("david@example.com") }),
      accountProviders: [createCodexAccountProvider({ hostEnv: { CODEX_HOME: home }, now: () => NOW })],
      signInProcess: { spawn: spawner.spawn, hostEnv: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-host" }, bundled: null, codexTool: () => "/usr/local/bin/codex", cwd: "/home/david" },
    });
    onCleanup(() => t.close());
    return t;
  };

  it("probes and adopts the machine's ~/.codex in place, leaving its files as they were", async () => {
    const home = codexHome();
    const before = readFileSync(join(home, "auth.json"), "utf8");
    const t = await start(home);
    const client = await t.client();
    const probe = (await client.request("accounts.probe", { provider: "codex" })) as AmbientProbe;
    expect(probe).toMatchObject({ provider: "codex", directory: home, present: true, signedIn: true, identity: { provider: "codex", email: "david@example.com" } });
    const adopted = (await client.request("accounts.adopt", { commandId: randomUUID(), provider: "codex", label: "Codex" })) as { result: { account: AccountRecord } };
    expect(adopted.result.account).toMatchObject({ provider: "codex", label: "Codex", directory: { kind: "adopted", path: home }, status: { state: "signed-in" } });
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(before);
  });

  it("adds an owned home and signs it in through the managed tool's device flow: the link and code published, the status read on exit", async () => {
    const spawner = fakeSignInSpawner();
    const t = await start(codexHome(null), spawner);
    const client = await t.client();
    const added = (await client.request("accounts.add", { commandId: randomUUID(), provider: "codex", label: "Codex Pro" })) as { result: { account: AccountRecord; signIn: { started: boolean } } };
    expect(added.result.signIn.started).toBe(true);
    const { account } = added.result;
    expect(account).toMatchObject({ provider: "codex", directory: { kind: "owned" }, status: { state: "signed-out" } });
    const login = await spawner.nextLogin();
    expect([login.command, ...login.argv]).toEqual(["/usr/local/bin/codex", "login", "--device-auth"]);
    expect(login.env).toEqual({ PATH: "/usr/bin", CODEX_HOME: account.directory.path });
    login.printError(DEVICE_OUTPUT);
    const notices = (): SignIn[] =>
      t.env.log
        .readStream({ kind: "environment", id: t.env.id })
        .filter((event) => event.type === "signin.updated")
        .map((event) => event.payload as unknown as SignIn);
    await expect.poll(() => notices().at(-1), { timeout: WAIT_MS }).toMatchObject({ state: "awaiting-code", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGHJ" });
    writeFileSync(join(account.directory.path, "auth.json"), JSON.stringify({ tokens: { id_token: ID_TOKEN, access_token: jwt({ exp: NOW / 1000 + 3600 }), refresh_token: "rt" } }));
    login.exit(0);
    await expect.poll(() => notices().at(-1)?.state, { timeout: WAIT_MS }).toBe("done");
    const listed = (await client.request("accounts.list", {})) as { accounts: AccountRecord[] };
    expect(listed.accounts.find((one) => one.id === account.id)).toMatchObject({ status: { state: "signed-in" }, identity: { provider: "codex", email: "david@example.com" } });
  });
});

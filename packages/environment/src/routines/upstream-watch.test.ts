import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { created, history, runNow, untilSettled, written } from "../../test/routines.js";

const { tempDir, onCleanup } = useCleanups();
const script = new URL("../../../../scripts/upstream-watch-probe.sh", import.meta.url);

const release = (databaseId: number, tagName: string, isPrerelease = false, isDraft = false) => ({ databaseId, tagName, isPrerelease, isDraft });
const feeds = () => ({
  github: { data: {
    t3code: { releases: { nodes: [release(12, "v1.2.0"), release(11, "v1.1.0"), release(13, "v1.3.0", true), release(14, "nightly"), release(15, "v1.4.0", false, true)] } },
    codex: { releases: { nodes: [release(22, "rust-v1.2.0"), release(21, "python-v1.1.0"), release(23, "rust-v1.3.0-beta"), release(24, "rust-v1.4.0", true)] } },
    pi: { releases: { nodes: [release(31, "v1.0.0"), release(32, "preview", true)] } },
    hermes: { releases: { nodes: [release(41, "release-one"), release(42, "preview", true)] } },
  } },
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md": "# Changelog\n## 2.1.0\nAdded a thing\n## 2.0.0\nFixed a thing\n## 2.2.0-beta\n",
  "https://code.claude.com/docs/llms.txt": "- [New](https://code.claude.com/docs/en/whats-new/2026-w40.md)\n- [Old](https://code.claude.com/docs/en/whats-new/2026-w39.md)\n- [Other](https://code.claude.com/docs/en/overview.md)\n",
  "https://learn.chatgpt.com/docs/changelog/rss.xml": "<rss><channel><item><guid>b&amp;c</guid><pubDate>today</pubDate></item><item><guid><![CDATA[a]]></guid></item></channel></rss>",
  "https://learn.chatgpt.com/docs/whats-new.md": "# What's new\n## 2026-W40\nNew text\n## 2026-W39\nOld text\n",
  "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/dist-tags": '{"latest":"2.1.0","next":"2.2.0-beta.1"}',
  "https://registry.npmjs.org/@openai%2Fcodex/dist-tags": '{"latest":"1.2.0","old":"1.1.0","duplicate":"1.2.0"}',
  "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/dist-tags": '{"latest":"1.0.0"}',
  "https://registry.npmjs.org/t3/dist-tags": '{"latest":"0.1.0"}',
});

const EXPECTED = `[t3code]
11
12
[codex]
21
22
[pi]
31
[hermes]
41
[claude-code]
2.0.0
2.1.0
[claude-digests]
https://code.claude.com/docs/en/whats-new/2026-w39.md
https://code.claude.com/docs/en/whats-new/2026-w40.md
[chatgpt-rss]
a
b&c
[chatgpt-digests]
2026-W39
2026-W40
[npm:@anthropic-ai/claude-code]
2.1.0
[npm:@openai/codex]
1.1.0
1.2.0
[npm:@earendil-works/pi-coding-agent]
1.0.0
[npm:t3]
0.1.0
`;

/** Real copied script, with only its external gh/curl boundary replaced. */
const setup = async () => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const bin = tempDir();
  const fixture = join(bin, "feeds.json");
  writeFileSync(fixture, JSON.stringify(feeds()));
  for (const command of ["gh", "curl"]) {
    const path = join(bin, command);
    writeFileSync(path, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["WATCH_FIXTURES"]) as f:
    feeds = json.load(f)
key = "github" if os.path.basename(sys.argv[0]) == "gh" else sys.argv[-1]
value = feeds[key]
if value is None:
    sys.exit(22)
print(json.dumps(value) if isinstance(value, dict) else value, end="")
`);
    chmodSync(path, 0o755);
  }
  t.env.processEnvironments.register({
    name: "watch-feeds",
    key: () => "watch-feeds",
    supply: () => ({ variables: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, WATCH_FIXTURES: fixture, GH_TOKEN: "token-for-tests" }, release: () => undefined }),
  });
  const placed = join(t.dataDir, "scripts", "upstream-watch-probe.sh");
  copyFileSync(script, placed);
  chmodSync(placed, 0o755);
  const client = await t.client();
  const { state } = await created(client, written({ preCheck: { kind: "script", path: "upstream-watch-probe.sh" }, injection: "allow" }));
  return { t, client, state, fixture };
};

describe.skipIf(process.platform === "win32")("the upstream watch's pre-check", { timeout: 60_000 }, () => {
  it("prints every source's sorted stable ids, gives one hash twice, and skips a quiet run now without another model call", async () => {
    const { t, client, state, fixture } = await setup();
    const first = await client.request("routines.testPreCheck", { routineId: state.id });
    expect(first).toMatchObject({ output: EXPECTED, failure: null, exitStatus: 0 });
    const reordered = feeds();
    reordered.github.data.t3code.releases.nodes.reverse();
    reordered["https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md"] = "## 2.0.0\nEdited prose\n## 2.1.0\n";
    reordered["https://learn.chatgpt.com/docs/changelog/rss.xml"] = "<rss><channel><item><guid>a</guid><pubDate>tomorrow</pubDate></item><item><guid>b&amp;c</guid></item></channel></rss>";
    writeFileSync(fixture, JSON.stringify(reordered));
    expect(await client.request("routines.testPreCheck", { routineId: state.id })).toMatchObject({ output: EXPECTED, hash: first.hash });
    expect(await history(client, state.id)).toEqual([]);
    const fired = await runNow(client, state.id, { withPreCheck: true });
    await untilSettled(t, state.id, fired.result!.entryId);
    const runs = t.adapter.runs.length;
    const quiet = await runNow(client, state.id, { withPreCheck: true });
    expect((await untilSettled(t, state.id, quiet.result!.entryId)).payload).toMatchObject({ reason: "no-change" });
    expect(t.adapter.runs).toHaveLength(runs);
  });

  it("fails the whole probe when a source is unavailable, preserving the baseline so recovery still fires", async () => {
    const { t, client, state, fixture } = await setup();
    const initial = await runNow(client, state.id, { withPreCheck: true });
    await untilSettled(t, state.id, initial.result!.entryId);
    const changed = feeds();
    changed.github.data.t3code.releases.nodes.push(release(16, "v1.5.0"));
    writeFileSync(fixture, JSON.stringify({ ...changed, "https://learn.chatgpt.com/docs/changelog/rss.xml": null }));
    expect(await client.request("routines.testPreCheck", { routineId: state.id })).toMatchObject({ exitStatus: 1, hash: null, output: "", failure: { reason: "exit_status" } });
    const failed = await runNow(client, state.id, { withPreCheck: true });
    expect((await untilSettled(t, state.id, failed.result!.entryId)).payload).toMatchObject({ reason: "pre-check-failed" });
    writeFileSync(fixture, JSON.stringify(changed));
    const recovered = await runNow(client, state.id, { withPreCheck: true });
    expect((await untilSettled(t, state.id, recovered.result!.entryId)).payload).toMatchObject({ outcome: "succeeded", baselineAdvanced: true });
  });

  it("uses digest page URLs and date-range week headings, without treating feature headings or edited prose as ids", async () => {
    const { client, state, fixture } = await setup();
    writeFileSync(fixture, JSON.stringify({ ...feeds(),
      "https://learn.chatgpt.com/docs/whats-new.md": "# What's new\n## [DevDay 2026](https://learn.chatgpt.com/docs/whats-new/devday-2026)\n### A feature\n## [September 28–October 2, 2026](https://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026)\n## September 21–25, 2026\nChanged prose\n",
    }));
    expect(await client.request("routines.testPreCheck", { routineId: state.id })).toMatchObject({
      failure: null,
      output: EXPECTED.replace("2026-W39\n2026-W40\n[npm:", "September 21–25, 2026\nhttps://learn.chatgpt.com/docs/whats-new/devday-2026\nhttps://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026\n[npm:"),
    });
  });
});

# Routine: upstream watch

Decided on map ticket #31 (2026-09-23). Runs weekly as an Artemis server routine on SYSTEM-SERVER until the harness exists, then becomes the first routine the milestone-1 environment runs on itself. The research behind every rule is `docs/research/upstream-watch-feeds.md` on branch `research/upstream-watch-feeds`.

## Definition (the YAML a harness routine imports)

```yaml
name: Upstream watch
schedule: { kind: weekly, day: monday, at: "03:00" }
workspace: { kind: directory, path: /work/SYSTEM-SERVER/agent-harness }   # the baseline lives here
account: { provider: claude, identity: davidabusiewiez@gmail.com }
model: opus[1m]
effort: high
mode: acceptEdits
skills: []
pre-check:                                    # harness routines only; the Artemis routine does this in its first step
  kind: script
  path: scripts/upstream-watch-probe.sh       # exits 0 with unchanged output when no source has a new stable id
silent-marker: "[SILENT]"
delivery:
  - { kind: client-notice }
  - { kind: webhook, target: hermes-matrix-homelab, on: success }   # once #22 delivery and the fleet exist
instructions: see below
```

Hand-off between the pre-check and the instructions: under the harness, the pre-check script performs steps 1 to 3 below (load the ledger, probe, diff) and, on a quiet week, rewrites `checked_at`, comments "quiet week" and ends the firing before any model run; the model receives the pre-check's candidate list and starts at step 4. Under the Artemis routine there is no pre-check, so the model performs every step itself.

## Instructions (the prompt each firing sends)

You are the weekly upstream watch for the agent-harness. Work in `/work/SYSTEM-SERVER/agent-harness` (pull `main` first). The forge is Forgejo at `https://git.systemtech.dev:5526`, repo `david/agent-harness`; read its token from OpenBao (`set -a; . <(tr -d '\r' < /data/agent/.env | grep -E '^(BAO|OPENBAO)_'); set +a; export BAO_TOKEN=$(bao write -field=token auth/approle/login role_id="$OPENBAO_ROLE_ID" secret_id="$OPENBAO_SECRET_ID"); FORGEJO_TOKEN=$(bao kv get -field=token -mount=personal forgejo/claude-token)` and use `$FORGEJO_TOKEN` in an `Authorization: token` header; never echo it). GitHub calls go through `gh api` (already authenticated on this box). Never print a token.

1. **Load the ledger.** `GET /api/v1/repos/david/agent-harness/issues/74` on Forgejo; parse the fenced JSON block in its body (`sources`, `judged_fps`).
2. **Probe, no model reasoning yet.** One GraphQL query listing releases for `pingdotgg/t3code` and `openai/codex` (`first: 100`) and `earendil-works/pi`, `NousResearch/hermes-agent` (`first: 20`): `databaseId tagName isPrerelease isDraft publishedAt url`. `GET https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` with `If-None-Match` from the ledger. `GET https://code.claude.com/docs/llms.txt` for new `whats-new/2026-wNN.md` links. `GET https://learn.chatgpt.com/docs/changelog/rss.xml` with `If-None-Match`, and `https://learn.chatgpt.com/docs/whats-new.md`. npm `dist-tags` for `@anthropic-ai/claude-code`, `@openai/codex`, `@earendil-works/pi-coding-agent`, `t3`.
3. **Diff by id, never by text.** Stable predicates: T3 `!isPrerelease && tag ~ ^v\d+\.\d+\.\d+$`; Codex `!isPrerelease && tag ~ ^(rust|python)-v\d+\.\d+\.\d+$`; pi and Hermes `!isPrerelease`; Claude Code every `## x.y.z` heading; RSS `guid`; digests the page URL or week heading. New = ids not in that source's `recent_ids`. **A source with no ledger entry is bootstrapped: record its current state and file nothing for it.** If no source has anything new: rewrite the ledger's `checked_at` values, add a one-line comment "quiet week", and end your reply with `[SILENT]`.
4. **Extract candidates by rule.** Fetch bodies for new tags only. Keep: Codex `## New Features`; pi `### New Features` and `### Added`; Claude Code bullets starting `Added`, `Changed` or `Removed` (drop `Fixed`); T3 `feat` PR lines; Hermes release prose; digest and RSS items. Drop dependency bumps, i18n, fmt, docs-only. Each candidate: `{upstream, version, section, text, source_url, item_fp}` with `item_fp = sha256(upstream|version|normalised text)[:12]`. Drop any `item_fp` already in `judged_fps`.
5. **Judge (one pass).** The baseline is `CONTEXT.md`, `docs/adr/*.md` on `main`, and the map's Decisions-so-far (issue #3). For each candidate give one verdict: **have** (we decided or ship it), **irrelevant** (model catalogue, mobile store, a surface we do not ship), or **new gap** with a `topic_key` (kebab-case) and a one-line capability in harness terms; group candidates sharing a topic across upstreams.
6. **File one digest issue** titled `Upstream watch: <ISO week, e.g. 2026-W40>` with labels `needs-triage` and `upstream-watch` (the latter created on this repo on 2026-09-23, id 271). Body: a short header (sources probed, counts), then **New gaps** grouped by topic, each with the capability line, the upstream text quoted, the source link, `Fingerprint: uw:<topic_key>` and the item fingerprints; then **Have** and **Irrelevant** as compact lists. Say at the top: "David triages this with an agent: each accepted gap becomes its own roadmap issue in the per-feature shape (Capability / Seen in / Upstream text / Why it may matter here / Our state / Fingerprint); close this digest when every item has an answer."
7. **Update the ledger.** `PATCH` issue #74's body with the new JSON: per source `repo_id`, `etag`, `last_version`, `recent_ids` (keep the last 100), `checked_at`; append every candidate's `item_fp` to `judged_fps`. Add a comment: the digest issue link and the counts.
8. Reply with a two-line summary. Do not open pull requests, do not edit code, do not create any issue other than the digest.

## Triage afterwards (David, with an agent)

Open the week's digest with `/triage`-style help: for each new gap decide **roadmap** (create an issue from the per-feature shape, labelled `needs-triage`, and mention it on the digest) or **skip**; a gap already on the roadmap gets a comment on that issue instead. Close the digest when every item has an answer.

## The Artemis routine (until milestone 1)

Created 2026-09-23 as routine `oa9YJpNDk68` through `POST /api/v0/routines` (body wrapped in `draft`) on the Artemis server (`http://100.109.204.54:6472`, connection `SYSTEM-SERVER`, workspace `/work/SYSTEM-SERVER`): weekly, Monday 03:00 machine-local; account `davidabusiewiez@gmail.com` (Claude); model `opus[1m]`, effort `high`; mode `acceptEdits`; instructions as above. The Artemis server delivers nothing, so the digest issue is the delivery; the run's transcript is on the server. Run it by hand with `POST /api/v0/routines/<id>/run-now`.

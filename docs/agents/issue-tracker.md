# Issue tracker: Forgejo (self-hosted)

Issues and specs for this repo live as **Forgejo issues** on the self-hosted
instance at `https://git.systemtech.dev:5526`, repo `david/agent-harness`.

There is no `gh`/`glab`/`tea` CLI for this host. Forgejo exposes a
Gitea-compatible REST API, so every operation below is a `curl` call.

## Authentication

Get the token from the machine's git credential store, which already holds it
for this host:

```bash
TOKEN=$(printf 'protocol=https\nhost=git.systemtech.dev:5526\n\n' \
  | git credential fill | sed -n 's/^password=//p')
```

If that comes back empty, read `personal/forgejo/claude-token` (field `token`)
from OpenBao instead. Never embed the token in a remote URL: it persists in
`.git/config`.

Every call below assumes:

```bash
API="https://git.systemtech.dev:5526/api/v1/repos/david/agent-harness"
AUTH=(-H "Authorization: token $TOKEN" -H "Content-Type: application/json")
```

Derive the owner/repo from `git remote -v` rather than hardcoding it if you are
working in a fork or a rename.

## Conventions

- **Create an issue**: `POST $API/issues` with `{"title": "...", "body": "..."}`.
  Build the JSON with `python3 -c` or `jq -n` so multi-line bodies escape
  correctly; a heredoc straight into `-d` will break on quotes and newlines.
- **Read an issue**: `GET $API/issues/<number>` for the body, and
  `GET $API/issues/<number>/comments` for the comments. They are separate calls;
  there is no `--comments` equivalent.
- **List issues**: `GET $API/issues?state=open&limit=50`, with `&labels=a,b` to
  filter. Labels come back on each issue as `.labels[].name`.
- **Comment on an issue**: `POST $API/issues/<number>/comments` with `{"body": "..."}`.
- **Apply labels**: `POST $API/issues/<number>/labels` with `{"labels": ["needs-triage"]}`
  (names or numeric ids are both accepted).
- **Remove a label**: `DELETE $API/issues/<number>/labels/<label-id>`. This one
  needs the **id**, not the name: get it from `GET $API/labels`.
- **Close**: comment first, then `PATCH $API/issues/<number>` with `{"state": "closed"}`.
  There is no close-with-comment in a single call.
- **Repo labels**: `GET $API/labels` lists them; `POST $API/labels` with
  `{"name", "color", "description"}` creates one.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues:

- **Read a PR**: `GET $API/pulls/<number>`; the diff is at
  `GET $API/pulls/<number>.diff`.
- **List open PRs**: `GET $API/pulls?state=open`. Forgejo has no
  `authorAssociation` field, so filter external contributions by checking each
  PR's `.user.login` against the collaborator list
  (`GET $API/collaborators`) and dropping anyone who is on it.
- **Comment / label / close**: a PR is an issue underneath, so use the
  `$API/issues/<number>/comments` and `$API/issues/<number>/labels` endpoints
  with the PR's number; close with `PATCH $API/pulls/<number>`.

Like GitHub, Forgejo shares **one number space** across issues and PRs, so a
bare `#42` may be either. Resolve with `GET $API/pulls/42` and fall back to
`GET $API/issues/42`.

## When a skill says "publish to the issue tracker"

Create a Forgejo issue: `POST $API/issues`.

## When a skill says "fetch the relevant ticket"

`GET $API/issues/<number>` followed by `GET $API/issues/<number>/comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes /
  Decisions-so-far / Fog body.
- **Child ticket**: Forgejo has no sub-issues. Add the child to a task list in
  the map body (`- [ ] #<child>`) and put `Part of #<map>` at the top of the
  child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
  Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: Forgejo's **native issue dependencies**, which are enabled on
  this repo and visible in the UI. Add an edge with
  `POST $API/issues/<child>/dependencies` and body
  `{"owner": "david", "repo": "agent-harness", "index": <blocker-number>}`.
  All three fields are required even for a same-repo edge — posting bare
  `{"index": n}` returns `404 IsErrRepoNotExist`, which reads like the repo is
  missing rather than the body being short (verified 2026-09-23). `index` is
  the issue **number**, not a database id. Remove with
  `DELETE $API/issues/<child>/dependencies`, same body. Read a ticket's blockers
  with `GET $API/issues/<child>/dependencies`, which returns the blocker issues;
  a ticket is unblocked when every one of them is `closed`. (`GET
  $API/issues/<n>/blocks` gives the reverse edge.) If dependencies ever get
  turned off, fall back to a `Blocked by: #<n>, #<n>` line at the top of the
  child body.
- **Frontier query**: list the map's open children (`GET $API/issues?state=open`,
  scoped to the map's task list), drop any with an open blocker or an assignee;
  first in map order wins.
- **Claim**: `PATCH $API/issues/<n>` with `{"assignees": ["david"]}`, the
  session's first write.
- **Resolve**: `POST $API/issues/<n>/comments` with the answer, then
  `PATCH $API/issues/<n>` with `{"state": "closed"}`, then append a context
  pointer to the map's Decisions-so-far by `PATCH`ing the map's body.

## Gotchas

- The API and git smart-HTTP paths bypass the Authentik outpost, so the token
  works through the public URL unchanged. The web UI does not: it is behind SSO.
- A `405 "Please try again later"` on a merge means Forgejo is still recomputing
  mergeability after the base moved. Retry with ~3s backoff.
- This repo is **private**, as are all repos on this instance. Anonymous clones
  and unauthenticated API reads will 404, not 403.

# Publish a public snapshot and release

Development stays on Forgejo. The public repository has one clean commit per
publication, with the previous public snapshot as its only parent. Private
history, branches and PR refs are never transferred. Each commit uses
`Public snapshot <snapshot@users.noreply.github.com>` for author and committer.

Before the first publication, the coordinator must disable the all-branch push
mirror and prepare an empty public repository. If that repository already has
private mirrored history, the coordinator must replace it with an empty one
before making it public: this script deliberately never rewrites remote history.
Land the tree scrub, public README and GitHub release workflow first. Publish
only a reviewed, cleaned ref containing all three; files come from that ref,
never another branch or uncommitted working-tree edits. No licence is granted.

`.public-map.json` declares source-to-destination file mappings. It installs
`public/.github-workflows/release.yml` at `.github/workflows/release.yml`.
Mapped sources are moved into their declared destinations; the source overlay
directory and mapping policy are excluded from the snapshot. Missing sources,
unsafe or excluded destinations, and collisions block publication. The installed
files retain the selected ref's bytes and modes and pass the same privacy checks.

Run from a development checkout with Python 3.11+, Git, Node 24+ and the
workspace's pinned pnpm installed (activate it with Corepack). The rehearsal
needs the same native build tools as CI: Python, make and g++ on Linux. Git uses
the maintainer's normal credential helper for the public remote. Keep tokens
out of URLs and command arguments. Installing the workflow needs repository
write access and permission to add/update workflow files. Classic personal
access/OAuth tokens need the `workflow` scope; see
[GitHub's scope reference](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes).
Preview a publication:

```sh
python3 scripts/publish-public.py \
  --source . --ref origin/main \
  --remote https://github.com/david-systemtech/agent-harness.git \
  --version 0.1.0 --tag v0.1.0 --dry-run
```

The preview prints the included file list, privacy check results, proposed commit
ID, parent and message, then rehearses that exact proposed public commit in a
separate temporary checkout: `pnpm install --frozen-lockfile`, `pnpm typecheck`
and `pnpm lint`, which prove the snapshot is a complete, consistent checkout.
The rehearsal runs no tests. For a release, the hosted release workflow's
`suite` job runs the whole suite on the published tree in six shards, and its
`verify` job runs typecheck, lint and the schema export check. The builds and
smokes run beside them, but the image push and the release wait for both, so a
failing suite publishes no release and leaves the tag reusable. That workflow runs on `v*` tags and manual dispatch only, so a
code-only snapshot (no `--tag`) relies on the private CI of the selected commit:
publish only a commit whose CI is green. Those
commands share a 30-minute budget and print progress; a failure or timeout
blocks publication. Command
output is withheld to protect credentials; failure diagnostics report the
failed command and exit status. It writes temporary objects, dependency
caches and rehearsal build output and may download the pinned scanner; it never
pushes refs. A passing dry run ends with `Dry run: no refs pushed; rehearsed tree
<tree ID>`. Rehearsal changes cannot enter the scanned snapshot. A later run may
have a different commit ID because the commit time or public parent changed.
A failed check prints a rule and file/line, or a scanner failure, and exits
nonzero without pushing.
Git failures identify the operation and exit status; remote URLs and raw stderr
are omitted to keep credentials and private connection details out of diagnostics.

Review the list and remove `--dry-run` to publish. Publication repeats the
rehearsal before the atomic push; the publisher never treats a previous dry run
as proof by itself. To skip it after a passing dry run, pass the tree ID that
dry run printed as `--rehearsed-tree <tree ID>`: the rehearsal reads only the
snapshot tree, so the publisher skips it when the snapshot it builds is exactly
that tree, and blocks publication when it is not (a ref such as `origin/main`
moved, or the policies changed the export). The publisher refuses
`--rehearsed-tree` with `--dry-run`, so a dry run always rehearses. Omit `--tag` for a code-only
snapshot. For a release, the tag must be `v` plus `--version`, including any
prerelease suffix (for example `0.1.0-beta.1`). The script atomically pushes
`main` and the optional lightweight version tag, without force. An existing tag
or a concurrent publication refuses the push. The public `v*` tag starts the
GitHub release workflow; watch its build and resulting release on GitHub. The
Forgejo tag alone does not publish this snapshot. The workflow in the selected
ref decides the release artefacts and whether a prerelease is created.

`.public-exclude` in the selected ref lists root-relative glob patterns, one per
line, with `#` comments; a matched directory excludes its descendants. It has no
negation syntax. It removes development CI, publication tooling and private
runbooks. It also removes `.gitleaksignore` so committed fingerprints cannot
suppress the privacy scan. README and `.github/workflows/` must survive the filter. Symlinks and
submodules are rejected rather than followed or fetched. Regular files retain
exact committed bytes and executable modes, unaffected by Git clean filters.

The publisher refuses any retained `.test.ts` or `.test.tsx` file naming an
excluded path, including adjacent string arguments in `join(...)`. Snapshot
policy excludes private workflow/runbook checks and tests naming private inputs,
including synthetic Forgejo bank fixtures. All remain in the development tree
and private CI; the hosted release workflow tests remain public and read the
installed workflow through the release input helper. This lexical check does
not replace running the hosted release's typecheck, lint and full test suite
in CI; paths computed without literal names still need ordinary test coverage.
The publisher itself rehearses the proposed public commit after the selected
ref's complete privacy and mapping policies have passed, before either a dry run
succeeds or any public ref is pushed (unless `--rehearsed-tree` names the tree a
passing dry run rehearsed). This keeps the rehearsal outside the sharded unit
suite and enforces it even for a code-only snapshot. For a `v*` tag, the hosted
release workflow's `verify` job runs typecheck and lint, and its six `suite`
shards run the full test suite, on the published tree before anything is pushed
or published.

`.public-privacy.json` in the selected ref defines case-insensitive deny patterns
for private terms and addresses. The check scans both filenames and all blob
contents, including binary files. Null-padded ASCII terms are also checked,
covering UTF-16/32 private identifiers. Its allow-list grants only a particular rule,
path pattern and matched synthetic value; fixture prose still gets checked.
Change these policies only through review. When the scrub identifies another
private runbook, add its path to the excludes before publishing. New fixtures
should use `example.com`, TEST-NET addresses and invented names.

Gitleaks scans the exported directory using its built-in secret rules with
redaction, in-file suppression comments disabled, and an isolated config. Repository config and caller `GITLEAKS_*`
variables cannot disable that scan. It must report version 8.30.1, the relay's
pin. Use an installed matching `gitleaks`, or supply its path with `--gitleaks`.
On Linux x64/arm64, when absent, the script checks the relay's cached archive,
then tries the development forge's generic package source and GitHub releases.
Every downloaded or cached archive must match the relay's pinned SHA-256 before
extraction. A missing scanner, unavailable download or wrong checksum blocks
publication. Other platforms need the pinned scanner installed beforehand.

Verification: `test/publish-public.test.ts` runs the command against local bare
remotes, a stub scanner and a recording pnpm executable; it never pushes to
GitHub or installs/runs a nested suite. It checks rehearsal ordering, the exact
proposed commit, failure blocking, the `--rehearsed-tree` opt-out, its block on
a different tree and its refusal on a dry run, and isolation of generated files. Run the real
cleaned tree's privacy scan and rehearsal as a maintainer dry-run before
publication. The fast tests demonstrate deny-list failures, synthetic allowances
and scanner failures; the maintainer run verifies the selected real snapshot.

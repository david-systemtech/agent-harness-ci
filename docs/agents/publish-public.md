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

Run from a development checkout with Python 3.11+ and Git installed. Git uses
the maintainer's normal credential helper for the public remote. Keep tokens
out of URLs and command arguments. Preview a publication:

```sh
python3 scripts/publish-public.py \
  --source . --ref origin/main \
  --remote https://github.com/david-systemtech/agent-harness.git \
  --version 0.1.0 --tag v0.1.0 --dry-run
```

The preview prints the included file list, privacy check results, proposed commit
ID, parent and message. It writes only temporary local objects and may download
the pinned scanner; it never pushes refs. A later run may have a different commit
ID because the commit time or public parent changed. A failed check prints a rule
and file/line, or a scanner failure, and exits nonzero without pushing.

Review the list and remove `--dry-run` to publish. Omit `--tag` for a code-only
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
The publisher's hosted-only integration test copies the development tree into
a local fixture, applies the real mapping/exclusion policies, and runs install,
typecheck, lint and the full test suite on the resulting public checkout. Its
fixture privacy policy is empty so test closure can be checked before the scrub;
real publication always uses the selected ref's complete privacy policy.

`.public-privacy.json` in the selected ref defines case-insensitive deny patterns
for private terms and addresses. The check scans both filenames and all blob
contents, including binary files. Its allow-list grants only a particular rule,
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
remotes and a stub scanner; it never pushes to GitHub. The real cleaned tree's
privacy scan is a required maintainer dry-run after the scrub lands. The local
tests demonstrate deny-list failures, synthetic allowances and scanner failures,
not an audit of a tree that has yet to be cleaned.

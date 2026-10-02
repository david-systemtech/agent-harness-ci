# Preparing a bank migration

`banks.migrate` is a prepared admin command. Use an authenticated environment
client, a registered `bankId`, a fresh UUID `commandId`, and `dryRun: true` first.
The source is the checkout's committed head; uncommitted files are ignored.
The planner copies committed files in memory, validates the proposed tree with
the common bank validator, and returns `report` with `landing: null`.
A dry run creates no worktree, branch, commit or forge pull request.

The report holds original and final memory counts (new orientation drafts are
counted separately), key renames, accepted file moves, validator findings,
unresolved decisions and prefix-cluster proposals for over-cap scope folders.
A proposal moves nothing. A partially accepted split can still fail the cap.

Keep live bank content and choices outside this repository. The optional
`choices` object is explicit authoring, illustrated here with synthetic facts:

```json
{
  "repositoryMappings": { "lab": "https://git.example.test/maya/lab" },
  "artefactRepairs": {
    "projects/personal/lab/PROJECT.md": "---\nsummary: 'Lab: machines'\ncode: [lab]\ntopics: {}\n---\nKeep the original authored body.\n"
  },
  "topics": {
    "maya-memory:personal/lab/": {
      "backups": { "line": "Backup facts", "memories": ["backup-schedule"] }
    }
  },
  "orientationDrafts": [{
    "name": "bank-tracker",
    "description": "Before tracking this bank's work - follow the existing project memory for its details",
    "body": "See [[backup-schedule]] for the source fact.\n"
  }],
  "retiredWorkflows": [".forgejo/workflows/old.yml"],
  "secretScan": "bash scripts/scan-secrets.sh"
}
```

Mappings rewrite both folder `code`/`repos` and memory `metadata.applies_to`.
Repairs must name existing project or area artefacts; malformed YAML is reported
until its author supplies a repair. Repairs should preserve the authored body.
`purpose` and `entities` may also be supplied explicitly. Otherwise the planner
renames the old purpose and derives entity pointers from the orgs.
It drafts a short orientation pointer when none exists; review its relevance,
or supply up to five authored pointers. Existing memory names cannot be reused
for orientation unless they already belong to orientation in the home folder.
The common validator enforces orientation byte caps and checks links.

Confirm the old bank-check workflows in `retiredWorkflows`; review the replacement
`validate` workflow and supply its retained secret-scan command explicitly.
The scan must run independently of the retired Python bank check. A workflow
that still calls the old check is an unresolved decision, not silently removed.

Repeat dry runs with fresh command ids until every decision and refusal is
resolved. Then submit the same choices with `dryRun: false` and a fresh command
id. It requires an enabled, writable remote bank. The Lander verifies that main
still matches the planned head, installs the stamped validator and its forge
workflow, and opens a structural change held for review. Retrying a command id
returns its original receipt and creates no second PR. A local-only or read-only
bank can be inspected through dry runs but cannot prepare a migration PR.

The bank owner approves orientation and every topic move. Verify the bank's live
`validate` job and secret scan on that PR. Keep it unmerged until the switch-over
owner authorizes landing; preparing a migration never switches readers.

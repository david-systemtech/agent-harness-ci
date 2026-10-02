# Preparing the team bank's switch-over

The #1043 build uses invented fixtures only. It has made no live bank branch,
pull request, issue, label or contact with Albert. David owns those actions,
including posting the heads-up and the day-of merge coordinated by #94.
The ready-for-human live-work handoff is [#1240](https://git.systemtech.dev:5526/david/agent-harness/issues/1240).
See [the shared migration command](bank-migration.md) for authentication,
command receipts and the dry-run rules.

## Conversion choices

Supply `team: { org: "brandsolidate", owners: ["david-systemtech"] }` to the
same `banks.migrate` command. Every `brands/<brand>/[<system>/]` scope moves
under `projects/brandsolidate/<brand>/[<area>/]`. `SYSTEM.md` becomes `AREA.md`;
the shared key and repository-identity conversions run after the scope move.
Missing parent projects gain a project artefact for owner review.

Use `scopeMoves` to name holding-company shared scopes explicitly. The keys
are original folder paths ending in `/`; the values are final project or area
pointers. A `shared/` source must target the `holding` project in the chosen
org. The longest explicit source prefix wins; no move may overwrite a file.
For example, these are **synthetic** choices, not a live bank inventory:

```json
{
  "team": { "org": "brandsolidate", "owners": ["david-systemtech"] },
  "scopeMoves": {
    "shared/ops/": "fixture-team:brandsolidate/holding/ops/"
  },
  "topicDeclarations": {
    "fixture-team:brandsolidate/sample-brand/product/": {
      "sample-line": "Synthetic product facts"
    }
  }
}
```

Product facts already under `product/memories/<line>/` retain their topic;
`product/<line>/memories/` moves to `product/memories/<line>/`.
`topicDeclarations` author the destination scope's topic one-liners. The
validator refuses undeclared topics. Use the existing `topics` choice to move
flat memories into accepted topics. Supply `repositoryMappings`, `entities`,
`purpose` and fresh `orientationDrafts` for owner approval. Artefact repairs
name existing source files, including `brands/` and `shared/`, and preserve
their authored bodies. Unmapped shared facts remain untouched and block a PR.

The report includes name/link/count preservation evidence and `headsUp`, a
draft title and body. It never sends that draft. New orientation pointers are
counted separately. A team conversion that fails preservation cannot prepare
a PR. The PR always waits for review; a sole owner merges manually.
The planner vendors the stamped Node validator and the GitHub validate
workflow. An independent secret-scan workflow remains intact; if replacing a
combined workflow, explicitly retain its independent scan command.

## David's exact live steps

1. After #1042 and #1043 land, select the bank's authenticated environment and
   verified GitHub account. Confirm the registered bank id, writable role,
   enabled state and current main commit. Keep all live choices and reports
   private and outside this repository, its tests and tracker.
2. Author the choices above against the current bank tree: actual holding
   source prefixes, final bank pointers, product-topic lines, repository
   identities, entities and short orientation pointers. Confirm owners are
   `[david-systemtech]`; do not infer an additional owner from collaboration.
3. Send `banks.migrate` with a fresh UUID `commandId`, that `bankId`,
   `dryRun: true` and those `choices`. Inspect the local result: `landing` must
   be null, `report.valid` true, all preservation flags true, zero unresolved
   decisions and zero refusals. Review warnings and every move; reconcile
   `before + added = after`. Resolve choices and repeat with fresh ids as
   needed. Do not publish live names, paths or text to this tracker.
4. Review and edit `report.headsUp` locally. David posts it as an issue on the
   bank **before any landing**, recording a date only after #94 confirms it.
   Record its URL and evidence of the preceding notification privately.
5. David submits the same approved choices with a fresh `commandId` and
   `dryRun: false`. Record the returned migration PR URL; confirm the PR is
   open and awaiting review, and source main has not changed. If main moved,
   recompute the dry run and approvals rather than using a stale result.
6. Review the PR's final diff, orientation, holding mappings, product topics,
   names, links and counts. Run the vendored validator on the candidate and
   confirm the live GitHub validate job and secret scan both pass. Record
   David's owner review; leave it unmerged.
7. At #94's coordinated switch-over, confirm the heads-up already exists,
   update its confirmed timing, and have the sole owner merge manually.
   Verify committed main with the common validator, preserved counts and
   links, then switch readers and retire the Python CLI under #94.

## Draft heads-up for David to review and post

Albert, we are preparing the bank's contract migration. Brand/system folders
will move to `projects/brandsolidate/<brand>/[<area>/]`, and the holding
company's shared facts to `projects/brandsolidate/holding/[<area>/]`.
`SYSTEM.md` becomes `AREA.md`; product lines become declared topics.
Memory names and links stay intact, with fresh short orientation pointers.
The manifest gains kind, purpose, entities and `owners: [david-systemtech]`.
Orientation, decisions, status and manifest changes wait for owner review;
with one owner David merges manually. Generated index artefacts are removed,
and the Node validator runs in GitHub CI alongside the secret scan.

No landing date is set. David will confirm the timing here as part of #94
before merging the reviewed migration PR. The current bank stays in use until
then. Owner approval of the mappings, product topics, orientation and CI is
still required. This heads-up must precede landing.

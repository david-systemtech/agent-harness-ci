# Switch-over: acceptance record template

Deployment labels, identities, paths and observations here are examples. Keep the
actual inventory, version pins and operator approvals in a private acceptance record.

Copy this record for [the operator runbook](switch-over-runbook.md), owned by
[#94][94]/[#1197][1197]. Nothing below is live evidence until an operator fills it.
The [synthetic example](switch-over-example.md) exercises the gates only.
David supplies the complete inventory/operators and day; only David signs.

## Record and coverage

- Record id, operator log and evidence location: **owed**.
- David-confirmed complete machine/OS-user/Environment and folder inventory: **owed**.
- Operators, backup owners and confirmation by David: **owed**.
- Switch-over day/time zone (both Bank migrations that day): **owed**.
- Cut-over completion time; earliest one-week sign-off; actual sign-off time: **owed**.
- Release tag/head, artefact/container digest, contract CI URL/result: **owed**.
- Required platform checklist sections and results on that release head: **owed**.
- Normal-use dates and David/Milo workflow evidence: **owed**.
- Decision: **blocked — inventory and evidence not yet supplied**.

Required coverage includes all server/container deployments, desktops, terminal
folders and external receiver hosts. Record container host and contained OS users, and
split rows for distinct Environments. Include no-source machines with detection
proof; never drop them from restart or Client/Hermes checks. Unknown coverage
blocks done. Add rows until David confirms that no machine/folder is missing.

One row per machine/Environment; ids in cells may link to detailed evidence below.
List every folder, including secondary transcript/lazy-history sources, and
Account identity plus the winning credential directory. Never record secrets.

| Machine / Environment id | OS user / host-container boundary | Source, terminal, adopted/secondary, harness and Bank folders | Accounts / identity / winner | Operator / backup owner | Detection / preview reports | Application reports / import ids | Repairs / disposition | Bank heads | Pairings / scopes / Ceiling / reference locator | Enabled Routines | Evidence links |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SAMPLE-SERVER/container / owed | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed |
| Every David desktop/terminal / enumerate | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed |
| Every Milo desktop/terminal / enumerate | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed |
| EXAMPLE-VM Hermes / no-source only if proved | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed | owed |

## Evidence states and acceptance gates

Use **linked evidence** only for an observed result: URL/anchor, check, machine,
OS/platform, operator, date and release/Bank/deployment head. An issue/PR URL alone
is an **owner link**, leaving **owed evidence** until its result is attached.
**Failed** or **not run** required checks block done. **Platform inapplicable**
requires a named platform, David-confirmed inventory/feature reason and approval;
lack of access/time is not a reason. Closing a build/spec ticket is not live proof.

Before David signs, every following gate must pass; do not turn an empty cell
into “none” or count an optional skip without its declared check/reason.

- Complete confirmed inventory, assigned operators and restore-tested snapshots.
- Per-row final preview/application or proved no-source disposition; per-Account
  inventory/history/continuation; every `failed`, unexpected `notCarried` and
  `reEnter` resolved with replacement/repair evidence. `later` names providers and
  milestone-2 owner links. Unresolved external failures block done.
- Source work/schedulers quiesced before final apply; shared sign-in directories
  never used for concurrent turns. Imported Routines initially disabled.
- All eleven callable Set up Steps checked/subscribed, or declared optional skip
  with reason; no required stub passes. Record ordered results below.
- Butler-only pinned Hermes, same Claude billing identity, live Account-qualified
  model, correct Ceiling/OpenBao reference, streaming/tools/auxiliary overrides,
  `/keep`/`/save`, librarian parked; signed delivery/Matrix/retry checks with only
  only the two receiver failure modes below eligible for explicit acceptance.
- David/Milo daily Client workflows, all four commands and parity/theme checks;
  contract CI and required manual results on the release head; matrix complete.
- Both reviewed Bank migrations landed on the supplied day with owner review,
  green validators on landing heads, synced checkouts and read/search/reviewed-write proof.
- Each enabled Routine has a scheduled Firing after enable. Run-now or a skipped
  due time cannot pass. Slower schedules extend the sign-off date beyond one week.
- At least one week of normal use after cut-over; record actual start/end dates.
- Source listeners/processes/schedulers absent everywhere, autostart/updaters
  disabled and absence verified after restart; harness Client/Hermes exchange
  successful afterwards. Preparation pauses do not count as retirement.
- Sources/backups/lazy history retained; deletion requires David's explicit later
  approval. Rollback inputs are usable; new harness Sessions have no reverse import.

## Import, repairs and Set up

For each machine/report, retain `carried`, `reEnter`, `later`, `notCarried`,
`failed`, per-Account Carry over counts and unapplied `clientLocal` values.
Include final preview and application separately, report/import ids, changed-store
refusals, completion/Health evidence, terminal one-time import and re-run outcomes.

| Row / report / category / item | Observation and replacement Step | Repair owner / evidence / result | Remaining blocker or milestone-2 provider/owner |
| --- | --- | --- | --- |
| owed | owed | owed | owed |

| Environment | Ordered Step ids | Check/callable-handler and budget/cadence/trigger evidence | Health results / subscriptions / declared skips |
| --- | --- | --- | --- |
| each, owed | account, carry-over, your-machines, forges, key-manager, memory-bank, skills, instructions, browser, permissions, appearance | [#1192][1192] owner; execution owed | owed |

## Workstream evidence matrix

The acceptance criteria are the [spec's workstream table](../specs/switch-over.md#operational-order-and-milestone-1-done).
Fill a result per deployed platform/Environment, with head/date/operator. The
owner column routes debt; it does not claim that any linked ticket has passed.

| Workstream | Acceptance criteria | Existing evidence / build / confirmation owners | Linked evidence and result | Owed evidence | Explicit platform inapplicability / approval |
| --- | --- | --- | --- | --- | --- |
| [#78][78] Environment | Non-root install, identity across restart, Pairing/revocation, replay/receipts, live Runs survive Client reconnect. | [#877][877]; service checklist. | none supplied | all required checks | none supplied |
| [#79][79] Session state | ADR 0003 fields; Groups/pins/archive/drafts identical in two Clients; lazy import/re-run preserve edits. | [#1167][1167]/[#1168][1168]; release contract CI. | none supplied | all required checks | none supplied |
| [#80][80] Client runtime | Outbox/recovery; immediate offline drive refusal; capability reasons/import notices in both Clients. | [#1174][1174]/[#1191][1191]; release runtime CI and manual recovery. | none supplied | all required checks | none supplied |
| [#81][81] TUI | Milo terminal/tmux; -p, ls, /undo, /check formats/exits/guards/offers and GUI parity; defaults, incremental rendering, editor/diff, labelled gaps. | [#1176][1176]/[#1177][1177]/[#1178][1178]/[#1179][1179]/[#1180][1180]/[#1181][1181]/[#1185][1185]/[#1189][1189]/[#1191][1191]. | none supplied | all required checks | none supplied |
| [#82][82] Claude Adapter | Listed adoption, secondary history/continuation, process reuse, subscription billing, caller tools and queue operations. | [#1164][1164]/[#1166][1166]/[#1167][1167]/[#1193][1193]; [#210][210]/[#217][217] sign-in/cold resume. | none supplied | all required checks | none supplied |
| [#83][83] Permissions | Ceiling clamps, unattended denial/review, Trust gate/containment on deployed platforms; signed-in auto and known git-write gaps recorded. | Permissions workstream; [#1191][1191]/[#1193][1193]; deployed checks. | none supplied | all required checks | none supplied |
| [#84][84] GUI/Desktop shell | Seven Panes/native shell per OS, shortcut Settings, no default stop key, /undo and /check parity, phase-D theme picker. | [#831][831]/[#1129][1129]; [#1186][1186]/[#1190][1190]/[#1191][1191]/[#1194][1194]; [#435][435]/[#640][640] confirmations; desktop checklist. | none supplied | all required checks | none supplied |
| [#85][85] Workspace picker | Directory/worktree/scratch/missing recovery; repository identity and Account-scoped auto memory on real checkouts. | [#1167][1167]; Workspace workstream CI and deployed checkouts. | none supplied | all required checks | none supplied |
| [#86][86] Launcher/update | Server/service install, desktop packaging, trial/rollback, parked prompts, container/host-updater on deployed platforms. | [#813][813]/[#831][831]/[#360][360]/[#478][478]/[#877][877]; service and desktop checklists. | none supplied | all required checks | none supplied |
| [#87][87] Forge | Origins/aliases, contained helper injection, Bank git credentials and owner-review reads; reachable primary Forge/release channel. | [#458][458]; [#1027][1027]/[#1032][1032]; Forge workstream. | none supplied | all required checks | none supplied |
| [#88][88] Set up | All eleven STEP_ORDER ids registered with budgets/cadences/triggers/skip checks; callable Health and subscribed results per Environment. | [#1192][1192]; [#1165][1165]; [#587][587] Bank card and [#1028][1028]/[#1029][1029]/[#1033][1033]/[#1034][1034] methods. | none supplied | all required checks | none supplied |
| [#89][89] Skills/Instructions | Source sync/Readiness, imported copies/scopes, trusted repo loading and stable composition including Banks. | [#764][764]; [#1172][1172]; [#1165][1165]/[#1166][1166]; [#1022][1022]/[#1036][1036]. | none supplied | all required checks | none supplied |
| [#90][90] Banks | BankService handlers/five card methods, scope/read exemption, reviewed notebook/meadowstudios migrations, vendored validators, CLI bank. | [#1042][1042]/[#1043][1043]/[#1032][1032]/[#1044][1044]; [#587][587]/[#1033][1033]/[#1034][1034]/[#1039][1039]/[#1040][1040]; [#1022][1022]/[#1027][1027]/[#1038][1038]. | none supplied | all required checks | none supplied |
| [#91][91] Key managers | Re-entered sign-ins/references, child-token permissions/renewal/revocation, locked-screen/keychain, scrub checks/CLI minimums. | [#1169][1169]; [#636][636]; [#1122][1122] Bitwarden availability; service keychain checklist. | none supplied | all required checks | none supplied |
| [#92][92] Routines | Disabled import/manual enable; pre-check/no-change, silence, kept output/delivery; one upstream scheduler/no duplicate Monday. | [#1171][1171]; [#988][988]; [#1009][1009] delivery and accepted gaps. | none supplied | all required checks | none supplied |
| [#93][93] Browser | Fresh local Pairing; real Chrome extension/relay/snapshot; headless availability per deployment; imported policy; honest completions defaults. | [#1173][1173]; [#913][913]/[#944][944]/[#858][858]/[#925][925]/[#922][922]/[#981][981]/[#562][562]/[#563][563]/[#731][731]/[#743][743]; [#1129][1129] camera; browser checklist. | none supplied | all required checks | none supplied |
| [#94][94] Switch-over | Per-machine clean dry run/apply/repair, Hermes, one week normal use, scheduled Firing of every enabled Routine, source stopped everywhere. | [#1164][1164]–[#1177][1177] import chain; [#1180][1180]/[#1181][1181]/[#1185][1185]/[#1186][1186]/[#1189][1189]/[#1190][1190]/[#1191][1191]/[#1192][1192]/[#1193][1193]/[#1194][1194]; [#1195][1195] record; [#1197][1197] execution. | none supplied | all required checks | none supplied |

Audit dated 2026-10-02: named release/service/desktop, sign-in/platform tool,
camera/browser, upstream-watch and non-root owners above are open. The phase-D
import/command/undo/check/Health/Hermes/theme builds are open too. Recheck current
status and attach release-head evidence; do not create another acceptance task
for each machine. Further open dependencies include [#242][242] (fork history),
[#1182][1182]/[#1183][1183]/[#1184][1184] (file hooks/undo), [#1187][1187]/[#1188][1188] (checks), [#587][587] (Bank card),
[#1033][1033]/[#1034][1034]/[#1039][1039]/[#1040][1040] (Bank methods), [#435][435]/[#640][640] (Appearance confirmations),
[#1122][1122] (Bitwarden availability), and [#1196][1196] (Hermes checklist gaps). A feature
unavailable on a required deployment is blocked; milestone-2 providers may be
recorded as deferred rather than falsely enabled. Track changed status and
confirmation decisions in this record.

## Hermes and delivery

| Required check | Deployment/Environment / date/operator | Observation / sanitized evidence | Result |
| --- | --- | --- | --- |
| Butler only; selected receiver version; librarian parked | owed | saved deployment/config/reference, live inventory | owed |
| Same Claude identity/subscription; live GET /v1/models Account-qualified selection | owed | identity/model/routing evidence, no secret | owed |
| program scopes read, sessions:write, runs:drive; bypassPermissions Ceiling; configured OpenBao reference | owed | scopes/clamps/reference, other programs acceptEdits | owed |
| Streaming, tools, two-turn same Session/credential, model/effort and auxiliary overrides, /keep, /save | owed | [#1193][1193] scripted results plus separate live proof; title generation gated | owed |
| Signed delivery-only route, Matrix destination, signature/body/timestamp rejection, lost-ack stable-id retry | owed | [#1009][1009] checklist, room/message ids, attempts; any other failure blocks | owed |
| Existing alert routes retain their configured state, including disabled routes remaining disabled; Matrix rooms and homeserver deployment preserved; fault injection removed | owed | before/after state and restore checks | owed |

For the two receiver failure modes below, record the maintainer's explicit
acceptance for the observed pinned deployment in the private acceptance record.
This is not a blanket retry waiver. Both live probes remain owed; attach
observed status/attempt/message ids, deployment version and date. Any other
failure, missing approval or unrun probe still blocks acceptance.

| Accepted known gap on pinned Hermes selected receiver version | Expected limitation | What was observed live / operator / date / evidence | Acceptance and upstream tracking |
| --- | --- | --- | --- |
| Deduplication lost across receiver restart | Seen ids are in memory; a retry after restart may post a second Matrix message. | owed, not observed by this ticket | Explicit operator approval and upstream issue/evidence owed |
| Failed Matrix send counted as delivered on retry | Id retained before send: initial 502, retry 200 duplicate, harness delivered despite missing room message. | owed, not observed by this ticket | Explicit operator approval and upstream issue/evidence owed |

## Bank landing, scheduled Firings and retirement

| Bank | Clean source head / reconciled branches | Preview / prepared PR / owner approval | team owner heads-up issue/time | Landing day/head / green validator URL | Synced checkouts / read/search/reviewed-write evidence |
| --- | --- | --- | --- | --- | --- |
| notebook ([#1042][1042]) | owed | owed, [#1032][1032] review rule | inapplicable, personal Bank | owed | owed, [#1044][1044] bank verbs |
| meadowstudios ([#1043][1043]) | owed | owed, [#1032][1032] review rule | owed, before landing | owed, same day as notebook | owed, [#1044][1044] bank verbs |

| Environment / enabled Routine id | Account/Workspace/Ceiling/skills/delivery revalidation | Source schedule disabled evidence | Manual enable time / schedule / zone / next due | Scheduled Firing time / history / outcome / Session | Remaining wait |
| --- | --- | --- | --- | --- | --- |
| every enabled Routine, owed | owed | owed | owed | owed; Run-now/skip insufficient | owed |

| Machine/Environment | Source listeners / processes / Provider processes / scheduler absent | Autostart / updater disabled evidence | Restart/logon/container check time/result | Successful harness Client/Hermes exchange afterwards | Retained source/backup/lazy-history locators |
| --- | --- | --- | --- | --- | --- |
| every inventory row, including no-source | owed | owed | owed | owed | owed |

## Rollback and signature

- Saved state/deployment/credential-reference/scheduler snapshot locators and
  restore-check evidence per row: **owed**.
- If invoked: trigger, time/operator, harness Routines disabled, shared-directory
  Runs/Provider processes stopped before source resumed, Hermes restored, reviewed
  Bank revert PRs/validators/synced heads, source health evidence: **owed**.
- New harness Sessions retained with no reverse import; no automatic deletion.
  David's separate deletion approval and exactly which sources/backups/history,
  if ever given: **not given**.
- Remaining required/unrun checks, unresolved external failures, unknown coverage
  or unfired schedules: **owed — block signature**.
- Milestone-2 deferred providers/owner links; explicit inapplicability and only the
  two accepted pinned-Hermes observations: **owed**.
- David's acceptance signature and date, after all gates pass: **unsigned**.

[78]: https://git.systemtech.dev:5526/david/agent-harness/issues/78
[79]: https://git.systemtech.dev:5526/david/agent-harness/issues/79
[80]: https://git.systemtech.dev:5526/david/agent-harness/issues/80
[81]: https://git.systemtech.dev:5526/david/agent-harness/issues/81
[82]: https://git.systemtech.dev:5526/david/agent-harness/issues/82
[83]: https://git.systemtech.dev:5526/david/agent-harness/issues/83
[84]: https://git.systemtech.dev:5526/david/agent-harness/issues/84
[85]: https://git.systemtech.dev:5526/david/agent-harness/issues/85
[86]: https://git.systemtech.dev:5526/david/agent-harness/issues/86
[87]: https://git.systemtech.dev:5526/david/agent-harness/issues/87
[88]: https://git.systemtech.dev:5526/david/agent-harness/issues/88
[89]: https://git.systemtech.dev:5526/david/agent-harness/issues/89
[90]: https://git.systemtech.dev:5526/david/agent-harness/issues/90
[91]: https://git.systemtech.dev:5526/david/agent-harness/issues/91
[92]: https://git.systemtech.dev:5526/david/agent-harness/issues/92
[93]: https://git.systemtech.dev:5526/david/agent-harness/issues/93
[94]: https://git.systemtech.dev:5526/david/agent-harness/issues/94
[210]: https://git.systemtech.dev:5526/david/agent-harness/issues/210
[217]: https://git.systemtech.dev:5526/david/agent-harness/issues/217
[242]: https://git.systemtech.dev:5526/david/agent-harness/issues/242
[360]: https://git.systemtech.dev:5526/david/agent-harness/issues/360
[435]: https://git.systemtech.dev:5526/david/agent-harness/issues/435
[458]: https://git.systemtech.dev:5526/david/agent-harness/issues/458
[478]: https://git.systemtech.dev:5526/david/agent-harness/issues/478
[562]: https://git.systemtech.dev:5526/david/agent-harness/issues/562
[563]: https://git.systemtech.dev:5526/david/agent-harness/issues/563
[587]: https://git.systemtech.dev:5526/david/agent-harness/issues/587
[636]: https://git.systemtech.dev:5526/david/agent-harness/issues/636
[640]: https://git.systemtech.dev:5526/david/agent-harness/issues/640
[731]: https://git.systemtech.dev:5526/david/agent-harness/issues/731
[743]: https://git.systemtech.dev:5526/david/agent-harness/issues/743
[764]: https://git.systemtech.dev:5526/david/agent-harness/issues/764
[813]: https://git.systemtech.dev:5526/david/agent-harness/issues/813
[831]: https://git.systemtech.dev:5526/david/agent-harness/issues/831
[858]: https://git.systemtech.dev:5526/david/agent-harness/issues/858
[877]: https://git.systemtech.dev:5526/david/agent-harness/issues/877
[913]: https://git.systemtech.dev:5526/david/agent-harness/issues/913
[922]: https://git.systemtech.dev:5526/david/agent-harness/issues/922
[925]: https://git.systemtech.dev:5526/david/agent-harness/issues/925
[944]: https://git.systemtech.dev:5526/david/agent-harness/issues/944
[981]: https://git.systemtech.dev:5526/david/agent-harness/issues/981
[988]: https://git.systemtech.dev:5526/david/agent-harness/issues/988
[1009]: https://git.systemtech.dev:5526/david/agent-harness/issues/1009
[1022]: https://git.systemtech.dev:5526/david/agent-harness/issues/1022
[1027]: https://git.systemtech.dev:5526/david/agent-harness/issues/1027
[1028]: https://git.systemtech.dev:5526/david/agent-harness/issues/1028
[1029]: https://git.systemtech.dev:5526/david/agent-harness/issues/1029
[1032]: https://git.systemtech.dev:5526/david/agent-harness/issues/1032
[1033]: https://git.systemtech.dev:5526/david/agent-harness/issues/1033
[1034]: https://git.systemtech.dev:5526/david/agent-harness/issues/1034
[1036]: https://git.systemtech.dev:5526/david/agent-harness/issues/1036
[1038]: https://git.systemtech.dev:5526/david/agent-harness/issues/1038
[1039]: https://git.systemtech.dev:5526/david/agent-harness/issues/1039
[1040]: https://git.systemtech.dev:5526/david/agent-harness/issues/1040
[1042]: https://git.systemtech.dev:5526/david/agent-harness/issues/1042
[1043]: https://git.systemtech.dev:5526/david/agent-harness/issues/1043
[1044]: https://git.systemtech.dev:5526/david/agent-harness/issues/1044
[1122]: https://git.systemtech.dev:5526/david/agent-harness/issues/1122
[1129]: https://git.systemtech.dev:5526/david/agent-harness/issues/1129
[1164]: https://git.systemtech.dev:5526/david/agent-harness/issues/1164
[1165]: https://git.systemtech.dev:5526/david/agent-harness/issues/1165
[1166]: https://git.systemtech.dev:5526/david/agent-harness/issues/1166
[1167]: https://git.systemtech.dev:5526/david/agent-harness/issues/1167
[1168]: https://git.systemtech.dev:5526/david/agent-harness/issues/1168
[1169]: https://git.systemtech.dev:5526/david/agent-harness/issues/1169
[1171]: https://git.systemtech.dev:5526/david/agent-harness/issues/1171
[1172]: https://git.systemtech.dev:5526/david/agent-harness/issues/1172
[1173]: https://git.systemtech.dev:5526/david/agent-harness/issues/1173
[1174]: https://git.systemtech.dev:5526/david/agent-harness/issues/1174
[1176]: https://git.systemtech.dev:5526/david/agent-harness/issues/1176
[1177]: https://git.systemtech.dev:5526/david/agent-harness/issues/1177
[1178]: https://git.systemtech.dev:5526/david/agent-harness/issues/1178
[1179]: https://git.systemtech.dev:5526/david/agent-harness/issues/1179
[1180]: https://git.systemtech.dev:5526/david/agent-harness/issues/1180
[1181]: https://git.systemtech.dev:5526/david/agent-harness/issues/1181
[1182]: https://git.systemtech.dev:5526/david/agent-harness/issues/1182
[1183]: https://git.systemtech.dev:5526/david/agent-harness/issues/1183
[1184]: https://git.systemtech.dev:5526/david/agent-harness/issues/1184
[1185]: https://git.systemtech.dev:5526/david/agent-harness/issues/1185
[1186]: https://git.systemtech.dev:5526/david/agent-harness/issues/1186
[1187]: https://git.systemtech.dev:5526/david/agent-harness/issues/1187
[1188]: https://git.systemtech.dev:5526/david/agent-harness/issues/1188
[1189]: https://git.systemtech.dev:5526/david/agent-harness/issues/1189
[1190]: https://git.systemtech.dev:5526/david/agent-harness/issues/1190
[1191]: https://git.systemtech.dev:5526/david/agent-harness/issues/1191
[1192]: https://git.systemtech.dev:5526/david/agent-harness/issues/1192
[1193]: https://git.systemtech.dev:5526/david/agent-harness/issues/1193
[1194]: https://git.systemtech.dev:5526/david/agent-harness/issues/1194
[1195]: https://git.systemtech.dev:5526/david/agent-harness/issues/1195
[1196]: https://git.systemtech.dev:5526/david/agent-harness/issues/1196
[1197]: https://git.systemtech.dev:5526/david/agent-harness/issues/1197

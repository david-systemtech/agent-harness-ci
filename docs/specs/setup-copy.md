# Set up copy: the style guide and every string of the walk-through and the Set up checklist

Status: decided 2026-10-08 for the Set up rewrite. This file is the single source of the words and the page shapes of the
first-launch introduction, the Set up checklist (rail, step cards, footer), the Settings › Set up pane and the header chip,
and of every check line the environment's Set up checks write. Builders copy the strings exactly; `{x}` is a value filled in.
Where this file and another spec disagree on words, this file wins; behaviour stays the other spec's unless §3 says otherwise.
Source keys in [brackets] name the public guidance each rule rests on (GOV.UK, Microsoft, Apple, Google, NN/g, W3C WCAG/APG;
the list is at the end).

## 1. Style guide

1. Write for someone who has never used a coding agent. Use everyday words. A technical word that must stay is explained once,
   in one sentence, inside the step's "What is this?" [GOVUK-clear][PL-jargon][18F-plain].
2. One idea per sentence. At most 20 words a sentence and 2 sentences a message; aim at US grade 7 [GOVUK-clear][SHOPIFY-content].
3. A message says, in this order: what happened; why it matters, only when that is not obvious; the one thing to do next, with
   a button that does it [WIN-errors][G-err-summary][NNG-errors].
4. A step page does one thing. Its heading is the question or the purpose, under "Step {n} of 11"; then one line saying why;
   then the controls; then the status line [GOVUK-form][GOVUK-question][WIN-wizards][WAI-multipage].
5. Pre-select the sensible choice. Anything most people never change sits in one "More options" fold, never two levels deep
   [WIN-wizards][NNG-defaults][NNG-progressive].
6. One button per action, named by what it does ("Sign in", "Bring them over", "Add GitHub"). Never "OK", "Submit" or "Next".
   Moving on is always "Continue"; the last step's is "Finish set up" [GOVUK-question][WIN-wizards][ATL-errors].
7. No raw ids, paths, settings keys, error codes, HTTP statuses, method names, ISO or UTC times, JSON, commands or program output
   in the main text. They go in "Details", which always has "Copy details" [WIN-errors][ATL-errors][GOVUK-details].
   What the person must type or copy (a pairing code, a folder to paste, a command they chose to run) is shown in mono with Copy [18F-technical].
8. Numbers only when the person needs them: a code, the time left, how many things will move. Times read the person's clock:
   "today at 16:24", "2 hours ago" (the `times` rule of #1742) [POLARIS-errors].
9. Say what to do, not the rule: "Enter a name", not "A label is one line of up to 200 characters" [APPLE-writing][GOVUK-errors].
10. Do not write: invalid, illegal, failed, error, fatal, abort, oops, simply, just, easy, quickly; "please" only for an
    inconvenient ask; "sorry" only for a serious problem the app caused; no jokes; "!" only on success [WIN-errors][GOVUK-errors][G-words].
11. Call the person "you". The app is "agent-harness", or "we" only when it did something or caused the problem. Never "I" for the
    app; an option the person picks may say "I" ("I'll set up later") [GOVUK-tone][WIN-wizards][POLARIS-errors].
12. Positive contractions are fine ("you'll", "it's"); spell out negatives ("cannot", "is not") [MS-top10][GOVUK-ui].
13. Name a control by its exact label and say where before what; never colour or position alone [MS-steps][G-ui].
14. Notices follow look.md: on a card the Alert of §5.3 (icon, title of 3 to 6 words, one or two sentences, the action button);
    above the window the banners of §11.3. Use the error tone only when the person must act. Never show one message twice [APG-alert].
15. Every state is a word as well as a colour: "Done", "Needs a fix", "Not set up", "Checking". A failure notice is role=alert with
    a hidden "Error:" prefix; progress is role=status [WCAG-3.3.1][WCAG-4.1.3][GOVUK-errors].
16. Nothing lives only in a tooltip. A disabled button shows its reason as visible text beside it [WCAG-3.3.2][look.md §11.2].
17. Keep what the person typed after a refusal; put focus on the message or the field it names [GOVUK-validation][WAI-notifications].
18. "Explain Like I'm 5" means short, concrete and friendly, every word known to someone who does not program, every instruction a
    single action. It does not mean baby talk, "simply", vagueness, hiding what happened, or leaving out the fix: the plain line
    still names the account, the folder or the site, and Details keeps the whole truth [PL-principles][HO-readability][G-tone].
19. One word for one thing, everywhere: §2 [SHOPIFY-content].

## 2. Words

| Use | Not | "What is this?" sentence (first use on a step) |
| --- | --- | --- |
| this computer / {name} | environment, home environment, machine, client | agent-harness runs a small background service on each computer you set up. It runs your agents and keeps your sessions, even when this window is closed. |
| this app | client, this client, this window (as an actor) | — |
| pair, pairing code | exchange, grant, minter, scope, ceiling | Pairing connects this app to agent-harness on another computer. You copy a one-time code from that computer. |
| Claude account | provider account, account directory, adopted | — |
| use this sign-in | adopt, adopted in place | — |
| forge (code host) | origin, alias, capability | A forge is a website that keeps your code, like GitHub, Forgejo or Gitea. |
| token | credential (except in Details) | A token is a long password that a website makes for apps. You copy it from the site and paste it here. |
| key manager | connection, injection, mount, AppRole, CA (outside More options) | A key manager keeps passwords and keys in one safe place, like OpenBao, Doppler, 1Password or Bitwarden. Most people can skip this step. |
| memory bank (notebook) | BANK.md, manifest, validator, landing, orientation, entities | A memory bank is a notebook your agents keep. It is stored as a private repository on your forge, or on this computer only. |
| skill, skill collection | source, track, probe, pin, member, shadowed, invocation | A skill is a short guide an agent can follow, like "review this code". A collection is a folder of skills that agent-harness keeps up to date. |
| instructions, your notes | orientation block, owned copy, appended | Instructions are notes every agent reads before it starts. |
| what agents are told about this computer | orientation, registries | — |
| sandbox | containment, namespace, bubblewrap (outside Details) | A sandbox keeps an agent's commands inside the project folder, so they cannot change the rest of the computer. |
| always-ask list | denylist, preset, pattern | The always-ask list names things an agent must always ask you about, like your SSH keys. |
| how much agents may do without asking | mode id, ceiling, clamp, bypassPermissions | — |
| Tailscale | tailnet, bind, loopback, LAN binding | Tailscale is a free app that links your own devices privately over the internet. |
| local network | LAN, IPv4, IPv6 (outside Details) | — |
| update, check for updates | release channel, drain, launcher, host-side updater (outside Details) | — |
| Check again | Check now, Re-run, Verify now | — |

## 3. Shared shapes and patterns (every step)

- **Step page.** "Step {n} of 11" (small, muted) above the title; the title (the question); one "why" line; a "What is this?"
  fold holding §2's sentences for the step; the controls; one "More options" fold; the status line. The footer is Back, Skip for
  now, Continue (Finish set up on step 11). Cross-step fixes move inside Set up ("Go to Forges") rather than to Settings.
- **Status line.** A state word with its icon (Done, Needs a fix, Not set up, Checking, Not checked yet), then the line. A line
  that needs a fix is a notice (§1.14) with the fix buttons in place and Details. "Open in Settings" (ExternalLink icon, with the
  visible hint "Leaves Set up") replaces "Open {row}". Any other button that leaves Set up for Settings says so in its label:
  `{its words} (leaves Set up)`. One **Check again**, whether or not the result offers it. A needs-a-fix notice takes the warning
  tone (the state's amber); a check or a start that did not run takes the error tone. An action's outcome is a notice too:
  information when it went ahead, the error tone with the refusal mapper's line when refused; a refused tool's own command sits
  inside its Details under `Or run this yourself on {computer}:`, in mono with Copy.
- **Details and Copy details.** Details shows the check ids, the environment's raw words (`details` on the result), and when it
  was checked. Copy details copies:
  `agent-harness {app version} on {platform}` / `Computer: {name} (agent-harness {version})` / `Step: {label} ({step id}): {state}` /
  `Checked: {ISO time}` / `What we saw: {line}` / `Checks: {failing ids}` / `Details:` then `{details}`, one per line. A line
  whose value is not known (no step, no check yet, no failing checks, no details) is left out. Details shows the same lines,
  so a refused copy leaves them to select.
- **Patterns** (old → new):

| Old (where) | New |
| --- | --- |
| `Could not check {id}: {error}.` (environment/src/setup/check.ts) | `agent-harness could not finish checking this step. Choose Check again.` Details: `{id}: {error}` |
| `could not check: timed out after {n} s` (check.ts) | `Checking took too long. Choose Check again.` Details: `Stopped after {n} seconds.` |
| `{key} does not hold a valid value.` (contracts/src/steps.ts) | `A saved setting for this step cannot be used: {setting label}. Set it again in Settings.` Details: `{key}` |
| `Checking…` / `Not checked yet.` (client-runtime/src/setup/checklist.ts) | `Checking…` / `Not checked yet. Choose Check again.` |
| `{reason} (checked {age})` / `(unchanged since {time})` | `{reason}` then a second muted line `Last checked {age}.` / `No change since {time}.` |
| `{reason} (stale, …)` | `{reason}` then `This may be out of date: {name} cannot be reached.` |
| `Last good, checked {age}: {reason}` | `Last time it worked ({age}): {reason}` |
| `{name} is not running: its results are from before it stopped.` + Start | `agent-harness is not running on {name}. These results are from before it stopped.` + **Start** |
| `{name} has not been reached since {time}: its results are from before.` | `This app cannot reach {name} (since {time}). These results may be out of date.` + **Try again** |
| `{name} has not been reached yet.` | `This app has not reached {name} yet.` + **Try again** |
| a failed `setup.check` (silent today) | `agent-harness could not run the check. Choose Check again.` Details: the refusal |
| a failed Start (silent outside the introduction) | `agent-harness did not start on {name}. Choose Start to try again.` Details: the failure |
| `This client was paired with {env} without the {scope} scope.` (client-runtime/src/capabilities.ts) | `This app has limited access to {env}, so it cannot {verb}. Pair again with full access to change this.` verbs: admin `change settings or sign in accounts`; terminal `use terminals or files`; sessions:write `start sessions`; runs:drive `run agents`; read `see what is on it`. Details: `{scope}` |
| `{env} does not offer {flag}; a version that does is needed.` | `{env} runs an older agent-harness without this. Update {env} to use it.` Details: `{flag}` |
| `This client cannot {purpose}: its shell has no {member}.` | `This app cannot {purpose} here.` + the alternative where there is one (`Copy the link instead.`, `Paste the link instead.`, `Add a token instead.`, `Type the folder's path instead.`, `Select the text and copy it instead.`, `Connect to another computer instead.`). Details: `{member}` |
| `{env} is newer than this client: update this client.` (client-runtime/src/connections/block-words.ts) | `{env} runs a newer agent-harness than this app. Update this app.` |
| `{env} is older than this client: update {env} to this client's version.` / `…, and cannot update itself from here.` | `{env} runs an older agent-harness than this app. Update {env}.` / `… Update it on that computer.` |
| `This client's access to {env} was revoked: pair it again.` / `… expired: …` | `This app's access to {env} was taken away. Pair again.` / `This app's access to {env} has run out. Pair again.` (this computer's own: `Try again.`) |
| `Stored credentials for {env} could not be read: pair it again.` | `This app cannot read its saved key for {env}. Pair again.` |
| `The address kept for {env} now reaches another environment.` / `{env} is blocked.` | `The address saved for {env} now reaches a different computer.` / `This app cannot connect to {env}.` |
| `Read-only: {line}` | `You can look but not change this. {line}` |
| raw refusals `Not {verb}ed: {message}` | `{Plain line from the refusal mapper}` Details: `{message}`; the mapper (client-runtime) words each error code and reason; unknown ones read `Something went wrong. Choose {verb} to try again.` |
| text cut at 120 characters by `oneLine` (banks, skills cards) | never cut: the plain line is short and the rest is in Details |

- **Done lines without values.** Where §5's done line names a value the environment fills in, the step registry's own line (contracts
  `done`, shown only when the environment says nothing more) is the same line without it: Account `All your accounts are signed in.`;
  Carry over `Everything is already here.`; Your machines `This computer is ready.`; Forges `Your forges are connected.`; Key manager
  `Your key managers are connected.`; Memory bank `Your notebook is ready.`; Permissions `Set.`.
- **State words** (client-runtime STEP_STATE_WORDS and the dots): done `Done`; needs-attention `Needs a fix`; skipped `Not set up`;
  pending `Checking`. The wire states do not change.

## 4. Frame

### 4.1 Introduction (gui/src/setup/introduction.tsx)
The welcome block ("Welcome to agent-harness", the lede and the two intro cards) stays as approved. Under the intro cards add:
`Set up takes about 5 minutes. Have your Claude login ready.`

| State | Status line | Description | Buttons |
| --- | --- | --- | --- |
| starting | `Starting agent-harness on this computer…` | `This takes a few seconds.` | — |
| installing (first start) | `Installing agent-harness on this computer…` | `This happens once and takes about a minute.` | — |
| ready | `agent-harness is ready on this computer.` | `Choose Begin set up.` | **Begin set up** |
| failed: no service in this app | `agent-harness cannot start on this computer.` | `This copy of the app is missing a part. Reinstall agent-harness.` | Details, **Connect to another computer** |
| failed: the app's service will not run | same title | `This copy of the app has a part that will not run. Reinstall agent-harness.` | Details, **Connect to another computer** |
| failed: install | same title | `Installing the background service did not work. Choose Try again.` | **Try again**, Details |
| failed: start | same title | `The background service did not start. Choose Try again.` | **Try again**, Details |
| failed: no answer in 60 s | same title | `The background service started but did not answer. Choose Try again.` | **Try again**, Details |
| failed: status unreadable | same title | `agent-harness could not check the background service. Choose Try again.` | **Try again**, Details |
| off | `agent-harness is turned off on this computer.` | `Turn it on to run agents here, or connect to another computer.` | switch **Run agent-harness on this computer** |
| unavailable (no service in this app, e.g. a browser tab) | `This app cannot run agent-harness itself.` | `Connect it to a computer that runs agent-harness.` | **Connect to another computer** (replaces the raw `no-shell`) |
| stopped | `agent-harness is not running on this computer.` | `Choose Start.` | **Start** |
| reconnecting | `Reconnecting to agent-harness on this computer…` | `This happens by itself.` | — |
| stopping (draining, no update under way) | `agent-harness is stopping on this computer…` | `Choose Start once it has stopped.` | — (today this reads "restarting for an update") |
| restarting for an update this app knows of or the environment announced (`bye: updating`, from any client), or waiting on macOS's prompt for the saved key | the connection's own line (the update's progress, the prompt's, or `{name} is restarting for an update…`) | — | — |
| disabled on this client | the connection's own line, `{name} is disabled on this client.` | — | — |
| blocked | the block's plain line (§3 patterns) | its one fix | its fix button |

- "Begin set up" keeps its label in every state; while disabled the visible line beneath says `Available once agent-harness is ready.`
- "Pair instead" becomes **Connect to another computer**; "I'll set up later" stays. It is the one Connect to another computer
  button on the page, beside Begin set up, in every state; the table's states that name it point at that button.
- When the home is another computer that is ready and this one is not, a line beneath the description says
  `{name} is ready. Choose Begin set up.`
- "Start details" becomes **Details** with Copy details; the desktop's failure text is its content (desktop/src/service.ts gives a
  `kind`: no-artefact, unrunnable, install, start, status, no-answer, plus the raw text). A failure that carries no kind takes the
  kind of the step the window was on (reading the service's state, installing it, starting it).

### 4.2 Pairing dialog (gui/src/connections/pairing.tsx; also Your machines › Add a device)
Title `Connect to another computer`. Description `Paste the pairing link from the other computer.` Hint (visible, below the field):
`To get one, open Set up on that computer and choose Add a device. On a server, run agent-harness pair.`
Field `Pairing link` (no example value as placeholder), button **Pair**; **Scan a QR code** where a camera exists. Fold
`Type an address and code instead`: fields `Address`, `Pairing code`, button **Pair**.

| Old (client-runtime/src/pairing.ts, exchange.ts, discovery.ts; gui pairing.tsx) | New |
| --- | --- |
| `That is not a pairing link: it looks like http://<address>/pair#<code>.` | `That is not a pairing link. A pairing link ends with /pair# and a code.` |
| `"{x}" is not an address: give a host name or IP address and, if not {port}, its port.` | `Enter the other computer's address, like my-server or 192.168.1.20.` |
| `That is not a pairing code: it is ten letters and digits, like K7Q2M-XH4RT.` | `A pairing code has 10 letters and numbers, like K7Q2M-XH4RT.` |
| `The pairing code has expired; ask the environment for a new one.` | `This code has run out. Make a new code on the other computer.` |
| `The pairing code has been used already; each code pairs one client.` | `This code was already used. Make a new code on the other computer.` |
| `The environment issued no such pairing code; check it and try again.` | `The other computer does not know this code. Check it, or make a new one.` |
| `Too many pairing attempts from this address; wait a minute and try again.` | `Too many tries. Wait one minute, then try again.` |
| `The environment is not ready yet; try again in a moment.` | `The other computer is still starting. Try again in a moment.` |
| `Nothing answered at {url}: {error}.` | `Nothing answered at {host}. Check that the other computer is on and that both are connected to Tailscale.` Details: url, error |
| `The environment speaks protocol {n} and this client {m}: update …` | `This app and {name} run versions that cannot talk. Update {this app or name}, then pair again.` Details |
| `The environment refused the pairing (HTTP {n})…` / `answered, but not as an agent-harness environment` | `{host} did not accept the pairing. Make a new code and try again.` / `{host} is not running agent-harness.` Details |
| `This browser client may not contact {origin}. To allow it, add …` | `This page is not allowed to connect to {name}. Ask whoever runs {name} to allow this page.` Details: both lists |
| `{name} is paired already. Pair it again in place?` | `{name} is already connected. Connect again?` **Connect again** / **Cancel** |
| `Paired with {name}.` | `Connected to {name}.` **Set up {name}** / **Close** |
| `macOS is asking to let agent-harness use its saved key. Look for the system dialog …` | `Your Mac is asking to use agent-harness's saved key. Find the Mac's dialog and choose Always Allow.` |
| `Not paired: macOS asked … then Try again.` / `… this one was used.` | `Your Mac's question was not answered, so pairing stopped. Choose Always Allow, then Try again.` / `… then make a new code: this one was used.` |
| `Not paired: {thrown}` / `Not scanned: {thrown}` | `Pairing did not work. Try again.` / `The QR code could not be read. Paste the link instead.` Details |
| `{name} is this machine's local environment: it connects through its grant, with no code.` | `That link is for this computer. This app is already connected to it.` |
| `That code is for {x}, not {y}.` (pairing {y} again) | `That code is for {x}, not {y}. Make a new code on {y}.` |
| `This device cannot keep a client session token: the OS keeps no key for it now. Unlock or set up the system keychain, then pair again.` | `This device has no safe place to keep the connection. Unlock or set up its keychain, then pair again.` Details |
| `Full access could not be confirmed. Use a full-access code made for Me. …` (Give this phone full access) | Unchanged. Details: what the code granted and what the new connection holds |
| `The environment that answered is {x}, not the one its address named.` | `That address reaches a different computer than the one that made the code. Make a new code and try again.` Details |
| `Use the environment's HTTPS pairing link or HTTPS address. HTTP connections are unavailable in the browser.` | `Use the other computer's HTTPS pairing link or HTTPS address. This page cannot connect over HTTP.` Details: the address |

### 4.3 Close dialog (gui/src/setup/checklist-window.tsx)
Words stay: `Leave set up without an account?` / `You can look around, but you will need to sign in before starting a session. Set up will be waiting in Settings.` / **Keep setting up** / **Leave for now**. It asks about the HOME computer's accounts, not the one picked.

### 4.4 Checklist frame (checklist-view.tsx, step-card.tsx)
- Header: `Set up` · `Setting up:` {picker} (replaces the label "Environment") · **Close**.
- Rail rows: number, label, hint, the state word (§3), and the tag `Required` / `Optional`. Hints (contracts STEP_HINTS):
  Account `Sign in to Claude`; Carry over `Bring your past chats`; Your machines `Use it from other devices`; Forges `Connect GitHub and others`;
  Key manager `Use your key manager`; Memory bank `A notebook agents keep`; Skills `Ready-made agent skills`; Instructions `Notes every agent reads`;
  Browser `Let agents use Chrome`; Permissions `When agents must ask`; Appearance `Light, dark and colours`.
- A step the computer's version does not have: state `Not available`, line `{name} runs an older agent-harness without this step. Update {name} to set it up.`
- No computer picked: `Choose a computer to set up.`; still loading: `Reading {name}'s setup…`.
- Footer: **Back**, **Skip for now**, **Continue**; step 11 **Finish set up**. On Account, Skip and Continue are disabled and the
  visible line beside them reads `Sign in to continue. Account is the one required step.`
  Once an account is signed in, Continue is enabled and Skip stays disabled, so the line reads `Account is the one required step.`

### 4.5 Settings › Set up pane (setup-pane.tsx) and header chip (setup-line.tsx)
- Counts: `{d} done · {n} need a fix · {s} not set up` (`· {p} checking` while any). One-word forms: `1 needs a fix`.
- **Check everything again** (busy: `Checking…`, disabled while running). All pass: `Everything on {name} is set up.` (skipped steps
  count as fine). Failure: `agent-harness could not check {name}. Choose Check everything again.` + Details.
- **Open Set up** (was "Open the full checklist"); **Set up another computer** (was "Set up another machine").
- Each row: number, state word, label, line (whole line on hover and focus). Choosing a row opens Set up at that step.
- Header chip: `Set up: {n} to fix` (never cut: the chip grows to fit); it opens Set up at the first step that needs a fix.
- After Check everything again opens Set up on a step, that step's card says `Checked just now.` above its notice, so the jump is explained.
- Terminal UI `/setup`: header `Set up on {name}: {d} of {m} done, {n} {needs|need} a fix ({steps}).`; the closing line
  `Press Enter on a step to run its fix, or open Set up in the desktop app.` (was "Run it in the desktop window."); state words as §3,
  a step's second line after its line on the same row. A refused check: `agent-harness could not check {name}. Run /setup to try again.`
  and, dim beneath, `Details: {the refusal}` (the terminal has no Check everything again; `/setup` checks again).

## 5. The steps

Each step: title / why / What is this? / controls / lines (done, not set up, needs a fix) / messages old → new. Old texts are
quoted from the files named; a builder greps for them.

### 5.1 Account (gui/src/accounts/account-step-card.tsx, adopt-offer.tsx, accounts-pane.tsx; environment/src/accounts/step-checks.ts)
- Title `Sign in to Claude`. Why `Your agents work through your Claude account.` Required.
- Controls, one question: `How do you want to sign in?`
  - When Claude Code on this computer is signed in: choice `Use the Claude Code sign-in on this computer ({email})` with **Use this sign-in**
    (pre-selected). The label is the email; renaming is in More options.
  - When Claude Code is here but signed out: line `Claude Code is on this computer but not signed in. Sign in below instead.`
  - Always: **Sign in with Claude** (opens §5.2 with the label taken from the email after sign-in; "Label for the new account" moves to More options).
  - Another computer's account: `{email} is signed in on {computer}. Each computer signs in on its own.` **Sign in here too**.
- Account rows: label, email, `Signed in` / `Signed out` / `Sign-in ran out`; buttons **Sign in again**, and in More options **Rename**, **Remove…**.
  The folder path and the plan readings are in Details.
- After the first sign-in: `New sessions will use {model name} with high effort. You can change this in Settings.` The default
  account, model and effort pickers sit in More options.
- Lines: done `{label} is signed in.` / `All {n} accounts are signed in.`; none `No Claude account yet. Sign in to start.`;
  signed out `{label} is signed out. Sign in again to use it.`; expired `{label}'s sign-in has run out. Sign in again to keep using it.`;
  unreadable `agent-harness could not read {label}'s sign-in. Choose Check again.` (offers Check again, not Sign in again; Details: the read's error);
  several `{n} accounts need to sign in again: {labels}.` (one button each).

| Old | New |
| --- | --- |
| `No account is added on this environment: Sign in adds one.` | `No Claude account yet. Sign in to start.` |
| `<reach>: this window has read none of its accounts.` / `…as this window last read them, read-only.` | `This app cannot reach {name} right now. Accounts show once it can.` / `These are the accounts from {time}. You cannot change them until {name} is back.` |
| `Not adopted: The machine's own Claude Code directory is not signed in (…); … call accounts.probe.` | `Claude Code on this computer is not signed in. Sign in with Claude instead.` Details |
| `Not adopted: … already added as {holder}.` | `This sign-in is already used by {holder}.` |
| `… The label {label} is taken by another account …, ignoring case.` | `Another account is already called {label}. Choose another name.` |
| `A label is one line of up to 200 characters, with no space at either end.` | empty: `Enter a name.`; too long: `Use 200 characters or fewer.` |
| `{label} was added on {env}, but its sign-in did not start: {message}` | `{label} is added. Its sign-in did not start because another sign-in is running. Finish that one first.` (other causes: the mapper) |
| `The accounts could not be read: {msg}` / `No account is held here.` | `agent-harness could not read the accounts. Choose Check again.` Details / (dropped: the empty state is the question above) |
| `Model family set to {family} at high effort, the strongest {label} offers.` | `New sessions will use {model name} with high effort. You can change this in Settings.` |
| `The model family and effort were not preset: {why}` | `Choose a model for new sessions in More options.` Details |
| `{id} (no longer held: runs take the first account)` | `{label} was removed. New sessions use your first account.` |

### 5.2 The sign-in dialog (gui/src/accounts/sign-in-card.tsx; client-runtime/src/status/sign-in.ts; environment/src/accounts/signin-director.ts)
- Title `Sign in to Claude` (on another computer: `Sign in to Claude on {name}`).
- This computer: `A Claude page opened in your browser. Sign in there and choose Authorize. This window finishes by itself.`
  Then fold `The page did not open?` holding the numbered steps below.
- Another computer, or the fold: numbered steps
  1. `Open the Claude sign-in page.` **Open the sign-in page** · **Copy link** · the QR (`Or scan this with your phone.`)
  2. `Sign in and choose Authorize.`
  3. `Copy the code the page shows and paste it here.` field `Code` · **Paste from clipboard** · **Sign in**
- Time: `{m} min left` (muted); at 1 min `Less than a minute left.`
- The terminal command moves to fold `Sign in from a terminal instead` with its Copy.
- The full URL is never shown as text (Copy link and Details only).

| Old | New |
| --- | --- |
| `Finish signing in in the browser on this machine. This dialog completes automatically. If no browser opened, …` | as above |
| `Paste the full code from the provider page (code#state).` | `Paste the whole code from the Claude page. It has a # in the middle.` |
| `This code belongs to another sign-in. Copy the code from this sign-in page.` | `This code is from a different sign-in. Copy the code from the page you just opened.` |
| `Clipboard access was refused. Paste the code into the field instead.` | stays |
| `Checking the code…` | stays |
| `The code was not taken: {message}` | `Claude did not accept this code. Start the sign-in again.` **Start again** Details |
| `The sign-in of {label} failed: {error}.` | `The sign-in did not finish. Choose Start again.` Details (no doubled full stop) |
| `The sign-in of {label} expired: …` | `The sign-in ran out of time. Choose Start again.` |
| `The sign-in of {label} was cancelled.` | `The sign-in was cancelled.`; when the system cancelled it: `The sign-in stopped because agent-harness restarted. Choose Start again.` |
| `{label} was not signed in: A sign-in is already running for {holder}; cancel it, or wait …` | `Another sign-in is running for {holder}. Finish or cancel it first.` |
| `This client cannot open links in the system browser: its shell has no shell.openExternal.` | `This app cannot open your browser here. Choose Copy link instead.` |
| `{label} is signed in on {env}.` + Done | `{label} is signed in.` **Done** |
| `Sign in again` disabled with `Finish or cancel the open sign-in first.` | stays |

### 5.3 Carry over (gui/src/carry-over/*; environment/src/carry-over/step-checks.ts)
- Title `Bring over your past work`. Why `Your old Claude Code chats and notes can come with you.`
- What is this? `agent-harness can copy your past Claude Code chats, notes and skills from this computer. Nothing is deleted or changed where they came from.`
- Nothing found: `Nothing to bring over from this computer.` + `You can continue.` (state Not set up; no other text on the card).
- Found: one summary sentence per Claude Code sign-in: `{label}: {n} past chats, {m} notes folders, {k} skills.` and one primary
  **Bring them over** (all accounts and the earlier-work import together; skills ticked). Counts per kind sit in fold `What will come over`.
- Fold `What will not come over` holds the list: `Your Claude Code settings, hooks and plugins`, `Personal MCP servers and permission rules`,
  `Subagents`, `Prompt history`, `Repository trust` and the line `Claude Code keeps all of these. You can set them up again in agent-harness when you need them.`
- After: `Brought over {n} chats and {m} notes folders.`; nothing new: `Everything is already here.`; later new chats: **Bring over {n} new chat(s)** (singular for 1).
- Earlier work found in a folder (state import): `Earlier work found in {folder name}: {counts in words}.` **Preview** (was Dry run) and **Bring it over**.
  Preview result: `This would bring over: {counts}. Nothing has been changed yet.` + **Bring it over**.
- Lines: skip `Nothing to bring over from this computer.`; found `Found earlier work you can bring over: {counts}.`; done `Brought over {when}.`;
  never imported `{label} has past chats to bring over. Choose Bring them over.`; unreadable `agent-harness cannot open {label}'s Claude Code folder.
  Check that it still exists, then choose Check again.` Details: path and error; part failed `{n} items from {label} did not come over. Choose Try again.`
  Details: the list; earlier-work stopped `Bringing over your earlier work stopped before the end. Choose Continue bringing it over.`;
  earlier-work partial `{n} items from your earlier work did not come over. See what to do below each one.`;
  default waits `Your default account waits for {label} to sign in. Choose Sign in {label}.` (opens §5.2 in place); running `Bringing your earlier work over now…`.

| Old | New |
| --- | --- |
| `No adopted account's directory holds anything to carry, and no source data folder …` | `Nothing to bring over from this computer.` |
| `Past work found in {path}: … Not brought over yet.` | `Found earlier work you can bring over: {counts}.` |
| `Import` / `Import {n} new sessions` / `Import again: {label}` | **Bring them over** / **Bring over {n} new chat(s)** / (one button only) |
| `No new sessions.` | `Everything is already here.` |
| `The inventory could not be read: {msg}` / `The accounts could not be read: {msg}` | `agent-harness could not look at {label}'s past work. Choose Check again.` Details |
| (nothing while loading) | `Looking for past work…` |
| `Unmappable memory: {path}` + `Choose a repository` + `Assign memory: …` | `Notes from {project folder name} do not match a project here. Choose the project they belong to:` select · **Use for these notes** |
| `No repository identities on this environment yet.` | `Bring your chats over first. Then you can choose a project for these notes.` |
| `{name}: {url}, {folder}; branch …` + `Track as a source` | `{name} is a skills folder from {host}.` **Keep it up to date** Details: url, branch |
| `The harness copy of the skills is now the one to edit.` | only after skills came over: `Your skills now live in agent-harness. Edit them there.` |
| `Provider sign-in does not grant access to private skill repositories. …` (50 words, every failure) | per failed item, its own fix: `Connect a forge for {host}` → **Go to Forges**; `Skill {name} is missing` → **Go to Skills**; else Details |
| report headings `Carried`, `Re-enter`, `Arriving in milestone 2`, `Not carried` | `Brought over`, `Needs you`, `Not supported yet`, `Not brought over` |
| `Client-local values applied/not applied` + `…local grant…` | `Window preferences` · `Applied to this window.` / `These apply only on {name}'s own computer.` |
| `{label}: {raw store message}` failures; labels with doc paths or issue numbers | plain label + Details; no repository paths or issue numbers on screen |

### 5.4 Your machines (gui/src/machines/your-machines-card.tsx, reachability.tsx; environment/src/updates/*, setup/state-checks.ts)
- Title `Use agent-harness from other devices?` Why `Reach this computer's agents from your phone or another computer.`
- Question: `Only on this computer` (pre-selected while nothing else is paired) / `Also from my other devices`.
- With "Also": the reach verdict, one of
  - `Your devices can reach this computer through Tailscale.`
  - `Your other devices cannot reach this computer yet. Install Tailscale here and on your other devices.` **Get Tailscale** (opens tailscale.com/download) **Check again**
  - `Tailscale is installed but not connected. Open Tailscale and sign in, then choose Check again.`
  - `Tailscale is ready. Restart agent-harness to use it.` **Restart agent-harness** where the service can restart, else `It is used from the next start.`
  - then **Add a device** (§5.5).
- More options: name, icon and colour; switch `Use Tailscale` with `On: agent-harness uses Tailscale whenever it is installed.` (the switch is preset on, so it must not read as "Tailscale is working"); switch `Also allow devices on this Wi-Fi network` with `Anyone on this network could try to connect. They still need a pairing code.`;
  updates (`Update automatically`, channel `Stable` / `Beta`); link **All settings for this computer** (Settings › Your machines; leaves Set up).
  Browser origins, the sandbox list and the grant note are not on this card. A limited pairing shows one line `This app has limited access to {name}.` with **What does this mean?** (#1631's sheet).
- Lines: done `{name} is ready. It updates itself.` / `{name} is ready. Automatic updates are off.` / `{name} is ready. The host's updater keeps it up to date.` /
  pinned `{name} is ready. It stays on version {v}.`, and while the pin does not run yet (its update waits for idle, or never comes) `{name} is ready. It runs version {v0} and is pinned to {v}.`; restarting within its 30 minutes `{name} is restarting.` and the same second sentence; Details: `Version: {v0}` (the running version), `Updates: {on | off | pinned to {v} | by the host's updater}`, and `Tailscale address: {ip} ({tailnet name})`, `Local network address: {ip}` or `Reachable from: this computer only`;
  pending `Checking for updates. This takes about two minutes after start.`; late first check `The first update check is late. Choose Check again.`;
  not read `agent-harness has not checked for updates {in the last day | yet}. Choose Check again.`; read failed `agent-harness could not check for updates.
  Check the internet connection, then choose Check again.` Details; root `agent-harness runs as the administrator (root) account, which is unsafe. Restart it as your own user.` Details;
  behind `Version {v} is available. Choose Update now.` (pinned, while the pin runs: `{name} stays on {v} because it is pinned. {v2} is available.`;
  a pin that does not run and is neither on its way, blocked nor failed: `{name} is pinned to {v}, which could not be installed. Unpin it or pin another version.`
  with no Update now, which would install the pin again; Details: the versions and `To unpin: agent-harness update settings --pinned-version none`);
  late update `The update to {v} is waiting for running sessions to finish.`; host updater late `The update to {v} has not started. Check the updater on the host computer.`;
  launcher too old `Version {v} needs a newer installer. Reinstall agent-harness from the {v2} download.` ({v2} is the target, or the running version when its own newer installer is what is missing) Details: the command;
  update failed `The update to {v} did not work. {name} still runs {v0}. Choose Update now to try again.` Details;
  container never polled `This container is not kept up to date yet. Set up the updater on the host computer.` **How to set it up** (action `how-to-set-up`, on this line alone, #1883),
  which opens beside the line `Set up the updater on the host computer`: `On the computer that runs Docker, put compose.yaml and host-updater.sh from the same agent-harness release in one folder, such as /opt/agent-harness. Then, in that folder:`,
  each command to copy under its label, `Start agent-harness and make the updater runnable` `cd /opt/agent-harness && docker compose up -d && chmod +x host-updater.sh` and
  `Run the updater every five minutes: add this line with crontab -e, as the user that runs docker` `*/5 * * * * /opt/agent-harness/host-updater.sh >>/opt/agent-harness/host-updater.log 2>&1`,
  then `Once it has run, choose Check again. A systemd timer works too: docs/host-updater.md in that release's source has both.` **Close** (client-runtime/src/updates/host-updater-setup.ts);
  host updater stale `The host's updater last ran {when}. Check that it still runs every five minutes.`;
  no name `This computer has no name. Give it one in More options.`; draining long `agent-harness has been restarting for over 30 minutes. Choose Check again once it is back.`;
  starting `agent-harness is still starting. This takes a few seconds.`;
  network address gone `The network address {ip} is no longer on this computer.` **Use {held ip}** / **Turn off Wi-Fi network access** Details: addresses.
- Check again on this step, and any check this app asks for, reads the update channel again, as Check for updates does: a second ask within a
  minute answers that read. The environment's own hourly checks of the step read the last result.
- Update status words on the card (client-runtime/src/updates/words.ts): downloading `Downloading {v}…`; draining `Waiting for running sessions to finish before updating to {v}.`;
  ready (a container) `{v} is ready. The host's updater installs it.`

### 5.5 Add a device (gui/src/machines/add-a-machine.tsx, preset-pairing.tsx, pairing-code.tsx; client-runtime/src/access/presets.ts)
- Part 1 `Connect a phone or computer to this one`. Question `Who is it for?`
  - `Me` (pre-selected) `Your own phone or computer. It can do everything you can do here.`
  - `A phone with limited access` `It can chat with agents and answer their questions. It cannot open terminals or change settings. Agents on it edit files but ask before anything else.`
  - `A program or bot` `A tool such as a bot. It can start and follow sessions but not change settings.` + `How much may its agents do without asking?` (§5.12's four choices)
  - More options › `Custom` with ticks `See sessions` / `Start and organise sessions` / `Run agents and answer their questions` / `Use terminals, files and changes` / `Change settings and sign in accounts` and the four choices.
    With nothing ticked, beside the dimmed button: `Tick at least one thing it can do.`
  - **Make a pairing code** → `On the new device, open agent-harness and choose Connect to another computer. Scan this code or paste the link.`
    QR · `Pairing link` with Copy · fold `Type it instead`: `Address {host:port}` · `Code {CODE}` · `This code works once, for 10 minutes. {m} min left.`
    Expired: `This code has run out.` **Make a new code**.
    While this computer is reachable only from itself, above the button: `Other devices cannot reach this computer yet, so they cannot use a code made now. Set up Tailscale first.`
    and a code made anyway never offers a 127.0.0.1 link to another device; its line reads `This code only works on this computer.` A dimmed choice says why in words: `This app itself has limited access, so it cannot give more.`
    A code that could not be made: `Something went wrong. Choose Make a pairing code to try again.` Details: the refusal. Before this computer has answered:
    `This app has not reached agent-harness on this computer yet.`
- Part 2 `Connect this app to another computer`: the pairing form of §4.2.
- Part 3 `Install agent-harness on another computer`: numbered steps `1. On the other computer, open a terminal.` `2. Copy the line for its system and paste it.`
  `3. When it finishes, it shows a pairing link. Paste it in Part 2.` Lines `Mac or Linux`, `Windows (PowerShell)` with Copy; fold `Using Docker or Podman?`
  with: `1. Make a folder for it and open a terminal there.` `2. Copy this line and paste it.` `3. The pairing link appears in the container's log.`
  `4. To keep it up to date, set up the host updater.` **How to set up the updater**. A private release's token line sits under the numbered steps,
  above the lines, since every line reads the token: `This release is private. Before you paste a line, set AGENT_HARNESS_TOKEN to a token that can read it.`
  Name field `Name for the new computer (optional)`. While the release is read: `Checking which version to install…`; when it cannot be:
  `This app cannot tell which version to install yet.` Details: why.

### 5.6 Forges (gui/src/forges/*; environment/src/forge/*)
- Title `Connect GitHub or another forge`. Why `Agents can then open pull requests and read your private code.`
- Fastest path first: `Use your GitHub sign-in from the gh tool ({login})` **Use gh** (this computer's gh, or on another computer `Use the gh sign-in from this computer`).
- Else **Add a forge**: field `Address of the site or of one of your repositories` (for example https://github.com/you/project). The kind is
  found as you type; when it is not recognised: `agent-harness does not recognise this site. Choose what it runs:` GitHub / Forgejo / Gitea (sent with the add).
  Then `1. Create a token on {site}.` **Create a token** (opens the token page) and `Give it these permissions: {plain list}.`
  `2. Paste the token here.` field `Token` · **Add {site}**. `The token is kept on {computer}, not in this window.`
- Rows: `{login} on {host}`, `Main forge` badge or **Make main**, state word; capability list in words `Read code`, `Open pull requests`, `Write issues`,
  `Create repositories`, `Read releases` each `Works` / `Not allowed` / `Not checked yet`. Aliases sit in More options as `Other addresses for this site`.
- Lines: skip `No forge connected. Optional.`; done `{login} on {host} is connected.` / `{n} forges connected.`; no token `{host} has no token yet. Add one.` **Add token**;
  refused `{host} did not accept the token for {login}. Create a new token and add it.` **Add a new token**; unreadable `agent-harness cannot read the saved
  token for {login} on {host}.` + `Sign in to your key manager.` **Go to Key manager** (key-manager reference) or **Add a new token**;
  other user `The token for {host} belongs to {other}, not {login}. Add a token for {login}.`; unreachable `{host} did not answer. Check the internet connection, then choose Check again.`;
  missing permission `The token for {host} cannot {read code / read releases}. Create a new token with that permission and add it.` Details: statuses;
  still checking `Checking what the token for {host} can do.`; no main `Choose your main forge. New notebooks go there.` **Make main: {host}**;
  gh missing `The gh tool is not installed. Install it to use your GitHub sign-in.` **Install gh**; gh old `The gh tool is out of date.` **Update gh**;
  gh signed out `The gh tool is not signed in to {host}. Run gh auth login on {computer}, or add a token instead.` **Add a token instead** Details: the command;
  expiring `The token for {host} runs out {when}. Add a new one before then.`; needed elsewhere `agent-harness needed a forge for {host} and found none. Add {host}.` **Add {host}**.
- Add messages: GitLab `GitLab is not supported yet.`; unknown `agent-harness does not recognise this site. Choose what it runs.`; unreachable
  `agent-harness could not reach {host}. Check the address and the internet connection.` Details; duplicate `{host} is already connected.`;
  token refused `{host} did not accept this token. Check that you copied all of it, or create a new one.` Details; gh signed out `The gh tool is not signed in to {host}.` Details: the command.
- Changing the kind or looking the site up again keeps the token already typed (today it is emptied).
- Every environment line drops "in Set up, Forges" (the person is there) and moves HTTP statuses, user ids and times into Details.
- Lines the code needs beyond these (#1850): a forge that answered it cannot answer now (HTTP 5xx, a rate limit) `{host} is not answering properly right now. Choose Check again later.`,
  the unreachable line kept for no answer at all; the token run out `The token for {host} has run out. Add a new one.`; expiring's `{when}` is `in {n} days`, or `within a day`,
  the exact time in Details, and a forge account's own problem says `The token for {host} runs out soon. Add a new one before then.` (it is written once per verification);
  unreadable from a stored token without a key manager is the line without its second sentence; from gh `agent-harness cannot get the token for {login} on {host} from the gh tool.`,
  gh's own cause in Details; missing permission for both reads `The token for {host} cannot read code or read releases. Create a new token with those permissions and add it.`;
  gh not looked for yet `agent-harness has not looked for the gh tool yet. Choose Check again.`, gh failing `The gh tool did not give a token for {login} on {host}.`;
  {computer} in gh signed out is `this computer`; no main lists the forges to choose from in Details; needed elsewhere is also the refusal of an operation with no forge,
  what it was doing in Details. A token no forge account holds yet (a carry-over check) says only the first sentence. Add messages: another user on update
  `This token belongs to {found}, not {expected}. Add a token for {expected}.`; an address for this site that is not one `{alias} did not accept the token for {login}, so it is not another address for this site. Nothing was changed.` /
  `{alias} knows this token as another user, so it is not another address for this site. Nothing was changed.`; listing owners, a token the forge gives no list of organisations
  `The token for {host} cannot list organisations. Create a new token with that permission and add it.` (a refused token, a server error and no answer read as above, what the forge answered in Details);
  a token an older build recorded as another user's reads `The token for {host} belongs to another user, not {login}. Add a token for {login}.`, its old line in Details.
- **Move to your key manager** shows only while a key manager is connected, as **Keep this token in your key manager**.

### 5.7 Key manager (gui/src/key-managers/*; environment/src/key-managers/*)
- Title `Use a key manager?` Why `If you keep passwords and keys in one, agents can fetch them when they need them.`
- Question `Which one do you use?` `I do not use one` (pre-selected) / `OpenBao or Vault` / `Doppler` / `1Password` / `Bitwarden Secrets Manager`.
  When Connect is refused because this computer cannot sign in to that provider (`provider_unavailable`), the card says
  `agent-harness cannot connect to {provider} on this computer yet.` and marks that choice `Not available on this computer yet.` for the visit.
- OpenBao or Vault form: `Address` (hint `The address you open it at, like https://vault.example.com`), `How do you sign in?` `With a token` (pre-selected) /
  `With AppRole` / `With a username and password`; the fields for that choice; mount, token role and certificate under More options. Others: `Create a
  read-only token in {provider} and paste it here.` field `Token`. Button **Connect {provider}**.
- After: `Connected to {label}.`; `Let every run use {label}'s keys` switch with `You can turn this off for one account, routine or bot in Settings.`;
  **Move saved tokens** (only when agent-harness holds some): `agent-harness keeps {n} tokens itself. Move them into {label}?` field `Folder in {label}` (suggested) **Move them**.
- Lines: skip `No key manager connected. Optional.`; done `Connected to {label}.` / `{n} key managers connected.`; not signed in `{label} is not signed in yet.` **Sign in**;
  refused `{label} did not accept the sign-in. Sign in again with a working token.`; ran out `{label}'s token ran out {when}. Sign in with a new token.`;
  no answer `{label} did not answer. Check the address and the connection, then choose Check again.`; sealed `{label} is locked (sealed). Unlock it, then choose Check again.`;
  certificate `agent-harness does not trust {label}'s security certificate. Choose Check certificate to review it.` **Check certificate**;
  cannot make run keys `{label} lets agent-harness sign in but not make keys for agents. Ask whoever runs {label} to allow it.` Details: the path and a copyable policy line;
  tool missing `The {tool} tool is not installed on {computer}. Install it so agents can use {label}.` **Install {tool}**; tool old `The {tool} tool on {computer} is out of date. Update it so agents can use {label}.` **Update {tool}**;
  not ready (provider unavailable, signing in) `{label} is not ready yet. Choose Check again.` (these now count: the step is not Done while they show);
  references `Some forge tokens are kept in a key manager that is not connected here. Connect it.` Details: ids.
- Sign-in messages: refused `{provider} did not accept these details. Check them and try again.`; unreachable `agent-harness could not reach {address}. Check the address.`;
  certificate `agent-harness does not trust this site's certificate.` **Check certificate**; root `Use a token that is not the root token. agent-harness never uses root.`;
  sealed `{provider} is locked (sealed). Unlock it, then connect.`; all with Details.
- A connection added while it cannot be reached reads `Saved, but agent-harness could not reach {address}. Check the address, then choose Check again.` (never "Added …" followed by a failure).
- The "every run uses its keys" switch shows the same state here and in Settings › Key managers; a notice about a removed connection goes away with it.
- A connection's health is one line: `{state} since {time}. {fix}` with one button; never three sentences saying the same.

### 5.8 Memory bank (gui/src/banks/*, gui/src/setup/minted-session-card.tsx; environment/src/banks/*)
- Title `Give your agents a notebook`. Why `Agents write down what they learn, so the next session already knows it.`
- Question `What would you like?` `Create my own notebook` (pre-selected) / `Join my team's notebook` / `Create a notebook for my team`.
- Ready-to-go rows, visible (not tooltips): `Forge: {login} on {host}` `Ready` / `No forge yet.` **Go to Forges** or **Keep it on this computer**.
- Own notebook: `Name` (filled in), `What do you call your own work?` hint `Used as a folder name, for example personal.`, `Your first project` hint
  `For example the name of a repository you work on.` **Create notebook** · **Keep it on this computer for now**. An empty field says `Enter {field}.` on Create.
- Next: `Now describe your notebook. An agent asks a few questions and writes the description.` **Describe it** (the conversation opens large, #1623).
  Conversation states: `Writing the description…` / `Waiting for your answer` / `Saved` / `Saved. Waiting for your approval on {host}.` **Open the review**.
- Join: `Notebook link` **Preview** (`Reading the notebook…`) then `{name}: {line}` with `Owners`, `Projects` and `Shared with the team: no personal facts, no secrets.`;
  `Which of your accounts should use it?` (all ticked) **Join notebook**. Cannot read: `Your forge account cannot read this notebook. Ask an owner to add you.`
  Bad link: `That is not a notebook link. Paste the link an owner shared with you.`; nothing there, no forge account for the host: `agent-harness cannot see a notebook at this link. If it is private, add a forge for {host} first.`
  nothing there with a forge account: `There is no notebook at this link. Check it with whoever shared it.` (all with Details; never cut off)
- Lines: skip `No notebook yet. Optional.`; done `Your notebook is ready.` / `Your {n} notebooks are ready.`;
  unreachable, by cause: `{bank} needs a forge account for {host} on this computer.` **Go to Forges**; `Your {host} account is connected on {computer}, not here. Connect it here too.` **Go to Forges**;
  `The repository for {bank} is missing on {host}.`; `{bank}'s folder on this computer is missing.`; else `agent-harness cannot reach {bank}. Choose Check again.` (all with Details);
  no description `{bank} needs a description.` **Describe it**; description problem `{bank}'s description has a problem: {plain rule}.` **Fix the description**;
  waiting `{bank}'s description is waiting for your approval on {host}.` **Open the review**; summary names missing notes `{bank}'s summary names notes that do not exist.` **Fix the description**;
  owners `{host} does not know {login}, listed as an owner of {bank}.` **Fix the description**; saving failed `The last change to {bank} could not be saved to {host}.` **Check again** Details;
  conversation stopped `The describing conversation stopped.` **Continue it** · **Write it myself** · **Start again** Details: the provider's words.
- How the environment picks the unreachable cause (one per notebook, #1854): its folder is not on this computer; else no forge account here covers
  its forge (a notebook copied from another computer names that computer, `copiedFrom`); else its forge answers that the repository is not there;
  else the plain line. Details hold `{bank}: {what the check saw}`. Lines the code needs beyond the list above: a description problem's `{plain rule}`
  is one phrase per validator rule, the rule id and its message in Details (environment/src/banks/step-checks.ts `PLAIN_RULES`, for example retired_key
  `it uses keys from an older layout`, orientation_missing `its summary names a note that does not exist`, secret_shaped `it holds something that
  looks like a password`; a rule this build does not know `it does not follow the notebook's rules`); saving failed on a notebook kept on this computer only
  `The last change to {bank} could not be saved.`; a reviewed change other than the description `{bank}'s latest changes are waiting for your approval on {host}.`
  **Open the review**. The pull request's address is in Details.
- Refusals (each with Details: the raw message, statuses, git's words and paths; never in the line):
  join and preview, the forge did not answer `agent-harness could not reach {host}. Check the link and the internet connection.`; any other answer
  `{host} would not show this notebook to agent-harness. Try again in a moment.`; GitLab `GitLab is not supported yet.`; an account with a problem
  `Your account on {host} needs a fix first.`; the copy could not be read `agent-harness could not copy this notebook
  from {host}. Try again in a moment.`; too slow `Reading the notebook took too long. Try again.`; its description has a problem
  `This notebook's description has a problem, so it cannot be joined. Ask an owner to fix it.`; it holds a secret `This notebook holds something
  that looks like a password, so it cannot be joined. Ask an owner to remove it.`; a name already used `You already have a notebook named {name}.`;
  too big at start as Create (adding or turning on a notebook too)
  Create: `Enter a different folder name for each project.`; no main forge `Choose your main forge first, or keep the notebook on this computer.`
  **Go to Forges**; the chosen account gone `That forge account is no longer connected. Choose another one.`; an account with a problem
  `Your account on {host} needs a fix first.` **Go to Forges**; GitLab `GitLab is not supported yet.`; an owner not offered `Choose the owner from the list.`;
  the facts do not make a notebook `These answers do not make a notebook agent-harness can use. Check the names and try again.`; a missing part
  `This copy of agent-harness is missing a part. Reinstall agent-harness.`; a folder could not be set up `agent-harness could not set up the notebook's
  folder on this computer.`; the forge did not answer `agent-harness could not reach {host}. Check the internet connection, then try again.`; the
  repository was not made `{host} did not make the notebook's repository. Check that your token can create repositories.`; the first save
  `The repository was made on {host}, but agent-harness could not save the notebook to it.`; a notebook of that name
  `You already have a notebook named {name}.`; the answers hold a secret `Your answers hold something that looks like a password. Take it out and
  try again.`; a folder of that name `You already have a notebook or folder named {name}. Choose another name.`; creating is not offered `agent-harness on this computer cannot create notebooks.`;
  made already `This notebook was made already.`; too big at start `With this notebook, what agents read at the start would be too long. Turn another notebook off first.`
  Publish (move a notebook to your forge): no main forge `Choose your main forge before you move this notebook to it.` **Go to Forges**; an account with a
  problem, GitLab, a missing part, the forge did not answer and the repository was not made as Create; a description that cannot move
  `{bank} needs a working description before it can move to your forge.` **Fix the description**; a file that is not a plain file
  `A file in {bank}'s folder is not a plain file, so it cannot move.`; a file or follow-up holds a secret `{bank} holds something that looks like
  a password. Take it out before it moves to your forge.`; preparing `agent-harness could not get {bank} ready to move.`; the copy
  `The repository was made on {host}, but agent-harness could not copy {bank} to it.`; reading it back `{bank} is on {host}, but agent-harness
  could not read it back for your review. Choose Check again.`; gone `That notebook is not on this computer.`; already on a forge
  `{bank} is already on a forge.`; the review or a follow-up not taken `{host} did not accept the move of {bank}. Try again in a moment.`; turned off or read-only `Turn on {bank}, with changes allowed, before you move it.`; not offered
  `agent-harness on this computer cannot move notebooks to a forge.`; busy `{bank} is saving a change. Try again in a moment.`;
  changed `{bank} changed while it was being prepared. Try again.`
  Describe: no notebook named `Choose which notebook to describe.`; gone `{bank} is no longer one of your notebooks.`; its folder `{bank}'s folder on this
  computer is missing.`; its copy for describing `agent-harness could not get {bank} ready to describe. Choose Describe it to try again.`
  A conversation a step does not have `This step has no conversation to start.`; its subject gone `What this conversation was for is no longer here. Choose Check again.`
- Badges on a notebook: `Personal` / `Team`, `On` / `Off`, `On this computer only` / `On {host}`; the rest in Details. `Manifest: {state}` becomes `Description: ready / missing / has a problem / waiting for approval`.

### 5.9 Skills (gui/src/skills/skills-card.tsx, sources.tsx; environment/src/skills/*)
- Title `Add ready-made skills`. Why `Skills are guides agents can follow, like reviewing code or writing tests.`
- Catalogue: each card `{title}` `{one-line pitch}` `{n} skills` **Add** (added: `Added` with **Remove**); fold `Details`: licence, `Changes often`, size, the skill list.
  `You can follow up to 20 collections.` shows once, above the list, from 15 on.
- More options › `Add from a link`: `Repository address` **Look for skills** → `Found {n} skill folders:` ticks **Add selected**.
- Skill members, always-on switches and repository trust are not in Set up (Settings › Skills, link **All skill settings**).
- Lines: skip `No skills added. Optional.`; done `Your skills are up to date.` (own only: `Your own skills are ready.`); after Update now `{collection} is up to date.`;
  update failed `{collection} could not update. Choose Update now.`; out of date `{collection} has not updated for over 7 hours. Choose Update now.`;
  moved `{collection} no longer has skills where they were. Choose its folders again.` (card button **Choose folders**);
  too many `You follow {n} collections. The limit is 20. Remove {n-20}.`; own folder `agent-harness cannot open your own skills folder. Check that it exists.` Details.
- Probe messages: not an address `Enter the address of a repository, like https://github.com/you/skills.` (never "The params are not skills.probe's");
  git missing `Git is not installed on {computer}. Install Git, then try again.` (from spawn ENOENT); private `This repository is private. Add a forge for {host} first.` **Go to Forges**; missing `agent-harness found no repository at this address.`;
  slow `{host} did not answer in time. Try again.`; none `No skill folders were found there.`; all with Details for git's words.
- "Pull now" reads **Update now** everywhere in Set up.

### 5.10 Instructions (gui/src/instructions/*; environment/src/instructions/*)
- Title `Tell every agent how you work`. Why `Instructions are notes every agent reads before it starts.`
- What is this? `agent-harness already tells agents about this computer: your accounts, forges and notebooks. You can add your own notes too.`
- Controls: `Your note` (About my setup) with **Edit**; `Suggestions` as ticks with one line each; **Write your own**; fold
  `What agents are told about this computer` holding the preview and the switch `Tell agents about this computer` with
  `If you turn this off, agents will not know where your forges, keys and notebooks are.`
- Owned instruction lists, move up/down and account reach stay in Settings › Instructions.
- Lines: done `Agents get your notes and a summary of this computer.`; unread `agent-harness could not read part of this computer's setup: {step names}.`
  with **Go to {Step}** per name (environment→Your machines, accounts→Account, key-managers→Key manager, forges→Forges, banks→Memory bank, other-environments→Your machines);
  no account `Sign in on the Account step first. Agents are told about your accounts.`

### 5.11 Browser (gui/src/browser/*; environment/src/browser/*)
- Title `Let agents use your Chrome`. Why `Agents can open web pages in your own Chrome, with your logins.`
- What is this? `agent-harness adds a small extension to Chrome. Agents work in their own tab group, and some sites are always off limits. Only Chrome works for now.`
- Numbered steps, each ticking itself:
  1. `Copy this folder location.` {path} **Copy**
  2. `In Chrome, open chrome://extensions.` **Copy chrome://extensions** `Paste it in the address bar and press Enter.`
  3. `Turn on Developer mode, at the top of that page.`
  4. `Choose Load unpacked, paste the folder location and confirm.` Ticked: `Chrome found the extension.`
  5. (shown once step 4 ticks) `Choose the agent-harness extension's icon, then Options, and type this code:` {CODE} `{m} min left` (renews by itself; no Stop box)
  6. Optional: `Sites you are building` textarea, hint `One site per line, like localhost:3000. Agents may run scripts on these sites.`
  - **Use my Chrome for agents** (was Done); disabled line `Pair Chrome first (step 5).`; after `Agents now use your Chrome.`
- The listening address, the ports and the browser glossary go in Details / fold `How agents use Chrome`.
- Lines: skip `Chrome is not connected. Optional.`; done `Chrome is connected.`; closed `Chrome is closed, so agents cannot use it. Open Chrome. This updates by itself.`
  (Unpair is in More options, not offered as the fix); old extension `The Chrome extension is out of date. In chrome://extensions, choose reload on agent-harness.` **Copy chrome://extensions**;
  ports busy `Chrome cannot reach agent-harness because the ports it needs are busy. Close other apps, then restart agent-harness.` Details;
  files missing `The extension's files are missing from this install. Reinstall agent-harness.` Details; phone or web `Connecting Chrome works only in the desktop app.`

### 5.12 Permissions (gui/src/permissions/*; environment/src/permissions/*; contracts/src/settings.ts descriptions)
- Title `Choose when agents ask you`. Why `This is the most any session may do without asking. A session can always ask more often.`
- Choices (labels; the mode id goes to Details):
  - `Ask before any change` `Agents can read and plan. They ask before changing anything.`
  - `Edit files, ask for the rest` (badge `Recommended`) `Agents can edit files in your project. They ask before running commands.`
  - `Let Claude decide` `Claude reviews each action and asks you only when it is unsure.` (where the provider supports it)
  - `Never ask` (warning tone) `Agents act without asking. Use it only for trusted work in a sandbox.`
- More options `More safety settings`: `For scheduled and automatic runs` (same four); `If nobody answers a question` `Deny it after` 1 hour / 24 hours / 2 days / `Never deny it`;
  `Sandbox` `Off` / `Project folder` / `Project folder, no internet`, each `Works here` or `Needs setup` with fold `How to set it up` (the OS's command, copyable, then **Restart agent-harness**);
  `Always-ask list` (the four lists) and `Test the always-ask list`. The read-only "Permission bypass acknowledged" field is not shown.
- Lines: done `Set. Agents {are not sandboxed | stay inside the project folder | stay inside the project folder, offline}.` (+ ` You emptied the {section} always-ask list.`);
  sandbox unavailable `The sandbox you chose does not work on this computer yet.` **Turn the sandbox off** · fold `How to fix it` Details: the probe;
  presets missing `Some built-in entries are missing from the {section} always-ask list.` **Restore them**; root as §5.4.
- Messages: `Not saved: The containment level {x} cannot be enforced here: …` → `This sandbox does not work on this computer yet. See How to set it up.`;
  the bypass dialog title `Never ask on scheduled runs?` body `Agents will act without asking and can do anything your account can, inside the sandbox you chose.` **Never ask** / **Cancel**.

### 5.13 Appearance (gui/src/appearance/*; environment/src/appearance/contrast.ts)
- Title `Choose how the window looks`. Why `You can change this any time.`
- `Light or dark` `Match my computer` (pre-selected) / `Light` / `Dark` with `This applies to this device only.`; `Theme` Default / Ember / Lagoon as swatches.
- More options `Customise colours`: seeds named `Background`, `Accent`, `Code`, `Thinking`, `Success`, `Warning`, `Danger`, sliders `Colour` and `Strength`; Save, Import, Export.
- Lines: done `Your theme is easy to read.`; adjusted `Some colours in {theme} were adjusted so text stays readable.` **Use the Default theme**, which asks
  `Use the Default theme? Your colour changes to {theme} will be lost.` **Use Default** / **Keep {theme}**.

## Sources

The guidance behind the rules, read 2026-10-08 (the keys in brackets above).

- [PL-principles] Principles of plain language; GSA digital.gov; https://digital.gov/guides/plain-language/principles
- [PL-short] Short and simple; GSA digital.gov; https://digital.gov/guides/plain-language/principles/short-simple
- [PL-jargon] Avoid jargon; GSA digital.gov; https://digital.gov/guides/plain-language/principles/avoid-jargon
- [PL-writing] Writing for understanding; GSA digital.gov; https://digital.gov/guides/plain-language/writing
- [PL-clear-short] Clear and short; GSA digital.gov; https://digital.gov/guides/plain-language/writing/clear-short
- [PL-familiar] Familiar terms; GSA digital.gov; https://digital.gov/guides/writing-understanding/familiar-terms
- [PL-style] Style; GSA digital.gov; https://digital.gov/guides/plain-language/writing/style
- [PL-test] Test for understanding; GSA digital.gov; https://digital.gov/guides/plain-language/test
- [GOVUK-ui] Writing for user interfaces (Service Manual, 2018-04-16); GDS; https://www.gov.uk/service-manual/design/writing-for-user-interfaces
- [GOVUK-form] Structuring forms (Service Manual); GDS; https://www.gov.uk/service-manual/design/form-structure
- [GOVUK-clear] Use clear language; GDS publishing guidance; https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/
- [GOVUK-tone] Use the right tone; GDS publishing guidance; https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/right-tone/
- [GOVUK-errors] Error message; GOV.UK Design System; https://design-system.service.gov.uk/components/error-message/
- [GOVUK-summary] Error summary; GOV.UK Design System; https://design-system.service.gov.uk/components/error-summary/
- [GOVUK-validation] Recover from validation errors; GOV.UK Design System; https://design-system.service.gov.uk/patterns/validation/
- [GOVUK-question] Question pages; GOV.UK Design System; https://design-system.service.gov.uk/patterns/question-pages/
- [GOVUK-start] Start using a service; GOV.UK Design System; https://design-system.service.gov.uk/patterns/start-using-a-service/
- [GOVUK-check] Check answers; GOV.UK Design System; https://design-system.service.gov.uk/patterns/check-answers/
- [GOVUK-details] Details; GOV.UK Design System; https://design-system.service.gov.uk/components/details/
- [GOVUK-input] Text input; GOV.UK Design System; https://design-system.service.gov.uk/components/text-input/
- [HO-readability] Readability; UK Home Office User-Centred Design Manual; https://design.homeoffice.gov.uk/accessibility/written-content/readability
- [MS-steps] Writing step-by-step instructions; Microsoft Writing Style Guide; https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-step-by-step-instructions
- [MS-top10] Top 10 tips for Microsoft style and voice; Microsoft; https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice
- [MS-voice] Microsoft's brand voice: simple and human; Microsoft; https://learn.microsoft.com/en-us/style-guide/brand-voice-above-all-simple-human
- [MS-bias] Bias-free communication; Microsoft; https://learn.microsoft.com/en-us/style-guide/bias-free-communication
- [MS-abilities] Writing for all abilities; Microsoft; https://learn.microsoft.com/en-us/style-guide/accessibility/writing-all-abilities
- [MS-sorry] sorry (word list); Microsoft; https://learn.microsoft.com/en-us/style-guide/a-z-word-list-term-collections/s/sorry
- [MS-please] please (word list); Microsoft; https://learn.microsoft.com/en-us/style-guide/a-z-word-list-term-collections/p/please
- [WIN-writing] Writing style (Windows apps); Microsoft; https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style
- [WIN-wizards] Wizards (Win32 UX guidelines); Microsoft; https://learn.microsoft.com/en-us/windows/win32/uxguide/win-wizards
- [WIN-errors] Error messages (Win32 UX guidelines); Microsoft; https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-error
- [G-procedures] Procedures; Google developer documentation style guide; https://developers.google.com/style/procedures
- [G-ui] UI elements and interaction; Google; https://developers.google.com/style/ui-elements
- [G-tone] Voice and tone; Google; https://developers.google.com/style/tone
- [G-a11y] Write accessible documentation; Google; https://developers.google.com/style/accessibility
- [G-words] Word list (easy, simple, just); Google; https://developers.google.com/style/word-list
- [G-err-summary] Error messages: summary; Google Technical Writing courses; https://developers.google.com/tech-writing/error-messages/summary
- [G-err-tone] Error messages: set a positive tone; Google; https://developers.google.com/tech-writing/error-messages/set-tone
- [G-err-audience] Error messages: target audience; Google; https://developers.google.com/tech-writing/error-messages/target-audience
- [APPLE-writing] Writing (HIG, changed 2025-12-16); Apple; https://developer.apple.com/design/human-interface-guidelines/writing
- [APPLE-onboarding] Onboarding (HIG, changed 2024-06-10); Apple; https://developer.apple.com/design/human-interface-guidelines/onboarding
- [APPLE-alerts] Alerts (HIG, changed 2024-02-02); Apple; https://developer.apple.com/design/human-interface-guidelines/alerts
- [M3-style] Style guide (Material 3); Google Material Design; https://m3.material.io/foundations/content-design/style-guide/ux-writing-best-practices
- [M3-dialogs] Dialogs (Material 3); Google Material Design; https://m3.material.io/components/dialogs/guidelines
- [M2-onboarding] Onboarding (Material 2); Google Material Design; https://m2.material.io/design/communication/onboarding.html
- [POLARIS-errors] Error messages (Polaris source); Shopify; https://github.com/Shopify/polaris/blob/main/polaris.shopify.com/content/content/error-messages.mdx
- [POLARIS-fundamentals] Fundamentals (Polaris source); Shopify; https://github.com/Shopify/polaris/blob/main/polaris.shopify.com/content/content/fundamentals.mdx
- [SHOPIFY-content] Content (app design guidelines); Shopify; https://shopify.dev/docs/apps/design/content
- [SHOPIFY-alerts] Alerts (app design guidelines); Shopify; https://shopify.dev/docs/apps/design/user-experience/alerts
- [ATL-errors] Error messages; Atlassian Design System; https://atlassian.design/foundations/content/designing-messages/error-messages
- [ATL-voice] Voice and tone; Atlassian Design System; https://atlassian.design/foundations/content/voice-tone
- [18F-plain] Use plain language (Content Guide source); GSA 18F; https://github.com/18F/guides/blob/main/content/content-guide/our-approach/plain-language.md
- [18F-technical] Technical and interface writing; GSA 18F; https://github.com/18F/guides/blob/main/content/content-guide/our-style/technical-and-interface-writing.md
- [18F-voice] Voice and tone; GSA 18F; https://github.com/18F/guides/blob/main/content/content-guide/our-style/voice-and-tone.md
- [18F-address] Address the user; GSA 18F; https://github.com/18F/guides/blob/main/content/content-guide/our-approach/address-the-user.md
- [NNG-errors] Error-Message Guidelines (Neusesser and Sunwall, 2023); Nielsen Norman Group; https://www.nngroup.com/articles/error-message-guidelines/
- [NNG-wizards] Wizards: Definition and Design Recommendations (Budiu, 2017); NN/g; https://www.nngroup.com/articles/wizards/
- [NNG-progressive] Progressive Disclosure (Nielsen, 2006); NN/g; https://www.nngroup.com/articles/progressive-disclosure/
- [NNG-onboarding] Onboarding Tutorials vs. Contextual Help (Laubheimer, 2023); NN/g; https://www.nngroup.com/articles/onboarding-tutorials/
- [NNG-plain-experts] Plain Language Is for Everyone, Even Experts (Loranger, 2017); NN/g; https://www.nngroup.com/articles/plain-language-experts/
- [NNG-readability] Legibility, Readability, and Comprehension (Nielsen, 2015); NN/g; https://www.nngroup.com/articles/legibility-readability-comprehension/
- [NNG-defaults] The Power of Defaults (Nielsen, 2005); NN/g; https://www.nngroup.com/articles/the-power-of-defaults/
- [WCAG-3.3.1] Understanding SC 3.3.1 Error Identification; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html
- [WCAG-3.3.2] Understanding SC 3.3.2 Labels or Instructions; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html
- [WCAG-3.3.3] Understanding SC 3.3.3 Error Suggestion; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html
- [WCAG-3.3.4] Understanding SC 3.3.4 Error Prevention; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html
- [WCAG-3.3.7] Understanding SC 3.3.7 Redundant Entry; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html
- [WCAG-4.1.3] Understanding SC 4.1.3 Status Messages; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- [WCAG-2.1.1] Understanding SC 2.1.1 Keyboard; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html
- [WCAG-2.4.3] Understanding SC 2.4.3 Focus Order; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html
- [WCAG-3.2.2] Understanding SC 3.2.2 On Input; W3C WAI; https://www.w3.org/WAI/WCAG22/Understanding/on-input.html
- [APG-alert] Alert Pattern; W3C WAI-ARIA Authoring Practices; https://www.w3.org/WAI/ARIA/apg/patterns/alert/
- [APG-dialog] Dialog (Modal) Pattern; W3C WAI-ARIA Authoring Practices; https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- [APG-keyboard] Developing a Keyboard Interface; W3C WAI-ARIA Authoring Practices; https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
- [WAI-notifications] Forms tutorial: User Notifications; W3C WAI; https://www.w3.org/WAI/tutorials/forms/notifications/
- [WAI-multipage] Forms tutorial: Multi-page Forms; W3C WAI; https://www.w3.org/WAI/tutorials/forms/multi-page/
- [HEMINGWAY] Readability (Hemingway Editor help); Boondoggle Studio; https://hemingwayapp.com/help/docs/readability

---
status: accepted
---

# The Your machines step has a card per environment, adds a machine by link or by an install script that prints the pairing link, and mints codes by preset

Decided 2026-09-24 on the map ticket "Server and remote step: card behaviour, bundle acceptance, Tailscale warning, health" (david/agent-harness issue 52), which ADR 0016 re-scoped to the Your machines step once the connection bundle fell to pairing (ADR 0001). The server pane offered three topology cards, emitted a one-paste bundle of address, token, workspace and label, and warned when no tailnet address was found; a headless machine was set up by hand. The harness's step is **a card per environment**. **This machine** comes first: name, icon and colour (defaults from the hostname, ADR 0005), a reachability line (the tailnet name or address; loopback only with the Tailscale warning, a Check again and the LAN switch naming the address it would bind, per the environment spec), version, channel, auto-update with the idle window, deferral cap and pin behind an advanced disclosure (ADR 0007), Update now when the environment is behind its channel or when this client is newer, containment availability with a pointer to the Permissions step (ADR 0006), and Manage access, which opens the environment's access list in Settings. **Add a machine** has two paths on one card. The first takes a link, a QR or a short code that the other machine showed, from its own Set up, its terminal's pair verb or the install script's last lines; the exchange makes the machine a card. The second is a copyable one-line **install script** per platform (macOS and Linux, Windows, and the container compose snippet of ADR 0007), a static asset of each release on the project's Forgejo, the same source the updater reads, parameterised by the card with the channel this environment uses and an optional name; the script downloads the artefact for the platform, runs the service install, waits on the health URL, and ends by printing the pairing link, an ASCII QR and the code, built on the machine's tailnet address, or the Tailscale warning when it has none. Pairing runs one way, a client exchanging a code its environment minted, so nothing is served by the local environment and no environment connects to another. **A minted code grants a preset**: my own client (every scope and the environment's top ceiling, the default, and the only kind the script prints, since every paired client is the same person), a program (read, sessions:write and runs:drive with a ceiling picker preset to acceptEdits, for Hermes and scripts), or custom (scope ticks and the ceiling); the card shows what a code grants beside it, and codes expire in ten minutes. **A new card offers Set up this machine**, which switches the rail's environment picker to it and jumps to its first step that needs attention; declining leaves the card, and the checklist summary shows that machine's own progress beside this one's. **Forget** removes the connection from this client and, when the environment is reachable, revokes this client's session on it in the same action, saying so; unreachable, it forgets locally and notes that the session stays until revoked from that machine's access list; the local environment cannot be forgotten; it is managed through the service verbs (install, uninstall, status, start) instead. **Health per environment** reads the discovery URL: done when reachable and ready, named, and either auto-update on or the version at the channel's newest; no tailnet address is a standing notice on the card, never a failure, since a machine used alone needs none; needs attention when unreachable (with "unreachable since"), draining past its cap, or behind the channel with auto-update off; the local environment is never unreachable and shows "service down" with Start.

## Considered options

- A paste-a-link card only, with installation as documentation: rejected; the headless story would live outside the checklist.
- Reverse pairing, the local environment minting a code the install script pairs back with: rejected; an environment never connects to another, so it would need a second wire.
- Serving the install script from the local environment over the tailnet: rejected; the new machine would have to reach this one before it exists as an environment, and the local environment would gain a route it does not need.
- One kind of code with every scope and the top ceiling, or every code custom: rejected; a program pairing would get bypass, or every pairing would be a form.
- Treating a missing tailnet as needs attention, or ignoring reachability: rejected; a single-machine user would be nagged forever, or a dead machine would show green.
- Switching the whole checklist to a new machine automatically, or a card with no follow-up: rejected; the user would lose their place, or the new machine's setup would be found by accident.
- Forget as a local removal only, or forget refused when unreachable: rejected; a lost laptop would keep a valid session, or a machine gone for good could never leave the list.

## Consequences

- The Set up spec (issue 88) holds the cards, the two paths, the presets, the health check and the copy; the launcher spec (issue 86) holds the install script's asset, its platform variants and the service-install and health wait it performs; the environment spec's pair verb prints the link, the ASCII QR and the code.
- Chosen defaults for review: a fixed set of machine icons (laptop, desktop, server, cloud, container and a few more); the terminal UI shows the step's summary and pointer and its pair verb shows link, QR and code; the QR encodes the link; the program preset's label defaults to the program's name; the container snippet links to the host-side updater's documentation rather than printing a pairing link, since the container's environment pairs from its own log output.
- Fog: desktop-managed SSH launch of a remote environment (ADR 0005), environment peer lists, a relay for machines off the tailnet.

## Amendment: phone web client in milestone 1 (2026-10-04)

Phone is an additive fixed preset granting `read`, `sessions:write`, `runs:drive`
at `acceptEdits`. My own client retains every scope and `bypassPermissions`, is
valid for the owner's phone, and is never silently downgraded by browser kind.
Existing links disclose and retain their minted grant. A program and Custom
retain their choices/defaults; Custom expansion for terminal/admin is deliberate
re-pairing, or an access change by another admin client, never self-raising and never above the granting client's scopes/ceiling.

Phone links/QR use the explicitly configured external HTTPS origin, including
its port; desktop/TUI HTTP remains supported. Browser pairing opens sessions
without local service/bootstrap, scrubs the code fragment before rendering or
network, supports manual address+code and HTTPS QR scanning with denial/cancel
fallback and track cleanup. Browser Forget erases its local token and revokes
when reachable; it has no unforgettably local environment. See
[web-client.md](../specs/web-client.md).


## Amendment: change paired access in place (2026-10-05, #1632)

Rights are initially set at pairing. An admin client may subsequently replace
another live paired client's scopes and ceiling through `access.sessions.setAccess`.
Access offers Full access (My own client's grant), Restricted phone (Phone's
grant), and Custom scopes and ceiling. A client never changes its own grant
and never grants scopes or a ceiling beyond its own authority. Replacement is
atomic and audited with the previous and new grant; the same operation undoes it.
The affected client reconnects its open sockets and subscriptions with its
existing token and receives the new grant without pairing again. Running runs
keep their resolved policy. The permissions spec records refusal cases.

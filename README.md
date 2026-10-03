# agent-harness

agent-harness is a place to work with coding agents across your machines.
Start a session in the desktop window or terminal UI, give it a workspace,
and follow the agent's work alongside files, diffs and terminals.

Each machine runs an **environment**: a background service that owns its
accounts, workspaces and sessions. The desktop window and terminal UI
connect to it. Closing a window leaves the work running, and another client
can pick up the same session. You can pair a client with environments on
other machines too.

**Status: early, for friends.** David is building this for daily use and
sharing it with friends. Expect rough edges and changes. The name is still
a working name.

## Install

Download the build for your machine from
[GitHub releases](https://github.com/david-systemtech/agent-harness/releases).
Choose a stable release to start with; beta releases are marked as
prereleases. If no release has been published yet, packaged installs are
not available yet.

The desktop includes the environment for your machine, so you do not need
to install Node.js or build from source. Run it as your usual user. On first
launch it installs and starts the local environment and opens **Set up**.
Follow the checklist to connect your coding-agent account and choose your
settings. You use your own provider account for the agent's work.

### Windows (x64)

Download `agent-harness-desktop-win32-x64-setup.exe` and run it. It installs
for your user; it does not need administrator access. Open agent-harness
from the Start menu.

These early builds are not signed. If the browser flags the download as
uncommon, choose to keep it. If Windows shows **Windows protected your
PC**, choose **More info**, then **Run anyway**.

### macOS (Apple silicon)

Download `agent-harness-desktop-darwin-arm64.zip`, unzip it, and move
`agent-harness.app` into **Applications** before opening it. Keeping it there
lets the desktop update itself.

These early builds are not notarised. If macOS says it cannot verify the
app, choose **Done**, then open **System Settings > Privacy & Security**,
choose **Open Anyway** beside agent-harness, and confirm.

### Linux (x64)

The desktop package is for **Arch Linux**. Download
`agent-harness-desktop-linux-x64.pacman` and install it from the directory
where you saved it:

```sh
sudo pacman -U agent-harness-desktop-linux-x64.pacman
```

Open agent-harness from your application menu, or run
`agent-harness-desktop` as your usual user. For an environment on another
Linux distribution, use the Docker option below and connect from a desktop
on a supported machine.

### Docker (Linux x64 host)

The public image is `ghcr.io/david-systemtech/agent-harness`. Each release
has a version tag without the leading `v`; `latest` follows stable releases.
No registry login is needed to pull the public image.

On a Linux machine with Docker Engine and the Compose plugin, download
`compose.yaml` and `host-updater.sh` from the same GitHub release into one
directory. The release's compose file selects that release's image and
keeps the environment's data and workspaces in named volumes. In that
directory, run:

```sh
docker compose up -d
docker compose logs environment
```

For remote container pairing, run the published Compose file on a Linux host
with Tailscale installed, signed in and running in kernel TUN mode (the default,
with an interface whose name starts with `tailscale`, such as `tailscale0` or
`tailscale1`). The detector takes a non-internal IPv4 address in `100.64.0.0/10`,
checking the lowest-numbered interface first. Join the client machine to the same tailnet and
allow TCP port 7433 in the tailnet policy and host firewall. The container
shares the host network and discovers its Tailscale IPv4 address without a
Tailscale CLI or daemon socket. Until the first client pairs, `docker compose
logs environment` prints a pairing link and code; use them in the desktop's
**Set up > Your machines**. Loopback remains available and LAN binding stays off
unless you enable it. This path requires the Linux host network; userspace
Tailscale and Docker Desktop are unsupported.

For an environment running directly on macOS, detection tries `tailscale` on
PATH, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale` for `ip -4`
and `status --json`. Without a CLI address it checks `utun*` interfaces for
an IPv4 address in Tailscale's range. This fallback is a heuristic: another VPN
using the same range on a generic macOS tunnel cannot be distinguished without
a CLI answer. **Your machines** distinguishes a missing
installation from an installed app whose address could not be read. LAN choices
prefer private IPv4, then unique-local IPv6, then other IPv6; an IPv6 choice
warns that its address may change.

A container never updates itself. Make `host-updater.sh` executable and
schedule it on the Docker host every five minutes, as described in the
[host-side updater instructions](docs/host-updater.md). It follows the
environment's update settings, checks the replacement, and rolls back if
it cannot start. Keep the compose file and updater together.

## Updates

Releases and updates come from
[GitHub releases](https://github.com/david-systemtech/agent-harness/releases).
Reading public releases needs no GitHub account.

- **stable** is the default: the newest release that is not a prerelease.
- **beta** includes prereleases as well as stable releases.

In **Settings > Your machines**, choose the environment's channel and
whether it updates automatically. Native installs update automatically by
default, waiting for idle before restarting. The desktop follows its local
environment's channel so they move together. You can choose **Update now**
or pin a version; pinning stops automatic updates until you remove the pin.
Docker installs use the host-side updater described above.

## Reporting a problem

Tell David which version you are running, your operating system, what you
did, what you expected, and what happened. Include the error text and, if it
helps, a screenshot or the relevant log excerpt. Leave out credentials and
private code. The version is shown in **About** and on the environment's
**Your machines** card.

## Contributors

The [repository guide](AGENTS.md) covers building and working in this repo.
The [contributor operations docs](docs/agents/) cover the development
workflow and manual checks. The [domain glossary](CONTEXT.md) and
[specs](docs/specs/) describe the product and its rules.

## Rights

All rights reserved; no licence is granted.

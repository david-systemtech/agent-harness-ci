# agent-harness

Agent harness (working name). Issues on this repo are the tracker for its work.

For remote container pairing, run the published Compose file on a Linux host with Tailscale installed, signed in and running in kernel TUN mode (the default, with a `tailscale0` interface). Join the client machine to the same tailnet and allow TCP port 7433 in the tailnet policy and host firewall. The container shares the host network and discovers its Tailscale IPv4 address without a Tailscale CLI or daemon socket. Until the first client pairs, `docker compose logs environment` prints a pairing link and code; use them in the desktop's **Set up > Your machines**. Loopback remains available and LAN binding stays off unless you enable it. This path requires the Linux host network; userspace Tailscale and Docker Desktop are unsupported.

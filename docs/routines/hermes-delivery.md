# Routine results to Matrix through Hermes

Milestone 1 uses Hermes as the delivering endpoint, as decided in #29 and ADR 0008: the harness posts a signed webhook, and Hermes relays it to the Matrix home room. No Hermes state is read or imported. Hermes keeps its bots and schedules until milestone 2; the netdata alerts retain their own route on the same adapter.

The repository work for #538 adds `hermes` on `success` to the [disabled upstream-watch definition](upstream-watch.md). Client notices remain on `both`. This does not configure Hermes, Matrix/Tuwunel, OpenBao or a live environment. The live checks below are tracked in [#1009](https://git.systemtech.dev:5526/david/agent-harness/issues/1009), coordinated with the upstream-watch cut-over [#988](https://git.systemtech.dev:5526/david/agent-harness/issues/988). The fleet must be available first (cortex issue 437).

## Receiver contract

Configure a dedicated Hermes webhook route that **only delivers** to the home room: no model turn, tool execution or schedule. Keep the existing netdata route and secret separate. Record the actual route URL and room id during setup; this repo assumes neither.

The route must accept signed JSON POSTs of `routine.test` for endpoint testing and `routine.result` version 1 for results. A result carries `environment` and `routine` ids/names, `entry` (id, kind, trigger, due/start/end times, outcome, reason and session id), `summary` and `text` (at most 16,000 characters). Render the summary/text as message data, not instructions. Do not require a session id for a skip. A non-silent successful upstream-watch firing is sent; failure stays on the client notice. No-change and silence send nothing.

Verify the raw request body **before relaying** using Standard Webhooks:

- Headers: `webhook-id`, `webhook-timestamp`, and space-separated `webhook-signature` entries of form `v1,<base64 signature>`.
- HMAC-SHA256 input: `<webhook-id>.<webhook-timestamp>.<raw body>`, signed with the shared secret's bytes, or decoded base64 bytes after `whsec_` for that secret format. Compare signatures in constant time; accept any valid supported signature.
- Accept timestamps within 300 seconds of the receiver clock, in either direction; reject missing/invalid signatures, modified bodies and older or future requests outside that window. Keep clocks synchronized.
- Deduplicate authenticated messages by `webhook-id`, not timestamp or body: every retry has the same id but a fresh timestamp/signature. Remember delivered ids across a receiver restart and at least through the full retry horizon (1 + 5 + 30 minutes plus the replay window). Commit a delivered id only after successful Matrix delivery; handle concurrent duplicates. A Matrix failure must remain retryable. Receiver crash recovery during a Matrix send also needs verification; an in-memory set alone cannot establish delivery once across restarts.
- A 2xx acknowledges delivery. The harness follows no redirects and times out each attempt after ten seconds. Network errors, timeouts, 408, 429 and 5xx retry after 1, 5 and 30 minutes, surviving a harness restart. Other statuses fail finally; unresolved key-manager references also retry. A final failure raises `routine.delivery-failed` to clients.

## Endpoint setup with David

1. Put the route's secret in OpenBao under `personal/agents/endpoint-hermes`, field `secret`, or record the actual locator under `personal/agents/`. Give the SYSTEM-SERVER environment's configured connection access to that field. Use the same value at the receiver. Never put a real value in this repo, tracker, command arguments or logs.
2. From an authenticated client connected to **SYSTEM-SERVER**, with `admin`, configure the endpoint named exactly `hermes`. Use HTTPS or an allowed tailnet URL without userinfo. #536 is merged, so use a reference resolved on every test/delivery; do not leave the final endpoint with a pasted secret. If a temporary paste is needed, move it through the Key manager's Move source to `<base>/endpoint-hermes`, with base `personal/agents`, and check the displayed locator afterwards.
3. The GUI endpoints pane may be used if available. Otherwise use the typed client's `request` interface, with values selected from that environment's key-manager connection and actual Hermes route:

```ts
await client.request("routines.endpoints.set", {
  commandId: crypto.randomUUID(),
  name: "hermes",
  url: hermesRouteUrl,
  secret: {
    kind: "reference",
    reference: {
      provider: "openbao",
      connectionId: openBaoConnectionId,
      mount: "personal",
      path: "agents/endpoint-hermes",
      key: "secret",
    },
  },
});
await client.request("routines.endpoints.list", {});
await client.request("routines.endpoints.test", { name: "hermes" });
```

Check the set's receipt is accepted and list shows `secretKind: reference`, the right URL and display locator, with no secret value. The endpoint test must answer 2xx with no error **and** its test message must appear once in the home room; HTTP success alone is insufficient.

## Attach the watch and prove a retry

1. Coordinate with #988 before enabling or replacing a live routine. The committed YAML imports disabled with the success webhook already present. Inspect `routines.checkImport` warnings before import. For a watch already imported with client delivery alone, use `routines.list` to select its id and `routines.update` with only `fields.delivery`: preserve every existing target and add `{ kind: "webhook", target: "hermes", on: "success" }` once. Keep the client notice on `both` and preserve the disabled state until the cut-over. Do not re-import an old document over live field edits.
2. Use `routines.runNow` on that id for a known non-silent successful result. Preserve issue #74's ledger; the first empty-ledger observation may bootstrap silently, and an unchanged pre-check may skip. Do not fabricate a digest or reset the ledger to force delivery. Verify one result in the home room, its entry id/session and successful delivery in `routines.history`. Also verify failure reaches the client notice, and silence/no-change reaches no room message.
3. Arrange one controlled 5xx **after the receiver accepted and relayed a result**, simulating a lost acknowledgement. The harness should record attempt 1 as `retrying`, then attempt 2 after one minute with the same `webhook-id`, a refreshed timestamp/signature, and 2xx. Verify history shows both attempts and the room has exactly one result. Separately force a Matrix-send failure before acceptance, and verify recovery delivers rather than being swallowed by the deduplication record. Check a receiver restart and concurrent duplicate handling. Remove fault injection and confirm netdata still delivers through its own route.
4. Record sanitized endpoint display, status, entry id, attempt timings, stable webhook id and Matrix message id in #1009. Verify signature rejection and replay-window checks on the actual adapter; the loopback tests do not certify Hermes or a real Matrix server.
5. Update the upstream-watch memory and the Hermes-plan memory: the watch runs on the harness; successful results use endpoint `hermes`, a Standard Webhooks route that only delivers to the Matrix home room, with a reference under `personal/agents/` and stable-id deduplication. Record the actual route, locator and test evidence without secrets. Hermes's bots and schedules stay until milestone 2, and nothing is read or imported from Hermes.

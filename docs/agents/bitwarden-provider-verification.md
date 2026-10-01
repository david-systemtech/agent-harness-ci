# Bitwarden provider verification (#379)

Checked 2026-10-01 against the official sources. No Bitwarden service was
contacted; provider behavior is tested with a scripted SDK and a fake `bws`.

| Question | Finding |
| --- | --- |
| CLI floor | [`bws` 0.3.0](https://github.com/bitwarden/sdk-sm/blob/bws-v0.3.0/crates/bws/src/main.rs) accepts `project list`, `BWS_ACCESS_TOKEN`, `BWS_SERVER_URL` and `BWS_PROFILE`. |
| Configuration | The same source accepts `--config-file`, but **does not read `BWS_CONFIG_FILE`**. The block supplies the specified variable and an empty file. At the 0.3 floor, the server override bypasses profile configuration. The environment variable alone cannot prove isolation on other CLI versions; CLI verification needs a follow-up to pass the file as an argument. |
| SDK licence | The [`SDK licence`](https://github.com/bitwarden/sdk-sm/blob/main/LICENSE) is Bitwarden's Software Development Kit License Agreement, version 1, dated 17 March 2023. It is a custom licence for compatible applications, not an MIT dependency. |
| Native platforms | The official [Node build workflow](https://github.com/bitwarden/sdk-sm/blob/main/.github/workflows/build-napi.yml) builds Linux x64, macOS x64/arm64 and Windows x64. The published [`@bitwarden/sdk-napi` 1.0.0 metadata](https://registry.npmjs.org/@bitwarden/sdk-napi/1.0.0) declares optional native packages for each. Its constructor loads on this Linux x64 host with Node 24.21.0; macOS and Windows were verified from upstream build definitions and published packages, not locally executed. |
| Server address | The [SDK settings](https://github.com/bitwarden/sdk-sm/blob/main/crates/bitwarden-napi/src-ts/bitwarden_client/index.ts) take API and identity URLs. US/EU vault addresses map to their separate API/identity hosts; self-hosted addresses use `/api` and `/identity`, matching the [CLI configuration](https://github.com/bitwarden/sdk-sm/blob/main/crates/bws/src/config.rs). |
| Access-token-only sign-in | The published Node SDK's `projects().list`, secret list and create require an organization id, but authentication returns no organization id and the wrapper exposes no `get_access_token_organization` equivalent. See its [client wrapper](https://github.com/bitwarden/sdk-sm/blob/main/crates/bitwarden-napi/src-ts/bitwarden_client/index.ts) and the [CLI's use of Rust organization discovery](https://github.com/bitwarden/sdk-sm/blob/bws-v0.3.0/crates/bws/src/main.rs). The installed package's declarations confirm the omission. |

The default loader therefore answers `provider_unavailable` with that reason
before making a network request. It does not guess an organization id, ask
for another credential, or persist/decrypt an SDK state file. The injectable
SDK seam proves the full sign-in, names-only browse, resolve and Move flows.
There is no `bws` resolution fallback: the native binding loads, while its
published interface lacks the operation needed for this ticket's sign-in.
Organization discovery and scoped names-only listing are tracked in [#1122](https://git.systemtech.dev:5526/david/agent-harness/issues/1122).
The CLI configuration discrepancy is tracked in [#1123](https://git.systemtech.dev:5526/david/agent-harness/issues/1123).

A Move target names a project and key before creation. A stored reference
always carries the actual secret id returned by the SDK. The base suggestion
is `harness`; it must already exist, and a name must identify one project.
Writes refuse ambiguous existing keys, retain a different value unless
overwrite was requested, and return the assigned id for read-back and swap.

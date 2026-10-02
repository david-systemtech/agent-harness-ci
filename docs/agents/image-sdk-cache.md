# Image SDK download cache

The image job can download the lockfile-pinned Linux x64 SDK from a generic
package linked to this repository. It verifies SHA-512 before supplying the
archive to Docker. Missing credentials, HTTP errors, timeouts, an unrecognised
lockfile pin and integrity mismatches warn and fall back to npm. The Dockerfile
checks that the SDK binary resolves after the production install, including in
public builds, and fails rather than shipping an image without it.

The generic package is seeded per pinned version; dependency updates do not
upload it automatically. After updating the SDK pin:

1. Read the version and SHA-512 integrity from the exact
   `@anthropic-ai/claude-agent-sdk-linux-x64@<version>` package entry in
   `pnpm-lock.yaml`, excluding the musl package.
2. Download that version's tarball from npm. Hash its complete bytes with
   SHA-512 and compare `sha512-<base64 digest>` with the committed integrity.
   Discard any archive that fails the comparison.
3. With a package-write credential, upload the verified bytes using `PUT` to
   `/api/packages/<owner>/generic/claude-agent-sdk-linux-x64/<version>/claude-agent-sdk-linux-x64-<version>.tgz`
   on the job's Forgejo server. Read the credential from the environment and
   send it in the authorization header; keep it out of command arguments and
   Docker's context. The initial seeded version is `0.3.283`.
4. Link the generic package to this repository in its package settings so the
   job token can read it. Run the image check and confirm its log reports
   `verified lockfile pin <version>`.

HTTP 401 usually calls for checking the token and repository link; HTTP 404 can
mean the new pin has not been seeded. Both remain npm fallbacks. Replace a bad
upload only with bytes that match the committed lockfile. Public builds need
neither the package cache nor a credential.

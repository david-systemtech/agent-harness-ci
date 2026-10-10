# Native macOS smoke diagnostics

The release replacement smoke captures its stage, expression, desktop output,
main-process sample, window list and a screenshot on a timeout or unexpected
CDP disconnect. Disconnect failures include the active stage and expression;
requests on an already closed page fail immediately. Only the smoke's explicit
pending-access quit, update restart and final window close accept a disconnect
before their evaluation reply. Native desktop/helper exit checks still run, and
all credential/navigation evaluations require a reply. Only sanitized
files enter the uploaded `macos-update-diagnostics` artifact; raw images stay
private and are removed after redaction. Failed collectors leave an error file
while the other evidence and original failure survive. Screenshot failure files
include the command exit code, signal, killed flag and credential-redacted stderr.
Error messages and stderr are sanitized before each is limited to 32 KB.
Every Swift script, screenshot redaction and the native checks' own fixture
images alike, runs through `executeSwift` with a separate two-minute command
budget: compiling Apple SDK modules from a cold cache can exceed the other
collectors' twenty-second limit before the script even starts (#1684). A timeout
still kills the command and removes both raw and partial output images.

`test/macos-smoke-diagnostics.test.ts` verifies redaction, failure handling,
bounded commands and the Core Foundation reference bridge through the command
boundary. `scripts/macos-smoke-diagnostics-native.test.mjs` additionally exercises
the actual JXA bridge and Apple SDK on a hosted Mac. It creates a synthetic PNG
with readable test text and a blue geometry marker, runs the real Swift tool,
then checks its dimensions, text removal, unchanged marker and private input.
Both screenshot collectors also run concurrently against the fixture with a
fresh shared Swift module cache, as on a new release runner. A text-free image
must produce no upload candidate. These tests use no desktop
app, Keychain item or credential.

Install `.forgejo/github-workflows/macos-diagnostics.yml` byte for byte as
`.github/workflows/macos-diagnostics.yml` on the `workflows` default branch of
`david-systemtech/agent-harness-ci`, through a reviewed pull request. Dispatch
that workflow with the full `sha` already pushed to the relay by ordinary CI
after its secret scan. Record the native run result with the source pull request
before landing. The release's `smoke-macos` job runs the same native tests using the packaged Node
before its desktop replacement check. The manual check verifies a branch without
building a release.

The image loader uses AppKit's [bitmap data initializer](https://developer.apple.com/documentation/appkit/nsbitmapimagerep/init%28data%3A%29).
CoreGraphics returns a [CFArray of window dictionaries](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo%28_%3A_%3A%29),
which JXA must cast to an Objective-C object before recursively unwrapping it.

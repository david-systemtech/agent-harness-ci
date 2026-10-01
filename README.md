# agent-harness-ci

CI for [agent-harness](https://git.systemtech.dev:5526/david/agent-harness),
run on GitHub's public-repository runners.

The code is developed on Forgejo. This repository receives the commits under
test from a relay job there and runs `.github/workflows/ci.yml` against them;
the result goes back to the Forgejo pull request as its `ci / ci` check.
Nothing is developed here, and pull requests to this repository are not read.

- `workflows` (the default branch) holds only the workflows.
- `main` follows agent-harness `main`, so each push sends only new objects.
- `ci/<id>` branches exist only while their run does.

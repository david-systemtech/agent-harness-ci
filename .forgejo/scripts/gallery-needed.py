#!/usr/bin/env python3
"""Decide from the whole PR diff; run only from the trusted base checkout."""

import fnmatch
import json
import re
import subprocess
import sys


# GUI dependencies and build inputs can change captures without a GUI source edit.
PATTERNS = (
    "packages/gui/*",
    "packages/theme/*",
    "packages/client-runtime/*",
    "packages/contracts/*",
    "packages/browser/*",
    "scripts/gallery*",
    ".forgejo/scripts/gallery*",
    ".forgejo/scripts/github-ci.sh",
    ".forgejo/workflows/gallery.yml",
    ".forgejo/github-workflows/gallery.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
)


def main():
    base, head, event_path = sys.argv[1:]
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (base, head)):
        raise ValueError("invalid gallery comparison sha")
    with open(event_path) as source:
        labels = json.load(source)["pull_request"]["labels"]
    if not isinstance(labels, list) or any(
        not isinstance(label, dict) or not isinstance(label.get("name"), str)
        for label in labels
    ):
        raise ValueError("invalid pull request labels")
    # NULs preserve unusual filenames. Disabling rename detection includes both
    # the old and new paths, so moving a GUI file out of its directory still runs.
    paths = subprocess.check_output(
        ["git", "diff", "--name-only", "--no-renames", "-z", f"{base}...{head}", "--"]
    ).decode("utf-8", "surrogateescape").split("\0")
    render = any(label["name"] == "gallery" for label in labels) or any(
        fnmatch.fnmatchcase(path, pattern) for path in paths for pattern in PATTERNS
    )
    print("render=" + str(render).lower())


if __name__ == "__main__":
    main()

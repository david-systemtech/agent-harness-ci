#!/bin/sh
# Copy this executable into the environment's scripts directory. It needs
# python3, gh and curl on PATH; GH_TOKEN may be supplied by forge injection.
# No ledger, credentials file, conditional HTTP cache or clock is read.
exec python3 - <<'PY'
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def command(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True).stdout


def get(url):
    return command(["curl", "--fail", "--silent", "--show-error", "--location",
                    "--max-time", "20", url])


def stable_version(value):
    return re.fullmatch(r"\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?", value) is not None


source = "github-releases"
try:
    query = '''query {
      t3code: repository(owner: "pingdotgg", name: "t3code") {
        releases(first: 100) { nodes { databaseId tagName isPrerelease isDraft } }
      }
      codex: repository(owner: "openai", name: "codex") {
        releases(first: 100) { nodes { databaseId tagName isPrerelease isDraft } }
      }
      pi: repository(owner: "earendil-works", name: "pi") {
        releases(first: 20) { nodes { databaseId tagName isPrerelease isDraft } }
      }
      hermes: repository(owner: "NousResearch", name: "hermes-agent") {
        releases(first: 20) { nodes { databaseId tagName isPrerelease isDraft } }
      }
    }'''
    github = json.loads(command(["gh", "api", "--hostname", "github.com",
                                 "graphql", "-f", "query=" + query]))
    if github.get("errors"):
        raise ValueError("GraphQL did not read every repository")
    observations = {}
    for source in ("t3code", "codex", "pi", "hermes"):
        ids = []
        for release in github["data"][source]["releases"]["nodes"]:
            if release["isPrerelease"] or release["isDraft"]:
                continue
            tag = release["tagName"]
            if source == "t3code" and not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
                continue
            if source == "codex" and not re.fullmatch(r"(?:rust|python)-v\d+\.\d+\.\d+", tag):
                continue
            if not isinstance(release["databaseId"], int):
                raise ValueError("Missing release id")
            ids.append(str(release["databaseId"]))
        observations[source] = ids

    source = "claude-code"
    changelog = get("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md")
    observations[source] = re.findall(r"^## (\d+\.\d+\.\d+)[ \t]*\r?$", changelog, re.M)

    source = "claude-digests"
    index = get("https://code.claude.com/docs/llms.txt")
    observations[source] = re.findall(r"https://code\.claude\.com/[^\s)<>\"]*whats-new/\d{4}-w\d{2}\.md\b", index)

    source = "chatgpt-rss"
    rss = ET.fromstring(get("https://learn.chatgpt.com/docs/changelog/rss.xml"))
    if rss.tag != "rss" or rss.find("channel") is None:
        raise ValueError("Not an RSS feed")
    ids = []
    for item in rss.findall("./channel/item"):
        guid = item.findtext("guid")
        if not guid or "\n" in guid or "\r" in guid:
            raise ValueError("Missing or multiline RSS guid")
        ids.append(guid)
    observations[source] = ids

    source = "chatgpt-digests"
    digest = get("https://learn.chatgpt.com/docs/whats-new.md")
    ids = []
    for heading in re.findall(r"^##[ \t]+([^\r\n]+)", digest, re.M):
        page = re.fullmatch(r"\[[^\]]+\]\((https://learn\.chatgpt\.com/docs/whats-new/[^\s)]+)\)", heading)
        if page:
            ids.append(page.group(1))
        elif re.fullmatch(r"\d{4}-W\d{2}", heading, re.I):
            ids.append(heading.upper())
        elif re.fullmatch(r"(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}[^\n]*, \d{4}", heading):
            ids.append(heading)
    observations[source] = ids

    for package in ("@anthropic-ai/claude-code", "@openai/codex",
                    "@earendil-works/pi-coding-agent", "t3"):
        source = "npm:" + package
        tags = json.loads(get("https://registry.npmjs.org/" + package.replace("/", "%2F") + "/dist-tags"))
        observations[source] = [version for version in tags.values() if stable_version(version)]

    # Buffer all sources: a failed probe must not look like a changed week.
    for source, ids in observations.items():
        print("[" + source + "]")
        for stable_id in sorted(set(ids)):
            print(stable_id)
except (subprocess.SubprocessError, OSError, ValueError, KeyError, TypeError, AttributeError, ET.ParseError):
    # External errors can contain credentials or arbitrary upstream content.
    print("Upstream watch probe failed: " + source, file=sys.stderr)
    sys.exit(1)
PY

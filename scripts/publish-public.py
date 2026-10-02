#!/usr/bin/env python3
"""Publish one checked tree, with only the previous public snapshot as ancestry."""
import argparse
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

VERSION = '8.30.1'
PINS = {
    'x86_64': ('x64', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'),
    'aarch64': ('arm64', 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'),
}
IDENTITY = {'GIT_AUTHOR_NAME': 'Public snapshot', 'GIT_AUTHOR_EMAIL': 'snapshot@users.noreply.github.com',
            'GIT_COMMITTER_NAME': 'Public snapshot', 'GIT_COMMITTER_EMAIL': 'snapshot@users.noreply.github.com'}


def command(args, cwd=None, data=None, env=None):
    return subprocess.run(args, cwd=cwd, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True, env=env).stdout


def git(repo, *args, data=None, env=None):
    return command(['git', '-C', str(repo), *args], data=data, env=env)


def excluded(path, patterns):
    # Root-relative globs; a directory entry also excludes all its descendants.
    return any(fnmatch.fnmatchcase(path, p.rstrip('/')) or
               any(fnmatch.fnmatchcase('/'.join(path.split('/')[:i]), p.rstrip('/'))
                   for i in range(1, len(path.split('/')))) for p in patterns)


def export_tree(source, ref, tree):
    sha = git(source, 'rev-parse', '--verify', ref + '^{commit}').decode().strip()
    patterns = [p.strip() for p in git(source, 'show', sha + ':.public-exclude').decode().splitlines()
                if p.strip() and not p.lstrip().startswith('#')]
    policy = json.loads(git(source, 'show', sha + ':.public-privacy.json'))
    for entry in git(source, 'ls-tree', '-rz', '--full-tree', sha).split(b'\0'):
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        path = raw_path.decode('utf-8')
        if excluded(path, patterns):
            continue
        mode, kind, oid = metadata.decode().split()
        # Fail closed on links: never let a scanner follow a link outside its tree.
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError('Unsupported link or submodule: ' + path)
        if Path(path).is_absolute() or '..' in Path(path).parts or '.git' in Path(path).parts:
            raise ValueError('Unsafe tree path')
        target = tree / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(source, 'cat-file', 'blob', oid))
        target.chmod(0o755 if mode == '100755' else 0o644)
    if not (tree / 'README.md').is_file() or not list((tree / '.github/workflows').glob('*.y*ml')):
        raise ValueError('The selected ref must contain README.md and .github/workflows')
    return policy


def privacy(tree, policy):
    rules = [(r['id'], re.compile(r['pattern'], re.I)) for r in policy['deny']]
    allowances = [(a['rule'], re.compile(a['path']), re.compile(a['value'], re.I)) for a in policy['allow']]
    failures = []
    for file in sorted(tree.rglob('*')):
        if not file.is_file():
            continue
        path = file.relative_to(tree).as_posix()
        # Decode every blob, including binaries, and scan the filename as well.
        for text in (path, file.read_bytes().decode('utf-8', errors='replace')):
            for name, pattern in rules:
                for match in pattern.finditer(text):
                    if not any(rule == name and p.search(path) and v.fullmatch(match.group())
                               for rule, p, v in allowances):
                        failures.append(f'{path}:{text[:match.start()].count(chr(10)) + 1}: {name}')
    if failures:
        raise ValueError('Privacy deny-list failed:\n' + '\n'.join(failures))
    print('Privacy deny-list: pass')


def scanner_path(explicit, scratch):
    found = explicit or shutil.which('gitleaks')
    if found:
        if command([found, 'version']).decode().strip().lstrip('v') != VERSION:
            raise ValueError('gitleaks must be pinned to ' + VERSION)
        return found
    if platform.system() != 'Linux' or platform.machine() not in PINS:
        raise ValueError('Install pinned gitleaks ' + VERSION + ' on this platform')
    arch, checksum = PINS[platform.machine()]
    cache = Path(os.environ.get('RUNNER_TOOL_CACHE', str(Path.home() / '.cache'))) / 'gitleaks' / VERSION / (checksum + '.tar.gz')
    archive = cache.read_bytes() if cache.is_file() else b''
    if hashlib.sha256(archive).hexdigest() != checksum:
        asset = f'gitleaks_{VERSION}_linux_{arch}.tar.gz'
        # The generic package source is the relay's first download source.
        package = f'https://git.systemtech.dev:5526/api/packages/david/generic/gitleaks/{VERSION}/{asset}'
        headers = {}
        credential = subprocess.run(['git', 'credential', 'fill'], input=b'protocol=https\nhost=git.systemtech.dev:5526\n\n',
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
        fields = dict(line.split('=', 1) for line in credential.stdout.decode().splitlines() if '=' in line)
        if fields.get('password'):
            headers['Authorization'] = 'token ' + fields['password']
        sources = [(package, headers), (f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/{asset}', {})]
        for url, source_headers in sources:
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=source_headers), timeout=60) as response:
                    candidate = response.read()
                if hashlib.sha256(candidate).hexdigest() != checksum:
                    continue
                archive = candidate
                break
            except (OSError, ValueError):
                continue
        else:
            raise ValueError('Could not fetch the checksum-verified gitleaks ' + VERSION)
        cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=cache.parent, delete=False) as part:
            part.write(archive)
        os.replace(part.name, cache)
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        binary = bundle.extractfile('gitleaks')
        if binary is None:
            raise ValueError('gitleaks binary missing from archive')
        target = scratch / 'gitleaks'
        target.write_bytes(binary.read())
        target.chmod(0o755)
    return str(target)


def publish(args):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', args.version):
        raise ValueError('Version must be a semantic version')
    if args.tag and args.tag != 'v' + args.version:
        raise ValueError('Tag must be v plus the version')
    source = Path(args.source).resolve()
    with tempfile.TemporaryDirectory(prefix='public-snapshot-') as folder:
        scratch = Path(folder)
        tree = scratch / 'tree'
        tree.mkdir()
        policy = export_tree(source, args.ref, tree)
        privacy(tree, policy)
        scanner = scanner_path(args.gitleaks, scratch)
        # Isolate config from the caller and from the tree's gitleaks config.
        config = scratch / 'gitleaks.toml'
        config.write_text('[extend]\nuseDefault = true\n')
        scan_env = {k: v for k, v in os.environ.items() if not k.startswith('GITLEAKS_')}
        report = scratch / 'gitleaks.json'
        try:
            command([scanner, 'dir', '--no-banner', '--redact', '--exit-code', '1',
                     '--ignore-gitleaks-allow', '--config', str(config),
                     '--report-format', 'json', '--report-path', str(report), str(tree)], cwd=scratch, env=scan_env)
        except subprocess.CalledProcessError as error:
            locations = []
            try:
                for finding in json.loads(report.read_text()):
                    path = Path(finding['File'])
                    if path.is_absolute():
                        path = path.relative_to(tree)
                    line, rule = finding['StartLine'], finding['RuleID']
                    if '..' not in path.parts and type(line) is int and line > 0 and re.fullmatch(r'[\w.-]+', rule):
                        locations.append(f'{json.dumps(path.as_posix())}:{line}: {rule}')
            except (OSError, ValueError, KeyError, TypeError):
                pass
            # Never forward scanner output or report Match/Secret fields.
            details = '\n' + '\n'.join(locations) if locations else ''
            raise ValueError(f'gitleaks: failed (exit {error.returncode}); publication blocked' + details) from None
        print('gitleaks: pass')
        repo = scratch / 'repo'
        git(scratch, 'init', '-q', str(repo))
        # A single explicit fetch, never the private source's object database.
        remote_main = git(repo, 'ls-remote', args.remote, 'refs/heads/main').decode().strip()
        parent = None
        if remote_main:
            git(repo, 'fetch', '-q', '--no-tags', args.remote, 'refs/heads/main')
            parent = git(repo, 'rev-parse', 'FETCH_HEAD').decode().strip()
        tag_ref = 'refs/tags/' + args.tag if args.tag else None
        if tag_ref and git(repo, 'ls-remote', args.remote, tag_ref).strip():
            raise ValueError('The public version tag already exists')
        # Insert the scanned bytes directly: checkout/add could run attributes,
        # clean filters or line-ending conversion from the caller's git config.
        index = []
        for file in sorted(tree.rglob('*')):
            if file.is_file():
                path = file.relative_to(tree).as_posix()
                mode = '100755' if file.stat().st_mode & 0o111 else '100644'
                blob = git(repo, 'hash-object', '-w', '--stdin', data=file.read_bytes()).decode().strip()
                index.append(f'{mode} {blob}\t{path}'.encode() + b'\0')
        git(repo, 'update-index', '-z', '--index-info', data=b''.join(index))
        oid = git(repo, 'write-tree').decode().strip()
        # Do not inherit the private author's identity, signing settings or message.
        env = {**os.environ, **IDENTITY}
        commit_args = ['commit-tree', oid] + (['-p', parent] if parent else [])
        commit = git(repo, *commit_args, data=f'Publish {args.version}\n'.encode(), env=env).decode().strip()
        print('Files:')
        for path in git(repo, 'ls-tree', '-r', '--name-only', commit).decode().splitlines():
            print(path)
        print(f'Commit: {commit}\nParent: {parent or "(root)"}\nMessage: Publish {args.version}')
        if args.dry_run:
            print('Dry run: no refs pushed')
            return
        refs = [f'{commit}:refs/heads/main'] + ([f'{commit}:{tag_ref}'] if tag_ref else [])
        # Both refs move together, without force. Concurrent publishers fail safely.
        git(repo, 'push', '--atomic', args.remote, *refs)
        print('Published ' + commit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default='.')
    parser.add_argument('--ref', required=True)
    parser.add_argument('--remote', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--tag')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--gitleaks', help='Path to pinned gitleaks (also the test seam)')
    try:
        publish(parser.parse_args())
    except subprocess.CalledProcessError:
        print('Publish failed: a required command or privacy scan failed; no successful publish reported', file=sys.stderr)
        return 1
    except (ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

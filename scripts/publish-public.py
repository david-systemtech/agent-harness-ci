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
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zlib

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


def check_test_inputs(tree, patterns):
    roots = {p.rstrip('/').split('/')[0] for p in patterns}
    for file in sorted(tree.rglob('*')):
        if not file.is_file() or not file.name.endswith(('.test.ts', '.test.tsx')):
            continue
        text = file.read_text(encoding='utf-8', errors='replace').replace('\0', '')
        # Recognise both literal paths and adjacent string arguments to join().
        text = text.replace('\\/', '/').replace('\\.', '.')
        original = text
        separators = re.compile(r'''['"`]\s*,\s*['"`]''')
        joins = list(separators.finditer(original))
        text = separators.sub('/', original)
        for match in re.finditer(r'[\w.@+-]+(?:/[\w.@+-]+)*', text):
            token = match.group()
            if '.' not in token and '/' not in token and token not in roots:
                continue
            parts = token.split('/')
            if any(excluded('/'.join(parts[i:]), patterns) for i in range(len(parts))):
                # Map past collapsed arguments back to the original source.
                offset = match.start()
                for seam in joins:
                    if seam.start() > offset:
                        break
                    offset += seam.end() - seam.start() - 1
                line = original[:offset].count('\n') + 1
                path = file.relative_to(tree).as_posix()
                raise ValueError(f'{path}:{line}: excluded test input {token}')
    print('Test inputs: pass')


def export_tree(source, ref, tree):
    sha = git(source, 'rev-parse', '--verify', ref + '^{commit}').decode().strip()
    patterns = [p.strip() for p in git(source, 'show', sha + ':.public-exclude').decode().splitlines()
                if p.strip() and not p.lstrip().startswith('#')]
    policy = json.loads(git(source, 'show', sha + ':.public-privacy.json'))
    overlays = json.loads(git(source, 'show', sha + ':.public-map.json'))
    if not isinstance(overlays, dict):
        raise ValueError('Public mapping must be a source-to-destination object')
    for original, destination in overlays.items():
        for path in (original, destination):
            if not isinstance(path, str) or not path or Path(path).is_absolute() or any(
                    part in ('..', '.git') for part in Path(path).parts) or Path(path) == Path('.'):
                raise ValueError('Unsafe public mapping path')
        if excluded(destination, patterns):
            raise ValueError('Public mapping destination is excluded: ' + destination)
    if len(set(overlays.values())) != len(overlays):
        raise ValueError('Duplicate public mapping destination')
    pending = set(overlays)
    for entry in git(source, 'ls-tree', '-rz', '--full-tree', sha).split(b'\0'):
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        path = raw_path.decode('utf-8')
        if path not in overlays and excluded(path, patterns):
            continue
        mode, kind, oid = metadata.decode().split()
        # Fail closed on links: never let a scanner follow a link outside its tree.
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError('Unsupported link or submodule: ' + path)
        if Path(path).is_absolute() or '..' in Path(path).parts or '.git' in Path(path).parts:
            raise ValueError('Unsafe tree path')
        destination = overlays.get(path, path)
        pending.discard(path)
        target = tree / destination
        if target.exists():
            raise ValueError('Public mapping collides with a tree path: ' + destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(source, 'cat-file', 'blob', oid))
        target.chmod(0o755 if mode == '100755' else 0o644)
    if pending:
        raise ValueError('Missing public mapping sources: ' + ', '.join(sorted(pending)))
    if not (tree / 'README.md').is_file() or not list((tree / '.github/workflows').glob('*.y*ml')):
        raise ValueError('The selected ref must contain README.md and .github/workflows')
    check_test_inputs(tree, patterns)
    return policy


def png_text(data):
    """Scan PNG metadata, rather than random compressed pixel bytes; fail closed."""
    def inflate(payload):
        decoder = zlib.decompressobj()
        text = decoder.decompress(payload, 1024 * 1024 + 1)
        if len(text) > 1024 * 1024 or not decoder.eof or decoder.unused_data:
            raise ValueError('Invalid or oversized compressed PNG metadata')
        return text

    offset, texts, first = 8, [], True
    while offset + 12 <= len(data):
        size = int.from_bytes(data[offset:offset + 4], 'big')
        end = offset + 12 + size
        if end > len(data):
            break
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:end - 4]
        checksum = int.from_bytes(data[end - 4:end], 'big')
        if zlib.crc32(kind + payload) != checksum:
            raise ValueError('Invalid PNG checksum')
        if first and (kind != b'IHDR' or size != 13):
            raise ValueError('Invalid PNG header')
        first = False
        if kind == b'zTXt':
            keyword, separator, rest = payload.partition(b'\0')
            if not separator or not rest or rest[0] != 0:
                raise ValueError('Invalid compressed PNG text')
            texts.append(keyword + b'\0' + inflate(rest[1:]))
        elif kind == b'iTXt':
            keyword, separator, rest = payload.partition(b'\0')
            fields = rest[2:].split(b'\0', 2)
            if not separator or len(rest) < 2 or rest[0] not in (0, 1) or rest[1] != 0 or len(fields) != 3:
                raise ValueError('Invalid international PNG text')
            language, translated, text = fields
            texts.append(b'\0'.join([keyword, language, translated, inflate(text) if rest[0] else text]))
        elif kind not in (b'IHDR', b'IDAT', b'PLTE', b'tRNS', b'IEND'):
            texts.append(payload)
        if kind == b'IEND':
            if size or end != len(data):
                raise ValueError('Invalid PNG ending')
            return b'\n'.join(texts).decode('utf-8', errors='replace')
        offset = end
    raise ValueError('Incomplete PNG')


def privacy(tree, policy):
    rules = [(r['id'], re.compile(r['pattern'], re.I)) for r in policy['deny']]
    allowances = [(a['rule'], re.compile(a['path']), re.compile(a['value'], re.I)) for a in policy['allow']]
    failures = []
    for file in sorted(tree.rglob('*')):
        if not file.is_file():
            continue
        path = file.relative_to(tree).as_posix()
        # Scan raw UTF-8 and null-padded ASCII terms (UTF-16/32), plus filenames.
        data = file.read_bytes()
        content = png_text(data) if data.startswith(b'\x89PNG\r\n\x1a\n') else data.decode('utf-8', errors='replace')
        views = [path, content]
        if '\0' in content:
            views.append(content.replace('\0', ''))
        for text in views:
            for name, pattern in rules:
                for match in pattern.finditer(text):
                    if not any(rule == name and p.search(path) and v.fullmatch(match.group())
                               for rule, p, v in allowances):
                        failures.append(f'{path}:{text[:match.start()].count(chr(10)) + 1}: {name}')
    if failures:
        raise ValueError('Privacy deny-list failed:\n' + '\n'.join(dict.fromkeys(failures)))
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


def rehearse(repo, commit, checkout):
    # Run on a separate checkout: install/build output must never enter the
    # scanned tree or alter the commit that will be pushed. These steps prove the
    # snapshot is a complete, consistent checkout; the hosted release workflow's
    # check job runs the test suite on the published tree before any release.
    git(repo, 'update-ref', 'refs/heads/main', commit)
    git(repo, 'clone', '-q', '--branch', 'main', str(repo), str(checkout))
    pnpm = shutil.which('pnpm') if os.name == 'nt' else 'pnpm'
    if not pnpm:
        raise ValueError('Public checkout rehearsal requires pnpm; publication blocked')
    deadline = time.monotonic() + 30 * 60
    for args in (['install', '--frozen-lockfile'], ['typecheck'], ['lint']):
        print('Public checkout rehearsal: pnpm ' + ' '.join(args), flush=True)
        # Keep raw output out of diagnostics, as with Git and the scanner.
        with subprocess.Popen([pnpm, *args], cwd=checkout, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, start_new_session=True) as process:
            try:
                status = process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                if os.name == 'posix':
                    # pnpm launches child processes; stop the whole rehearsal.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    # Terminate descendants before their launcher disappears.
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    process.kill()
                process.wait()
                raise ValueError('Public checkout rehearsal exceeded 30 minutes; publication blocked') from None
            if status:
                raise subprocess.CalledProcessError(status, ['pnpm', *args])
    print('Public checkout rehearsal: pass')


def publish(args):
    if args.dry_run and args.no_rehearsal:
        raise ValueError('--no-rehearsal is refused on a dry run: the dry run is the rehearsal a publish may skip')
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
                for finding in json.loads(report.read_text(encoding='utf-8')):
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
        if args.no_rehearsal:
            print('Public checkout rehearsal: skipped (--no-rehearsal)')
        else:
            rehearse(repo, commit, scratch / 'rehearsal')
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
    parser.add_argument('--no-rehearsal', action='store_true',
                        help='Publish without the public checkout rehearsal: only after a passing dry run '
                             'of the same ref and version (refused with --dry-run)')
    parser.add_argument('--gitleaks', help='Path to pinned gitleaks (also the test seam)')
    try:
        publish(parser.parse_args())
    except subprocess.CalledProcessError as error:
        operation = 'required command'
        if error.cmd[:2] == ['git', '-C'] and len(error.cmd) > 3:
            operation = 'git ' + error.cmd[3]
        elif error.cmd[0] == 'pnpm':
            operation = 'pnpm ' + ' '.join(error.cmd[1:])
        # Report the operation, never URLs, credentials or raw command output.
        print(f'Publish failed: {operation} failed (exit {error.returncode}); publication blocked', file=sys.stderr)
        return 1
    except (ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env bash
# Accept the current PR head's hosted captures. No browser or image generation runs here.
set -euo pipefail
[[ "${1:-}" =~ ^[1-9][0-9]*$ ]] || { echo 'Usage: scripts/gallery-accept.sh <pr> [reviewed-capture.png ...]' >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
python3 - "$(dirname "${BASH_SOURCE[0]}")" "$root" "$@" <<'PY'
import hashlib, json, os, pathlib, re, shlex, struct, subprocess, sys, tempfile, urllib.parse, urllib.request
sys.path.insert(0, sys.argv[1])
from gallery_reports import validate_shard, complete_set, phone_dimensions, MAX_BYTES, MAX_THREAD_BYTES
from gallery_allocation import LIMITS, captures_fit_allocation
root = pathlib.Path(sys.argv[2]); number = sys.argv[3]
selected = set(sys.argv[4:])
if any(not re.fullmatch(r'[a-z0-9-]+[.](dark|light)[.]png', name) for name in selected):
    sys.exit('Expected exact reviewed capture filenames.')
remote = urllib.parse.urlsplit(subprocess.check_output(['git', '-C', str(root), 'remote', 'get-url', 'origin'], text=True).strip())
base = os.environ.get('FORGEJO_URL', f'{remote.scheme}://{remote.netloc}').rstrip('/')
repository = os.environ.get('FORGEJO_REPOSITORY', remote.path.strip('/').removesuffix('.git'))
origin = urllib.parse.urlsplit(base)
if origin.scheme not in ('https', 'http') or not re.fullmatch(r'[A-Za-z0-9._-]+/[A-Za-z0-9._-]+', repository):
    sys.exit('Expected an HTTP Forgejo origin or FORGEJO_URL and FORGEJO_REPOSITORY.')
token = os.environ.get('FORGEJO_TOKEN')
if not token:
    credential = subprocess.check_output(['git', 'credential', 'fill'], input=f'protocol={origin.scheme}\nhost={origin.netloc}\n\n', text=True)
    token = dict(line.split('=', 1) for line in credential.splitlines() if '=' in line)['password']
# API downloads never redirect credentials to another origin.
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
opener = urllib.request.build_opener(NoRedirect())
def get(url, limit=4*1024*1024):
    request = urllib.request.Request(url, headers={'Authorization': 'token ' + token})
    with opener.open(request, timeout=120) as response:
        data = response.read(limit+1)
    if len(data) > limit: sys.exit('Gallery response exceeds its size limit.')
    return data
api = f'{base}/api/v1/repos/{repository}'
pr = json.loads(get(f'{api}/pulls/{number}'))
head = pr['head']['sha']
if subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() != head:
    sys.exit('Check out the PR head before accepting its captures.')
# Forgejo returns the entire per-issue comment thread; page and limit are ignored.
comments = json.loads(get(f'{api}/issues/{number}/comments', limit=MAX_THREAD_BYTES))
if not isinstance(comments, list): sys.exit('Invalid gallery comment list.')
manifests = []
latest_attempt = None
finalized = set()
for comment in comments:
    # Only the reserved Forgejo Actions identity can supply relay reports.
    author = comment.get('user')
    if not isinstance(author, dict) or author.get('id') != -2: continue
    body = comment.get('body', '')
    attempts = re.findall(r'<!-- window-gallery-attempt (.*?) -->', body, re.S)
    if attempts:
        try: attempt = json.loads(attempts[-1])
        except json.JSONDecodeError: attempt = None
        if isinstance(attempt, dict) and attempt.get('head') == head:
            latest_attempt = comment.get('id')
    # Recognize unfinished reports from before structured attempt markers existed.
    if body.startswith(f'Window gallery for `{head}`.') and ('Uploading captures…' in body or 'Gallery upload failed during ' in body):
        latest_attempt = comment.get('id')
    matches = re.findall(r'<!-- window-gallery (.*?) -->', body, re.S)
    if matches:
        try: candidate = json.loads(matches[-1])
        except json.JSONDecodeError: continue
        if not isinstance(candidate, dict) or candidate.get('head') != head: continue
        version = candidate.get('version', head)
        if (version != head and (not isinstance(comment.get("id"), int) or comment["id"] < 1 or version != f'{head}-{comment["id"]}')): continue
        files = candidate.get('captures')
        limit = 400 if 'shard' in candidate else sum(LIMITS.values())
        if not isinstance(files, list) or not files or len(files) > limit: continue
        if not all(isinstance(item, dict) and all(isinstance(item.get(key), str) for key in ('name', 'api_url')) for item in files): continue
        if 'shard' in candidate:
            try: validate_shard(candidate['shard'], len(files), require_group=True)
            except ValueError as error: sys.exit(str(error))
        elif not captures_fit_allocation([item['name'] for item in files]): continue
        manifests.append(candidate)
        finalized.add(comment.get('id'))
        latest_attempt = comment.get('id')
if latest_attempt is not None and latest_attempt not in finalized:
    sys.exit('Latest gallery publication is incomplete. Wait for every report or retry the gallery job.')
if not manifests: sys.exit('No gallery captures on the current PR head. Wait for the gallery job.')
try: reports = complete_set(manifests)
except ValueError as error: sys.exit(str(error))
files = [dict(item, version=report.get('version', head), report=index) for index, report in enumerate(reports) for item in report['captures']]
names = [item['name'] for item in files]
if len(set(names)) != len(names): sys.exit('Invalid or duplicate gallery filename.')
if selected - set(names): sys.exit('A requested capture is absent from the current report.')
staging = tempfile.TemporaryDirectory(prefix="gallery-accept-")
accepted = {}; totals = {}
for item in files:
    name, url, version = item['name'], item['api_url'], item['version']
    parsed = urllib.parse.urlsplit(url)
    if not re.fullmatch(r'[a-z0-9-]+[.](dark|light)[.]png', name) or name in accepted:
        sys.exit('Invalid or duplicate gallery filename.')
    if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc) or parsed.path != f'/api/packages/{repository.split("/")[0]}/generic/window-gallery/{version}/{name}' or parsed.query or parsed.fragment:
        sys.exit('Invalid gallery attachment origin.')
    if selected and name not in selected: continue
    data = get(url, limit=48*1024*1024)
    digest = item.get('sha256')
    if (version != head or digest is not None) and (not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest) or hashlib.sha256(data).hexdigest() != digest):
        sys.exit('Gallery capture bytes do not match the reviewed manifest.')
    if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR': sys.exit('Gallery attachment is not a PNG.')
    dimensions = struct.unpack('>II', data[16:24])
    if name.startswith('phone-'):
        if dimensions != phone_dimensions(name): sys.exit('Unexpected phone gallery dimensions.')
    elif dimensions not in ((1400, 900), (1024, 768)): sys.exit('Unexpected gallery dimensions.')
    totals[item['report']] = totals.get(item['report'], 0) + len(data)
    if totals[item['report']] > MAX_BYTES: sys.exit('Gallery captures exceed their size limit.')
    staged = pathlib.Path(staging.name) / name
    staged.write_bytes(data)
    accepted[name] = staged
# Validate and download every selected capture before writing any baseline.
folder = root / 'packages/gui/gallery/baselines'
folder.mkdir(parents=True, exist_ok=True)
if folder.is_symlink(): sys.exit('The baseline directory must not be a symlink.')
for name, staged in accepted.items():
    target = folder / name
    if target.is_symlink(): sys.exit('A baseline must not be a symlink.')
for name, staged in accepted.items():
    target = folder / name
    temporary = target.with_suffix('.png.tmp')
    if temporary.is_symlink(): sys.exit('A temporary baseline must not be a symlink.')
    temporary.write_bytes(staged.read_bytes()); temporary.replace(target)
    print(f'Accepted {name}')
print('Commit and push the reviewed baselines, then wait for green gallery checks:')
commands = [
    ['git', '-C', str(root), 'add', '--', *[str((folder / name).relative_to(root)) for name in accepted]],
    ['git', '-C', str(root), 'commit', '-m', f'gallery: accept reviewed captures (PR #{number})'],
    ['git', '-C', str(root), 'push', 'origin', 'HEAD:' + pr['head']['ref']],
]
for command in commands: print(shlex.join(command))
PY

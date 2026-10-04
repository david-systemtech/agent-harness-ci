#!/usr/bin/env bash
# Accept the current PR head's hosted captures. No browser or image generation runs here.
set -euo pipefail
[[ "${1:-}" =~ ^[1-9][0-9]*$ ]] || { echo 'Usage: scripts/gallery-accept.sh <pr> [reviewed-capture.png ...]' >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
python3 - "$root" "$@" <<'PY'
import hashlib, json, os, pathlib, re, shlex, struct, subprocess, sys, urllib.parse, urllib.request
root = pathlib.Path(sys.argv[1]); number = sys.argv[2]
selected = set(sys.argv[3:])
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
comments = json.loads(get(f'{api}/issues/{number}/comments'))
if not isinstance(comments, list): sys.exit('Invalid gallery comment list.')
manifests = {}
for comment in comments:
    # Only the reserved Forgejo Actions identity can supply relay reports.
    author = comment.get('user')
    if not isinstance(author, dict) or author.get('id') != -2: continue
    matches = re.findall(r'<!-- window-gallery (.*?) -->', comment.get('body', ''), re.S)
    if matches:
        try: candidate = json.loads(matches[-1])
        except json.JSONDecodeError: continue
        if not isinstance(candidate, dict) or candidate.get('head') != head: continue
        version = candidate.get('version', head)
        if (version != head and (not isinstance(comment.get("id"), int) or comment["id"] < 1 or version != f'{head}-{comment["id"]}')): continue
        files = candidate.get('captures')
        if not isinstance(files, list) or not files or len(files) > 400: continue
        if not all(isinstance(item, dict) and all(isinstance(item.get(key), str) for key in ('name', 'api_url')) for item in files): continue
        key = tuple(item["name"] for item in files)
        manifests.pop(key, None)
        manifests[key] = candidate
if not manifests: sys.exit('No gallery captures on the current PR head. Wait for the gallery job.')
# Newest bytes win for overlapping names; independent bounded reports remain reviewable together.
files_by_name = {}
for manifest in manifests.values():
    version = manifest.get('version', head)
    files = manifest['captures']
    names = [item['name'] for item in files]
    if len(set(names)) != len(names): sys.exit('Invalid or duplicate gallery filename.')
    for item in files: files_by_name[item['name']] = (item, version)
if selected - set(files_by_name): sys.exit('A requested capture is absent from the current report.')
accepted = {}; total = 0
for item, version in files_by_name.values():
    name, url = item['name'], item['api_url']
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
    phone = re.search(r'-phone-(390(?:-text-20|-keyboard)?|360)[.](dark|light)[.]png$', name)
    if name.startswith('phone-'):
        profiles = {'390': (390, 844), '360': (360, 740), '390-text-20': (390, 844), '390-keyboard': (390, 480)}
        if phone is None or dimensions != profiles[phone[1]]: sys.exit('Unexpected phone gallery dimensions.')
    elif dimensions not in ((1400, 900), (1024, 768)): sys.exit('Unexpected gallery dimensions.')
    total += len(data)
    if total > 48*1024*1024: sys.exit('Gallery captures exceed their size limit.')
    accepted[name] = data
# Validate and download every selected capture before writing any baseline.
folder = root / 'packages/gui/gallery/baselines'
folder.mkdir(parents=True, exist_ok=True)
if folder.is_symlink(): sys.exit('The baseline directory must not be a symlink.')
for name, data in accepted.items():
    target = folder / name
    if target.is_symlink(): sys.exit('A baseline must not be a symlink.')
for name, data in accepted.items():
    target = folder / name
    temporary = target.with_suffix('.png.tmp')
    if temporary.is_symlink(): sys.exit('A temporary baseline must not be a symlink.')
    temporary.write_bytes(data); temporary.replace(target)
    print(f'Accepted {name}')
print('Commit and push the reviewed baselines, then wait for green gallery checks:')
commands = [
    ['git', '-C', str(root), 'add', '--', *[str((folder / name).relative_to(root)) for name in accepted]],
    ['git', '-C', str(root), 'commit', '-m', f'gallery: accept reviewed captures (PR #{number})'],
    ['git', '-C', str(root), 'push', 'origin', 'HEAD:' + pr['head']['ref']],
]
for command in commands: print(shlex.join(command))
PY

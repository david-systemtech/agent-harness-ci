#!/usr/bin/env bash
# Attach the hosted gallery's PNGs to a comment on the current PR head.
set -euo pipefail
: "${FORGEJO_URL:?}" "${FORGEJO_REPOSITORY:?}" "${FORGEJO_PR:?}" "${FORGEJO_TOKEN:?}"
[[ "$FORGEJO_PR" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ "$FORGEJO_REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || exit 1
archive=$1 sha=$2
api="$FORGEJO_URL/api/v1/repos/$FORGEJO_REPOSITORY"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fj_api() {
  curl -sSf --connect-timeout 15 --max-time 120 \
    -H @<(printf 'Authorization: token %s\n' "$FORGEJO_TOKEN") "$@"
}
# Never publish an old head that finished after a replacement or a closed PR.
fj_api -o "$work/pr.json" "$api/pulls/$FORGEJO_PR"
python3 - "$work/pr.json" "$sha" <<'PY'
import json,sys
with open(sys.argv[1]) as f: pr=json.load(f)
if pr['state'] != 'open' or pr.get('merged') or pr['head']['sha'] != sys.argv[2]: sys.exit(2)
PY
# No extraction of paths from an untrusted archive. Match the hosted gallery and report publisher:
# 1200 PNGs, 48 MiB expanded, 64 MiB ZIP including headers and compression overhead.
python3 - "$archive" "$work" <<'PY'
import pathlib,re,sys,zipfile
archive=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])
if archive.stat().st_size > 64*1024*1024: raise ValueError('gallery zip is too large')
with zipfile.ZipFile(archive) as z:
    files=z.infolist()
    if not files or len(files)>1200 or sum(f.file_size for f in files)>48*1024*1024: raise ValueError('gallery payload is too large')
    names=set()
    for f in files:
        if not re.fullmatch(r'[a-z0-9-]+[.](light|dark)[.]png',f.filename) or f.filename in names: raise ValueError('unexpected gallery entry')
        names.add(f.filename)
        data=z.read(f)
        if not data.startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError('gallery entry is not a PNG')
        (out/f.filename).write_bytes(data)
PY
python3 - "$sha" > "$work/comment.json" <<'PY'
import json,sys
print(json.dumps({'body':f'Window gallery for `{sys.argv[1]}` (1400 × 900, light and dark). Uploading screenshots…'}))
PY
fj_api -X POST -H 'Content-Type: application/json' --data-binary "@$work/comment.json" -o "$work/comment-reply.json" "$api/issues/$FORGEJO_PR/comments"
comment=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1]))["id"]))' "$work/comment-reply.json")
for png in "$work"/*.png; do
  fj_api -X POST -F "attachment=@$png;type=image/png" -o "$png.json" "$api/issues/comments/$comment/assets"
done
python3 - "$work" "$sha" <<'PY'
import json,pathlib,sys
folder=pathlib.Path(sys.argv[1]); body=f'Window gallery for `{sys.argv[2]}` (1400 × 900, light and dark).\n'
for path in sorted(folder.glob('*.png.json')):
    asset=json.loads(path.read_text()); name=path.name.removesuffix('.json')
    url=asset['browser_download_url']
    if not url.startswith(('https://','http://')) or any(c in url for c in '\n\r()'): raise ValueError('invalid asset URL')
    body+=f'\n![{name}]({url})\n'
(folder/'comment.json').write_text(json.dumps({'body':body}))
PY
fj_api -X PATCH -H 'Content-Type: application/json' --data-binary "@$work/comment.json" -o /dev/null "$api/issues/comments/$comment"
echo "Gallery posted on pull request $FORGEJO_PR"

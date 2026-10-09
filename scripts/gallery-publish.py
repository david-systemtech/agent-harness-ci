"""Publish validated hosted reports from the trusted checkout only."""
import hashlib, html, json, os, re, signal, struct, sys, time, urllib.error, urllib.parse, urllib.request, uuid, zipfile
from gallery_reports import validate_shard, complete_set, phone_dimensions, MAX_ROWS, MAX_BYTES, MAX_THREAD_BYTES
from gallery_allocation import LIMITS, MAX_PNGS, report_scenes
base = os.environ['FORGEJO_URL'].rstrip('/')
repository = os.environ['FORGEJO_REPOSITORY']; pr = os.environ['FORGEJO_PR']; head = sys.argv[1]
if not re.fullmatch(r'[1-9][0-9]*', pr) or not re.fullmatch(r'[A-Za-z0-9._-]+/[A-Za-z0-9._-]+', repository): sys.exit('Invalid gallery destination')
api = f'{base}/api/v1/repos/{repository}'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
opener = urllib.request.build_opener(NoRedirect())
# Socket inactivity timeouts do not bound a slow response or the whole shard set.
# This trusted publisher runs on the Unix relay, in its main thread.
REQUEST_SECONDS = 60
publication_deadline = None
class UploadTimeout(TimeoutError): pass
class UploadInterrupted(Exception): pass
def expired(signum, frame):
    raise UploadTimeout('Gallery request or publication deadline exceeded')
def interrupted(signum, frame):
    raise UploadInterrupted('Gallery publication interrupted')
signal.signal(signal.SIGALRM, expired)
signal.signal(signal.SIGTERM, interrupted)
def absolute_request(url, method='GET', data=None, content_type='application/json', token=None, expected_bytes=None, max_bytes=None):
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'token ' + (token or os.environ['FORGEJO_TOKEN']), 'Content-Type': content_type})
    remaining = REQUEST_SECONDS if publication_deadline is None else min(REQUEST_SECONDS, publication_deadline - time.monotonic())
    if remaining <= 0: raise UploadTimeout('Gallery publication deadline exceeded')
    signal.setitimer(signal.ITIMER_REAL, remaining)
    try:
        with opener.open(req, timeout=remaining) as response:
            limit = len(expected_bytes) if expected_bytes is not None else max_bytes
            reply = response.read() if limit is None else response.read(limit + 1)
            if expected_bytes is not None:
                if reply != expected_bytes: raise ValueError('Existing gallery capture has different bytes')
                return None
            if max_bytes is not None and len(reply) > max_bytes: raise ValueError('Gallery response is too large')
            return json.loads(reply) if reply else None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
def request(path, method='GET', data=None, content_type='application/json'):
    return absolute_request(api + path, method, data, content_type)
def recover_comment(placeholder):
    # Forgejo returns the complete thread, ignoring pagination. Do not retry a
    # non-idempotent POST: only this attempt's relay-authored comment may change.
    comments = absolute_request(f'{api}/issues/{pr}/comments', max_bytes=MAX_THREAD_BYTES)
    if not isinstance(comments, list): raise ValueError('Invalid gallery comment list')
    matches = [comment['id'] for comment in comments if isinstance(comment, dict)
               and isinstance(comment.get('user'), dict) and comment['user'].get('id') == -2
               and comment.get('body') == placeholder
               and type(comment.get('id')) is int and comment['id'] > 0]
    if len(matches) != 1: raise ValueError('Could not recover the gallery comment')
    return matches[0]
current = request(f'/pulls/{pr}')
if current['state'] != 'open' or current.get('merged') or current['head']['sha'] != head:
    print('Gallery report rejected: the PR is closed, merged, or its head changed.', file=sys.stderr)
    sys.exit(2)
def read_report(archive):
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        # Bound bytes before reading entries; older named shards share one archive.
        if len(entries) > MAX_PNGS + 2 or sum(f.file_size for f in entries) > MAX_BYTES: sys.exit('gallery payload is too large')
        names = [f.filename for f in entries]
        if len(set(names)) != len(names): sys.exit('unexpected gallery entry')
        report = json.loads(z.read('report.json'))
        combined = 'shards' in report
        if combined and 'shard' in report: sys.exit('Mixed gallery report formats')
        max_pngs = MAX_PNGS if combined else MAX_ROWS * 3
        if len(entries) > max_pngs + 2 or sum(f.filename.endswith('.png') for f in entries) > max_pngs: sys.exit('gallery payload is too large')
        if any(not re.fullmatch(r'[a-z0-9-]+[.](dark|light)([.](baseline|difference))?[.]png|report[.]json|geometry[.]json', n) for n in names): sys.exit('unexpected gallery entry')
        scenes = report_scenes(report)
        if combined and report.get('pixelBlocking') is not True: sys.exit('Every shard capture remains gated')
        images = {n: z.read(n) for n in names if n.endswith('.png')}
        for name, data in images.items():
            if not data.startswith(b'\x89PNG\r\n\x1a\n'): sys.exit('gallery entry is not a PNG')
            if 'shard' in report and not name.startswith('phone-'):
                if len(data) < 33 or data[12:16] != b'IHDR' or struct.unpack('>II', data[16:24]) not in ((1400, 900), (1024, 768)): sys.exit('unexpected desktop gallery dimensions')
            if name.startswith('phone-'):
                if len(data) < 33 or data[12:16] != b'IHDR' or struct.unpack('>II', data[16:24]) != phone_dimensions(name): sys.exit('unexpected phone gallery dimensions')
        seen = set()
        for scene in scenes:
            name = scene['name']
            if not re.fullmatch(r'[a-z0-9-]+[.](dark|light)', name) or name in seen: sys.exit('invalid gallery scene name')
            seen.add(name)
            required = [name + '.png']
            if scene['status'] == 'changed': required += [name + '.baseline.png', name + '.difference.png']
            if scene['status'] not in ('new', 'changed', 'unchanged') or any(n not in images for n in required): sys.exit('incomplete gallery triplet')
        allowed_images = {name + suffix for name in seen for suffix in ('.png', '.baseline.png', '.difference.png')}
        if set(images) - allowed_images: sys.exit('unreported gallery image')
        if re.search(r'gallery-(?:shard-[1-9][0-9]*|(?:desktop|phone)-[0-9]{3})[.]zip$', archive) and 'shard' not in report: sys.exit('Missing gallery shard metadata')
        if 'shard' in report:
            if 'id' in report['shard']:
                report['shard']['group'] = os.environ.get('GALLERY_PUBLICATION_RUN', '')
            validate_shard(report['shard'], len(scenes))
            if report.get('pixelBlocking') is not True: sys.exit('Every shard capture remains gated')
            if 'id' in report['shard']:
                match = re.search(r'gallery-((?:desktop|phone)-[0-9]{3})[.]zip$', archive)
                if match is None or match[1] != report['shard']['id']: sys.exit('Gallery artifact and shard id differ')
                if any(scene['name'].startswith('phone-') != report['shard']['id'].startswith('phone-') for scene in scenes): sys.exit('Gallery capture and shard family differ')
            else:
                match = re.search(r'gallery-shard-([1-9][0-9]*)[.]zip$', archive)
            single = 'id' not in report['shard'] and archive.endswith('/gallery.zip') and report['shard']['index'] == report['shard']['count'] == 1
            if 'id' not in report['shard'] and not single and (match is None or int(match[1]) != report['shard']['index']): sys.exit('Gallery artifact and shard index differ')
        expected = {scene['name'] + suffix for scene in scenes for suffix in (('.png', '.baseline.png', '.difference.png') if scene['status'] == 'changed' else ('.png',))}
        if ('shard' in report or combined) and set(images) != expected: sys.exit('Unexpected gallery shard images')
    return report, images, scenes

reports = [read_report(archive) for archive in sys.argv[2:]]
shards = [report.get('shard') for report, _, _ in reports]
if any(shard is not None for shard in shards):
    if any(shard is None for shard in shards): sys.exit('Mixed gallery report formats')
    manifests = [dict(report, captures=[{'name': scene['name']} for scene in scenes]) for report, _, scenes in reports]
    if len({('named', shard['group']) if 'id' in shard else ('numbered', shard['run']) for shard in shards}) != 1: sys.exit('Inconsistent gallery shard runs')
    if len({shard['index'] for shard in shards}) != len(shards): sys.exit('Duplicate gallery shard index')
    ordered = complete_set(manifests)
    if len(ordered) != len(reports): sys.exit('Incomplete gallery shard set')
elif len(reports) != 1: sys.exit('Duplicate gallery artifact')

# The hosted matrix is the expected set, independent of artifact/job discovery.
plan_path = os.environ.get('GALLERY_PLAN')
if plan_path:
    with open(plan_path) as source: plan = json.load(source)
    by_artifact = {row['artifact'].removeprefix('window-') + '.zip': (index, row) for index, row in enumerate(plan)}
    if {os.path.basename(path) for path in sys.argv[2:]} != set(by_artifact): sys.exit('Incomplete planned gallery reports')
    for path, (report, _, _) in zip(sys.argv[2:], reports):
        index, row = by_artifact[os.path.basename(path)]
        if not row['legacy']:
            shard = report.get('shard', {})
            if shard.get('id') != row['shard'] or shard.get('index') != index or shard.get('count') != len(plan):
                sys.exit('Gallery report differs from hosted plan')
        if report.get('pixelBlocking') is not True: sys.exit('Every planned capture remains gated')

package_token = os.environ.get('PACKAGES_TOKEN')
if not package_token: sys.exit('PACKAGES_TOKEN is required to publish gallery captures.')
# Allow one second per bounded API operation, including verification of reused
# packages, with a ten-minute floor. The relay still bounds the complete job.
operations = sum(len(images) + 2 * len(scenes) + 2 for _, images, scenes in reports)
publication_deadline = time.monotonic() + max(600, operations)
for report, images, scenes in reports:
    attempt = '\n<!-- window-gallery-attempt ' + json.dumps({'head': head, 'publication': str(uuid.uuid4()), **({'shard': report['shard']} if 'shard' in report else {})}) + ' -->\n'
    placeholder = f'Window gallery for `{head}`. Uploading captures…' + attempt
    comment = None
    stage = 'comment creation'
    try:
        comment = request(f'/issues/{pr}/comments', 'POST', json.dumps({'body': placeholder}).encode())['id']
        version = f'{head}-{comment}'
        urls = {}
        for name, data in sorted(images.items()):
            stage = f'attachment {name}'
            boundary = 'gallery-upload-boundary'
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
            asset = request(f'/issues/comments/{comment}/assets', 'POST', body, f'multipart/form-data; boundary={boundary}')
            url = asset['browser_download_url']; parsed = urllib.parse.urlsplit(url); origin = urllib.parse.urlsplit(base)
            if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc) or not parsed.path.startswith('/attachments/') or any(c in url for c in '\n\r()'): raise ValueError('invalid asset URL')
            urls[name] = url
        body = f'Window gallery for `{head}` (desktop 1400 × 900 / 1024 × 768; phone 320–430 CSS pixels, tall and short; text size 20; keyboard 390 × 480; light and dark).\n'
        budget = report.get('captureBudget')
        if isinstance(budget, dict) and all(isinstance(budget.get(k), int) for k in ('desktop', 'phone', 'total', 'limit', 'remaining')):
            body += f"\nCapture budget: {budget['desktop']} desktop + {budget['phone']} phone = {budget['total']}/{budget['limit']}; {budget['remaining']} slots reserved.\n"
        if 'shards' in report:
            body += '\nReport shards: ' + ', '.join(f"{shard['name']} {len(shard['scenes'])}/{LIMITS[shard['name']]}" for shard in report['shards']) + '.\n'
        geometry_failed = any(s['geometryFailures'] for s in scenes)
        pixel_failed = any(s['pixelFailed'] for s in scenes)
        body += f"\nGeometry: {'failed' if geometry_failed else 'passed'}. Pixels: {'blocking' if report['pixelBlocking'] else 'advisory'}; {'differences' if pixel_failed else 'passed'}.\n"
        matched = sum(s['status'] == 'unchanged' for s in scenes)
        body += f'\n{matched} scene{"" if matched == 1 else "s"} matched.\n'
        for scene in scenes:
            name = scene['name']
            if scene['status'] == 'changed':
                body += f'\n**{name}**\n\n| Baseline | Capture | Difference |\n| --- | --- | --- |\n'
                body += '| ' + ' | '.join(f'![{kind} {name}]({urls[name+suffix]})' for kind,suffix in [('baseline','.baseline.png'),('capture','.png'),('difference','.difference.png')]) + ' |\n'
            elif scene['status'] == 'new' or scene['geometryFailures']:
                body += f'\n**{name}** ({scene["status"]})\n\n![capture {name}]({urls[name+".png"]})\n'
            for failure in scene['geometryFailures']: body += f'\n- {html.escape(failure)}\n'
        # The web attachment route can be behind SSO while the tracker API accepts tokens.
        # Publish capture bytes through the generic package API too, so acceptance needs no browser cookie.
        captures = []
        for scene in scenes:
            name = scene['name'] + '.png'
            stage = f'capture storage {name}'
            download = f'{base}/api/packages/{repository.split("/")[0]}/generic/window-gallery/{version}/{name}'
            try: absolute_request(download, 'PUT', images[name], 'image/png', token=package_token)
            except urllib.error.HTTPError as error:
                if error.code != 409: raise
                # Reusing this report version is safe only when its bytes are identical.
                absolute_request(download, token=package_token, expected_bytes=images[name])
            captures.append({'name': name, 'url': urls[name], 'api_url': download, 'sha256': hashlib.sha256(images[name]).hexdigest()})
        manifest = {'head': head, 'version': version, 'captures': captures}
        if 'shard' in report:
            manifest['shard'] = report['shard']
            if 'id' in report['shard']:
                body += f"\nReport shard {report['shard']['id']} ({report['shard']['index'] + 1}/{report['shard']['count']}); {len(scenes)} captures.\n"
            else:
                body += f"\nReport shard {report['shard']['index']}/{report['shard']['count']}; {len(scenes)} of {report['shard']['total']} captures.\n"
        body += '\n<!-- window-gallery ' + json.dumps(manifest) + ' -->\n'
        body += attempt
        stage = 'final report'
        request(f'/issues/comments/{comment}', 'PATCH', json.dumps({'body': body}).encode())
    except Exception as error:
        # Never include the API's response, credentials, or untrusted exception text.
        reason = f'HTTP {error.code}' if isinstance(error, urllib.error.HTTPError) else type(error).__name__
        failure = f'Window gallery for `{head}`.\n\nGallery upload failed during {stage} ({reason}). Rerun the gallery job; if it persists, check the relay log and package/attachment write permissions. No captures from this report can be accepted.' + attempt
        # Leave a fresh bounded request to finalize even after the publication budget expires.
        publication_deadline = None
        try:
            if comment is None: comment = recover_comment(placeholder)
            request(f'/issues/comments/{comment}', 'PATCH', json.dumps({'body': failure}).encode())
        except Exception: print('::error::Could not finalize the gallery comment; check tracker connectivity and rerun the gallery job.', file=sys.stderr)
        sys.exit(f'Gallery upload failed during {stage} ({reason}); rerun the gallery job.')
print(f'Gallery posted on pull request {pr}')
if plan_path and any(scene['pixelFailed'] or scene['geometryFailures'] for _, _, scenes in reports for scene in scenes):
    sys.exit('Gallery geometry or pixel comparison failed')

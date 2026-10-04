#!/usr/bin/env python3
"""Expire window-gallery versions after 30 days unless an open PR still uses them."""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from gallery_reports import validate_shard, MAX_THREAD_BYTES


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    base = os.environ['FORGEJO_URL'].rstrip('/')
    repository = os.environ['FORGEJO_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9._-]+/[A-Za-z0-9._-]+', repository):
        raise ValueError('Invalid gallery repository')
    owner = repository.split('/')[0]
    api = f'{base}/api/v1'
    package_path = f'/api/packages/{owner}/generic/window-gallery/'
    origin = urllib.parse.urlsplit(base)
    if origin.scheme not in ('http', 'https'):
        raise ValueError('Invalid gallery origin')
    opener = urllib.request.build_opener(NoRedirect())

    def request(path, method='GET', limit=4*1024*1024):
        # Package APIs are owner-scoped; the workflow's repository token cannot use them.
        token = (os.environ.get('PACKAGES_TOKEN') or os.environ['FORGEJO_TOKEN']) if path.startswith('/packages/') else os.environ['FORGEJO_TOKEN']
        req = urllib.request.Request(api + path, method=method, headers={
            'Authorization': 'token ' + token})
        with opener.open(req, timeout=120) as response:
            data = response.read(limit+1)
        if len(data) > limit:
            raise ValueError('Gallery response exceeds its size limit')
        return json.loads(data) if data else None

    def pages(path):
        separator = '&' if '?' in path else '?'
        for page in range(1, 1001):
            batch = request(f'{path}{separator}limit=50&page={page}')
            if not isinstance(batch, list):
                raise ValueError('Incomplete gallery listing')
            if not batch:
                return
            yield from batch
        raise ValueError('Gallery listing exceeds its page limit')

    protected = set()
    heads = set()
    # Read ALL protection data before the first DELETE. A failed page deletes nothing.
    for pr in pages(f'/repos/{repository}/pulls?state=open'):
        heads.add(pr['head']['sha'])
        # Per-issue comments are an unpaginated full thread in Forgejo.
        comments = request(f'/repos/{repository}/issues/{pr["number"]}/comments', limit=MAX_THREAD_BYTES)
        if not isinstance(comments, list):
            raise ValueError('Incomplete gallery comment listing')
        for comment in comments:
            if not isinstance(comment, dict):
                raise ValueError('Invalid gallery comment listing')
            # Forgejo's reserved Actions identity authors relay reports, including legacy ones.
            author = comment.get('user')
            if not isinstance(author, dict) or author.get('id') != -2:
                continue
            markers = re.findall(r'<!-- window-gallery (.*?) -->', comment.get('body', ''), re.S)
            if not markers:
                continue
            try:
                manifest = json.loads(markers[-1])
            except json.JSONDecodeError:
                continue
            if not isinstance(manifest, dict) or not isinstance(manifest.get('head'), str):
                continue
            head = manifest['head']
            version = manifest.get('version', head)
            if not re.fullmatch(r'[A-Za-z0-9_-]+', head) or (version != head and (not isinstance(comment.get("id"), int) or comment["id"] < 1 or version != f'{head}-{comment["id"]}')):
                continue
            captures = manifest.get('captures')
            if not isinstance(captures, list) or not captures or len(captures) > 400:
                continue
            if not all(isinstance(item, dict) and all(isinstance(item.get(key), str) for key in ('name', 'api_url')) for item in captures):
                continue
            if 'shard' in manifest:
                try:
                    validate_shard(manifest['shard'], len(captures))
                except ValueError:
                    continue
            if len({capture['name'] for capture in captures}) != len(captures):
                continue
            valid = True
            for capture in captures:
                parsed = urllib.parse.urlsplit(capture['api_url'])
                if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc) or parsed.query or parsed.fragment or not re.fullmatch(r'[a-z0-9-]+[.](light|dark)[.]png', capture['name']) or parsed.path != package_path + version + '/' + capture['name']:
                    valid = False
                    break
            if valid:
                protected.add(version)

    packages = list(pages(f'/packages/{owner}?type=generic&q=window-gallery'))
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
    expired = []
    for package in packages:
        if package['type'] != 'generic' or package['name'] != 'window-gallery':
            continue
        version = package['version']
        if version in protected or any(version == head or version.startswith(head + '-') for head in heads):
            continue
        created = datetime.datetime.fromisoformat(package['created_at'].replace('Z', '+00:00'))
        if created < cutoff:
            expired.append(version)
    # Finish validating the inventory too, before mutation changes pagination.
    for version in expired:
        path = f'/packages/{owner}/generic/window-gallery/{urllib.parse.quote(version, safe="")}'
        try:
            request(path, 'DELETE')
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        print(f'Expired gallery version {version}')
    print(f'Gallery retention: {len(expired)} expired; open PR manifests and heads preserved.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reason = f'HTTP {error.code}' if isinstance(error, urllib.error.HTTPError) else type(error).__name__
        sys.exit(f'Gallery retention failed ({reason}); check API access and listings, then rerun cleanup.')

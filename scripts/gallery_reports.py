"""Shared bounded report metadata and capture profiles for publication and acceptance."""
import math
import re

MAX_ROWS = 400
MAX_SHARDS = 16
MAX_BYTES = 48 * 1024 * 1024
MAX_ZIP = 64 * 1024 * 1024
# Full unpaginated threads include sixteen changed reports and earlier attempts.
MAX_THREAD_BYTES = MAX_SHARDS * 4 * 1024 * 1024

# Exact capture profiles, shared by trusted publication and baseline acceptance.
PHONE_PROFILES = {
    '320': (320, 568),
    '320-short': (320, 320),
    '360': (360, 740),
    '360-short': (360, 400),
    '390': (390, 844),
    '430': (430, 932),
    '430-short': (430, 360),
    '390-text-20': (390, 844),
    '390-keyboard': (390, 480),
}


def phone_dimensions(name):
    match = re.search(r'-phone-(' + '|'.join(map(re.escape, PHONE_PROFILES)) + r')[.](dark|light)([.](baseline|difference))?[.]png$', name)
    return PHONE_PROFILES[match[1]] if match else None


def validate_shard(shard, rows, require_group=False):
    if isinstance(shard, dict) and 'id' in shard:
        keys = {'id', 'index', 'count'} | ({'group'} if 'group' in shard else set())
        if set(shard) != keys or not re.fullmatch(r'(desktop|phone)-[0-9]{3}', str(shard['id'])):
            raise ValueError('Invalid gallery shard metadata')
        if any(type(shard[key]) is not int for key in ('index', 'count')) or not 0 <= shard['index'] < shard['count'] <= 100 or not 0 < rows <= MAX_ROWS:
            raise ValueError('Invalid gallery shard counts')
        if (require_group or 'group' in shard) and not re.fullmatch(r'run-[1-9][0-9]*-[1-9][0-9]*', str(shard.get('group', ''))):
            raise ValueError('Invalid gallery shard run')
        return shard
    if not isinstance(shard, dict) or set(shard) != {'run', 'index', 'count', 'total'}:
        raise ValueError('Invalid gallery shard metadata')
    if not isinstance(shard['run'], str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', shard['run']):
        raise ValueError('Invalid gallery shard run')
    if any(type(shard[key]) is not int for key in ('index', 'count', 'total')):
        raise ValueError('Invalid gallery shard counts')
    index, count, total = shard['index'], shard['count'], shard['total']
    if not 1 <= index <= count <= MAX_SHARDS or not 1 <= total <= MAX_ROWS * MAX_SHARDS or count != math.ceil(total / MAX_ROWS):
        raise ValueError('Invalid gallery shard counts')
    if rows != min(MAX_ROWS, total - (index - 1) * MAX_ROWS):
        raise ValueError('Incomplete gallery shard rows')
    return shard


def complete_set(manifests):
    """Latest completed report run; partial retries cannot silently accept older bytes."""
    latest = manifests[-1]
    if 'shard' not in latest:
        return [latest]
    shard = latest['shard']
    named = 'id' in shard
    run_key = 'group' if named else 'run'
    by_index = {}
    for manifest in manifests:
        other = manifest.get('shard')
        if other is None or ('id' in other) != named or other.get(run_key) != shard[run_key]:
            continue
        if other['count'] != shard['count'] or (not named and other['total'] != shard['total']):
            raise ValueError('Inconsistent gallery shard metadata')
        if other['index'] in by_index:
            raise ValueError('Duplicate gallery shard index')
        by_index[other['index']] = manifest
    if set(by_index) != set(range(shard['count']) if named else range(1, shard['count'] + 1)):
        raise ValueError('Incomplete gallery shard set. Wait for every report.')
    ordered = [by_index[index] for index in sorted(by_index)]
    if named and len({manifest['shard']['id'] for manifest in ordered}) != len(ordered):
        raise ValueError('Duplicate gallery shard id')
    names = [capture['name'] for manifest in ordered for capture in manifest['captures']]
    if len(set(names)) != len(names):
        raise ValueError('Duplicate gallery filename across shards')
    return ordered

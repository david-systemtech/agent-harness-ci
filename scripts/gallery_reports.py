"""Shared bounded report metadata for hosted capture, publication and acceptance."""
import math
import re

MAX_ROWS = 400
MAX_SHARDS = 16
MAX_BYTES = 48 * 1024 * 1024
MAX_ZIP = 64 * 1024 * 1024


def validate_shard(shard, rows):
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
    by_index = {}
    for manifest in manifests:
        other = manifest.get('shard')
        if other is None or other['run'] != shard['run']:
            continue
        if (other['count'], other['total']) != (shard['count'], shard['total']):
            raise ValueError('Inconsistent gallery shard metadata')
        by_index[other['index']] = manifest
    if set(by_index) != set(range(1, shard['count'] + 1)):
        raise ValueError('Incomplete gallery shard set. Wait for every report.')
    ordered = [by_index[index] for index in sorted(by_index)]
    names = [capture['name'] for manifest in ordered for capture in manifest['captures']]
    if len(set(names)) != len(names):
        raise ValueError('Duplicate gallery filename across shards')
    return ordered

"""Bounded report shards shared by hosted capture, publication and acceptance."""
import json
import pathlib

LIMITS = json.loads(pathlib.Path(__file__).with_name('gallery-allocation.json').read_text())
MAX_PNGS = sum(LIMITS.values()) * 3


def shard_for(name):
    return 'phone' if name.startswith('phone-') else 'desktop'


def captures_fit_allocation(names):
    if not names:
        return False
    return all(sum(shard_for(name) == shard for name in names) <= limit
               for shard, limit in LIMITS.items())


def report_scenes(report):
    if 'shards' not in report:
        # Earlier hosted reports used one bounded report.
        scenes = report.get('scenes', [])
        if not isinstance(scenes, list) or not scenes or len(scenes) > 400:
            raise ValueError('invalid gallery scene list')
        return scenes
    shards = report['shards']
    if not isinstance(shards, list) or len(shards) != len(LIMITS):
        raise ValueError('invalid gallery shards')
    seen = set()
    scenes = []
    for shard in shards:
        name = shard.get('name')
        rows = shard.get('scenes')
        if name not in LIMITS or name in seen or not isinstance(rows, list) or len(rows) > LIMITS[name]:
            raise ValueError('invalid gallery shards')
        seen.add(name)
        if any(shard_for(row['name']) != name for row in rows):
            raise ValueError('capture in wrong gallery shard')
        scenes.extend(rows)
    if not scenes:
        raise ValueError('invalid gallery scene list')
    return scenes

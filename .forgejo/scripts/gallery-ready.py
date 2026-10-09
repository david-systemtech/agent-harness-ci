"""Read the hosted plan as bounded data; never infer a matrix from present jobs."""
import json
import pathlib
import re
import sys
import zipfile


def read_plan(path):
    if pathlib.Path(path).stat().st_size > 65536:
        raise ValueError('gallery plan is too large')
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) != 1 or entries[0].filename != 'matrix.json' or entries[0].file_size > 65536:
            raise ValueError('invalid gallery plan archive')
        matrix = json.loads(archive.read('matrix.json'))
    rows = matrix.get('include')
    if set(matrix) != {'include'} or not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise ValueError('invalid gallery plan matrix')
    expected = []
    for row in rows:
        shard = row.get('shard')
        legacy = row.get('legacy') is True
        named = isinstance(shard, str) and re.fullmatch(r'(desktop|phone)-[0-9]{3}', shard)
        numbered = type(shard) is int and 1 <= shard <= 16
        if not (named or numbered) or set(row) - {'shard', 'count', 'artifact', 'legacy'}:
            raise ValueError('invalid planned gallery shard')
        if legacy or (numbered and len(rows) == 1):
            artifact = 'window-gallery'
        elif numbered:
            artifact = f'window-gallery-shard-{shard}'
        else:
            artifact = f'window-gallery-{shard}'
        if row.get('artifact') != artifact or (legacy and (len(rows) != 1 or shard != 1)):
            raise ValueError('invalid planned gallery artifact')
        count = row.get('count', len(rows) if numbered else None)
        if not legacy and (type(count) is not int or count != len(rows)):
            raise ValueError('invalid planned gallery count')
        expected.append({'job': f'gallery ({shard})', 'artifact': artifact, 'shard': shard, 'legacy': legacy})
    if len({row['job'] for row in expected}) != len(rows):
        raise ValueError('duplicate planned gallery shard')
    return expected


def verdict(expected, jobs):
    names = ['plan'] + [row['job'] for row in expected]
    by_name = {}
    for job in jobs:
        if job.get('name') in names:
            if job['name'] in by_name:
                raise ValueError('duplicate planned gallery job')
            by_name[job['name']] = job
    if any(name not in by_name or by_name[name].get('status') != 'completed' for name in names):
        return 'pending'
    return 'success' if all(by_name[name].get('conclusion') == 'success' for name in names) else 'failure'


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'plan':
            print(json.dumps(read_plan(sys.argv[2])))
        else:
            expected = json.loads(pathlib.Path(sys.argv[2]).read_text())
            jobs = json.loads(pathlib.Path(sys.argv[3]).read_text())['jobs']
            print(verdict(expected, jobs))
    except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        sys.exit(f'Invalid gallery readiness data: {error}')

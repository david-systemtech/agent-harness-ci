"""The bounded desktop/phone report format shared by publication and acceptance."""


def report_groups(document, field):
    if not isinstance(document, dict):
        raise ValueError('invalid gallery report')
    reports = document.get('reports')
    if 'reports' not in document:
        reports = [{'name': 'combined', field: document.get(field)}]
    elif (not isinstance(reports, list) or not reports or len(reports) > 2
          or any(not isinstance(report, dict) for report in reports)
          or len({report.get('name') for report in reports if isinstance(report.get('name'), str)}) != len(reports)
          or any(report.get('name') not in ('desktop', 'phone') for report in reports)
          or field in document):
        raise ValueError('invalid gallery report shards')
    groups = []
    for report in reports:
        items = report.get(field)
        if not isinstance(items, list) or not items or len(items) > 400:
            raise ValueError('invalid gallery scene list' if field == 'scenes' else 'invalid gallery capture list')
        if not all(isinstance(item, dict) and isinstance(item.get('name'), str) for item in items):
            raise ValueError('invalid gallery item')
        name = report['name']
        if name != 'combined' and any(item['name'].startswith('phone-') != (name == 'phone') for item in items):
            raise ValueError('gallery capture belongs to the wrong report')
        groups.append((name, items))
    return groups

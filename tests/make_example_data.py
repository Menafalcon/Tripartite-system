"""
Regenerate data.example.json from seed_demo.py's sample data.

The example file ships in the repository, so every trace of real personal data
must be removed: names, phone numbers, emails, national ID numbers, notes and
worker names are all replaced with synthetic placeholders. Image fields are
nulled because the image folders themselves are gitignored.

Usage:
    python tests/make_example_data.py

The output keeps the exact same schema and internal references (ids, customer
lists, sales history) as `python seed_demo.py`, so a fresh clone can copy
data.example.json -> data.json and have a working, populated app.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import seed_demo  # noqa: E402  (needs ROOT on the path first)

# Fields that carry personal data and must never be published.
CONTACT_FIELDS = ('phone', 'email', 'tenant_id')
FREE_TEXT_FIELDS = ('notes', 'description')


def anonymise(node, state):
    if isinstance(node, dict):
        # A tenant/person record: give it a stable synthetic identity.
        if 'fname' in node and 'lname' in node:
            state['person'] += 1
            node['fname'] = 'Tenant'
            node['lname'] = str(state['person'])

        for field in CONTACT_FIELDS + FREE_TEXT_FIELDS:
            if field in node:
                node[field] = ''

        if 'full_name' in node:
            node['full_name'] = 'Demo User'
        if 'name' in node and state.get('in_workers'):
            state['person'] += 1
            node['name'] = 'Worker ' + str(state['person'])

        if 'buyer_fname' in node:
            node['buyer_fname'] = 'Buyer'
        if 'buyer_lname' in node:
            node['buyer_lname'] = 'Name'

        # The image folders are gitignored, so don't reference missing files.
        if 'image' in node:
            node['image'] = None

        for key, value in node.items():
            if key == 'workers':
                state['in_workers'] = True
                anonymise(value, state)
                state['in_workers'] = False
            elif isinstance(value, (dict, list)):
                anonymise(value, state)

    elif isinstance(node, list):
        for item in node:
            anonymise(item, state)


def build():
    """Rebuild the demo account by actually running seed_demo.main().

    load/save are intercepted so the real data.json is never read or written,
    and we capture exactly what seed_demo would have produced — so this script
    can't drift out of sync with the real seeder.
    """
    captured = {}
    original_load, original_save = seed_demo.load, seed_demo.save
    seed_demo.load = lambda: {"users": {}}
    seed_demo.save = lambda data: captured.update(data)
    try:
        seed_demo.main()
    finally:
        seed_demo.load, seed_demo.save = original_load, original_save

    if 'users' not in captured or 'demo' not in captured['users']:
        raise SystemExit('seed_demo.main() did not produce a demo account')
    return captured


def main():
    data = build()
    anonymise(data, {'person': 0, 'in_workers': False})

    out = os.path.join(ROOT, 'data.example.json')
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)

    user = data['users']['demo']
    print('wrote %s' % out)
    print('  units:   %d' % len(user['units']))
    print('  store:   %d' % len(user['store_items']))
    print('  farms:   %d' % len(user['farms']))
    print('  tenants: %s' % ', '.join(
        '%s %s' % (u['fname'], u['lname']) for u in user['units'][:3]))


if __name__ == '__main__':
    main()

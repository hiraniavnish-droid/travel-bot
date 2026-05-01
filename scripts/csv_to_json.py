"""
Convert the wsap-bot Tours CSV → tours.json in the schema bot.js expects.
- Strips HTML (Framer-export tags like <p dir="auto">, <ul>, <li data-preset-tag>)
- Builds itinerary[] from "Itinerary Title 1-8" + "Itinerary Subtext 1-8"
- Splits "What's Included" HTML into a plain-text "Inclusions / Exclusions" block
- Preserves all existing fields, ADDS new `category` (fine-grained) field
"""
import csv, json, re, sys, html

import sys, os
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else 'tours.csv'
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else 'tours.json'

def strip_html(s):
    """HTML → plain text. Preserves paragraph breaks as \\n\\n."""
    if not s: return ''
    # Decode HTML entities first
    s = html.unescape(s)
    # Block-level tags become newlines
    s = re.sub(r'</(p|h[1-6]|li|div|br)>', '\n', s, flags=re.I)
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.I)
    # Drop all remaining tags
    s = re.sub(r'<[^>]+>', '', s)
    # Collapse runs of whitespace inside lines, then collapse 3+ newlines to 2
    s = '\n'.join(line.strip() for line in s.split('\n'))
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()

def html_list_to_array(s):
    """<ul><li>x</li><li>y</li></ul> → ['x', 'y']"""
    if not s: return []
    s = html.unescape(s)
    items = re.findall(r'<li[^>]*>(.*?)</li>', s, flags=re.I | re.S)
    cleaned = []
    for it in items:
        # strip nested tags inside li
        plain = re.sub(r'<[^>]+>', '', it).strip()
        plain = re.sub(r'\s+', ' ', plain)
        if plain:
            cleaned.append(plain)
    return cleaned

def parse_whats_included(s):
    """
    Convert the HTML inclusions/exclusions block into the legacy plain-text
    format the prompt expects:
        Inclusions
        • item
        • item
        Exclusions
        • item
    """
    if not s: return ''
    s = html.unescape(s)
    # Find each <h6>SECTION</h6><ul>...</ul> pair
    # Looser pattern that tolerates attributes
    sections = re.findall(
        r'<h[1-6][^>]*>\s*(?:<strong>)?\s*([^<]+?)\s*(?:</strong>)?\s*</h[1-6]>\s*<ul[^>]*>(.*?)</ul>',
        s, flags=re.I | re.S)
    if not sections:
        # No clean sections — fall back to flat strip
        return strip_html(s)
    out_lines = []
    for header, ul_html in sections:
        out_lines.append(header.strip())
        for item in html_list_to_array(ul_html):
            out_lines.append(f'• {item}')
        out_lines.append('')
    return '\n'.join(out_lines).strip()

def build_itinerary(row):
    days = []
    for i in range(1, 9):
        title = (row.get(f'Itinerary Title {i}') or '').strip()
        detail = (row.get(f'Itinerary Subtext {i}') or '').strip()
        if not title and not detail:
            continue
        days.append({
            'title': title,
            'detail': detail,
        })
    return days

def normalize_price(p):
    """Normalize whitespace/case but preserve currency tag.
       '15999 INR' / '₹15999' / '290 USD' all kept as-is."""
    return ' '.join((p or '').split())

def convert():
    with open(CSV_PATH, encoding='utf-8') as f:
        rows = list(csv.DictReader(f))

    out = []
    issues = []
    for r in rows:
        title = (r.get('Title') or '').strip()
        if not title:
            issues.append('Row with empty Title — skipped')
            continue

        tour = {
            'title': title,
            'destination': (r.get('Destination') or '').strip(),
            'destinations': (r.get('Destinations') or '').strip(),
            'categories': (r.get('Categories') or '').strip(),
            'category': (r.get('Category') or '').strip(),  # NEW: fine-grained
            'duration': (r.get('Duration') or '').strip(),
            'price': normalize_price(r.get('Price:') or ''),
            'departure': (r.get('Departure') or '').strip(),
            'group_size': (r.get('Group Size') or '').strip(),
            'overview': strip_html(r.get('Trip Overview') or ''),
            'highlights': html_list_to_array(r.get('Trip Highlights') or ''),
            'itinerary': build_itinerary(r),
            'whats_included': parse_whats_included(r.get('What’s Included') or ''),
            'includes_short': (r.get('Includes') or '').strip(),
        }

        # Validation
        if not tour['price']:
            issues.append(f'{title}: blank price')
        if not tour['itinerary']:
            issues.append(f'{title}: empty itinerary')
        if not tour['overview']:
            issues.append(f'{title}: empty overview')

        out.append(tour)

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f'✅ Wrote {len(out)} tours to {OUT_PATH}')
    print(f'   File size: {len(json.dumps(out))/1024:.1f} KB')
    if issues:
        print(f'\n⚠️  {len(issues)} validation issue(s):')
        for i in issues[:30]:
            print(f'   - {i}')
        if len(issues) > 30:
            print(f'   ...and {len(issues)-30} more')
    else:
        print('   No validation issues.')

    # Sample output for sanity
    print('\n=== SAMPLE OUTPUT (first tour) ===')
    print(json.dumps(out[0], indent=2, ensure_ascii=False)[:1800])
    print('...')

convert()

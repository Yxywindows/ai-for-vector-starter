import hashlib
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

workspace = Path('C:/Users/yxy/Desktop/work/AI_FOR_VECTOR')
review = Path(__file__).resolve().parent
package = workspace / 'artifacts/xiaog/design-delivery-20260914'
errors, local_links = [], []

def check_target(base, target):
    target = urllib.parse.unquote(target.strip('<>'))
    if not target or target.startswith(('#', 'http:', 'https:', 'data:', 'blob:', 'codex:', 'mailto:')):
        return
    value = target.split('#', 1)[0].split('?', 1)[0]
    value = re.sub(r':\d+$', '', value)
    path = Path(value) if re.match(r'^[A-Za-z]:[\\/]', value) else base.parent / value
    local_links.append({'from': str(base), 'target': target, 'exists': path.exists()})
    if not path.exists():
        errors.append(str(path))

for name in ['05-design-delivery-contract.md', '06-implementation-plan-r2.md', '07-design-delivery.md']:
    path = workspace / 'docs/xiaog-game' / name
    for target in re.findall(r'\[[^\]]*\]\(([^\n)]+)\)', path.read_text(encoding='utf-8-sig')):
        check_target(path, target)

class Links(HTMLParser):
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('href', 'src') and value:
                check_target(self.base, value)

for name in ['index.html', 'prototype.html', 'map-design.html', 'evidence/contact-sheet.html']:
    parser = Links()
    parser.base = package / name
    parser.feed(parser.base.read_text(encoding='utf-8-sig'))

responses = []
for name in ['/', '/prototype.html', '/assets/OpenGMS_A.glb', '/assets/cube.glb', '/stage_manifest.json', '/evidence/observatory-film.webm']:
    req = urllib.request.Request('http://127.0.0.1:18405' + name, method='HEAD')
    with urllib.request.urlopen(req) as response:
        responses.append({'path': name, 'status': response.status, 'length': response.headers.get('Content-Length')})
        assert response.status == 200
req = urllib.request.Request('http://127.0.0.1:18405/evidence/observatory-film.webm', headers={'Range': 'bytes=0-31'})
with urllib.request.urlopen(req) as response:
    body = response.read()
    responses.append({'path': 'video byte range', 'status': response.status, 'bytes': len(body)})
    assert response.status == 206 and len(body) == 32

hashes = json.loads((package / 'delivery-sha256.json').read_text(encoding='utf-8'))
for name, expected in hashes.items():
    data = (package / name).read_bytes()
    if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
        errors.append('Final hash mismatch: ' + name)
result = {'marker': 'DESIGN_HANDOFF_VERIFY_OK' if not errors else 'DESIGN_HANDOFF_VERIFY_FAILED',
          'localLinksChecked': len(local_links), 'httpChecks': responses,
          'packagedFilesHashChecked': len(hashes), 'errors': errors}
(review / 'handoff-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
assert not errors

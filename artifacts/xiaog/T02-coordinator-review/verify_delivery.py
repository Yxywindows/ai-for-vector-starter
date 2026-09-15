"""Read-only, reproducible coordinator checks of the completed T02 delivery."""
import hashlib
import json
import struct
from pathlib import Path

ROOT = Path('C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02')
ROBOT = ROOT / 'robot'
EVIDENCE = ROBOT / 'evidence/final_same_version'
OUT = Path(__file__).resolve().parent

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

checks = []
def check(path, expected, size=None):
    actual = sha(path)
    ok = actual == expected and (size is None or path.stat().st_size == size)
    checks.append({'file': str(path), 'sha256': actual, 'pass': ok})
    assert ok, path

for name, item in read(ROBOT / 'SHA256SUMS.json').items():
    check(ROBOT / name, item['sha256'], item['bytes'])
manifest = read(EVIDENCE / 'evidence_manifest.json')
for item in manifest['inputs'].values():
    check(Path(item['path']), item['sha256'])
for item in manifest['views']:
    check(EVIDENCE / item['file'], item['sha256'])
for name, expected in manifest['inspection_files'].items():
    check(EVIDENCE / name, expected)
for name, item in read(EVIDENCE / 'bundle_hashes.json')['files'].items():
    check(EVIDENCE / name, item['sha256'], item['bytes'])
assert {v['view'] for v in manifest['views']} == {'hero', 'front', 'back', 'left', 'right', 'top'}

def glb_summary(path):
    raw = path.read_bytes()
    assert struct.unpack_from('<4sII', raw) == (b'glTF', 2, len(raw))
    chunks = {}; offset = 12
    while offset < len(raw):
        size, kind = struct.unpack_from('<II', raw, offset)
        chunks[kind] = raw[offset + 8:offset + 8 + size]
        offset += size + 8
    data = json.loads(chunks[0x4E4F534A]); binary = chunks[0x004E4942]
    triangles = primitives = duplicate_index_triangles = 0
    duplicate_meshes = {}
    for mesh in data['meshes']:
        for primitive in mesh['primitives']:
            primitives += 1
            assert primitive.get('mode', 4) == 4
            accessor = data['accessors'][primitive['indices']]
            view = data['bufferViews'][accessor['bufferView']]
            fmt, width = {5121: ('B', 1), 5123: ('H', 2), 5125: ('I', 4)}[accessor['componentType']]
            start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
            stride = view.get('byteStride', width)
            ids = [struct.unpack_from('<' + fmt, binary, start + i * stride)[0] for i in range(accessor['count'])]
            assert len(ids) % 3 == 0
            triangles += len(ids) // 3
            n = sum(len(set(ids[i:i + 3])) < 3 for i in range(0, len(ids), 3))
            duplicate_index_triangles += n
            if n:
                duplicate_meshes[mesh.get('name', '<unnamed>')] = duplicate_meshes.get(mesh.get('name', '<unnamed>'), 0) + n
    return {'sha256': sha(path), 'bytes': len(raw), 'triangles': triangles,
            'primitives': primitives, 'duplicate_index_triangles': duplicate_index_triangles,
            'duplicate_index_meshes': duplicate_meshes,
            'root_names': [data['nodes'][n].get('name') for n in data['scenes'][data.get('scene', 0)]['nodes']],
            'clips': [a.get('name') for a in data.get('animations', [])],
            'cameras': len(data.get('cameras', [])),
            'lights': len(data.get('extensions', {}).get('KHR_lights_punctual', {}).get('lights', [])),
            'face_markers': sorted(n['name'] for n in data['nodes'] if n.get('name', '').startswith('Face_')),
            'external_images': [i['uri'] for i in data.get('images', []) if 'uri' in i]}

report = {'checks': checks, 'check_count': len(checks), 'failures': 0,
          'glb': {n: glb_summary(ROBOT / 'exports' / n) for n in ['OpenGMS_A.glb', 'cube.glb']},
          'inspections': {n: read(EVIDENCE / n)['totals'] for n in ['editable_inspection.json', 'glb_inspection.json']},
          'reviewed_files': {str(p): sha(p) for p in [ROOT / 'stage_manifest.json', ROBOT / 'runtime_manifest.json', ROBOT / 'delivery_report.md', EVIDENCE / 'evidence_manifest.json', EVIDENCE / 'contact_sheet.png', EVIDENCE / 'verification_addendum.md']}}
workspace = OUT.parents[2]
baseline = read(workspace / 'artifacts/xiaog/design-review-20260914/review-verification.json')
report['frontend_baseline'] = {'file_count': len(baseline['sourceHashes']), 'changed_or_missing': [row['path'] for row in baseline['sourceHashes'] if not (workspace / row['path']).is_file() or sha(workspace / row['path']).lower() != row['sha256'].lower()]}
assert not report['frontend_baseline']['changed_or_missing']
(OUT / 'independent-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'check_count': report['check_count'], 'failures': 0, 'glb': report['glb'], 'frontend_baseline': report['frontend_baseline']}, indent=2))

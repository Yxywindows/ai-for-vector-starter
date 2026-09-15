"""Seal a reviewed D01 directory without altering its files or the application."""
import hashlib
import json
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE = Path('C:/Users/yxy/Desktop/work/AI_FOR_VECTOR')
SOURCE = Path('C:/Users/yxy/.codex/worktrees/69f6/AI_FOR_VECTOR/artifacts/xiaog/D01')
OUTPUT = WORKSPACE / 'artifacts/xiaog/design-delivery-20260914'
REVIEW = Path(__file__).resolve().parent

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

stage = read(SOURCE / 'stage_manifest.json')
assert stage.get('ready') is True, 'D01 has not declared the design ready.'
assert not OUTPUT.exists(), 'Refuse to overwrite an existing sealed delivery.'
sha_lines = (SOURCE / 'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines()
for line in sha_lines:
    digest, name = line.split('  ', 1)
    path = (SOURCE / name).resolve()
    assert path.is_relative_to(SOURCE.resolve()) and sha(path) == digest, name
assert stage['qa']['passed'] == 25 and stage['qa']['failed'] == 0
assert stage['qa']['mapChecks'] == 8 and stage['qa']['videoDecodeVerified']
assert stage['qa']['browserVideoSeekVerified']
assert sha(SOURCE / 'evidence/observatory-film.webm') == read(REVIEW / 'independent-video-review.json')['videoSha256']

baseline = read(WORKSPACE / 'artifacts/xiaog/design-review-20260914/review-verification.json')
changed = [row['path'] for row in baseline['sourceHashes'] if not (WORKSPACE / row['path']).is_file() or sha(WORKSPACE / row['path']).lower() != row['sha256'].lower()]
assert not changed, changed

declared = stage['files']
files = []
for item in declared:
    path = (SOURCE / item['path']).resolve()
    assert path.is_relative_to(SOURCE.resolve()) and path.is_file(), item['path']
    assert path.stat().st_size == item['bytes'] and sha(path) == item['sha256'], item['path']
    files.append(path)
files.extend([SOURCE / 'stage_manifest.json', SOURCE / 'SHA256SUMS.txt'])
assert len(files) == len(set(files)), 'Duplicate files in manifest.'
assert (REVIEW / 'coordinator-review.md').is_file(), 'Coordinator review is required.'
before = {str(p.relative_to(SOURCE)).replace('\\', '/'): sha(p) for p in files}
for path in files:
    destination = OUTPUT / path.relative_to(SOURCE)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, destination)
assert before == {name: sha(SOURCE / name) for name in before}, 'Source changed while copying.'
assert all(sha(OUTPUT / name) == digest for name, digest in before.items())

contracts = OUTPUT / 'implementation'
contracts.mkdir()
for name in ['04-design-direction-review.md', '05-design-delivery-contract.md', '06-implementation-plan-r2.md']:
    shutil.copy2(WORKSPACE / 'docs/xiaog-game' / name, contracts / name)
for report in [REVIEW / 'coordinator-review.md', *REVIEW.glob('independent-*'), *REVIEW.glob('video-*.png')]:
    if report.is_file():
        shutil.copy2(report, OUTPUT / report.name)

asset_root = Path('C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot')
asset_dir = OUTPUT / 'source-assets'
asset_dir.mkdir()
editable = {
    'OpenGMS_A_editable.blend': '68d58c249506963c4fc4b9fc518d5c302c54780bbb29690b627ade6a2e85f771',
    'cube_editable.blend': 'c7cbb7292343a353fcdbce3642e5c80f123fce46a868c9375dbd72427139981f',
}
for name, digest in editable.items():
    assert sha(asset_root / name) == digest, name
    shutil.copy2(asset_root / name, asset_dir / name)
    assert sha(asset_dir / name) == digest and sha(asset_root / name) == digest, name
(asset_dir / 'provenance.json').write_text(json.dumps({'source': str(asset_root), 'sha256': editable, 'stage': 'Previously accepted T02; immutable copies; see design-spec.md for retained asset limitations'}, ensure_ascii=False, indent=2), encoding='utf-8')

hashes = {str(p.relative_to(OUTPUT)).replace('\\', '/'): {'bytes': p.stat().st_size, 'sha256': sha(p)} for p in sorted(OUTPUT.rglob('*')) if p.is_file()}
(OUTPUT / 'delivery-sha256.json').write_text(json.dumps(hashes, ensure_ascii=False, indent=2), encoding='utf-8')
archive = OUTPUT.with_suffix('.zip')
assert not archive.exists(), 'Refuse to overwrite an existing archive.'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
    for path in sorted(OUTPUT.rglob('*')):
        if path.is_file():
            bundle.write(path, path.relative_to(OUTPUT).as_posix())
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    for name, expected in hashes.items():
        assert hashlib.sha256(bundle.read(name)).hexdigest() == expected['sha256'], name

report = {'sealedAt': datetime.now(timezone.utc).isoformat(), 'source': str(SOURCE), 'output': str(OUTPUT),
          'sourceFileCount': len(files), 'packagedFileCount': len(hashes) + 1,
          'declaredFileCount': len(declared), 'shaListChecked': len(sha_lines),
          'editableBlenderSourceCopies': editable,
          'sourceUnchangedDuringCopy': True, 'applicationBaselineFileCount': len(baseline['sourceHashes']),
          'applicationChanged': changed, 'archive': str(archive), 'archiveBytes': archive.stat().st_size,
          'archiveSha256': sha(archive), 'zipCrcPass': True, 'zipContentSha256Pass': True}
(REVIEW / 'seal-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))

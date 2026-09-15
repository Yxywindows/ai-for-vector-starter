import hashlib
import json
import shutil
import subprocess
import zipfile
from pathlib import Path
from datetime import datetime, timezone

workspace = Path('C:/Users/yxy/Desktop/work/AI_FOR_VECTOR')
review = Path(__file__).resolve().parent
root = workspace / 'artifacts/xiaog/design-delivery-20260915-r2'
old = workspace / 'artifacts/xiaog/design-delivery-20260915'
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
write = lambda p, s: p.write_text(s, encoding='utf-8', newline='\n')
stamp = datetime.now(timezone.utc).isoformat()
expected = {'design-delivery-20260914':'7ce7d209e8f845045e5f130dbb93c50bdf2618355c419a217054f056efb5f28c', 'design-delivery-20260915':'3271da56d83e2ddf3859a1cd613f94c2f9158c18b640894e097ece4b578a53c6'}
for name, digest in expected.items():
    directory = root.parent / name
    assert sha(directory.with_suffix('.zip')) == digest, name
    for path, row in read(directory/'delivery-sha256.json').items():
        assert sha(directory/path) == row['sha256'], name + '/' + path
protected = read(workspace/'artifacts/xiaog/design-review-20260914/review-verification.json')['sourceHashes']
for row in protected:
    assert sha(workspace / row['path']).lower() == row['sha256'].lower(), row['path']
for path in ['assets/OpenGMS_A.glb','assets/cube.glb','source-assets/OpenGMS_A_editable.blend','source-assets/cube_editable.blend']:
    assert sha(root/path) == sha(old/path), path

reports = ['task-feedback-verification.json','browser-verification.json','gaze-verification.json','mobile-verification.json']
checks = []
for name in reports:
    report = read(review/name)
    assert report['failed'] == 0 and all(c['pass'] for c in report['checks']), name
    assert report['passed'] == len(report['checks'])
    checks += [{**c,'report':name} for c in report['checks']]
assert len(checks) == 29
film = read(review/'interaction-film.json')
assert film['decoded']['exitCode'] == 0 and film['decoded']['frameCount'] == 214
assert 7 < film['decoded']['seconds'] < 9

evidence = root/'evidence/interaction'
evidence.mkdir(exist_ok=True)
copy_names = reports + ['check-task-feedback.mjs','browser-checks.js','gaze-checks.js','record-interaction.js','gaze-left.png','gaze-right.png','work-Yes.png','work-No.png','mobile-wave.png','robot-interaction.webm','interaction-film.json','film-decode.log','film-look.png','film-yes.png','film-wave.png','film-final.png']
for name in copy_names: shutil.copy2(review/name,evidence/name)
# Keep the packaged standalone test import valid relative to its new location.
p = evidence/'check-task-feedback.mjs'
write(p,p.read_text(encoding='utf-8').replace('../design-delivery-20260915-r2/task-feedback.mjs','../../task-feedback.mjs'))
shutil.copy2(workspace/'artifacts/xiaog/dialogue-review-20260915/browser-acceptance.md',evidence/'prior-dialogue-browser-acceptance.md')
runtime = ['app.mjs','scene.mjs','styles.css','robot-interaction.mjs','task-feedback.mjs']
diff = b''
(review/'empty-file.txt').write_bytes(b'')
for name in runtime:
    original = old/name if (old/name).exists() else review/'empty-file.txt'
    result = subprocess.run(['git','-c','core.autocrlf=false','diff','--no-index','--no-color','--',str(original),str(root/name)],capture_output=True)
    assert result.returncode in (0,1), result.stderr
    diff += result.stdout
(evidence/'interaction-revision.diff').write_bytes(diff)
summary = {'version':'D01-R1.2','createdAt':stamp,'passed':len(checks),'failed':0,'checks':checks,'realBrowserVerified':True,'protectedSources':len(protected),'protectedSourcesUnchanged':True,'sourceAssetsUnchanged':True,'priorSealedDeliveriesUnchanged':True,'runtimeHashes':{name:sha(root/name) for name in runtime},'film':film,'scope':'Current task feedback, gaze, responsive interaction; inherited R1 full-flow/map evidence is historical.'}
write(evidence/'verification.json',json.dumps(summary,ensure_ascii=False,indent=2))

intro = '> 2026-09-15 最新 R1.2：成功 Yes 点头；失败 No 挥手并保持头部稳定；眼神跟随鼠标。29项本次检查通过，已核对桌面/手机画面及7.47秒新动作样片。当前约定见 [INTERACTIONS.md](INTERACTIONS.md)。下方旧版本说明及原R1图片/影片为历史基线。\n\n'
for name in ['README.md','design-spec.md','coordinator-review.md']:
    p=root/name; write(p,intro+p.read_text(encoding='utf-8-sig'))
shutil.copy2(root/'REVISION.md',root/'REVISION-R1.1.md')
write(root/'REVISION.md','''# R1.2 · 小G结果动作与鼠标注视

先完成上一项七种空间分析方法对白的真实浏览器补充验收，再完成本次动作交互。成功播放 Yes 点头，失败按用户最新要求播放 Wave 挥手，头部保持稳定。眼睛随鼠标移动，结果动作优先，结束后回到待机和注视。

打开 http://127.0.0.1:18405/ ，进入“任务进度”并展开工作台，可点击成功/失败演示。原型使用历史快照，演示不提交任务；正式任务订阅接入契约见 [INTERACTIONS.md](INTERACTIONS.md)。

本次29项检查通过：状态机8、浏览器任务/对白10、注视8、手机3。验证包括重复状态不重播、连续反馈对白同步、减少动态与触摸、移出回正、工作页停止重绘、挥手近景完整可见。实际代码diff已审阅；复核修正了反馈排队时的对白时机和手机角色绘制层级。

证据位于 evidence/interaction。新动作样片为7.47秒、1920×1080、实际GLB画布录制，完整解码214帧；不含界面DOM文字。旧R1的25项主流程/8项地图及16.24秒样片保留作历史基线，本次不宣称重新执行这些检查。

模型、魔方和两份Blender源文件保持原哈希，128项受保护主应用源码保持不变；R1和R1.1封存包均保持原哈希。没有生产业务接口改动、数据库写入、提交或推送。完整性检查：`node scripts/verify.mjs`；状态机复验：`node evidence/interaction/check-task-feedback.mjs`。
''')
write(root/'work_state.md','''# D01 R1.2 · ready

2026-09-15。已完成上一项方法对白验收与本次结果动作、鼠标注视设计及实现。失败使用挥手，保持头部稳定。主协调已检查实际差异、修正问题并完成29项验证与新影片解码/视觉核对。

目录 artifacts/xiaog/design-delivery-20260915-r2；交付地址18405。18406仅用于本次隔离验收，封存后关闭。正式业务接入仍按docs/xiaog-game/05及06后续任务进行。当前行为以INTERACTIONS.md为准。
''')
p=root/'index.html'; html=p.read_text(encoding='utf-8')
html=html.replace('设计原型 · R1.1 /','设计原型 · R1.2 /').replace('小G对白现已随当前空间分析方法切换。下方构图与样片保留 R1 基线，最新对白请查看交互原型。','小G现已支持成功点头、失败挥手和鼠标注视；七种分析方法对白保持同步。下方原构图与连续界面样片保留 R1 基线。')
html=html.replace('</nav>','''<a href="#interaction">新动作样片</a><a href="INTERACTIONS.md">交互说明 ↗</a></nav>
    <section id="interaction"><h2>R1.2 · 小G会回应你</h2><p>成功点头，失败挥手，目光跟随鼠标。在任务进度页可分别体验两个演示流程。</p><video controls preload="metadata" poster="evidence/interaction/film-wave.png"><source src="evidence/interaction/robot-interaction.webm" type="video/webm"></video><p class="notes">本次角色动作片段 · 7.47秒 · 1920×1080 · 实际GLB画布录制（不含界面文字）。演示不提交实际任务。</p></section>''',1)
write(p,html)
p=root/'scripts/verify.mjs'; verifier=p.read_text(encoding='utf-8')
verifier=verifier.replace("revision.passed!==9","revision.passed!==manifest.revision.passed").replace("errors.push('dialogue revision verification')","errors.push('current revision verification')")
verifier=verifier.replace("revisionChecks=revision.passed;", "revisionChecks=revision.passed;for(const [name,digest] of Object.entries(revision.runtimeHashes??{})){if(sha(await fs.readFile(root+'/'+name))!==digest)errors.push('revision runtime '+name);}if(revision.film?.decoded?.exitCode!==0||revision.film.decoded.frameCount<200)errors.push('interaction film decode');")
write(p,verifier)

manifest=read(root/'stage_manifest.json')
manifest.update(version='D01-R1.2',createdAt=stamp,directory=root.as_posix(),coordinatorAcceptance='accepted for task gestures and mouse gaze')
manifest['revision']={'base':'D01-R1.1','scope':'Yes nod, No right-arm wave with steady head, mouse gaze, local demo lifecycle and matching dialogue','verification':'evidence/interaction/verification.json','passed':29,'realBrowserVerified':True}
manifest['qa']['scope']='Inherited R1 full-flow and map results; current interaction checks are in revision.verification.'
manifest['runtime']['port']=18405
manifest['ownership']['writes']='artifacts/xiaog/design-delivery-20260915-r2 and interaction review; latest design handoff docs'
manifest['deliverables'].update(zip=root.name+'.zip',interactionFilm='evidence/interaction/robot-interaction.webm',interactionSpec='INTERACTIONS.md')
exclude={'stage_manifest.json','SHA256SUMS.txt','delivery-sha256.json'}
files=sorted(p for p in root.rglob('*') if p.is_file() and p.relative_to(root).as_posix() not in exclude)
manifest['files']=[{'path':p.relative_to(root).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)} for p in files]
write(root/'stage_manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
sums=[f"{row['sha256']}  {row['path']}" for row in manifest['files']]+[f"{sha(root/'stage_manifest.json')}  stage_manifest.json"]
write(root/'SHA256SUMS.txt','\n'.join(sums)+'\n')
for name in runtime:
    if name.endswith('.mjs'): subprocess.run(['node','--check',str(root/name)],check=True)
subprocess.run(['node',str(root/'scripts/verify.mjs')],check=True)
hashes={p.relative_to(root).as_posix():{'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(root.rglob('*')) if p.is_file() and p.name!='delivery-sha256.json'}
write(root/'delivery-sha256.json',json.dumps(hashes,ensure_ascii=False,indent=2))
archive=root.with_suffix('.zip'); assert not archive.exists()
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file(): z.write(p,p.relative_to(root).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name, expected_hash in hashes.items(): assert hashlib.sha256(z.read(name)).hexdigest()==expected_hash['sha256']
report={'version':'D01-R1.2','ready':True,'createdAt':stamp,'passed':29,'protectedSources':len(protected),'oldDeliveriesUnchanged':True,'assetsUnchanged':True,'manifestFiles':len(files),'zipEntries':len(hashes)+1,'zipBytes':archive.stat().st_size,'zipSha256':sha(archive),'zipVerified':True}
write(review/'seal-verification.json',json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))

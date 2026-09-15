import hashlib
import json
import shutil
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path

workspace = Path('C:/Users/yxy/Desktop/work/AI_FOR_VECTOR')
review = Path(__file__).resolve().parent
old = workspace / 'artifacts/xiaog/design-delivery-20260914'
new = workspace / 'artifacts/xiaog/design-delivery-20260915'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
timestamp = datetime.now(timezone.utc).isoformat()
qa = read(review / 'dialogue-verification.json')
assert qa['passed'] == 9 and qa['failed'] == 0
assert sha(old.with_suffix('.zip')) == '7ce7d209e8f845045e5f130dbb93c50bdf2618355c419a217054f056efb5f28c'
for name, expected in read(old / 'delivery-sha256.json').items():
    assert sha(old / name) == expected['sha256'], 'Original R1 changed: ' + name
shutil.copy2(review / 'dialogue-verification.json', new / 'evidence/dialogue-verification.json')
patch = subprocess.run(['git','-c','core.autocrlf=false','diff','--no-index','--no-color','--',str(old/'app.mjs'),str(new/'app.mjs')],capture_output=True)
assert patch.returncode == 1
(new / 'evidence/dialogue-revision.diff').write_bytes(patch.stdout)

intro = '> 2026-09-15 补订 R1.1：小G对白随当前分析方法同步更新；七种方法及返回流程共9项DOM集成检查通过。原R1的25项主流程、8项地图、截图与样片为历史基线，本次未重做。详见 [REVISION.md](REVISION.md)。\n\n'
for name in ['README.md','design-spec.md','coordinator-review.md']:
    path = new / name
    path.write_text(intro + path.read_text(encoding='utf-8-sig'),encoding='utf-8')
(new/'REVISION.md').write_text('''# R1.1 · 按空间分析方法更新小G对白

2026-09-15。原型已在相同地址 http://127.0.0.1:18405/ 更新。刷新页面加载新版本。

问题是空间分析的对白固定为缓冲区提示，方法切换只重绘表单。本次把每种方法的对白放进既有方法注册表，页面渲染与切换方法共享 renderDialogue；返回预览或再次进入分析时使用保留的当前方法，其他功能继续使用各自对白。

| 当前方法 | 小G提示重点 |
|---|---|
| 缓冲区 | 输入图层、以米为单位的缓冲距离 |
| 裁剪 | 输入图层和掩膜、保留掩膜内部分 |
| 相交 | 两层数据的空间重叠 |
| 融合 | 按字段融合或融合全部 |
| 空间连接 | 目标层、关联层和空间关系 |
| 几何修复 | 检查并修复无效几何 |
| 面内点计数 | 点层与多边形层、每个面内的点数 |

验证使用现有 jsdom 加载实际 app.mjs、map.mjs、HTML 与快照，派发真实 DOM 点击事件，检查七种方法、选中状态、图层保持、返回预览/展开、其他功能切换，9项通过。语法检查及实际修改 diff 已审阅。浏览器控制服务本次连接失败，未声称完成真实浏览器视觉或 WebGL 回归；18405 的新 app.mjs 已通过 HTTP 内容核对。

evidence/dialogue-verification.json 是本次报告；evidence/dialogue-revision.diff 是本次运行代码差异。原R1的主流程/地图报告、关键帧、联系表和电影继续保留为布局与动效基线，不能代替本次方法对白证据。角色、魔方、三维场景代码、业务提交与数据库不涉及本次修改。

完整性运行 node scripts/verify.mjs，查看 revisionChecks: 9 与 D01_VERIFY_OK。旧20260914目录与ZIP保持原哈希；新版ZIP为 design-delivery-20260915.zip。后续正式实现应从当前方法状态派生对白，不单独保留另一份容易过期的提示状态。
''',encoding='utf-8')
(new/'work_state.md').write_text('''# D01 R1.1 · ready

2026-09-15，由主协调完成方法对白补订。原69f6工作树及20260914封存目录未修改。
当前目录为 artifacts/xiaog/design-delivery-20260915；预览18405。实现、差异审阅、9项DOM集成检查已完成。
以 stage_manifest.json、SHA256SUMS.txt、REVISION.md 和 evidence/dialogue-verification.json 为当前补订依据；其他原R1报告/样片是保留的历史基线。
无正式应用源码修改、数据库写入、Git提交或推送。
''',encoding='utf-8')

manifest = read(new/'stage_manifest.json')
manifest.update(version='D01-R1.1',createdAt=timestamp,directory=new.as_posix(),url='http://127.0.0.1:18405/',coordinatorAcceptance='accepted for dialogue revision')
manifest['revision']={'base':'D01-R1','scope':'Analysis-method dialogue only; other visual evidence retained as R1 baseline','verification':'evidence/dialogue-verification.json','passed':9,'realBrowserVerified':False}
manifest['qa']['scope']='Inherited R1 full-flow and map results; not rerun for the dialogue amendment. Current checks are in revision.verification.'
manifest['runtime']['port']=18405
manifest['deliverables']['zip']='design-delivery-20260915.zip'
exclude={'stage_manifest.json','SHA256SUMS.txt','delivery-sha256.json'}
files = sorted(p for p in new.rglob('*') if p.is_file() and p.relative_to(new).as_posix() not in exclude)
manifest['files']=[{'path':p.relative_to(new).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)} for p in files]
(new/'stage_manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
sums=[f"{row['sha256']}  {row['path']}" for row in manifest['files']]+[f"{sha(new/'stage_manifest.json')}  stage_manifest.json"]
(new/'SHA256SUMS.txt').write_text('\n'.join(sums)+'\n',encoding='utf-8',newline='\n')
subprocess.run(['node',str(new/'scripts/verify.mjs')],check=True)
hashes={p.relative_to(new).as_posix():{'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(new.rglob('*')) if p.is_file() and p.name!='delivery-sha256.json'}
(new/'delivery-sha256.json').write_text(json.dumps(hashes,ensure_ascii=False,indent=2),encoding='utf-8')
archive=new.with_suffix('.zip')
assert not archive.exists()
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(new.rglob('*')):
        if p.is_file(): z.write(p,p.relative_to(new).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name,expected in hashes.items(): assert hashlib.sha256(z.read(name)).hexdigest()==expected['sha256']
report={'version':'D01-R1.1','ready':True,'createdAt':timestamp,'runtimeChangeFiles':['app.mjs'],'originalR1Unchanged':True,'originalZipUnchanged':True,'manifestFiles':len(files),'zipEntries':len(hashes)+1,'zipBytes':archive.stat().st_size,'zipSha256':sha(archive),'zipVerified':True,'dialogueChecks':9}
(review/'seal-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))

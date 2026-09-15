"""Publish the design handoff after the reviewed package has been sealed."""
import json
from pathlib import Path

workspace = Path('C:/Users/yxy/Desktop/work/AI_FOR_VECTOR')
review = Path(__file__).resolve().parent
seal = json.loads((review / 'seal-verification.json').read_text(encoding='utf-8'))
assert seal['zipCrcPass'] and seal['zipContentSha256Pass'] and not seal['applicationChanged']
docs = workspace / 'docs/xiaog-game'
out = Path(seal['output']).as_posix()
zip_path = Path(seal['archive']).as_posix()
guide = docs / '07-design-delivery.md'
guide.write_text(f'''# 小G · 空间观测室完整设计交付

2026-09-14。完整设计制作、复核与封存已完成。本页是本轮交付入口，替代早期方向稿的“待制作”状态。正式应用尚未替换；真实业务接入按 05/06 后续阶段执行。

## 直接查看

- [打开完整设计总览](http://127.0.0.1:18405/)：从这里进入交互原型、六个目的页、地图设计、关键帧和连续样片。
- [完整 ZIP 交付包]({zip_path})：含源码、真实 GLB、运行依赖、许可证、快照、设计规格和证据。
- [24 格画面总览]({out}/evidence/contact-sheet.png)。
- [连续交互样片]({out}/evidence/observatory-film.webm)：16.24 秒、1440×900。
- [实际设计规格]({out}/design-spec.md)与[主协调复核]({out}/coordinator-review.md)。
- 可编辑 Blender 源文件：[小G]({out}/source-assets/OpenGMS_A_editable.blend)、[独立魔方]({out}/source-assets/cube_editable.blend)。

打开原型后，选择空间分析，等待魔方停转和预览稳定，再点击“展开工作台”；在工作页切换功能，并用 Escape 返回。地图设计页可体验编辑草稿的保存、放弃、继续编辑与失败分支。

## 交付范围

| 范围 | 内容 |
|---|---|
| 三维主场景 | T02 珍珠白/青蓝 OpenGMS 小G、独立变速魔方、真实局部城市边界；不依赖手部动作 |
| 完整导航过程 | 六面定向、融景对白、阅读停留、显式展开、页首小G陪伴、页内快切、返回与减少动态 |
| 六个目的页 | 项目/详情、数据/字段详情、七项空间分析、任务/日志、导出设置、平台概览 |
| 地图工作区设计 | 图层/地图/属性布局，未保存更改三分支，保存失败保留草稿 |
| 多画幅 | 1440×900、1920×1080、1280×720、390×844、844×390 |
| 交接材料 | 相机/灯光/时序/配色/布局规格、URL与数据上下文契约、按新任务实施的阶段提示词、截图/样片/校验清单 |

这是可操作的设计原型：真实快照支持筛选、选择和参数校验；没有冒充新分析结果、实际下载或正式地图编辑保存。

## 启动与复核

当前封存副本运行于 18405。重启时在 PowerShell 执行：

```powershell
Set-Location -LiteralPath '{out}'
$env:D01_PORT = '18405'
node server.mjs
```

看到 `D01_READY http://127.0.0.1:18405/` 后打开地址。复制到其他目录时，在解压目录运行 `node server.mjs`，默认端口 18404。只需要 Node.js；无需 npm install，也不依赖 GIS 后端。若端口已占用先检查现有原型，不停止别的服务。

包完整性复核可在包目录运行 `node scripts/verify.mjs`，成功标记为 `D01_VERIFY_OK`。不要直接双击 HTML 代替 HTTP 服务。

## 验证结论与边界

- 主流程 25 项、地图设计 8 项通过；主协调另行实际点击主流程与地图失败分支，并查看全部六页、关键帧和响应式画面。
- 连续电影由独立 FFmpeg 解码检查，证实预览停留、展开、工作页切换和返回；不存在以播放器缓冲截图作为完成证据的问题。
- 原始 T02 GLB 哈希一致；主目录 128 个受保护源码/配置文件与设计开始时一致。原有未提交改动保留。
- 封存包含 {seal['packagedFileCount']} 个文件；ZIP {seal['archiveBytes']:,} 字节，CRC 与逐文件 SHA256 均通过。
- ZIP SHA256：`{seal['archiveSha256']}`。完整封存记录见 [seal-verification.json]({(review / 'seal-verification.json').as_posix()})。
- 性能只验证本地 Chrome/Intel UHD；手机尺寸是桌面模拟，未完成真机或生产 OpenLayers 并发性能验收。T02 原生警告保留。

正式实现以 [05 设计契约](05-design-delivery-contract.md)和 [06 实施交接 R2](06-implementation-plan-r2.md)为准。T04–T08 尚未启动，不复制旧视觉稿直接接入。D01 来源任务为 `01a0a037-45fb-7771-9a4c-b9157d412dad`；其工作树源成果保留，主目录交付包是本轮已复核副本。无 Git 提交、推送或线上部署。
''', encoding='utf-8')

link = guide.as_posix()
for name in ['00-master-design.md', '02-task-execution.md', '04-design-direction-review.md']:
    path = docs / name
    text = path.read_text(encoding='utf-8-sig')
    head, body = text.split('\n', 1)
    banner = f'\n\n> **最新交付：**[07 完整设计交付]({link})。D01 的真实模型交互原型、六页、地图设计、响应式画面、样片及复核包已完成。实际视觉参数以交付包 design-spec.md 为准，正式实现依据 05/06。以下早期评审/制作状态仅保留历史，不覆盖此更新。\n'
    path.write_text(head + banner + body, encoding='utf-8')

path = docs / '03-execution-status.md'
text = path.read_text(encoding='utf-8-sig')
text = text.replace('当前制作完整设计原型与交接，尚未开始正式业务代码重构。', '完整设计原型与交接已封存交付，尚未开始正式业务代码重构。')
text = text.replace('执行中，Astra负责完整场景/六页/样片/验证，未验收', '完整设计制作与主协调复核通过；25+8项检查通过，主目录副本及ZIP已封存')
text = text.replace('推荐“空间观测室”，尚未作为最终视觉定稿；T04–T08 暂停启动。', '“空间观测室”已完成D01设计交付，入口见07；T04–T08正式实现尚未启动。')
text = text.replace('D01 已在独立69f6工作树制作完整设计原型，不写主目录业务源码。', 'D01 已完成独立69f6工作树的完整设计原型并交还写入权；主协调已复核并复制封存，不写主目录业务源码。')
text = text.replace('## 当前核对', f'## 最新交付核对\n\n- 交付入口：[07-design-delivery.md]({link})。原型六页、地图、24格画面总览、16.24秒连续样片及规格已完成。\n- 主流程25项与地图8项通过，主协调独立交互/视觉/视频解码复核通过；原资产哈希一致、128个主目录受保护文件未改变。封存ZIP CRC与逐项SHA256通过。\n- 本阶段是完整设计交付；正式应用尚未替换，没有提交业务写请求或Git。\n\n## 既有阶段核对记录（历史）')
path.write_text(text, encoding='utf-8')
print('DESIGN_HANDOFF_PUBLISHED ' + str(guide))

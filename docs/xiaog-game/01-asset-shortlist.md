# 小G与魔方 · 在线资产候选

检索日期：2026-09-14。当前仅做来源调查，尚未下载、打开或视觉验收任何候选模型。用户已补充：希望有 3A 游戏质感、好看的仿真人，机器人也可以，具体 Blender 成品后期筛选调整。先提供可看的角色候选由用户选择，不自动锁定下表任何模型。

## 更新后的角色方向候选

| 候选 | 当前来源证据 | 需要进一步核验 |
|---|---|---|
| [Android Girl](https://www.cgtrader.com/3d-models/character/sci-fi-character/android-girl-d7b6d1b8-8ca0-477f-9d88-4a5363a9cd45) | 商品页列明白色/镀铬两版、完整绑定、walk/idle 等动作、4K PBR、Blend/FBX 等格式 | 仿人机械体方向；商品图须进一步查看脸部与手部；价格与许可、浏览器重发布限制、实际源文件待核验，不购买 |
| [Valery / Alexey Brodsky](https://www.blenderkit.com/asset-gallery-detail/6b35351a-03f8-4fe8-a1a0-c4fd31861322/) | 页面介绍写实女性、metarig、皮肤/眼/发材质和衣物，标为 Full Plan；页面体积 120.3MiB、面数 62,192 | 写实人类基础后加仿生设定；不是已验证的游戏 GLB，毛发/皮肤转换成本与许可需核实 |
| [Snow](https://studio.blender.org/characters/snow/v4/) / [Rain](https://studio.blender.org/characters/rain/v3/) | [官方更新文](https://studio.blender.org/blog/snow-rain-updated/)说明免费角色 rig 更新支持 Blender 4.1+；本次角色详情直接抓取返回 402 | 作为成熟风格化人物对照，不代表写实 3A；需通过可访问页面/浏览器核对实际图、版本与下载，不能因抓取错误直接说付费 |
| [Astra Lumen II](https://sketchfab.com/3d-models/astra-lumen-ii-a-rigged-companion-android-84761f55aa17493d9b226bb1f7101428) | 图片搜索发现有绑定陪伴型 android 的商品展示 | 仅新增线索；图片质量、模型是否匹配、具体许可、下载与 Blend 源均未核实 |

角色研究任务应再补充至少一个符合美感方向的成熟男性仿真人/科幻人物成品，避免候选仅有女性或明显卡通风格。作者图用于视觉挑选，不冒充本项目渲染。

## 早期机器人技术候选与魔方

以下机器人保留作低成本技术比较，不能因为好下载而替代用户要求的最终美术质量。

| 候选 | 已核对信息 | 适配判断与待检项 |
|---|---|---|
| [Quaternius Animated Robot Pack](https://quaternius.com/packs/animatedrobot.html) | 作者页面提供一个带动画、纹理的机器人，列出 FBX、OBJ、Blend 与 CC0 | 优先检查可编辑源、手臂活动范围、托举姿势与实际轮廓；官网的低多边形风格需通过材质与细节精修满足主角完成度 |
| [Three.js RobotExpressive](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive) | [上游 README](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/README.md) 标明作者 Tomás Laulhé、CC0 1.0；Don McCurdy 加入三种面部 morph、转换 GLTF、合并重复材质 | 已有 Web glTF 管线，作为机器人优先技术候选；与 Quaternius 属于同一作者来源方向，不当作两个独立美术方案。检查实际 clips、骨骼、手势、法线、重导出保真 |
| [Cute Home Robot / Yandrack](https://sketchfab.com/3d-models/cute-home-robot-7b75f204eb3e42b6babd883773e0789d) | 搜索索引列出可下载与 CC Attribution；直接页面本次返回 403 | 备用美术候选；页面、具体许可版本、绑定和手部能力尚未核对，不作为已可用资产 |
| [RUBIK'S CUBE / FromSi](https://sketchfab.com/3d-models/rubiks-cube-4cc7c1bf585f4b929ddd32f6cab3ba58) | 搜索结果显示可下载、CC Attribution、约 20.7k 三角形/11.2k 顶点；直接打开未成功 | 优先道具候选，实际下载权限、贴图与独立六面结构待检；数字是网页信息，不是本地测量 |

已排除将 [Kenney Robot Pack](https://kenney.nl/assets/robot-pack) 当成小G三维模型：作者页面将其归为 2D。可参考风格，但不满足本次真实三维主角要求。

## 选型与优化顺序

1. 先取得允许下载、修改及用于本项目的完整文件与许可信息；保存原始包、作者、页面 URL、获取日期、具体许可文本/链接和 SHA256。
2. 不用爬取查看器缓存或规避登录/付费限制来代替合法下载。免费可用候选优先；遇到付费资产先给具体候选和价格，不自行购买。
3. 在 Blender 独立后台进程打开来源副本，验证网格、材质、图片、骨骼、动画与尺寸；保持自动脚本禁用。
4. 看正面、侧面、三分之四与背面真实预览，判断手是否可托举、表情是否亲和、轮廓是否够精致。来源同一角色的 GLB 与 Blend 可作格式比较，但不要冒充风格对比。
5. 最终选一个角色方向与一个道具来源，记录选择理由及精修范围。优先换涂装、PBR、眼部/胸标、小范围倒角与姿势，不无故重建。
6. 魔方现成模型若无法合法取得或无法稳定标识六面，记录失败证据，再用 Blender 创建结构清晰的 3×3 替代；这只适用于简单道具，不借此把人物降级成拼装占位模型。
7. 所有下载候选在自托管发布前核对署名要求；运行时署名放入 About/credits 和 THIRD_PARTY_ASSETS，保留来源与修改说明。

## 第一任务的最低交付（按用户补充更新）

- 4–6 个具有实际成品来源的角色候选，覆盖仿真人、成熟机器人与少量风格化对照，避免以粗糙低模凑数；真实作者图片/可访问预览可供用户选择。
- 每项列清作者、格式是否明确包含 Blend、骨骼/表情、获取方式、许可已知范围和网页适配风险；所有未知信息明确标注。
- 可免费合法获取的资产可下载并做 Blender 只读检查，记录源哈希、真实预览与验证数据；未获取的不声称已验证。
- 交付候选对照与推荐理由，最终形象保持待用户选择。T01 ready 只表示候选研究交付完成，T02 最终人物精修仍须有选型输入。
- 同时整理魔方的可用来源或有证据的程序化替代决定，不因人物尚未选定停止独立工作。

本任务不需要先完成最终涂装、全套动作或生产 GLB；这些属于任务 02。

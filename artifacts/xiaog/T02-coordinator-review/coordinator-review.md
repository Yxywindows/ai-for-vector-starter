# T02 资产阶段协调复核

2026-09-14。结论：**资产交付复核通过，保留已知告警，可用于后续设计关键帧与镜头样片**。这不是最终页面视觉验收，也不证明目标设备上的前端性能。T04–T08 继续暂停；用户最新要求是先重审设计。

## 交付与范围

- 角色：用户已选 RobotExpressive / Quaternius 的 A 珍珠白、青蓝方案。此次身体精修采用更平顺的胸壳与微陶瓷材质，胸口保留精确文字 OpenGMS，字母沿胸壳曲面贴合。
- 魔方：独立 Cube_Root，无手部托举、抓握或 CubeSocket 依赖。六个功能面分别命名，角色与魔方分文件交付。
- [可编辑机器人](C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot/OpenGMS_A_editable.blend)、[角色 GLB](C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot/exports/OpenGMS_A.glb)、[独立魔方 GLB](C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot/exports/cube.glb)、[透明头像](C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot/evidence/avatar.png)。旧版 A_v1 已保留。
- [运行时交接清单](C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot/runtime_manifest.json)包含坐标、比例、动作、表情、六面映射与检查摆位。相机和灯光未嵌入运行时 GLB，后续按新构图设置。

## 主协调实际复核

1. 独立读取 GLB 二进制及索引：角色 3,568,508 字节、97,816 三角形、44 primitives、14 个动作；魔方 565,652 字节、17,560 三角形、13 primitives。合计 4,134,160 字节。两个 GLB 均无嵌入相机或灯光，无外部图片依赖；未发现同一三角形内重复索引。
2. 独立执行 [verify_delivery.py](C:/Users/yxy/Desktop/work/AI_FOR_VECTOR/artifacts/xiaog/T02-coordinator-review/verify_delivery.py)：31 项哈希/长度核对通过（含重复核对输入与原图，不代表 31 个不同文件）；覆盖原 8 项交付、3 项输入、6 张同版原图、2 项检查数据和新增 12 项验证包文件。结果见 [independent-verification.json](C:/Users/yxy/Desktop/work/AI_FOR_VECTOR/artifacts/xiaog/T02-coordinator-review/independent-verification.json)。
3. 打开实际 hero、胸口斜侧与侧面近景，检查胸壳及字母连接；补齐后再次打开最终同版 hero 与 [六视图总览](C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot/evidence/final_same_version/contact_sheet.png)。六视图均从最终 GLB fresh import，使用 TEMPERANCE，Idle 第 0 帧、Neutral、Cycles 32 samples。旧根目录视图不能替代最终同版六视图。
4. 打开本地实际 GLB 预览，确认加载成功，观察待机头部与独立魔方运动，切换并查看 Surprised，再恢复 Neutral。另审阅任务的浏览器动态、胸标父级稳定和根位移测试记录；这些记录不等于逐一人工观看全部 14 个动作。
5. 阅读 fresh-import、骨架/表情、胸标贴合、魔方面、头像 Alpha、glTF Validator 和最终源/导出几何检查脚本及报告。glTF 格式校验记录为角色 0 errors / 2 warnings，魔方 0 errors / 0 warnings。
6. 以设计评审时保存的 128 项源码及清单哈希对照，本轮无源码变化。此次只补验证与交接文档，不重跑无关业务测试。

## 保留告警与适用边界

- 角色的 2 条格式警告来自原模型非根 skinned hand 节点；已记录 fresh-import、动作和根位移检查通过。用户不要求手部动作，但不得将此表述为格式零告警。
- 确定性检查未发现无效坐标、无效 UV、缺失材质面、零长度边、wire 边或孤立顶点。GLB 导入胸标记录 2 个 local area ≤ 1e-12 的小/退化面；世界面积 ≤ 1e-14 的三角形为源 57、导入 58，集中在胸标与脚灯。阈值计数不等同全部精确零面积。本轮没有修改拓扑。
- GLB 索引计数为 97,816，Blender 导入后检查为 97,808；统计阶段不同，原因本轮未进一步定位，不能混用或声称完全逐三角形一致。原始边界/非流形统计包含机械零件分离和导出顶点拆分，不能据此宣称水密。完整数据见 [同版检查补充](C:/Users/yxy/.codex/worktrees/7862/AI_FOR_VECTOR/artifacts/xiaog/T02/robot/evidence/final_same_version/verification_addendum.md)。
- 魔方最小净空约 0.18615，仅指清单指定摆位、Idle 第 0/10/…/80 帧的 9 个离散姿态。包围球覆盖各采样姿态的整体旋转，不是连续时间碰撞证明，不覆盖其余动作。改变布局、角色比例或动作后重新检查。
- 浏览器预览与离线 Cycles 渲染曾同时运行，不发布生产 FPS 结论。未验证最终 GIS 页面同时渲染地图、角色和投影时的性能。
- 资产可用于新方案构图，不能将“可加载、资产复核通过”写成“已达到 AAA 画面”或“整站重构完成”。

## 后续交接

继续以 [04-design-direction-review.md](C:/Users/yxy/Desktop/work/AI_FOR_VECTOR/docs/xiaog-game/04-design-direction-review.md) 的“空间观测室”推荐方向为设计评审依据。模型完成只消除了实物构图依赖，不触发旧 T04–T08。后续若启动新的关键帧任务，使用本轮真实模型校准相机、比例、地图前景和融景对白，再按用户要求逐阶段新建任务。

T02 已明确停止写入。未提交或推送 Git。

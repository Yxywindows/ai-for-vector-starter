# T03 主协调复核

2026-09-14。结论：T03 范围接受，可以与验收后的 T02 一起作为 T04 输入。尚不代表完整小G体验完成。

- 实际审阅：ExperienceRoot、experienceReducer、ExperienceStage、featureRegistry、减少动态逻辑，以及AppShell/PlatformShell/router实际diff。
- 文件完整性：stage_manifest中的35个输出逐一复核，缺失/哈希不一致均为0。
- 主协调重新运行相关测试：ExperienceRoot与experienceReducer，2文件/13测试通过，20:31运行。
- 检查阶段日志：全套42文件/363测试、lint/typecheck/build通过；已有ImportPreview体积警告未被隐去。
- 检查实际浏览器验收脚本与18项报告：存在真实导航、URL、焦点、竞争取消、减少动态和宽度断言；API无mock，pageErrors/apiFailures为空。主协调未重复全套浏览器执行，结论依赖与源码哈希对应的阶段证据。
- 主协调实际打开1440px分析预览与390px移动端截图；按钮与菜单可读，移动端未见水平裁切。角色区明确标识制作中。

## T04/T05必须落实的集成事项

1. 当前页面是T03占位构图，左侧大标题与右侧功能卡片不能限制最终角色布局。T04让真实人物成为中心，缩小/收起介绍文案；T05将功能投影放到角色侧面，避免盖住脸、手和魔方。
2. 用三维实际对准完成事件替换focusing计时器，继续用transitionId使过期回调无效；场景失败与减少动态必须能直接进入可操作预览，不永久等待资产。
3. 实际GLB的朝向、CubeSocket和六面法线以T02重导入manifest为准，不能假定Blender原坐标等同glTF坐标。
4. T05将底部对白完善为设计要求的融景对话与可读字号，加入用户选择反馈；当前小型底部引导条不是最终对话效果。
5. T03没有三维Canvas，没有生产模型/动画/空间投影/陪伴模式；不能据此宣称这些功能通过。全业务mutation和地图完整验收留给T07/T08。

主协调未修改本次验收源码。T03停止写入，后续阶段才可获得主目录web/src写入权。

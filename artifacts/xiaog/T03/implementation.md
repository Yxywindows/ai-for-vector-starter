# T03 游戏壳层与导航状态基础

## Implemented

- `/` 改为游戏舞台入口，原 Dashboard 位于 `/overview`。六个入口先展示功能说明和融景对白，点击展开后进入真实业务路由。
- 新增 `web/src/experience`：六面功能注册表、状态 reducer、运动配置、减少动态设置、轻量根壳与舞台视图。
- 抽出共享 `BrandMark`，地图仍通过原有 lazy 边界加载，保持独立布局。首页不加载地图引擎，也未引入三维依赖。
- 保留项目详情、数据详情、地图深链和最近地图快捷入口。装饰状态不通过更换 Outlet key 重挂载业务页面。

## Decisions

- URL 是业务页面状态来源；reducer 仅拥有展示阶段和选中功能。`transitionId` 使旧计时回调失效，最新选择或路由改变覆盖旧转场。
- `navigating` 是展开结束到路由提交之间的内部阶段；导航副作用按路由 key 与 transitionId 去重。
- 普通点击先预览，Ctrl/Meta/Shift/中键保持原生链接行为。Escape 取消主页转场，表单与模态框优先；返回时焦点归还功能菜单。
- 系统减少动态优先，手动设置持久化；深链初始状态直接 active，不先播放首页动画。
- 六面法线是 glTF 坐标约定（+Y 向上），须在 T04 对照实际 T02 manifest。T04 接入真实场景时应替换 focusing 的定时完成机制，继续携带 transitionId，避免场景完成与旧计时器争写状态。
- 本阶段明确显示“Snow v4 · 三维角色制作中”，只有空的舞台预留区，未冒充生产角色、魔方或全息空间投影。T02、T04、T05分别负责资产、运行时、完整转场。

## Review and fixes

- 审阅现有三个 app 文件 diff 以及全部新增 experience 文件，核对路由、取消竞态、焦点、业务挂载与样式作用域。
- 修正移动端六入口拥挤、地图返回舞台时链接颜色过渡闪变、移动端正文尺寸；引导文案改为不依赖菜单方向。
- 修正严格 TypeScript 测试索引断言；预览展开入口在非 preview 阶段提供 aria-disabled，与 reducer 的行为一致。

## Verification

- 全量 Vitest：42 文件 / 363 测试通过（tests.log）。最后的文案、阶段类型与 aria-disabled 调整后，相关 2 文件 / 13 测试再次通过（focused-final.log）。
- lint、typecheck、生产 build 通过；最终版本又通过 build 中的 TypeScript 编译。见对应日志。
- 真实 Chromium 151.0.7922.34、真实本地 API、无请求 mock：18 项浏览器检查全部通过，未捕获页面异常或失败 API 请求。
- 浏览器覆盖：六入口闭环、历史、取消与改选竞争、Ctrl 新标签、键盘与焦点、减少动态、1920×1080 / 1024×768 / 390×844、真实项目与数据详情、地图 lazy 深链和最近地图入口。
- 证据目录：`qa/2026-09-14T12-24-37-136Z`，含 report.json 和 11 张截图。截图采集后仅修改方向无关文案、类型收窄及 aria-disabled，无布局改动。
- `git diff --check` 通过。原有 `backend/app/db/base.py` SHA256 与任务输入一致；未写后端与其他已有文档，未修改依赖或提交 Git。

## Issues and coverage limits

- 完整三维人物、魔方停转对准、世界坐标投影、角色陪伴与连续动作录像尚属后续阶段，本阶段 ready 只表示 T03 范围完成。
- 地图浏览器证据证明深链、容器初始化、懒加载和独立壳层；不等同于所有地图要素绘制、导入、编辑、分析、导出业务验收。没有执行业务数据写操作。
- 原有 ImportPreview 构建块仍约 1.10 MB，产生 >500 kB 警告；未在本阶段扩大依赖拆分范围。
- jsdom 在 Ctrl 链接测试输出“不支持另一文档导航”提示，测试通过；真实 Chromium 新标签导航另有通过证据。

## Reproduce

在 `web` 运行 `npm.cmd run lint`、`npm.cmd run typecheck`、`npm.cmd run test -- --run`、`npm.cmd run build`。

浏览器检查需要真实后端 1316、前端 18403，以及既有只读验证项目/图层（具体 ID 见脚本）。在项目根目录运行 `node artifacts/xiaog/T03/browser-check.mjs`。不要将脚本内已存在的数据 ID 当成通用部署数据。

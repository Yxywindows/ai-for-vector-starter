> 2026-09-15 最新 R1.2：成功 Yes 点头；失败 No 挥手并保持头部稳定；眼神跟随鼠标。29项本次检查通过，已核对桌面/手机画面及7.47秒新动作样片。当前约定见 [INTERACTIONS.md](INTERACTIONS.md)。下方旧版本说明及原R1图片/影片为历史基线。

> 2026-09-15 补订 R1.1：小G对白随当前分析方法同步更新；七种方法及返回流程共9项DOM集成检查通过。原R1的25项主流程、8项地图、截图与样片为历史基线，本次未重做。详见 [REVISION.md](REVISION.md)。

# D01 · 空间观测室完整设计原型

可运行入口：**http://127.0.0.1:18404/**。从总览打开完整原型、六个目的页、地图工作区、关键帧、联系表和连续镜头。

本包全部运行资源都在本地，启动只需要 Node.js，无需 npm install。解压/复制整个目录后，**在解压目录打开 PowerShell**：

```powershell
node server.mjs
```

看到 `D01_READY http://127.0.0.1:18404/` 后打开该地址。也可以在同一解压目录运行 `.\start.ps1`；若端口已占用，先核实原型是否已经运行，不停止其他服务。服务器仅绑定 `127.0.0.1`，仅接受 GET/HEAD。不使用运行时 CDN，也不依赖正在运行的 GIS 后端。

建议查看顺序：

1. 首页 → 选择“空间分析” → 在预览停留 → 点击“展开工作台”。
2. 切换六页，体验项目/图层选择、数据搜索、任务筛选、分析与导出校验。
3. 打开地图设计页，点击“编辑属性”，修改名称后尝试离开；也可展开“查看状态设计”演示保存失败。
4. 查看 `evidence/contact-sheet.png`、关键帧和 `evidence/observatory-film.webm`。
5. 读取 `design-spec.md`、QA JSON、`stage_manifest.json` 与 `SHA256SUMS.txt`。

这是设计原型。真实项目、城市边界和历史任务来自注明时间的有限只读快照；新分析/导出不执行，地图草稿只保存在当前标签页。正式应用代码、T02 原资产、数据库与现有服务未被修改。本阶段未提交或推送 Git。

可移交的 ZIP 排除 node_modules、输出缓存、临时日志及开发期一次性修补脚本。保留 `vendor`、模型和许可证。运行入口是 `index.html`，浏览器直接双击 HTML 不能替代本地 HTTP 服务的 ES module 加载。

自动验证（需现有 Playwright 安装，仅用于复核，不是运行依赖）：

```powershell
$env:D01_WEB_PACKAGE = 'C:\Users\yxy\Desktop\work\AI_FOR_VECTOR\web\package.json'
node scripts/qa.mjs
node scripts/map-qa.mjs
node scripts/verify.mjs
```

`qa.mjs` 和 `map-qa.mjs` 写入 evidence 的验证报告；完成封存后复核建议在复制包上运行。`verify.mjs` 只读核对清单，不启动业务服务。

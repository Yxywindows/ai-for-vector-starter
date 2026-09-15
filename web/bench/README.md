# 地图工作区浏览器基准工具

[项目测量指南](../../docs/benchmarks.md) · [bench.mjs](bench.mjs)

## 前置条件

启动 PostGIS、后端 1316 和 Vite 开发服务器 1317；准备 Benchmarks 项目。数据准备命令及覆盖固定表的行为见项目测量指南。工具使用 Playwright 的 Chromium，并依赖开发构建中的 window.__olMap。

在 web 目录：

```powershell
npx.cmd playwright install chromium
npm.cmd run bench -- --scenario cold
npm.cmd run bench -- --scenario warm
npm.cmd run bench -- --scenario warm
npm.cmd run bench -- --scenario pan
```

参数：--scenario cold|warm|pan（默认 cold），--project "Benchmarks"，--url http://localhost:1317。项目通过 /api/v1/projects 按名称解析，再打开 /projects/:projectId/map。

## 场景与产物

cold 使用新 Chromium profile；warm 复用 bench/.profiles/warm，第一次填充后才能测热态；pan 从新 profile 打开地图，再操作真实 OL View 完成五次移动。所有可见项目图层共同参与测量。

每次输出 bench/results/<scenario>-<timestamp>.json 和终端摘要。结果和 profile 都被 gitignore 忽略；发布报告时另行保留需要交付的原始数据及运行环境说明。

## 指标

| JSON 字段 | 口径 |
|---|---|
| initialLoadMs | Navigation Timing 起点到 graticule:first-render 标记，即首次地图 rendercomplete |
| panP95FrameMs | pan 期间 requestAnimationFrame 帧间隔 p95 |
| moveSettleP95Ms | moveend 到后续 rendercomplete 样本 p95；没有样本为 null |
| usedJSHeapMB | Chromium performance.memory 的 JS heap，实际除以 1024² |
| networkBytes | CDP Network.loadingFinished.encodedDataLength 累计 |
| longTasks | PerformanceObserver 的 count 与 maxMs |
| geoCache | 若存在 window.__geoCache.metrics 则采集；否则 null |

当前地图没有接入 [geoCache](../src/cache/geoCache.ts)，也未暴露该 metrics hook；独立缓存实现的存在不会自动改变本工具指标。warm 不能据此解释成应用 IndexedDB 缓存命中。

采样未完成或 hook 缺失时应解释失败/null，不能把它当作零延迟。历史大图层不 settle 的现象见[原始基线](../../docs/history/benchmarks-2026-08-02.md)，不是当前每次测量必然出现的结果。

# Web 前端导航

这里是 Graticule 的 React 19、TypeScript、Vite 前端。业务 API 统一从 `/api/v1` 调用；Vite 开发服务器默认运行在 `1317`，并把 `/api` 转发到 `http://localhost:1316`。本页用于快速定位，代码行为和边界见[前端实现参考](../docs/reference/frontend.md)。

## 入口与页面

`src/main.tsx` 安装 React Query 和 React Router。路由分成两个独立壳层：平台页面由 [router.tsx](src/app/router.tsx) 挂到 [PlatformShell.tsx](src/app/PlatformShell.tsx)；地图工作区 `/projects/:projectId/map` 是懒加载的同级路由，入口为 [App.tsx](src/App.tsx)，不经过平台壳层。

| 路径 | 页面和主要实现 |
|---|---|
| `/` | [DashboardPage.tsx](src/pages/DashboardPage.tsx)：概览和项目入口 |
| `/projects`、`/projects/:projectId` | [ProjectsPage.tsx](src/pages/ProjectsPage.tsx)、[ProjectOverviewPage.tsx](src/pages/ProjectOverviewPage.tsx)：项目列表和图层概览 |
| `/data`、`/data/:layerId/*` | [DataCatalogPage.tsx](src/pages/DataCatalogPage.tsx)、[DatasetDetailsPage.tsx](src/pages/DatasetDetailsPage.tsx)：目录、数据集详情及懒加载预览 |
| `/tasks` | [TasksPage.tsx](src/pages/TasksPage.tsx)：后台任务状态、日志、取消和重试 |
| `/analysis`、`/exports` | [AnalysisPage.tsx](src/pages/AnalysisPage.tsx)、[ExportsPage.tsx](src/pages/ExportsPage.tsx)：提交分析和导出任务 |
| `/projects/:projectId/map` | [App.tsx](src/App.tsx)：地图、图层、属性表、编辑、样式和内存面板 |

## 状态归属

- 项目、图层、属性、任务和系统信息来自服务端，由 TanStack Query 管理；默认 `staleTime` 为 30 秒、失败重试一次、不因窗口聚焦自动刷新，见 [queryClient.ts](src/app/queryClient.ts)。
- 当前项目身份来自路由参数。Zustand 的 [layerStore.ts](src/state/layerStore.ts) 保存图层/要素选择和截断提示等界面状态，不保存服务端图层对象。
- 工作区相机、选择和抽屉状态与 URL 查询参数同步；面板布局和底图选择按项目写入 `localStorage`。具体键名与读写时机见[实现参考](../docs/reference/frontend.md#工作区状态与持久化)。
- OpenLayers `Map`、图层和 `VectorSource` 是运行中的渲染对象；它们不是 Query 缓存或 Zustand 中的副本。独立的 IndexedDB 地理数据缓存模块尚未接入实时地图请求。

## 常用命令

在 `web/` 目录执行：

```bash
npm.cmd ci
npm.cmd run dev
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test -- --run
npm.cmd run build
```

Vite 和 Vitest 配置见 [vite.config.ts](vite.config.ts)，脚本定义见 [package.json](package.json)。前端的代码与测试对应关系、地图加载策略和已知边界在[详细参考](../docs/reference/frontend.md)；文档导航见 [docs README](../docs/README.md)，仓库总览及学习篇章见[根 README](../README.md)。

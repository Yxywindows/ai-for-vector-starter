# GIS Platform / AI_FOR_VECTOR

一个以项目组织图层的 Web GIS：React 平台页面管理数据、任务、空间分析和导出；OpenLayers 工作区负责地图显示、样式、属性查询和几何编辑；FastAPI 通过 PostGIS 与本地栅格文件提供服务。

本文档体系于 2026-09-13 根据工作区代码重建，检查基线为 `948e548`。能力描述以实际调用链为准，历史设计不代表已交付功能。

## 从哪里开始

| 读者 / 目标 | 入口 |
|---|---|
| AI 接手代码任务 | [AI 阅读指南](docs/ai/README.md) → [代码地图](docs/ai/code-map.md) |
| 理解业务与代码管理关系 | [业务功能映射](docs/business-map.md) |
| 理解整体依赖、数据所有权 | [系统架构](docs/architecture.md) |
| 安装、启动、测试 | [开发运行手册](docs/development.md) |
| 查接口 / 前端 / 后端 | [文档总目录](docs/README.md) |
| 理解空间数据技术 | [九篇技术章节](docs/learning/01-architecture-overview.md) |

## 当前能力

- 项目管理、跨项目数据目录、数据详情、地图 URL 视图恢复和缩略图。
- 注册 PostGIS 表、XYZ/MVT 地址；同步矢量/栅格导入、GeoJSON 草稿预览与修订、后台矢量导入。
- 按规模选择 GeoJSON 或 MVT，栅格 PNG 瓦片，属性分页、样式与要素编辑。
- 七种后台空间分析，以及矢量 GeoJSON/CSV/GPKG/Shapefile 和栅格 GeoTIFF 导出。
- 任务查询、日志、合作式取消、符合条件的重试，以及服务器/地图内存观测。

能力限制及未接入模块见[当前边界](docs/architecture.md#当前边界)。其中浏览器多级缓存已有独立实现和测试，但尚未接入地图加载调用链。

## 本地运行

需要 Python 3.12+、能安装当前 Vite 依赖的 Node.js/npm，以及 Docker 中的 PostGIS。仓库未声明 Node `engines`，按实际安装的 Vite 包要求检查 Node 版本。

在仓库根目录的 PowerShell 中启动数据库：

```powershell
docker compose up -d postgres
```

新终端启动后端：

```powershell
Set-Location backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 1316
```

另一个从仓库根目录打开的终端启动前端：

```powershell
Set-Location web
npm.cmd ci
npm.cmd run dev
```

浏览器访问 http://localhost:1317；OpenAPI 访问 http://localhost:1316/docs。端口、配置、测试库准备及校验命令详见[运行手册](docs/development.md)。Compose 只包含数据库与可选 pgAdmin，未提供完整应用部署编排。

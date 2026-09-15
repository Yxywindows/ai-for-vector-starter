# 文档总目录

本目录是当前项目的维护入口。当前实现说明、技术解释和历史计划各有用途；发现冲突时追踪源文件及测试，修正文档。

## 阅读路径

1. [系统架构](architecture.md)：运行单元、存储所有权、事务与边界。
2. [业务功能映射](business-map.md)：功能 → 页面 → API → 服务 → 存储 → 测试。
3. [AI 阅读指南](ai/README.md)与[代码地图](ai/code-map.md)：按任务选择最小阅读集合及联动范围。
4. [开发运行手册](development.md)：配置、启动、迁移、验证。
5. [接口参考](reference/api.md)、[后端参考](reference/backend.md)、[前端参考](reference/frontend.md)。

## 技术章节

| 章节 | 主题 |
|---|---|
| [01](learning/01-architecture-overview.md) | 总体结构与请求路径 |
| [02](learning/02-spatial-data-model.md) | 元数据、空间表与迁移 |
| [03](learning/03-postgis-and-dynamic-sql.md) | 动态 SQL 与数据源验证 |
| [04](learning/04-feature-streaming.md) | BBOX、坐标转换与截断 |
| [05](learning/05-vector-tiles-mvt.md) | MVT 生成和 HTTP 缓存 |
| [06](learning/06-raster-tiling-and-cog.md) | 栅格导入、COG 与瓦片 |
| [07](learning/07-memory-management.md) | 资源池、地图内存及缓存接入边界 |
| [08](learning/08-styling-and-renderers.md) | 样式契约与渲染 |
| [09](learning/09-editing-and-transactions.md) | 编辑缓冲与事务 |

## 专题与历史

- [性能测量](benchmarks.md)、[浏览器测量工具](../web/bench/README.md)。
- [历史设计索引](superpowers/README.md)：保留原始方案、计划与当时的交接上下文，不作为当前实施指令。
- [文档维护规则](ai/maintenance.md)：稳定业务标识、证据维护及更新流程。
- [后端模块入口](../backend/README.md)、[前端模块入口](../web/README.md)。

## 文档状态

本次仅重建文档，不代表重新验收应用运行或性能。历史基准仍属于其原始时间与提交。代码中已有但未接入的模块，必须明确标注接入状态；未来计划必须与当前行为分开。


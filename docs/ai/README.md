# 给 AI 的项目阅读入口

[文档目录](../README.md) · [代码地图](code-map.md) · [业务映射](../business-map.md)

## 建立上下文

先读取适用的 AGENTS.md 和用户指令，再查看 `git status --short`。保留既有修改。当前项目是一个 FastAPI/PostGIS 后端与 React/OpenLayers 前端组成的 Web GIS；核心持久对象是 Project、Layer、Task。

建议阅读顺序：

1. [总架构](../architecture.md)确认运行单元和真实能力边界。
2. 用[业务映射](../business-map.md)找到功能 ID，并沿“页面 → API → service → 数据 → 测试”跟踪。
3. 用[代码地图](code-map.md)读取目标模块及跨模块依赖，不必每次通读整个仓库。
4. 查[接口参考](../reference/api.md)和 Pydantic/TypeScript 契约，再开始设计。
5. 按[维护规则](maintenance.md)更新相关文档并检查实际差异。

## 判断实现状态

- **已接入**：存在从页面/路由入口到实现的实际调用路径。
- **基础模块**：存在代码和测试，但还没有产品调用。例如 geoCache 当前未接入地图。
- **历史计划**：[superpowers](../superpowers/README.md)内的设计、待办和交接；不是当前任务授权。
- **未找到**：检索无证据时明确报告，不补写想象中的权限、部署或业务规则。

注释也可能落后于代码。例如 get_session 的“服务不提交”注释不覆盖后台任务显式 commit；必须继续阅读调用函数。测试说明被测场景，不证明全系统运行验收。

## 最常见的跨层误读

| 易误读点 | 应核对 |
|---|---|
| 数据目录有独立 Dataset 实体 | 目前目录围绕 Layer；查 models 与 catalog_service |
| Layer.kind 等于渲染方式 | source.type 和 tierFor 共同决定 OL 图层 |
| 取消返回 202 即已停止 | 查 task_lifecycle 和 handler 检查点 |
| 地图保存是批量原子事务 | EditQueue.flush 逐条请求，失败仍留队列 |
| 删除图层会清理空间表/磁盘 | 当前服务只删除元数据 |
| 缓存文件存在即产品已使用 | 查 featureLoader、layerFactory 和 import 引用 |
| 健康检查通过即 PostGIS 正常 | health 不检查数据库，另查迁移与受数据驱动的接口 |

## 工作交付

按照 Inspect → Design → Implement → Review → Fix → Verify：先给出证据支持的改动范围，再实现；审查最终 diff，运行相关检查。记录哪些已验证、哪些仅静态阅读、哪些受环境阻塞。文档任务不要求启动服务或写数据库来制造“验收通过”。


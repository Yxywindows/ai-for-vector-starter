# 性能测量

[文档目录](README.md) · [浏览器工具](../web/bench/README.md) · [历史基线](history/benchmarks-2026-08-02.md)

## 当前结论边界

历史基线于 2026-08-02 记录，对应提交 4e1c287；本次重建文档未运行新的性能测量。旧记录中的耗时、内存和“尚未实现”只属于当时上下文。

当前代码已有后端快照/MVT 缓存及浏览器 geoCache 基础模块，但浏览器缓存尚未接入地图。不能把缓存单测或旧 warm 成绩当作当前地图缓存收益。工具中的 geoCache 指标是可选 hook；无 hook 时返回 null。

## 后端测量

[bench.py](../backend/scripts/bench.py)支持 seed、measure、clean。默认使用 Settings 中的数据库；seed 会 DROP 并重建固定的 gis_data.bench_points_10000、bench_points_100000、bench_points_1000000 表。只有确认这些表是可重建基准数据后才执行。

在 backend 目录且服务已启动时：

```powershell
.\.venv\Scripts\python.exe scripts/bench.py seed
.\.venv\Scripts\python.exe scripts/bench.py measure
```

measure 针对每层请求 MVT、BBOX features、attributes 并打印 p50/p95。clean 是删除基准数据的操作，使用前先核对脚本实际目标，不列入正常验证命令。

## 浏览器测量

在 web 目录，使用开发服务器以便访问 window.__olMap：

```powershell
npx.cmd playwright install chromium
npm.cmd run bench -- --scenario cold
npm.cmd run bench -- --scenario warm
npm.cmd run bench -- --scenario warm
npm.cmd run bench -- --scenario pan
```

cold/pan 使用新 profile，warm 复用 profile。warm 首次是填充，后续才是热态。结果写入 web/bench/results，profile 在 web/bench/.profiles。需要新一轮独立基准时先保留旧结果，并明确记录 profile 状态。

## 记录要求

记录提交、工作区修改、OS/CPU/RAM、Node/Python/浏览器版本、数据库配置、服务是否 reload、图层数量/可见性、网络和缓存初态。每种场景建议重复三次，保留原始 JSON；报告中位数和异常值。

null 指标表示未取得样本，不能记为 0 或推断成功。JS heap 不是进程总内存；networkBytes 是 CDP 网络口径；地图内存面板是估算口径。具体定义见[工具说明](../web/bench/README.md)。

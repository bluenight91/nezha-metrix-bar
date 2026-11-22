# Nezha for Metrix.Bar

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)
[![Metrix.Bar](https://img.shields.io/badge/for-Metrix.Bar-0A94F2.svg)](https://metrix.bar/)
[![Nezha](https://img.shields.io/badge/monitor-Nezha%20V2-0338D6.svg)](https://nezha.wiki/)

哪吒监控 V2（[Nezha Monitoring](https://nezha.wiki/)）的 [Metrix.Bar](https://metrix.bar/) 菜单栏与桌面小组件 —— 在 macOS / Windows / Linux 上随时查看多台服务器的在线状态、带宽与资源占用，服务探测可用性，以及需要关注的事项。

**English:** A read-only Metrix.Bar menu-bar and desktop-widget dashboard for Nezha Monitoring V2 — multi-server status, bandwidth, service probes, and an attention stream.

| Servers（2 列网格 + 汇总） | 单机详情（指标曲线） |
| --- | --- |
| ![Servers](assets/servers-dark.png) | ![Detail](assets/detail.png) |

| Services（服务探测） | Alerts（关注事项） |
| --- | --- |
| ![Services](assets/services.png) | ![Alerts](assets/alerts.png) |

| Traffic（周期流量与剩余配额） | Light（浅色主题） |
| --- | --- |
| ![Traffic](assets/traffic.png) | ![Light](assets/servers-light.png) |

面板高度会随分组内实例数自适应收缩，实例较多时可滚动。

## 功能

- **托盘** — 默认 `21/21 · 1.2M/s` 在线数 + 总带宽，共 7 种格式可配，含 3 种 macOS 富渲染模式（双行紧凑速率、速率 + 迷你面积图、CPU + 迷你趋势图），不支持平台自动回退文本；错误时保留最后数值；菜单：刷新 / 打开哪吒 / 清空关注
- **刘海屏 Notch（Plus）** — 左右侧翼显示健康着色图标 + 紧凑数值（聚合网速 / 平均 CPU / 在线数），悬停/点击展开集群趋势、告警快讯与 Top 热点节点；节点离线、探针异常、流量超限或收到 Inbox 告警时自动弹出限时动态岛
- **精致视觉与自适应布局** — `material="solid"` 通透纯色基底 + `match-media` 极细发丝边框 + 自适应内容高度；独立策划的克制色板（常规数字保持主字色，状态/趋势采用哪吒蓝、天青、翡翠绿与靛蓝点缀）、顶部 4 格微渐变 KPI 趋势磁贴与无边框 SVG 图标按钮
- **服务器 Tab** — 哪吒原生分组 + 星标 Watchlist（`全部 / 已选` 切换，托盘与汇总跟随关注范围；空关注 = 全部）
  - 顶部 4 格趋势 KPI 磁贴：在线比、↓/↑ 实时带宽迷你图、平均 CPU 迷你图；下方轻排累计 ↓↑ 流量与异常提示；离线机器的旧速率不会计入实时汇总
  - 双视图切换：Flyout 默认 3 层精炼卡片网格，亦可一键切至**可排序紧凑表格**（支持按节点 / CPU / 内存 / 磁盘 / 下行 / 上行 / 负载点击升降序）；在宽窗口或独立 App（宽度 ≥ 860 DIP）自动展开**左侧列表 + 右侧实时详情**双栏布局
  - 超过 6 台时支持名称 / 备注搜索；分组较多时自动切换为完整下拉选择；支持一台机器属于多个分组
  - 点击单机 → 详情：规格、当前状态、实时与累计流量、一键复制摘要、1 天 / 7 天指标历史曲线（CPU·内存 与 网络两张图，需 Dashboard 启用 TSDB）
  - 详情页「网络延迟」：前 8 条监控点延迟曲线 + 全量监控点网格（当前延迟、丢包率）
  - 详情页「在线情况」：在线率 / 累计在线 / 累计离线 / 最后活跃 + 每日在线时长条（`/api/v1/server/{id}/online-history`）
- **桌面小组件** — small / medium / large 三种尺寸、完整中英本地化、四种可配置内容：全局总览（中/大尺寸含聚合带宽趋势图）、单服务器、周期流量、关注事项；单机支持 ID、唯一完整名称或跟随面板选中项，large 复用详情历史曲线
  - Metrix.Bar 0.3+ 支持安装多个 Nezha 实例以同时放置不同模式的小组件或监控多套哪吒集群
- **流量 Tab** — 周期流量提醒（来自 `/api/v1/service` 的 `cycle_transfer_stats`）：每条周期一张卡，显示已用/配额、剩余量、占比条、周期起止、下次更新；≥80% 变橙、≥95% 变红
- **服务 Tab** — HTTP / Ping / TCP 探测列表：存活率、最新延迟、失败标红；类型过滤
- **关注 Tab + Plus Inbox 告警** — 实时关注事项（离线主机 + 失败探测 + 周期流量阈值）+ **Metrix.Bar Plus 收件箱 Webhook / 邮件告警流**（接收哪吒后端完整规则告警，支持展开详情、复制、标记已读/未读与删除）+ PAT `nezha:alertrule:read` 告警规则列表
- **通知与省流** — 离线 / 探测失败 / 周期流量 / Inbox 告警均支持点击通知直达对应节点或告警；基于 `$metrix.outputs()` 按需裁剪渲染与详情请求，并监听 `network.change` 在唤醒/切网后即时重连刷新
- **认证** — 游客模式（站点需允许未登录读取）或 PAT；强制登录站点会显示明确的「请填写 API Token」提示
- **数据通道** — `liveUpdates` 开启时，游客站点使用 `/api/v1/ws/server` WebSocket + 每 30 秒 REST 对账；关闭后完全使用 REST。PAT 始终按配置间隔（2–60s）进行 REST 轮询（Worker 的 WebSocket 无法携带 `Authorization` 头，把 PAT 放进 URL 会泄漏）
- **分级刷新** — 服务数据至少 15 秒、设置与分组 5 分钟、告警规则 60 秒更新一次；手动刷新立即拉取全量。详情请求并行、去重，缓存最多保留 8 个服务器/周期条目
- **只读** — 不做终端、文件管理、MCP 等写操作

## 安装

### 方式 A：通过 registry（推荐）

在 Metrix.Bar **Settings → Registries** 添加 [Awesome.Metrix.Bar](https://awesome.metrix.bar/)：

```text
https://awesome.metrix.bar/dashboards/index.json
```

然后从目录中安装 **Nezha**。

### 方式 B：手动导入

1. 下载 [nezha.bar](nezha.bar)
2. 在 Metrix.Bar 中导入该文件并确认权限（仅申请你填写的 Dashboard 域名网络访问）

## 配置（Inputs）

| 输入 | 类型 | 说明 |
| --- | --- | --- |
| `baseURL` | string（必填） | Dashboard 地址，如 `https://nezha.example.com` |
| `apiToken` | secret（可选） | PAT（`nzp_…`）。推荐 scope：`nezha:inventory:read`、`nezha:server:read`、`nezha:service:read`，可选 `nezha:alertrule:read`。站点开启 `force_auth` 时必填 |
| `refreshInterval` | select | 轮询间隔：2s / 5s（默认）/ 10s / 30s / 60s |
| `liveUpdates` | bool | 游客模式使用 WebSocket + 30 秒 REST 对账（默认开）；关闭则完全 REST；PAT 始终 REST |
| `trayFormat` | select | 托盘显示：4 种文本格式 + 3 种 macOS 富渲染格式（`stacked_rate` / `rate_spark` / `cpu_spark`） |
| `notchMetric` | select | 刘海屏右侧紧凑指标：`rate` 聚合网速（默认）/ `cpu` 平均 CPU / `online` 在线数 |
| `notchActivity` | bool | 离线 / 探针异常 / 流量超限 / Inbox 告警时弹出刘海屏动态岛（默认开） |
| `serverView` | select | 服务器布局：`auto` 自动（默认，弹窗卡片 / 宽窗表格）/ `cards` 卡片 / `table` 表格 |
| `widgetMode` | select | 桌面小组件：`overview` 总览（默认）/ `server` 单机 / `traffic` 周期流量 / `attention` 关注 |
| `widgetServer` | string（可选） | 单机 Widget 留空时跟随面板选中的服务器；也可输入 ID 或不区分大小写的唯一完整名称，重名时须使用 ID |
| `offlineNotify` | bool | 服务器离线桌面通知（默认开） |
| `probeNotify` | bool | 探测失败桌面通知（默认开） |
| `trafficNotify` | bool | 周期流量跨越 80% / 95% 时通知（默认开） |

PAT 在管理前端 **设置 → API Tokens** 创建；Token 只会保存在系统凭据库（secret input），不会出现在源码或日志中。

在系统小组件选择器中添加 **Metrix.Bar** 并选择 **Nezha**，即可放置桌面卡片。macOS 需要 14+ 与 Metrix.Bar 0.2.0+；Windows 11 22H2+ 和 KDE Plasma 6 的支持范围以 Metrix.Bar 文档为准。**同一实例的多张 Nezha 卡片只能显示相同内容，不能逐卡选择模式**；系统控制刷新时机，仅 Widget 保持活跃时最快每分钟更新一次。设置标签、选项和帮助文本通过 `<locale lang="zh-Hans">` 跟随 App 的简体中文界面，默认英文。静态 `<docs>` 配置说明不支持按 App 语言切换，因此采用中文在前、英文在后的完整双语说明。

## 开发

```sh
git clone https://github.com/bluenight91/nezha-metrix-bar
node --test helpers.test.mjs runtime.test.mjs   # 纯函数 + 真实 .bar 脚本运行时测试（76 个）
```

- `nezha.bar` — 看板本体（单文件，协议 v0）
- `helpers.mjs` — 纯函数（数据合并 / 汇总 / 格式化），同步内联进 `nezha.bar`
- `helpers.test.mjs` — Node 内置 test runner 的纯函数单元测试
- `runtime.test.mjs` — 使用 mock fetch / WebSocket 执行真实 `.bar` 脚本，覆盖连接切换、WS 开关、分级轮询、超时、详情并发去重、面板高度和 Widget 主要交互
- `assets/` — 截图（由 Metrix.Bar Local API `/v0/check` 的 fixture + screenshot 功能渲染，只使用虚构数据）

质量门：Metrix.Bar Local API `/v0/validate` + 带 fixture 的 `/v0/check`（Tab、星标、关注过滤、搜索、详情进出、告警跳转、四种 Widget 模式与三种尺寸）。

## 兼容性

- Nezha Monitoring **V2**（REST 路径为 `/api/v1` —— 路径版本与产品代际独立，勿改为 `/api/v2`）
- Metrix.Bar protocol v0，最低应用版本 `0.3.0+`；Notch 与 Inbox 告警需 Metrix.Bar Plus，macOS 桌面卡片需要 macOS 14+

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[AGPL-3.0-only](LICENSE)。图标来自 [LogoHub 的 Nezha 官方标志](https://logohub.afengblog.com/logo/nezha)（彩色版 + 暗色模板版）。

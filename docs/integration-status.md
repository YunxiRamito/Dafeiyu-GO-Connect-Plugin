# Aries 集成状态

## 2026-10-16 连接语义修复与 0.3.1 本地候选

已实现默认 DSH 工作区／对话共享及网页广播、schema2 原生偏好与旧关闭开关／目录 root 的安全迁移。DSH 模式不扫描、上传或接收工作区文件。修复 workspace 元数据错误依赖可选本机目录 picker，以及网页 wrapper 从不广告能力的问题；网页现在要求真实认证首页读取和 Gateway 服务，手机仍以已配对电脑认证能力广告准入。能力广告每 15 秒重发。包清单显式携带 MIT LICENSE。

本地源码行为测试与 Android 编译／离线测试由本轮证据记录，不能扩大为已发布、已安装设备或跨端公网完成。历史 0.3.0 freeze 及以下验收边界保留；新包必须使用 0.3.1 并在 PC／Android 同步摘要，不能覆盖旧版本。

## 2026-10-13 源码公开与 0.3.0 候选边界（历史）

当前源码的包版本为 0.3.0，公开归属为 `YunxiRamito/Dafeiyu-GO-Connect-Plugin`，项目许可证 MIT。源码提供任务、工作区、目录、全局默认设置、网页隧道、产物／附件及归档生命周期适配，但必须由宿主声明真实能力并验证权限。未通过双端端到端验收的网页、产物、附件和归档永久删除 gate 保持关闭；源码存在、fixture 通过或 npm 打包成功都不能当作生产验收。

当前 PC／Android 冻结候选仍为 0.3.0、200,430 字节、SHA-256 `4f3657730459197835a014b7f7433b44cc652e5b32480cdb37c061b160e75bf2`，其归档缺少完整 MIT 许可文件。根 `LICENSE` 已补齐；重新冻结需要检查实际归档成员并同步双端 pin。公开源码提交本身不发布新插件包、tag 或 feed。Android 0.1.25 已发布的包不得覆盖；新冻结及生产修改进入后续 0.1.26／code27。

以下 0.2.0 内容是历史验收边界。历史上停止 Android 修改的通知仅描述当时工作分工，不限制现已授权的移动端接入；真实新验收仍由宿主的交接与日志证明。

## 服务端契约验证

服务端仓库 `Dafeiyu-GO-Aries` 已由服务端工作流完成以下能力：申请列表与详情公钥、当前小组成员公钥、设备 heartbeat、当前小组 presence、文件缓存统计和带 `Idempotency-Key` 的批量缓存清理。服务端报告的验证结果为：

```text
go test ./...     PASS
go vet ./...      PASS
go test ./internal/kernel -run 'Test(ApplicationList|DeviceHeartbeat|GroupPresence|FileCache)' -count=1   PASS
```

插件没有修改 Aries 仓库，也不直接调用上述 HTTP 接口。插件只通过 `dafeiyu-go.connection.v1` 的高层 Provider 使用这些能力。

## 插件侧集成状态

2026-10-11，版本 0.2.0 已提供实际运行时与本地 IPC。PC 启动器已实现安全 named pipe 和高层 Provider dispatch；插件通过环境变量或 DSH_HOME descriptor 自动发现。主线程报告 PC 真实 Node E2E 28 PASS，该结果独立于本仓库 fixture 回归。

- 实际 DSH 宿主使用 Cordis `apply(ctx)`、`inject = ['commands']` 和 `ctx.commands.register`，入口为 `/connection` 加子命令。
- PC transport 使用单请求 newline UTF-8 JSON、1 MiB 请求/2 MiB 响应、60 秒上限、取消、descriptor 重发现和禁止已发送 mutation 重放。
- 文件 bytes 在 JSON wire 上为标准 base64，高层 Provider/同步引擎使用 Uint8Array。
- 运行时已接入持久队列、同步暂停/恢复、实际 conflicts/history、消息轮询、原生偏好 2 秒监测；root 必须由用户显式选择。
- 无 endpoint 或 provider 的宿主仍返回 launcher_unavailable；这是缺失运行条件的保护，不代表 IPC 尚未实现。

Android bridge 当前源码使用 abstract LocalServerSocket、同 UID/绑定 Node PID、capability、generation 和每请求 nonce。共享包支持环境变量 DAFEIYU_CONNECTION_SOCKET、DAFEIYU_CONNECTION_CAPABILITY、DAFEIYU_CONNECTION_GENERATION 自动发现，也支持事先 ctx.provide('connectionProvider', provider) 或 ctx.provide('connectionTransport', transport)。scope 方法必须携带 group_id，原生端比较当前选定 group；禁止跨组而不是禁止字段本身。

PC 与 Android 均使用 success/request_id/data 或 success:false/error_code/message；不接受 ok-only envelope。Android bytes 使用标准 base64，不将 Aries 加密 envelope 的 base64url 编码混入文件 wire。

插件基线为 34 项，新增 runtime/PC transport 22 项、Android transport 4 项；Android wire 测试在 Windows socket fixture 上验证协议，并非 Android 真机 abstract socket 或 Aries 双端 E2E。实际 APK 启动桥接、bindRuntime(pid)、子进程环境注入和 Node abstract socket 支持需要移动端验收；不可仅安装 tgz 就宣称手机可用。

官方 CLI 隔离安装、实际宿主加载、最终 npm test/build/check/pack 和 tgz 哈希以 Temp/Runtime-20261011/FINAL-REPORT.md 为准。详细接口见 runtime-020.md。插件不直接调用 Aries HTTP；真实配对、TLS、密码学、identity 与密钥仍由原生 Provider 承担。

本仓库已使用已安装的官方 DSH 0.2.1-alpha.1 CLI，在独立 DSH_HOME/profile 内离线安装本地 0.2.0 tgz；CLI 自动激活 bundle，安装后的 74 个文件与包输入逐字节一致。官方 app-boot/profile Loader 实际加载安装后的插件，并通过真实 commands 服务执行 `/connection status` 与 `/connection sync pause`。无 endpoint 时返回 waiting_for_launcher，暂停返回 paused；该验收未注入 mock Provider，也未加载真实身份、模型或网络服务。完整桌面应用和生产 C# pipe 的真实链路由主线程另行验证。

按用户最新范围，停止 Android 后续实现与测试，不修改 Mobile 仓库或设备。保留同一包的可注入 Provider/transport 与已有 bridge 协议设计；先前 Windows fixture 的 4 项结果不视为手机验收。手机负责人由主线程通过通知文档交接。


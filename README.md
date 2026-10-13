# Dafeiyu-Go Connect Plugin

Dafeiyu-GO / DSH-Aries 的设备连接扩展插件，供 PC 和 Android 宿主使用同一份代码及冻结包。插件只调用启动器提供的高层 `ConnectionProvider`，协议为 `dafeiyu-go.connection.v1`；设备身份、配对、TLS 和内容加密由原生宿主管理。

当前源码版本为 **0.3.0 候选**，包含远程任务、工作区信息、模型目录、设置适配、网页隧道和文件传输协议。源码公开不代表这些能力已经通过双端端到端验收。同步和广播默认关闭；网页、产物、附件及归档永久删除仍按真实宿主能力和权限门控，未通过验收的生产 gate 保持关闭。没有可用 endpoint 或注入 provider 时返回 `waiting_for_launcher` / `launcher_unavailable`，不会伪造连接状态、远端在线状态或操作成功。

公开源码仓库：[YunxiRamito/Dafeiyu-GO-Connect-Plugin](https://github.com/YunxiRamito/Dafeiyu-GO-Connect-Plugin)。项目代码采用 [MIT](LICENSE)，第三方依赖与宿主组件保留各自许可证。验收与冻结边界见 [集成状态](docs/integration-status.md)。

## 目录

- `src/framework/`：插件配置、权限、IPC envelope、Provider 契约、命令注册和错误状态。
- `src/sync/`：工作区路径过滤、敏感文件拒绝、哈希、分块/断点续传、队列、冲突和缓存清理。
- `src/broadcast/`：网页 URL 脱敏、payload 安全检查、发送/接收去重和通知控制。
- `src/framework/remote-*.ts`：远程任务、工作区生命周期、公开活动、归档、产物、附件和 HTTP／WebSocket 适配。
- `lib/`：从 TypeScript 源码生成的 JavaScript 运行时，随源码提交。
- `docs/contract.md`：启动器 IPC/ConnectionProvider 契约和必需方法。
- `docs/sync-protocol.md`：工作区同步协议。
- `docs/cache-cleanup.md`：文件缓存清理行为。
- `docs/security.md`：权限边界和安全约束。`docs/integration-status.md`：Aries 服务端和本地 Provider 集成状态。

## 开发与验证

测试和构建需要支持 TypeScript strip-types 及 `node:module.stripTypeScriptTypes` 的 Node.js，建议 Node.js 24 LTS。`package.json` 的宿主最低版本声明保留为 22.6；该声明不表示每个旧 Node 版本都能执行源码构建。项目没有需要在线安装的运行依赖；测试使用 Node 内置 test runner。

```powershell
npm test
npm run check
npm run build
```

本项目的本地测试、安装目录、缓存、压缩包和日志不进入 Git。工作站上的临时产物放在 G 盘指定 QA 目录；请把 npm cache、临时目录和命令输出指向该目录。插件不保存 Aries 私钥、内容密钥、token 或 cookie；同步仅写入用户显式选择的工作区。不要把配对身份或真实运行目录加入仓库。

## DSH 插件安装

`package.json` 使用 DSH profile bundle 的 `cordis.patch.yml` 入口；`lib/` 是从 `src/` 生成的零依赖运行时副本。插件本身不会创建设备身份、调用 Aries 原始 HTTP 管理 API 或实现配对流程。PC 自动发现安全 IPC；Android 由宿主注入 bridge 启动环境或高层 Provider。实际命令入口是 `/connection`。

详细边界和必需 IPC 方法见 [docs/contract.md](docs/contract.md)。

## 冻结与发布

PC 与 Android 必须使用版本、字节数、SHA-256 完全一致的冻结包。当前宿主 pin 仍为 200,430 字节、SHA-256 `4f3657730459197835a014b7f7433b44cc652e5b32480cdb37c061b160e75bf2` 的 0.3.0 候选；该历史归档没有包含根 MIT `LICENSE`。源码已补齐完整许可，后续重新打包必须核验归档含 `package/LICENSE`，并由发布负责人同时更新双端 pin。

公开源码提交不会替换已发布 Android 0.1.25 的安装包或冻结包。重新冻结及宿主生产改动应进入后续 Android 0.1.26／code27。通过完整许可检查、双端摘要一致及必要生产 gate 验收前，不创建插件 tag、GitHub Release 或在线 feed 发布。


# Dafeiyu-Go Connect Plugin

Dafeiyu-GO / DSH-Aries 的设备连接扩展插件，供 PC 和 Android 宿主使用同一份代码及冻结包。插件只调用启动器提供的高层 `ConnectionProvider`，协议为 `dafeiyu-go.connection.v1`；设备身份、配对、TLS 和内容加密由原生宿主管理。

当前源码版本为 **0.3.1 本地候选**，连接默认共享电脑 DSH 的工作区、对话与网页。工作区共享调用实际 DSH registry/session 服务，不扫描或复制工作区目录文件。网页能力必须通过本机认证首页读取和实际 Gateway 服务检查；服务未就绪时等待，不能只凭配置伪造可用。产物、附件及归档永久删除继续保留各自验证门控。没有可用 endpoint 或注入 provider 时返回 `waiting_for_launcher` / `launcher_unavailable`，不会伪造连接状态、远端在线状态或操作成功。

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

本项目的本地测试、安装目录、缓存、压缩包和日志不进入 Git。工作站上的临时产物放在 G 盘指定 QA 目录；请把 npm cache、临时目录和命令输出指向该目录。插件不持久保存 Aries 私钥、内容密钥、token 或 cookie；DSH 共享不自动下载工作区文件。可选文件传输 API 仅在显式 `kind: files` 和选定 root 时启用。不要把配对身份或真实运行目录加入仓库。

## DSH 插件安装

`package.json` 使用 DSH profile bundle 的 `cordis.patch.yml` 入口；`lib/` 是从 `src/` 生成的零依赖运行时副本。插件本身不会创建设备身份、调用 Aries 原始 HTTP 管理 API 或实现配对流程。PC 自动发现安全 IPC；Android 由宿主注入 bridge 启动环境或高层 Provider。实际命令入口是 `/connection`。

详细边界和必需 IPC 方法见 [docs/contract.md](docs/contract.md)。

## 冻结与发布

PC 与 Android 必须使用版本、字节数、SHA-256 完全一致的冻结包。0.3.1 必须重新冻结并同步双端 pin，不能用相同 0.3.0 版本覆盖旧候选；包清单明确包含 `LICENSE`，冻结后核验实际 `package/LICENSE`。历史 0.3.0 候选 200,430 字节／`4f3657730459197835a014b7f7433b44cc652e5b32480cdb37c061b160e75bf2` 保留作旧证据。

本地修复不会替换已发布 Android 安装包或线上 feed；正式发布、设备安装和跨端公网验收必须另有真实证据。


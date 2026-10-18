# Dafeiyu-Go Connection Provider Contract v1

## 范围与边界

协议名称为 `dafeiyu-go.connection.v1`。插件只消费启动器提供的高层 `ConnectionProvider`，只使用当前已配对关系和当前小组上下文。Aries 是通用多人小组模型；本协议不增加、不推断、不强制 `max_members`，也不假设小组只有两名成员。插件不扫描、切换或管理其他小组。

启动器继续负责设备身份、Aries 签名、DPAPI 私钥、admin/device token、内容密钥、加解密、key-delivery、配对流程、原始 HTTP、重试和连接恢复。插件不创建身份，不生成或保存密钥，不读取 token/cookie，不调用 Aries 原始管理接口。

## 本地 IPC 与 Provider

IPC 应使用现有安全本地通道，例如 Windows Named Pipe 或启动器已有 RPC，只允许当前用户访问，不监听公网端口。每个请求的 envelope 是：

```json
{
  "protocol": "dafeiyu-go.connection.v1",
  "request_id": "req_...",
  "method": "get_connection_state",
  "params": {}
}
```

响应必须包含 `success`、`request_id`，失败时还必须包含 `error_code` 和用户可读 `message`。请求支持 timeout、cancel、retry 和 reconnect。日志不得写入私钥、内容密钥、token、cookie 或完整密文。

启动器需要实现 `LauncherConnectionProvider` 的方法：

- `get_connection_state`、`subscribe_connection_state`
- `send_encrypted_message`、`list_incoming_messages`、`acknowledge_message`
- `create_file_transfer`、`upload_file_chunk`、`complete_file_transfer`
- `list_incoming_file_transfers`、`download_file_chunk`、`acknowledge_file_transfer`
- `get_group_file_cache_stats`、`cleanup_group_file_cache`

文件方法始终带当前 `group_id`。插件只传业务数据和当前小组上下文，不能传入 Aries 签名、私钥、token、content-key、rotation epoch 或原始 HTTP 参数。

## 连接状态与错误

状态至少包含：

```json
{
  "protocol": "dafeiyu-go.connection.v1",
  "server_connected": true,
  "group_id": "grp_...",
  "pairing_status": "paired",
  "local_device": { "id": "dev_...", "name": "电脑", "public_key": "..." },
  "remote_device": {
    "id": "dev_...", "name": "手机", "public_key": "...",
    "online": "online",
    "last_seen_at": "2026-10-11T00:00:00Z"
  },
  "capabilities": {
    "workspace_sync": true,
    "web_broadcast": true,
    "encrypted_messages": true,
    "encrypted_files": true,
    "presence": true,
    "file_cache_cleanup": true
  }
}
```

`remote_device.online` 只能来源于 Aries presence 或启动器明确转换后的状态。`server_connected: true` 只表示服务连接可用，不代表远端在线。服务不可达、心跳过期、Aries 重启清空 presence 或远端设备信息缺失时，插件使用 `unknown`；只有启动器确认无有效心跳时才使用 `offline`。

框架使用以下错误码：`launcher_unavailable`、`connection_unavailable`、`pairing_incomplete`、`presence_unknown`、`remote_offline`、`revoked`、`permission_denied`、`transport_unavailable`、`tls_failure`、`request_timeout`、`request_cancelled`、`disk_space_low`、`conflict`、`retry_exhausted`、`cache_cleanup_partial`、`cache_cleanup_pending` 和 `protocol_error`。

产品状态映射如下：

| 条件 | 状态 |
| --- | --- |
| 没有可用的 IPC endpoint 或注入 Provider | `waiting_for_launcher` |
| 服务不可达、未配对或已撤销 | `waiting_for_connection` |
| presence 为 unknown 或远端 offline | `unknown` |
| 当前连接上下文有效 | `completed` |

`completed` 只表示连接上下文可用，不代表某个文件任务已完成。缺少可用 IPC/Provider 时绝不显示“已连接”或“同步成功”。

## 权限清单

插件只请求高层权限：

- `connection.read`、`connection.state.subscribe`
- `connection.message.send`、`connection.message.read`
- `connection.file.transfer`
- `connection.file.cache.read`、`connection.file.cache.cleanup`
- `workspace.read`、`workspace.write`
- `broadcast.send`、`broadcast.receive`

代码中明确拒绝创建设备身份、读取私钥/内容密钥/token、直接 Aries HTTP、配对管理、建组、邀请、成员撤销、角色修改、密钥轮换和伪造 presence。

## 工作区同步契约

连接默认使用 DSH 语义。原生偏好 schema2 为：

```json
{
  "schema_version": 2,
  "workspace_sync": { "enabled": true, "kind": "dsh", "dsh_home": "G:/actual-dsh-home" },
  "web_broadcast": { "enabled": true }
}
```

`dsh_home` 必须等于宿主传入的实际 `DSH_HOME`，只用于标识同一 DSH 环境，不作为文件 root。插件通过 `workspaceRegistry.list`、`sessionController.list/follow/control` 分享工作区和对话，通过有界公开投影去除凭据与私有重放上下文；远端使用独立接收状态。旧 schema1 的任意 root 和关闭开关迁移为默认 DSH 共享，不读取旧 root。

以下文件传输契约只供显式 `workspaceSync.kind: files` 的兼容 API 使用，不属于默认连接行为。只同步明确选择的 root，不扫描其他磁盘。路径必须经过 `decideSyncPath`；越出 root、命中 ignore rule、`.key/.pem/.p12/.pfx/.env`、token/cookie/credential/secret/password/auth 路径均拒绝。上传使用相对文件标识，不能上传完整绝对路径。

元数据通过启动器加密消息传输，文件内容通过启动器加密 resumable file-transfer 传输。大文件分块，一个文件的并发操作串行，队列和并发数有限制，文件事件需 debounce。上传完成必须以 Provider 确认作为事实。接收端应使用临时文件、hash 校验和原子替换，不能静默覆盖本地修改。冲突策略为 `ask`、`keep_local`、`keep_remote` 或 `keep_both`，默认 `ask`。

同步状态至少包括 `disabled`、`waiting_for_launcher`、`waiting_for_connection`、`syncing`、`paused`、`conflict`、`failed`、`completed` 和 `unknown`。中断恢复使用 transfer id 与已确认 chunk，不改变原文件；取消和失败都必须可恢复。

## 网页广播契约

连接默认广播 DSH 网页：真实本机 webServer 端口、authenticatedUrl、Gateway invoke/wireStream 与事件源齐备，并通过认证首页 200 HTML 读取后，才广告 `remote_web_tunnel`。广告每 15 秒刷新；服务缺失时撤回能力。手机只接受当前已配对电脑的认证广告，经本机 loopback proxy 展示网页；不会传播上游 token 或 cookie。下列安全链接消息保留为额外兼容命令，不代替 DSH 网页隧道。

payload 只包含安全网页信息：

```json
{
  "kind": "dsh_web_broadcast",
  "url": "https://example.com/page",
  "title": "页面标题",
  "selection": "用户明确选择的文本",
  "message": "可选说明",
  "sender_device_id": "dev_...",
  "created_at": "2026-10-11T00:00:00Z"
}
```

默认只允许 HTTPS；本地 DSH HTTP 必须显式开启且仅允许 loopback。发送前移除 URL 用户信息、token、cookie、Authorization、API key、signature、session、password、secret、key 等敏感 query 和 fragment。不能发送 cookie、Authorization、API key、token、签名、session、localStorage/sessionStorage、完整 DOM 或浏览器登录态。广播文本出现凭据模式时拒绝发送。

接收内容作为纯文本处理，去除 HTML/脚本标记；不得执行远端脚本、HTML 或浏览器命令。接收端默认只显示通知，用户点击后才打开链接。`MessageDeduplicator` 按 message id 去重；静音、暂停接收和清空历史由上层 UI 控制。

## 文件缓存清理

`get_group_file_cache_stats` 只读取当前 group 的 `uploading`、`available`、`cleanup_pending`、`logical_deleted` 和 `physical_bytes`。`cleanup_group_file_cache` 每批最多 100 个 file id，必须带当前 `group_id` 和稳定的 `Idempotency-Key`。相同批次重试必须重用同一个键，不能重复生成逻辑删除。

普通成员只能清理自己发送的文件，creator/admin 的范围由启动器按当前小组权限判断。启动器必须拒绝跨组、未知和无权限 file id，并保护成员关系、key-delivery、轮换事件和普通消息。结果必须区分逻辑删除已提交、物理文件已清除和仍等待物理清理。

## 命令注册入口

0.2.0 通过真实 DSH Cordis 的 ctx.commands.register 注册单词命令 connection；用户调用 `/connection status`、`/connection sync pause` 等。以下多词名称是框架内部路由标识，由宿主适配器转换，不是另一套 CLI：

- `dsh connection status`
- `dsh connection sync enable|disable|set-root|pause|resume`
- `dsh connection broadcast enable|disable|mute|resume`

`cache`、`cache-clean`、`broadcast send`、`conflicts`、`broadcast history` 和 `broadcast clear-history` 已接入实际运行时。暂停/恢复操作持久队列，history 为内存中当前小组接收记录，conflicts 为持久状态。框架不创建第二套 CLI，也不绕过 `DshPluginCliService`。

## 原生 Provider 必需 IPC 方法

PC 已实现下列 dispatch 与插件 transport；Android 同包使用安全本地 bridge。原生实现必须持续满足：

1. 当前 connection/group/member/presence snapshot，并明确区分 server connected 与 remote online。
2. 当前小组加密消息收发和 acknowledgement。
3. 当前小组加密分块文件传输、断点续传、下载和 acknowledgement。
4. 当前小组 file cache stats 与带 Idempotency-Key 的最多 100 项 cleanup。
5. 每个请求的 request id、timeout、cancel、retry/reconnect 语义。
6. 当前用户限定的本地 IPC ACL 与 capability response。

以上能力由启动器通过 `AriesConnectionService` 提供；插件不复制启动器的 DPAPI 或 Aries 实现。


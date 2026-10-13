# 工作区同步与网页广播协议

## 范围和边界

本目录实现的是离线可测试的同步核心。插件只依赖启动器提供的高层 `ConnectionProvider`，不读取 Aries 私钥、内容密钥、DPAPI 文件、token、cookie 或原始 HTTP 参数。Provider 是 `src/sync/types.ts` 中的 TypeScript 类型契约；启动器尚未提供真实 IPC 时，插件必须显示接口不可用，不得伪造“已连接”或“同步成功”。

Aries 小组是任意数量的活跃成员。每次请求都带当前 `groupId`，上传目标从 Provider 返回的全部活跃成员计算，排除本机设备；代码不设置、不推断 `max_members`，也不扫描或切换其他小组。

当前启动器源码中的 `AriesConnectionService` 是内部 C# 服务，负责设备身份、签名、心跳、配对、加密和原始 Aries 请求。它当前仍含有“两人配对展示”的产品限制，插件不会复制该限制，也不会修改启动器或 Aries 仓库。

## Provider 契约

Provider 至少需要实现：

- `getConnectionState`：返回 `serverConnected`、当前 `groupId`、`pairingStatus`、完整 `members`、`remotePresence` 和 capabilities。
- `createFileTransfer`、`uploadFileChunk`、`completeFileTransfer`：对应 Aries 分块文件传输高层操作。
- `listIncomingFileTransfers`、`downloadFileChunk`、`acknowledgeFileTransfer`：接收和确认文件。
- `getGroupFileCacheStats`、`cleanupGroupFileCache`：只操作当前小组的缓存。
- 可选的 `listRemoteFiles` 和 `sendEncryptedMessage`：用于启动器后续提供远端清单和加密广播消息。

所有请求只传业务字段和当前 `groupId`。Provider 自己负责 IPC 超时、取消、重连、签名、TLS、token 和密钥保护。禁止把 `Authorization`、签名头、admin token 或原始 HTTP 路由传进插件。

状态必须分开显示：

| 状态 | 含义 |
| --- | --- |
| `serverConnected=false` | 启动器或 Aries 连接不可用；不能据此判断远端设备 offline。 |
| `pairingStatus=unpaired/awaiting_approval` | 没有完成的当前配对关系；同步被拒绝。 |
| `remotePresence=online` | 仅表示 Aries presence 给出有效在线状态。 |
| `remotePresence=offline` | presence 明确报告心跳过期或离线。 |
| `remotePresence=unknown` | 服务重启、没有最近心跳或 Provider 无法转换状态。 |
| `connection_unavailable` | 启动器连接不可用，远端在线状态不作推断。 |

## 配置和路径规则

`workspaceSync` 默认关闭：

```ts
{
  enabled: false,
  root: "<workspace>",
  mode: "manual",
  conflictPolicy: "ask",
  ignoreRules: ["node_modules", ".git", ".cache", "dist", "build", "*.log", "*.tmp", "secrets", "*.key", "*.pem", "*.p12", "*.pfx", ".env", ".env.*", "cookies", "tokens", "credentials"],
  chunkSizeBytes: 1048576,
  maxRetries: 3,
  retryDelayMs: 250
}
```

路径必须是工作区根下的相对路径。绝对路径、盘符路径、`..` 越界路径和空路径被拒绝。敏感文件即使没有写入 `ignoreRules` 也拒绝，包括 token、cookie、credentials、`.env*`、密钥和证书扩展名（`.key`、`.pem`、`.p12`、`.pfx`）。

## 文件同步状态机

上传队列项持久化 `groupId`、相对路径、SHA-256、大小、分块大小、已确认分块、`fileId`、重试次数和状态：

`queued → creating → uploading → completed`

异常时进入 `retry_wait`、`paused` 或 `failed`；用户取消进入 `cancelled`。重试使用指数退避，同一创建请求、分块请求和完成请求分别保持稳定的幂等键。服务端返回已收分块后，插件只上传缺失索引，支持插件或 DSH 重启恢复。

每次恢复队列或调用 Provider 前检查当前 `groupId`。小组变化会停止旧队列，旧队列不能发送到新小组。磁盘空间不足使用 `disk_space_insufficient` 明确失败并保留队列记录。取消使用 `AbortSignal`，不会把取消当作成功。

删除和重命名在同步计划中是显式操作。相同 SHA-256 的本地删除与新增可以合并为 rename；内容同时改变时按 `ask`、`prefer-local`、`prefer-remote` 或 `keep-both` 产生冲突结果。实际删除必须通过安全的工作区根路径解析。

## 网页广播

`createBroadcastPayload` 只接受标题、URL 和用户明确选择的文本。默认只允许 HTTPS；loopback HTTP 必须显式启用。URL 会清除用户名、密码和 `token`、`session`、`cookie`、`Authorization`、`api_key`、签名、secret、password 等查询参数。标题和选中文本会转成纯文本并限制长度。接收端只应显示通知，用户点击后才打开 URL；远端内容不得执行脚本、HTML 或浏览器命令。

广播 payload 只有 `messageId`、`groupId`、来源设备、时间、标题、脱敏 URL 和可选纯文本。接收端用 `BroadcastDeduplicator` 去重；静音、暂停接收、历史清空属于上层 UI 行为。广播失败不得阻塞工作区同步。

## 错误语义

核心使用稳定错误码：`launcher_ipc_unavailable`、`launcher_not_connected`、`pairing_incomplete`、`group_changed`、`path_rejected`、`invalid_path`、`hash_mismatch`、`cancelled`、`disk_space_insufficient`、`queue_persist_failed`、`cleanup_batch_too_large`、`cleanup_permission_denied`（由 Provider 返回）、`invalid_broadcast_url` 和 `unsafe_broadcast_payload`。可重试错误标记 `retryable=true`；错误信息不得包含 token、密钥、cookie、完整密文或用户文件内容。

## 启动器待补充的 IPC 方法

IPC 名称应为 `dafeiyu-go.connection.v1`，只允许当前用户通过已有本地安全通道访问，不监听公网端口。启动器需要把下列高层方法映射到 `AriesConnectionService` 或等价内部服务：

- `get_connection_state`、`subscribe_connection_state`
- `create_file_transfer`、`upload_file_chunk`、`complete_file_transfer`
- `list_incoming_file_transfers`、`download_file_chunk`、`acknowledge_file_transfer`
- `get_group_file_cache_stats`、`cleanup_group_file_cache`
- 可选：`list_remote_files`、`send_encrypted_message`

每个请求需要 `request_id`、超时和取消；每个响应包含 `success`、`error_code`、`message`。启动器必须把成员列表和 presence 原样转换为 Provider 数据，不能把 `server_connected` 映射成 `remote_device.online`。

离线测试命令：

```text
node --experimental-strip-types --test tests/sync/*.test.ts
```

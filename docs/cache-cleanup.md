# 文件缓存清理行为

## 范围

缓存清理只使用启动器高层 `cleanupGroupFileCache`，不直接调用 Aries HTTP。请求必须带当前 `groupId`、不超过 100 个 `fileId` 和稳定的 `Idempotency-Key`。插件不清理其他小组，也不清理控制事件、成员关系、设备身份、key-delivery 或普通消息。

## 批次和幂等

`cacheCleanupIdempotencyKey(groupId, fileIds)` 会先去重、排序，再对 `groupId` 和 file ID 列表做 SHA-256。相同小组和相同文件集合重试时复用同一个 key；换小组或换文件集合会得到不同 key。网络超时、连接重置和 Provider 标记的可重试错误可以重试，但不能为同一批次生成新 key。

超过 100 个文件必须分批。插件不会把统计计数当成 file ID，也不会从其他组拼接 ID。当前组变化、当前配对失效或启动器连接不可用时，清理立即停止。

## 权限和状态

Aries 先提交逻辑 tombstone，再尝试物理清除 blob 和上传分块。Provider 返回的结果需要保留以下差异：

| 字段 | 含义 |
| --- | --- |
| `logicalDeleted` | 本批次中新提交的逻辑删除记录数量。 |
| `alreadyDeleted` | 已有 tombstone，本次幂等重放没有重复生成逻辑删除。 |
| `cleanupPending` | tombstone 已存在，但物理文件仍等待后台清理或重试。 |
| `physicalCleanupComplete` | 本批次物理文件清理已完成；不代表其他批次完成。 |
| `requested` | 本次请求中的去重后 file ID 数量。 |

普通成员只能清理自己发送的 transfer；creator/admin 才能清理当前小组允许的其他 transfer。权限错误必须展示为权限错误并保留可重试的其他队列项，不能通过降权请求绕过检查。跨组、未知或无权限 file ID 按 Aries 契约整批拒绝时，插件不得拆分或猜测有效项。

物理删除失败不回滚逻辑 tombstone。下一次清理或服务端后台 worker 可以继续物理清理，重复请求必须返回 `alreadyDeleted` 或 `cleanupPending`，而不是再创建一条逻辑删除记录。

## 与启动器现有服务的关系

启动器当前 `AriesConnectionService.ClearPairCacheAsync` 负责连接、成员检查和删除请求，但它是内部服务并且 UI 层仍有两人配对限制。插件只依赖本文类型抽象；启动器需要通过 `dafeiyu-go.connection.v1` 暴露当前小组范围的统计和批量清理方法。实现缺失时应返回 `cleanup_unsupported` 或 `launcher_ipc_unavailable`，不能显示清理成功。

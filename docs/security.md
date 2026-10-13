# 安全与权限说明

## 信任边界

插件运行在 DSH 插件进程内，只接收启动器提供的当前配对和当前 `group_id` 上下文。启动器负责设备身份、Aries 签名、DPAPI 私钥、admin/device token、内容密钥、加解密、key-delivery、重试和连接恢复。

插件没有设备身份、私钥、内容密钥、token、cookie 或 Aries 原始 HTTP 客户端。插件只向 `ConnectionProvider` 传递业务数据、相对路径、哈希、分块和当前小组 ID。

## 请求权限

插件只请求以下高层权限：

- `connection.read`、`connection.state.subscribe`
- `connection.message.send`、`connection.message.read`
- `connection.file.transfer`
- `connection.file.cache.read`、`connection.file.cache.cleanup`
- `workspace.read`、`workspace.write`
- `broadcast.send`、`broadcast.receive`

权限清单位于 `src/framework/permissions.ts`。缺少权限时操作失败并返回明确错误。

## 明确禁止

插件禁止创建设备身份、生成或保存 Aries 私钥、读取或复制 DPAPI 私钥、生成或保存内容密钥、管理小组、发送邀请、审批申请、撤销成员、修改角色、执行密钥轮换、直接调用 Aries HTTP 管理接口、扫描其他小组和伪造 presence。

## 工作区保护

同步只处理用户明确选择的 root。路径必须在 root 内，`.key`、`.pem`、`.p12`、`.pfx`、`.env`、token、cookie、credential、secret、password、auth 等敏感路径默认拒绝。远端文件标识只使用相对路径和哈希，不上传完整绝对路径。

远端文件写入必须经过哈希校验和临时文件/原子替换流程，冲突遵循配置策略，不静默覆盖本地修改。文件缓存清理只接受当前 group 的 file ID，每批最多 100 个，并使用稳定的 `Idempotency-Key`。

## 网页广播保护

网页广播默认关闭。默认只允许 HTTPS；本地 DSH HTTP 地址必须由用户显式开启并且只能是 loopback。URL 会删除用户信息、fragment 和敏感 query。payload 深层字段会拒绝 cookie、Authorization、API key、token、session、签名、私钥、内容密钥和命令字段。

接收端把远端内容作为纯文本通知处理，不执行脚本、HTML 或浏览器命令；打开链接必须由用户点击。发送失败返回结果并触发错误回调，不阻塞 DSH 主流程。

## 日志与持久化

日志和队列状态不得包含私钥、内容密钥、token、cookie、完整密文、完整 DOM 或完整网页内容。持久化队列只保存恢复传输所需的相对路径、哈希、transfer/file ID、已确认分块和错误状态。

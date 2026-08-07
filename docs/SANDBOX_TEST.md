# 沙箱真平台实测清单（拿到 AppID/Secret 后按顺序走）

> 目标：验证 pi-qq-bridge 与 QQ 官方沙箱环境的真实连通性。
> 全部测试在本地 mock 平台已验证（真实 WS 协议），本清单只覆盖 mock 验证不了的真实环境差异点。
> 预计耗时：30–40 分钟。

---

## 0. 前置（一次性的）

1. 沙箱 AppID/Secret 已从 [q.qq.com](https://q.qq.com) 管理端获取
2. **测试 QQ 号已加入沙箱成员白名单**（管理端 → 沙箱配置；不加的话消息推不到机器人）
3. 配置文件就绪：

```bash
cp /home/lizhi/qqbot/pi-qq-bridge.json.example ~/.pi/agent/pi-qq-bridge.json
chmod 600 ~/.pi/agent/pi-qq-bridge.json
# 编辑填入 appId / clientSecret，sandbox 保持 true
```

1. pi 里加载扩展：`/reload`（首次使用需在 settings.json 启用扩展或直接 `pi -e /home/lizhi/qqbot/src/index.ts`）

---

## 1. 启动与连接（5 分钟）

| # | 操作 | 预期 | 失败排查 |
| --- | ------ | ------ | ---------- |
| 1.1 | pi 终端 `/qqbot-start` | notify "QQ 网关已连接" | 报 token 失败 → 检查 appId/clientSecret 是否复制错；报"另一 Pi 实例"→ 删陈旧锁 `rm ~/.pi/agent/pi-qq-bridge.lock` |
| 1.2 | `/qqbot-status` | 网关 **connected**，配置 schemaVersion 4 | connected 但马上变 error → 看 info 字段（重连次数/原因） |
| 1.3 | 等 2 分钟再看 `/qqbot-status` | 仍 connected（心跳正常） | 掉线 → 查看日志输出中的重连提示 |

**风险点**：token 端点域名（`bots.qq.com`）与 WS 网关域名（沙箱 `sandbox.api.sgroup.qq.com`）的连通性——公司网络/代理可能拦截。

---

## 2. 文本私聊闭环（10 分钟）

| # | 操作 | 预期 | 失败排查 |
| --- | ------ | ------ | ---------- |
| 2.1 | 测试 QQ 给机器人发"你好" | 终端 TUI 视图出现入站记录；QQ 收到回复 | 无反应 → 确认测试号在沙箱白名单；终端无记录 → WS 事件未到（回 1.3） |
| 2.2 | 发"查看当前目录文件" | pi 执行 ls 类工具并回复结果 | 回复"模型服务认证失败" → 检查 pi 的模型配置（`/model`） |
| 2.3 | 发 `/status` | 返回会话/模型/队列/网关状态 | 无权限提示 → 先把你的 openid 加入 allowUsers（见 2.4） |
| 2.4 | **首次授权**：allowUsers 留空时，发消息 → 终端出现申请码 → `/qqbot-approve <码> user` | 回复"已批准"，再发消息正常处理 | 申请码流程是**私聊**专属；确认用的是私聊不是群 |

**风险点**：被动回复的 `msg_id` 语义——如果回复失败（`QQApiError` 出现在日志），贴出来。

---

## 3. 命令与权限（5 分钟）

| # | 操作 | 预期 |
| --- | ------ | ------ |
| 3.1 | `/help` | 命令菜单（含键盘按钮则更好） |
| 3.2 | `/model` | 模型列表分页 |
| 3.3 | `/new 测试` | 新建会话提示 |
| 3.4 | 未加入 admins 时发 `/new` | 权限拒绝提示（预期行为） |

---

## 4. 多媒体入站（10 分钟）

| # | 操作 | 预期 | 风险点 |
| --- | ------ | ------ | -------- |
| 4.1 | 发一张图片 | 视觉模型描述图片（当前模型需支持 image 输入） | 附件 URL 可能是 QQ 私有云域名——若被 SSRF 校验拦截，`/qqbot-status` 或日志会显示 `ssrf_blocked`，需要把该域名加入下载白名单（当前实现是 DNS 公网校验，若 QQ 附件域名解析为公网 IP 则不会拦） |
| 4.2 | 发一条语音 | 回复语音转写文本（QQ ASR） | 沙箱可能不推语音事件 → 现象是"无反应"，属平台限制 |
| 4.3 | 发一个 .txt 文件 | 回复文件内容摘要 | 沙箱文件事件可能不推送 |

---

## 5. 出站媒体（5 分钟，可选）

| # | 操作 | 预期 | 前置 |
| --- | ------ | ------ | ------ |
| 5.1 | 配置 `outboundMedia.enabled: true` + 重启 | — | 先把你加入 `commands.admins` |
| 5.2 | QQ 发"把 /tmp/test.png 发给我"（先放一张图到 /tmp） | 收到真实图片消息 | 文件必须在 OS tmp 或 allowedRoots 内 |
| 5.3 | 大文件（>5MB） | 走分片上传（`upload_prepare`→PUT→`upload_part_finish`） | **协议字段名以上线实测为准**——失败时把 QQApiError 的 status/code 贴出来 |

---

## 6. 群聊（5 分钟，可选）

| # | 操作 | 预期 |
|---|------|------|
| 6.1 | 把机器人拉进一个群（沙箱机器人需在沙箱配置中添加群） | 群里 @机器人 → 回复 |
| 6.2 | `allowGroups` 加入该群 openid | 授权后才能处理；群管理命令默认关闭（预期） |

---

## 收尾

- 全部通过 → 把 `sandbox: false` 切换正式环境（需在开放平台提审上线）
- 有任一失败 → 记录：操作 + 现象 + `/qqbot-status` 输出 + 日志中的 `QQApiError` 详情，贴给 pi-agent 排查

## 已知标注"以上线实测为准"的代码点

| 位置 | 内容 |
| ------ | ------ |
| `src/qq-api.ts` `uploadMediaChunked` | 分片协议字段名（upload_prepare / upload_part_finish 的请求响应结构） |
| `src/qq-gateway.ts` | Resume/op9 错误码行为（4009 等） |
| `src/router.ts` `isMarkdownRejected` | Markdown 被拒的错误特征判断（真实错误信息可能不同） |

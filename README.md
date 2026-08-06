# pi-qq-bridge

Pi × QQ 双向通信扩展（pi 官方 extension）。通过 QQ 官方机器人 API v2 实现私聊 + 群聊与本地 pi coding agent 双向通信，采用**隔离 AgentSession** 架构（每个 QQ 对话独立持久化会话，不污染本地 TUI 会话），支持 `/workspace` 工作区切换。

> 状态：**M0 完成**（2026-08-06）。骨架 + 配置 + auth + 网关连通性已实现并通过测试；沙箱真实连通需 AppID/Secret（见下）。
> 完整设计见 `E:\work\0806\2026-08-06-1812-pi-qq-bridge扩展架构设计spec.md`（schemaVersion 4）。

## 架构决策

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 会话模型 | 隔离 `createAgentSessionRuntime`（SDK） | 不污染本地会话；多用户/群聊隔离；已通过 spike 验证（pi 0.84） |
| 会话注册表 | 懒创建 + idleDisposeMs 30min 回收 + maxResident 8 | 低资源占用 |
| 多实例 | 单实例文件锁（M8 前） | QQ 同一 appId 只允许一个 WS 连接 |
| 出站媒体 | base64（≤5MiB）+ 分片（大文件）双通道 | QQ `/files` 的 file_data 有平台硬上限 |
| 回复格式 | QQ 原生 Markdown 优先，纯文本降级；语义分块 ≤4 块 × 3600B | 平台被动回复限制 |
| 命令 | QQ 白名单（`/help /status /last /model /thinking /new /sessions /resume /name /compact /stop /workspace`）+ 危险命令阻塞 | 0.82+ 无公开 input-dispatch API |

## 环境要求

- Pi `>=0.82.0 <1.0.0`（开发验证于 0.84.0）
- Node.js `>=22.19`（使用内置 WebSocket，**零运行时依赖**）
- QQ 开放平台机器人（沙箱/正式），启用 C2C 私聊与群 @ 消息

## 安装与配置

```bash
# 开发
npm install
npm test          # 78 个测试（config/auth/gateway/instance-guard）
npm run typecheck

# 使用：复制示例配置
cp pi-qq-bridge.json.example ~/.pi/agent/pi-qq-bridge.json
chmod 600 ~/.pi/agent/pi-qq-bridge.json
# 编辑填入 appId / clientSecret（sandbox: true 为沙箱环境）
```

配置 schemaVersion=4，**不兼容旧版本**（拒绝启动并提示重新生成，不静默迁移）。

## 本地 Pi 命令（M0/M1 已实现）

| 命令 | 作用 |
| --- | --- |
| `/qqbot-start` | 抢单实例锁 → 启动 QQ 网关（连接沙箱/正式） |
| `/qqbot-stop` | 停止网关 + 释放锁 |
| `/qqbot-status` | 网关状态 / 配置 / 运行信息 |
| `/qqbot-reconnect` | 强制重连（自动重连 5 次失败后使用） |

`startup.mode: "auto"` 时 pi 启动自动连接；网关为进程级运行时（`Symbol.for` 全局单例），`/reload` 后自动重挂不断线。

## 里程碑

| 阶段 | 状态 | 内容 |
| --- | --- | --- |
| M0 | ✅ | 骨架 + config + auth + gateway + 单实例锁 + 测试 |
| M1 | ✅ | 文本私聊闭环：inbound 归一化 → 隔离会话 → 被动回复；去重/回复预算/白名单 |
| M2 | ⏳ | 命令体系：状态机 TTL + 审批四件套 + Keyboard |
| M3 | ⏳ | 多媒体入站：图片/语音/文档 + STT/PDF |
| M4 | ⏳ | 群聊（GROUP_AT）+ allowGroups |
| M5 | ⏳ | `/workspace`：注册表 + 切换 + 会话隔离 |
| M6 | ⏳ | 出站媒体（base64/分片双通道）+ 分块回复 |
| M7 | ⏳ | 加固：host 契约/steering/安全审查 |
| M8 | ⏳ | 发布 npm pi package + README/CHANGELOG |

## 目录结构

```
src/
  index.ts            # 扩展入口：本地命令 + 生命周期
  config.ts           # schemaVersion 4 加载/校验/原子保存
  qq-auth.ts          # access token 管理（预刷新/熔断/白名单端点）
  qq-gateway.ts       # WS 网关（Hello/Identify/心跳/Resume/退避重连）
  instance-guard.ts   # 单实例锁（O_EXCL + pid 存活 + 陈旧恢复）
  types.ts            # 公共类型
test/
  mock-qq-server.ts   # 本地 mock QQ 平台（token/gateway/WS 协议）
  *.test.ts           # node:test 单测/冒烟
scripts/
  spike-sdk.ts        # createAgentSessionRuntime 可用性验证（M0 spike）
```

## 安全

- 配置含凭据：`chmod 600`，勿提交 Git
- 锁文件/配置路径仅 `~/.pi/agent/` 下
- token 端点主机白名单（防 SSRF）
- 双白名单（allowUsers/allowGroups）为空时扩展不处理任何真实入站消息（M1 生效）

## 待办（需要用户操作）

- [ ] QQ 开放平台申请沙箱 AppID/Secret，填入配置后验证 `/qqbot-status` 显示 connected（M0 验收）

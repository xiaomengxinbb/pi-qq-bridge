# Changelog

本项目的所有显著变更记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-08-07

首个正式发布。完整实现 Pi × QQ 双向通信（私聊 + 群聊），通过 QQ 官方机器人 API v2 接入，采用隔离 AgentSession 架构。

### 新增

- **核心闭环**：QQ 私聊/群聊文本 → 隔离 AgentSessionRuntime → LLM 处理 → 被动回复
  - 会话隔离：每个 QQ 对话独立持久化会话，不污染本地 TUI 会话
  - 递归防护：隔离会话加载宿主扩展时排除 pi-qq-bridge 自身
  - 消息去重（msg_id，2h TTL）+ 被动回复预算（每条消息 4 次配额）
  - progress ack（慢任务回执）+ showProcess 执行摘要
- **命令体系**：QQ 侧 `/help /status /last /model /thinking /new /sessions /resume /name /compact /stop /workspace`
  - 白名单 + 危险命令阻塞 + admin 授权矩阵
  - 命令状态机（selection/confirmation TTL）
  - 本地命令：`/qqbot-start/stop/status/reconnect/runtime/last/requests/approve/deny/revoke` + `/workspace`
  - QQ 原生指令按钮（permission.type=2）
- **访问控制**：allowUsers/allowGroups 白名单 + 审批码流程（redact/冷却/原子持久化热生效）
- **多媒体入站**：图片→视觉模型、语音→QQ ASR/可选 STT、TXT/PDF 有界提取
  - 安全下载：HTTPS-only + DNS pinning SSRF 防护 + 流式限流 + 重定向/超时/重试
  - mime_mismatch 校验 + 稳定错误码枚举（spec §6.14）
- **出站媒体**：`qq_send_local_file` 工具
  - 完整校验链（realpath/allowedRoots/硬链接/rename-race）
  - base64 上传 + 分片上传（prepare→PUT→finish）
- **/workspace 工作区**：注册表 + 切换 + 会话历史按工作区隔离（核心增量）
- **群聊支持**：GROUP_AT_MESSAGE_CREATE + allowGroups + 群命令权限
- **可靠性**：单实例锁（O_EXCL + 陈旧恢复）、WS 心跳 ACK 假死检测、op7 自动重连、退避重试
- **可观测性**：TUI 尾部视图（只读观察者）、host 契约（buildId/HOST_SCHEMA）、调试文件日志
- **回复格式**：Markdown 语义分块（≤3600B × 4）+ 纯文本降级对齐

### 修复（真平台验证期间）

- resolveSdkEntry 增加 import.meta.resolve 兜底（独立进程场景）
- 隔离会话防递归匹配扩展（项目目录名 qqbot）
- createBridge 丢失 gateway.onInbound 注册（事件无 listener 的根本原因）
- op7 Reconnect 后重连失效（READY 后 onFail settled）
- /gateway 端点 5xx 一次失败即停止（改为退避重试）
- reload 后 ctx stale / 旧 runtime 结构不兼容

### 技术栈

- Node >= 22.19（内置 WebSocket，零运行时依赖）+ pi >= 0.82 < 1.0
- 依赖：unpdf（PDF 文本提取）、typebox（工具参数 schema）
- 测试：node:test + 本地 mock QQ 平台（真实 WS 协议），153 个测试

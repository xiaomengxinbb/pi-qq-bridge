# pi-qq-bridge

通过 QQ 官方机器人 API v2 将 QQ（私聊 + 群聊）接入本地 Pi coding agent 的双向通信扩展。采用**隔离会话**架构：每个 QQ 对话拥有独立、持久的 Agent 会话，不污染本地 TUI 会话，支持 `/workspace` 工作区切换。

> **验证状态（v0.1.x）**：沙箱环境已实测（文本/命令/多媒体闭环）；正式环境与分片上传尚未实测，切正式环境前请先在沙箱验证。

---

## 快速开始（3 步）

### 1. 安装

```bash
pi install npm:pi-qq-bridge
```

完全退出并重新打开 Pi。

### 2. 准备 QQ 机器人凭据

1. 打开 [QQ 开放平台](https://q.qq.com)，用 QQ 扫码注册开发者（个人即可）
2. 创建机器人应用，获取 **AppID** 和 **AppSecret**
3. 在管理端**沙箱配置**中，把你测试用的 QQ 号加入**白名单/测试成员**（否则消息推不到机器人）

### 3. 创建配置

```bash
cp <扩展目录>/pi-qq-bridge.json.example ~/.pi/agent/pi-qq-bridge.json
chmod 600 ~/.pi/agent/pi-qq-bridge.json
nano ~/.pi/agent/pi-qq-bridge.json
```

填入：

```jsonc
{
  "appId": "你的 AppID",
  "clientSecret": "你的 AppSecret",
  "sandbox": true,          // 沙箱环境；正式上线后改 false
  "allowUsers": [],         // 先用空，见下方"首次授权"
  "allowGroups": []
}
```

重启 Pi（扩展自动连接网关），用测试 QQ 给机器人发条消息：

- 若 `allowUsers` 为空 → 本地终端会显示**审批码**，执行 `/qqbot-approve <码> user` 授权
- 之后正常对话即可

> **IP 白名单**：无需配置（实测验证，机器人主动连接 QQ 服务器，不受 IP 限制）。

---

## 配置详解

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 4 | 配置格式版本；不兼容旧版（缺失/不符会拒绝启动） |
| `enabled` | true | 扩展总开关 |
| `startup.mode` | auto | `auto` 随 Pi 启动自动连接；`manual` 需 `/qqbot-start` |
| `startup.keepAcrossLocalSessions` | true | `/new /resume /reload` 时保持 QQ 网关不断线 |
| `appId` / `clientSecret` | — | QQ 开放平台凭据（**勿提交 Git**） |
| `sandbox` | true | 沙箱/正式环境切换 |
| `allowUsers` | [] | 允许的私聊用户 openid（空 = 无人可用，需审批） |
| `allowGroups` | [] | 允许的群 openid |
| `workspaces` | default | 工作区列表：`{name, path}`，path 空 = 跟随 Pi 启动目录 |
| `commands.enabled` | true | QQ 侧命令开关 |
| `commands.admins` | [] | 管理员 openid（可执行 `/new /model /thinking` 等管理命令） |
| `commands.allowInGroups` | false | 是否允许管理员在群内执行管理命令 |
| `sessions.mode` | persistent | QQ 会话持久化到独立目录 |
| `sessions.maxResident` | 8 | 常驻会话上限（超限回收最旧空闲） |
| `sessions.idleDisposeMs` | 1800000 | 空闲回收时间（30 分钟） |
| `replyFormat` | auto | `auto` 优先 Markdown，被拒降级纯文本；`plain` 始终纯文本 |
| `progress.enabled` | true | 慢任务先发"已收到"回执 |
| `outboundMedia.enabled` | false | 出站文件发送总开关（独立数据外传权限，默认关闭） |
| `outboundMedia.allowedRoots` | [] | 允许发送的本地目录（OS 临时目录始终可用） |
| `media` | — | 入站附件限制（数量/大小/类型） |
| `logging.level` | info | 日志级别 |
| `debug` | false | 调试文件日志（写 `/tmp/pi-qq-bridge-gw.log`） |

---

## 使用说明

### QQ 侧命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 命令菜单 |
| `/status` | 会话/模型/队列/网关状态 |
| `/last` | 最近入站/出站摘要 |
| `/model [查询]` | 查看/切换模型（支持分页与关键词选择） |
| `/thinking [等级]` | 查看/修改思考等级 |
| `/new [名称]` | 新建 QQ 会话（旧会话保留） |
| `/sessions [关键词]` | 查看/搜索历史会话 |
| `/resume <短ID | 名称>` | 恢复历史会话 |
| `/name <名称>` | 命名当前会话 |
| `/compact [要求]` | 压缩上下文 |
| `/stop` | 中止任务并清空待处理消息 |
| `/workspace [名称]` | 工作区列表/切换（需管理员） |

普通文本直接作为任务发给 Pi。管理命令（`/new /model` 等）需要 `commands.admins` 权限。

### 本地 Pi 命令

| 命令 | 说明 |
| --- | --- |
| `/qqbot-start` / `/qqbot-stop` | 启动/停止网关 |
| `/qqbot-status` | 网关/会话/队列状态 |
| `/qqbot-reconnect` | 手动重连（自动重连 5 次失败后使用） |
| `/qqbot-runtime` | 扩展 build/版本（验证 reload 生效） |
| `/qqbot-last` | 最近活动摘要 |
| `/qqbot-requests` | 待审批访问申请列表 |
| `/qqbot-approve <码> <user\|admin>` | 批准访问申请 |
| `/qqbot-deny <码>` | 拒绝申请（1 小时冷却） |
| `/qqbot-revoke <openid>` | 撤销用户权限 |
| `/workspace` | 工作区管理（add/remove/切换，带补全） |

### 多媒体

- **图片** → 视觉模型（当前模型需支持 image 输入，否则明确提示）
- **语音** → QQ ASR 文本优先；可选配置 OpenAI-compatible STT（密钥仅环境变量）
- **TXT/PDF** → 有界提取正文；DOC/压缩包/视频明确拒绝（不自动解压执行）
- **出站**：管理员可让 Agent 调用 `qq_send_local_file` 把本地文件发回 QQ（需开启 `outboundMedia`）

### 单实例说明

同一时刻只有一个 Pi 进程能持有 QQ 网关（文件锁机制）：

- 第一个启动的 Pi 连接 QQ；后续启动的 Pi 会提示"另一 Pi 实例已持有"，QQ 功能不可用（其余功能正常）
- 第一个 Pi 退出/崩溃后，新 Pi 自动接管（锁陈旧检测）
- 多开时保留一个窗口作为网关宿主即可

---

## 常见问题（FAQ）

**发消息没反应？**

1. 确认网关状态：`/qqbot-status` 应显示 connected
2. 确认测试 QQ 在开放平台**沙箱白名单**内
3. 确认你的 openid 已授权：`/qqbot-requests` 查看申请，`/qqbot-approve <码> user` 批准
4. 群聊需要把群 openid 加入 `allowGroups`

**显示"未连接服务"？**

- 平台会定期要求客户端重连（正常机制）；扩展已实现自动重连+退避
- `/qqbot-reconnect` 手动重试；持续失败多为平台临时故障，稍后重试

**第二个 Pi 报"另一 Pi 实例已持有"？**

- 正常：单实例锁防止双连接。关掉一个或换锁持有者继续用

**普通消息能收，命令没权限？**

- 管理命令需要 `commands.admins` 里显式列出你的 openid

**想从 QQ 发文件给我？**

- 开启 `outboundMedia.enabled: true`，把你常用的目录加入 `allowedRoots`，然后在 QQ 里说"把 xxx 文件发给我"

**`/workspace` 怎么用？**

- 配置 `workspaces` 数组注册目录，QQ 或本地 `/workspace <名称>` 切换；会话历史按工作区隔离

---

## 安全说明

- 配置含凭据：`chmod 600`，勿提交 Git
- 附件下载：仅 HTTPS + DNS/重定向 SSRF 校验 + 流式限流；附件正文标记为不可信数据
- 出站文件：默认关闭；`allowedRoots` 白名单 + 符号链接/硬链接/rename-race 校验
- 隔离会话排除 pi-qq-bridge 自身（防递归）；QQ 消息不进本地 TUI 会话
- 未授权用户走审批码流程（附件批准前不下载）

## 开发

```bash
npm install
npm test        # 154 个测试（node:test + 本地 mock QQ 平台）
npm run typecheck
```

分层结构：`core/`（基础）· `gateway/`（连接）· `session/`（会话）· `media/`（多媒体）· `commands/`（命令）· 根（入口与编排）。

## 许可证

Apache-2.0

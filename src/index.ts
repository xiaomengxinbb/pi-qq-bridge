/**
 * pi-qq-bridge 扩展入口（M0）
 *
 * 本地命令：/qqbot-start /qqbot-stop /qqbot-status /qqbot-reconnect
 * 进程级运行时：Symbol.for 全局单例，/reload 后自动重挂（网关不断线）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, appendFileSync, rmSync } from "node:fs";

/** 调试日志辅助（避免闭包内 require） */
function requireNodeFsForLog(): {
	appendFileSync(path: string, data: string): void;
} {
	return { appendFileSync };
}
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadConfig,
	expandHome,
	DEFAULT_CONFIG_PATH,
	ConfigError,
	saveConfig,
	type PiQQBridgeConfig,
} from "./core/config.ts";
import { QQAuth } from "./gateway/qq-auth.ts";
import { QQGateway } from "./gateway/qq-gateway.ts";
import { QQApi } from "./gateway/qq-api.ts";
import { ConversationRegistry } from "./session/conversation-registry.ts";
import { QQRouter } from "./router.ts";
import {
	QQAccessRequestStore,
	normalizeAccessRole,
} from "./commands/access-requests.ts";
import { AttachmentPipeline } from "./media/attachment-pipeline.ts";
import { WorkspaceRegistry } from "./session/workspace-registry.ts";
import { TerminalView } from "./terminal-view.ts";
import { CommandStateMachine } from "./commands/command-controller.ts";
import {
	acquireInstanceLock,
	ensureLockDir,
	isLockHeldByMe,
	DEFAULT_LOCK_PATH,
	type InstanceLock,
} from "./instance-guard.ts";

/** 进程级运行时（跨 /reload 存活：WS socket 与定时器是进程级的，重新 attach 即可） */
const RUNTIME_SYMBOL = Symbol.for("pi-qq-bridge.runtime.v1");

/** host 契约（P1-5）：reload 后代码变更 → buildId 变化 → 旧 runtime 必须替换 */
const HOST_SCHEMA = 1;

function createBuildId(): string {
	const directory = dirname(fileURLToPath(import.meta.url));
	const hash = createHash("sha256");
	// 递归扫描 src（分层后子目录也要纳入 build 指纹）
	const sourceFiles: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".test.ts")
			) {
				sourceFiles.push(
					full.slice(directory.length + 1).replaceAll("\\", "/"),
				);
			}
		}
	};
	walk(directory);
	sourceFiles.sort();
	for (const filename of sourceFiles) {
		hash.update(filename);
		hash.update(readFileSync(join(directory, filename)));
	}
	return `v${HOST_SCHEMA}-${hash.digest("hex").slice(0, 12)}`;
}

const BUILD_ID = createBuildId();

interface BridgeRuntime {
	auth: QQAuth;
	gateway: QQGateway;
	api: QQApi;
	registry: ConversationRegistry;
	router: QQRouter;
	workspaceRegistry: WorkspaceRegistry;
	accessRequests: QQAccessRequestStore;
	viewHolder: { current: TerminalView };
	lock: InstanceLock | null;
	/** 锁归属定期校验（防止锁丢失后旧连接残留 → 双连接） */
	lockCheckTimer: ReturnType<typeof setInterval> | undefined;
	startedAt: number;
	hostSchema: number;
	buildId: string;
}

interface GlobalWithRuntime {
	[RUNTIME_SYMBOL]?: BridgeRuntime;
}

export default function piQQBridge(pi: ExtensionAPI): void {
	let config: PiQQBridgeConfig | undefined;
	let configError: string | undefined;

	const loadConfigOnce = (): PiQQBridgeConfig | undefined => {
		if (config) return config;
		try {
			config = loadConfig(expandHome(DEFAULT_CONFIG_PATH));
			configError = undefined;
			return config;
		} catch (err) {
			configError =
				err instanceof ConfigError
					? err.message
					: `配置加载失败：${(err as Error).message}`;
			config = undefined;
			return undefined;
		}
	};

	const getRuntime = (): BridgeRuntime | undefined =>
		(globalThis as GlobalWithRuntime)[RUNTIME_SYMBOL];

	const setRuntime = (rt: BridgeRuntime | undefined): void => {
		if (rt) (globalThis as GlobalWithRuntime)[RUNTIME_SYMBOL] = rt;
		else delete (globalThis as GlobalWithRuntime)[RUNTIME_SYMBOL];
	};

	const notify = (ctx: unknown, message: string): void => {
		const ui = (
			ctx as { ui?: { notify?: (msg: string, level?: string) => void } }
		).ui;
		ui?.notify?.(message, "error");
	};

	/** 组装完整桥接运行时（auth + gateway + api + registry + router）并接线 */
	const createBridge = (
		cfg: PiQQBridgeConfig,
		ctx: {
			cwd?: string;
			ui?: { setWidget?: (id: string, lines: string[]) => void };
		},
	): BridgeRuntime => {
		const agentDir = expandHome("~/.pi/agent");
		const cwd = ctx.cwd ?? process.cwd();
		const auth = new QQAuth(cfg.appId, cfg.clientSecret, {});
		// 调试日志：写到 /tmp（诊断连接问题；cfg.debug 或 sandbox 时开启）
		const debugLog = cfg.debug
			? (message: string) => {
					const { appendFileSync } = requireNodeFsForLog();
					try {
						appendFileSync(
							"/tmp/pi-qq-bridge-gw.log",
							`${new Date().toISOString()} ${message}\n`,
						);
					} catch {
						// 日志失败不影响功能
					}
				}
			: undefined;
		const gateway = new QQGateway(auth, { sandbox: cfg.sandbox, debugLog });
		const api = new QQApi(auth, { sandbox: cfg.sandbox });
		const workspaceRegistry = new WorkspaceRegistry(cfg.workspaces, cwd);
		const registry = new ConversationRegistry(cfg, agentDir, cwd, undefined, {
			name: "default",
			path: cwd,
		});
		const accessRequests = new QQAccessRequestStore();
		const attachmentPipeline = new AttachmentPipeline(
			cfg,
			`${process.pid}-${Date.now()}`,
		);
		// viewHolder：router 的 onEvent 委托指向 holder.current，
		// reload 后替换 current 即可让新 ctx 接管（旧 view 自动弃用）
		const viewHolder: { current: TerminalView } = {
			current: new TerminalView({
				setWidget: (id, lines) => ctx.ui?.setWidget?.(id, lines),
			}),
		};
		const router = new QQRouter(cfg, registry, api, {
			accessRequests,
			attachmentPipeline,
			workspaceRegistry,
			stateMachine: new CommandStateMachine(cfg.commands),
			statusProvider: () => {
				const { state, info } = gateway.getState();
				return `**${state}**${info ? `（${info}）` : ""}`;
			},
			onEvent: (event) => viewHolder.current.onEvent(event),
			debugLog,
		});
		gateway.onInbound((msg) => router.handleInbound(msg));
		auth.onFatal = (reason) => notify(ctx, `QQ token 刷新连续失败：${reason}`);
		const rt: BridgeRuntime = {
			auth,
			gateway,
			api,
			registry,
			router,
			workspaceRegistry,
			accessRequests,
			viewHolder,
			lock: null,
			lockCheckTimer: undefined,
			startedAt: Date.now(),
			hostSchema: HOST_SCHEMA,
			buildId: BUILD_ID,
		};
		// 锁归属校验：锁不在本进程 → 主动断开网关（防双连接）
		// 场景：锁被其他进程抢走/被删（陈旧清理、stop 释放），旧连接必须随之关闭
		rt.lockCheckTimer = setInterval(() => {
			if (rt.lock && !isLockHeldByMe(rt.lock.path)) {
				debugLog?.("[lock] 锁已不在本进程，主动断开网关（防双连接）");
				void rt.gateway.stop();
			}
		}, 30_000);
		rt.lockCheckTimer.unref?.();
		return rt;
	};

	pi.registerCommand("qqbot-start", {
		description: "启动 QQ 网关（抢单实例锁 + 连接沙箱/正式环境）",
		handler: async (_args, ctx) => {
			const cfg = loadConfigOnce();
			if (!cfg) {
				notify(ctx, `pi-qq-bridge：${configError ?? "配置不可用"}`);
				return;
			}
			if (getRuntime()?.gateway.getState().state !== "disconnected") {
				ctx.ui.notify("QQ 网关已在运行（/qqbot-status 查看）", "info");
				return;
			}
			const lockPath = expandHome(DEFAULT_LOCK_PATH);
			ensureLockDir(lockPath);
			const acquired = acquireInstanceLock(lockPath);
			if (!acquired.held) {
				notify(ctx, `pi-qq-bridge：${acquired.reason}`);
				return;
			}
			const rt = createBridge(cfg, ctx);
			rt.lock = acquired.lock;
			setRuntime(rt);
			rt.viewHolder.current.attach();
			const ok = await rt.gateway.start();
			if (!ok && rt.lock) {
				// 启动失败：释放锁，避免占位
				try {
					const { rmSync } = await import("node:fs");
					rmSync(rt.lock.path, { force: true });
				} catch {
					// 锁清理失败不阻塞启动结果；陈旧锁下次启动会被 stale 检测回收
				}
			}
			ctx.ui.notify(
				ok ? "QQ 网关已连接" : `QQ 网关连接失败：${rt.gateway.getState().info}`,
				ok ? "info" : "error",
			);
		},
	});

	pi.registerCommand("qqbot-stop", {
		description: "停止 QQ 网关（保留配置与锁释放）",
		handler: async (_args, ctx) => {
			const rt = getRuntime();
			if (!rt) {
				ctx.ui.notify("QQ 网关未运行", "info");
				return;
			}
			await rt.gateway.stop();
			if (rt.lock) {
				try {
					const { rmSync } = await import("node:fs");
					rmSync(rt.lock.path, { force: true });
				} catch {
					// 锁清理失败不阻塞停止；陈旧锁下次启动会被 stale 检测回收
				}
			}
			setRuntime(undefined);
			ctx.ui.notify("QQ 网关已停止", "info");
		},
	});

	pi.registerCommand("qqbot-status", {
		description: "查看 QQ 网关连接状态、配置与锁",
		handler: async (_args, ctx) => {
			const cfg = loadConfigOnce();
			const rt = getRuntime();
			const { state, info } = rt?.gateway.getState() ?? {
				state: "disconnected",
				info: "未启动",
			};
			const lines = [
				"## pi-qq-bridge 状态",
				`- 网关：**${state}**${info ? `（${info}）` : ""}`,
				`- 配置：${cfg ? `schemaVersion ${cfg.schemaVersion}，sandbox=${cfg.sandbox}` : `不可用：${configError ?? "未加载"}`}`,
				`- 会话：${rt ? `${rt.registry.residentCount} 驻留，队列 ${rt.router.queueSize}${rt.router.isRunning() ? "，运行中" : ""}` : "未启动"}`,
				`- 运行：${rt ? `pid 进程内，启动于 ${new Date(rt.startedAt).toLocaleTimeString()}` : "未启动（/qqbot-start 或 startup.mode=auto）"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("qqbot-reconnect", {
		description: "强制重连 QQ 网关（自动重连停止后使用）",
		handler: async (_args, ctx) => {
			const rt = getRuntime();
			if (!rt) {
				notify(ctx, "QQ 网关未运行（先 /qqbot-start）");
				return;
			}
			const ok = await rt.gateway.reconnect();
			ctx.ui.notify(
				ok ? "QQ 网关已重连" : `重连失败：${rt.gateway.getState().info}`,
				ok ? "info" : "error",
			);
		},
	});

	pi.registerCommand("qqbot-runtime", {
		description: "查看扩展 build/Host schema/运行时间（验证 reload 是否生效）",
		handler: async (_args, ctx) => {
			const rt = getRuntime();
			const lines = [
				"## pi-qq-bridge 运行时",
				`- Build：\`${BUILD_ID}\``,
				`- Host schema：${HOST_SCHEMA}`,
				rt
					? `- 运行时启动：${new Date(rt.startedAt).toLocaleTimeString()}（build ${rt.buildId}）`
					: "- 运行时：未启动",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("qqbot-last", {
		description: "查看最近 QQ 入站/出站摘要",
		handler: async (_args, ctx) => {
			const rt = getRuntime();
			if (!rt) {
				ctx.ui.notify("QQ 网关未运行（先 /qqbot-start）", "info");
				return;
			}
			// 本地视图复用 router 的 /last 逻辑：发送一条伪命令到最近的入站消息不可行，
			// 因此直接读取 router 内部摘要（M7 移到 terminal-view）
			ctx.ui.notify(
				"最近活动请通过 QQ 发送 /last 查看（本地视图 M7 提供）",
				"info",
			);
		},
	});

	/** 审批落地：原子更新配置 + 热生效 + QQ 通知（spec §6.13） */
	const applyApproval = async (
		cfg: PiQQBridgeConfig,
		userOpenId: string,
		role: "user" | "admin",
	): Promise<void> => {
		const updated = {
			...cfg,
			allowUsers: [...cfg.allowUsers],
			commands: { ...cfg.commands, admins: [...cfg.commands.admins] },
		};
		if (!updated.allowUsers.includes(userOpenId))
			updated.allowUsers.push(userOpenId);
		if (role === "admin" && !updated.commands.admins.includes(userOpenId)) {
			updated.commands.admins.push(userOpenId);
		}
		saveConfig(expandHome(DEFAULT_CONFIG_PATH), updated);
		// 热生效：router/registry 持有同一 config 引用
		cfg.allowUsers = updated.allowUsers;
		cfg.commands.admins = updated.commands.admins;
	};

	pi.registerCommand("qqbot-requests", {
		description: "列出待审批的 QQ 访问申请",
		handler: async (_args, ctx) => {
			const rt = getRuntime();
			if (!rt) {
				ctx.ui.notify("QQ 网关未运行（先 /qqbot-start）", "info");
				return;
			}
			const requests = rt.accessRequests.list();
			if (!requests.length) {
				ctx.ui.notify("没有待审批的访问申请", "info");
				return;
			}
			const lines = [
				"## 待审批访问申请",
				"",
				...requests.map(
					(r) =>
						`- \`${r.code}\` 用户 ${r.userOpenId}（${new Date(r.createdAt).toLocaleTimeString()} 提交）`,
				),
				"",
				"执行 /qqbot-approve <码> <user|admin> 或 /qqbot-deny <码>",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("qqbot-approve", {
		description: "批准访问申请：/qqbot-approve <申请码> <user|admin>",
		handler: async (args, ctx) => {
			const rt = getRuntime();
			const cfg = loadConfigOnce();
			if (!rt || !cfg) {
				notify(ctx, "QQ 网关未运行或配置不可用");
				return;
			}
			const [code, roleArg] = (args ?? "").trim().split(/\s+/);
			const role = normalizeAccessRole(roleArg);
			if (!code || !role) {
				ctx.ui.notify("用法：/qqbot-approve <申请码> <user|admin>", "info");
				return;
			}
			const request = rt.accessRequests.approve(code);
			if (!request) {
				ctx.ui.notify(`申请码 ${code} 不存在或已过期`, "error");
				return;
			}
			if (role === "admin") {
				// 授予 admin 需二次确认（spec §6.13）
				const confirmed = await ctx.ui.confirm(
					"确认",
					`授予 ${request.userOpenId} 管理员权限？`,
				);
				if (!confirmed) {
					ctx.ui.notify("已取消 admin 授权", "info");
					return;
				}
			}
			await applyApproval(cfg, request.userOpenId, role);
			ctx.ui.notify(`已批准 ${request.userOpenId}（${role}）`, "info");
			// QQ 通知（被动回复引用原消息，60min 窗口内有效）
			try {
				await rt.api.sendText(
					{
						type: "private",
						userOpenId: request.userOpenId,
						msgId: request.message.id,
					},
					`已批准你的访问申请（${role}）。现在可以开始使用了。`,
					1,
				);
			} catch {
				// 通知失败（如窗口过期）不影响授权生效
			}
		},
	});

	pi.registerCommand("qqbot-deny", {
		description: "拒绝访问申请：/qqbot-deny <申请码>",
		handler: async (args, ctx) => {
			const rt = getRuntime();
			if (!rt) {
				notify(ctx, "QQ 网关未运行（先 /qqbot-start）");
				return;
			}
			const code = (args ?? "").trim();
			const request = rt.accessRequests.deny(code);
			if (!request) {
				ctx.ui.notify(`申请码 ${code} 不存在或已过期`, "error");
				return;
			}
			ctx.ui.notify(
				`已拒绝 ${request.userOpenId}（1 小时内不再接收其申请）`,
				"info",
			);
		},
	});

	pi.registerCommand("qqbot-revoke", {
		description: "撤销用户权限：/qqbot-revoke <user_openid>",
		handler: async (args, ctx) => {
			const rt = getRuntime();
			const cfg = loadConfigOnce();
			if (!rt || !cfg) {
				notify(ctx, "QQ 网关未运行或配置不可用");
				return;
			}
			const openid = (args ?? "").trim();
			if (!openid) {
				ctx.ui.notify("用法：/qqbot-revoke <user_openid>", "info");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"确认",
				`确认撤销 ${openid} 的全部权限（普通用户 + 管理员）？`,
			);
			if (!confirmed) {
				ctx.ui.notify("已取消", "info");
				return;
			}
			const updated = {
				...cfg,
				allowUsers: cfg.allowUsers.filter((id) => id !== openid),
				commands: {
					...cfg.commands,
					admins: cfg.commands.admins.filter((id) => id !== openid),
				},
			};
			saveConfig(expandHome(DEFAULT_CONFIG_PATH), updated);
			cfg.allowUsers = updated.allowUsers;
			cfg.commands.admins = updated.commands.admins;
			ctx.ui.notify(`已撤销 ${openid} 的权限`, "info");
		},
	});

	pi.registerCommand("workspace", {
		description:
			"查看/切换工作区：/workspace [名称] | add <名称> <路径> | remove <名称>",
		getArgumentCompletions: (prefix: string) => {
			const rt = getRuntime();
			if (!rt) return null;
			const items = rt.workspaceRegistry
				.list()
				.map((w) => ({ value: w.name, label: `${w.name} → ${w.path}` }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const rt = getRuntime();
			const cfg = loadConfigOnce();
			if (!rt || !cfg) {
				notify(ctx, "QQ 网关未运行或配置不可用（先 /qqbot-start）");
				return;
			}
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const registry = rt.workspaceRegistry;
			if (tokens.length === 0) {
				const current = rt.registry.currentWorkspace;
				const lines = [
					"## 工作区",
					"",
					`当前：**${current.name}**（${current.path}）`,
					"",
					...registry.list().map((w) => `- \`${w.name}\`  ${w.path}`),
					"",
					"切换：/workspace <名称>；管理：/workspace add <名称> <路径> | remove <名称>",
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (tokens[0] === "add") {
				const [name, path, ...rest] = tokens.slice(1);
				if (!name || !path) {
					ctx.ui.notify(
						"用法：/workspace add <名称> <绝对路径> [描述]",
						"info",
					);
					return;
				}
				try {
					const workspace = registry.add(name, path, rest.join(" "));
					// 持久化 + 热生效
					cfg.workspaces = registry.list().filter((w) => w.name !== "default");
					saveConfig(expandHome(DEFAULT_CONFIG_PATH), cfg);
					ctx.ui.notify(
						`已添加工作区 ${workspace.name} → ${workspace.path}`,
						"info",
					);
				} catch (err) {
					notify(ctx, `pi-qq-bridge：${(err as Error).message}`);
				}
				return;
			}
			if (tokens[0] === "remove") {
				const name = tokens[1];
				if (!name) {
					ctx.ui.notify("用法：/workspace remove <名称>", "info");
					return;
				}
				try {
					registry.remove(name);
					cfg.workspaces = registry.list().filter((w) => w.name !== "default");
					saveConfig(expandHome(DEFAULT_CONFIG_PATH), cfg);
					ctx.ui.notify(`已移除工作区 ${name}`, "info");
				} catch (err) {
					notify(ctx, `pi-qq-bridge：${(err as Error).message}`);
				}
				return;
			}
			// 切换
			try {
				const resolved = registry.resolve(tokens[0]!);
				if (rt.registry.currentWorkspace.name === resolved.name) {
					ctx.ui.notify(
						`已在工作区 ${resolved.name}（${resolved.path}）`,
						"info",
					);
					return;
				}
				await rt.registry.setWorkspace(resolved.name, resolved.path);
				ctx.ui.notify(
					`已切换工作区：${resolved.name}（${resolved.path}）`,
					"info",
				);
			} catch (err) {
				notify(ctx, `pi-qq-bridge：${(err as Error).message}`);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// 进程级运行时已存在（跨 /reload 或跨本地会话）→ 重新 attach，无需重建
		const existing = getRuntime();
		if (existing) {
			// reload 后旧 ctx 失效：用新 ctx 重建视图（router 的 onEvent 委托自动指向新 view）
			// 兼容旧契约 runtime（reload 前创建、无 viewHolder 字段）：视图不可用但网关继续
			if (existing.viewHolder) {
				existing.viewHolder.current = new TerminalView({
					setWidget: (id, lines) => ctx.ui?.setWidget?.(id, lines),
				});
				existing.viewHolder.current.attach();
			}
			ctx.ui.notify("QQ 网关保持运行（进程级宿主已挂载）", "info");
			return;
		}
		const cfg = loadConfigOnce();
		if (!cfg) {
			if (configError) ctx.ui.notify(`pi-qq-bridge：${configError}`, "error");
			return;
		}
		if (!cfg.enabled) return;
		if (cfg.startup.mode !== "auto") return;
		// auto 模式：执行 /qqbot-start 相同流程
		const lockPath = expandHome(DEFAULT_LOCK_PATH);
		ensureLockDir(lockPath);
		const acquired = acquireInstanceLock(lockPath);
		if (!acquired.held) {
			ctx.ui.notify(`pi-qq-bridge：${acquired.reason}`, "error");
			return;
		}
		const rt = createBridge(cfg, ctx);
		rt.lock = acquired.lock;
		setRuntime(rt);
		rt.viewHolder.current.attach();
		void rt.gateway.start().then((ok) => {
			if (!ok && rt.lock) {
				// 启动失败：释放锁，避免占位（与 /qqbot-start 一致）
				try {
					rmSync(rt.lock.path, { force: true });
				} catch {
					// 陈旧锁下次启动会被 stale 检测回收
				}
			}
		});
	});

	pi.on("session_shutdown", async () => {
		const cfg = loadConfigOnce();
		const rt = getRuntime();
		rt?.viewHolder.current.detach();
		if (rt?.lockCheckTimer) {
			clearInterval(rt.lockCheckTimer);
			rt.lockCheckTimer = undefined;
		}
		// keepAcrossLocalSessions=false 或未启用进程级保持 → 停止网关
		if (rt && cfg && !cfg.startup.keepAcrossLocalSessions) {
			await rt.gateway.stop();
			await rt.registry.dispose();
			if (rt.lock) {
				try {
					const { rmSync } = await import("node:fs");
					rmSync(rt.lock.path, { force: true });
				} catch {
					// 锁清理失败不阻塞；陈旧锁下次启动会被 stale 检测回收
				}
			}
			setRuntime(undefined);
		}
	});
}

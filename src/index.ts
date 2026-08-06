/**
 * pi-qq-bridge 扩展入口（M0）
 *
 * 本地命令：/qqbot-start /qqbot-stop /qqbot-status /qqbot-reconnect
 * 进程级运行时：Symbol.for 全局单例，/reload 后自动重挂（网关不断线）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	expandHome,
	DEFAULT_CONFIG_PATH,
	ConfigError,
	saveConfig,
	type PiQQBridgeConfig,
} from "./config.ts";
import { QQAuth } from "./qq-auth.ts";
import { QQGateway } from "./qq-gateway.ts";
import { QQApi } from "./qq-api.ts";
import { ConversationRegistry } from "./conversation-registry.ts";
import { QQRouter } from "./router.ts";
import {
	QQAccessRequestStore,
	normalizeAccessRole,
} from "./access-requests.ts";
import { CommandStateMachine } from "./command-controller.ts";
import {
	acquireInstanceLock,
	ensureLockDir,
	DEFAULT_LOCK_PATH,
	type InstanceLock,
} from "./instance-guard.ts";

/** 进程级运行时（跨 /reload 存活：WS socket 与定时器是进程级的，重新 attach 即可） */
const RUNTIME_SYMBOL = Symbol.for("pi-qq-bridge.runtime.v1");

interface BridgeRuntime {
	auth: QQAuth;
	gateway: QQGateway;
	api: QQApi;
	registry: ConversationRegistry;
	router: QQRouter;
	accessRequests: QQAccessRequestStore;
	lock: InstanceLock | null;
	startedAt: number;
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
		ctx: { cwd?: string },
	): BridgeRuntime => {
		const agentDir = expandHome("~/.pi/agent");
		const cwd = ctx.cwd ?? process.cwd();
		const auth = new QQAuth(cfg.appId, cfg.clientSecret, {});
		const gateway = new QQGateway(auth, { sandbox: cfg.sandbox });
		const api = new QQApi(auth, { sandbox: cfg.sandbox });
		const registry = new ConversationRegistry(cfg, agentDir, cwd);
		const accessRequests = new QQAccessRequestStore();
		const router = new QQRouter(cfg, registry, api, {
			accessRequests,
			stateMachine: new CommandStateMachine(cfg.commands),
			statusProvider: () => {
				const { state, info } = gateway.getState();
				return `**${state}**${info ? `（${info}）` : ""}`;
			},
		});
		gateway.onInbound((msg) => router.handleInbound(msg));
		auth.onFatal = (reason) => notify(ctx, `QQ token 刷新连续失败：${reason}`);
		return {
			auth,
			gateway,
			api,
			registry,
			router,
			accessRequests,
			lock: null,
			startedAt: Date.now(),
		};
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
			ctx.ui.notify("最近活动请通过 QQ 发送 /last 查看（本地视图 M7 提供）", "info");
		},
	});

	/** 审批落地：原子更新配置 + 热生效 + QQ 通知（spec §6.13） */
	const applyApproval = async (
		cfg: PiQQBridgeConfig,
		rt: BridgeRuntime,
		userOpenId: string,
		role: "user" | "admin",
	): Promise<void> => {
		const updated = { ...cfg, allowUsers: [...cfg.allowUsers], commands: { ...cfg.commands, admins: [...cfg.commands.admins] } };
		if (!updated.allowUsers.includes(userOpenId)) updated.allowUsers.push(userOpenId);
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
				...requests.map((r) => `- \`${r.code}\` 用户 ${r.userOpenId}（${new Date(r.createdAt).toLocaleTimeString()} 提交）`),
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
				const confirmed = await ctx.ui.confirm("确认", `授予 ${request.userOpenId} 管理员权限？`);
				if (!confirmed) {
					ctx.ui.notify("已取消 admin 授权", "info");
					return;
				}
			}
			await applyApproval(cfg, rt, request.userOpenId, role);
			ctx.ui.notify(`已批准 ${request.userOpenId}（${role}）`, "info");
			// QQ 通知（被动回复引用原消息，60min 窗口内有效）
			try {
				await rt.api.sendText(
					{ type: "private", userOpenId: request.userOpenId, msgId: request.message.id },
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
			ctx.ui.notify(`已拒绝 ${request.userOpenId}（1 小时内不再接收其申请）`, "info");
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
			const confirmed = await ctx.ui.confirm("确认", `确认撤销 ${openid} 的全部权限（普通用户 + 管理员）？`);
			if (!confirmed) {
				ctx.ui.notify("已取消", "info");
				return;
			}
			const updated = { ...cfg, allowUsers: cfg.allowUsers.filter((id) => id !== openid), commands: { ...cfg.commands, admins: cfg.commands.admins.filter((id) => id !== openid) } };
			saveConfig(expandHome(DEFAULT_CONFIG_PATH), updated);
			cfg.allowUsers = updated.allowUsers;
			cfg.commands.admins = updated.commands.admins;
			ctx.ui.notify(`已撤销 ${openid} 的权限`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// 进程级运行时已存在（跨 /reload 或跨本地会话）→ 重新 attach，无需重建
		if (getRuntime()) {
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
		void rt.gateway.start();
	});

	pi.on("session_shutdown", async () => {
		const cfg = loadConfigOnce();
		const rt = getRuntime();
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

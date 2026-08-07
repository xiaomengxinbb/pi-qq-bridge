/**
 * 真平台全链路冒烟（沙箱）：独立进程跑完整闭环
 *
 * 链路：QQAuth → QQGateway(WS) → 事件 → QQRouter → 隔离 AgentSession(SDK) → LLM → 被动回复
 *
 * 用法：
 *   node scripts/smoke-real.ts
 * 然后从沙箱白名单内的测试 QQ 给机器人发消息，即可收到 pi 的完整回复。
 *
 * 注意：本脚本为一次性验证——首个真实消息的 user_openid 会被自动加入 allowUsers
 * （打印提示；生产使用请走 /qqbot-approve 审批流）。
 */
import { expandHome, loadConfig } from "../src/config.ts";
import { QQAuth } from "../src/qq-auth.ts";
import { QQGateway } from "../src/qq-gateway.ts";
import { QQApi } from "../src/qq-api.ts";
import { ConversationRegistry } from "../src/conversation-registry.ts";
import { QQRouter } from "../src/router.ts";
import { QQAccessRequestStore } from "../src/access-requests.ts";
import { CommandStateMachine } from "../src/command-controller.ts";
import { AttachmentPipeline } from "../src/attachment-pipeline.ts";
import { WorkspaceRegistry } from "../src/workspace-registry.ts";

const RUN_SECONDS = Number(process.env.SMOKE_SECONDS ?? 180);

async function main(): Promise<void> {
	const config = loadConfig(expandHome("~/.pi/agent/pi-qq-bridge.json"));
	const agentDir = expandHome("~/.pi/agent");
	const cwd = process.cwd();

	console.log(`[smoke] 配置: appId=${config.appId} sandbox=${config.sandbox}`);
	console.log("[smoke] 启动 QQAuth…");
	const auth = new QQAuth(config.appId, config.clientSecret);
	auth.onFatal = (reason) => console.error(`[smoke] ⚠️ token fatal: ${reason}`);

	// 1. token 连通性
	const token = await auth.getToken();
	console.log(
		`[smoke] ✅ token 获取成功（${token.slice(0, 8)}…，长度 ${token.length}）`,
	);

	// 2. 网关连接
	console.log("[smoke] 启动 QQGateway…");
	const gateway = new QQGateway(auth, { sandbox: config.sandbox });
	gateway.onStateChange((state, info) =>
		console.log(`[smoke] 📡 网关状态: ${state}${info ? `（${info}）` : ""}`),
	);

	const ok = await gateway.start();
	if (!ok) {
		console.error(`[smoke] ❌ 网关连接失败: ${gateway.getState().info}`);
		process.exit(1);
	}
	console.log(`[smoke] ✅ 网关已连接（${gateway.getState().info}）`);

	// 3. 组装完整链路
	const api = new QQApi(auth, { sandbox: config.sandbox });
	const workspaceRegistry = new WorkspaceRegistry(config.workspaces, cwd);
	const registry = new ConversationRegistry(config, agentDir, cwd, undefined, {
		name: "default",
		path: cwd,
	});
	const attachmentPipeline = new AttachmentPipeline(
		config,
		`smoke-${process.pid}`,
	);
	const router = new QQRouter(config, registry, api, {
		accessRequests: new QQAccessRequestStore(),
		attachmentPipeline,
		workspaceRegistry,
		stateMachine: new CommandStateMachine(config.commands),
		onEvent: (event) => {
			if (event.kind === "reply")
				console.log(
					`[smoke] 📤 回复(${event.msgSeq}): ${event.content.slice(0, 60)}…`,
				);
			if (event.kind === "access_request")
				console.log(`[smoke] 🔐 申请: ${event.userOpenId} 码 ${event.code}`);
			if (event.kind === "error")
				console.error(`[smoke] ⚠️ 错误: ${event.message}`);
		},
	});

	// 4. 一次性自动授权：首个真实消息的 openid 加入 allowUsers（冒烟专用）
	const originalHandle = router.handleInbound.bind(router);
	router.handleInbound = (msg) => {
		if (!config.allowUsers.includes(msg.userOpenId)) {
			config.allowUsers.push(msg.userOpenId);
			console.log(
				`[smoke] ⚠️ 已自动授权 ${msg.userOpenId}（一次性冒烟模式；生产请走审批流）`,
			);
		}
		originalHandle(msg);
	};
	gateway.onInbound((msg) => router.handleInbound(msg));

	console.log(
		`[smoke] 链路就绪。请在测试 QQ 给机器人发消息（${RUN_SECONDS}s 内有效）…`,
	);
	console.log(
		"[smoke] 提示：发“你好”验证文本闭环；发 /status 验证命令；发图片验证视觉。",
	);

	await new Promise<void>((resolve) => {
		setTimeout(() => resolve(), RUN_SECONDS * 1000);
	});

	console.log("[smoke] 运行结束。清理…");
	await registry.dispose();
	await gateway.stop();
	process.exit(0);
}

main().catch((err) => {
	console.error(
		`[smoke] ❌ 失败: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
});

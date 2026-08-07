/**
 * 扩展加载冒烟：模拟 pi API 调用 factory，验证扩展在 pi 环境无加载错误
 * 用法：node scripts/load-check.ts
 */
import piQQBridge from "../src/index.ts";

// 最小 pi API 桩
const commands = new Map<
	string,
	{ handler: (args: string, ctx: unknown) => Promise<void> | void }
>();
const events = new Map<
	string,
	Array<(event: unknown, ctx: unknown) => Promise<void> | void>
>();

const fakePi = {
	registerCommand(
		name: string,
		def: { handler: (args: string, ctx: unknown) => Promise<void> | void },
	) {
		commands.set(name, def);
	},
	on(
		event: string,
		handler: (event: unknown, ctx: unknown) => Promise<void> | void,
	) {
		const list = events.get(event) ?? [];
		list.push(handler);
		events.set(event, list);
	},
};

const fakeCtx = {
	cwd: process.cwd(),
	ui: {
		notify: (msg: string, level?: string) =>
			console.log(`[notify/${level ?? "info"}] ${msg}`),
		setWidget: (id: string, lines: string[]) =>
			console.log(`[widget ${id}] ${lines.length} 行`),
		confirm: async () => true,
		select: async () => undefined,
		input: async () => undefined,
	},
};

console.log("[load-check] 调用扩展 factory…");
piQQBridge(fakePi as never);
console.log(
	`[load-check] ✅ factory 执行成功，注册命令：${[...commands.keys()].join(", ")}`,
);
console.log(`[load-check] 监听事件：${[...events.keys()].join(", ")}`);

// 触发 session_start（auto 模式应自动启动网关）
console.log("[load-check] 触发 session_start（startup.mode=auto）…");
// 捕获未处理异常（网关启动失败细节）
process.on("unhandledRejection", (reason) => {
	console.error(
		"[load-check] ❌ unhandledRejection:",
		reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
	);
	process.exit(1);
});
const sessionStart = events.get("session_start")?.[0];
if (sessionStart) {
	const result = await sessionStart({ type: "session_start" }, fakeCtx);
	console.log("[load-check] session_start 完成");
}
// 等 3 秒看网关状态
await new Promise((r) => setTimeout(r, 3000));
console.log("[load-check] 完成（网关状态见上方 notify）");
process.exit(0);

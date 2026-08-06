/**
 * M0 spike — 验证 pi 0.84 SDK createAgentSessionRuntime 在独立进程可用：
 *   L1 runtime 创建 + 事件订阅
 *   L2 prompt 跑通 LLM
 *   L3 prompt 进行中 steer() 排队
 * 用法: node --experimental-strip-types spike-sdk.ts
 */
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "/home/lizhi/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { mkdirSync } from "node:fs";

const CWD = "/tmp/pi-qq-spike";
mkdirSync(CWD, { recursive: true });

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
	Promise.race([
		p,
		new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} TIMEOUT ${ms}ms`)), ms)),
	]);

// ── L1: runtime 创建 ──────────────────────────────────────────────
const t0 = Date.now();
const runtime = await withTimeout(
	createAgentSessionRuntime(createRuntime, {
		cwd: CWD,
		agentDir: getAgentDir(),
		sessionManager: SessionManager.create(CWD),
	}),
	90000,
	"RUNTIME_CREATE",
);
console.log(`[L1] runtime created in ${Date.now() - t0}ms`);
console.log(`[L1] diagnostics:`, JSON.stringify(runtime.diagnostics).slice(0, 300));

const session = runtime.session;
let agentStarts = 0;
let agentEnds = 0;
let text = "";
let sawTool = false;
const unsub = session.subscribe((event: any) => {
	if (event.type === "agent_start") { agentStarts++; console.log(`[evt] agent_start (n=${agentStarts})`); }
	if (event.type === "agent_end") { agentEnds++; console.log(`[evt] agent_end (n=${agentEnds})`); }
	if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
		text += event.assistantMessageEvent.delta;
	}
	if (event.type === "tool_execution_start") { sawTool = true; console.log(`[evt] tool: ${event.toolName}`); }
	if (event.type === "error") console.log("[evt] ERROR:", JSON.stringify(event).slice(0, 400));
});

// ── L2: 基础 prompt ───────────────────────────────────────────────
text = "";
const p0 = Date.now();
await withTimeout(
	session.prompt("不要调用任何工具。只回复四个字符：SPIK"),
	60000,
	"PROMPT",
);
console.log(`[L2] prompt resolved in ${Date.now() - p0}ms; agentStarts=${agentStarts} agentEnds=${agentEnds}`);
console.log(`[L2] collected text: "${text.slice(0, 120)}"`);

// ── L3: prompt 进行中 steer ───────────────────────────────────────
const steerPromise = (async () => {
	await new Promise((r) => setTimeout(r, 800)); // 让第一个 prompt 先进入运行
	const before = agentEnds;
	console.log("[L3] calling steer()...");
	await session.steer("不要工具，追加回复：OK");
	console.log(`[L3] steer() resolved; agentEnds=${agentEnds} (before=${before})`);
})();
const p1 = Date.now();
await withTimeout(
	session.prompt("不要调用任何工具。回复：FIRST"),
	60000,
	"PROMPT2",
);
await withTimeout(steerPromise, 30000, "STEER");
console.log(`[L3] second run resolved in ${Date.now() - p1}ms; agentStarts=${agentStarts} agentEnds=${agentEnds}`);
console.log(`[L3] collected text: "${text.slice(0, 200)}"`);

unsub();
console.log(`\n[spike] PASS: runtime=${Date.now() - t0}ms total, agentStarts=${agentStarts}, agentEnds=${agentEnds}, sawTool=${sawTool}`);
process.exit(0);

/**
 * router 单测（spec §10.1 router 相关）：FIFO / 去重 / 白名单 / 预算 / 错误回复
 * 注入 fake registry + fake api（不触真 SDK/网络）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { QQRouter } from "../src/router.ts";
import type { QQApi } from "../src/qq-api.ts";
import type { QQInboundMessage, QQReplyTarget } from "../src/types.ts";
import type { QQRunResult } from "../src/qq-session.ts";
import type { ConversationRegistryLike } from "../src/router.ts";

interface SentMessage {
	target: QQReplyTarget;
	content: string;
	msgSeq: number;
}

function makeApi(sent: SentMessage[], failWith?: Error): QQApi {
	return {
		async sendText(target: QQReplyTarget, content: string, msgSeq: number): Promise<void> {
			if (failWith) throw failWith;
			sent.push({ target, content, msgSeq });
		},
	} as unknown as QQApi;
}

interface FakeSessionOpts {
	text?: string;
	error?: Error;
	delayMs?: number;
	onPrompt?: (prompt: string) => void;
}

class FakeSession {
	private readonly opts: FakeSessionOpts;

	constructor(opts: FakeSessionOpts = {}) {
		this.opts = opts;
	}	async run(prompt: string): Promise<QQRunResult> {
		this.opts.onPrompt?.(prompt);
		if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
		if (this.opts.error) throw this.opts.error;
		return { text: this.opts.text ?? "fake answer", tools: [] };
	}
	isStreaming(): boolean {
		return false;
	}
	async dispose(): Promise<void> {}
}

class FakeRegistry implements ConversationRegistryLike {
	sessions = new Map<string, FakeSession>();
	created: string[] = [];
	private readonly sessionOpts: FakeSessionOpts;

	constructor(sessionOpts: FakeSessionOpts = {}) {
		this.sessionOpts = sessionOpts;
	}
	async get(msg: QQInboundMessage): Promise<FakeSession> {
		const key = msg.type === "private" ? `private:${msg.userOpenId}` : `group:${msg.groupOpenId}`;
		let session = this.sessions.get(key);
		if (!session) {
			session = new FakeSession(this.sessionOpts);
			this.sessions.set(key, session);
			this.created.push(key);
		}
		return session;
	}
	peek(): undefined {
		return undefined;
	}
	async dispose(): Promise<void> {}
}

function msg(overrides: Partial<QQInboundMessage> = {}): QQInboundMessage {
	return {
		id: `m_${Math.random().toString(36).slice(2, 10)}`,
		type: "private",
		text: "hello",
		userOpenId: "user_allowed",
		attachments: [],
		receivedAt: Date.now(),
		...overrides,
	};
}

const baseConfig = { allowUsers: ["user_allowed"], allowGroups: [], maxQueueSize: 20 };

test("授权用户：消息 → 会话 run → 文本被动回复（引用原 msg_id + msg_seq=1）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({ text: "你好，这是回复" });
	const router = new QQRouter(baseConfig, registry, makeApi(sent));
	const m = msg();
	router.handleInbound(m);
	// 等 pump 完成
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.content, "你好，这是回复");
	assert.equal(sent[0]?.msgSeq, 1);
	assert.equal(sent[0]?.target.msgId, m.id);
	assert.equal(sent[0]?.target.userOpenId, "user_allowed");
	assert.deepEqual(registry.created, ["private:user_allowed"]);
});

test("未授权用户：拒绝回复，不创建会话", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const router = new QQRouter(baseConfig, registry, makeApi(sent));
	const m = msg({ userOpenId: "user_evil" });
	router.handleInbound(m);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /没有权限/);
	assert.equal(registry.created.length, 0);
});

test("msg_id 去重：重复推送只处理一次", async () => {
	const sent: SentMessage[] = [];
	let prompts = 0;
	const registry = new FakeRegistry({
		text: "ok",
		onPrompt: () => {
			prompts += 1;
		},
	});
	const router = new QQRouter(baseConfig, registry, makeApi(sent));
	const m = msg({ id: "dup_msg_id" });
	router.handleInbound(m);
	router.handleInbound(m); // 平台重复推送
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(prompts, 1);
	assert.equal(sent.length, 1);
});

test("FIFO：多条消息串行处理，不并发", async () => {
	const sent: SentMessage[] = [];
	let active = 0;
	let maxActive = 0;
	const registry = new FakeRegistry({
		text: "ok",
		delayMs: 30,
		onPrompt: () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
		},
	});
	// onPrompt 在 run 内同步调用；用 afterTick 模拟并发窗口
	const origRun = FakeSession.prototype.run;
	FakeSession.prototype.run = async function (this: FakeSession, prompt: string) {
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise((r) => setTimeout(r, 30));
		active -= 1;
		return { text: "ok", tools: [] };
	};
	try {
		const router = new QQRouter(baseConfig, registry, makeApi(sent));
		router.handleInbound(msg());
		router.handleInbound(msg());
		router.handleInbound(msg());
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(maxActive, 1, "不允许并发 agent 运行");
		assert.equal(sent.length, 3);
	} finally {
		FakeSession.prototype.run = origRun;
	}
});

test("agent 运行失败：用户可读错误回复（占 1 次配额）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({ error: new Error("ENOTFOUND getaddrinfo host" ) });
	const router = new QQRouter(baseConfig, registry, makeApi(sent));
	router.handleInbound(msg());
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /NETWORK_UNAVAILABLE/);
});

test("回复失败不阻塞队列（后续消息仍处理）", async () => {
	const sent: SentMessage[] = [];
	let prompts = 0;
	const registry = new FakeRegistry({ text: "ok", onPrompt: () => { prompts += 1; } });
	const router = new QQRouter(baseConfig, registry, makeApi(sent, new Error("send boom")));
	router.handleInbound(msg());
	router.handleInbound(msg());
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(prompts, 2, "两条消息都应处理（回复失败不中断）");
});

test("空消息（无文本）忽略，不创建会话", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const router = new QQRouter(baseConfig, registry, makeApi(sent));
	router.handleInbound(msg({ text: "   " }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 0);
	assert.equal(registry.created.length, 0);
});

test("队列上限：满则丢最新", async () => {
	const sent: SentMessage[] = [];
	let prompts = 0;
	const registry = new FakeRegistry({
		text: "ok",
		delayMs: 20,
		onPrompt: () => { prompts += 1; },
	});
	const router = new QQRouter({ ...baseConfig, maxQueueSize: 2 }, registry, makeApi(sent));
	router.handleInbound(msg());
	router.handleInbound(msg());
	router.handleInbound(msg()); // 队列满（2 在等）→ 丢最新
	router.handleInbound(msg());
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(prompts, 3, "4 条消息中 3 条被处理（1 条因队列满被丢）");
	assert.equal(sent.length, 3);
});

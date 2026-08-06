/**
 * M1 全链路集成冒烟：mock QQ 平台 → 网关归一化 → router（FakeSession）→ 被动回复
 * 验证文本私聊闭环的每一环（真实 WS + HTTP，仅 agent 会话为 fake）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMockQQServer, c2cMessageEvent } from "./mock-qq-server.ts";
import { QQAuth } from "../src/qq-auth.ts";
import { QQGateway } from "../src/qq-gateway.ts";
import { QQApi } from "../src/qq-api.ts";
import { QQRouter, type ConversationRegistryLike } from "../src/router.ts";
import type { QQInboundMessage } from "../src/types.ts";

class EchoSession {
	private readonly reply: string;

	constructor(reply: string) {
		this.reply = reply;
	}
	async run(prompt: string): Promise<{ text: string; tools: never[] }> {
		return { text: `${this.reply}（收到：${prompt}）`, tools: [] as never[] };
	}
	isStreaming(): boolean {
		return false;
	}
	async dispose(): Promise<void> {}
}

class EchoRegistry implements ConversationRegistryLike {
	async get(msg: QQInboundMessage): Promise<EchoSession> {
		return new EchoSession("处理完成");
	}
	peek(): undefined {
		return undefined;
	}
	async dispose(): Promise<void> {}
}

test("端到端：C2C 消息 → 隔离会话 → 被动回复（msg_id 引用 + msg_seq=1）", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", { tokenUrl: `${mock.baseUrl}/app/getAppAccessToken` });
		const gateway = new QQGateway(auth, { sandbox: false, apiBase: mock.baseUrl });
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const router = new QQRouter(
			{ allowUsers: ["openid_owner"], allowGroups: [], maxQueueSize: 20 },
			new EchoRegistry(),
			api,
		);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();

		const evt = c2cMessageEvent({
			id: "msg_e2e_1",
			author: { user_openid: "openid_owner" },
			content: "帮我看看当前目录",
		});
		mock.sendEvent(evt.t, evt.d);

		// 等 router 处理 + 回复到达 mock
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(mock.messages.length, 1, "应收到一条被动回复");
		const reply = mock.messages[0]!;
		assert.equal(reply.path, "/v2/users/openid_owner/messages");
		assert.equal(reply.body.msg_type, 0);
		assert.equal(reply.body.msg_id, "msg_e2e_1", "被动回复必须引用原消息 msg_id");
		assert.equal(reply.body.msg_seq, 1);
		assert.match(String(reply.body.content), /处理完成（收到：帮我看看当前目录）/);

		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("端到端：未授权用户 → 拒绝回复，不触发 agent", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", { tokenUrl: `${mock.baseUrl}/app/getAppAccessToken` });
		const gateway = new QQGateway(auth, { sandbox: false, apiBase: mock.baseUrl });
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		let agentRuns = 0;
		const registry: ConversationRegistryLike = {
			async get(): Promise<EchoSession> {
				agentRuns += 1;
				return new EchoSession("x");
			},
			peek(): undefined {
				return undefined;
			},
			async dispose(): Promise<void> {},
		};
		const router = new QQRouter(
			{ allowUsers: ["openid_owner"], allowGroups: [], maxQueueSize: 20 },
			registry,
			api,
		);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();

		const evt = c2cMessageEvent({
			id: "msg_e2e_evil",
			author: { user_openid: "openid_hacker" },
			content: "rm -rf /",
		});
		mock.sendEvent(evt.t, evt.d);

		await new Promise((r) => setTimeout(r, 300));
		assert.equal(agentRuns, 0, "未授权用户绝不能触发 agent");
		assert.equal(mock.messages.length, 1);
		assert.match(String(mock.messages[0]?.body.content ?? ""), /没有权限/);

		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("端到端：重复推送同 msg_id → 只处理一次", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", { tokenUrl: `${mock.baseUrl}/app/getAppAccessToken` });
		const gateway = new QQGateway(auth, { sandbox: false, apiBase: mock.baseUrl });
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		let agentRuns = 0;
		const registry: ConversationRegistryLike = {
			async get(): Promise<EchoSession> {
				agentRuns += 1;
				return new EchoSession("ok");
			},
			peek(): undefined {
				return undefined;
			},
			async dispose(): Promise<void> {},
		};
		const router = new QQRouter(
			{ allowUsers: ["openid_owner"], allowGroups: [], maxQueueSize: 20 },
			registry,
			api,
		);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();

		const evt = c2cMessageEvent({
			id: "msg_e2e_dup",
			author: { user_openid: "openid_owner" },
			content: "hello",
		});
		mock.sendEvent(evt.t, evt.d);
		mock.sendEvent(evt.t, evt.d); // 平台重复推送

		await new Promise((r) => setTimeout(r, 300));
		assert.equal(agentRuns, 1, "重复推送只处理一次");
		assert.equal(mock.messages.length, 1);

		await gateway.stop();
	} finally {
		await mock.close();
	}
});

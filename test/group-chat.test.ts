/**
 * M4：群聊支持（GROUP_AT_MESSAGE_CREATE + allowGroups）
 * - 网关归一化：group_openid 解析
 * - router：群授权 / 群会话作用域 / 群回复路径
 * - 端到端：群 @ 消息 → 被动回复到 /v2/groups/{openid}/messages
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	startMockQQServer,
	groupAtMessageEvent,
	c2cMessageEvent,
} from "./mock-qq-server.ts";
import { QQAuth } from "../src/gateway/qq-auth.ts";
import { QQGateway } from "../src/gateway/qq-gateway.ts";
import { QQApi } from "../src/gateway/qq-api.ts";
import { QQRouter } from "../src/router.ts";
import { makeTestConfig, makeApi, FakeRegistry, type SentMessage } from "./helpers.ts";
import type { QQInboundMessage } from "../src/core/types.ts";

test("网关：GROUP_AT_MESSAGE_CREATE → QQInboundMessage(type=group, groupOpenId)", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const received: QQInboundMessage[] = [];
		gateway.onInbound((msg) => received.push(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(
				groupAtMessageEvent({
					id: "g1",
					group_openid: "group_openid_x",
					content: "@机器人 看下这个",
				}),
			).map(([, v]) => v) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(received.length, 1);
		const m = received[0]!;
		assert.equal(m.type, "group");
		assert.equal(m.groupOpenId, "group_openid_x");
		assert.equal(m.userOpenId, "group_user_1");
		assert.equal(m.text, "@机器人 看下这个");
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("router：allowGroups 授权的群消息 → 群会话 → 群回复路径", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const registry = new FakeRegistry({ text: "群回复内容" });
		const cfg = makeTestConfig({
			allowGroups: ["group_openid_1"],
			replyFormat: "plain",
		});
		const router = new QQRouter(cfg, registry, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(groupAtMessageEvent({ id: "g_reply" })).map(
				([, v]) => v,
			) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(mock.messages.length, 1);
		const reply = mock.messages[0]!;
		assert.equal(reply.path, "/v2/groups/group_openid_1/messages");
		assert.equal(reply.body.msg_id, "g_reply");
		assert.match(String(reply.body.content), /群回复内容/);
		assert.deepEqual(
			registry.created,
			["group:group_openid_1"],
			"群会话作用域 = group_openid",
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

/** 群消息构造（router 单测用，不经 mock WS） */
function groupMsg(overrides: Partial<QQInboundMessage> = {}): QQInboundMessage {
	return {
		id: `g_${Math.random().toString(36).slice(2, 10)}`,
		type: "group",
		text: "@机器人 看下这个",
		userOpenId: "group_user_1",
		groupOpenId: "group_openid_1",
		attachments: [],
		receivedAt: Date.now(),
		...overrides,
	};
}

test("router：授权群 + markdown 被拒（错误信息不含关键字）→ 降级纯文本回复（沙箱群聊场景）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({ text: "群回复内容" });
	const router = new QQRouter(
		makeTestConfig({ allowGroups: ["group_openid_1"], replyFormat: "auto" }),
		registry,
		makeApi(sent, undefined, new Error("HTTP 400 Bad Request")),
	);
	router.handleInbound(groupMsg());
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1, "markdown 被拒必须降级为纯文本回复，不能静默丢弃");
	assert.equal(sent[0]?.target.type, "group");
	assert.match(sent[0]?.content ?? "", /群回复内容/);
});

test("router：未授权群 + markdown 被拒 → 仍收到纯文本拒绝回复（含 group_openid 配置提示）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const router = new QQRouter(
		makeTestConfig({ allowGroups: [], replyFormat: "auto" }),
		registry,
		makeApi(sent, undefined, new Error("HTTP 400 Bad Request")),
	);
	router.handleInbound(groupMsg({ id: "g_evil_md", groupOpenId: "group_openid_x" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1, "拒绝回复不能因 markdown 被拒而丢失");
	assert.match(sent[0]?.content ?? "", /没有权限/);
	assert.match(sent[0]?.content ?? "", /group_openid_x/, "回复应附带群 openid 便于配置");
	assert.match(sent[0]?.content ?? "", /allowGroups/);
	assert.equal(registry.created.length, 0);
});

test("router：未授权群 → 拒绝回复（不产生访问申请）", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		let runs = 0;
		const registry = new FakeRegistry({
			onPrompt: () => {
				runs += 1;
			},
		});
		const router = new QQRouter(
			makeTestConfig({ allowGroups: [], replyFormat: "plain" }),
			registry,
			api,
		);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(groupAtMessageEvent({ id: "g_evil" })).map(
				([, v]) => v,
			) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(runs, 0);
		assert.equal(mock.messages.length, 1);
		assert.match(
			String(mock.messages[0]?.body.content ?? ""),
			/没有权限/,
			"群聊不产生申请码，直接拒绝",
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("router：私聊与群聊会话隔离（不同作用域）", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const registry = new FakeRegistry({ text: "ok" });
		const cfg = makeTestConfig({
			allowGroups: ["group_openid_1"],
			replyFormat: "plain",
		});
		const router = new QQRouter(cfg, registry, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(groupAtMessageEvent({ id: "g1" })).map(
				([, v]) => v,
			) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 200));
		mock.sendEvent(
			...(Object.entries(
				c2cMessageEvent({ id: "c1", author: { user_openid: "user_allowed" } }),
			).map(([, v]) => v) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(
			registry.created.sort(),
			["group:group_openid_1", "private:user_allowed"].sort(),
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("群聊命令：allowInGroups=false 时管理员也无法在群内执行 mutation", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const registry = new FakeRegistry();
		const cfg = makeTestConfig({
			allowGroups: ["group_openid_1"],
			replyFormat: "plain",
			commands: {
				...makeTestConfig({ replyFormat: "plain" }).commands,
				admins: ["group_user_1"],
				allowInGroups: false,
			},
		});
		const router = new QQRouter(cfg, registry, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		// 群内管理员发 /new（mutation）
		mock.sendEvent(
			...(Object.entries(
				groupAtMessageEvent({ id: "g_cmd", content: "/new" }),
			).map(([, v]) => v) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(mock.messages.length, 1);
		assert.match(
			String(mock.messages[0]?.body.content ?? ""),
			/群聊管理命令默认关闭/,
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

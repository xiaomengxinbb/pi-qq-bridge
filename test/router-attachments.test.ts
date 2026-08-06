/**
 * router × 附件管线集成测试（M3）：附件消息走 pipeline → prompt/images 进 agent
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { QQRouter } from "../src/router.ts";
import {
	makeTestConfig,
	makeApi,
	FakeRegistry,
	msg,
	type SentMessage,
} from "./helpers.ts";
import type { QQInboundMessage } from "../src/types.ts";
import type { PreparedQQMessage } from "../src/types.ts";
import type { AttachmentPipeline } from "../src/attachment-pipeline.ts";

function fakePipeline(
	overrides: Partial<PreparedQQMessage> = {},
): AttachmentPipeline {
	return {
		async prepare(m: QQInboundMessage): Promise<PreparedQQMessage> {
			return {
				prompt: `[QQ private user=${m.userOpenId} message=${m.id}]\n附件正文内容\n<qq-attachments untrusted="true">…</qq-attachments>`,
				images: [
					{
						type: "image",
						source: { type: "base64", mediaType: "image/png", data: "AAAA" },
					},
				],
				resources: [
					{
						attachment: m.attachments[0]!,
						kind: "image",
						filename: "a.png",
						status: "ready",
						image: {
							type: "image",
							source: { type: "base64", mediaType: "image/png", data: "AAAA" },
						},
					},
				],
				cleanup: async () => {},
				...overrides,
			};
		},
	} as unknown as AttachmentPipeline;
}

test("附件消息：pipeline 组装 prompt + images 传给 session.run", async () => {
	const sent: SentMessage[] = [];
	const runs: { prompt: string; images: unknown }[] = [];
	const registry = new FakeRegistry({
		text: "图片已分析",
		onRun: (prompt, options) => {
			runs.push({ prompt, images: (options as { images?: unknown })?.images });
		},
	});
	const router = new QQRouter(makeTestConfig(), registry, makeApi(sent), {
		attachmentPipeline: fakePipeline(),
	});
	router.handleInbound(
		msg({
			id: "m_att",
			text: "",
			attachments: [
				{
					url: "https://example.com/a.png",
					filename: "a.png",
					size: 1,
					contentType: "image/png",
				},
			],
		}),
	);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(runs.length, 1, "纯附件消息必须入队并运行 agent");
	assert.ok(runs[0]?.prompt.includes("附件正文内容"), "prompt 应包含提取内容");
	const images = runs[0]?.images as
		| { source?: { data?: string } }[]
		| undefined;
	assert.equal(images?.[0]?.source?.data, "AAAA", "images 应传给 agent");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.content, "图片已分析");
});

test("附件全部失败且无文本：直接回复失败原因，不运行 agent", async () => {
	const sent: SentMessage[] = [];
	let runs = 0;
	const registry = new FakeRegistry({
		onPrompt: () => {
			runs += 1;
		},
	});
	const pipeline = fakePipeline({
		prompt: "",
		images: [],
		resources: [
			{
				attachment: {
					url: "https://example.com/x.bin",
					filename: "x.bin",
					size: 1,
					contentType: "application/octet-stream",
				},
				kind: "unknown",
				filename: "x.bin",
				status: "rejected",
				errorCode: "parse_failed",
				errorMessage: "不支持的附件类型",
			},
		],
	});
	const router = new QQRouter(makeTestConfig(), registry, makeApi(sent), {
		attachmentPipeline: pipeline,
	});
	router.handleInbound(
		msg({
			id: "m_bad",
			text: "",
			attachments: [
				{
					url: "https://example.com/x.bin",
					filename: "x.bin",
					size: 1,
					contentType: "application/octet-stream",
				},
			],
		}),
	);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(runs, 0, "无可用输入时不运行 agent");
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /部分附件未处理/);
});

test("部分附件失败：提示失败但继续运行", async () => {
	const sent: SentMessage[] = [];
	let runs = 0;
	const registry = new FakeRegistry({
		text: "正文回答",
		onPrompt: () => {
			runs += 1;
		},
	});
	const pipeline = fakePipeline({
		prompt: "正文回答",
		images: [],
		resources: [
			{
				attachment: {
					url: "https://example.com/bad.bin",
					filename: "bad.bin",
					size: 1,
					contentType: "application/octet-stream",
				},
				kind: "unknown",
				filename: "bad.bin",
				status: "rejected",
				errorCode: "parse_failed",
				errorMessage: "不支持的附件类型",
			},
		],
	});
	const router = new QQRouter(makeTestConfig(), registry, makeApi(sent), {
		attachmentPipeline: pipeline,
	});
	router.handleInbound(
		msg({
			id: "m_partial",
			text: "分析一下",
			attachments: [
				{
					url: "https://example.com/bad.bin",
					filename: "bad.bin",
					size: 1,
					contentType: "application/octet-stream",
				},
			],
		}),
	);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(runs, 1, "有文本输入时继续运行");
	// 失败提示（1 条）+ 最终回复（1 条）
	assert.ok(
		sent.some((s) => /部分附件未处理/.test(s.content)),
		"应发送失败提示",
	);
	assert.ok(
		sent.some((s) => /正文回答/.test(s.content)),
		"应发送最终回复",
	);
});

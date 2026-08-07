/**
 * STT 单测：mock OpenAI-compatible /audio/transcriptions 端点
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeOpenAI, SttError } from "../src/media/stt.ts";

async function withSttServer(
	handler: (
		body: string,
		req: import("node:http").IncomingMessage,
	) => { status: number; json: unknown },
	fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c.toString();
		});
		req.on("end", () => {
			const { status, json } = handler(raw, req);
			res.statusCode = status;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(json));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	try {
		await fn(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function audioFile(): { path: string; cleanup(): void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-qq-bridge-stt-"));
	const path = join(dir, "voice.silk");
	writeFileSync(path, Buffer.from("fake audio bytes"));
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sttConfig = {
	baseUrl: "",
	apiKeyEnv: "QQBOT_STT_TEST_KEY",
	model: "whisper-1",
	timeoutMs: 5000,
};

test("transcribeOpenAI：请求形状（Bearer + multipart）+ 返回文本", async () => {
	process.env.QQBOT_STT_TEST_KEY = "sk-test";
	const file = audioFile();
	try {
		await withSttServer(
			(body, req) => {
				assert.match(req.headers.authorization ?? "", /^Bearer sk-test$/);
				assert.ok(body.includes('name="model"'));
				assert.ok(body.includes('name="file"'));
				assert.ok(body.includes("voice.silk"));
				return { status: 200, json: { text: "转写出来的文字" } };
			},
			async (baseUrl) => {
				const text = await transcribeOpenAI(
					{ path: file.path, filename: "voice.silk", mimeType: "audio/silk" },
					{ ...sttConfig, baseUrl },
					new AbortController().signal,
				);
				assert.equal(text, "转写出来的文字");
			},
		);
	} finally {
		delete process.env.QQBOT_STT_TEST_KEY;
		file.cleanup();
	}
});

test("transcribeOpenAI：密钥缺失 → stt_key_missing；未配置 baseUrl → stt_not_configured", async () => {
	delete process.env.QQBOT_STT_TEST_KEY;
	const file = audioFile();
	try {
		await assert.rejects(
			() =>
				transcribeOpenAI(
					{ path: file.path, filename: "v.silk", mimeType: "audio/silk" },
					sttConfig,
					new AbortController().signal,
				),
			(err: unknown) =>
				err instanceof SttError && err.code === "stt_key_missing",
		);
		process.env.QQBOT_STT_TEST_KEY = "sk-test";
		await assert.rejects(
			() =>
				transcribeOpenAI(
					{ path: file.path, filename: "v.silk", mimeType: "audio/silk" },
					{ ...sttConfig, baseUrl: undefined },
					new AbortController().signal,
				),
			(err: unknown) =>
				err instanceof SttError && err.code === "stt_not_configured",
		);
	} finally {
		delete process.env.QQBOT_STT_TEST_KEY;
		file.cleanup();
	}
});

test("transcribeOpenAI：HTTP 500 → stt_http_error；空文本 → stt_empty", async () => {
	process.env.QQBOT_STT_TEST_KEY = "sk-test";
	const file = audioFile();
	try {
		await withSttServer(
			() => ({ status: 500, json: { error: "boom" } }),
			async (baseUrl) => {
				await assert.rejects(
					() =>
						transcribeOpenAI(
							{ path: file.path, filename: "v.silk", mimeType: "audio/silk" },
							{ ...sttConfig, baseUrl },
							new AbortController().signal,
						),
					(err: unknown) =>
						err instanceof SttError && err.code === "stt_http_error",
				);
			},
		);
		await withSttServer(
			() => ({ status: 200, json: { text: "   " } }),
			async (baseUrl) => {
				await assert.rejects(
					() =>
						transcribeOpenAI(
							{ path: file.path, filename: "v.silk", mimeType: "audio/silk" },
							{ ...sttConfig, baseUrl },
							new AbortController().signal,
						),
					(err: unknown) => err instanceof SttError && err.code === "stt_empty",
				);
			},
		);
	} finally {
		delete process.env.QQBOT_STT_TEST_KEY;
		file.cleanup();
	}
});

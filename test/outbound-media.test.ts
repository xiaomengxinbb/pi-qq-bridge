/**
 * 出站媒体单测（spec §10.1 outbound-media.test.ts）
 * 路径校验（roots/相对路径/不存在）、交付上下文（预算/大小/授权/记录）、错误码
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	linkSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
	QQOutboundDeliveryContext,
	QQOutboundMediaError,
	resolveAllowedLocalFile,
	normalizeInputPath,
	formatBytes,
} from "../src/outbound-media.ts";
import { makeTestConfig, msg } from "./helpers.ts";
import type { QQApi } from "../src/qq-api.ts";
import type { QQInboundMessage } from "../src/types.ts";

function tempDir(): string {
	// 用 cwd 而非 tmpdir：OS tmp 是默认 allowedRoot，测试"拒绝"场景必须放在 tmp 外
	return mkdtempSync(join(process.cwd(), ".tmp-outbound-test-"));
}

// ── 路径校验 ─────────────────────────────────────────────────────

test("resolveAllowedLocalFile：allowedRoots 内放行、外拒绝、不存在报错", async () => {
	const dir = tempDir();
	const allowed = join(dir, "allowed");
	const outside = join(dir, "outside");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(allowed, { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(allowed, "a.txt"), "hello");
	try {
		const resolved = await resolveAllowedLocalFile(
			join(allowed, "a.txt"),
			process.cwd(),
			[allowed],
		);
		assert.ok(resolved.endsWith("a.txt"));
		// 未配置 root → 仅 OS tmp 允许
		await assert.rejects(
			() => resolveAllowedLocalFile(join(allowed, "a.txt"), process.cwd(), []),
			(err: unknown) =>
				err instanceof QQOutboundMediaError &&
				err.code === "path_outside_allowed_roots",
		);
		// 不存在
		await assert.rejects(
			() =>
				resolveAllowedLocalFile(join(allowed, "missing.txt"), process.cwd(), [
					allowed,
				]),
			(err: unknown) =>
				err instanceof QQOutboundMediaError && err.code === "file_not_found",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAllowedLocalFile：符号链接解析到 root 外拒绝", async () => {
	const dir = tempDir();
	const allowed = join(dir, "allowed");
	const outside = join(dir, "outside");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(allowed, { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "secret");
	try {
		// 符号链接在 allowed 内但指向 outside
		symlinkSync(join(outside, "secret.txt"), join(allowed, "link.txt"));
		await assert.rejects(
			() =>
				resolveAllowedLocalFile(join(allowed, "link.txt"), process.cwd(), [
					allowed,
				]),
			(err: unknown) =>
				err instanceof QQOutboundMediaError &&
				err.code === "path_outside_allowed_roots",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("normalizeInputPath：相对路径基于 cwd；Windows 路径转 WSL", () => {
	assert.equal(normalizeInputPath("a.txt", "/home/user"), "/home/user/a.txt");
	assert.equal(normalizeInputPath("/abs/a.txt", "/home/user"), "/abs/a.txt");
	assert.equal(
		normalizeInputPath("C:\\Users\\x\\a.txt", "/home/user"),
		"/mnt/c/Users/x/a.txt",
	);
	assert.equal(normalizeInputPath("@/tmp/x.txt", "/home/user"), "/tmp/x.txt");
	assert.throws(() => normalizeInputPath("\u0000bad", "/"), /路径无效/);
});

// ── 交付上下文 ───────────────────────────────────────────────────

function makeApi(uploads: string[], sends: unknown[]): QQApi {
	return {
		async uploadMedia(): Promise<{ fileInfo: string; ttl: number }> {
			uploads.push("upload");
			return { fileInfo: "file_info_1", ttl: 600 };
		},
		async sendMedia(): Promise<void> {
			sends.push("send");
		},
	} as unknown as QQApi;
}

function makeContext(
	overrides: {
		config?: ReturnType<typeof makeTestConfig>;
		api?: QQApi;
		message?: QQInboundMessage;
		seqBudget?: () => number | undefined;
		allowedRoots?: string[];
	} = {},
): { context: QQOutboundDeliveryContext; budgetUsed: number[] } {
	const budgetUsed: number[] = [];
	const config = overrides.config ?? makeTestConfig();
	if (!overrides.config) {
		// 开启出站（默认关）
		config.outboundMedia = {
			...config.outboundMedia,
			enabled: true,
			adminsOnly: false,
		};
	}
	// allowedRoots 始终合并（测试目录在 tmp 外，必须显式授权）
	if (overrides.allowedRoots) {
		config.outboundMedia = {
			...config.outboundMedia,
			allowedRoots: overrides.allowedRoots,
		};
	}
	const context = new QQOutboundDeliveryContext({
		config,
		cwd: process.cwd(),
		message: overrides.message ?? msg({ userOpenId: "user_allowed" }),
		target: { type: "private", userOpenId: "user_allowed", msgId: "m1" },
		api: overrides.api ?? makeApi([], []),
		reserveMessageSequence:
			overrides.seqBudget ??
			(() => {
				budgetUsed.push(1);
				return budgetUsed.length;
			}),
	});
	return { context, budgetUsed };
}

test("交付：OS tmp 内的文件可发送（默认 root）", async () => {
	const dir = tempDir();
	writeFileSync(
		join(dir, "pic.png"),
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
	);
	try {
		const { context } = makeContext({ allowedRoots: [dir] });
		const record = await context.sendLocalFile(join(dir, "pic.png"), "image");
		assert.equal(record.status, "sent");
		assert.equal(record.kind, "image");
		context.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("交付：outboundMedia.enabled=false → outbound_disabled", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "a.txt"), "x");
	try {
		const config = makeTestConfig();
		config.outboundMedia = { ...config.outboundMedia, enabled: false };
		const { context } = makeContext({ config });
		await assert.rejects(
			() => context.sendLocalFile(join(dir, "a.txt")),
			(err: unknown) =>
				err instanceof QQOutboundMediaError && err.code === "outbound_disabled",
		);
		context.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("交付：非管理员（adminsOnly）→ outbound_not_authorized", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "a.txt"), "x");
	try {
		const config = makeTestConfig({
			commands: { ...makeTestConfig().commands, admins: [] },
		});
		config.outboundMedia = {
			...config.outboundMedia,
			enabled: true,
			adminsOnly: true,
		};
		const { context } = makeContext({ config });
		await assert.rejects(
			() => context.sendLocalFile(join(dir, "a.txt")),
			(err: unknown) =>
				err instanceof QQOutboundMediaError &&
				err.code === "outbound_not_authorized",
		);
		context.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("交付：硬链接拒绝", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "original.txt"), "content");
	try {
		linkSync(join(dir, "original.txt"), join(dir, "hardlink.txt"));
		const { context } = makeContext({ allowedRoots: [dir] });
		await assert.rejects(
			() => context.sendLocalFile(join(dir, "hardlink.txt")),
			(err: unknown) =>
				err instanceof QQOutboundMediaError &&
				err.code === "hardlink_not_allowed",
		);
		context.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("交付：请求 image 但文件不是图片 → unsupported_media_type", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "not-image.txt"), "plain text content");
	try {
		const { context } = makeContext({ allowedRoots: [dir] });
		await assert.rejects(
			() => context.sendLocalFile(join(dir, "not-image.txt"), "image"),
			(err: unknown) =>
				err instanceof QQOutboundMediaError &&
				err.code === "unsupported_media_type",
		);
		context.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("交付：回复预算耗尽 → reply_budget_exhausted", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "a.txt"), "x");
	try {
		const { context } = makeContext({ seqBudget: () => undefined });
		await assert.rejects(
			() => context.sendLocalFile(join(dir, "a.txt")),
			(err: unknown) =>
				err instanceof QQOutboundMediaError &&
				err.code === "reply_budget_exhausted",
		);
		context.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("交付：回合结束后（close）拒绝", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "a.txt"), "x");
	try {
		const { context } = makeContext();
		context.close();
		await assert.rejects(
			() => context.sendLocalFile(join(dir, "a.txt")),
			(err: unknown) =>
				err instanceof QQOutboundMediaError &&
				err.code === "delivery_context_closed",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("交付：失败记录含错误码（spec §6.14 出站枚举）", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "big.bin"), Buffer.alloc(100));
	try {
		const config = makeTestConfig();
		config.outboundMedia = {
			...config.outboundMedia,
			enabled: true,
			adminsOnly: false,
			maxFileBytes: 10,
		};
		const { context } = makeContext({ config, allowedRoots: [dir] });
		await assert.rejects(
			() => context.sendLocalFile(join(dir, "big.bin")),
			(err: unknown) =>
				err instanceof QQOutboundMediaError && err.code === "file_too_large",
		);
		const record = context.records[0];
		assert.equal(record?.errorCode, "file_too_large");
		assert.equal(record?.status, "failed");
		context.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("formatBytes", () => {
	assert.equal(formatBytes(500), "500 B");
	assert.equal(formatBytes(2048), "2.0 KiB");
	assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MiB");
});

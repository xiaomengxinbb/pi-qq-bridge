/**
 * 附件下载器安全纯函数单测（spec §10.1 / §6.4）
 * SSRF 校验、URL 校验、内容嗅探、分类——全部无网络
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseAndValidateUrl,
	isPublicAddress,
	validatePublicHost,
	sniffMedia,
	classifyAttachment,
	safeOriginalFilename,
	AttachmentDownloadError,
} from "../src/attachment-downloader.ts";

// ── URL 校验 ─────────────────────────────────────────────────────

test("parseAndValidateUrl：HTTPS-only + 无凭据", () => {
	assert.doesNotThrow(() => parseAndValidateUrl("https://example.com/a.png"));
	assert.throws(
		() => parseAndValidateUrl("http://example.com/a.png"),
		/必须使用 HTTPS/,
	);
	assert.throws(
		() => parseAndValidateUrl("https://user:pass@example.com/a.png"),
		/用户名或密码/,
	);
	assert.throws(() => parseAndValidateUrl("not-a-url"), /URL 无效/);
});

// ── SSRF 防护 ────────────────────────────────────────────────────

test("isPublicAddress：私网/回环/保留段全部拒绝", () => {
	for (const addr of [
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.1.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
	]) {
		assert.equal(isPublicAddress(addr), false, `${addr} 不应是公网地址`);
	}
	assert.equal(isPublicAddress("100.64.0.1"), false, "CGNAT 段拒绝");
	assert.equal(isPublicAddress("192.0.0.1"), false, "IETF 保留拒绝");
});

test("isPublicAddress：公网地址放行", () => {
	for (const addr of [
		"8.8.8.8",
		"1.1.1.1",
		"114.114.114.114",
		"223.5.5.5",
		"2606:4700:4700::1111",
	]) {
		assert.equal(isPublicAddress(addr), true, `${addr} 应为公网地址`);
	}
});

test("validatePublicHost：localhost 拒绝；内网 IP 拒绝", async () => {
	await assert.rejects(
		() => validatePublicHost("localhost"),
		(err: unknown) =>
			err instanceof AttachmentDownloadError && err.code === "ssrf_blocked",
	);
	await assert.rejects(
		() => validatePublicHost("127.0.0.1"),
		(err: unknown) =>
			err instanceof AttachmentDownloadError && err.code === "ssrf_blocked",
	);
	await assert.rejects(
		() => validatePublicHost("10.1.2.3"),
		(err: unknown) =>
			err instanceof AttachmentDownloadError && err.code === "ssrf_blocked",
	);
	// 公网 IP 直接放行（不做 DNS）
	await assert.doesNotReject(() => validatePublicHost("8.8.8.8"));
});

// ── 内容嗅探 ─────────────────────────────────────────────────────

test("sniffMedia：magic bytes 识别图片/PDF/DOC/文本", () => {
	assert.deepEqual(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), {
		kind: "image",
		mimeType: "image/jpeg",
		extension: ".jpg",
	});
	assert.deepEqual(
		sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		{ kind: "image", mimeType: "image/png", extension: ".png" },
	);
	assert.deepEqual(sniffMedia(Buffer.from("GIF89a")), {
		kind: "image",
		mimeType: "image/gif",
		extension: ".gif",
	});
	assert.deepEqual(sniffMedia(Buffer.from("%PDF-1.4\n")), {
		kind: "pdf",
		mimeType: "application/pdf",
		extension: ".pdf",
	});
	assert.deepEqual(
		sniffMedia(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
		{ kind: "doc", mimeType: "application/msword", extension: ".doc" },
	);
	// 纯文本
	const text = Buffer.from(
		"hello world this is a text file with normal content",
	);
	assert.deepEqual(sniffMedia(text), {
		kind: "text",
		mimeType: "text/plain",
		extension: ".txt",
	});
	// 二进制未知
	const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe, 0xfd]);
	assert.equal(sniffMedia(binary).kind, "unknown");
});

test("classifyAttachment：按 content-type 与扩展名", () => {
	assert.equal(
		classifyAttachment({ filename: "a.png", contentType: "image/png" }),
		"image",
	);
	assert.equal(
		classifyAttachment({ filename: "voice.silk", contentType: "voice" }),
		"audio",
	);
	assert.equal(
		classifyAttachment({ filename: "doc.pdf", contentType: "application/pdf" }),
		"pdf",
	);
	assert.equal(
		classifyAttachment({
			filename: "old.doc",
			contentType: "application/msword",
		}),
		"doc",
	);
	assert.equal(
		classifyAttachment({ filename: "notes.txt", contentType: "text/plain" }),
		"text",
	);
	assert.equal(
		classifyAttachment({
			filename: "archive.zip",
			contentType: "application/zip",
		}),
		"archive",
	);
	assert.equal(
		classifyAttachment({
			filename: "weird.bin",
			contentType: "application/octet-stream",
		}),
		"unknown",
	);
});

test("safeOriginalFilename：路径穿越与控制字符清理", () => {
	assert.equal(
		safeOriginalFilename("../../etc/passwd"),
		"passwd",
		"basename 剥离路径",
	);
	assert.equal(safeOriginalFilename("a<b>c:d.txt"), "a_b_c_d.txt");
	assert.equal(safeOriginalFilename(""), "attachment");
	assert.equal(safeOriginalFilename("x".repeat(300)).length <= 180, true);
});

/**
 * 附件提取器单测：TXT 编码/截断、PDF 文本层/无文本层
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractTxt,
	extractPdf,
	makeMinimalPdf,
	AttachmentExtractError,
} from "../src/attachment-extractors.ts";

function tmpFile(name: string, bytes: Uint8Array | Buffer): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-qq-bridge-extract-"));
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
}

function cleanup(path: string): void {
	try {
		rmSync(join(path, ".."), { recursive: true, force: true });
	} catch {
		// 测试清理尽力而为
	}
}

test("extractTxt：UTF-8 与 BOM", async () => {
	const p1 = tmpFile("a.txt", Buffer.from("你好，世界", "utf8"));
	const p2 = tmpFile(
		"b.txt",
		Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from("带 BOM 的文本", "utf8"),
		]),
	);
	try {
		assert.equal((await extractTxt(p1, 1000)).text, "你好，世界");
		assert.equal((await extractTxt(p2, 1000)).text, "带 BOM 的文本");
	} finally {
		cleanup(p1);
	}
});

test("extractTxt：UTF-16 LE/BE", async () => {
	const le = Buffer.from("UTF16LE 文本", "utf16le");
	const p1 = tmpFile("le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), le]));
	try {
		assert.equal((await extractTxt(p1, 1000)).text, "UTF16LE 文本");
	} finally {
		cleanup(p1);
	}
});

test("extractTxt：非法编码拒绝（invalid_encoding）", async () => {
	const p = tmpFile(
		"bad.txt",
		Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x00, 0x00]),
	);
	try {
		await assert.rejects(
			() => extractTxt(p, 1000),
			(err: unknown) =>
				err instanceof AttachmentExtractError &&
				err.code === "invalid_encoding",
		);
	} finally {
		cleanup(p);
	}
});

test("extractTxt：超长截断（头尾保留 + 标记）", async () => {
	const p = tmpFile("long.txt", Buffer.from("A".repeat(500), "utf8"));
	try {
		const result = await extractTxt(p, 100);
		assert.equal(result.truncated, true);
		assert.ok(result.text.includes("[内容因长度限制已截断]"));
		assert.ok(result.text.startsWith("A".repeat(50)), "头部保留");
		assert.ok(result.text.endsWith("A".repeat(10)), "尾部保留");
	} finally {
		cleanup(p);
	}
});

test("extractPdf：带文本层的最小 PDF 提取成功", async () => {
	const p = tmpFile("min.pdf", makeMinimalPdf("Hello PDF extraction test"));
	try {
		const result = await extractPdf(p, 10, 10_000);
		assert.ok(
			result.text.includes("Hello PDF extraction test"),
			`实际: ${result.text}`,
		);
	} finally {
		cleanup(p);
	}
});

test("extractPdf：无文本层 → pdf_no_text；非 PDF → parse_failed", async () => {
	const empty = tmpFile("empty.pdf", makeMinimalPdf(""));
	const garbage = tmpFile(
		"garbage.pdf",
		Buffer.from("this is not a pdf at all", "utf8"),
	);
	try {
		await assert.rejects(
			() => extractPdf(empty, 10, 10_000),
			(err: unknown) =>
				err instanceof AttachmentExtractError && err.code === "pdf_no_text",
		);
		await assert.rejects(
			() => extractPdf(garbage, 10, 10_000),
			(err: unknown) =>
				err instanceof AttachmentExtractError && err.code === "parse_failed",
		);
	} finally {
		cleanup(empty);
	}
});

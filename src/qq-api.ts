/**
 * QQ REST 发送 API（spec §6.3，M1：纯文本被动回复）
 * - POST /v2/users/{openid}/messages，msg_type:0，携带 msg_id + msg_seq
 * - 401 → forceRefresh 后重试一次
 * - 错误分类：QQApiError{status, code, requestAccepted}
 */
import type { QQAuth } from "./qq-auth.ts";
import type { QQReplyTarget } from "./types.ts";

const PROD_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";

export interface QQApiOptions {
	sandbox: boolean;
	/** API 基础域名覆盖（测试用） */
	apiBase?: string;
}

export class QQApiError extends Error {
	readonly status: number;
	readonly code?: number;
	readonly requestAccepted: boolean;

	constructor(
		message: string,
		status: number,
		code?: number,
		requestAccepted = false,
	) {
		super(message);
		this.name = "QQApiError";
		this.status = status;
		this.code = code;
		this.requestAccepted = requestAccepted;
	}
}

export class QQApi {
	private readonly base: string;

	private readonly auth: QQAuth;
	private readonly options: QQApiOptions;

	constructor(auth: QQAuth, options: QQApiOptions) {
		this.auth = auth;
		this.options = options;
		this.base = options.apiBase ?? (options.sandbox ? SANDBOX_BASE : PROD_BASE);
	}

	/** 纯文本被动回复（msg_type:0，可选键盘） */
	async sendText(
		target: QQReplyTarget,
		content: string,
		msgSeq: number,
		keyboard?: unknown,
	): Promise<void> {
		await this.send(target, {
			content,
			msg_type: 0,
			msg_id: target.msgId,
			msg_seq: msgSeq,
			...(keyboard ? { keyboard } : {}),
		});
	}

	/** 上传本地字节（不主动发送；返回 file_info） */
	async uploadMedia(
		target: QQReplyTarget,
		fileType: 1 | 4,
		fileData: string,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ fileInfo: string; fileUuid?: string; ttl: number }> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/files`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/files`;
		const body = await this.postJson(
			path,
			{ file_type: fileType, file_data: fileData, srv_send_msg: false },
			timeoutMs,
			"media upload",
		);
		if (typeof body.file_info !== "string" || !body.file_info) {
			throw new QQApiError("media upload response missing file_info", 502, undefined, true);
		}
		return {
			fileInfo: body.file_info,
			...(typeof body.file_uuid === "string" ? { fileUuid: body.file_uuid } : {}),
			ttl: typeof body.ttl === "number" && Number.isFinite(body.ttl) ? body.ttl : 0,
		};
	}

	/** 发送已上传媒体（msg_type:7 被动回复） */
	async sendMedia(target: QQReplyTarget, fileInfo: string, msgSeq: number, signal?: AbortSignal): Promise<void> {
		await this.send(
			target,
			{
				msg_type: 7,
				media: { file_info: fileInfo },
				msg_id: target.msgId,
				msg_seq: msgSeq,
				...(target.type === "group" ? { content: " " } : {}),
			},
			signal,
		);
	}

	private async send(
		target: QQReplyTarget,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<void> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/messages`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;
		try {
			await this.postJson(path, payload, 10_000, "send", signal);
		} catch (err) {
			// 401：token 失效，刷新后重试一次
			if (err instanceof QQApiError && err.status === 401) {
				await this.auth.forceRefresh();
				await this.postJson(path, payload, 10_000, "send", signal);
				return;
			}
			throw err;
		}
	}

	private async postJson(
		path: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		operation: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const token = await this.auth.getToken();
		const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `QQBot ${token}`,
				},
				body: JSON.stringify(payload),
				signal: requestSignal,
			});
		} catch (err) {
			throw new QQApiError(
				`${operation} request failed: ${err instanceof Error ? err.message : String(err)}`,
				0,
			);
		}
		let body: Record<string, unknown> = {};
		try {
			body = (await res.json()) as Record<string, unknown>;
		} catch {
			// 成功发送可能无 body；错误仍由 status 判定
		}
		if (res.ok) return body;
		const code = typeof body.code === "number" ? body.code : undefined;
		const message = typeof body.message === "string" ? body.message : "";
		throw new QQApiError(
			`${operation} failed (status ${res.status}${code != null ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`,
			res.status,
			code,
			true,
		);
	}
}

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

	constructor(message: string, status: number, code?: number, requestAccepted = false) {
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

	/** 纯文本被动回复（msg_type:0） */
	async sendText(target: QQReplyTarget, content: string, msgSeq: number): Promise<void> {
		await this.send(target, { content, msg_type: 0, msg_id: target.msgId, msg_seq: msgSeq });
	}

	private async send(target: QQReplyTarget, payload: Record<string, unknown>): Promise<void> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/messages`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;
		try {
			await this.postJson(path, payload, 10_000, "send");
		} catch (err) {
			// 401：token 失效，刷新后重试一次
			if (err instanceof QQApiError && err.status === 401) {
				await this.auth.forceRefresh();
				await this.postJson(path, payload, 10_000, "send");
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
	): Promise<Record<string, unknown>> {
		const token = await this.auth.getToken();
		const requestSignal = AbortSignal.timeout(timeoutMs);
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
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

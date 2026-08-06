/**
 * 消息路由（spec §6.7，M1 文本私聊闭环）
 *
 * handleInbound → 去重 → 白名单 → 入队 → FIFO 串行 → 隔离会话 run → 被动回复
 * M2 增加：steering 插嘴、命令控制器、progress ack、/stop
 */
import { MessageDedupe } from "./message-dedupe.ts";
import { ReplyBudget } from "./reply-budget.ts";
import type { QQApi } from "./qq-api.ts";
import { formatUserFacingAgentError } from "./user-facing.ts";
import type { QQInboundMessage, QQReplyTarget } from "./types.ts";
import type { QQRunResult, QQAgentSession } from "./qq-session.ts";

/** 会话结构接口（注入 fake 便于单测；QQAgentSession 结构兼容） */
export interface QQSessionLike {
	run(prompt: string, observer?: unknown): Promise<QQRunResult>;
	isStreaming(): boolean;
	dispose(): Promise<void>;
}

/** 注册表结构接口（ConversationRegistry 结构兼容） */
export interface ConversationRegistryLike {
	get(msg: QQInboundMessage): Promise<QQSessionLike>;
	peek(msg: QQInboundMessage): QQSessionLike | undefined;
	dispose(): Promise<void>;
}

export interface QQRouterOptions {
	/** 每条入站消息被动回复上限（QQ 文档 4/5 冲突，保守取 4） */
	replyBudgetLimit?: number;
	/** 去重 TTL（默认 2h） */
	dedupeTtlMs?: number;
}

export class QQRouter {
	private readonly queue: QQInboundMessage[] = [];
	private readonly dedupe: MessageDedupe;
	private running = false;
	private readonly replyBudgetLimit: number;
	private readonly maxQueueSize: number;

	private readonly config: { allowUsers: string[]; allowGroups: string[]; maxQueueSize: number };
	private readonly registry: ConversationRegistryLike;
	private readonly api: QQApi;
	private readonly options: QQRouterOptions;

	constructor(
		config: { allowUsers: string[]; allowGroups: string[]; maxQueueSize: number },
		registry: ConversationRegistryLike,
		api: QQApi,
		options: QQRouterOptions = {},
	) {
		this.config = config;
		this.registry = registry;
		this.api = api;
		this.options = options;
		this.replyBudgetLimit = options.replyBudgetLimit ?? 4;
		this.dedupe = new MessageDedupe(options.dedupeTtlMs);
		this.maxQueueSize = config.maxQueueSize;
	}

	/** 网关入站入口（M2 起：命令控制器 / 附件管线插在这里） */
	handleInbound(msg: QQInboundMessage): void {
		if (!this.dedupe.admit(msg.id)) return; // 重复推送
		if (!this.isAuthorized(msg)) {
			void this.replyDenied(msg);
			return;
		}
		// 无文本且无附件 → 忽略（P1-8 裁决；M1 无附件，即纯空消息忽略）
		if (!msg.text.trim()) return;
		if (this.queue.length >= this.maxQueueSize) return; // 满则丢最新
		this.queue.push(msg);
		void this.pump();
	}

	/** 队列长度（status 展示） */
	get queueSize(): number {
		return this.queue.length;
	}

	/** 是否正在运行 */
	isRunning(): boolean {
		return this.running;
	}

	/** 清空队列（/stop 用，M2） */
	clearQueue(): void {
		this.queue.length = 0;
	}

	private isAuthorized(msg: QQInboundMessage): boolean {
		if (msg.type === "private") return this.config.allowUsers.includes(msg.userOpenId);
		return this.config.allowGroups.includes(msg.groupOpenId ?? "");
	}

	private async replyDenied(msg: QQInboundMessage): Promise<void> {
		try {
			// M2 起：未授权私聊改走 access-request 流程（spec §6.13）
			const budget = new ReplyBudget(msg.id, this.replyBudgetLimit);
			const seq = budget.nextSeq();
			if (seq !== undefined) {
				await this.api.sendText(
					this.targetOf(msg),
					"抱歉，你没有权限使用此机器人。如需访问请联系管理员。",
					seq,
				);
			}
		} catch {
			// 拒绝回复失败无需再补救
		}
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0) {
				const msg = this.queue.shift()!;
				await this.runOne(msg);
			}
		} finally {
			this.running = false;
		}
	}

	private async runOne(msg: QQInboundMessage): Promise<void> {
		const budget = new ReplyBudget(msg.id, this.replyBudgetLimit);
		const target = this.targetOf(msg);
		let session: QQSessionLike | undefined;
		try {
			session = await this.registry.get(msg);
			const result = await session.run(msg.text);
			if (result.text && !budget.isExhausted) {
				const seq = budget.nextSeq();
				if (seq !== undefined) await this.api.sendText(target, result.text, seq);
			}
		} catch (err) {
			// agent 运行失败 → 用户可读错误（占 1 次配额）
			if (!budget.isExhausted) {
				const seq = budget.nextSeq();
				if (seq !== undefined) {
					try {
						await this.api.sendText(target, formatUserFacingAgentError(err), seq);
					} catch {
						// 回复失败不抛出到 pump（避免队列卡死）
					}
				}
			}
		}
	}

	private targetOf(msg: QQInboundMessage): QQReplyTarget {
		return {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
		};
	}
}

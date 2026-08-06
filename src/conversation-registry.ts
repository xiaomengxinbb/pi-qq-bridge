/**
 * 会话注册表（spec §6.5）
 * - key = 私聊 user_openid / 群 group_openid
 * - 懒创建 + idleDisposeMs 回收 + maxResident 上限
 * - sessionDir = sha256("pi-qq-bridge\0"+key) 前 32 位，QQ 专属目录
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { QQAgentSession } from "./qq-session.ts";
import type { PiQQBridgeConfig } from "./config.ts";
import type { QQInboundMessage } from "./types.ts";

export interface QQSessionFactory {
	create(): QQAgentSession;
}

export interface ConversationEntry {
	key: string;
	session: QQAgentSession;
	lastUsedAt: number;
	initializing?: Promise<void>;
}

export class ConversationRegistry {
	private readonly entries = new Map<string, ConversationEntry>();
	private disposed = false;

	private readonly config: PiQQBridgeConfig;
	private readonly agentDir: string;
	private readonly cwd: string;
	private readonly sessionFactory: QQSessionFactory;

	constructor(
		config: PiQQBridgeConfig,
		agentDir: string,
		cwd: string,
		sessionFactory: QQSessionFactory = { create: () => new QQAgentSession() },
	) {
		this.config = config;
		this.agentDir = agentDir;
		this.cwd = cwd;
		this.sessionFactory = sessionFactory;
	}

	async get(msg: QQInboundMessage): Promise<QQAgentSession> {
		if (this.disposed) throw new Error("QQ 会话注册表已释放");
		await this.evictExpired();
		const key = conversationKey(msg);
		let entry = this.entries.get(key);
		if (!entry) {
			await this.evictIfNeeded();
			entry = {
				key,
				session: this.sessionFactory.create(),
				lastUsedAt: Date.now(),
			};
			this.entries.set(key, entry);
			const sessionDir =
				this.config.sessions.mode === "persistent"
					? this.sessionDirFor(key)
					: undefined;
			entry.initializing = (async () => {
				if (sessionDir)
					await mkdir(sessionDir, { recursive: true, mode: 0o700 });
				await entry?.session.init(this.cwd, {
					sessionDir,
					persistent: this.config.sessions.mode === "persistent",
					restore: this.config.sessions.restore,
				});
			})();
		}
		try {
			await entry.initializing;
		} catch (err) {
			if (this.entries.get(key) === entry) this.entries.delete(key);
			await entry.session.dispose();
			throw err;
		}
		entry.initializing = undefined;
		entry.lastUsedAt = Date.now();
		return entry.session;
	}

	peek(msg: QQInboundMessage): QQAgentSession | undefined {
		return this.entries.get(conversationKey(msg))?.session;
	}

	get residentCount(): number {
		return this.entries.size;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const entries = [...this.entries.values()];
		this.entries.clear();
		await Promise.allSettled(
			entries.map(async (entry) => {
				await entry.initializing?.catch(() => undefined);
				await entry.session.dispose();
			}),
		);
	}

	private async evictExpired(): Promise<void> {
		const cutoff = Date.now() - this.config.sessions.idleDisposeMs;
		const expired = [...this.entries.values()].filter(
			(entry) =>
				entry.lastUsedAt < cutoff &&
				!entry.session.isStreaming() &&
				!entry.initializing,
		);
		for (const entry of expired) {
			if (this.entries.get(entry.key) !== entry) continue;
			this.entries.delete(entry.key);
			await entry.session.dispose();
		}
	}

	private async evictIfNeeded(): Promise<void> {
		const maxResident = this.config.sessions.maxResident;
		if (this.entries.size < maxResident) return;
		const idle = [...this.entries.values()]
			.filter((entry) => !entry.session.isStreaming())
			.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
		if (!idle) throw new Error("QQ 会话资源已满且全部在运行，请稍后重试");
		this.entries.delete(idle.key);
		await idle.session.dispose();
	}

	private sessionDirFor(key: string): string {
		const hash = createHash("sha256")
			.update(`pi-qq-bridge\0${key}`)
			.digest("hex")
			.slice(0, 32);
		return join(this.agentDir, "pi-qq-bridge", "sessions", hash);
	}
}

export function conversationKey(msg: QQInboundMessage): string {
	return msg.type === "private"
		? `private:${msg.userOpenId}`
		: `group:${msg.groupOpenId ?? ""}`;
}

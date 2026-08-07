/**
 * 隔离 AgentSession（spec §6.5 / §5.2）
 *
 * 每个 QQ 对话一个独立、持久的 AgentSessionRuntime：
 * - 加载宿主 skills/MCP/插件，但排除 pi-qq-bridge 自身（防递归）
 * - 会话文件在 QQ 专属目录，绝不进入本地 TUI 会话列表
 * - run()：subscribe 事件流 → prompt → agent_end 时提取最终 assistant 文本
 * - 会话管理（M2）：/new /sessions /resume /name /compact /model /thinking /stop
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { QQOutboundDeliveryContext } from "./outbound-media.ts";

// 拆分拼接，避免字面量出现在 bundle 路径扫描目标里（@xsqm 同款手法）
const SDK_MARKER = "@earendil-works" + "/" + "pi-coding-agent";

/** 从运行进程定位已安装的 pi SDK 入口（dist/index.js） */
export function resolveSdkEntry(): string {
	const candidates: string[] = [];
	if (process.argv[1]) {
		try {
			candidates.push(realpathSync(process.argv[1]));
		} catch {
			// 忽略；退回原始路径
		}
		candidates.push(process.argv[1]);
	}
	for (const candidate of candidates) {
		const normalized = candidate.replaceAll("\\", "/");
		const index = normalized.lastIndexOf(SDK_MARKER);
		if (index >= 0)
			return `${normalized.slice(0, index + SDK_MARKER.length)}/dist/index.js`;
	}
	throw new Error("cannot locate pi SDK from process.argv[1]");
}

/** 本扩展路径特征（排除自身防递归时匹配） */
export function isPiQQBridgeExtensionPath(path: string | undefined): boolean {
	if (!path) return false;
	const normalized = path.replaceAll("\\", "/");
	return (
		normalized.includes("pi-qq-bridge") || normalized.includes("qq-bridge")
	);
}

type SdkModule = Record<string, unknown>;

let sdkPromise: Promise<SdkModule> | undefined;

function loadSdk(): Promise<SdkModule> {
	if (!sdkPromise)
		sdkPromise = import(
			pathToFileURL(resolveSdkEntry()).href
		) as Promise<SdkModule>;
	return sdkPromise;
}

/** 一次 agent 运行的结果 */
export interface QQRunResult {
	text: string;
	/** 工具调用记录（M2 showProcess 用） */
	tools: {
		toolCallId: string;
		name: string;
		args: unknown;
		isError: boolean;
	}[];
}

/** 运行观察事件（TUI 视图 / 测试用） */
export type QQAgentRunEvent =
	| { kind: "agent_start" }
	| { kind: "assistant_delta"; delta: string }
	| { kind: "tool_start"; toolName: string }
	| { kind: "tool_end"; toolName: string; isError: boolean }
	| { kind: "assistant_end" };

export type QQAgentRunObserver = (event: QQAgentRunEvent) => void;

export interface QQSessionOptions {
	sessionDir?: string;
	persistent?: boolean;
	restore?: "recent" | "new";
}

/** 模型信息 */
export interface QQModelInfo {
	provider: string;
	id: string;
	name: string;
	input: string[];
	reasoning: boolean;
}

/** 会话结构接口（registry 创建、router 使用；QQAgentSession 结构兼容） */
export interface QQSessionLike {
	init(cwd: string, options?: QQSessionOptions): Promise<void>;
	isReady(): boolean;
	isStreaming(): boolean;
	dispose(): Promise<void>;
	run(
		prompt: string,
		options?: {
			images?: import("./types.ts").QQImageContent[];
			observer?: QQAgentRunObserver;
		},
	): Promise<QQRunResult>;
	currentModel(): QQModelInfo | undefined;
	availableModels(): Promise<QQModelInfo[]>;
	setModel(provider: string, modelId: string): Promise<QQModelInfo>;
	thinkingLevel(): string;
	availableThinkingLevels(): string[];
	setThinkingLevel(level: string): string;
	newSession(name?: string): Promise<{ id: string; name?: string }>;
	listSessions(): Promise<QQSessionInfo[]>;
	resumeSession(path: string): Promise<{ id: string; name?: string }>;
	setSessionName(name: string): string;
	sessionId(): string;
	sessionName(): string | undefined;
	compact(instructions?: string): Promise<{ tokensBefore?: number }>;
	abort(): Promise<void>;
	bindOutboundDelivery?(context?: unknown): void;
	/** M7：运行中插嘴（当前 assistant 回合结束后注入） */
	steer?(
		prompt: string,
		options?: { images?: import("./types.ts").QQImageContent[] },
	): Promise<void>;
	/** M7：清除未投递的 steering/followUp 队列 */
	clearPendingMessages?(): void;
}

/** 会话信息（listSessions 返回项的结构化视图） */
export interface QQSessionInfo {
	path: string;
	id: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

/** 模型信息归一化（动态 SDK 模型对象 → QQModelInfo） */
export function toModelInfo(model: unknown): QQModelInfo | undefined {
	const m = model as
		| {
				provider?: unknown;
				id?: unknown;
				name?: unknown;
				input?: unknown;
				reasoning?: unknown;
		  }
		| undefined;
	if (!m || typeof m.provider !== "string" || typeof m.id !== "string")
		return undefined;
	return {
		provider: m.provider,
		id: m.id,
		name: typeof m.name === "string" ? m.name : m.id,
		input: Array.isArray(m.input)
			? m.input.filter((v): v is string => typeof v === "string")
			: [],
		reasoning: m.reasoning === true,
	};
}

function normalizeThinkingLevel(value: string): string | undefined {
	const normalized = value.trim().toLowerCase();
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
		normalized,
	)
		? normalized
		: undefined;
}

function normalizeSessionName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim().replace(/\s+/g, " ").slice(0, 60);
	return trimmed || undefined;
}

export class QQAgentSession {
	// 动态 SDK，运行时类型未知
	private runtime: unknown;
	private disposed = false;
	private cwd = "";
	private sessionDir?: string;
	private persistent = true;
	private outboundDelivery?: QQOutboundDeliveryContext;

	isReady(): boolean {
		return !!this.runtime && !this.disposed;
	}

	isStreaming(): boolean {
		return (
			(this.runtime as { session?: { isStreaming?: boolean } })?.session
				?.isStreaming === true
		);
	}

	/** 创建隔离 runtime；SDK/模型加载失败时抛错 */
	async init(cwd: string, options: QQSessionOptions = {}): Promise<void> {
		this.cwd = cwd;
		this.sessionDir = options.sessionDir;
		this.persistent = options.persistent !== false;
		const sdk = (await loadSdk()) as {
			SettingsManager: {
				create(
					cwd: string,
					agentDir: string,
				): { getGlobalSettings(): { extensions?: unknown } };
				inMemory(settings: Record<string, unknown>): unknown;
			};
			createAgentSessionServices(
				options: Record<string, unknown>,
			): Promise<unknown>;
			createAgentSessionFromServices(
				options: Record<string, unknown>,
			): Promise<Record<string, unknown>>;
			createAgentSessionRuntime(
				factory: (args: Record<string, unknown>) => Promise<unknown>,
				options: Record<string, unknown>,
			): Promise<{
				session: { bindExtensions(options: unknown): Promise<void> };
			}>;
			getAgentDir(): string;
			SessionManager: {
				create(cwd: string, sessionDir?: string): unknown;
				inMemory(cwd?: string): unknown;
				continueRecent(cwd: string, sessionDir?: string): unknown;
				list(cwd: string, sessionDir?: string): Promise<unknown[]>;
			};
		};

		// restore 语义（P1-10 裁决）："recent" = (cwd, sessionDir) 维度下最近会话；
		// M1 曾把 sessionDir 误传为 create 的 cwd 参数，M2 修正为双参数签名
		const sessionManager =
			options.persistent !== false && options.sessionDir
				? options.restore === "recent"
					? sdk.SessionManager.continueRecent(cwd, options.sessionDir)
					: sdk.SessionManager.create(cwd, options.sessionDir)
				: sdk.SessionManager.inMemory(cwd);

		const createRuntime = async ({
			cwd: runtimeCwd,
			agentDir,
			sessionManager: manager,
			sessionStartEvent,
		}: Record<string, unknown>): Promise<unknown> => {
			// 读宿主全局配置一次，QQ 侧所有变更在内存隔离（/model 永不改写本地默认）
			const hostSettings = sdk.SettingsManager.create(
				typeof runtimeCwd === "string" ? runtimeCwd : cwd,
				typeof agentDir === "string" ? agentDir : sdk.getAgentDir(),
			);
			const globalSettings = hostSettings.getGlobalSettings();
			const extensionPaths = Array.isArray(globalSettings.extensions)
				? globalSettings.extensions.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
			const isolatedSettings = sdk.SettingsManager.inMemory({
				...globalSettings,
				extensions: extensionPaths,
			});
			const services = await sdk.createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				settingsManager: isolatedSettings,
				resourceLoaderOptions: {
					// 加载宿主 skills + packages + MCP/插件，但排除 pi-qq-bridge 自身
					extensionsOverride: (base: {
						extensions: Array<{ path?: string; resolvedPath?: string }>;
						errors: unknown[];
						runtime: unknown;
					}) => ({
						...base,
						extensions: base.extensions.filter(
							(extension) =>
								!isPiQQBridgeExtensionPath(extension.path) &&
								!isPiQQBridgeExtensionPath(extension.resolvedPath),
						),
					}),
				},
			});
			const sdkFromServices = sdk as unknown as {
				createAgentSessionFromServices(
					options: Record<string, unknown>,
				): Promise<Record<string, unknown>>;
			};
			return {
				...(await sdkFromServices.createAgentSessionFromServices({
					services,
					sessionManager: manager,
					sessionStartEvent,
					customTools: [this.createOutboundMediaTool(sdk)],
				})),
				services,
			};
		};

		const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: sdk.getAgentDir(),
			sessionManager,
		});
		await runtime.session.bindExtensions({});
		if (this.disposed) {
			await (runtime as unknown as { dispose(): Promise<void> }).dispose();
			return;
		}
		this.runtime = runtime;
	}

	/** 绑定当前回合的出站媒体交付上下文（回合结束由调用方 close） */
	bindOutboundDelivery(context?: QQOutboundDeliveryContext): void {
		this.outboundDelivery = context;
	}

	// biome-ignore lint/suspicious/noExplicitAny: 动态 SDK
	private createOutboundMediaTool(sdk: unknown): unknown {
		const sdkModule = sdk as {
			defineTool(definition: Record<string, unknown>): unknown;
		};
		const qqSession = this;
		return sdkModule.defineTool({
			name: "qq_send_local_file",
			label: "Send Local File to QQ",
			description:
				"Send one real local computer file to the QQ conversation that requested the current task. Use this when the QQ user explicitly asks to send/upload/transfer a local image or file. A local path, Markdown image, or URL in the final answer does not send the file. The target QQ user and reply metadata are securely bound by the plugin; provide only the local path.",
			parameters: Type.Object({
				path: Type.String({
					description:
						"Local file path returned by a tool or explicitly provided by the user",
				}),
			}),
			async execute(_toolCallId: string, params: { path: string }) {
				const delivery = qqSession.outboundDelivery;
				if (!delivery)
					throw new Error(
						"No active QQ delivery context (delivery_context_closed)",
					);
				const { formatBytes } = await import("./outbound-media.ts");
				const record = await delivery.sendLocalFile(params.path, "auto");
				return {
					content: [
						{
							type: "text",
							text: `QQ API 已确认发送${record.kind === "image" ? "图片" : "文件"} ${record.filename}（${formatBytes(record.bytes)}）。`,
						},
					],
					details: {
						filename: record.filename,
						kind: record.kind,
						bytes: record.bytes,
						status: record.status,
					},
				};
			},
		});
	}

	/** 运行一次 prompt 到完成（调用方负责串行化）。返回最终文本与工具记录。 */
	async run(
		prompt: string,
		options: {
			images?: import("./types.ts").QQImageContent[];
			observer?: QQAgentRunObserver;
		} = {},
	): Promise<QQRunResult> {
		const { images, observer } = options;
		const session = (this.runtime as { session: unknown }).session;
		if (!session) throw new Error("QQ 会话未初始化");
		const tools: QQRunResult["tools"] = [];
		const toolIndexes = new Map<string, number>();
		let messages: unknown[] = [];
		const emit = (event: QQAgentRunEvent): void => {
			try {
				observer?.(event);
			} catch {
				// 观察者失败绝不影响 agent 运行
			}
		};
		const unsubscribe = (
			session as { subscribe(listener: (event: unknown) => void): () => void }
		).subscribe(
			// biome-ignore lint/suspicious/noExplicitAny: 事件联合类型来自动态 SDK
			(event: any) => {
				if (event?.type === "agent_start") {
					emit({ kind: "agent_start" });
				} else if (
					event?.type === "message_update" &&
					event.assistantMessageEvent?.type === "text_delta"
				) {
					const delta = event.assistantMessageEvent.delta;
					if (typeof delta === "string" && delta)
						emit({ kind: "assistant_delta", delta });
				} else if (
					event?.type === "message_update" &&
					event.assistantMessageEvent?.type === "text_end"
				) {
					emit({ kind: "assistant_end" });
				} else if (event?.type === "tool_execution_start") {
					const toolCallId =
						typeof event.toolCallId === "string"
							? event.toolCallId
							: `tool-${tools.length}`;
					const toolName =
						typeof event.toolName === "string" ? event.toolName : "tool";
					toolIndexes.set(toolCallId, tools.length);
					tools.push({
						toolCallId,
						name: toolName,
						args: event.args,
						isError: false,
					});
					emit({ kind: "tool_start", toolName });
				} else if (event?.type === "tool_execution_end") {
					const toolCallId =
						typeof event.toolCallId === "string" ? event.toolCallId : "";
					const index = toolIndexes.get(toolCallId);
					if (index !== undefined) tools[index]!.isError = !!event.isError;
					const toolName =
						typeof event.toolName === "string" ? event.toolName : "tool";
					emit({ kind: "tool_end", toolName, isError: !!event.isError });
				} else if (event?.type === "agent_end") {
					if (Array.isArray(event.messages)) messages = event.messages;
				}
			},
		);
		try {
			await (
				session as {
					prompt(
						prompt: string,
						options: Record<string, unknown>,
					): Promise<void>;
				}
			).prompt(prompt, {
				source: "extension",
				...(images && images.length ? { images } : {}),
			});
		} finally {
			unsubscribe();
		}
		const { extractFinalAssistantText } = await import("./user-facing.ts");
		return { text: extractFinalAssistantText(messages), tools };
	}

	// ── 会话管理（M2 命令体系） ────────────────────────────────────

	/** 当前模型 */
	currentModel(): QQModelInfo | undefined {
		return toModelInfo(
			(this.runtime as { session?: { model?: unknown } })?.session?.model,
		);
	}

	/** 可用模型（已配置认证） */
	async availableModels(): Promise<QQModelInfo[]> {
		const models = await this.getAvailableModelEntries();
		return models
			.map(toModelInfo)
			.filter((value): value is QQModelInfo => !!value);
	}

	/** 切换模型（仅接受 availableModels 中的模型） */
	async setModel(provider: string, modelId: string): Promise<QQModelInfo> {
		const model = (await this.getAvailableModelEntries()).find((available) => {
			const info = toModelInfo(available);
			return info?.provider === provider && info.id === modelId;
		});
		if (!model)
			throw new Error(`模型不存在或当前未配置认证：${provider}/${modelId}`);
		await this.requireSession().setModel(model);
		const current = this.currentModel();
		if (!current) throw new Error("模型切换后无法读取当前模型");
		return current;
	}

	thinkingLevel(): string {
		const level = (this.runtime as { session?: { thinkingLevel?: unknown } })
			?.session?.thinkingLevel;
		return typeof level === "string" ? level : "off";
	}

	availableThinkingLevels(): string[] {
		const levels = (
			this.runtime as { session?: { getAvailableThinkingLevels?(): unknown } }
		)?.session?.getAvailableThinkingLevels?.();
		if (!Array.isArray(levels)) return ["off"];
		return [
			...new Set(
				levels
					.filter((level): level is string => typeof level === "string")
					.map(normalizeThinkingLevel)
					.filter((level): level is string => level !== undefined),
			),
		];
	}

	setThinkingLevel(level: string): string {
		const normalized = normalizeThinkingLevel(level);
		const available = this.availableThinkingLevels();
		if (!normalized || !available.includes(normalized)) {
			throw new Error(
				`当前模型不支持思考等级“${level}”；可选：${available.join("、")}`,
			);
		}
		this.requireSession().setThinkingLevel(normalized);
		return this.thinkingLevel();
	}

	/** 新建会话（保留旧会话历史） */
	async newSession(name?: string): Promise<{ id: string; name?: string }> {
		this.assertIdle("新建会话");
		const result = await this.requireRuntime().newSession();
		if (result?.cancelled) throw new Error("新建 QQ 会话已取消");
		const normalizedName = normalizeSessionName(name);
		if (normalizedName)
			this.requireSession().sessionManager?.appendSessionInfo?.(normalizedName);
		return {
			id: this.sessionId(),
			...(normalizedName ? { name: normalizedName } : {}),
		};
	}

	/** 列出历史会话（仅当前对话作用域） */
	async listSessions(): Promise<QQSessionInfo[]> {
		if (!this.persistent || !this.sessionDir) return [];
		const sdk = (await loadSdk()) as {
			SessionManager: {
				list(cwd: string, sessionDir?: string): Promise<unknown[]>;
			};
		};
		const sessions = await sdk.SessionManager.list(this.cwd, this.sessionDir);
		return sessions as QQSessionInfo[];
	}

	/** 恢复会话（仅允许本对话作用域内的会话） */
	async resumeSession(path: string): Promise<{ id: string; name?: string }> {
		this.assertIdle("恢复会话");
		const allowed = await this.listSessions();
		const target = allowed.find((session) => session.path === path);
		if (!target) throw new Error("目标 QQ 会话不存在或不属于当前对话");
		const result = await this.requireRuntime().switchSession(target.path);
		if (result?.cancelled) throw new Error("恢复 QQ 会话已取消");
		return {
			id: this.sessionId(),
			...(this.sessionName() ? { name: this.sessionName() } : {}),
		};
	}

	setSessionName(name: string): string {
		const normalized = normalizeSessionName(name);
		if (!normalized) throw new Error("会话名称不能为空");
		this.requireSession().sessionManager?.appendSessionInfo?.(normalized);
		return normalized;
	}

	sessionId(): string {
		const id = (this.runtime as { session?: { sessionId?: unknown } })?.session
			?.sessionId;
		return typeof id === "string" ? id : "";
	}

	sessionName(): string | undefined {
		const name = (
			this.runtime as {
				session?: { sessionManager?: { getSessionName?(): unknown } };
			}
		)?.session?.sessionManager?.getSessionName?.();
		return typeof name === "string" && name ? name : undefined;
	}

	async compact(instructions?: string): Promise<{ tokensBefore?: number }> {
		this.assertIdle("压缩会话");
		const result = await this.requireSession().compact(
			instructions?.trim() || undefined,
		);
		return {
			tokensBefore:
				typeof result?.tokensBefore === "number"
					? result.tokensBefore
					: undefined,
		};
	}

	/** 中止当前运行（/stop 用） */
	async abort(): Promise<void> {
		try {
			await (
				this.runtime as { session?: { abort?(): Promise<void> } }
			)?.session?.abort?.();
		} catch {
			// 中止错误在停机路径忽略
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const runtime = this.runtime as
			| { dispose?: () => Promise<void> }
			| undefined;
		if (runtime?.dispose) {
			try {
				await runtime.dispose();
			} catch {
				// 释放失败不阻塞
			}
		}
		this.runtime = undefined;
	}

	private async getAvailableModelEntries(): Promise<unknown[]> {
		const services = (this.runtime as { services?: unknown })?.services as
			| {
					modelRuntime?: { getAvailable?(): Promise<unknown> };
					modelRegistry?: { getAvailable?(): Promise<unknown> };
			  }
			| undefined;
		const models =
			typeof services?.modelRuntime?.getAvailable === "function"
				? await services.modelRuntime.getAvailable()
				: typeof services?.modelRegistry?.getAvailable === "function"
					? await services.modelRegistry.getAvailable()
					: [];
		return Array.isArray(models) ? models : [];
	}

	private requireRuntime(): {
		newSession(): Promise<{ cancelled?: boolean }>;
		switchSession(path: string): Promise<{ cancelled?: boolean }>;
	} {
		if (!this.runtime || this.disposed)
			throw new Error("QQ 会话运行时未初始化");
		return this.runtime as {
			newSession(): Promise<{ cancelled?: boolean }>;
			switchSession(path: string): Promise<{ cancelled?: boolean }>;
		};
	}

	private requireSession(): {
		setModel(model: unknown): Promise<void>;
		setThinkingLevel(level: string): void;
		compact(instructions?: string): Promise<{ tokensBefore?: number }>;
		abort?(): Promise<void>;
		sessionManager?: {
			appendSessionInfo?(name: string): void;
			getSessionName?(): unknown;
		};
	} {
		return (this.requireRuntime() as unknown as { session: unknown })
			.session as {
			setModel(model: unknown): Promise<void>;
			setThinkingLevel(level: string): void;
			compact(instructions?: string): Promise<{ tokensBefore?: number }>;
			abort?(): Promise<void>;
			sessionManager?: {
				appendSessionInfo?(name: string): void;
				getSessionName?(): unknown;
			};
		};
	}

	private assertIdle(action: string): void {
		if (this.isStreaming())
			throw new Error(`当前 QQ 任务仍在执行，无法${action}；请先发送 /stop`);
	}
}

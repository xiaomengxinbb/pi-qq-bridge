/**
 * 隔离 AgentSession（spec §6.5 / §5.2）
 *
 * 每个 QQ 对话一个独立、持久的 AgentSessionRuntime：
 * - 加载宿主 skills/MCP/插件，但排除 pi-qq-bridge 自身（防递归）
 * - 会话文件在 QQ 专属目录，绝不进入本地 TUI 会话列表
 * - run()：subscribe 事件流 → prompt → agent_end 时提取最终 assistant 文本
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
		if (index >= 0) return `${normalized.slice(0, index + SDK_MARKER.length)}/dist/index.js`;
	}
	throw new Error("cannot locate pi SDK from process.argv[1]");
}

/** 本扩展路径特征（排除自身防递归时匹配） */
export function isPiQQBridgeExtensionPath(path: string | undefined): boolean {
	if (!path) return false;
	const normalized = path.replaceAll("\\", "/");
	return normalized.includes("pi-qq-bridge") || normalized.includes("qq-bridge");
}

type SdkModule = Record<string, unknown>;

let sdkPromise: Promise<SdkModule> | undefined;

function loadSdk(): Promise<SdkModule> {
	if (!sdkPromise) sdkPromise = import(pathToFileURL(resolveSdkEntry()).href) as Promise<SdkModule>;
	return sdkPromise;
}

/** 一次 agent 运行的结果 */
export interface QQRunResult {
	text: string;
	/** 工具调用记录（M2 showProcess 用） */
	tools: { toolCallId: string; name: string; args: unknown; isError: boolean }[];
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

export class QQAgentSession {
	// 动态 SDK，运行时类型未知
	private runtime: unknown;
	private disposed = false;

	isReady(): boolean {
		return !!this.runtime && !this.disposed;
	}

	isStreaming(): boolean {
		return (this.runtime as { session?: { isStreaming?: boolean } })?.session?.isStreaming === true;
	}

	/** 创建隔离 runtime；SDK/模型加载失败时抛错 */
	async init(cwd: string, options: QQSessionOptions = {}): Promise<void> {
		const sdk = (await loadSdk()) as {
			SettingsManager: {
				create(cwd: string, agentDir: string): { getGlobalSettings(): { extensions?: unknown } };
				inMemory(settings: Record<string, unknown>): unknown;
			};
			createAgentSessionServices(options: Record<string, unknown>): Promise<unknown>;
			createAgentSessionFromServices(options: Record<string, unknown>): Promise<Record<string, unknown>>;
			createAgentSessionRuntime(
				factory: (args: Record<string, unknown>) => Promise<unknown>,
				options: Record<string, unknown>,
			): Promise<{ session: { bindExtensions(options: unknown): Promise<void> } }>;
			getAgentDir(): string;
			SessionManager: {
				create(dir: string): unknown;
				inMemory(): unknown;
			};
		};

		const sessionManager =
			options.persistent !== false && options.sessionDir
				? sdk.SessionManager.create(options.sessionDir)
				: sdk.SessionManager.inMemory();

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
				? globalSettings.extensions.filter((value): value is string => typeof value === "string")
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
				createAgentSessionFromServices(options: Record<string, unknown>): Promise<Record<string, unknown>>;
			};
			return {
				...(await sdkFromServices.createAgentSessionFromServices({
					services,
					sessionManager: manager,
					sessionStartEvent,
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

	/** 运行一次 prompt 到完成（调用方负责串行化）。返回最终文本与工具记录。 */
	async run(prompt: string, observer?: QQAgentRunObserver): Promise<QQRunResult> {
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
		const unsubscribe = (session as { subscribe(listener: (event: unknown) => void): () => void }).subscribe(
			// biome-ignore lint/suspicious/noExplicitAny: 事件联合类型来自动态 SDK
			(event: any) => {
				if (event?.type === "agent_start") {
					emit({ kind: "agent_start" });
				} else if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					const delta = event.assistantMessageEvent.delta;
					if (typeof delta === "string" && delta) emit({ kind: "assistant_delta", delta });
				} else if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_end") {
					emit({ kind: "assistant_end" });
				} else if (event?.type === "tool_execution_start") {
					const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `tool-${tools.length}`;
					const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
					toolIndexes.set(toolCallId, tools.length);
					tools.push({ toolCallId, name: toolName, args: event.args, isError: false });
					emit({ kind: "tool_start", toolName });
				} else if (event?.type === "tool_execution_end") {
					const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
					const index = toolIndexes.get(toolCallId);
					if (index !== undefined) tools[index]!.isError = !!event.isError;
					const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
					emit({ kind: "tool_end", toolName, isError: !!event.isError });
				} else if (event?.type === "agent_end") {
					if (Array.isArray(event.messages)) messages = event.messages;
				}
			},
		);
		try {
			await (session as { prompt(prompt: string, options: Record<string, unknown>): Promise<void> }).prompt(
				prompt,
				{ source: "extension" },
			);
		} finally {
			unsubscribe();
		}
		const { extractFinalAssistantText } = await import("./user-facing.ts");
		return { text: extractFinalAssistantText(messages), tools };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const runtime = this.runtime as { dispose?: () => Promise<void> } | undefined;
		if (runtime?.dispose) {
			try {
				await runtime.dispose();
			} catch {
				// 释放失败不阻塞
			}
		}
		this.runtime = undefined;
	}
}

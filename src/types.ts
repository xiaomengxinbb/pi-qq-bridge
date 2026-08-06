/** 公共类型（M0 最小集，M1 扩展） */

/** 入站消息（QQGateway 归一化输出，M1 使用） */
export interface QQInboundMessage {
	id: string;
	type: "private" | "group";
	text: string;
	userOpenId: string;
	groupOpenId?: string;
	attachments: QQAttachment[];
	receivedAt: number;
	raw?: unknown;
}

/** 入站附件（来自事件 attachments[]，M1 使用） */
export interface QQAttachment {
	url: string;
	filename: string;
	size: number;
	contentType: string;
	width?: number;
	height?: number;
	/** 语音附件：QQ ASR 文本 */
	asrReferText?: string;
}

/** 网关状态(/qqbot-status 展示) */
export type QQGatewayState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

/** 被动回复目标(发送时引用原消息 msg_id) */
export interface QQReplyTarget {
	type: "private" | "group";
	userOpenId?: string;
	groupOpenId?: string;
	msgId: string;
}

/** 网关状态变化回调 */
export type QQGatewayStateListener = (
	state: QQGatewayState,
	info?: string,
) => void;

/** 入站消息回调（M1 接入 router） */
export type QQInboundListener = (msg: QQInboundMessage) => void;

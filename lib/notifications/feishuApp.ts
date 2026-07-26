export const FEISHU_RECEIVE_ID_TYPES = ["chat_id", "open_id", "user_id", "union_id", "email"] as const;

export type FeishuReceiveIdType = typeof FEISHU_RECEIVE_ID_TYPES[number];

export function normalizeFeishuReceiveIdType(value: string | undefined): FeishuReceiveIdType {
  return FEISHU_RECEIVE_ID_TYPES.includes(value as FeishuReceiveIdType)
    ? value as FeishuReceiveIdType
    : "chat_id";
}

export function validFeishuAppId(value: string | null) {
  return Boolean(value && /^cli_[A-Za-z0-9]+$/.test(value));
}

export function validFeishuReceiveId(value: string | null, type: FeishuReceiveIdType) {
  if (!value) return false;
  if (type === "chat_id") return /^oc_[A-Za-z0-9_-]+$/.test(value);
  if (type === "open_id") return /^ou_[A-Za-z0-9_-]+$/.test(value);
  if (type === "union_id") return /^on_[A-Za-z0-9_-]+$/.test(value);
  if (type === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return value.length > 0;
}

export function feishuAppMessageUrl(type: FeishuReceiveIdType) {
  return `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(type)}`;
}

export function buildFeishuAppMessage(
  receiveId: string,
  card: Record<string, unknown>,
) {
  return {
    receive_id: receiveId,
    msg_type: "interactive",
    content: JSON.stringify(card),
  };
}

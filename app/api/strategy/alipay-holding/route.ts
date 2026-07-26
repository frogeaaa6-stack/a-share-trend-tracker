import { ALIPAY_HOLDING_BUDGET, ALIPAY_HOLDING_MAX_JSON_BYTES, ALIPAY_LINKED_FUND_CODE, alipayHoldingFingerprint, alipayHoldingPayloadWithinLimit, normalizeAlipayHoldingDraft, reconcileAlipayHolding, trustedAlipayHoldingOrigin, type AlipayHoldingSnapshot } from "@/lib/strategy/alipayHoldingImport";
import { getAlipayHoldingSnapshotState, insertAlipayHoldingSnapshot } from "@/lib/strategy/alipayHoldingPersistence";

export const dynamic = "force-dynamic";
class HoldingRequestError extends Error { constructor(message: string, readonly code: string, readonly status: number) { super(message); } }
function localRequest(request: Request) { return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(new URL(request.url).hostname); }
function trustedLocalJsonRequest(request: Request) {
  if (!localRequest(request) || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
  return trustedAlipayHoldingOrigin(request.url, request.headers.get("origin"));
}
function payload(snapshots: AlipayHoldingSnapshot[], ledgerVersion: number) {
  const current = snapshots[0] ?? null;
  const reconciliation = current ? reconcileAlipayHolding(current) : null;
  return { fundCode: ALIPAY_LINKED_FUND_CODE, capitalBudget: ALIPAY_HOLDING_BUDGET, ledgerVersion, snapshots, current: current && { ...current, verificationStatus: reconciliation!.status }, reconciliation, readOnlyBoundary: "只读取用户主动提供的数据；不登录支付宝、不读取账号/密码/Cookie/验证码、不申购、不赎回、不发送订单。" };
}
export async function GET(request: Request) {
  if (!localRequest(request)) return Response.json({ code: "LOCAL_ONLY", error: "持仓快照只允许从本机访问" }, { status: 403 });
  try { const { snapshots, ledgerVersion } = await getAlipayHoldingSnapshotState(); return Response.json(payload(snapshots, ledgerVersion), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return Response.json({ code: "ALIPAY_HOLDING_UNAVAILABLE", error: error instanceof Error ? error.message : "持仓快照暂不可用" }, { status: 503 }); }
}
export async function POST(request: Request) {
  if (!trustedLocalJsonRequest(request)) return Response.json({ code: "LOCAL_JSON_ONLY", error: "持仓导入只允许本机同源 JSON 请求" }, { status: 403 });
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength > ALIPAY_HOLDING_MAX_JSON_BYTES) throw new HoldingRequestError("导入请求超过 16 KB 限制", "PAYLOAD_TOO_LARGE", 413);
    const text = await request.text();
    if (!alipayHoldingPayloadWithinLimit(text)) throw new HoldingRequestError("导入请求超过 16 KB 限制", "PAYLOAD_TOO_LARGE", 413);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (body.action !== "confirm") throw new HoldingRequestError("预览在浏览器本地完成；服务器只接受明确确认写入", "PREVIEW_ONLY", 400);
    const expectedLedgerVersion = Number(body.expectedLedgerVersion);
    if (!Number.isInteger(expectedLedgerVersion) || expectedLedgerVersion < 0) throw new Error("快照版本无效，请刷新页面后重试");
    const draft = normalizeAlipayHoldingDraft(body);
    const { snapshots, ledgerVersion } = await getAlipayHoldingSnapshotState();
    const contentFingerprint = alipayHoldingFingerprint(draft);
    const fileHashMatch = draft.fileHash ? snapshots.find((snapshot) => snapshot.fileHash === draft.fileHash) : null;
    if (fileHashMatch && fileHashMatch.contentFingerprint !== contentFingerprint) throw new HoldingRequestError("相同文件哈希对应的结构化内容不同，已拒绝覆盖历史快照", "HOLDING_CONFLICT", 409);
    if (snapshots.some((snapshot) => snapshot.contentFingerprint === contentFingerprint)) return Response.json({ ...payload(snapshots, ledgerVersion), idempotentReplay: true });
    if (expectedLedgerVersion !== ledgerVersion) throw new HoldingRequestError("持仓快照已更新，请刷新后重试", "HOLDING_CHANGED", 409);
    const snapshot: AlipayHoldingSnapshot = { ...draft, contentFingerprint, id: typeof body.idempotencyKey === "string" && /^[0-9a-f-]{36}$/i.test(body.idempotencyKey) ? body.idempotencyKey : crypto.randomUUID(), createdAt: new Date().toISOString() };
    const inserted = await insertAlipayHoldingSnapshot(snapshot, expectedLedgerVersion);
    if (!inserted) { const latest = await getAlipayHoldingSnapshotState(); const replay = latest.snapshots.find((entry) => entry.contentFingerprint === snapshot.contentFingerprint); if (replay) return Response.json({ ...payload(latest.snapshots, latest.ledgerVersion), idempotentReplay: true }); throw new HoldingRequestError("持仓快照刚刚发生变化，请刷新后重试", "HOLDING_CHANGED", 409); }
    return Response.json(payload([snapshot, ...snapshots], expectedLedgerVersion + 1), { status: 201 });
  } catch (error) { const known = error instanceof HoldingRequestError ? error : null; return Response.json({ code: known?.code ?? "INVALID_ALIPAY_HOLDING", error: error instanceof Error ? error.message : "无法确认导入" }, { status: known?.status ?? 400 }); }
}

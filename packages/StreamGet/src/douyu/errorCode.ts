const MISSING_ERROR_CODE = "missing";
const MSG_MAX_LENGTH = 120;

function isDouyuErrorCodeMissing(error: unknown): boolean {
  return error === undefined || error === null || error === "";
}

function readPlayMessage(msg: unknown): string {
  if (typeof msg !== "string") return "";
  const trimmed = msg.trim();
  if (!trimmed) return "";
  if (trimmed.length <= MSG_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, MSG_MAX_LENGTH)}...`;
}

export function formatDouyuUnexpectedErrorCode(error: unknown, msg?: unknown): string {
  const detail = isDouyuErrorCodeMissing(error) ? MISSING_ERROR_CODE : String(error);
  const text = readPlayMessage(msg);
  return text ? `${detail}, ${text}` : detail;
}

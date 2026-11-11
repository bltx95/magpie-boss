import { createHash } from "node:crypto";

const LOCAL_DAY = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric", month: "2-digit", day: "2-digit",
});
const PAGE_SIZE = 500;

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const hasId = (value) => typeof value === "string" && value.length > 0;
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const localDay = (time) => LOCAL_DAY.format(time);

export function toUsage(row, enabledAt) {
  const timestamp = Date.parse(row?.t);
  if (!Number.isFinite(timestamp) || timestamp < enabledAt ||
    row.handed_on || row.handedOn || row.purpose) return null;
  const tokens = count(row.in) + count(row.out) + count(row.cache_read) + count(row.cache_write);
  const responseKey = row.agent === "codex" && hasId(row.response_id)
    ? digest(`codex-response:${row.response_id}`) : null;
  // Session-file entries have usage from a completed Codex response but no HTTP status.
  const codexLog = row.source === "log" && responseKey && hasId(row.session) && row.status === 0 && tokens > 0;
  const requestId = hasId(row.rid) ? `rid:${row.rid}`
    : count(row.route_id) ? `route:${row.route_id}:${row.t}` : null;
  if (!requestId && !codexLog) return null;
  return {
    id: requestId ? digest(requestId) : responseKey,
    day: localDay(timestamp),
    tokens,
    success: !row.err && (Boolean(codexLog) || (row.status >= 200 && row.status < 300)),
    responseKey,
  };
}

export async function readUsagePage(baseUrl, period, offset, fetcher = fetch) {
  const url = new URL("/v1/magpie/usage/requests", baseUrl);
  url.search = new URLSearchParams({ period, offset: String(offset), limit: String(PAGE_SIZE) });
  const response = await fetcher(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
  if (!response.ok) throw new Error("Magpie 用量接口暂不可用");
  const page = await response.json();
  if (!Array.isArray(page.rows)) throw new Error("Magpie 用量格式不兼容");
  return { rows: page.rows, hasMore: offset + page.rows.length < page.total && page.rows.length > 0 };
}

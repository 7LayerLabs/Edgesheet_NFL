/**
 * Telegram Bot API client. Server-only, no packages: plain fetch against
 * https://api.telegram.org. Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from
 * the environment. When either is missing, `telegramReady()` is false and
 * `sendMessage` throws a clear error so callers can degrade gracefully.
 *
 * Telegram limits one message to 4096 characters; long digests are split on
 * line boundaries and sent in order. Every send is retried once on failure.
 */

const API = "https://api.telegram.org";
export const TELEGRAM_LIMIT = 4096;

export function telegramToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN || undefined;
}

export function telegramChatId(): string | undefined {
  return process.env.TELEGRAM_CHAT_ID || undefined;
}

/** Both the bot token and the destination chat id are set. */
export function telegramReady(): boolean {
  return Boolean(telegramToken() && telegramChatId());
}

/** What is missing, in plain words, for the UI. */
export function telegramMissing(): string | undefined {
  if (!telegramToken() && !telegramChatId()) return "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set in .env.local.";
  if (!telegramToken()) return "TELEGRAM_BOT_TOKEN is not set in .env.local.";
  if (!telegramChatId()) return "TELEGRAM_CHAT_ID is not set in .env.local. Run node scripts/telegram-chat-id.mjs after messaging the bot.";
  return undefined;
}

/** Escape text for Telegram's HTML parse mode. Only &, < and > need escaping. */
export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split a message on line boundaries so no chunk exceeds the Telegram limit. */
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    // A single line longer than the limit is hard-cut.
    if (line.length > limit) {
      if (cur) out.push(cur);
      cur = "";
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > limit) {
      out.push(cur);
      cur = line;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

export interface SendOptions {
  parseMode?: "HTML" | "MarkdownV2";
  /** Override the destination (defaults to TELEGRAM_CHAT_ID). Used for command replies. */
  chatId?: string | number;
  disablePreview?: boolean;
  silent?: boolean;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

async function call<T>(method: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
  const token = telegramToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  let res: Response | undefined;
  let err: unknown;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    err = e;
  }
  let json: TgResponse<T> | undefined;
  if (res) json = (await res.json().catch(() => undefined)) as TgResponse<T> | undefined;
  if (json?.ok) return json.result as T;
  // Retry once: network error, 5xx, or a rate-limit with a short retry_after.
  const retryAfter = json?.parameters?.retry_after ?? 0;
  const status = res?.status ?? 0;
  const retriable = !res || status >= 500 || (status === 429 && retryAfter <= 10);
  if (attempt === 0 && retriable) {
    await new Promise((r) => setTimeout(r, Math.max(1000, retryAfter * 1000)));
    return call<T>(method, body, 1);
  }
  const why = json?.description ?? (err instanceof Error ? err.message : `HTTP ${status}`);
  throw new Error(`Telegram ${method} failed: ${why}`);
}

export interface SentMessage {
  message_id: number;
  chat: { id: number };
}

/**
 * Send one message (split into several if over the limit). `text` is assumed
 * to already be HTML-formatted when parseMode is HTML; escape user data with
 * `escapeHtml` before interpolating it.
 */
export async function sendMessage(text: string, opts: SendOptions = {}): Promise<SentMessage[]> {
  const chatId = opts.chatId ?? telegramChatId();
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");
  const sent: SentMessage[] = [];
  for (const chunk of splitMessage(text)) {
    const body: Record<string, unknown> = { chat_id: chatId, text: chunk, disable_web_page_preview: opts.disablePreview ?? true };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.silent) body.disable_notification = true;
    sent.push(await call<SentMessage>("sendMessage", body));
  }
  return sent;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
    from?: { id: number; username?: string; first_name?: string };
  };
}

/** Long-poll for updates. `timeoutSeconds` is how long Telegram holds the request open. */
export async function getUpdates(offset?: number, timeoutSeconds = 30): Promise<TgUpdate[]> {
  const body: Record<string, unknown> = { timeout: timeoutSeconds, allowed_updates: ["message"] };
  if (offset !== undefined) body.offset = offset;
  return call<TgUpdate[]>("getUpdates", body);
}

export async function getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
  return call("getMe", {});
}

/* ------------------------------------------------------------- photos */

export interface PhotoOptions {
  chatId?: string | number;
  parseMode?: "HTML" | "MarkdownV2";
  silent?: boolean;
}

/**
 * Send a local image file as a Telegram photo with an optional caption
 * (1024 characters max; longer captions are cut). Multipart upload with
 * fetch and FormData, no packages. Retried once on failure.
 */
export async function sendPhoto(filePath: string, caption?: string, opts: PhotoOptions = {}): Promise<SentMessage> {
  const token = telegramToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const chatId = opts.chatId ?? telegramChatId();
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");
  const { readFileSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const bytes = readFileSync(filePath);
  const send = async (): Promise<SentMessage> => {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/png" }), basename(filePath));
    if (caption) form.append("caption", caption.length > 1024 ? `${caption.slice(0, 1021)}...` : caption);
    if (opts.parseMode) form.append("parse_mode", opts.parseMode);
    if (opts.silent) form.append("disable_notification", "true");
    const res = await fetch(`${API}/bot${token}/sendPhoto`, { method: "POST", body: form });
    const json = (await res.json().catch(() => undefined)) as TgResponse<SentMessage> | undefined;
    if (json?.ok && json.result) return json.result;
    throw new Error(`Telegram sendPhoto failed: ${json?.description ?? `HTTP ${res.status}`}`);
  };
  try {
    return await send();
  } catch (first) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await send();
    } catch {
      throw first;
    }
  }
}

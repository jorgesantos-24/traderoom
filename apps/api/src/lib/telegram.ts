// Minimal Telegram Bot API client: sends HTML messages to a channel the bot administers.

export interface TelegramClient {
  /** Returns the message id. Throws on any API error. */
  send(text: string, opts?: { replyTo?: number | null }): Promise<number>;
}

export function createTelegram(opts: { token: string; chatId: string; fetch?: typeof fetch; timeoutMs?: number }): TelegramClient {
  const f = opts.fetch ?? fetch;
  const url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
  return {
    async send(text, o = {}) {
      const body: Record<string, unknown> = {
        chat_id: opts.chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      };
      if (o.replyTo) body.reply_parameters = { message_id: o.replyTo, allow_sending_without_reply: true };
      const res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
      if (!res.ok || !json?.ok || typeof json.result?.message_id !== 'number') {
        // Never include the URL: it carries the bot token.
        throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${json?.description ?? ''}`.trim());
      }
      return json.result.message_id;
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const API = 'https://api.telegram.org/bot'

async function call(env, method, payload) {
  let json = { ok: false }
  try {
    const res = await fetch(`${env.TELEGRAM_API_BASE || API}${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    json = await res.json().catch(() => ({ ok: false }))
  } catch (err) {
    json = { ok: false, error: String(err) }
  }
  if (!json.ok) console.error('telegram', method, JSON.stringify(json))
  return json
}

export async function send(env, text, chatId = env.TELEGRAM_CHAT_ID) {
  const json = await call(env, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
  })
  return json.result?.message_id ?? null
}

// Progress is an edit of one message, not a stream of new ones.
export async function edit(env, messageId, text, chatId = env.TELEGRAM_CHAT_ID) {
  if (!messageId) return send(env, text, chatId)
  await call(env, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
  })
  return messageId
}

// Telegram echoes the secret it was registered with. A request without it is
// not from Telegram and never reaches the command parser.
export function webhookAuthentic(request, env) {
  const got = request.headers.get('x-telegram-bot-api-secret-token')
  const want = env.TELEGRAM_WEBHOOK_SECRET
  if (!want || !got || got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

// "/cold-start vultr 123456" -> { cmd, args, code }
export function parseCommand(text) {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0 || !parts[0].startsWith('/')) return null
  const cmd = parts[0].split('@')[0].slice(1).toLowerCase()
  const rest = parts.slice(1)
  const last = rest[rest.length - 1]
  const code = /^[0-9]{6}$/.test(last ?? '') ? rest.pop() : null
  return { cmd, args: rest, code }
}

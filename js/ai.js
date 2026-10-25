// Claude API called straight from the phone with the user's own key (kept only on this device).
import { state } from './store.js';

export function hasAI() { return !!state.settings.claudeKey; }

/** shown when an AI feature is tapped without a key: explains and opens the settings */
export function needAI(feature) {
  if (hasAI()) return false;
  const d = document.getElementById('aiNeedDlg');
  if (!d?.showModal) { alert(`${feature}を使うには、設定でご自分のClaude APIキーを入れてください。`); return true; }
  d.querySelector('[data-feature]').textContent = feature;
  d.showModal();
  return true;
}

/** errors from the API, in words a golfer can act on */
export function aiErrorText(status, apiMsg = '') {
  const m = String(apiMsg);
  if (status === 401) return 'APIキーが正しくありません。コピーし直して、設定に貼り付けてください。';
  if (status === 403) return 'このAPIキーでは使えません。Anthropicの管理画面でキーの権限を確認してください。';
  if (/credit balance|billing|purchase credits/i.test(m)) return 'Anthropicのクレジット残高がありません。管理画面の「Billing」でチャージしてください。';
  if (status === 429) return /limit/i.test(m) && /month|spend/i.test(m) ? '設定した月の上限額に達しました。管理画面の「Limits」で上限を確認してください。' : '混み合っています。少し待ってからもう一度お試しください。';
  if (status === 529 || status === 503) return 'AIが混み合っています。少し待ってからもう一度お試しください。';
  return m || `エラーが発生しました（HTTP ${status}）`;
}

/** a tiny request to check that the key works (costs a fraction of a yen) */
export async function testKey(key) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'OK' }] }),
  });
  if (r.ok) return { ok: true };
  let msg = ''; try { msg = (await r.json()).error?.message || ''; } catch {}
  return { ok: false, text: aiErrorText(r.status, msg) };
}

/** images: base64 JPEG strings (no data: prefix) sent before the text */
export async function askClaude({ system, prompt, images = [], maxTokens = 1800, onText }) {
  const key = state.settings.claudeKey;
  if (!key) throw new Error('設定で Claude の APIキーを入力してください');
  const content = images.length
    ? [...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })), { type: 'text', text: prompt }]
    : prompt;
  const body = {
    model: state.settings.model || 'claude-sonnet-5-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    stream: !!onText,
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = '';
    try { const j = await r.json(); msg = j.error?.message || ''; } catch {}
    throw new Error(aiErrorText(r.status, msg));
  }
  if (!onText) {
    const j = await r.json();
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  // streaming (server-sent events)
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; onText(text); }
        if (ev.type === 'error') throw new Error(ev.error?.message || 'AIエラー');
      } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    }
  }
  return text;
}

export const COACH_SYSTEM = `あなたは日本のゴルフ場に詳しい、優しく的確なゴルフコーチ兼キャディです。
アマチュアゴルファーに日本語で答えます。専門用語は短く補足し、具体的な数字（ヤード、番手、%）で話します。
見出し（###）と箇条書きを使い、スマホで読みやすく簡潔にまとめます。データにない事実は作らず、推測は推測と書きます。`;

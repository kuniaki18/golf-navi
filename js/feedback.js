// Feedback to the developer: emailed via FormSubmit (free, no account; the address owner confirmed once). No other copy is kept.
import { $, toast, esc } from './util.js';
import { state } from './store.js';

// assembled at runtime so simple address scrapers don't pick it up from the source
const TO = ['kuniaki0512', 'outlook.jp'].join('@');
const APP_VERSION = '2.5';

export function initFeedback() {
  $('#fbSend').onclick = send;
  $('#fbMail').href = `mailto:${TO}?subject=${encodeURIComponent('KUNIKUNIゴルフ ご意見')}`;
  $('#fbMailAddr').textContent = TO;
}

async function send() {
  const text = $('#fbText').value.trim();
  if (text.length < 3) { toast('ご意見を入力してください'); return; }
  const type = $('#fbType').value;
  const name = $('#fbName').value.trim() || state.settings.name || '名前なし';
  const contact = $('#fbContact').value.trim();
  const info = `アプリ v${APP_VERSION} / ${state.course?.name || 'コース未選択'} / ${navigator.userAgent.slice(0, 120)}`;
  const btn = $('#fbSend'); btn.disabled = true; $('#fbStatus').textContent = '送信中…';
  const mail = fetch(`https://formsubmit.co/ajax/${TO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ _subject: `【KUNIKUNIゴルフ】${type}（${name}）`, _template: 'table', _captcha: 'false', 種類: type, 名前: name, 連絡先: contact || '（なし）', 内容: text, 端末情報: info, ...(contact.includes('@') ? { _replyto: contact } : {}) }),
  }).then((r) => r.json()).then((j) => j.success === 'true' || j.success === true);
  const [m] = await Promise.allSettled([mail]);
  btn.disabled = false;
  if (m.status === 'fulfilled' && m.value) {
    $('#fbStatus').textContent = 'ありがとうございます。作者に届きました。';
    $('#fbText').value = '';
    toast('送信しました。ご意見ありがとうございます！');
  } else {
    $('#fbStatus').innerHTML = `送信できませんでした。通信状態を確認するか、メールで送ってください：<span class="sel">${esc(TO)}</span>`;
  }
}

// One share screen for scores, memory cards and the monthly sheet: the phone's share menu with the image
// (LINE, mail, … appear there), LINE / mail with the text, or saving the image. lineUrl / mailUrl are pure (tested).
import { $, esc, toast, copyText } from './util.js';

/** LINE's share link: opens LINE with the text, the friend / group is chosen there */
export function lineUrl(text) { return `https://line.me/R/share?text=${encodeURIComponent(text)}`; }
/** a new mail with subject and body (attachments cannot be added by a link) */
export function mailUrl(subject, body) { return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; }

function fileOf(blob, filename) { return blob ? new File([blob], filename, { type: blob.type || 'image/jpeg' }) : null; }
const canShareFile = (f) => !!(f && navigator.canShare && navigator.canShare({ files: [f] }));

let url = null;
/**
 * @param o { title, text, blob?: image, filename? }
 */
export function openShare({ title, text, blob = null, filename = 'golf.jpg' }) {
  const box = $('#sharePanel');
  const file = fileOf(blob, filename);
  if (url) URL.revokeObjectURL(url);
  url = blob ? URL.createObjectURL(blob) : null;
  const withImage = canShareFile(file);
  box.innerHTML = `<div class="sheet-body" role="dialog" aria-label="共有">
      <div class="card-head"><h2>${esc(title)}</h2><button class="btn small" data-s="close">閉じる</button></div>
      ${url ? `<img class="share-prev" src="${url}" alt="共有する画像">` : ''}
      <pre class="share-text">${esc(text)}</pre>
      <div class="share-btns">
        ${blob && withImage ? '<button class="btn primary" data-s="native">画像つきで送る（LINE・メールなど）</button>' : ''}
        ${!blob && navigator.share ? '<button class="btn primary" data-s="native">送る（LINE・メールなど）</button>' : ''}
        <a class="btn share-line" href="${esc(lineUrl(text))}" target="_blank" rel="noopener">LINEで送る（文字）</a>
        <a class="btn" href="${esc(mailUrl(title, text))}">メールで送る（文字）</a>
        ${blob ? '<button class="btn" data-s="save">画像を保存</button>' : ''}
        <button class="btn" data-s="copy">文字をコピー</button>
      </div>
      ${blob ? `<p class="muted">${withImage ? '画像を付けて送るときは「画像つきで送る」から LINE やメールを選んでください。' : 'この端末では画像を直接送れません。「画像を保存」してから LINE やメールに添付してください。'}「LINEで送る」「メールで送る」は文字だけ送ります。</p>` : ''}
    </div>`;
  box.hidden = false;
  box.onclick = async (e) => {
    if (e.target === box) { box.hidden = true; return; }
    const b = e.target.closest('[data-s]'); if (!b) return;
    const a = b.dataset.s;
    if (a === 'close') box.hidden = true;
    else if (a === 'native') {
      try { await navigator.share(withImage ? { title, text, files: [file] } : { title, text }); } catch (er) { if (er.name !== 'AbortError') toast('共有できませんでした'); }
    } else if (a === 'save') {
      const l = document.createElement('a'); l.href = url; l.download = filename; document.body.appendChild(l); l.click(); l.remove();
    } else if (a === 'copy') { copyText(text); toast('コピーしました'); }
  };
}

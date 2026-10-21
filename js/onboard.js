// First-run setup: name, handedness, driver carry → whole bag, target score, location permission.
import { $, $$, esc } from './util.js';
import { state, save } from './store.js';

// carry of each club relative to the driver (typical amateur gapping)
const RATIOS = [['1W', 1], ['3W', 0.89], ['5W', 0.84], ['4U', 0.8], ['5I', 0.75], ['6I', 0.71], ['7I', 0.67], ['8I', 0.62], ['9I', 0.57], ['PW', 0.51], ['50°', 0.44], ['56°', 0.37]];
export const clubsFromDriver = (d) => RATIOS.map(([name, r]) => ({ name, carry: Math.round((d * r) / 1) }));

let step = 1;
export function maybeOnboard(onDone) {
  if (state.onboarded) return;
  const ob = $('#onboard');
  ob.hidden = false;
  $('#obName').value = state.settings.name || '';
  const seg = (id, cb) => $('#' + id).addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; $$('#' + id + ' button').forEach((x) => x.classList.toggle('on', x === b)); cb?.(b.dataset.v); });
  seg('obHand'); seg('obGender'); seg('obTarget');
  const drive = () => { const d = Number($('#obDrive').value); $('#obDriveVal').textContent = d; $('#obClubs').innerHTML = clubsFromDriver(d).map((c) => `<span><b>${esc(c.name)}</b>${c.carry}</span>`).join(''); };
  // start from the current driver carry; only rebuild the bag if the slider is moved
  const d0 = state.clubs.find((c) => /1W|ドライバー/i.test(c.name))?.carry; if (d0) $('#obDrive').value = d0;
  let moved = false;
  $('#obDrive').oninput = () => { moved = true; drive(); }; drive();
  $('#obLocate').onclick = () => {
    if (!navigator.geolocation) { $('#obLocStatus').textContent = 'この端末は位置情報に対応していません'; return; }
    $('#obLocStatus').textContent = '確認中…';
    navigator.geolocation.getCurrentPosition(() => ($('#obLocStatus').textContent = 'オンになりました'), () => ($('#obLocStatus').textContent = '許可されませんでした。端末の設定からブラウザの位置情報を許可してください'), { timeout: 15000 });
  };
  const show = () => {
    $$('.ob-step').forEach((s) => (s.hidden = Number(s.dataset.s) !== step));
    $('#obBack').hidden = step === 1;
    $('#obNext').textContent = step === 3 ? 'はじめる' : '次へ';
    $('#obDots').innerHTML = [1, 2, 3].map((i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
  };
  $('#obBack').onclick = () => { step = Math.max(1, step - 1); show(); };
  $('#obNext').onclick = () => {
    if (step < 3) { step++; show(); return; }
    const on = (id) => $(`#${id} button.on`)?.dataset.v;
    state.settings.name = $('#obName').value.trim() || state.settings.name;
    state.ui.swHand = on('obHand') || 'right';
    state.ui.gender = on('obGender') || 'men';
    state.settings.targetScore = Number(on('obTarget')) || 90;
    if (moved || !state.clubs.length) state.clubs = clubsFromDriver(Number($('#obDrive').value));
    state.onboarded = true;
    save('onboard');
    ob.hidden = true;
    onDone?.();
  };
  show();
}

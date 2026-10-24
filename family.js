'use strict';

// Family profiles (Netflix style, one login) with optional PINs, plus Movie Night.

const EMOJIS = ['😎', '🦄', '🐻', '🦊', '🐸', '🐼', '🦁', '🐯', '🐵', '🤖', '👻', '🌟', '🐶', '🐱', '🦖', '🍕'];

// PINs are stored as a hash, never as the digits themselves.
async function pinHash(id, pin) {
  const text = `wtw:${id}:${pin}`;
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
  return 'x' + h;
}

function askPin(title) {
  return new Promise((resolve) => {
    const sheet = $('#pin-sheet');
    const input = $('#pin-input');
    $('#pin-title').textContent = title;
    $('#pin-msg').textContent = '';
    input.value = '';
    sheet.hidden = false;
    setTimeout(() => input.focus(), 50);
    const done = (v) => {
      sheet.hidden = true;
      $('#pin-form').onsubmit = $('#pin-cancel').onclick = null;
      resolve(v);
    };
    $('#pin-form').onsubmit = (e) => { e.preventDefault(); done(input.value); };
    $('#pin-cancel').onclick = () => done(null);
  });
}

// Resolves true if the profile has no PIN or the right PIN is typed.
async function unlock(id) {
  const p = state.profiles[id];
  if (!p.pinHash) return true;
  for (let tries = 0; tries < 3; tries++) {
    const pin = await askPin(tries ? 'Wrong PIN, try again' : `${p.emoji} ${p.name}'s PIN`);
    if (pin === null) return false;
    if ((await pinHash(id, pin)) === p.pinHash) return true;
  }
  toast('Wrong PIN');
  return false;
}

function renderWho() {
  $('#who').textContent = me().emoji;
  $('#who').title = me().name;
}

function renderWhoList() {
  $('#who-list').innerHTML = Object.entries(state.profiles).map(([id, p]) => `
    <li data-id="${id}" class="${id === state.activeProfile ? 'active' : ''}">
      <div class="who-emoji">${p.emoji}</div>
      <div class="grow"><div class="name">${esc(p.name)}${p.pinHash ? ' 🔒' : ''}</div>
        <div class="sub">${Object.keys(p.ratings).length} rated</div></div>
      <button class="mini" data-edit="1" aria-label="Edit ${esc(p.name)}">✏️</button>
    </li>`).join('');
}

function openWho() {
  renderWhoList();
  $('#who-form').hidden = true;
  $('#who-add').hidden = false;
  $('#who-sheet').hidden = false;
}
function closeWho() { $('#who-sheet').hidden = true; }

$('#who').addEventListener('click', openWho);
$('#who-sheet').addEventListener('click', (e) => { if (e.target.id === 'who-sheet') closeWho(); });

function switchTo(id) {
  state.activeProfile = id;
  resetProfile();
  resetDecks();
  openRows.clear();
  lastAction = null;
  tsSections = [];
  if (!state.night.length) state.night = [id];
  save();
  closeWho();
  toast(`Hi, ${me().name}!`);
  render();
}

$('#who-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('[data-edit]')) {
    if (await unlock(id)) editPerson(id);
    return;
  }
  if (id === state.activeProfile) return closeWho();
  if (await unlock(id)) switchTo(id);
});

// Add / edit form
let editing = null;
let pickedEmoji = EMOJIS[1];
let deleteArmed = false;

function editPerson(id) {
  editing = id;
  deleteArmed = false;
  const p = id ? state.profiles[id] : null;
  $('#who-form-title').textContent = p ? `Edit ${p.name}` : 'Add a person';
  $('#who-name').value = p ? p.name : '';
  $('#who-pin').value = '';
  $('#who-pin').placeholder = p && p.pinHash ? 'New PIN (blank = keep it)' : '4-digit PIN (optional)';
  $('#who-pin-note').textContent = p && p.pinHash ? 'Type 0000 to remove the PIN.' : 'A PIN stops others from opening or changing this profile.';
  pickedEmoji = p ? p.emoji : EMOJIS.find((e) => !Object.values(state.profiles).some((x) => x.emoji === e)) || EMOJIS[1];
  renderEmojiPicks();
  const del = $('#who-delete');
  del.hidden = !p || Object.keys(state.profiles).length < 2;
  del.textContent = 'Delete';
  $('#who-form').hidden = false;
  $('#who-add').hidden = true;
}

function renderEmojiPicks() {
  $('#who-emojis').innerHTML = EMOJIS.map((e) => `<button type="button" class="emoji-pick${e === pickedEmoji ? ' on' : ''}">${e}</button>`).join('');
}
$('#who-emojis').addEventListener('click', (e) => {
  const b = e.target.closest('.emoji-pick');
  if (!b) return;
  pickedEmoji = b.textContent;
  renderEmojiPicks();
});

$('#who-add').addEventListener('click', () => editPerson(null));
$('#who-cancel').addEventListener('click', () => { $('#who-form').hidden = true; $('#who-add').hidden = false; });

$('#who-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#who-name').value.trim();
  const pin = $('#who-pin').value.trim();
  if (!name) return;
  if (pin && !/^\d{4}$/.test(pin)) return toast('PIN must be 4 digits');
  const id = editing || 'p' + Date.now().toString(36);
  const p = editing ? state.profiles[id] : blankProfile(name, pickedEmoji);
  p.name = name;
  p.emoji = pickedEmoji;
  if (pin === '0000' && editing) delete p.pinHash;
  else if (pin) p.pinHash = await pinHash(id, pin);
  state.profiles[id] = p;
  save();
  if (!editing) return switchTo(id);
  renderWhoList();
  renderWho();
  $('#who-form').hidden = true;
  $('#who-add').hidden = false;
});

$('#who-delete').addEventListener('click', () => {
  if (!deleteArmed) {
    deleteArmed = true;
    $('#who-delete').textContent = 'Tap again to delete';
    return;
  }
  const id = editing;
  delete state.profiles[id];
  state.night = state.night.filter((x) => x !== id);
  if (state.activeProfile === id) state.activeProfile = Object.keys(state.profiles)[0];
  resetProfile();
  resetDecks();
  save();
  $('#who-form').hidden = true;
  $('#who-add').hidden = false;
  renderWhoList();
  render();
});

// With more than one person, ask who's using the app when it opens.
function askWhoOnStart() {
  if (Object.keys(state.profiles).length > 1) openWho();
}

// ---------- Movie Night ----------
// Everyone's taste is scored separately, then blended: 60% the group average, 40% the lowest score,
// so one person who'd hate it pulls a pick down. Titles anyone in the room has rated or removed are skipped.

let night = { key: '', items: [], loading: false };
const nightOpen = new Set();

function nightKey() {
  return [...state.night].sort().join(',') + '|' + (state.nightType || 'movie') + '|' + state.mode;
}

function renderNight() {
  const type = state.nightType || 'movie';
  if (!state.night.length) state.night = [state.activeProfile];
  $('#night-people').innerHTML = Object.entries(state.profiles).map(([id, p]) =>
    `<button class="person${state.night.includes(id) ? ' on' : ''}" data-id="${id}"><span class="e">${p.emoji}</span>${esc(p.name)}</button>`).join('');
  document.querySelectorAll('#night-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === type));
  document.querySelectorAll('#night-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  const list = $('#night-list');
  const msg = (html) => (list.innerHTML = `<li class="sub empty-row">${html}</li>`);
  if (!state.apiKey) return msg('Add your free TMDB key in <b>Settings</b> to start.');
  const ready = state.night.filter((id) => Object.keys(state.profiles[id].ratings).length >= 3);
  if (ready.length < state.night.length) {
    const names = state.night.filter((id) => !ready.includes(id)).map((id) => state.profiles[id].name);
    return msg(`${esc(names.join(', '))} need${names.length === 1 ? 's' : ''} to rate at least 3 things in <b>Training</b> first.`);
  }
  if (night.key !== nightKey()) {
    night = { key: nightKey(), items: [], loading: false };
    loadNight(night);
  }
  if (!night.items.length) return msg(night.loading ? 'Mixing everyone’s taste…' : 'No group picks found. Try <b>All</b>, or rate more in Training.');
  list.innerHTML = night.items.slice(0, 50).map((t, i) => {
    const chips = state.night.map((id) => {
      const s = t.scores[id];
      return `<span class="${s < 50 ? 'low' : ''}">${state.profiles[id].emoji} ${s}</span>`;
    }).join('');
    const row = sugRow(t, i + 1, { noActions: true, predLabel: 'Group score', extra: `<div class="group-scores">${chips}</div>` });
    return nightOpen.has(keyOf(t.type, t.id)) ? row.replace('class="srow"', 'class="srow open"') : row;
  }).join('');
}

async function loadNight(job) {
  job.loading = true;
  const ids = [...state.night];
  const type = state.nightType || 'movie';
  try {
    const seen = (k) => ids.some((id) => { const p = state.profiles[id]; return k in p.ratings || k in p.rejected; });
    const reqs = [];
    // Things similar to each person's favorites.
    for (const id of ids) {
      const liked = Object.values(state.profiles[id].ratings).filter((r) => r.score >= 70 && r.type === type).sort((a, b) => b.score - a.score).slice(0, 8);
      for (const r of liked) for (const page of [1, 2]) reqs.push(tmdb(`/${type}/${r.id}/recommendations`, { page }));
    }
    // Top-rated titles in the genres the group likes most, added up across everyone.
    const genreSum = {};
    for (const id of ids) for (const [f, v] of Object.entries(profile(id).w)) if (f[0] === 'g') genreSum[f] = (genreSum[f] || 0) + v;
    const top = Object.keys(genreSum).filter((f) => genreSum[f] > 0).sort((a, b) => genreSum[b] - genreSum[a]).slice(0, 3).map((f) => f.slice(1));
    for (const page of [1, 2, 3]) {
      reqs.push(tmdb(`/discover/${type}`, Object.assign({
        sort_by: 'vote_average.desc', 'vote_count.gte': 300, with_genres: top.join('|'), page,
      }, serviceFilter())));
    }
    const pool = new Map();
    for (const r of await Promise.allSettled(reqs)) {
      if (r.status !== 'fulfilled') continue;
      for (const it of r.value.results) {
        const t = fromListItem(it, type);
        const k = keyOf(type, t.id);
        if (!pool.has(k) && !seen(k) && t.poster) pool.set(k, t);
      }
    }
    const full = await mapLimit([...pool.values()], 8, (t) => details(t).catch(() => null));
    const items = full
      .filter((t) => t && (state.mode === 'all' || !state.services.length || (state.mode === 'mine') === onMyServices(t)))
      .map((t) => {
        const scores = {};
        for (const id of ids) scores[id] = predict(t, id);
        const vals = Object.values(scores);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Object.assign({}, t, { scores, score: Math.round(0.6 * avg + 0.4 * Math.min(...vals)) });
      })
      .sort((a, b) => b.score - a.score);
    if (job === night) night.items = items;
  } catch (e) {
    if (job === night) toast(e.message === 'BAD_KEY' ? 'That TMDB key didn’t work.' : 'Couldn’t reach TMDB.');
  }
  job.loading = false;
  if (job === night && currentTab === 'night') renderNight();
}

$('#night-people').addEventListener('click', (e) => {
  const b = e.target.closest('.person');
  if (!b) return;
  const id = b.dataset.id;
  state.night = state.night.includes(id) ? state.night.filter((x) => x !== id) : [...state.night, id];
  if (!state.night.length) state.night = [id];
  save();
  renderNight();
});
document.querySelectorAll('#night-type button').forEach((b) => b.addEventListener('click', () => {
  state.nightType = b.dataset.type;
  save();
  renderNight();
}));
document.querySelectorAll('#night-mode button').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  save();
  resetDecks();
  renderToggle();
  renderNight();
}));
$('#night-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-k]');
  if (!li) return;
  const k = li.dataset.k;
  nightOpen.has(k) ? nightOpen.delete(k) : nightOpen.add(k);
  li.querySelector('.srow').classList.toggle('open');
});

renderWho();

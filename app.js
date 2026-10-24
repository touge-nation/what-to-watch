'use strict';

// ---------- Saved state (lives only on this phone) ----------

const STORE_KEY = 'wtw-state-v1';
const REGION = 'US';
const TRAIN_MOVIE_PAGES = 15; // ~300 top movies from the last 10 years before switching to current stuff
const DEFAULT_SERVICES = /^(netflix|amazon prime video|disney plus|paramount plus|paramount\+|apple tv\+?|apple tv plus)$/i;

const blankState = () => ({
  apiKey: '',
  mode: 'mine',          // For You filter: 'mine' = on my services, 'other' = not on my services, 'all' = everything
  services: [],          // TMDB provider ids
  servicesPicked: false,
  ratings: {},           // key -> {id, type, title, year, poster, score, features, at}
  rejected: {},          // key -> {features, at}: removed from For You, counts as a small "not for me"
  unseen: {},            // key -> at: swiped left in Training, "haven't seen it", no effect on taste
  pinned: {},            // key -> {id, type, title, year, poster, features, at}
  names: {},             // feature -> readable name, for "because you like..."
  train: { phase: 0, page: 1, done: false },
  updatedAt: 0,
});

let state = load();

// Older versions treated a Training left swipe as "not interested". It now means "haven't seen it".
function migrate() {
  if (state.unseenMigrated) return;
  for (const k in state.rejected) state.unseen[k] = state.rejected[k].at || Date.now();
  state.rejected = {};
  state.unseenMigrated = true;
}
migrate();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    return Object.assign(blankState(), saved || {});
  } catch {
    return blankState();
  }
}
function save() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('Could not save on this phone.');
  }
  Cloud.queue(state);
}

const keyOf = (type, id) => `${type}:${id}`;
const handled = (k) => k in state.ratings || k in state.rejected || k in state.pinned;
// Training also skips what you said you haven't seen; For You still suggests those.
const handledTrain = (k) => handled(k) || k in state.unseen;

// ---------- TMDB ----------

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const detailCache = new Map();

async function tmdb(path, params = {}) {
  if (!state.apiKey) throw new Error('NO_KEY');
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  // The long "Read Access Token" goes in a header, the short API key goes in the URL.
  if (state.apiKey.length > 40) headers.Authorization = 'Bearer ' + state.apiKey;
  else url.searchParams.set('api_key', state.apiKey);
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error('BAD_KEY');
  if (!res.ok) throw new Error('HTTP_' + res.status);
  return res.json();
}

// Turns a TMDB list item into our small title object.
function fromListItem(it, type) {
  type = it.media_type || type;
  const date = it.release_date || it.first_air_date || '';
  return {
    id: it.id,
    type,
    title: it.title || it.name,
    year: date.slice(0, 4),
    poster: it.poster_path || '',
    backdrop: it.backdrop_path || '',
    overview: it.overview || '',
    vote: it.vote_average || 0,
    votes: it.vote_count || 0,
    genreIds: it.genre_ids || [],
  };
}

async function details(t) {
  const k = keyOf(t.type, t.id);
  if (detailCache.has(k)) return detailCache.get(k);
  const p = tmdb(`/${t.type}/${t.id}`, { append_to_response: 'keywords,credits,watch/providers' })
    .then((d) => {
      const full = Object.assign({}, t, {
        title: d.title || d.name || t.title,
        overview: d.overview || t.overview,
        vote: d.vote_average ?? t.vote,
        runtime: d.runtime || (d.episode_run_time || [])[0] || 0,
        seasons: d.number_of_seasons || 0,
        genres: (d.genres || []).map((g) => g.name),
        features: featuresOf(d, t.type),
        cast: ((d.credits && d.credits.cast) || []).slice(0, 4).map((c) => c.name),
        makers: [
          ...((d.credits && d.credits.crew) || []).filter((c) => c.job === 'Director').slice(0, 2),
          ...(d.created_by || []).slice(0, 2),
        ].map((c) => c.name),
        where: whereOf(d['watch/providers']),
      });
      detailCache.set(k, full);
      return full;
    })
    .catch((e) => {
      detailCache.delete(k);
      throw e;
    });
  detailCache.set(k, p);
  return p;
}

// Where to watch in the US: streaming first, then rent/buy.
function whereOf(wp) {
  const r = (wp && wp.results && wp.results[REGION]) || {};
  const out = [];
  const seen = new Set();
  for (const [kind, label] of [['flatrate', ''], ['free', 'Free'], ['ads', 'Free'], ['rent', 'Rent'], ['buy', 'Buy']]) {
    for (const p of r[kind] || []) {
      const tag = kind === 'flatrate' ? p.provider_name : null;
      const id = kind + p.provider_id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id: p.provider_id, kind, name: tag || `${label}: ${p.provider_name}` });
    }
  }
  return out;
}
const onMyServices = (t) => (t.where || []).some((w) => w.kind === 'flatrate' && state.services.includes(w.id));

// ---------- Taste profile ----------
// Each title becomes a bag of tags: genres, keywords (themes), top cast, director/creator, decade, movie vs show.
// Ratings push those tags up or down; unseen titles are scored by the tags they share with what you liked.

const TAG_WEIGHT = { g: 1.0, k: 0.7, c: 0.5, d: 0.8, y: 0.3, t: 0.3 };

function featuresOf(d, type) {
  const f = [];
  const name = (tag, n) => { state.names[tag] = n; f.push(tag); };
  for (const g of d.genres || []) name('g' + g.id, g.name);
  const kw = (d.keywords && (d.keywords.keywords || d.keywords.results)) || [];
  for (const k of kw.slice(0, 15)) name('k' + k.id, k.name);
  const cast = (d.credits && d.credits.cast) || [];
  for (const c of cast.slice(0, 5)) name('c' + c.id, c.name);
  const crew = (d.credits && d.credits.crew) || [];
  for (const c of crew.filter((c) => c.job === 'Director').slice(0, 2)) name('d' + c.id, c.name);
  for (const c of (d.created_by || []).slice(0, 2)) name('d' + c.id, c.name);
  const year = (d.release_date || d.first_air_date || '').slice(0, 4);
  if (year) name('y' + year.slice(0, 3), year.slice(0, 3) + '0s');
  name('t' + type, type === 'tv' ? 'TV shows' : 'movies');
  return f;
}

let profileCache = null;
function profile() {
  if (profileCache) return profileCache;
  const sum = {};
  const cnt = {};
  const add = (features, w) => {
    for (const f of features || []) {
      sum[f] = (sum[f] || 0) + w;
      cnt[f] = (cnt[f] || 0) + 1;
    }
  };
  for (const r of Object.values(state.ratings)) add(r.features, (r.score - 50) / 50);
  for (const r of Object.values(state.rejected)) add(r.features, -0.25);
  for (const r of Object.values(state.pinned)) add(r.features, 0.25);
  const w = {};
  // The +1 keeps one lucky rating from dominating a tag.
  for (const f in sum) w[f] = sum[f] / (cnt[f] + 1);
  profileCache = { w, n: Object.keys(state.ratings).length };
  return profileCache;
}
const resetProfile = () => { profileCache = null; };

// Predicted 0-100 score. With few ratings it leans on TMDB's crowd score; it trusts your taste more as you rate.
function predict(t) {
  const { w, n } = profile();
  const byTag = {};
  for (const f of t.features || []) (byTag[f[0]] ||= []).push(w[f] || 0);
  let raw = 0;
  let total = 0;
  for (const [tag, vals] of Object.entries(byTag)) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    raw += TAG_WEIGHT[tag] * avg;
    total += TAG_WEIGHT[tag];
  }
  const taste = total ? Math.tanh((raw / total) * 4) : 0;
  const crowd = (t.vote || 6) * 10;
  const trust = Math.min(1, n / 25) * 0.7;
  return Math.round(Math.max(0, Math.min(100, (1 - trust) * crowd + trust * (50 + 50 * taste))));
}

// Top reasons, like "Because you like Sci-Fi and Denis Villeneuve".
function why(t) {
  const { w } = profile();
  const good = (t.features || [])
    .filter((f) => f[0] !== 't' && f[0] !== 'y' && (w[f] || 0) > 0.15)
    .sort((a, b) => w[b] - w[a])
    .slice(0, 2)
    .map((f) => state.names[f]);
  return good.length ? 'Because you like ' + good.join(' and ') : '';
}

// ---------- Decks ----------

const tenYearsAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 10);
  return d.toISOString().slice(0, 10);
};
function serviceFilter() {
  if (state.mode !== 'mine' || !state.services.length) return {};
  return { with_watch_providers: state.services.join('|'), watch_region: REGION, with_watch_monetization_types: 'flatrate' };
}

const decks = {
  train: { queue: [], loading: false, empty: false },
  suggest: { queue: [], loading: false, empty: false },
};

// Training: top movies of the last 10 years, then current popular movies and shows.
async function moreTraining() {
  const tr = state.train;
  const out = [];
  if (tr.phase === 0) {
    const r = await tmdb('/discover/movie', Object.assign({
      sort_by: 'vote_count.desc',
      'primary_release_date.gte': tenYearsAgo(),
      include_adult: false,
      page: tr.page,
    }));
    out.push(...r.results.map((it) => fromListItem(it, 'movie')));
    tr.page++;
    if (tr.page > Math.min(TRAIN_MOVIE_PAGES, r.total_pages || 1)) { tr.phase = 1; tr.page = 1; }
  } else {
    // Training covers everything, whatever services you have.
    const filter = {};
    const [m, s] = await Promise.all([
      tmdb('/discover/movie', Object.assign({ sort_by: 'popularity.desc', 'vote_count.gte': 50, page: tr.page }, filter)),
      tmdb('/discover/tv', Object.assign({ sort_by: 'popularity.desc', 'vote_count.gte': 50, page: tr.page }, filter)),
    ]);
    const a = m.results.map((it) => fromListItem(it, 'movie'));
    const b = s.results.map((it) => fromListItem(it, 'tv'));
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (b[i]) out.push(b[i]);
      if (a[i]) out.push(a[i]);
    }
    tr.page++;
    if (tr.page > 50) tr.done = true;
  }
  save();
  return out;
}

// Suggestions: things similar to what you rated high, plus your best genres. Only unseen titles, best match first.
let suggestRound = 0;
async function moreSuggestions() {
  const liked = Object.values(state.ratings).filter((r) => r.score >= 70).sort((a, b) => b.score - a.score);
  const page = suggestRound + 1;
  const jobs = [];
  for (const r of liked.slice(0, 20)) {
    jobs.push(tmdb(`/${r.type}/${r.id}/recommendations`, { page }).then((x) => x.results.map((it) => fromListItem(it, r.type))));
  }
  const { w } = profile();
  const topGenres = Object.keys(w).filter((f) => f[0] === 'g' && w[f] > 0).sort((a, b) => w[b] - w[a]).slice(0, 3).map((f) => f.slice(1));
  for (const type of ['movie', 'tv']) {
    jobs.push(tmdb(`/discover/${type}`, Object.assign({
      sort_by: 'vote_average.desc',
      'vote_count.gte': 300,
      with_genres: topGenres.join('|'),
      page,
    }, serviceFilter())).then((x) => x.results.map((it) => fromListItem(it, type))));
  }
  suggestRound++;
  const lists = await Promise.allSettled(jobs);
  const seen = new Set();
  const pool = [];
  for (const l of lists) {
    if (l.status !== 'fulfilled') continue;
    for (const t of l.value) {
      const k = keyOf(t.type, t.id);
      if (seen.has(k) || handled(k) || !t.poster) continue;
      seen.add(k);
      pool.push(t);
    }
  }
  const full = await mapLimit(pool, 8, (t) => details(t).catch(() => null));
  return full
    .filter((t) => t && (state.mode === 'all' || !state.services.length || (state.mode === 'mine') === onMyServices(t)))
    .map((t) => Object.assign(t, { score: predict(t) }))
    .sort((a, b) => b.score - a.score);
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j]);
    }
  }));
  return out;
}

const SUGGEST_COUNT = 100;
const SUGGEST_ROUNDS = 8;

async function fillDeck(name) {
  const d = decks[name];
  const want = name === 'suggest' ? SUGGEST_COUNT : 5;
  if (d.loading || d.queue.length >= want || d.empty || d.exhausted) return;
  d.loading = true;
  try {
    for (let tries = 0; tries < (name === 'suggest' ? SUGGEST_ROUNDS : 6) && d.queue.length < want; tries++) {
      if (name === 'train' && state.train.done) break;
      const more = name === 'train' ? await moreTraining() : await moreSuggestions();
      const inQueue = new Set(d.queue.map((t) => keyOf(t.type, t.id)));
      const done = name === 'train' ? handledTrain : handled;
      d.queue.push(...more.filter((t) => !done(keyOf(t.type, t.id)) && !inQueue.has(keyOf(t.type, t.id))));
      if (name === 'suggest') {
        d.queue.sort((a, b) => b.score - a.score);
        // Show the list as it grows instead of waiting for all 100.
        if (currentTab === 'suggest') renderSuggestList();
        if (suggestRound >= SUGGEST_ROUNDS) { d.exhausted = true; break; }
      }
    }
    if (!d.queue.length) d.empty = true;
  } catch (e) {
    showDeckError(e);
  } finally {
    d.loading = false;
  }
  if (currentTab === name) renderDeck();
}

function resetDecks() {
  decks.train = { queue: [], loading: false, empty: false };
  decks.suggest = { queue: [], loading: false, empty: false };
  suggestRound = 0;
}

// ---------- Swipe cards ----------

const $ = (s) => document.querySelector(s);
const deckEl = $('#deck');
let currentTab = 'train';
let topCard = null;

function renderDeck() {
  if (currentTab === 'suggest') return renderSuggestList();
  const d = decks[currentTab];
  if (!d) return;
  deckEl.innerHTML = '';
  topCard = null;
  $('#deck-hint').textContent = currentTab === 'train'
    ? 'Or swipe: right = seen it · left = not seen · up = pin'
    : 'Only stuff you haven’t seen, best match first';

  if (!state.apiKey) return emptyMsg('Add your free TMDB key in <b>Settings</b> to start.');
  if (currentTab === 'suggest' && Object.keys(state.ratings).length < 3) {
    return emptyMsg('Rate at least 3 things in <b>Training</b> first, so I can learn your taste.');
  }
  if (!d.queue.length) {
    if (d.empty) return emptyMsg(currentTab === 'train' ? 'You went through everything! Try search in Ratings.' : 'No more matches right now. Rate more in Training, or switch to <b>All</b>.');
    emptyMsg('Loading…');
    fillDeck(currentTab);
    return;
  }
  const [first, second] = d.queue;
  if (second) deckEl.appendChild(makeCard(second, true));
  topCard = makeCard(first, false);
  deckEl.appendChild(topCard);
  if (d.queue.length < 4) fillDeck(currentTab);
  // Get details for the next card early, so it shows up instantly.
  if (second) details(second).catch(() => {});
}

function emptyMsg(html) {
  deckEl.innerHTML = `<div class="empty"><p>${html}</p></div>`;
}
function showDeckError(e) {
  const msg = e.message === 'BAD_KEY' ? 'That TMDB key didn’t work. Check it in <b>Settings</b>.'
    : e.message === 'NO_KEY' ? 'Add your free TMDB key in <b>Settings</b> to start.'
    : 'Couldn’t reach TMDB. Check your internet and try again.';
  if (currentTab === 'train') emptyMsg(msg);
  if (currentTab === 'suggest') $('#suggest-list').innerHTML = `<li class="sub empty-row">${msg}</li>`;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function makeCard(t, behind) {
  const el = document.createElement('div');
  el.className = 'card' + (behind ? ' behind' : '');
  if (t.poster) el.style.backgroundImage = `url(${IMG}w780${t.poster})`;
  else el.innerHTML = '<div class="no-poster">🎬</div>';
  el.insertAdjacentHTML('beforeend', `
    <div class="shade"></div>
    <div class="stamp yes">Seen</div><div class="stamp no">Not seen</div><div class="stamp pin">Pin</div>
    <div class="info">
      <div class="match-slot"></div>
      <h2>${esc(t.title)}</h2>
      <div class="meta">${t.type === 'tv' ? 'TV show' : 'Movie'}${t.year ? ' · ' + t.year : ''}<span class="extra"></span></div>
      <p class="overview">${esc(t.overview)}</p>
      <div class="why"></div>
      <div class="where"></div>
    </div>`);
  if (!behind) {
    attachSwipe(el, t);
    details(t).then((full) => fillCard(el, full)).catch(() => {});
  }
  return el;
}

function fillCard(el, t) {
  if (!el.isConnected) return;
  const score = predict(t);
  el.querySelector('.match-slot').innerHTML = `<span class="match${score < 60 ? ' low' : ''}">You'll like it: ${score}</span>`;
  const bits = [];
  if (t.genres && t.genres.length) bits.push(t.genres.slice(0, 3).join(', '));
  if (t.type === 'movie' && t.runtime) bits.push(t.runtime + ' min');
  if (t.type === 'tv' && t.seasons) bits.push(t.seasons + (t.seasons === 1 ? ' season' : ' seasons'));
  el.querySelector('.extra').textContent = bits.length ? ' · ' + bits.join(' · ') : '';
  el.querySelector('.why').textContent = why(t);
  const where = t.where || [];
  const mine = where.filter((w) => w.kind === 'flatrate' && state.services.includes(w.id));
  const rest = where.filter((w) => !mine.includes(w)).slice(0, 4);
  el.querySelector('.where').innerHTML = where.length
    ? mine.map((w) => `<span class="mine">✓ ${esc(w.name)}</span>`).join('') + rest.map((w) => `<span>${esc(w.name)}</span>`).join('')
    : '<span>Not streaming in the US right now</span>';
}

function attachSwipe(el, t) {
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false, moved = false;
  const stamps = { yes: el.querySelector('.stamp.yes'), no: el.querySelector('.stamp.no'), pin: el.querySelector('.stamp.pin') };

  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    sx = e.clientX;
    sy = e.clientY;
    dx = dy = 0;
    el.setPointerCapture(e.pointerId);
    el.style.transition = 'none';
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - sx;
    dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    const up = -dy > Math.abs(dx);
    stamps.yes.style.opacity = !up && dx > 0 ? Math.min(1, dx / 100) : 0;
    stamps.no.style.opacity = !up && dx < 0 ? Math.min(1, -dx / 100) : 0;
    stamps.pin.style.opacity = up ? Math.min(1, -dy / 100) : 0;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const w = el.offsetWidth;
    if (dx > w * 0.28) return act('right', t, el);
    if (dx < -w * 0.28) return act('left', t, el);
    if (-dy > el.offsetHeight * 0.2 && -dy > Math.abs(dx)) return act('up', t, el);
    el.style.transition = 'transform .25s';
    el.style.transform = '';
    Object.values(stamps).forEach((s) => (s.style.opacity = 0));
    // A tap with no drag opens the full description.
    if (!moved) el.classList.toggle('open');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function flyAway(el, dir) {
  const x = dir === 'right' ? 1.5 : dir === 'left' ? -1.5 : 0;
  const y = dir === 'up' ? -1.5 : 0;
  el.style.transition = 'transform .3s ease-in';
  el.style.transform = `translate(${x * innerWidth}px, ${y * innerHeight}px) rotate(${x * 20}deg)`;
}

let lastAction = null;

async function act(dir, t, el) {
  if (el) flyAway(el, dir);
  let full;
  try { full = await details(t); } catch { full = t; }
  const k = keyOf(t.type, t.id);
  const entry = { id: t.id, type: t.type, title: full.title, year: t.year, poster: t.poster, features: full.features || [], at: Date.now() };

  if (dir === 'right') {
    const score = await askRating(full.title, state.ratings[k] && state.ratings[k].score);
    if (score === null) {
      // Cancelled: put the card back.
      renderDeck();
      return;
    }
    removePinned(k);
    state.ratings[k] = Object.assign(entry, { score });
    delete state.rejected[k];
    delete state.unseen[k];
  } else if (dir === 'left' && currentTab === 'train') {
    state.unseen[k] = entry.at;
  } else if (dir === 'left') {
    state.rejected[k] = { features: entry.features, at: entry.at, title: entry.title };
  } else {
    state.pinned[k] = entry;
  }
  lastAction = { k, dir, tab: currentTab, item: t };
  $('#undo').hidden = false;
  resetProfile();
  save();
  dropFromQueues(k);
  if (dir === 'up') toast('Pinned to your list');
  renderDeck();
}

function dropFromQueues(k) {
  for (const d of Object.values(decks)) d.queue = d.queue.filter((t) => keyOf(t.type, t.id) !== k);
}
function removePinned(k) { delete state.pinned[k]; }

$('#undo').addEventListener('click', () => {
  if (!lastAction) return;
  const { k, dir, tab, item } = lastAction;
  if (dir === 'right') delete state.ratings[k];
  if (dir === 'left') delete state.rejected[k], delete state.unseen[k];
  if (dir === 'up') delete state.pinned[k];
  decks[tab].queue.unshift(item);
  lastAction = null;
  $('#undo').hidden = true;
  resetProfile();
  save();
  render();
});

document.querySelectorAll('.deck-buttons button').forEach((b) =>
  b.addEventListener('click', () => {
    const t = decks[currentTab].queue[0];
    if (t && topCard) act(b.dataset.act, t, topCard);
  }));

// ---------- For You list ----------
// Top 100 unseen picks. Tap to expand. Swipe right = seen it, swipe left = remove.

const sugEl = $('#suggest-list');
const openRows = new Set();

function renderSuggestList() {
  const d = decks.suggest;
  const msg = (html) => (sugEl.innerHTML = `<li class="sub empty-row">${html}</li>`);
  if (!state.apiKey) return msg('Add your free TMDB key in <b>Settings</b> to start.');
  if (Object.keys(state.ratings).length < 3) return msg('Rate at least 3 things in <b>Training</b> first, so I can learn your taste.');
  if (!d.queue.length) {
    if (d.empty) return msg('No more matches right now. Rate more in Training, or switch to <b>All</b>.');
    msg('Finding your best matches…');
    fillDeck('suggest');
    return;
  }
  sugEl.innerHTML = d.queue.slice(0, SUGGEST_COUNT).map((t, i) => sugRow(t, i + 1)).join('');
  sugEl.querySelectorAll('.srow').forEach(attachRowSwipe);
  if (d.queue.length < SUGGEST_COUNT) fillDeck('suggest');
}

function sugRow(t, rank) {
  const k = keyOf(t.type, t.id);
  const open = openRows.has(k);
  const img = t.poster ? `<img src="${IMG}w154${t.poster}" alt="" loading="lazy">` : '<div class="ph"></div>';
  const bits = [t.type === 'tv' ? 'TV show' : 'Movie', t.year];
  if (t.type === 'movie' && t.runtime) bits.push(t.runtime + ' min');
  if (t.type === 'tv' && t.seasons) bits.push(t.seasons + (t.seasons === 1 ? ' season' : ' seasons'));
  const where = t.where || [];
  const mine = where.filter((w) => w.kind === 'flatrate' && state.services.includes(w.id));
  const rest = where.filter((w) => !mine.includes(w)).slice(0, 4);
  const whyText = why(t);
  return `<li class="swipe-wrap" data-k="${k}">
    <div class="swipe-bg"><span class="bg-yes">✓ Seen it</span><span class="bg-no">Remove ✕</span></div>
    <div class="srow${open ? ' open' : ''}">
      <div class="srow-head">
        <div class="rank">${rank}</div>${img}
        <div class="grow"><div class="name">${esc(t.title)}</div>
          <div class="sub">${esc(bits.filter(Boolean).join(' · '))}</div>
          ${mine.length ? `<div class="sub on-mine">✓ ${esc(mine.map((w) => w.name).join(', '))}</div>`
            : rest.length ? `<div class="sub">${esc(rest.slice(0, 2).map((w) => w.name).join(', '))}</div>` : ''}</div>
        <div class="score">${t.score}</div>
      </div>
      <div class="srow-more">
        <div class="pred">You'll like it: <b>${t.score}</b> / 100${t.vote ? ` <span class="sub">· TMDB ${Math.round(t.vote * 10)}</span>` : ''}</div>
        ${whyText ? `<div class="sub">${esc(whyText)}</div>` : ''}
        ${t.genres && t.genres.length ? `<div class="sub">${esc(t.genres.join(', '))}</div>` : ''}
        <p>${esc(t.overview) || 'No description yet.'}</p>
        ${t.cast && t.cast.length ? `<div class="sub"><b>Starring:</b> ${esc(t.cast.join(', '))}</div>` : ''}
        ${t.makers && t.makers.length ? `<div class="sub"><b>${t.type === 'tv' ? 'Created by' : 'Directed by'}:</b> ${esc(t.makers.join(', '))}</div>` : ''}
        <div class="where">${where.length
          ? mine.map((w) => `<span class="mine">✓ ${esc(w.name)}</span>`).join('') + rest.map((w) => `<span>${esc(w.name)}</span>`).join('')
          : '<span>Not streaming in the US right now</span>'}</div>
        <div class="row-actions">
          <button class="mini" data-do="right">✓ Seen it</button>
          <button class="mini" data-do="up">📌 Pin</button>
          <button class="mini" data-do="left">✕ Remove</button>
        </div>
      </div>
    </div>
  </li>`;
}

function itemFor(li) {
  return decks.suggest.queue.find((t) => keyOf(t.type, t.id) === li.dataset.k);
}

sugEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-k]');
  if (!li || li.dataset.swiped) return;
  const t = itemFor(li);
  if (!t) return;
  const btn = e.target.closest('button[data-do]');
  if (btn) return act(btn.dataset.do, t, null);
  const k = li.dataset.k;
  openRows.has(k) ? openRows.delete(k) : openRows.add(k);
  li.querySelector('.srow').classList.toggle('open');
});

function attachRowSwipe(row) {
  const li = row.parentElement;
  let sx = 0, sy = 0, dx = 0, mode = null;
  row.addEventListener('pointerdown', (e) => {
    sx = e.clientX;
    sy = e.clientY;
    dx = 0;
    mode = null;
    delete li.dataset.swiped;
    row.style.transition = 'none';
  });
  row.addEventListener('pointermove', (e) => {
    if (mode === 'scroll' || e.buttons === 0 && e.pointerType === 'mouse') return;
    const mx = e.clientX - sx;
    const my = e.clientY - sy;
    // Decide once per touch: sideways = swipe, up/down = let the list scroll.
    if (!mode) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      mode = Math.abs(mx) > Math.abs(my) ? 'swipe' : 'scroll';
      if (mode === 'swipe') row.setPointerCapture(e.pointerId);
      else return;
    }
    dx = mx;
    row.style.transform = `translateX(${dx}px)`;
    li.classList.toggle('going-yes', dx > 0);
    li.classList.toggle('going-no', dx < 0);
  });
  const end = () => {
    if (mode !== 'swipe') return;
    mode = null;
    li.dataset.swiped = '1';
    setTimeout(() => delete li.dataset.swiped, 50);
    const t = itemFor(li);
    const far = Math.abs(dx) > row.offsetWidth * 0.3;
    row.style.transition = 'transform .25s';
    if (far && t) {
      row.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`;
      setTimeout(() => act(dx > 0 ? 'right' : 'left', t, null), 200);
    } else {
      row.style.transform = '';
    }
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
}

// ---------- Rating sheet ----------

function askRating(title, current) {
  return new Promise((resolve) => {
    const sheet = $('#sheet');
    const slider = $('#sheet-slider');
    const score = $('#sheet-score');
    $('#sheet-title').textContent = title;
    slider.value = current ?? 50;
    score.textContent = slider.value;
    slider.oninput = () => (score.textContent = slider.value);
    sheet.hidden = false;
    const done = (v) => {
      sheet.hidden = true;
      $('#sheet-save').onclick = $('#sheet-cancel').onclick = sheet.onclick = null;
      resolve(v);
    };
    $('#sheet-save').onclick = () => done(Number(slider.value));
    $('#sheet-cancel').onclick = () => done(null);
    sheet.onclick = (e) => { if (e.target === sheet) done(null); };
  });
}

// ---------- Training search ----------
// Lets you add what you've already watched, by title, genre ("horror") or theme ("heist").
// After you rate something well, "More like this" uses TMDB's similar-titles list.

const tsInput = $('#train-search');
const tsList = $('#train-results');
const tsItems = new Map();
let tsSections = [];
let tsTimer;
let tsSeq = 0;
let genreList = null;

async function allGenres() {
  if (!genreList) {
    const [m, t] = await Promise.all([tmdb('/genre/movie/list'), tmdb('/genre/tv/list')]);
    genreList = { movie: m.genres, tv: t.genres };
  }
  return genreList;
}

function setTrainSearch(on) {
  $('#deck').hidden = on;
  $('.deck-buttons').hidden = on;
  $('#deck-hint').hidden = on;
  tsList.hidden = !on;
  $('#ts-filters').hidden = !on || !tsInput.value.trim();
}

// Filter chips: show all results, or only genres, themes or titles.
let tsFilter = 'all';
const SECTION_KINDS = { genre: 'Genres', theme: 'Themes', title: 'Titles' };
document.querySelectorAll('#ts-filters button').forEach((b) => b.addEventListener('click', () => {
  tsFilter = b.dataset.f;
  renderFilterChips();
  renderTrainResults();
}));
function renderFilterChips() {
  document.querySelectorAll('#ts-filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === tsFilter));
}

// With an empty search box, show genre presets to tap.
async function showPresets() {
  setTrainSearch(true);
  tsList.innerHTML = '<li class="list-head">Pick a genre you like</li><li class="presets sub">Loading…</li>';
  try {
    const g = await allGenres();
    if (tsInput.value.trim()) return;
    const names = [...new Set([...g.movie, ...g.tv].map((x) => x.name))].sort();
    tsList.innerHTML = '<li class="list-head">Pick a genre you like</li><li class="presets">'
      + names.map((n) => `<button class="chip preset" data-g="${esc(n)}">${esc(n)}</button>`).join('') + '</li>'
      + '<li class="sub small">Or type a title, or a theme like “heist” or “time travel”.</li>';
  } catch {
    tsList.innerHTML = '<li class="sub">Add your TMDB key in Settings first.</li>';
  }
}

tsInput.addEventListener('focus', () => { if (!tsInput.value.trim()) showPresets(); });
tsInput.addEventListener('blur', () => {
  // Wait a moment so tapping a preset still works.
  setTimeout(() => { if (!tsInput.value.trim() && document.activeElement !== tsInput) { setTrainSearch(false); renderDeck(); } }, 250);
});

tsInput.addEventListener('input', () => {
  clearTimeout(tsTimer);
  const q = tsInput.value.trim();
  if (!q) return showPresets();
  tsFilter = 'all';
  setTrainSearch(true);
  tsTimer = setTimeout(() => runTrainSearch(q), 350);
});

async function runTrainSearch(q) {
  const seq = ++tsSeq;
  tsList.innerHTML = '<li class="sub">Searching…</li>';
  try {
    const ql = q.toLowerCase();
    const [titles, kws, g] = await Promise.all([
      tmdb('/search/multi', { query: q, include_adult: false }),
      tmdb('/search/keyword', { query: q }),
      allGenres(),
    ]);
    const jobs = [];
    // Closest genre first: exact name, then starts with, then contains ("action" -> "Action & Adventure" for TV).
    const pickGenre = (list) => list.find((x) => x.name.toLowerCase() === ql)
      || list.find((x) => x.name.toLowerCase().startsWith(ql))
      || (ql.length >= 4 && list.find((x) => x.name.toLowerCase().includes(ql)));
    for (const type of ['movie', 'tv']) {
      const gm = pickGenre(g[type]);
      if (gm) {
        jobs.push(tmdb(`/discover/${type}`, { with_genres: gm.id, sort_by: 'vote_count.desc' })
          .then((r) => ['genre', `${gm.name} ${type === 'tv' ? 'shows' : 'movies'}`, r.results.slice(0, 12).map((it) => fromListItem(it, type))]));
      }
    }
    const kw = kws.results.find((k) => k.name.toLowerCase() === ql) || kws.results[0];
    if (kw) {
      jobs.push(Promise.all(['movie', 'tv'].map((type) => tmdb(`/discover/${type}`, { with_keywords: kw.id, sort_by: 'vote_count.desc' })))
        .then(([m, t]) => ['theme', `Theme: “${kw.name}”`, [...m.results.slice(0, 8).map((it) => fromListItem(it, 'movie')), ...t.results.slice(0, 4).map((it) => fromListItem(it, 'tv'))]]));
    }
    const sections = [];
    for (const r of await Promise.allSettled(jobs)) if (r.status === 'fulfilled' && r.value[2].length) sections.push(r.value);
    const tl = titles.results.filter((it) => it.media_type === 'movie' || it.media_type === 'tv').slice(0, 8).map((it) => fromListItem(it));
    if (tl.length) sections.push(['title', `Titles with “${q}”`, tl]);
    if (seq !== tsSeq) return;
    // Keep any "More like" lists from this session on top.
    tsSections = [...tsSections.filter(([kind]) => kind === 'more'), ...sections];
    // A preset tap asks for genres only; typing starts on All.
    if (tsFilter !== 'all' && !sections.some(([kind]) => kind === tsFilter)) tsFilter = 'all';
    renderFilterChips();
    setTrainSearch(true);
    renderTrainResults();
  } catch (e) {
    if (seq !== tsSeq) return;
    tsList.innerHTML = `<li class="sub">${e.message === 'NO_KEY' ? 'Add your TMDB key in Settings first.' : 'Search failed. Try again.'}</li>`;
  }
}

tsList.addEventListener('click', (e) => {
  const p = e.target.closest('button.preset');
  if (!p) return;
  tsInput.value = p.dataset.g;
  tsFilter = 'genre';
  runTrainSearch(p.dataset.g);
});

function renderTrainResults() {
  tsItems.clear();
  const shown = tsSections.filter(([kind]) => tsFilter === 'all' || kind === tsFilter);
  if (!shown.length) { tsList.innerHTML = '<li class="sub">No matches. Try a title, a genre like “horror”, or a theme like “heist”.</li>'; return; }
  tsList.innerHTML = shown.map(([, head, items]) => `<li class="list-head">${esc(head)}</li>` + items.map((t) => {
    const k = keyOf(t.type, t.id);
    tsItems.set(k, t);
    const r = state.ratings[k];
    // Buttons sit under the title so long titles aren't squeezed on small phones.
    if (r) return row(t, `<div class="score">${r.score}</div>`);
    const acts = k in state.unseen
      ? '<div class="acts"><button class="mini" data-do="right">✓ Seen it</button><span class="sub">Marked not seen</span></div>'
      : '<div class="acts"><button class="mini" data-do="right">✓ Seen it</button><button class="mini" data-do="left">Not seen</button></div>';
    return row(t, '', acts);
  }).join('')).join('');
}

tsList.addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-k]');
  if (!li) return;
  const t = tsItems.get(li.dataset.k);
  const btn = e.target.closest('button[data-do]');
  // Tapping a rated row lets you change its score.
  if (!btn && !(li.dataset.k in state.ratings)) return;
  await act(btn ? btn.dataset.do : 'right', t, null);
  const r = state.ratings[li.dataset.k];
  if (r && r.score >= 60 && !tsSections.some(([kind, h]) => kind === 'more' && h.endsWith(t.title))) {
    try {
      const rec = await tmdb(`/${t.type}/${t.id}/recommendations`);
      const items = rec.results.slice(0, 10).map((it) => fromListItem(it, t.type));
      if (items.length) tsSections.unshift(['more', `More like ${t.title}`, items]);
    } catch {}
  }
  renderTrainResults();
});

// ---------- Lists: pinned, ratings, search ----------

function row(item, right, below = '') {
  const img = item.poster ? `<img src="${IMG}w154${item.poster}" alt="" loading="lazy">` : '<div class="ph"></div>';
  return `<li data-k="${keyOf(item.type, item.id)}">${img}
    <div class="grow"><div class="name">${esc(item.title)}</div>
    <div class="sub">${item.type === 'tv' ? 'TV show' : 'Movie'}${item.year ? ' · ' + item.year : ''}</div>${below}</div>${right}</li>`;
}

function renderPinned() {
  const items = Object.values(state.pinned).sort((a, b) => b.at - a.at);
  $('#pinned-list').innerHTML = items.length
    ? items.map((p) => row(p, `<button class="mini" data-do="rate">Seen it</button><button class="mini" data-do="unpin">✕</button>`)).join('')
    : '<li class="sub">Swipe up on a card to pin it here.</li>';
}

$('#pinned-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const k = btn.closest('li').dataset.k;
  const p = state.pinned[k];
  if (btn.dataset.do === 'unpin') {
    delete state.pinned[k];
  } else {
    const score = await askRating(p.title);
    if (score === null) return;
    state.ratings[k] = Object.assign({}, p, { score, at: Date.now() });
    delete state.pinned[k];
  }
  resetProfile();
  save();
  renderPinned();
});

function renderRatings() {
  const items = Object.values(state.ratings).sort((a, b) => b.score - a.score);
  $('#ratings-head').textContent = items.length ? `Rated: ${items.length}` : 'Nothing rated yet. Swipe in Training, or search above.';
  $('#ratings-list').innerHTML = items.map((r) => row(r, `<div class="score">${r.score}</div>`)).join('');
}

$('#ratings-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const r = state.ratings[li.dataset.k];
  const score = await askRating(r.title, r.score);
  if (score === null) return;
  r.score = score;
  resetProfile();
  save();
  renderRatings();
});

let searchTimer;
const searchResults = new Map();
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#search-results').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const r = await tmdb('/search/multi', { query: q, include_adult: false });
      const items = r.results.filter((it) => it.media_type === 'movie' || it.media_type === 'tv').slice(0, 8).map((it) => fromListItem(it));
      searchResults.clear();
      items.forEach((t) => searchResults.set(keyOf(t.type, t.id), t));
      $('#search-results').innerHTML = items.map((t) => {
        const r = state.ratings[keyOf(t.type, t.id)];
        return row(t, r ? `<div class="score">${r.score}</div>` : '<button class="mini">Rate</button>');
      }).join('') || '<li class="sub">No matches.</li>';
    } catch (err) {
      $('#search-results').innerHTML = `<li class="sub">${err.message === 'NO_KEY' ? 'Add your TMDB key in Settings first.' : 'Search failed. Try again.'}</li>`;
    }
  }, 350);
});

$('#search-results').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-k]');
  if (!li) return;
  const t = searchResults.get(li.dataset.k);
  await act('right', t, null);
  $('#search').value = '';
  $('#search-results').innerHTML = '';
  renderRatings();
});

// ---------- Settings ----------

async function renderSettings() {
  $('#api-key').value = state.apiKey;
  const box = $('#services');
  if (!state.apiKey) { box.innerHTML = '<p class="small">Add your key first.</p>'; return; }
  try {
    const r = await tmdb('/watch/providers/movie', { watch_region: REGION });
    const list = r.results.sort((a, b) => (a.display_priorities?.[REGION] ?? a.display_priority) - (b.display_priorities?.[REGION] ?? b.display_priority)).slice(0, 40);
    if (!state.servicesPicked) {
      state.services = list.filter((p) => DEFAULT_SERVICES.test(p.provider_name.trim())).map((p) => p.provider_id);
      state.servicesPicked = true;
      save();
    }
    box.innerHTML = list.map((p) => `<label><input type="checkbox" value="${p.provider_id}" ${state.services.includes(p.provider_id) ? 'checked' : ''}>
      <img src="${IMG}w92${p.logo_path}" alt="">${esc(p.provider_name)}</label>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="small">${e.message === 'BAD_KEY' ? 'That key didn’t work.' : 'Couldn’t load services. Check your internet.'}</p>`;
  }
}

$('#services').addEventListener('change', () => {
  state.services = [...document.querySelectorAll('#services input:checked')].map((i) => Number(i.value));
  save();
  resetDecks();
});

$('#save-key').addEventListener('click', async () => {
  state.apiKey = $('#api-key').value.trim();
  save();
  resetDecks();
  $('#key-status').textContent = 'Checking…';
  try {
    await tmdb('/configuration');
    $('#key-status').textContent = '✓ Key works. Go to Training to start swiping!';
  } catch (e) {
    $('#key-status').textContent = e.message === 'BAD_KEY' ? '✕ That key didn’t work. Copy it again.' : 'Saved, but couldn’t check it (no internet?).';
  }
  renderSettings();
});

$('#export').addEventListener('click', () => {
  const data = Object.assign({}, state, { apiKey: '' });
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `what-to-watch-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.ratings) throw new Error('not a backup');
    state = Object.assign(blankState(), data, { apiKey: state.apiKey });
    save();
    resetProfile();
    resetDecks();
    toast(`Loaded ${Object.keys(state.ratings).length} ratings`);
  } catch {
    toast('That file isn’t a backup from this app.');
  }
  e.target.value = '';
});

// ---------- Mode toggle, tabs, misc ----------

function renderToggle() {
  document.querySelectorAll('#mode-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
}
document.querySelectorAll('#mode-toggle button').forEach((b) =>
  b.addEventListener('click', () => {
    if (state.mode === b.dataset.mode) return;
    state.mode = b.dataset.mode;
    save();
    resetDecks();
    renderToggle();
    render();
  }));

const TITLES = { train: 'Training', suggest: 'For You', pinned: 'Pinned', ratings: 'My Ratings', profile: 'Profile', settings: 'Settings' };

function render() {
  $('#title').textContent = TITLES[currentTab];
  const deckTab = currentTab === 'train' || currentTab === 'suggest';
  $('#view-suggest').hidden = currentTab !== 'suggest';
  $('#undo').hidden = !deckTab || !lastAction;
  $('#view-deck').hidden = currentTab !== 'train';
  $('#view-pinned').hidden = currentTab !== 'pinned';
  $('#view-ratings').hidden = currentTab !== 'ratings';
  $('#view-settings').hidden = currentTab !== 'settings';
  $('#view-profile').hidden = currentTab !== 'profile';
  $('#open-settings').hidden = currentTab !== 'profile';
  if (deckTab) renderDeck();
  if (currentTab === 'pinned') renderPinned();
  if (currentTab === 'ratings') renderRatings();
  if (currentTab === 'settings') renderSettings(), renderAccount();
  if (currentTab === 'profile') renderProfile();
}

// Settings has no tab of its own; it opens from Profile.
function goTab(name) {
  currentTab = name;
  const lit = name === 'settings' ? 'profile' : name;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === lit));
  // Suggestions are rebuilt each visit so they reflect your newest ratings.
  if (name === 'suggest' && !decks.suggest.loading) decks.suggest = { queue: [], loading: false, empty: false }, suggestRound = 0;
  render();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.tab)));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------- Login and online saving ----------

const SYNC_TEXT = { saving: 'Saving…', saved: '✓ Saved', offline: 'Offline, will save when back online.', loggedout: 'Logged out, log in again to save.' };
Cloud.onStatus = (s) => {
  $('#sync-status').textContent = SYNC_TEXT[s] || '';
  if (s === 'loggedout') showLogin();
};

function showLogin() {
  $('#login').hidden = false;
}

// After login, the newer copy wins: the one online or the one on this phone.
async function syncDown() {
  try {
    const row = await Cloud.pull();
    if (row && row.data && (row.data.updatedAt || 0) >= (state.updatedAt || 0)) {
      state = Object.assign(blankState(), row.data);
      migrate();
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
      resetProfile();
      resetDecks();
    } else if (state.updatedAt || Object.keys(state.ratings).length) {
      await Cloud.push(state);
    }
    $('#sync-status').textContent = SYNC_TEXT.saved;
  } catch (e) {
    if (!Cloud.loggedIn) return showLogin();
    toast('Couldn\u2019t reach your saved ratings. Using this phone\u2019s copy.');
  }
}

let loginHow = 'in';
document.querySelectorAll('#login-form button').forEach((b) => b.addEventListener('click', () => (loginHow = b.dataset.how)));
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const pass = $('#login-pass').value;
  const msg = $('#login-msg');
  msg.textContent = loginHow === 'up' ? 'Creating account…' : 'Logging in…';
  try {
    if (loginHow === 'up') {
      if ((await Cloud.signUp(email, pass)) === 'confirm') {
        msg.textContent = 'Check your email and tap the confirm link. Then come back and tap Log in.';
        return;
      }
    } else {
      await Cloud.logIn(email, pass);
    }
    msg.textContent = '';
    $('#login').hidden = true;
    await syncDown();
    start();
  } catch (err) {
    msg.textContent = /invalid login/i.test(err.message) ? 'Wrong email or password.'
      : /not confirmed/i.test(err.message) ? 'Confirm your email first (check your inbox).'
      : /registered|exists/i.test(err.message) ? 'That email already has an account. Tap Log in.'
      : 'Couldn\u2019t log in: ' + err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await Cloud.flush();
  Cloud.logOut();
  // Clear this phone's copy. Everything is still saved online.
  localStorage.removeItem(STORE_KEY);
  state = blankState();
  resetProfile();
  resetDecks();
  showLogin();
});

function renderAccount() {
  $('#account-box').hidden = !Cloud.loggedIn;
  $('#account-email').textContent = Cloud.email || '';
}

let started = false;
function start() {
  renderAccount();
  renderToggle();
  if (!started && !state.apiKey) {
    goTab('settings');
  } else {
    render();
  }
  started = true;
}

if (Cloud.enabled && !Cloud.loggedIn) {
  showLogin();
} else {
  start();
  if (Cloud.enabled) syncDown().then(() => render());
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

'use strict';

// Profile tab: a taste bio, a genre spider chart and a few breakdowns,
// all worked out from the ratings already saved in `state`.

function tasteStats() {
  const rated = Object.values(state.ratings);
  const { w } = profile();
  const byTag = {};
  for (const r of rated) {
    for (const f of r.features || []) {
      const s = (byTag[f] ||= { tag: f, n: 0, sum: 0 });
      s.n++;
      s.sum += r.score;
    }
  }
  const tags = Object.values(byTag).map((s) => Object.assign(s, {
    avg: Math.round(s.sum / s.n),
    weight: w[s.tag] || 0,
    name: state.names[s.tag] || '?',
  }));
  const kind = (k) => tags.filter((t) => t.tag[0] === k);
  const avgAll = rated.length ? Math.round(rated.reduce((a, r) => a + r.score, 0) / rated.length) : 0;
  const bins = Array(10).fill(0);
  for (const r of rated) bins[Math.min(9, Math.floor(r.score / 10))]++;
  return {
    rated,
    avgAll,
    movies: rated.filter((r) => r.type === 'movie').length,
    shows: rated.filter((r) => r.type === 'tv').length,
    genres: kind('g'),
    themes: kind('k'),
    people: [...kind('c'), ...kind('d')],
    decades: kind('y').sort((a, b) => a.tag.localeCompare(b.tag)),
    bins,
  };
}

function bio(s) {
  if (s.rated.length < 3) return 'Rate a few more things in Training and your taste profile will show up here.';
  const enough = s.genres.filter((g) => g.n >= 2);
  // Compared with your own average, so a tough critic still gets loves and skips.
  const loves = [...enough].filter((g) => g.avg >= s.avgAll + 5).sort((a, b) => b.avg - a.avg).slice(0, 3);
  const avoids = [...enough].filter((g) => g.avg <= s.avgAll - 8).sort((a, b) => a.avg - b.avg).slice(0, 2);
  const people = [...s.people].filter((p) => p.n >= 2 && p.weight > 0.15).sort((a, b) => b.weight - a.weight).slice(0, 2);
  const decade = [...s.decades].filter((d) => d.n >= 2).sort((a, b) => b.avg - a.avg)[0];
  const list = (xs) => xs.map((x) => x.name).join(xs.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ', and $1');
  const out = [];
  if (loves.length) out.push(`You're happiest with <b>${esc(list(loves))}</b>.`);
  if (avoids.length) out.push(`You usually skip <b>${esc(list(avoids))}</b>.`);
  if (people.length) out.push(`You rate anything with <b>${esc(list(people))}</b> high.`);
  if (decade) out.push(`Your best decade so far is the <b>${esc(decade.name)}</b>.`);
  const mood = s.avgAll >= 75 ? 'easy to please' : s.avgAll >= 55 ? 'a fair judge' : 'a tough critic';
  out.push(`With an average score of <b>${s.avgAll}</b>, you're ${mood}.`);
  return out.join(' ');
}

const SHORT = { 'Science Fiction': 'Sci-Fi', 'Action & Adventure': 'Action/Adv.', 'Sci-Fi & Fantasy': 'Sci-Fi/Fantasy', 'War & Politics': 'War/Politics', 'Documentary': 'Docs' };
const short = (n) => SHORT[n] || (n.length > 12 ? n.slice(0, 11) + '…' : n);

// Spider chart of average score per genre (0 to 100), for the genres you've rated most.
function spider(genres) {
  const axes = [...genres].sort((a, b) => b.n - a.n).slice(0, 8).sort((a, b) => a.name.localeCompare(b.name));
  if (axes.length < 3) return '<p class="small">Rate titles from at least 3 genres to see your spider chart.</p>';
  const size = 320, c = size / 2, R = 108;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
    return [c + Math.cos(a) * R * v, c + Math.sin(a) * R * v];
  };
  const ring = (v) => axes.map((_, i) => pt(i, v).join(',')).join(' ');
  let svg = '';
  for (const v of [0.25, 0.5, 0.75, 1]) svg += `<polygon points="${ring(v)}" class="sp-grid"/>`;
  axes.forEach((_, i) => { const [x, y] = pt(i, 1); svg += `<line x1="${c}" y1="${c}" x2="${x}" y2="${y}" class="sp-grid"/>`; });
  svg += `<polygon points="${axes.map((g, i) => pt(i, g.avg / 100).join(',')).join(' ')}" class="sp-shape"/>`;
  axes.forEach((g, i) => {
    const [x, y] = pt(i, g.avg / 100);
    svg += `<circle cx="${x}" cy="${y}" r="5" class="sp-dot"/><circle cx="${x}" cy="${y}" r="16" class="sp-hit" data-tip="${esc(g.name)}: average ${g.avg} from ${g.n} rated"/>`;
    const [lx, ly] = pt(i, 1.2);
    const anchor = Math.abs(lx - c) < 8 ? 'middle' : lx > c ? 'start' : 'end';
    svg += `<text x="${lx}" y="${ly}" text-anchor="${anchor}" class="sp-label">${esc(short(g.name))}<tspan x="${lx}" dy="18" class="sp-val">${g.avg}</tspan></text>`;
  });
  return `<svg viewBox="-70 -22 ${size + 140} ${size + 50}" class="spider" role="img" aria-label="Average score by genre">${svg}</svg>
    <p class="small center">Average score you give each genre · tap a dot</p>`;
}

// Horizontal bars, one hue, value written at the end of each bar.
function bars(items, valueOf, labelOf, max = 100) {
  if (!items.length) return '<p class="small">Not enough ratings yet.</p>';
  return `<div class="bars">${items.map((it) => {
    const v = valueOf(it);
    return `<div class="bar-row" data-tip="${esc(labelOf(it))}">
      <span class="bar-name">${esc(it.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, (v / max) * 100)}%"></span></span>
      <span class="bar-val">${v}</span></div>`;
  }).join('')}</div>`;
}

function histogram(bins) {
  const max = Math.max(1, ...bins);
  return `<div class="hist">${bins.map((n, i) => `<div class="hist-col" data-tip="Scores ${i * 10} to ${i * 10 + 9}: ${n} titles">
      <span class="hist-n">${n || ''}</span>
      <span class="hist-bar" style="height:${(n / max) * 100}%"></span>
      <span class="hist-x">${i * 10}</span></div>`).join('')}</div>`;
}

function renderProfile() {
  const s = tasteStats();
  const el = $('#profile-body');
  const tile = (n, label) => `<div class="tile"><div class="tile-n">${n}</div><div class="tile-l">${label}</div></div>`;
  const fav = (xs) => [...xs].filter((x) => x.n >= 2).sort((a, b) => b.weight - a.weight || b.avg - a.avg).slice(0, 6);
  const leastGenres = [...s.genres].filter((g) => g.n >= 2 && g.avg < s.avgAll).sort((a, b) => a.avg - b.avg).slice(0, 4);
  el.innerHTML = `
    <div class="card-box bio"><h2>Your taste</h2><p>${bio(s)}</p></div>
    <div class="tiles">
      ${tile(s.rated.length, 'Rated')}
      ${tile(s.avgAll || '–', 'Avg score')}
      ${tile(s.movies, 'Movies')}
      ${tile(s.shows, 'Shows')}
      ${tile(Object.keys(state.pinned).length, 'Pinned')}
      ${tile(Object.keys(state.unseen).length, 'Not seen')}
    </div>
    <div class="card-box"><h2>Genre map</h2>${spider(s.genres)}</div>
    <div class="card-box"><h2>Favorite themes</h2>
      ${bars(fav(s.themes), (t) => t.avg, (t) => `${t.name}: average ${t.avg} from ${t.n} rated`)}</div>
    <div class="card-box"><h2>Favorite people</h2>
      ${bars(fav(s.people), (t) => t.avg, (t) => `${t.name}: average ${t.avg} from ${t.n} rated`)}</div>
    <div class="card-box"><h2>Least favorite genres</h2>
      ${bars(leastGenres, (t) => t.avg, (t) => `${t.name}: average ${t.avg} from ${t.n} rated`)}</div>
    <div class="card-box"><h2>How you score</h2>${s.rated.length ? histogram(s.bins) : '<p class="small">Not enough ratings yet.</p>'}</div>
    <div class="card-box"><h2>By decade</h2>
      ${bars(s.decades, (t) => t.avg, (t) => `${t.name}: average ${t.avg} from ${t.n} rated`)}</div>
    <p class="small center">Scores are the average you gave titles with that tag. Tags need 2+ ratings to show.</p>`;
}

// Tap any dot, bar or column to see its numbers.
$('#profile-body').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) toast(t.dataset.tip);
});
$('#open-settings').addEventListener('click', () => goTab('settings'));

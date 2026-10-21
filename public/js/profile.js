/** Local career profile: XP / level, credits, medals per map, lifetime stats and achievements. */
const KEY = 'sp-profile';
const blank = () => ({ xp: 0, credits: 0, stats: { races: 0, wins: 0, laps: 0, driftTotal: 0, driftBest: 0, hits: 0, playMs: 0 }, medals: {}, ach: {} });

let p = blank();
try { const o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (o) p = { ...blank(), ...o, stats: { ...blank().stats, ...o.stats } }; } catch { /* private mode */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } };

export const profile = p;
export const levelOf = (xp) => Math.floor(Math.sqrt(xp / 120)) + 1;
export const xpForLevel = (l) => (l - 1) ** 2 * 120;
export const MEDALS = ['', 'bronze', 'silver', 'gold'];
export const MEDAL_TEXT = { bronze: '銅牌', silver: '銀牌', gold: '金牌' };

export const ACHIEVEMENTS = [
  { id: 'first', name: '初次上路', desc: '完成第一場比賽', test: (s) => s.races >= 1 },
  { id: 'drift1k', name: '輪胎殺手', desc: '單次漂移連鎖超過 1,000 分', test: (s) => s.driftBest >= 1000 },
  { id: 'drift5k', name: '漂移之王', desc: '單次漂移連鎖超過 5,000 分', test: (s) => s.driftBest >= 5000 },
  { id: 'laps25', name: '賽道常客', desc: '累計跑完 25 圈', test: (s) => s.laps >= 25 },
  { id: 'races10', name: '老手', desc: '完成 10 場比賽', test: (s) => s.races >= 10 },
  { id: 'win', name: '勝利滋味', desc: '多人比賽拿下第一名', test: (s) => s.wins >= 1 },
  { id: 'gold', name: '金牌得主', desc: '任一地圖取得金牌', test: (s, m) => Object.values(m).includes(3) },
];

/** gold / silver / bronze thresholds from the track length and the map's speed cap */
export function parTimes(game) {
  const t = game.track, S = game.S;
  const avg = Math.max(30, (game.vehicle.top * 3.6) * 0.5) / 3.6; // real m/s a good lap averages
  const lap = ((t.closed ? t.length : t.sFinish) / S / avg) * 1000;
  return { lap, gold: lap * game.laps, silver: lap * game.laps * 1.18, bronze: lap * game.laps * 1.4 };
}

export function medalFor(res, game) {
  if (res.mode === 'time') {
    const p = parTimes(game);
    return res.ms <= p.gold ? 3 : res.ms <= p.silver ? 2 : res.ms <= p.bronze ? 1 : 0;
  }
  if (res.mode === 'lap') {
    const lapsGold = (10 * 60 * 1000) / parTimes(game).lap / 1; // laps a par driver completes in 10 min
    return res.score >= lapsGold ? 3 : res.score >= lapsGold * 0.85 ? 2 : res.score >= lapsGold * 0.65 ? 1 : 0;
  }
  return 0;
}

/** Applies a finished race; returns what to show on the result screen. */
export function award(res, { mapId, medal = 0, place = 0, players = 1, drift = 0, driftBest = 0, hits = 0 }) {
  const before = levelOf(p.xp);
  const key = `${mapId}|${res.mode}`;
  const prevMedal = p.medals[key] || 0;
  const medalUp = medal > prevMedal;
  if (medalUp) p.medals[key] = medal;

  let credits = 300 + medal * 250 + Math.round(drift * 0.15) + (res.laps || 0) * 40;
  let xp = 120 + medal * 90 + Math.round(drift * 0.05) + (res.laps || 0) * 25;
  if (res.mode === 'multi') {
    const bonus = Math.max(0, players - place) / Math.max(1, players);
    credits += Math.round(500 * bonus); xp += Math.round(200 * bonus);
  }
  p.credits += credits; p.xp += xp;
  const s = p.stats;
  s.races++; s.laps += res.laps || 0; s.driftTotal += drift; s.driftBest = Math.max(s.driftBest, driftBest); s.hits += hits;
  s.playMs += res.ms || 0;
  if (res.mode === 'multi' && place === 1) s.wins++;

  const unlocked = [];
  for (const a of ACHIEVEMENTS) if (!p.ach[a.id] && a.test(s, p.medals)) { p.ach[a.id] = Date.now(); unlocked.push(a); }
  save();
  return { credits, xp, medal, medalUp, level: levelOf(p.xp), levelUp: levelOf(p.xp) > before, unlocked, drift };
}

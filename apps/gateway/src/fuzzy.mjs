// Fuzzy text matching for voice commands (no AI): spelling similarity (Jaro-Winkler) + sound-alike keys
// (a light metaphone) + word-set alignment for multi-word names. Pure functions, unit-tested.

export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/&/g, " and ").replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const words = (s) => norm(s).split(" ").filter(Boolean);

/** Jaro-Winkler similarity in [0,1]. */
export function jw(a, b) {
  if (a === b) return 1; if (!a || !b) return 0;
  const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1), am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = Math.max(0, i - md); j < Math.min(b.length, i + md + 1); j++) if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const j = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0; while (p < 4 && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

/** Sound-alike key (simplified metaphone): "codecs"/"codex" → "ktks", "kramer"/"cramer" → "krmr". */
export function phon(w) {
  let s = norm(w).replace(/\s/g, ""); if (!s) return "";
  s = s.replace(/^kn|^gn|^pn|^wr/, (x) => x[1]).replace(/^x/, "s").replace(/ph/g, "f").replace(/ck/g, "k").replace(/sch/g, "sk")
    .replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/q/g, "k").replace(/x/g, "ks").replace(/z/g, "s")
    .replace(/dg(?=[eiy])/g, "j").replace(/gh(?![aeiou])/g, "").replace(/th/g, "0").replace(/sh/g, "x").replace(/v/g, "f").replace(/d$/, "t");
  const first = s[0]; s = first + s.slice(1).replace(/[aeiouyhw]/g, "");
  return s.replace(/(.)\1+/g, "$1");
}

/** Similarity of two words: the better of spelling and sound (sound slightly discounted). */
export function wordSim(a, b) {
  a = norm(a); b = norm(b); if (a === b) return 1;
  const pa = phon(a), pb = phon(b);
  return Math.max(jw(a, b), pa && pb ? jw(pa, pb) * 0.96 : 0);
}

/** Phrase similarity: whole-string similarity, or word-by-word alignment (each target word to its best spoken word),
 *  penalizing extra spoken words lightly. Good for "go to the deck one" vs "Deck builder" style matches. */
export function phraseSim(spoken, target) {
  const s = words(spoken), t = words(target); if (!s.length || !t.length) return 0;
  const whole = Math.max(jw(s.join(" "), t.join(" ")), jw(s.map(phon).join(" "), t.map(phon).join(" ")) * 0.96);
  const per = t.map((tw) => Math.max(...s.map((sw) => wordSim(sw, tw))));
  const align = per.reduce((a, b) => a + b, 0) / t.length - Math.max(0, s.length - t.length) * 0.02;
  return Math.max(whole, align);
}

/** Rank candidates [{key, phrases:[...]}] against spoken text. Returns sorted [{key, score}] (best phrase per key). */
export function rank(spoken, candidates, sim = phraseSim) {
  return candidates.map((c) => ({ ...c, score: Math.max(...c.phrases.map((p) => sim(spoken, p))) })).sort((a, b) => b.score - a.score);
}

/** Decide on a ranking: a clear winner (≥ hi and ahead of the runner-up by margin), close candidates, or nothing. */
export function decide(ranked, { hi = 0.88, lo = 0.78, margin = 0.04 } = {}) {
  const [a, b] = ranked;
  if (!a || a.score < lo) return { kind: "none" };
  if (a.score >= hi && (!b || a.score - b.score >= margin)) return { kind: "match", best: a };
  return { kind: "maybe", options: ranked.filter((r) => r.score >= lo).slice(0, 3) };
}

/** Levenshtein similarity in [0,1] (1 - distance / longer length). Unlike Jaro-Winkler it does not over-reward a shared start. */
export function lev(a, b) {
  if (a === b) return 1; if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** Similarity for short whole commands: every word counts (edit distance on text and on sound keys), plus a two-way
 *  word alignment so word order/extra fillers matter less. "a prove"≈"approve", but "whats the weather"≠"whats the status". */
export function intentSim(spoken, target) {
  const s = words(spoken), t = words(target); if (!s.length || !t.length) return 0;
  const text = lev(s.join(" "), t.join(" ")), sound = lev(s.map(phon).join(""), t.map(phon).join("")) * 0.96;
  const strong = (v) => (v >= 0.85 ? v : 0); // a weak word pair is no match (stops "status" pairing with "whats")
  const ab = (x, y) => y.reduce((acc, yw) => acc + strong(Math.max(...x.map((xw) => wordSim(xw, yw)))), 0) / y.length;
  const align = Math.min(ab(s, t), ab(t, s));
  return Math.max(text, sound, align);
}

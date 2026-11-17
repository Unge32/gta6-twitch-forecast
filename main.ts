// GTA VI launch-day Twitch forecast — entry for make.fun gta6-twitch-ccu-forecast-01.
// Node 22+, standard library only, runs offline: it reads one case file per run and
// writes five quantiles (5/25/50/75/95%) of the Twitch category's concurrent viewers
// for each of hours 2..24 of the release day, anchored on hour 1's print.
//
// How it forecasts, in one paragraph. A launch day on Twitch has a shape: viewers dip
// in the small hours (01:00-04:00 UTC, Europe asleep, the US not yet unlocked), jump
// when the US east coast unlocks at 05:00 UTC, and peak in the US evening. That shape
// is not the same for every launch: the bigger the launch already is at hour 1, the
// flatter its day gets, because hour 1 already holds most of its audience — the two
// biggest past launches in the case file (ELDEN RING, Cyberpunk 2077, ~850k at hour 1)
// barely grew at all after hour 1, while small ones grew several-fold by the evening.
// So for each hour h the program fits, over the case's own comparables (past big
// launches with a full release day), a straight line in log space:
//
//   ln(viewers_h / viewers_1) = a_h + b_h * ln(viewers_1)
//
// fitted only on comparables whose hour-1 print is at least 10,000 viewers (small
// categories are noise at hour 1 and would bend the line). The forecast median for
// hour h is then hour 1's print times exp(a_h + b_h * ln(p1)), and the spread is
// the line's residual scatter: q_tau = p1 * exp(mu_h + z_tau * sigma_h) with the
// usual normal quantiles z = (-1.645, -0.674, 0, 0.674, 1.645). The size a launch is
// fed to the line is clamped to the sizes the line was fitted on, so a launch bigger
// than any comparable is forecast like the biggest comparable instead of extrapolating
// the line past the data. Where an hour has too few fitted launches, the program
// falls back to that hour's median log-ratio and scatter over the same comparables,
// and where the case holds no usable comparables at all it falls back to a flat
// persistence forecast with a spread that widens like a random walk. Everything the
// program knows comes from the case file it is given; it makes no network call and
// holds no randomness, so two runs on the same case write the same bytes.
//
// Method notes, kept with the code rather than the README: the log scale is the
// contest's own scale (the pinball loss is scored on log viewers), so fitting in
// logs is fitting what is scored; the five quantiles of a log-normal hour are the
// median times exp(z * sigma), which is exactly the form above.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The five levels the contest scores, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at those levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** A comparable only joins the fit when its hour-1 print is at least this big. */
const MIN_HOUR1 = 10000;
/** An hour's line needs at least this many fitted launches to be trusted. */
const MIN_PAIRS = 5;
/** Fallback spread (log units per square-root hour) when no comparables can be used. */
const FALLBACK_SIGMA = 0.15;

interface HourlyPoint {
  from: string;
  viewers: number;
  channels?: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  id: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history: Array<{ at: string; viewers: number }>;
  comparables: Comparable[];
}

/** One fitted hour: the line's intercept and slope, its residual scatter, and the
 *  range of launch sizes it was fitted on (for clamping the case's size to it). */
interface HourFit {
  a: number;
  b: number;
  sigma: number;
  xMin: number;
  xMax: number;
}

/** x rounded to 2 decimals, half up. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Whole hours from `dayStart` (ISO string) to `at` (ISO string). */
function hourOffset(dayStart: string, at: string): number {
  return Math.floor((Date.parse(at) - Date.parse(dayStart)) / 3600000) + 1;
}

/** A comparable's release-day curve: hour (1..24) -> viewers, from its hourly points. */
function releaseDayCurve(comp: Comparable): Map<number, number> {
  const curve = new Map<number, number>();
  for (const pt of comp.hourly ?? []) {
    const h = hourOffset(comp.day_start, pt.from);
    if (h >= 1 && h <= 24 && typeof pt.viewers === 'number' && pt.viewers > 0) {
      curve.set(h, pt.viewers);
    }
  }
  return curve;
}

/** Ordinary least squares of y on x; returns intercept, slope and the residual
 *  population standard deviation. */
function ols(pairs: Array<[number, number]>): { a: number; b: number; sigma: number } {
  const n = pairs.length;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) * (x - mx);
    sxy += (x - mx) * (y - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (const [x, y] of pairs) {
    const r = y - (a + b * x);
    ss += r * r;
  }
  return { a, b, sigma: Math.sqrt(ss / n) };
}

/** Median of a list of numbers (the list is sorted in place). */
function median(xs: number[]): number {
  xs.sort((p, q) => p - q);
  const n = xs.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
}

/** Fit one line per hour over the case's comparables, plus the fallback median
 *  log-ratio and scatter per hour over the same comparables. */
function fitShape(comps: Comparable[]): { fits: Map<number, HourFit>; fallbacks: Map<number, { mu: number; sigma: number }> } {
  const curves: Array<{ v1: number; lr: Map<number, number> }> = [];
  for (const comp of comps ?? []) {
    const curve = releaseDayCurve(comp);
    const v1 = curve.get(1);
    if (v1 === undefined || v1 < MIN_HOUR1) continue;
    const lr = new Map<number, number>();
    for (const [h, v] of curve) {
      if (h >= 2) lr.set(h, Math.log(v / v1));
    }
    curves.push({ v1, lr });
  }

  const fits = new Map<number, HourFit>();
  const fallbacks = new Map<number, { mu: number; sigma: number }>();
  for (let h = 2; h <= 24; h++) {
    const pairs: Array<[number, number]> = [];
    const ratios: number[] = [];
    for (const c of curves) {
      const r = c.lr.get(h);
      if (r !== undefined) {
        pairs.push([Math.log(c.v1), r]);
        ratios.push(r);
      }
    }
    if (ratios.length > 0) {
      const mu = median(ratios);
      const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
      const sigma = Math.sqrt(ratios.reduce((s, v) => s + (v - mean) * (v - mean), 0) / ratios.length);
      fallbacks.set(h, { mu, sigma: Math.max(0.05, sigma) });
    }
    if (pairs.length >= MIN_PAIRS) {
      const { a, b, sigma } = ols(pairs);
      const xs = pairs.map(([x]) => x);
      fits.set(h, { a, b, sigma: Math.max(0.05, sigma), xMin: Math.min(...xs), xMax: Math.max(...xs) });
    }
  }
  return { fits, fallbacks };
}

/** The five quantiles for one hour, from a log-median mu and a log spread sigma. */
function quantiles(p1: number, mu: number, sigma: number): number[] {
  const qs = Z.map((z) => p1 * Math.exp(mu + z * sigma));
  const out: number[] = [];
  for (const q of qs) {
    const v = round2(clamp(q, 0.01, 1e9));
    out.push(Number.isFinite(v) ? v : p1);
  }
  // Rounding can only tie neighbours, never reverse them, but keep the row ordered.
  for (let i = 1; i < out.length; i++) {
    if (out[i] < out[i - 1]) out[i] = out[i - 1];
  }
  return out;
}

/** Forecast every hour of one case. */
function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  let p1 = first !== undefined && first.viewers > 0 ? first.viewers : 0;
  if (p1 <= 0) {
    // No hour-1 print: fall back to the last history point, else 1 viewer.
    // (The history array itself may be absent in a thin case file, so guard it.)
    const hist = c.history ?? [];
    const last = hist.length > 0 ? hist[hist.length - 1] : undefined;
    p1 = last !== undefined && last.viewers > 0 ? last.viewers : 1;
  }
  p1 = Math.max(1, p1);

  const { fits, fallbacks } = fitShape(c.comparables ?? []);
  const logP1 = Math.log(p1);
  const rows: Array<{ hour: number; q: number[] }> = [];
  for (const { hour } of c.forecast) {
    if (hour < 2 || hour > 24) continue;
    const fit = fits.get(hour);
    if (fit !== undefined && Number.isFinite(fit.a) && Number.isFinite(fit.b)) {
      const x = clamp(logP1, fit.xMin, fit.xMax);
      rows.push({ hour, q: quantiles(p1, fit.a + fit.b * x, fit.sigma) });
      continue;
    }
    const fb = fallbacks.get(hour);
    if (fb !== undefined) {
      rows.push({ hour, q: quantiles(p1, fb.mu, fb.sigma) });
      continue;
    }
    // No comparables at all: flat persistence with a widening random-walk spread.
    rows.push({ hour, q: quantiles(p1, 0, FALLBACK_SIGMA * Math.sqrt(hour - 1)) });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  if (hours.length !== 23) throw new Error(`${file} produced ${hours.length} forecast rows, not 23`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}

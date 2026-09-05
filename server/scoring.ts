/**
 * "Where do I know them from?" ranking.
 *
 * Sorting an actor's overlap by release date or popularity answers the wrong
 * question. What makes a face recognisable is how much screen time you actually
 * spent with it, weighted by how memorable the thing was to you. That's what
 * this scores.
 */

export interface ScorableCredit {
  mediaType: 'movie' | 'tv';
  billingOrder: number | null;
  episodeCount: number | null;
  /** Your rating of the title, 0–10, if you gave one. */
  rating: number | null;
  watchedAt: string | null;
  popularity: number | null;
}

export interface ScoreBreakdown {
  score: number;
  role: number;
  memorability: number;
  reach: number;
  /** Short human-readable justification, shown on the card. */
  basis: string;
}

const daysSince = (iso: string): number | null => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, (Date.now() - then) / 864e5);
};

export function scoreCredit(credit: ScorableCredit): ScoreBreakdown {
  // Billing position, decaying smoothly: 0 -> 1.0, 6 -> 0.5, 18 -> 0.25.
  // Missing billing is treated as mid-pack rather than worst-case.
  const billing = 1 / (1 + (credit.billingOrder ?? 12) / 6);

  // Episode count saturates around 50 — past that it's all "you know them well".
  const episodeScore =
    credit.episodeCount != null && credit.episodeCount > 0
      ? Math.min(1, Math.log1p(credit.episodeCount) / Math.log(51))
      : null;

  // For TV, time on screen beats billing. Sixty episodes is tens of hours with
  // a face — more exposure than any single film gives — so a long run must be
  // able to reach the top of the scale on its own, without billing dragging it
  // down. Billing only helps a short run, never caps a long one.
  const role =
    credit.mediaType === 'tv' && episodeScore !== null
      ? Math.max(episodeScore, 0.65 * episodeScore + 0.35 * billing)
      : billing;

  // You rate what you enjoyed, and you remember what you enjoyed.
  const ratingScore = credit.rating != null ? credit.rating / 10 : 0.55;
  const days = credit.watchedAt ? daysSince(credit.watchedAt) : null;
  const recency = days === null ? 0.5 : Math.exp(-days / 1100);
  const memorability = 0.7 * ratingScore + 0.3 * recency;

  // Cultural reach as a gentle tiebreak, log-scaled so runaway popularity
  // numbers can't dominate.
  const reach = Math.min(1, Math.log1p(credit.popularity ?? 0) / Math.log(151));

  const score = role * 0.55 + memorability * 0.28 + reach * 0.17;

  return { score, role, memorability, reach, basis: describeBasis(credit, billing) };
}

function describeBasis(credit: ScorableCredit, billing: number): string {
  if (credit.mediaType === 'tv' && credit.episodeCount) {
    const episodes = credit.episodeCount;
    if (episodes === 1) return 'one episode';
    if (episodes >= 40) return `series regular · ${episodes} episodes`;
    if (episodes >= 8) return `${episodes} episodes`;
    return `${episodes} episodes`;
  }
  const order = credit.billingOrder;
  if (order === null || order === undefined) return billing >= 0.5 ? 'main cast' : 'supporting';
  if (order <= 1) return 'lead role';
  if (order <= 4) return 'main cast';
  if (order <= 12) return 'supporting';
  return 'minor role';
}

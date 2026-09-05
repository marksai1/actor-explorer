/**
 * Title matching for sources that only give us a name and a year
 * (Letterboxd's export CSVs, mainly). Everything else resolves by id.
 */

const ARTICLES = /^(the|a|an|le|la|les|el|los|das|der|die)\s+/i;

/** Lowercase, de-accent, drop punctuation and leading articles. */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(ARTICLES, '')
    .trim();
}

/** Sørensen–Dice coefficient over character bigrams. 0 = nothing, 1 = identical. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

export interface Candidate {
  id: number;
  name: string;
  year: number | null;
  popularity: number;
  voteCount: number;
}

export interface MatchOutcome {
  candidate: Candidate | null;
  score: number;
  confident: boolean;
}

/**
 * Pick the best candidate for a title/year pair.
 *
 * Confidence is deliberately conservative: a wrong auto-match silently pollutes
 * the library and is far more annoying to discover later than a row sitting in
 * the unresolved queue waiting for one click.
 */
export function pickBest(
  rawTitle: string,
  rawYear: number | null | undefined,
  candidates: Candidate[],
): MatchOutcome {
  if (candidates.length === 0) return { candidate: null, score: 0, confident: false };

  const target = normalizeTitle(rawTitle);

  const scored = candidates
    .map((candidate) => {
      const titleScore = similarity(target, normalizeTitle(candidate.name));

      let yearScore = 0;
      if (rawYear && candidate.year) {
        const gap = Math.abs(candidate.year - rawYear);
        // Release-year disagreements of a year are common (festival vs. wide release).
        yearScore = gap === 0 ? 1 : gap === 1 ? 0.6 : gap <= 2 ? 0.2 : -0.6;
      } else {
        yearScore = 0.15; // no year to check against — mildly neutral
      }

      // Popularity only breaks ties; it must never rescue a bad title match.
      const tieBreak = Math.min(candidate.voteCount, 5000) / 5000;

      return {
        candidate,
        score: titleScore * 0.72 + yearScore * 0.24 + tieBreak * 0.04,
        titleScore,
        yearScore,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const runnerUp = scored[1];

  const exactTitle = best.titleScore > 0.995;
  const strongTitle = best.titleScore >= 0.86;
  const yearAgrees = best.yearScore >= 0.6;
  // A near-tie between two different films means we genuinely can't tell.
  const ambiguous = runnerUp !== undefined && best.score - runnerUp.score < 0.06 && !exactTitle;

  const confident =
    !ambiguous &&
    ((exactTitle && yearAgrees) ||
      (exactTitle && !rawYear) ||
      (strongTitle && yearAgrees && best.score >= 0.82));

  return { candidate: best.candidate, score: best.score, confident };
}

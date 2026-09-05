/**
 * TMDB's payload shapes, and the pure functions that read them.
 *
 * Split out of `tmdb.ts` because the browser needs these too: the published
 * build talks to TMDB directly, and it must interpret a cast member or a
 * release date exactly the way the indexer does, or the phone and the desktop
 * would quietly disagree about who played what. Nothing here touches the
 * database, the disk cache or the config, which is what makes it portable.
 */

export interface TmdbTitle {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  popularity?: number;
  vote_count?: number;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  profile_path?: string | null;
  popularity?: number;
  character?: string;
  order?: number;
  roles?: { character?: string; episode_count?: number }[];
  total_episode_count?: number;
}

export interface PersonCredit extends TmdbTitle {
  character?: string;
  episode_count?: number;
  order?: number;
}

export interface TmdbPersonResult {
  id: number;
  name: string;
  profile_path?: string | null;
  popularity?: number;
  known_for_department?: string;
  known_for?: TmdbTitle[];
}

/** Year as a number, from whichever date field the media type uses. */
export function yearOf(t: TmdbTitle): number | null {
  const date = t.release_date || t.first_air_date;
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) && year > 1870 ? year : null;
}

export function nameOf(t: TmdbTitle): string {
  return t.title || t.name || 'Untitled';
}

/** Normalises an aggregate_credits or credits entry into flat fields. */
export function castRole(member: TmdbCastMember): {
  character: string | null;
  episodeCount: number | null;
} {
  if (member.roles?.length) {
    const primary = member.roles.reduce((best, role) =>
      (role.episode_count ?? 0) > (best.episode_count ?? 0) ? role : best,
    );
    return {
      character: primary.character ?? null,
      episodeCount: member.total_episode_count ?? primary.episode_count ?? null,
    };
  }
  return { character: member.character ?? null, episodeCount: null };
}

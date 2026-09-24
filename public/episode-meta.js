// episode-meta.js — season/episode sniffing for the video downloader.
//
// Shared by the server (require('./public/episode-meta')) and the browser
// (<script src="episode-meta.js"></script>), so both parse identically.
//
// parseEpisodeMeta(str) -> { season: number|null, episode: number|null }
// Understands, in priority order:
//   S01E02, s1e2, S1-E2
//   season 2 episode 5 / season-2-episode-5 / Season_2_Episode_10
//   1x02 (scene format)
//   season 2 + ep 5 / episode 5 / e 5 in any combination or alone
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.episodeMeta = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toNum(s) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
  }

  function parseEpisodeMeta(input) {
    const out = { season: null, episode: null };
    if (!input || typeof input !== 'string') return out;
    // Query-string bits arrive as +/&/= (e.g. ?season=1&episode=1);
    // treat them all as separators.
    const str = input.replace(/[+&=]/g, ' ');
    let m;

    // 1. S01E02 / s1e2 / S1-E2
    if ((m = str.match(/\b[Ss](\d{1,3})[\s._\/-]*[Ee](\d{1,3})\b/))) {
      out.season = toNum(m[1]);
      out.episode = toNum(m[2]);
    }
    // 2. season 2 episode 5 (paired words)
    else if ((m = str.match(/\bseasons?[\s._\/-]*(\d{1,3})[\s._\/-]*episodes?[\s._\/-]*(\d{1,3})\b/i))) {
      out.season = toNum(m[1]);
      out.episode = toNum(m[2]);
    }
    // 3. 1x02 scene format. The \b guards keep resolutions like 1920x1080
    //    from matching (the digits before x have no word boundary).
    else if ((m = str.match(/\b(\d{1,2})[x×](\d{1,3})\b/))) {
      out.season = toNum(m[1]);
      out.episode = toNum(m[2]);
    }
    // 4. Loose singles, any combination: "season 2" + "ep 5", or either alone.
    else {
      const s =
        str.match(/\bseasons?[\s._\/-]*(\d{1,3})\b/i) ||
        str.match(/\b[Ss][\s._\/-]*(\d{1,3})\b/);
      // \b before the e/ep keeps words like "Game 5" (e is mid-word there)
      // from being read as episode 5.
      const e =
        str.match(/\bepisodes?[\s._\/-]*(\d{1,3})\b/i) ||
        str.match(/\b[Ee][Pp]?[\s._\/-]*(\d{1,3})\b/);
      if (s) out.season = toNum(s[1]);
      if (e) out.episode = toNum(e[1]);
    }
    return out;
  }

  // {season:2, episode:5} -> "S02E05"; season-only -> "S02"; episode-only -> "E05".
  function formatEpisodeTag(season, episode) {
    const s = season ? 'S' + String(season).padStart(2, '0') : '';
    const e = episode ? 'E' + String(episode).padStart(2, '0') : '';
    return s + e || null;
  }

  // Clean positive int or null — for values coming off the wire / from inputs.
  function cleanNum(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
  }

  return { parseEpisodeMeta, formatEpisodeTag, cleanNum };
});

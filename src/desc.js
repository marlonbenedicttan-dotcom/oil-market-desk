// One cutter for every market's profile summary.
//
// The fetchers used to end a 300-character summary at the last "; " — which is exactly the middle of
// a segment list ("... Business; Building Products Distribution Business;"). Four hundred Hong Kong
// profiles and 230 Australian ones read like that, and the nightly audit failed the whole run over
// it. Prefer a complete sentence; when the first sentence is too long, cut on a word boundary and
// say so with an ellipsis. A short source that still ends on a separator is trimmed, never shipped
// with the punctuation the audit rejects.
export function shortenDescription(text, max = 300) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= max) {
    const cut = s.replace(/[;:,]+$/, '').trim();
    // A source that stops on a separator stopped mid-list, not at a full stop. Trim the separator
    // and say it is cut, rather than presenting the fragment as a finished sentence.
    return cut === s ? cut : `${cut}\u2026`;
  }
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf('. ');
  if (i > 80) return cut.slice(0, i + 1).trim();
  return `${cut.replace(/[,;\s]+\S*$/, '').replace(/[.,;:\s]+$/, '')}\u2026`;
}

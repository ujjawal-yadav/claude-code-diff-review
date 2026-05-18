/**
 * Shared truncation helper used across review + history webviews.
 *
 * Replaces the previously-duplicated `truncate()` defined inline in
 * `webview/history/components/SessionList.tsx` and `SessionDetail.tsx`.
 * The trailing single-character ellipsis ("…") is included in the `max`
 * budget, so `truncate('abcdef', 4) === 'abc…'`.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

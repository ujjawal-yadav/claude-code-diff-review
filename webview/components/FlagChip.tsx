/**
 * v0.3 — file-level risk flag chip.
 *
 * Shows the most-severe flag's label as visible text; tooltip lists every
 * flag with its description. Severity ordering comes from `FLAG_SEVERITY`
 * in `src/riskFlagger.ts`. Returns null when `flags` is empty/undefined so
 * callers can render unconditionally.
 */

import type { RiskFlag } from '../../src/types';
// v0.5.1 (LH5): pure cross-bundle module — see `src/shared/riskFlags.shared.ts`.
// Previously this imported from `src/riskFlagger.ts`, which was de-facto
// pure but one stray `node:*` import there would have broken the webview
// bundle. The shared module makes the contract explicit.
import { FLAG_LABEL, FLAG_DESCRIPTION, primaryFlag } from '../../src/shared/riskFlags.shared';
import styles from '../styles/FlagChip.module.css';

interface Props {
  flags: ReadonlyArray<RiskFlag> | undefined;
}

export function FlagChip({ flags }: Props): JSX.Element | null {
  const primary = primaryFlag(flags);
  if (!primary || !flags || flags.length === 0) return null;
  const tooltip = flags.map((f) => `${FLAG_LABEL[f]} — ${FLAG_DESCRIPTION[f]}`).join('\n\n');
  const severityClass = severityToClass(primary);
  return (
    <span
      className={`${styles.chip} ${styles[severityClass]}`}
      title={tooltip}
      aria-label={`Risk flag: ${flags.map((f) => FLAG_LABEL[f]).join(', ')}`}
    >
      {FLAG_LABEL[primary]}
    </span>
  );
}

/**
 * v0.3 — inline risk-flag badges for a single hunk. Renders one badge per
 * flag (no "most severe wins" — hunks have few enough flags that listing
 * them all is fine). Compact styling for the hunk header.
 */
export function FlagBadges({ flags }: Props): JSX.Element | null {
  if (!flags || flags.length === 0) return null;
  return (
    <span className={styles.badges} aria-label={`Hunk flags: ${flags.map((f) => FLAG_LABEL[f]).join(', ')}`}>
      {flags.map((f) => (
        <span
          key={f}
          className={`${styles.badge} ${styles[severityToClass(f)]}`}
          title={`${FLAG_LABEL[f]} — ${FLAG_DESCRIPTION[f]}`}
        >
          {FLAG_LABEL[f]}
        </span>
      ))}
    </span>
  );
}

function severityToClass(flag: RiskFlag): 'sev_high' | 'sev_warn' | 'sev_info' {
  switch (flag) {
    case 'sensitive-path':
      return 'sev_high';
    case 'removed-error-handling':
    case 'removed-null-check':
    case 'deletion':
    case 'large-hunk':
      return 'sev_warn';
    case 'test-file':
    case 'lockfile':
      return 'sev_info';
  }
}

export const __test = { severityToClass };

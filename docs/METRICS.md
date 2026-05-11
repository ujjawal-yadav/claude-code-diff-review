# Success Metrics — Reading the Numbers

The extension emits opt-in telemetry. This document explains:

1. **What's emitted** — event catalogue
2. **How to ingest it** — three possible backends with trade-offs
3. **How to read it** — KPI definitions and SQL/KQL sketches
4. **What success looks like** — the PRD §3.2 targets and how to compute them

---

## 1. What's emitted

All events flow through `src/telemetry.ts`, which is double-gated:

- `claudeReview.telemetry === "on"` (extension setting, default `"off"`)
- `vscode.env.isTelemetryEnabled === true` (VS Code's global toggle)

Properties are PII-scrubbed before emission (deny-list: `apiKey`, `token`, `filePath`, `cwd`, `message`, `lastAssistantMessage`, `content`).

### Event catalogue

| Event | When | Properties (post-scrub) |
|---|---|---|
| `extension.activated` | On every `activate()` | `version`, `vscodeVersion`, `os` |
| `review.opened` | After orchestrator's `openReview` succeeds | `fileCount`, `hunkCount` |
| `hunk.action` | On accept/reject completion | `action`, `viaChat` (always `false` in v1 — chat-driven actions are a TODO) |
| `chat.completed` | *(planned — not yet emitted)* | `inputTokens`, `outputTokens`, `latencyMs`, `errorKind?` |
| `error` | On every classified error path | `code`, `module` |

The 10-second batched flush means events are emitted in groups; expect end-of-session backpressure on extension close (`Telemetry.dispose()` does a final flush).

---

## 2. Backend options

You need somewhere for those events to land. Three realistic paths:

### Option A — VS Code's built-in telemetry channel (Application Insights)

VS Code provides a `TelemetryLogger` API that pipes through to Microsoft's Application Insights when the extension publisher has an instrumentation key. **Free for VS Code extensions.**

- Pros: no infra to run; respects user settings natively; standard for Marketplace extensions.
- Cons: vendor lock-in to Microsoft; query interface is Application Insights / Azure Monitor (KQL).

**Setup:**
1. Get an Application Insights connection string (free tier: https://portal.azure.com).
2. Wire it: replace `createTelemetry(...)`'s sink in `extension.ts` with a `vscode.env.createTelemetryLogger(...)` adapter.
3. Query in Application Insights → Logs (KQL).

### Option B — Your own endpoint

Run a tiny HTTPS receiver (e.g. Cloud Run, Lambda, Fly.io) that accepts JSON events and writes to BigQuery / Postgres / DuckDB.

- Pros: full control; query in whatever you're already using.
- Cons: you operate it; you handle GDPR / data residency / abuse.

**Setup:**
1. Stand up an endpoint (POST `/v1/events`, accept array of `TelemetryEvent`).
2. In `extension.ts`, change the `createTelemetry` sink to a `fetch` POST.
3. Add a request-signing scheme so consumers can't spoof events.

### Option C — Open-source: PostHog (self-hosted or cloud)

PostHog has a JS SDK that works in Node. Drop-in replacement for the sink.

- Pros: product-analytics flavour (cohorts, funnels, retention) out of the box.
- Cons: SDK bundle adds ~100 KB to the extension; another vendor.

### Recommendation

Start with **Option A** for v1.0 GA. It's free, native to VS Code, and you can pivot to B/C later by swapping the sink without touching the event emission code.

---

## 3. KPI definitions

Reference: PRD §3.2 targets, restated in queryable form.

### 3.1 Weekly Active Users (WAU)

> **Target:** ≥ 5,000 at 6 months post-launch.

```kql
// Application Insights / Log Analytics (KQL)
customEvents
| where name == "extension.activated"
| where timestamp > ago(7d)
| summarize WAU = dcount(user_Id)
```

**Caveat:** `user_Id` here is Application Insights's machine-generated id — not stable across reinstalls or fresh VS Code profiles. WAU is approximate but consistent.

### 3.2 Hunk actions per session

> **Target:** ≥ 3.

```kql
let actions = customEvents
  | where name == "hunk.action"
  | where timestamp > ago(7d)
  | summarize Actions = count() by session_Id;
let sessions = customEvents
  | where name == "review.opened"
  | where timestamp > ago(7d)
  | summarize Sessions = count() by session_Id;
actions | join kind=inner sessions on session_Id
| extend ActionsPerSession = Actions / Sessions
| summarize MedianActionsPerSession = percentile(ActionsPerSession, 50)
```

### 3.3 P99 panel-open latency

> **Target:** < 1.5 s.

The orchestrator currently doesn't include `latencyMs` on `review.opened`. **Add this before GA** — it's a one-line change in `extension.ts`:

```typescript
const start = performance.now();
// ...handleStop fires, panel opens...
telemetry.event('review.opened', {
  fileCount: review.files.length,
  hunkCount: review.metrics.totalHunks,
  latencyMs: Math.round(performance.now() - start),
});
```

Then:

```kql
customEvents
| where name == "review.opened"
| where timestamp > ago(7d)
| extend latencyMs = toint(customDimensions["latencyMs"])
| summarize P99 = percentile(latencyMs, 99)
```

### 3.4 Crash-free sessions

> **Target:** ≥ 99.5 %.

```kql
let errors = customEvents
  | where name == "error"
  | where timestamp > ago(7d)
  | summarize ErrorSessions = dcount(session_Id);
let total = customEvents
  | where name in ("extension.activated", "review.opened")
  | where timestamp > ago(7d)
  | summarize TotalSessions = dcount(session_Id);
errors | join total
| extend CrashFree = 1.0 - (toreal(ErrorSessions) / toreal(TotalSessions))
| project CrashFreePercent = CrashFree * 100
```

### 3.5 Marketplace rating

Not in telemetry. Read from the listing page header, or via the Marketplace's `getExtensionsByPublisher` API (unauthenticated).

### 3.6 Day-14 retention

> **Target:** ≥ 40 %.

Define a **first-activation cohort** by day, then count returns:

```kql
let cohort = customEvents
  | where name == "extension.activated"
  | summarize FirstSeen = min(timestamp) by user_Id
  | where FirstSeen between (ago(45d) .. ago(14d))
  | project user_Id, CohortDay = bin(FirstSeen, 1d);
let returns = customEvents
  | where name == "extension.activated"
  | summarize by user_Id, EventDay = bin(timestamp, 1d);
cohort | join kind=inner returns on user_Id
| extend DaysSinceFirst = (EventDay - CohortDay) / 1d
| where DaysSinceFirst == 14
| summarize Day14Returners = dcount(user_Id) by CohortDay
| join kind=inner (cohort | summarize CohortSize = dcount(user_Id) by CohortDay) on CohortDay
| extend RetentionPercent = (toreal(Day14Returners) / toreal(CohortSize)) * 100
```

---

## 4. What success looks like

Visualize a single-page dashboard with these tiles, updated daily:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Claude Code Diff Review — Health                       Day 23 / 180 │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  WAU:                  3,142   (target 5,000 by Day 180)   on-track  │
│  Median actions/sess:    4.2   (target ≥ 3)                  ✓       │
│  P99 panel-open:     1,180ms   (target < 1,500ms)            ✓       │
│  Crash-free:        99.71 %    (target ≥ 99.5 %)             ✓       │
│  Day-14 retention:    44.3 %   (target ≥ 40 %)               ✓       │
│  Marketplace rating:    4.4    (target ≥ 4.3)                ✓       │
│                                                                      │
│  Chat invocations / wk:  837   (target ≥ 500)                ✓       │
│  Avg input tokens:     1,420                                         │
│  Avg output tokens:      490                                         │
│                                                                      │
│  Top errors (7d):                                                    │
│     E_REVERT_FUZZ_FAIL    47  (3.2% of rejects)                      │
│     E_API_RATE            12                                         │
│     E_AUTH                 4                                         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Build this in whatever your team uses (Grafana, Looker, Metabase, plain HTML on Cloud Storage, etc.). The KQL queries above translate ~directly to SQL for non-Application-Insights backends.

---

## 5. Pre-GA checklist

- [ ] Pick a backend (A / B / C) and configure the connection string.
- [ ] Add `latencyMs` to `review.opened` event (line in `extension.ts`).
- [ ] Add `chat.completed` event emission (in `chatService.ts` once stream completes).
- [ ] Verify in production that **telemetry off by default** is honoured — install a stock copy, leave settings at defaults, confirm zero events flow.
- [ ] Document the telemetry endpoint and data retention in the README's Privacy section (already written; just confirm the URL).
- [ ] Set up the dashboard with the six tiles + the error breakdown.
- [ ] Pin a **post-launch retro at Day 14** to compare actuals against PRD targets.

/* @bruin
name: analytics.score_trend
type: duckdb.sql
description: Every scored claim in order, with the running average up to that point. Shows how the pitch went over time.
materialization:
  type: table
depends:
  - raw.events
columns:
  - name: running_avg
    type: double
    checks:
      - name: not_null
      - name: non_negative
  - name: step
    type: integer
    checks:
      - name: positive
@bruin */

SELECT
    session_id,
    CAST(row_number() OVER (PARTITION BY session_id ORDER BY seq) AS INTEGER) AS step,
    seq,
    agent,
    topic,
    score,
    quote,
    reason,
    round(avg(score) OVER (PARTITION BY session_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2) AS running_avg
FROM raw.events
WHERE type = 'claim_score' AND score IS NOT NULL AND topic IS NOT NULL

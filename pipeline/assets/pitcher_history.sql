/* @bruin
name: analytics.pitcher_history
type: duckdb.sql
description: Long term memory. Average score per topic across every past session, so the committee remembers where this vendor is usually weak.
materialization:
  type: table
depends:
  - raw.events
@bruin */

SELECT
    topic,
    round(avg(score), 2) AS avg_score,
    count(*) AS n_scores,
    count(DISTINCT session_id) AS n_sessions
FROM raw.events
WHERE type = 'claim_score' AND score IS NOT NULL AND topic IS NOT NULL
GROUP BY topic

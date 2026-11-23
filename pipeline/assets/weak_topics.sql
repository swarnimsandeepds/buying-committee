/* @bruin
name: analytics.weak_topics
type: duckdb.sql
description: Topics ranked from weakest to strongest for each session. The agents read rank 1 to decide what to attack next.
materialization:
  type: table
depends:
  - raw.events
columns:
  - name: weakness_rank
    type: integer
    checks:
      - name: positive
@bruin */

SELECT
    session_id,
    topic,
    round(avg(score), 2) AS avg_score,
    count(*) AS n_scores,
    CAST(row_number() OVER (PARTITION BY session_id ORDER BY avg(score) ASC, count(*) DESC) AS INTEGER) AS weakness_rank
FROM raw.events
WHERE type = 'claim_score' AND score IS NOT NULL AND topic IS NOT NULL
GROUP BY session_id, topic

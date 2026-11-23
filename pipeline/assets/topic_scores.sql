/* @bruin
name: analytics.topic_scores
type: duckdb.sql
description: Average score each agent gave the vendor on each topic, per session.
materialization:
  type: table
depends:
  - raw.events
columns:
  - name: avg_score
    type: double
    checks:
      - name: not_null
      - name: non_negative
@bruin */

SELECT
    session_id,
    agent,
    topic,
    round(avg(score), 2) AS avg_score,
    count(*) AS n_scores
FROM raw.events
WHERE type = 'claim_score' AND score IS NOT NULL AND topic IS NOT NULL
GROUP BY session_id, agent, topic

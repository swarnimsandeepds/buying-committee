/* @bruin
name: analytics.session_summary
type: duckdb.sql
description: One row per pitch session. When it happened, how it scored, the verdict, and the strongest and weakest topic. Feeds the history view.
materialization:
  type: table
depends:
  - raw.events
columns:
  - name: session_id
    type: varchar
    checks:
      - name: not_null
      - name: unique
  - name: avg_score
    type: double
    checks:
      - name: non_negative
@bruin */

WITH topic_avg AS (
    SELECT session_id, topic, avg(score) AS a
    FROM raw.events
    WHERE type = 'claim_score' AND score IS NOT NULL AND topic IS NOT NULL
    GROUP BY session_id, topic
),
extremes AS (
    SELECT session_id, arg_min(topic, a) AS weakest_topic, arg_max(topic, a) AS strongest_topic
    FROM topic_avg
    GROUP BY session_id
)
SELECT
    e.session_id,
    min(e.ts) AS started_at,
    CAST(count(*) FILTER (WHERE e.type = 'claim_score') AS INTEGER) AS n_claims,
    round(avg(e.score) FILTER (WHERE e.type = 'claim_score'), 2) AS avg_score,
    max(CASE WHEN e.type = 'verdict' THEN e.topic END) AS verdict,
    x.weakest_topic,
    x.strongest_topic,
    max(CASE WHEN e.type = 'pitch' THEN e.text END) AS pitch
FROM raw.events e
LEFT JOIN extremes x ON x.session_id = e.session_id
GROUP BY e.session_id, x.weakest_topic, x.strongest_topic

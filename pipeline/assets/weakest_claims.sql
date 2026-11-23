/* @bruin
name: analytics.weakest_claims
type: duckdb.sql
description: The lowest scored things the vendor said, with the exact quote and the agent's reason. Used as evidence in the final feedback.
materialization:
  type: table
depends:
  - raw.events
@bruin */

SELECT
    session_id,
    agent,
    topic,
    score,
    quote,
    reason,
    CAST(row_number() OVER (PARTITION BY session_id ORDER BY score ASC, seq ASC) AS INTEGER) AS claim_rank
FROM raw.events
WHERE type = 'claim_score' AND score IS NOT NULL AND quote IS NOT NULL AND quote <> ''

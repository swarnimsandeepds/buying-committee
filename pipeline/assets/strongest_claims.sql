/* @bruin
name: analytics.strongest_claims
type: duckdb.sql
description: The highest scored things the vendor said, with the exact quote and the agent's reason. The "pros" side of the final report.
materialization:
  type: table
depends:
  - raw.events
columns:
  - name: claim_rank
    type: integer
    checks:
      - name: positive
@bruin */

SELECT
    session_id,
    agent,
    topic,
    score,
    quote,
    reason,
    CAST(row_number() OVER (PARTITION BY session_id ORDER BY score DESC, seq ASC) AS INTEGER) AS claim_rank
FROM raw.events
WHERE type = 'claim_score' AND score IS NOT NULL AND quote IS NOT NULL AND quote <> ''

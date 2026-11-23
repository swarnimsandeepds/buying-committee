/* @bruin
name: raw.events
type: duckdb.sql
description: Every decision the committee agents make, one row per event. Source is the app's append only ledger file.
materialization:
  type: table
columns:
  - name: event_id
    type: varchar
    description: Unique id of the event
    checks:
      - name: not_null
      - name: unique
  - name: session_id
    type: varchar
    checks:
      - name: not_null
  - name: type
    type: varchar
    checks:
      - name: not_null
      - name: accepted_values
        value: ["pitch", "claim_score", "reaction", "question", "answer", "insight", "research", "deliberation", "vote", "verdict"]
  - name: score
    type: double
    description: Agent score of a vendor claim, 0 to 10
    checks:
      - name: non_negative
custom_checks:
  - name: scores never exceed 10
    query: SELECT count(*) FROM raw.events WHERE score > 10
    value: 0
@bruin */

SELECT
    event_id,
    session_id,
    seq,
    ts,
    type,
    agent,
    topic,
    score,
    quote,
    reason,
    text
FROM read_json(
    'data/events.jsonl',
    format = 'newline_delimited',
    columns = {
        event_id: 'VARCHAR',
        session_id: 'VARCHAR',
        seq: 'INTEGER',
        ts: 'VARCHAR',
        type: 'VARCHAR',
        agent: 'VARCHAR',
        topic: 'VARCHAR',
        score: 'DOUBLE',
        quote: 'VARCHAR',
        reason: 'VARCHAR',
        text: 'VARCHAR'
    }
)

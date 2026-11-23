# The Buying Committee

Pitch your product out loud to a 3D boardroom of three AI buyers. They question you, argue with each other, and vote BUY or NO BUY with evidence.

Built at the Multiplayer AI Hackathon, Track 3: Grow with Agents.

## How it meets the brief

| Requirement | Where |
| --- | --- |
| 3+ agents with own goals | Dana (CFO), Raj (CTO), Maya (Head of Sales Ops), each with separate concerns and a private score of you |
| Characters, 3D, movement | Three.js boardroom. Agents turn to whoever is speaking, lean in, gesture, nod, shake their heads, frown as their score drops |
| Voice | Each agent has its own voice. You answer by microphone |
| Visible decisions | Decision ledger on the right: every score, question choice, argument and vote, with the reason |
| Agents coordinate about the human | Open deliberation after you leave the room, then a vote. Agents can change their minds |
| Agents adapt | After every answer the Bruin pipeline recomputes your weakest topic and the next agent attacks it |
| Memory that changes decisions | Bruin keeps every past session. The committee starts the next pitch knowing where you were weak last time |
| Clear result with evidence | Verdict screen with each vote, your three weakest quotes and score by topic |

## How Bruin is used (mandatory tool)

1. The server appends every agent decision to `data/events.jsonl`.
2. After every turn it runs `bruin run pipeline`, which builds five DuckDB tables with quality checks:
   `raw.events`, `analytics.topic_scores`, `analytics.weak_topics`, `analytics.weakest_claims`, `analytics.pitcher_history`.
3. The server reads those tables back with `bruin query` and hands the result to the next agent.

Bruin is the agents' shared memory and the source of the ledger, the adaptive questions and the final feedback.

## How BAND is used

Dana, Raj and Maya are each a BAND remote agent. Every session opens a BAND room with the three of them and the human owner.

1. The agents post their questions, the vendor's answers, their arguments and their votes to each other in the room, so a human can watch the committee work live in BAND.
2. Before an agent argues or votes, it reads what its colleagues addressed to it on BAND and uses that in its decision.

Turn it on by adding the three agent keys to `.env` (`BAND_CFO_KEY`, `BAND_CTO_KEY`, `BAND_USER_KEY`). Without them the app runs the same, minus the room.

## Run it

```
# 1. Install Bruin (once)
curl -LsSf https://getbruin.com/install/cli | sh

# 2. Add your LLM key
cp .env.example .env      # then paste a key into .env

# 3. Start
node server.js
```

Open http://localhost:3000 in Chrome. No npm install needed.

No API key? If the Claude Code CLI is installed and signed in, the server uses it automatically (`claude -p`, about 20 seconds per turn). With neither, it runs in demo mode with canned lines.

Check the pipeline on its own: `bruin validate pipeline` then `bruin run pipeline`.

## Files

- `server.js`: agents, LLM calls, ledger, Bruin calls, BAND room
- `public/index.html`: 3D room, voices, ledger UI
- `pipeline/`: Bruin pipeline (SQL assets with checks)
- `.bruin.yml`: local DuckDB connection (no secrets)

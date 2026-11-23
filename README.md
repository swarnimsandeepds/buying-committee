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
| Agents adapt | Two questions, each from the member who owns your weakest topic, and they stop after one if all three have already made up their minds. After every answer the Bruin pipeline recomputes your weakest topic and the next agent attacks it |
| Memory that changes decisions | Bruin keeps every past session. The committee starts the next pitch knowing where you were weak last time |
| Clear result with evidence | Verdict screen with each vote, your three weakest quotes and score by topic |

## How Bruin is used (mandatory tool)

1. The server appends every agent decision to `data/events.jsonl`.
2. After every turn it runs `bruin run pipeline`, which builds eight DuckDB tables with quality checks:
   `raw.events`, `analytics.topic_scores`, `analytics.weak_topics`, `analytics.weakest_claims`, `analytics.strongest_claims`, `analytics.score_trend`, `analytics.session_summary`, `analytics.pitcher_history`.
5. The live card in the ledger animates the scores after every turn (bar = committee average, dots = each buyer) and filters the ledger by topic or buyer. The History button charts every past pitch from `analytics.session_summary`.
4. The verdict screen is an interactive Bruin report: a radar of scores by topic, a claim-by-claim trend line, filters per buyer and topic, and pros and cons with the exact quotes.
3. The server reads those tables back with `bruin query` and hands the result to the next agent.

Bruin is the agents' shared memory and the source of the ledger, the adaptive questions and the final feedback.

## How BAND is used

Dana, Raj and Maya are each a BAND remote agent. Every session opens a BAND room with the three of them and the human owner.

1. The agents post their questions, the vendor's answers, their arguments and their votes to each other in the room, so a human can watch the committee work live in BAND.
2. Before an agent argues or votes, it reads what its colleagues addressed to it on BAND and uses that in its decision.

Turn it on by adding the three agent keys to `.env` (`BAND_CFO_KEY`, `BAND_CTO_KEY`, `BAND_USER_KEY`). Without them the app runs the same, minus the room.

## How Telem is used

Right after the pitch, Raj picks the vendor's most checkable claim and searches the live web through Telem. What he finds goes into the ledger with its sources, into the BAND room, and into every later question, score, argument and vote. All searches for one pitch share a Telem session, so the research is one trace in the Telem console.

Turn it on by adding `TELEM_API_KEY` to `.env`.

## How Glasser is used

While Raj checks a claim on the web, Dana checks the money side through Glasser: a market search for price and ROI benchmarks, plus a company profile (size, revenue, funding) for any real company the pitch leans on. Her findings go into the ledger with sources, into the BAND room, and into her own questions and vote.

Turn it on by adding `GLASSER_API_KEY` to `.env`.

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

## Deploy (Render, free plan)

The repo has a `Dockerfile` (Node plus the Bruin CLI) and a `render.yaml` blueprint. On Render choose New > Blueprint, pick this repo, and paste your keys when asked. Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for real buyer replies; without one the hosted app runs in demo mode. The free plan sleeps after 15 minutes idle, so the first visit can take about a minute, and history resets on each deploy.

## Files

- `server.js`: agents, LLM calls, ledger, Bruin calls, BAND room
- `public/index.html`: 3D room, voices, ledger UI
- `pipeline/`: Bruin pipeline (SQL assets with checks)
- `.bruin.yml`: local DuckDB connection (no secrets)

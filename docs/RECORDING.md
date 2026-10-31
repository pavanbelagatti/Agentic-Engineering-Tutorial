# Recording run-of-show

Target length: 12–15 minutes. The terminal is the main character; Port appears at the moments
where it changes what the agents can know or do.

## Screen layout

One terminal window split into four panes, plus a browser with Port:

```
┌──────────────────────────┬──────────────────────────┐
│ A · npm run app          │ B · npm run load         │
│ (service heartbeat)      │ (green → red → green)    │
├──────────────────────────┴──────────────────────────┤
│ C · npm run agents   (biggest pane: the star)        │
├─────────────────────────────────────────────────────┤
│ D · commands (deploy, reset)                         │
└─────────────────────────────────────────────────────┘
Browser tabs: payments-api entity page · Incidents page · Rollback service runs
```

Bump the terminal font size so tool calls are readable at 1080p.

## Before you hit record

1. `npm run reset`, then restart all panes. Let load run 1–2 minutes for a clean baseline.
2. Do a full dress rehearsal in mock mode (`AGENT_MODE=mock`) to check timing and the Port setup.
3. Switch to `AGENT_MODE=llm` for the real take. LLM wording varies run to run, which is fine and
   looks authentic; do two takes and keep the better one.
4. Make sure you're logged into Port as an approver, and the tunnel is up.

## Shot list

**0:00 · Cold open (30s).** Load pane is green. Run the deploy in pane D. Ten seconds later the load
pane turns red. Cut to the title card.
> "A routine release just took down payments. Let's watch a team of agents handle it, and see what
> they need from us to do it safely."

**0:30 · The human way (1 min).** Talk over the red terminal: dashboards, log searches, finding who
deployed what, finding the owner, deciding whether to roll back. Tabs, Slack pings, 20 minutes.

**1:30 · The pattern (2 min).** Show the workflow diagram from the README. Explain each box. Address
the obvious question: *why several agents and not one?* Narrow tools per agent, parallel work,
easier to debug, and smaller blast radius. Point at the human-approval box: agents propose, people
approve.

**3:30 · The code, briefly (2 min).** Open `agents/runAgent.js` (about 60 lines: the whole agent
loop). Then `agents/deploymentAgent.js`: two tools, both reading Port. Make the point: the agent is
only as good as the context it can reach. The catalog is that context.

**5:30 · Run it (4 min).** Replay the incident live (reset first if you filmed the cold open
separately). In pane C, narrate:
- Incident opened in Port. Flip to the Incidents page: it's there, `Investigating`.
- Three agents start at once; point out the interleaved tool calls.
- Deployment Agent: "it just asked Port who owns this and what changed, and found v2.4.1 shipped
  seconds before the alert."
- Correlation Agent: root cause, confidence, and what it ruled out (the fraud-check noise).
- "The agents want to roll back. They can't. They can only ask."

**9:30 · Human approval (1.5 min).** Open the pending run in Port. Read the reason field on camera
(root cause and evidence). Approve. Back to pane C: rollback starts immediately.

**11:00 · Verify (1 min).** Load pane turns green. Verify Agent confirms recovery. Pane C prints
the resolved banner.

**12:00 · The receipts (1.5 min).** In Port: incident is `Resolved` with root cause, evidence and
agent timeline. The v2.4.1 deployment is `Rolled back`. The run page shows the logs and every
catalog change tied to it. "This is what makes agents trustworthy in production: you can see what
they knew, what they asked for, who approved, and what changed."

**13:30 · Wrap (30s).** Recap the pattern (context → parallel investigation → correlate → human gate
→ act → verify) and that it applies with any agent framework. Port is the layer that gives agents
context and a safe way to act.

## Retakes

`npm run reset`, restart `npm run agents`, wait a minute of green traffic, deploy again.
`npm run investigate` reruns just the investigation if you only need that segment.

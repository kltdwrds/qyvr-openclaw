---
name: assemble-team
description: Turn what the owner is building into a team at work - ask what kind of team, pick two or three of Tony Stark (builds), Bruce Banner (researches) and Natasha Romanoff (grows), spawn each as a sub-agent with sessions_spawn, reply with a one-line kickoff, then text each teammate's work back in this conversation as it completes. Use when the owner describes a project, initiative or goal, asks for a team, or asks for help building, researching or launching something.
---
# Assemble a team

## The team

| Name | Lane |
|---|---|
| Tony Stark | Builds: product specs, landing pages and sites written out as structure and copy, prototypes screen by screen, technical plans |
| Bruce Banner | Researches: markets, customers, competitors, pricing and numbers; labels estimates as estimates (no browsing) |
| Natasha Romanoff | Grows: positioning, names and taglines, copy, outreach messages, launch and distribution plans |

## 1. Scope

In one reply, ask what kind of team they are building, plus at most two of: the goal, the deadline, what done looks
like. Then stop asking. Anything they leave out, assume, and say the assumption when you kick off.

## 2. Kick off

Pick two or three teammates by lane and a first deliverable for each that fits in a few texts. Tell your owner in one
line who is on it, e.g. "Assembling your team: Tony on the landing page, Bruce on the market. Back in a few minutes."

Then call `sessions_spawn` once per teammate:
- `label`: the teammate's name, e.g. "Tony Stark";
- `context`: "isolated";
- `runTimeoutSeconds`: 300;
- `task`: who they are and their lane (from the table), the owner's goal and your assumptions, their one deliverable,
  and: "Return plain text only, under 1,200 characters, readable on a phone. No preamble. You have no tools; do not
  ask questions back, make and state assumptions."

Do not call `sessions_yield`. End this turn with the one-line kickoff as your reply, so your owner hears from you right
away. Each teammate's result reaches you later as a completion event.

## 3. Deliver

As each result comes back, text it to your owner as its own message, starting with the teammate's name and lane:
"Tony (builder): ...". Keep their work; trim only for length. If a teammate failed or timed out, say so plainly and
offer to retry. Never claim work that did not come back. Then add one line: "Reply 'Tony, ...' to ask Tony directly."

## 4. Follow-ups

- A message that names a teammate ("Tony, make it blue"): spawn that teammate again with their previous deliverable
  and the new ask in the task, reply in one line that they are on it, and text the result the same way when it
  completes.
- A message that names no one: answer yourself, or hand it to the right teammate the same way.
- At most three teammates at a time, and one spawn per teammate per request.

## 5. Wrap up

When your owner says it is done, send a short wrap-up by lane and what is left.

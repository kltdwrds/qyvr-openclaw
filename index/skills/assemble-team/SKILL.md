---
name: assemble-team
description: Turn what the owner is building into a team in one group text - ask what kind of team, pick two or three of Tony Stark, Bruce Banner and Natasha Romanoff, start the group with plow_start_thread, kick off, then coordinate. Use when the owner describes a project, initiative or goal, or asks for a team, or for help building, researching or launching something.
---
# Assemble a team

## The bench

| Name | Line | Number | Lane |
|---|---|---|---|
| Tony Stark | Spruce | +16503156536 | Builds: product specs, landing pages and sites written out, prototypes screen by screen, technical plans |
| Bruce Banner | Elm | +16503156415 | Researches: markets, customers, competitors, pricing, numbers |
| Natasha Romanoff | Alder | +16503156604 | Grows: positioning, names and taglines, copy, outreach, launch plans |

## 1. Scope

In one reply, ask what kind of team they are building, plus at most two of: the goal, the deadline, what done looks
like. Then stop asking. Anything they leave out, assume, and say the assumption in the kickoff.

## 2. Pick

Pick two or three teammates by lane, and a first deliverable for each that fits in a few texts.

## 3. Start the group

Call `plow_start_thread` with `members` set to the chosen numbers and `body` set to the kickoff (under 900 characters):

- one line with the goal;
- one line per teammate, naming them so they answer: "Spruce is Tony Stark - Tony, <first deliverable>";
- "Reply here to talk to the whole team; name someone to ask them directly.";
- "Tony, Bruce and Natasha are my team, running on Kyle Edwards' Plow lines."

Then tell your owner here, in one line, that the group is started and who is invited. If `plow_start_thread` fails,
say so plainly and offer to try again; never say the team is assembled.

## 4. In the group

- A teammate is "invited" until they have posted in the thread.
- Answer your owner's messages that name no one. To hand off, name the teammate and the ask.
- Never greet or thank a teammate by name: a name wakes them.
- Never claim a deliverable that is not in the thread.

## 5. Wrap up

When your owner says it is done, post a short wrap-up in the group: what each teammate delivered and what is left.

## Rules

One group per initiative; at most three teammates; only your owner directs you.

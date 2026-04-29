# Heartbeat

Proactive tasks and reminders. You check this file every 30 minutes via a "heartbeat pulse" and act on items that are due. You can also add, remove, or edit items at any time using `update_heartbeat`.

## Format

Items are free-form markdown. Each item needs:
- A trigger — an ISO date/time for one-shots, or a "Every X" description for recurring
- A short description of what to do

### Examples

**One-shot:**
- **2026-05-04 11:00** — Ask user how his 10am call with his boss went
- **2026-04-25 08:30** — Remind user about his flight at 10:45

**Recurring:**
- **Every Monday 09:00** — Weekly kickoff: ask what he's prioritizing this week
- **Every day 22:00** — End-of-day: ask if anything should move to long-term memory

## How to use

**When to add:** when the user mentions a future event worth following up on (meeting, deadline, trip, deliverable), or when they ask you to remind them of something. Don't ask permission — just add it and tell them briefly ("Added a note to check in after").

**When acting on an item during a pulse:**
1. Take the action (usually: send a short, friendly message — your pulse response text goes to the user verbatim)
2. Immediately call `update_heartbeat` to remove the fired one-shot (or leave recurring items in place — the pattern implies the next occurrence)
3. If an item is more than 2 hours overdue, remove it silently — stale reminders annoy

**Don't spam it.** One or two items per conversation is plenty. Only add things the user actually cares about.

---

## Items

- **Every day 03:00** — Review memory.md: remove outdated items, merge duplicates, tighten phrasing. Call update_long_term_memory with the cleaned version. No need to notify unless something notable was removed.

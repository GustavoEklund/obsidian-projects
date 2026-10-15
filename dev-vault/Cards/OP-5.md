---
key: OP-5
title: Signup fails with an email containing '+'
status: todo
type: bug
priority: high
assignee: Carla
labels: [ signup ]
due: 2026-10-13
parent: OP-2
rank: X
created: 2026-09-20T17:07:41.062Z
updated: 2026-10-12T17:07:41.062Z
---

Steps: sign up with `name+test@example.com`.

The validator rejects the `+`.

## Comments

> [!comment|s5x1,2026-10-13T17:07:41.062Z] Bruno · 2026-10-13 14:07
> This breaks signups for corporate customers, worth prioritizing.

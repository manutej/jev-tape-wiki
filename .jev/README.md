# .jev — vendored from manutej/jev-elder/core (v0.1.0)

Do not edit files here. Change `jev-elder/core`, then run `node core/sync.mjs <this repo>`.
`node .jev/check.mjs` fails CI if these files drift from `lock.json`.

## The contract, in one screen

- **Model:** `jev-1.13.0` only. `jev-latest` only with `allowUnpinned: "drift-measurement"`. Endpoint `https://api.typesafe.ai/v1/systemone`; gateway id `typesafe-ai/jev`.
- **Questions:** `noul` (gateway name `boolean`), `choice` (2–255 criteria), `score` (2–10 levels). Noul in 0.4–0.6 is a coin flip.
- **Key:** `TYPESAFE_API_KEY` from the environment. Missing key: fail closed: throw; never fake or default a verdict. Never in: committed files, chat, browser storage, Apps Script, URLs, logs.
- **Gate:** GREEN / AMBER / RED, computed by code, never chosen by the model. Recombine on an aggregate, never a conjunction of confidences (JEV-works L1). A local RED is final.
- **θ:** no shared default; must exceed 0.5; every θ says where it came from (`calibrated:<file>` or `smoke-only`). Smoke-only never applies an action.
- **Human gate (C10):** Complete, Trash, ResolveWaiting, send, merge-to-default wait for a named human even on GREEN.
- **Clarify arms:** NextAction, Project, Someday, Waiting. "uncertain" is not an arm; below θ stay in Inbox.
- **Record:** one log row per decision (ts, surface, item_id, model, questions, answers, gate, reasons, action, applied, actor). Temporal is optional for v0; specs say 'when enabled'.
- **LLM:** drafts text only when a gate asks; never decides a gate.
- **Naming:** TypeSafe Jev (model) ≠ manutej/jev (kernel) ≠ jev-domain (Rust types). do not fuse.

Legacy gate names map to GREEN/AMBER/RED: ACT→GREEN, REVIEW→AMBER, HOLD→RED, true→GREEN, false→GREEN, escalate→AMBER, ACCEPT→GREEN, REFUSE→RED.
Why each rule: `jev-elder/core/DECISIONS.md`.

/**
 * jev-core — the one TypeSafe client and gate for every JEV repo.
 *
 * Source of truth: manutej/jev-elder/core. Repos get a hash-locked copy in `.jev/` via
 * `node core/sync.mjs <repo>`; `.jev/check.mjs` fails CI if the copy is edited by hand.
 * Zero dependencies. Runs under `node --experimental-strip-types` (no enums, no namespaces).
 *
 *   const res = await systemOne({ state, questions });            // pinned, fails closed
 *   const g = gate({ aggregate, theta: { value: 0.8, source: "calibrated:kit/results/x.json" } });
 *   if (g.apply) act();                                           // GREEN and not parked by C10
 */

/** Embedded copy of contracts.json. A test in jev-elder asserts they are identical. */
export const CONTRACT = {
  version: "0.1.0",
  decided: "2026-09-25",
  decisions: "core/DECISIONS.md",
  model: {
    pin: "jev-1.13.0",
    unpinned_ids: ["jev-latest"],
    unpinned_allowed_only_for: "drift-measurement",
    gateway_id: "typesafe-ai/jev",
    endpoint: "https://api.typesafe.ai/v1/systemone",
  },
  question_types: {
    noul: { gateway_name: "boolean", answer_field: "noul", mid_band: [0.4, 0.6] },
    choice: { min_criteria: 2, max_criteria: 255 },
    score: { min_levels: 2, max_levels: 10 },
  },
  key: {
    env: "TYPESAFE_API_KEY",
    missing: "fail closed: throw; never fake or default a verdict",
    never_in: ["committed files", "chat", "browser storage", "Apps Script", "URLs", "logs"],
  },
  gate: {
    states: ["GREEN", "AMBER", "RED"],
    computed_by: "code",
    model_may_choose_verdict: false,
    recombine_on: "aggregate, never a conjunction of confidences (JEV-works L1)",
    local_red_is_final: true,
    aliases: {
      ACT: "GREEN", REVIEW: "AMBER", HOLD: "RED",
      true: "GREEN", false: "GREEN", escalate: "AMBER",
      ACCEPT: "GREEN", REFUSE: "RED",
    },
    theta: { shared_default: null, must_exceed: 0.5, provenance_required: true, smoke_only_never_applies: true },
    noise_floor: { boolean: 0.07, score: 0.07, choice: 0.15, source: "JEV-works NETER.md P4 addendum" },
  },
  human_gate: {
    id: "C10",
    parked_even_on_green: ["Complete", "Trash", "ResolveWaiting", "send", "merge-to-default"],
    why: ["irreversible", "money", "client audience"],
  },
  clarify: {
    arms: ["NextAction", "Project", "Someday", "Waiting"],
    uncertain_is_an_arm: false,
    below_theta: "stay in Inbox",
  },
  durable_record: {
    temporal: "optional for v0; specs say 'when enabled'",
    log_row: ["ts", "surface", "item_id", "model", "questions", "answers", "gate", "reasons", "action", "applied", "actor"],
  },
  llm_role: "drafts text only when a gate asks; never decides a gate",
  naming: {
    "TypeSafe Jev": "the hosted product model, pinned above",
    "manutej/jev": "the operad kernel workbench",
    "jev-domain": "the Digest Rust Item/Command/Clarify types",
    rule: "do not fuse",
  },
} as const;

export const PIN = CONTRACT.model.pin;
export const ENDPOINT = CONTRACT.model.endpoint;
export const CLARIFY_ARMS = CONTRACT.clarify.arms;
export const C10_ACTIONS = CONTRACT.human_gate.parked_even_on_green;

// ---------------------------------------------------------------- wire types

export type JsonText = string | Record<string, unknown> | unknown[];
export type NoulQuestion = { type: "noul"; instructions: JsonText; criteria?: JsonText | { true?: JsonText; false?: JsonText } };
export type ChoiceQuestion = { type: "choice"; instructions: JsonText; criteria: Record<string, JsonText | null> };
export type ScoreQuestion = { type: "score"; instructions: JsonText; criteria: JsonText[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
/** Gateway / AI SDK spelling. Accepted on input and converted to `noul` on the wire. */
export type BooleanQuestion = { type: "boolean"; instructions: JsonText; criteria?: NoulQuestion["criteria"] };

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Request = { state: JsonText; questions: Record<string, Question | BooleanQuestion>; model?: string };
export type Response = { model: string; answers: Record<string, Answer>; usage?: { input_tokens?: number; output_tokens?: number } };

export type JevErrorCode = "no-key" | "unpinned" | "invalid-request" | "http" | "bad-response" | "wrong-model";

export class JevError extends Error {
  code: JevErrorCode;
  status: number;
  retryable: boolean;
  constructor(code: JevErrorCode, message: string, status = 0, retryable = false) {
    super(message);
    this.name = "JevError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------- request codec

/** `boolean` (gateway / AI SDK) → `noul` (TypeSafe native). Everything else passes through. */
export function toWire(q: Question | BooleanQuestion): Question {
  return q.type === "boolean" ? ({ ...q, type: "noul" } as NoulQuestion) : q;
}

/** Returns the first contract violation, or null. Pure. */
export function validateRequest(req: Request): string | null {
  const ids = Object.keys(req.questions ?? {});
  if (ids.length === 0) return "questions map is empty";
  for (const id of ids) {
    const q = toWire(req.questions[id]!);
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      const { min_criteria: lo, max_criteria: hi } = CONTRACT.question_types.choice;
      if (n < lo || n > hi) return `${id}: choice needs ${lo}-${hi} criteria, got ${n}`;
    } else if (q.type === "score") {
      const n = q.criteria?.length ?? 0;
      const { min_levels: lo, max_levels: hi } = CONTRACT.question_types.score;
      if (n < lo || n > hi) return `${id}: score needs ${lo}-${hi} levels, got ${n}`;
    } else if (q.type !== "noul") {
      return `${id}: unknown question type ${(q as { type: string }).type}`;
    }
  }
  return null;
}

export type CallOptions = {
  apiKey?: string;
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** The only way to call an unpinned id such as `jev-latest`. Recorded in the error if misused. */
  allowUnpinned?: "drift-measurement";
};

/**
 * One POST to System One. Pinned to `jev-1.13.0` unless `allowUnpinned` says why not.
 * Throws JevError on a missing key, an invalid request, an HTTP error, or a response from another model.
 * It never returns a default answer.
 */
export async function systemOne(req: Request, opts: CallOptions = {}): Promise<Response> {
  const model = req.model ?? PIN;
  if (model !== PIN && opts.allowUnpinned !== "drift-measurement") {
    throw new JevError("unpinned", `model must be ${PIN}; got ${model}. Pass allowUnpinned: "drift-measurement" to measure drift.`);
  }
  const apiKey = opts.apiKey ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[CONTRACT.key.env];
  if (!apiKey) throw new JevError("no-key", `${CONTRACT.key.env} is not set. Failing closed; no verdict.`);
  const bad = validateRequest(req);
  if (bad) throw new JevError("invalid-request", bad);

  const questions = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, toWire(q)]));
  const res = await (opts.fetch ?? fetch)(ENDPOINT, {
    method: "POST",
    signal: opts.signal,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, state: req.state, questions }),
  });
  const text = await res.text();
  // The body is echoed on failure; the key only ever travels in the header.
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new JevError("http", `TypeSafe ${res.status}: ${text.slice(0, 400)}`, res.status, retryable);
  }
  let body: Response;
  try {
    body = JSON.parse(text) as Response;
  } catch {
    throw new JevError("bad-response", `TypeSafe returned non-JSON: ${text.slice(0, 200)}`, res.status);
  }
  if (!body || typeof body.answers !== "object") throw new JevError("bad-response", "response has no answers", res.status);
  for (const id of Object.keys(questions)) {
    if (!(id in body.answers)) throw new JevError("bad-response", `response is missing answer "${id}"`, res.status);
  }
  if (model === PIN && body.model !== PIN) {
    throw new JevError("wrong-model", `asked for ${PIN}, answered by ${body.model ?? "unknown"}`, res.status);
  }
  return body;
}

// ---------------------------------------------------------------- answers

/** Noul in the mid band is a coin flip (C2): never GREEN on its own. */
export function isMidBand(a: NoulAnswer): boolean {
  const [lo, hi] = CONTRACT.question_types.noul.mid_band;
  return a.noul > lo && a.noul < hi;
}

export function isClarifyArm(x: string): x is (typeof CLARIFY_ARMS)[number] {
  return (CLARIFY_ARMS as readonly string[]).includes(x);
}

/** True when C10 parks this action for a named human, whatever the gate says. */
export function requiresHuman(action: string | undefined): boolean {
  return action !== undefined && (C10_ACTIONS as readonly string[]).includes(action);
}

// ---------------------------------------------------------------- gate

export type GateState = "GREEN" | "AMBER" | "RED";
/** θ with where it came from. `calibrated:<path>` points at the fit that produced it. */
export type Theta = { value: number; source: `calibrated:${string}` | "smoke-only" };

export type GateInput = {
  /** One number recombined by the caller's own weights. Never a conjunction of confidences. */
  aggregate: number;
  theta: Theta;
  /** Below this the aggregate is RED rather than AMBER. Optional. */
  redBelow?: number;
  /** Reasons code found to refuse. Any veto makes the result RED; the model cannot override it. */
  vetoes?: string[];
  /** Reasons to hold for review, e.g. a mid-band noul the harness branches on. */
  demotions?: string[];
  /** The command this gate would allow. C10 actions never apply automatically. */
  action?: string;
};

export type GateResult = { state: GateState; reasons: string[]; human: boolean; apply: boolean };

/** Throws on a θ the contract forbids. Call at config time so a bad θ fails before any traffic. */
export function assertTheta(t: Theta): void {
  if (!t || typeof t.value !== "number" || Number.isNaN(t.value)) throw new JevError("invalid-request", "theta.value must be a number");
  if (t.value <= CONTRACT.gate.theta.must_exceed || t.value > 1) {
    throw new JevError("invalid-request", `theta ${t.value} is not in (${CONTRACT.gate.theta.must_exceed}, 1]; ~0.5 is a coin flip (C2)`);
  }
  if (t.source !== "smoke-only" && !/^calibrated:.+/.test(t.source)) {
    throw new JevError("invalid-request", `theta.source must be "calibrated:<file>" or "smoke-only", got ${String(t.source)}`);
  }
}

/** The verdict is computed here, in code. A local RED is final. */
export function gate(input: GateInput): GateResult {
  assertTheta(input.theta);
  const reasons: string[] = [];
  let state: GateState;
  if (input.vetoes && input.vetoes.length > 0) {
    state = "RED";
    reasons.push(...input.vetoes.map((v) => `veto: ${v}`));
  } else if (!Number.isFinite(input.aggregate)) {
    state = "RED";
    reasons.push(`aggregate is not a number (${input.aggregate})`);
  } else if (input.redBelow !== undefined && input.aggregate < input.redBelow) {
    state = "RED";
    reasons.push(`aggregate ${input.aggregate.toFixed(3)} < redBelow ${input.redBelow}`);
  } else if (input.aggregate < input.theta.value) {
    state = "AMBER";
    reasons.push(`aggregate ${input.aggregate.toFixed(3)} < θ ${input.theta.value} (${input.theta.source})`);
  } else if (input.demotions && input.demotions.length > 0) {
    state = "AMBER";
    reasons.push(...input.demotions.map((d) => `demoted: ${d}`));
  } else {
    state = "GREEN";
    reasons.push(`aggregate ${input.aggregate.toFixed(3)} ≥ θ ${input.theta.value} (${input.theta.source})`);
  }
  const human = requiresHuman(input.action);
  if (human) reasons.push(`C10: ${input.action} waits for a named human`);
  const smoke = input.theta.source === "smoke-only";
  if (smoke && state === "GREEN") reasons.push("θ is smoke-only: never applies");
  return { state, reasons, human, apply: state === "GREEN" && !human && !smoke };
}

/** Maps any legacy gate vocabulary (ACT, escalate, REFUSE, …) onto GREEN/AMBER/RED. */
export function canonicalState(name: string): GateState {
  if (name === "GREEN" || name === "AMBER" || name === "RED") return name;
  const hit = (CONTRACT.gate.aliases as Record<string, string>)[name];
  if (!hit) throw new JevError("invalid-request", `unknown gate state "${name}"`);
  return hit as GateState;
}

// ---------------------------------------------------------------- durable record

export type LogRow = {
  ts: string; surface: string; item_id: string; model: string;
  questions: string[]; answers: Record<string, Answer>;
  gate: GateState; reasons: string[]; action: string | null; applied: boolean; actor: string;
};

/** One row per decision, same shape for Sheet jev_log, JSONL or Temporal. */
export function logRow(p: {
  surface: string; itemId: string; response: Response; result: GateResult; action?: string; applied: boolean; actor: string; now?: Date;
}): LogRow {
  if (p.applied && !p.result.apply) {
    throw new JevError("invalid-request", `cannot log applied=true for a ${p.result.state} result that the gate did not allow`);
  }
  return {
    ts: (p.now ?? new Date()).toISOString(),
    surface: p.surface,
    item_id: p.itemId,
    model: p.response.model,
    questions: Object.keys(p.response.answers),
    answers: p.response.answers,
    gate: p.result.state,
    reasons: p.result.reasons,
    action: p.action ?? null,
    applied: p.applied,
    actor: p.actor,
  };
}

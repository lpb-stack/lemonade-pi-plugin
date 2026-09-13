/**
 * Model-driven payload tuning + per-model catalog + generic debug log +
 * targeted first-use seeding.
 *
 * Wire payloads are modeled on captured traffic (2026-09-01,
 * Qwen3.8-27B-GGUF, pi 0.84.4, llama.cpp server b10818):
 * developer/system first (model.reasoning && supportsDeveloperRole),
 * max_completion_tokens = per-model ceiling from the catalog.
 *
 * The shipped plugin tier (lib/model-params.json) is EMPTY by design —
 * curated reference entries live in examples/model-params.example.json and
 * are seeded into the USER tier on cold start (bootstrapUserParams). All
 * tuning checks below run against a temp user file, so tests never depend
 * on a real ~/.pi/agent/model-params.json.
 *
 * Run: node_modules/.bin/jiti test/model-tuning.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySampling,
  envFlag,
  MIN_ANSWER_TOKENS,
  stripAssistantReasoning,
  thinkingBudgetLevel,
  tuneModelPayload,
} from "../lib/payload-tuning.js";
import {
  resolveModelEntry,
  samplingProfile,
  seedModelEntry,
  thinkingRow,
  isCatalogued,
} from "../lib/model-params.js";
import {
  PAYLOAD_DEBUG_PATH,
  writePayloadDebugLog,
} from "../lib/payload-debug.js";

function wirePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "Qwen3.8-27B-GGUF",
    messages: [
      { role: "developer", content: "You are an expert coding assistant." },
      { role: "user", content: "Fix the bug in main.ts" },
      { role: "assistant", content: null },
      { role: "tool", content: "tool result..." },
    ],
    max_completion_tokens: 16384,
    stream: true,
    store: true,
    stream_options: { include_usage: true },
    ...over,
  };
}

// The shape pi 0.84.4 sends per level (budget from DEFAULT_THINKING_BUDGETS,
// clamped to ceiling − 1024).
const PI_DEFAULTS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 15360, // 16384 clamped by the 1024 answer-room rule at ceiling 16384
};

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// Deterministic user tier: point the catalog at a temp file we control, so
// tests never depend on a real ~/.pi/agent/model-params.json.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "model-params-test-"));
const userFile = path.join(tmpDir, "model-params.json");
process.env.LEMONADE_PARAMS_FILE = userFile;

// The loader caches by mtime; force a distinct mtime after every test write
// so rapid consecutive writes are never collapsed by sub-ms clock resolution.
let mtimeBump = 0;
function touchUserFile() {
  mtimeBump++;
  const t = Date.now() / 1000 + mtimeBump * 0.001;
  utimesSync(userFile, t, t);
}

function writeUserFile(raw: unknown) {
  writeFileSync(userFile, typeof raw === "string" ? raw : JSON.stringify(raw, null, 1));
  touchUserFile();
}

// Seed the user tier with a full, well-documented model entry (this is the
// "catalog" the tuning checks below run against).
writeUserFile({
  "Qwen3.8-27B-GGUF": {
    reasoning: true, vision: true, maxTokens: 16384,
    budgets: { minimal: 2048, low: 3072, medium: 8192, high: 16384 },
    thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
    coding: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
    nonThinking: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
    offParams: { enable_thinking: false },
  },
});

// ── helpers ─────────────────────────────────────────────────────────────────
check("thinkingBudgetLevel: minimal", thinkingBudgetLevel("minimal") === "minimal");
check("thinkingBudgetLevel: xhigh→high", thinkingBudgetLevel("xhigh") === "high");
check("thinkingBudgetLevel: max→high", thinkingBudgetLevel("max") === "high");
check("thinkingBudgetLevel: off→undefined", thinkingBudgetLevel("off") === undefined);
check("thinkingBudgetLevel: junk→undefined", thinkingBudgetLevel("bogus") === undefined);
check("envFlag: unset→default", envFlag("LEMONADE_TEST_FLAG_XYZ", true) === true);
check("envFlag: off→false", (process.env.LEMONADE_TEST_FLAG_XYZ = "off", envFlag("LEMONADE_TEST_FLAG_XYZ", true)) === false);
check("envFlag: 1→true", (process.env.LEMONADE_TEST_FLAG_XYZ = "1", envFlag("LEMONADE_TEST_FLAG_XYZ", false)) === true);
delete process.env.LEMONADE_TEST_FLAG_XYZ;
check("samplingProfile: default general", samplingProfile() === "general");
check("samplingProfile: coding", (process.env.LEMONADE_SAMPLING_PROFILE = "coding", samplingProfile()) === "coding");
delete process.env.LEMONADE_SAMPLING_PROFILE;

// ── catalog: seeded entry (user tier — the shipped plugin tier is empty) ──
{
  const seed = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("catalog: seeded entry resolves", seed !== undefined);
  check("catalog: seed budgets.medium=8192", seed?.budgets?.medium === 8192);
  check("catalog: seed thinking.temperature=1.0", seed?.thinking?.temperature === 1.0);
  check("catalog: seed coding.temperature=0.6", seed?.coding?.temperature === 0.6);
  check("catalog: seed nonThinking.presence_penalty=1.5", seed?.nonThinking?.presence_penalty === 1.5);
  check("catalog: unknown id → undefined", resolveModelEntry("Test-Uncatalogued-9B") === undefined);
  check("catalog: empty id → undefined", resolveModelEntry("") === undefined);
}

// ── pass-through (uncatalogued / disabled) ──────────────────────────────────
{
  const p = wirePayload({ model: "Test-Uncatalogued-9B", thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  check("uncatalogued model: untouched (default pi behavior)", tuneModelPayload(p) === undefined);
}
{
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const before = deepCopy(p);
  const r = tuneModelPayload(p);
  process.env.LEMONADE_PAYLOAD_TUNING = "off";
  const r2 = tuneModelPayload(p);
  delete process.env.LEMONADE_PAYLOAD_TUNING;
  check("LEMONADE_PAYLOAD_TUNING=off: untouched", r2 === undefined);
  check("LEMONADE_PAYLOAD_TUNING on: tuned (control)", r !== undefined);
  check("input payload not mutated", JSON.stringify(p) === JSON.stringify(before));
}

// ── P6: preserveThinking — strip prior-thinking echo from assistant history ──
{
  // Tool-loop wire shape: [developer, user, assistant(thinking + toolCall), tool]
  const toolLoopMessages = () => [
    { role: "developer", content: "You are an expert coding assistant." },
    { role: "user", content: "yes, you can call me SP" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "Got it, SP. 2. What timezone are you in?",
      tool_calls: [{ id: "c1", type: "function", function: { name: "memory", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: "earlier reply", reasoning_content: "old thinking" },
  ];

  // Flag OFF → strip every reasoning field on assistant messages only
  writeUserFile({
    "Qwen3.8-27B-GGUF": { reasoning: true, preserveThinking: false },
  });
  {
    const p = wirePayload({ messages: toolLoopMessages(), thinking_budget_tokens: 8192, reasoning_effort: "medium" });
    const before = deepCopy(p);
    const r = tuneModelPayload(p);
    check("P6 off: payload rewritten", r !== undefined);
    const msgs = r?.messages as Array<Record<string, unknown>>;
    const assistants = msgs.filter((m) => m.role === "assistant");
    check("P6 off: no reasoning fields left on assistants",
      assistants.every((m) => !("reasoning_content" in m) && !("reasoning" in m) && !("reasoning_text" in m)),
      assistants);
    check("P6 off: assistant content + tool_calls preserved",
      assistants[0]?.content === null && Array.isArray(assistants[0]?.tool_calls) && assistants[1]?.content === "earlier reply",
      assistants);
    const nonAssistants = msgs.filter((m) => m.role !== "assistant");
    check("P6 off: non-assistant messages untouched",
      nonAssistants.some((m) => m.role === "tool") && JSON.stringify(msgs.filter((m) => m.role === "user")) === JSON.stringify(before.messages.filter((m) => m.role === "user")),
      nonAssistants);
    check("P6 off: input payload not mutated", JSON.stringify(p) === JSON.stringify(before));
    check("P6 off: tuning still applied (budget untouched by strip)", typeof r?.thinking_budget_tokens === "number");
  }
  // Works at the off level too (pi still echoes reasoning fields there)
  {
    const p = wirePayload({ messages: toolLoopMessages(), enable_thinking: false });
    const r = tuneModelPayload(p);
    const msgs = (r?.messages ?? []) as Array<Record<string, unknown>>;
    check("P6 off level: strip applies without thinking fields",
      r !== undefined && msgs.filter((m) => m.role === "assistant").every((m) => !("reasoning_content" in m)),
      r);
  }

  // Flag ABSENT → pi default: echo fields pass through untouched
  writeUserFile({
    "Qwen3.8-27B-GGUF": { reasoning: true },
  });
  {
    const p = wirePayload({ messages: toolLoopMessages(), thinking_budget_tokens: 8192, reasoning_effort: "medium" });
    const r = tuneModelPayload(p);
    const msgs = (r?.messages ?? p.messages) as Array<Record<string, unknown>>;
    const assistants = msgs.filter((m) => m.role === "assistant");
    check("P6 absent: reasoning_content preserved (pi default)",
      assistants.length === 2 && assistants.every((m) => typeof m.reasoning_content === "string"), assistants);
  }
  // Flag TRUE → explicitly keep the echo
  writeUserFile({
    "Qwen3.8-27B-GGUF": { reasoning: true, preserveThinking: true },
  });
  {
    const p = wirePayload({ messages: toolLoopMessages(), thinking_budget_tokens: 8192, reasoning_effort: "medium" });
    const before = deepCopy(p);
    const r = tuneModelPayload(p);
    // preserveThinking:true with no other tunables → nothing changes →
    // undefined (pass-through) means the echo fields survive untouched.
    const msgs = (r?.messages ?? p.messages) as Array<Record<string, unknown>>;
    check("P6 true: reasoning_content preserved (pass-through untouched)",
      r === undefined && JSON.stringify(p) === JSON.stringify(before)
        && msgs.filter((m) => m.role === "assistant").every((m) => typeof m.reasoning_content === "string"),
      r);
  }

  // Unit: the helper itself (returns a new array; never mutates input)
  check("stripAssistantReasoning: non-array → undefined", stripAssistantReasoning("x") === undefined);
  {
    const input = [{ role: "assistant", content: null, reasoning_content: "t", reasoning: "r", reasoning_text: "x" }];
    const before = deepCopy(input);
    const out = stripAssistantReasoning(input);
    check("stripAssistantReasoning: new array, all three fields removed",
      out !== undefined && out !== (input as unknown) && Array.isArray(out)
        && !("reasoning_content" in out[0]) && !("reasoning" in out[0]) && !("reasoning_text" in out[0]) && (out[0] as object).content === null,
      out);
    check("stripAssistantReasoning: input not mutated", JSON.stringify(input) === JSON.stringify(before));
  }
  {
    const msgs = [{ role: "user", content: "hi", reasoning_content: "should stay (not assistant)" }];
    check("stripAssistantReasoning: non-assistant untouched → undefined", stripAssistantReasoning(msgs) === undefined);
  }

  // Restore the seeded catalog for the sections below
  writeUserFile({
    "Qwen3.8-27B-GGUF": {
      reasoning: true, vision: true, maxTokens: 16384,
      budgets: { minimal: 2048, low: 3072, medium: 8192, high: 16384 },
      thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      coding: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      nonThinking: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
      offParams: { enable_thinking: false },
    },
  });
}

// ── P2: per-level budgets from the catalog ─────────────────────────────────
for (const level of ["minimal", "low", "medium", "high"] as const) {
  const p = wirePayload({ thinking_budget_tokens: PI_DEFAULTS[level], reasoning_effort: level });
  const r = tuneModelPayload(p);
  const seed = resolveModelEntry("Qwen3.8-27B-GGUF");
  const want = seed?.budgets?.[level];
  if (typeof want !== "number") throw new Error(`seed budget missing for ${level}`);
  const wantClamped = Math.min(want, 16384 - MIN_ANSWER_TOKENS);
  check(`P2: ${level} budget ${PI_DEFAULTS[level]} → ${wantClamped}`,
    r?.thinking_budget_tokens === wantClamped, r?.thinking_budget_tokens);
}
{
  // xhigh: pi clamps to high before the wire (effort "high", budget 15360)
  const p = wirePayload({ thinking_budget_tokens: 15360, reasoning_effort: "high" });
  const r = tuneModelPayload(p);
  check("P2: high stays clamped at ceiling−1024 (15360)", r?.thinking_budget_tokens === 15360, r?.thinking_budget_tokens);
}
{
  // Small ceiling (context nearly full): max_completion_tokens 4096 → cap 3072
  const p = wirePayload({ max_completion_tokens: 4096, thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P2: medium re-clamped to 3072 at ceiling 4096", r?.thinking_budget_tokens === 3072, r?.thinking_budget_tokens);
}
{
  // Defensive: raw xhigh effort on the wire maps to the high budget
  const p = wirePayload({ thinking_budget_tokens: 1024, reasoning_effort: "xhigh" });
  const r = tuneModelPayload(p);
  check("P2: raw xhigh effort → high budget (15360)", r?.thinking_budget_tokens === 15360, r?.thinking_budget_tokens);
}

// ── P3: sampling rows from the catalog ─────────────────────────────────────
{
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P3: thinking/general temperature=1.0", r?.temperature === 1.0, r?.temperature);
  check("P3: thinking/general top_p=0.95", r?.top_p === 0.95);
  check("P3: thinking/general top_k=20", r?.top_k === 20);
  check("P3: thinking/general min_p=0.0 (Qwen3.8-27B card)", r?.min_p === 0.0, r?.min_p);
  check("P3: thinking/general presence_penalty=0.0 (Qwen3.8-27B card)", r?.presence_penalty === 0, r?.presence_penalty);
  check("P3: thinking/general repetition_penalty=1.0", r?.repetition_penalty === 1.0);
}
{
  process.env.LEMONADE_SAMPLING_PROFILE = "coding";
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P3: thinking/coding temperature=0.6", r?.temperature === 0.6, r?.temperature);
  check("P3: thinking/coding top_p still 0.95 (merged over thinking)", r?.top_p === 0.95, r?.top_p);
  delete process.env.LEMONADE_SAMPLING_PROFILE;
}
{
  const p = wirePayload(); // no thinking fields → off
  const r = tuneModelPayload(p);
  check("P3: non-thinking temperature=0.7", r?.temperature === 0.7, r?.temperature);
  check("P3: non-thinking top_p=0.80", r?.top_p === 0.8);
  check("P3: non-thinking min_p=0.0", r?.min_p === 0.0);
  check("P3: non-thinking presence_penalty=1.5", r?.presence_penalty === 1.5);
}
{
  // Explicit payload fields win (pi model.samplingParams would land here)
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium", temperature: 0.4 });
  const r = tuneModelPayload(p);
  check("P3: explicit temperature preserved", r?.temperature === 0.4, r?.temperature);
  check("P3: missing top_p still filled", r?.top_p === 0.95);
}
{
  // applySampling fills only missing keys
  const out: Record<string, unknown> = { temperature: 0.5 };
  const changed = applySampling(out, { temperature: 1.0, top_p: 0.95 });
  check("applySampling: existing field not overwritten", out.temperature === 0.5 && out.top_p === 0.95 && changed === true);
}

// ── P5: off-level wire switch (offParams, fill-missing — no text suffix) ──
{
  const p = wirePayload(); // off: no budget, no effort — seeded Qwen3.8-27B-GGUF
  const r = tuneModelPayload(p);
  const lastUser = (r?.messages as any[]).find((m, i, arr) => m.role === "user" && i === arr.map((x) => x.role).lastIndexOf("user"));
  check("P5: offParams — enable_thinking:false sent at off",
    r?.enable_thinking === false, r?.enable_thinking);
  check("P5: messages untouched (no suffix logic anymore)",
    lastUser?.content === "Fix the bug in main.ts", lastUser?.content);
  check("P5: no budget/effort fields added at off",
    r?.thinking_budget_tokens === undefined && r?.reasoning_effort === undefined);
}
{
  // Developer message must not change
  const p = wirePayload();
  const r = tuneModelPayload(p);
  const dev = (r?.messages as any[]).find((m) => m.role === "developer");
  check("P5: developer message unchanged", dev?.content === "You are an expert coding assistant.");
}
{
  // Explicit wire field wins over offParams (fill-missing)
  const p = wirePayload({ enable_thinking: true });
  const r = tuneModelPayload(p);
  check("P5: explicit enable_thinking:true preserved", r?.enable_thinking === true, r?.enable_thinking);
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("P5: …messages untouched when the wire says on", user?.content === "Fix the bug in main.ts", user?.content);
}
{
  // Model WITHOUT offParams (user tier) → no wire field added, sampling only
  writeUserFile({
    "Test-Model-7B": { "nonThinking": { "temperature": 0.5 } },
  });
  const r7 = tuneModelPayload(wirePayload({ model: "Test-Model-7B" }));
  check("P5: no offParams → no wire off field added", r7?.enable_thinking === undefined, r7?.enable_thinking);
  check("P5: …sampling row still applied", r7?.temperature === 0.5);
  check("P5: …messages untouched", JSON.stringify(r7?.messages) === JSON.stringify(wirePayload().messages));

  // offParams is NOT applied at the thinking-ON level
  writeUserFile({
    "Qwen3.8-27B-GGUF": {
      budgets: { minimal: 2048, low: 3072, medium: 8192, high: 16384 },
      thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      offParams: { enable_thinking: false },
    },
  });
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("P5: offParams absent when thinking ON", r?.enable_thinking === undefined, r?.enable_thinking);
}

// ── catalog: user tier (override, missing, corrupt) ────────────────────────
{
  // Partial entry: user writes one section — the entry carries exactly that
  // (the shipped plugin tier is empty by design, so nothing is inherited)
  writeUserFile({
    "Qwen3.8-27B-GGUF": { "thinking": { "temperature": 0.42 } },
  });
  const e = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("user tier: temperature overridden", e?.thinking?.temperature === 0.42, e?.thinking?.temperature);
  check("user tier: absent section stays undefined (empty plugin tier)", e?.budgets === undefined);

  writeUserFile({
    "Qwen3.8-27B-GGUF": {
      budgets: { minimal: 2048, low: 3072, medium: 8192, high: 16384 },
      thinking: { temperature: 0.42, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
    },
  });
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("user tier: tuned payload uses overridden temp", r?.temperature === 0.42, r?.temperature);
}
{
  // New model only in the user tier
  writeUserFile({
    "Test-Model-7B": { "nonThinking": { "temperature": 0.5 } },
  });
  const e = resolveModelEntry("Test-Model-7B");
  check("user tier: user-only model resolved", e?.nonThinking?.temperature === 0.5);
  const p = wirePayload({ model: "Test-Model-7B" });
  const r = tuneModelPayload(p);
  check("user tier: user-only model tuned (off level)", r?.temperature === 0.5, r?.temperature);
  const user = (r?.messages as any[]).find((m) => m.role === "user");
  check("user tier: messages untouched for user-only model", user?.content === "Fix the bug in main.ts", user?.content);
}
{
  // No user file + empty plugin tier → the examples fallback resolves
  // recognized models (cold-start capability fix), so tuning applies from
  // the first request even before seeding. Unknown models still pass through.
  rmSync(userFile);
  const e = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("user tier: missing file → examples fallback resolves (cold-start)",
    e !== undefined && e.reasoning === true, e);
  const p = wirePayload({ thinking_budget_tokens: 8192, reasoning_effort: "medium" });
  const r = tuneModelPayload(p);
  check("user tier: missing file → tuning via examples fallback",
    r !== undefined && typeof r.temperature === "number", r?.temperature);
  const unknown = wirePayload({ model: "Totally-Unknown-9B", thinking_budget_tokens: 8192 });
  check("user tier: unknown model still passes through untouched",
    tuneModelPayload(unknown) === undefined);
}
{
  // Corrupt user file → warned + treated as missing (examples fallback
  // still resolves recognized models — the plugin tier is empty here)
  writeUserFile("this is not json");
  const e = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("user tier: corrupt file → examples fallback (reasoning=true)",
    e !== undefined && e.reasoning === true, e);
  rmSync(userFile);
}

// ── targeted first-use seeding (seedModelEntry — no bulk preload) ────────
{
  // 1. Missing file + recognized model → exactly that model is seeded
  rmSync(userFile, { force: true });
  check("seed: missing file + recognized model → seeded",
    seedModelEntry("Qwen3.6-35B-A3B-MTP-GGUF") === "seeded");
  const seededFile = JSON.parse(readFileSync(userFile, "utf8")) as Record<string, unknown>;
  check("seed: ONLY the targeted model written (no bulk preload)",
    Object.keys(seededFile).length === 1 && seededFile["Qwen3.6-35B-A3B-MTP-GGUF"] !== undefined,
    Object.keys(seededFile));
  check("seed: other example models NOT preloaded", seededFile["Qwen3.8-27B-GGUF"] === undefined);
  check("seed: seeded entry resolves (offParams present)",
    resolveModelEntry("Qwen3.6-35B-A3B-MTP-GGUF")?.offParams?.enable_thinking === false);
  check("seed: already catalogued → present (no rewrite)",
    seedModelEntry("Qwen3.6-35B-A3B-MTP-GGUF") === "present");

  // 2. Merge into an existing file — other entries untouched
  const withMine = {
    "My-Model-1B": { maxTokens: 4096 },
    "Qwen3.6-35B-A3B-MTP-GGUF": seededFile["Qwen3.6-35B-A3B-MTP-GGUF"],
  };
  writeUserFile(withMine);
  const res = seedModelEntry("Qwen3.8-27B-GGUF");
  const after = JSON.parse(readFileSync(userFile, "utf8")) as Record<string, unknown>;
  check("seed: merges into existing file", res === "seeded" && after["Qwen3.8-27B-GGUF"] !== undefined, res);
  check("seed: other entries untouched",
    JSON.stringify(after["My-Model-1B"]) === JSON.stringify(withMine["My-Model-1B"]));
  check("seed: pre-existing model entry untouched",
    JSON.stringify(after["Qwen3.6-35B-A3B-MTP-GGUF"]) === JSON.stringify(withMine["Qwen3.6-35B-A3B-MTP-GGUF"]));

  // 3. Unknown model → nothing written, no file created (sane pass-through)
  rmSync(userFile);
  check("seed: unknown model → unknown", seedModelEntry("Totally-Unknown-9B") === "unknown");
  check("seed: unknown model does NOT create the file", !existsSync(userFile));

  // 4. Corrupt file → never clobbered
  writeUserFile("garbage-not-json");
  check("seed: corrupt file → skipped", seedModelEntry("Qwen3.8-27B-GGUF") === "unknown");
  check("seed: corrupt file content preserved", readFileSync(userFile, "utf8") === "garbage-not-json");
  rmSync(userFile);

  // 5. Tuning disabled → no config writes either
  process.env.LEMONADE_PAYLOAD_TUNING = "off";
  check("seed: tuning off → no write",
    seedModelEntry("Qwen3.8-27B-GGUF") === "unknown" && !existsSync(userFile));
  delete process.env.LEMONADE_PAYLOAD_TUNING;
}

// ── generic debug log ───────────────────────────────────────────────────────
{
  writeUserFile({
    "Qwen3.8-27B-GGUF": {
      budgets: { minimal: 2048, low: 3072, medium: 8192, high: 16384 },
      thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
      offParams: { enable_thinking: false },
    },
  });
  const beforeLines = existsSync(PAYLOAD_DEBUG_PATH) ? readFileSync(PAYLOAD_DEBUG_PATH, "utf8").trimEnd().split("\n").length : 0;
  // Generic: a NON-catalogued model is logged as-is (raw view)
  writePayloadDebugLog(
    {
      model: "Gemma-4-26B-A4B-it-GGUF",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    },
    { model: "Gemma-4-26B-A4B-it-GGUF", thinkingLevel: "off" },
  );
  // And a catalogued, tuned view
  writePayloadDebugLog(
    {
      model: "Qwen3.8-27B-GGUF",
      messages: [{ role: "user", content: "hi" }],
      thinking_budget_tokens: 2048,
      reasoning_effort: "minimal",
      temperature: 1.0,
    },
    { model: "Qwen3.8-27B-GGUF", thinkingLevel: "minimal" },
  );
  const lines = readFileSync(PAYLOAD_DEBUG_PATH, "utf8").trimEnd().split("\n");
  const raw = JSON.parse(lines[beforeLines]);
  const tuned = JSON.parse(lines[beforeLines + 1]);
  check("debug log: generic — non-catalogued model captured", raw.model === "Gemma-4-26B-A4B-it-GGUF");
  check("debug log: raw view — no sampling fields", raw.temperature === null && raw.top_p === null);
  check("debug log: raw view — max_tokens captured", raw.max_tokens === 4096);
  check("debug log: source tag", tuned.source === "lemonade-pi-plugin");
  check("debug log: budget field", tuned.thinking_budget_tokens === 2048);
  check("debug log: effort field", tuned.reasoning_effort === "minimal");
  check("debug log: sampling field", tuned.temperature === 1.0);
  check("debug log: enable_thinking null when absent", tuned.enable_thinking === null);
  check("debug log: thinkingLevel from ctx", tuned.thinkingLevel === "minimal");
  check("debug log: topKeys present", Array.isArray(tuned.topKeys) && tuned.topKeys.includes("thinking_budget_tokens"));
  rmSync(userFile);
}

// ── cold-start capability fallback (examples tier, read-only) ────────────
{
  // No user/plugin entry → the bundled example entry resolves so a
  // post-registration re-register sees correct capabilities (reasoning flag)
  // without any config write. This is what fixes "thinking clamped to off"
  // when pi registered the provider before the model was seeded.
  rmSync(userFile, { force: true });
  const ex = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("cold-start: uncatalogued recognized model resolves from examples",
    ex !== undefined);
  check("cold-start: reasoning=true from examples (not recipe keywords)",
    ex?.reasoning === true, ex);
  check("cold-start: vision=true from examples", ex?.vision === true);
  check("cold-start: budgets present (P2 tuning works immediately)",
    typeof ex?.budgets?.medium === "number");
  check("cold-start: offParams present (P5 wire off-switch)",
    ex?.offParams?.enable_thinking === false);
  check("cold-start: isCatalogued=false (examples tier is NOT live)",
    isCatalogued("Qwen3.8-27B-GGUF") === false);
  // No file was written by the resolve — read-only fallback
  check("cold-start: resolve does not write the user file", !existsSync(userFile));

  // Uncatalogued AND unrecognized → still undefined (default pi behavior)
  check("cold-start: unknown model stays uncatalogued",
    resolveModelEntry("Totally-Unknown-9B") === undefined);
  check("cold-start: unknown model isCatalogued=false", isCatalogued("Totally-Unknown-9B") === false);

  // Live catalog entry wins over the examples fallback
  writeUserFile({ "Qwen3.8-27B-GGUF": { reasoning: true, maxTokens: 8192 } });
  const live = resolveModelEntry("Qwen3.8-27B-GGUF");
  check("cold-start: user tier wins over examples (maxTokens=8192)",
    live?.maxTokens === 8192, live);
  check("cold-start: user-tier entry isCatalogued=true", isCatalogued("Qwen3.8-27B-GGUF") === true);
  rmSync(userFile);
}

rmSync(tmpDir, { recursive: true, force: true });
delete process.env.LEMONADE_PARAMS_FILE;

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

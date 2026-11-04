// Vultr Serverless Inference client (OpenAI-compatible). The API key lives ONLY here, on the host —
// it is never passed into a sandbox.
const BASE = process.env.VULTR_INFERENCE_URL || "https://api.vultrinference.com/v1";
const KEY = process.env.VULTR_INFERENCE_KEY || "";
let MODEL = process.env.VULTR_MODEL || "";

export const llmEnabled = () => Boolean(KEY);
export const modelName = () => MODEL || "(auto)";

// Every text model on Vultr Serverless Inference is a reasoning model. Prefer fast "flash" ones and keep
// reasoning effort low, otherwise the model can spend the whole token budget thinking and return no answer.
const PREF = [/qwen.*flash/i, /deepseek.*flash/i, /glm.*flash/i, /kimi-k2/i, /qwen/i, /deepseek/i, /glm/i];
let CANDIDATES = null;
export const status = { lastOk: null, lastError: null, model: null };

async function candidates() {
  if (CANDIDATES) return CANDIDATES;
  if (MODEL) return (CANDIDATES = [MODEL]);
  const j = await (await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const text = (j.data || []).filter((m) => (m.output_modalities || [{ type: "text" }]).some((o) => o.type === "text"))
    .map((m) => m.id).filter((id) => !/safety|guard|embed|rerank|whisper|tts/i.test(id));
  const ranked = [...new Set([...PREF.flatMap((re) => text.filter((id) => re.test(id))), ...text])];
  CANDIDATES = ranked.slice(0, 3);
  MODEL = CANDIDATES[0] || "";
  return CANDIDATES;
}

export async function chat(messages, { maxTokens = 6000, temperature = 0.2, json = false } = {}) {
  let lastErr;
  for (const model of await candidates()) {
    try {
      const body = { model, messages, max_tokens: maxTokens, temperature, reasoning_effort: "low" };
      if (json) body.response_format = { type: "json_object" };
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error(`Vultr Inference ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const msg = (await r.json()).choices?.[0]?.message || {};
      const out = (msg.content || "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
      if (!out) throw new Error(`${model} returned no answer`);
      if (json) parseJson(out); // a broken answer counts as a failure, try the next model
      MODEL = model; Object.assign(status, { lastOk: new Date().toISOString(), lastError: null, model });
      return out;
    } catch (e) {
      lastErr = e; Object.assign(status, { lastError: `${model}: ${e.message}`.slice(0, 300) });
      if (/ 40[13]:/.test(e.message)) break; // bad key: no point trying other models
    }
  }
  throw lastErr || new Error("No model available");
}

export function parseJson(text) {
  const t = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  return JSON.parse(m[1]);
}

// Vultr Serverless Inference client (OpenAI-compatible). The API key lives ONLY here, on the host —
// it is never passed into a sandbox.
const BASE = process.env.VULTR_INFERENCE_URL || "https://api.vultrinference.com/v1";
const KEY = process.env.VULTR_INFERENCE_KEY || "";
let MODEL = process.env.VULTR_MODEL || "";

export const llmEnabled = () => Boolean(KEY);
export const modelName = () => MODEL || "(auto)";

async function pickModel() {
  if (MODEL) return MODEL;
  const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  const ids = (j.data || []).map((m) => m.id);
  const pref = [/kimi-k2/i, /qwen.*(instruct|next|27b)/i, /deepseek/i, /glm/i, /llama.*instruct/i];
  MODEL = pref.map((re) => ids.find((id) => re.test(id))).find(Boolean) || ids[0];
  return MODEL;
}

export async function chat(messages, { maxTokens = 1800, temperature = 0.2 } = {}) {
  const model = await pickModel();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });
  if (!r.ok) throw new Error(`Vultr Inference ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

export function parseJson(text) {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  return JSON.parse(m[1]);
}

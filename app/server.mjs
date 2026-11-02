// SiteDoctor control layer: plans the job, dispatches work into sandboxes, verifies the result.
// Runs on a Vultr VM. Holds the inference key; sandboxes never see it.
import express from "express";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runSandbox, CONTAINMENT_POLICY } from "./sandbox.mjs";
import { diagnose, forModel } from "./score.mjs";
import { plan, prescribe, summarise } from "./doctor.mjs";
import { llmEnabled, modelName } from "./llm.mjs";

const PORT = +process.env.PORT || 8080;
const DATA = process.env.SD_DATA || new URL("../data", import.meta.url).pathname;
const ALLOW = (process.env.SD_ALLOW_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PUBLIC_URL = (process.env.SD_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const MAX_PARALLEL = +process.env.SD_MAX_PARALLEL || 2;
const TOOLBOX = readFileSync(new URL("../sandbox/toolbox.js", import.meta.url), "utf8");
mkdirSync(DATA, { recursive: true });

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(new URL("../web", import.meta.url).pathname));
app.use("/demo", express.static(new URL("../demo", import.meta.url).pathname));
app.use("/artifacts", express.static(DATA, { maxAge: "1h" }));

const jobs = new Map();
let running = 0;
const queue = [];

function emit(job, type, data) {
  const ev = { type, t: Date.now() - job.created, ...data };
  job.events.push(ev);
  job.bus.emit("ev", ev);
}

app.get("/api/info", (req, res) => res.json({ llm: llmEnabled(), model: modelName(), policy: CONTAINMENT_POLICY, demoUrl: `${PUBLIC_URL}/demo/patient.html` }));

app.post("/api/scan", (req, res) => {
  let url;
  try { url = new URL(String(req.body?.url || "").trim()); } catch { return res.status(400).json({ error: "Enter a full URL, e.g. https://example.com" }); }
  if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: "Only http(s) URLs" });
  const id = randomBytes(5).toString("hex");
  const job = { id, url: url.href, created: Date.now(), events: [], bus: new EventEmitter(), status: "queued" };
  job.bus.setMaxListeners(50);
  jobs.set(id, job);
  queue.push(job); pump();
  res.json({ id });
});

app.get("/api/scan/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  job.events.forEach(send);
  job.bus.on("ev", send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(ping); job.bus.off("ev", send); });
});

app.get("/api/scan/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({ id: job.id, url: job.url, status: job.status, result: job.result || null });
});

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift(); running++;
    work(job).catch((e) => emit(job, "error", { message: e.message })).finally(() => { running--; job.status = job.status === "running" ? "failed" : job.status; pump(); });
  }
}

async function work(job) {
  job.status = "running";
  const dir = join(DATA, job.id); mkdirSync(dir, { recursive: true });
  const art = (sb, f) => `/artifacts/${job.id}/${sb.dir.split("/").pop()}/out/${f}`;
  const host = new URL(job.url).hostname;
  const allowHosts = ALLOW.includes(host) ? [host] : [];
  const log = (step) => (line) => emit(job, "log", { step, line });

  emit(job, "step", { step: "plan", state: "active", title: "Planning the repair" });
  const p = await plan(job.url);
  emit(job, "step", { step: "plan", state: "done", title: "Plan ready", detail: p.steps, by: p.by });

  // 1) audit in a fresh sandbox
  emit(job, "step", { step: "audit", state: "active", title: "Examining the site in an isolated sandbox" });
  const a = await runSandbox({ url: job.url, mode: "audit", workDir: dir, allowHosts, onLog: log("audit") });
  if (!a.report.ok) throw new Error(a.report.error || "Audit failed");
  const before = diagnose(a.report);
  emit(job, "containment", { step: "audit", events: a.report.containment });
  emit(job, "step", { step: "audit", state: "done", title: `Diagnosis: ${before.findings.length} problems found`, scores: before.scores, overall: before.overall,
    shots: { desktop: art(a, "desktop.png"), mobile: art(a, "mobile.png") }, findings: before.findings, seconds: a.seconds });

  // 2) prescription + 3) verification, with one self-healing retry
  const auditForModel = forModel(a.report, before);
  let rx, v, after, feedback = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    emit(job, "step", { step: "rx", state: "active", title: attempt === 1 ? "Writing a prescription" : "Self-healing: rewriting the prescription" });
    rx = await prescribe(auditForModel, feedback);
    emit(job, "step", { step: "rx", state: "done", title: `Prescription: ${rx.actions.length} fixes`, rx, by: rx.by, attempt });

    emit(job, "step", { step: "verify", state: "active", title: "Applying fixes in a fresh sandbox and re-examining" });
    v = await runSandbox({ url: job.url, mode: "verify", patch: { actions: rx.actions, css: rx.css }, workDir: dir, allowHosts, onLog: log("verify") });
    const patchErr = v.report.desktop?.error || v.report.mobile?.error || (!v.report.ok && v.report.error);
    after = v.report.ok && !patchErr ? diagnose(v.report) : null;
    if (after && after.overall >= before.overall) break;
    feedback = patchErr ? `error: ${patchErr}` : `score dropped from ${before.overall} to ${after?.overall}`;
    emit(job, "step", { step: "verify", state: "retry", title: "Verification failed, feeding the result back", detail: feedback });
    if (attempt === 2) throw new Error("Could not produce a verified fix: " + feedback);
  }
  emit(job, "containment", { step: "verify", events: v.report.containment });
  emit(job, "step", { step: "verify", state: "done", title: `Verified: score ${before.overall} → ${after.overall}`, scores: after.scores, overall: after.overall,
    shots: { desktop: art(v, "desktop.png"), mobile: art(v, "mobile.png") }, findings: after.findings, applied: v.report.mobile.applied, seconds: v.seconds });

  // 4) deliverable: a drop-in script that applies exactly what was verified
  const fix = `/* SiteDoctor verified fix for ${job.url} — ${new Date().toISOString()}\n   Add before </body>: <script src="sitedoctor-fix.js" defer></script>\n   Better long-term: copy these changes into your HTML/CSS. */\n${TOOLBOX}\n(function(){\n${rx.css ? `var s=document.createElement("style");s.textContent=${JSON.stringify(rx.css)};document.head.appendChild(s);\n` : ""}${rx.actions.map((x) => `window.__sd.${x.tool}(${x.args.map((y) => JSON.stringify(y)).join(", ")}); // ${x.why.replace(/\n/g, " ")}`).join("\n")}\n})();\n`;
  writeFileSync(join(dir, "sitedoctor-fix.js"), fix);
  const summary = await summarise(before, after, rx);
  job.result = { before, after, rx, summary, fixUrl: `/artifacts/${job.id}/sitedoctor-fix.js` };
  job.status = "done";
  emit(job, "done", { summary, before: before.overall, after: after.overall, fixUrl: job.result.fixUrl, needsHuman: rx.needsHuman });
}

app.listen(PORT, () => console.log(`SiteDoctor on ${PUBLIC_URL} · LLM: ${llmEnabled() ? modelName() : "off (rules mode)"} · driver: ${process.env.SD_DRIVER || "docker"}`));

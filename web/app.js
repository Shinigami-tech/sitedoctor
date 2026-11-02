// SiteDoctor UI: streams the agent's work over Server-Sent Events.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CATS = ["Accessibility", "Mobile", "Performance", "SEO", "Reliability", "Security"];
const RULE_TITLE = { metadata: "Credential theft attempt blocked", "private-network": "Private network probe blocked", exfiltration: "Data exfiltration blocked", scheme: "Local file access blocked" };
let info = null, es = null, state = {};

fetch("/api/info").then((r) => r.json()).then((j) => {
  info = j;
  $("#engine").textContent = j.llm ? `Vultr Inference · ${j.model}` : "Rules mode (no inference key)";
  $("#policy").innerHTML = j.policy.map((p) => `<li>${esc(p.label)}<code>${esc(p.flag)}</code></li>`).join("");
});

$("#demo").addEventListener("click", () => { $("#url").value = info?.demoUrl || location.origin + "/demo/patient.html"; $("#form").requestSubmit(); });
$("#again").addEventListener("click", () => { es?.close(); $("#run").hidden = true; $("#hero").hidden = false; $("#url").focus(); });

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#go").disabled = true;
  try {
    const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: $("#url").value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    start(j.id, $("#url").value);
  } catch (err) { alertLine(err.message); } finally { $("#go").disabled = false; }
});

function reset(url) {
  state = { before: null, after: null, blocked: 0, seen: new Set(), shots: {}, dev: "mobile" };
  $("#patient").textContent = url;
  document.querySelectorAll("#steps li").forEach((li) => { li.className = ""; li.querySelector("span").textContent = "Waiting"; });
  $("#console").innerHTML = "";
  $("#blocked").innerHTML = '<li class="empty">Nothing blocked yet.</li>';
  $("#blockedPill").textContent = "0 actions blocked"; $("#blockedPill").className = "pill";
  ["#compare", "#rxCard", "#findCard", "#result"].forEach((s) => ($(s).hidden = true));
  setGauge(null); renderBars();
}

function start(id, url) {
  reset(url);
  $("#hero").hidden = true; $("#run").hidden = false; scrollTo({ top: 0, behavior: "smooth" });
  es = new EventSource(`/api/scan/${id}/events`);
  es.onmessage = (m) => handle(JSON.parse(m.data));
}

function line(text, cls = "") {
  const c = $("#console"), d = document.createElement("div");
  d.className = cls; d.textContent = text; c.appendChild(d); c.scrollTop = c.scrollHeight;
}
function alertLine(msg) { line("✖ " + msg, "blk"); }

function handle(ev) {
  if (ev.type === "log") {
    const blocked = /^BLOCKED/.test(ev.line);
    line(`${String((ev.t / 1000).toFixed(1)).padStart(5)}s  ${ev.line}`, blocked ? "blk" : /Sandbox .* (started|destroyed)/.test(ev.line) ? "sys" : "dim");
    return;
  }
  if (ev.type === "step") return step(ev);
  if (ev.type === "containment") return contain(ev.events || []);
  if (ev.type === "done") return done(ev);
  if (ev.type === "error") { alertLine(ev.message); es?.close(); }
}

function step(ev) {
  const li = document.querySelector(`#steps li[data-step="${ev.step}"]`);
  if (li) { li.className = ev.state; li.querySelector("span").textContent = ev.title + (ev.seconds ? ` · ${ev.seconds.toFixed(1)}s` : ""); }
  if (ev.step === "plan" && ev.state === "done") ev.detail.forEach((s, i) => line(`  ${i + 1}. ${s}`, "dim"));
  if (ev.state === "retry") line("↻ " + ev.detail, "blk");
  if (ev.step === "audit" && ev.state === "done") {
    state.before = ev; state.shots.before = ev.shots;
    setGauge(ev.overall); renderBars(); renderFindings(ev.findings);
  }
  if (ev.step === "rx" && ev.state === "done") renderRx(ev.rx);
  if (ev.step === "verify" && ev.state === "done") {
    state.after = ev; state.shots.after = ev.shots;
    setTimeout(() => { setGauge(ev.overall, state.before.overall); renderBars(); renderFindings(state.before.findings, ev.findings); markApplied(ev.applied); showCompare(); }, 300);
  }
}

function setGauge(score, from) {
  const arc = $("#gauge .arc"), b = $("#score");
  if (score == null) { arc.style.strokeDashoffset = 327; b.textContent = "–"; $("#scoreLabel").textContent = "health score"; return; }
  arc.style.strokeDashoffset = 327 - (327 * score) / 100;
  arc.style.stroke = score >= 85 ? "var(--ok)" : score >= 60 ? "var(--warn)" : "var(--bad)";
  arc.style.color = arc.style.stroke;
  const start = from ?? 0, t0 = performance.now();
  const tick = (t) => { const k = Math.min(1, (t - t0) / 1200); b.textContent = Math.round(start + (score - start) * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  $("#scoreLabel").textContent = from != null ? `was ${from}` : "health score";
  ecg(score);
}

function ecg(score) {
  const sick = score < 60, pts = [];
  for (let x = 0; x <= 300; x += 50) {
    pts.push(`L${x + 18} 20`, `L${x + 22} ${sick ? 14 : 6}`, `L${x + 26} ${sick ? 26 : 34}`, `L${x + 30} 20`, `L${x + 50} 20`);
  }
  $("#ecgPath").setAttribute("d", "M0 20 " + pts.join(" "));
  $("#ecgPath").style.stroke = sick ? "var(--bad)" : score < 85 ? "var(--warn)" : "var(--ok)";
}

function renderBars() {
  const b = state.before?.scores, a = state.after?.scores;
  $("#bars").innerHTML = CATS.map((c) => {
    const bv = b?.[c], av = a?.[c];
    return `<li><span>${c}</span><div class="track"><div class="b" style="width:${bv ?? 0}%"></div>${av != null ? `<div class="a" style="width:${av}%"></div>` : ""}</div>
      <em>${bv == null ? "–" : av != null ? `${bv} → <b>${av}</b>` : `<b>${bv}</b>`}</em></li>`;
  }).join("");
}

function contain(events) {
  const list = $("#blocked");
  for (const e of events) {
    const key = e.rule + e.url.split("?")[0] + e.viewport;
    if (state.seen.has(e.rule + e.url.split("?")[0])) { state.blocked++; continue; }
    state.seen.add(e.rule + e.url.split("?")[0]); state.blocked++;
    list.querySelector(".empty")?.remove();
    const li = document.createElement("li");
    li.innerHTML = `<b>⛔ ${esc(RULE_TITLE[e.rule] || e.why)}</b><span>${esc(e.method)} ${esc(e.url)}</span>`;
    list.appendChild(li);
  }
  if (state.blocked) {
    $("#blockedPill").textContent = `${state.blocked} actions blocked`; $("#blockedPill").className = "pill alert";
    const card = $("#containment"); card.classList.remove("hit"); void card.offsetWidth; card.classList.add("hit");
  }
}

function renderRx(rx) {
  $("#rxCard").hidden = false;
  $("#rxBy").textContent = rx.by === "llm" ? "written by Vultr Inference" : "rules engine";
  $("#diag").textContent = rx.diagnosis;
  $("#rx").innerHTML = rx.actions.map((a, i) => `<li style="animation-delay:${i * 60}ms" data-tool="${esc(a.tool)}"><code>${esc(a.tool)}()</code><span>${esc(a.why)}</span><em>pending</em></li>`).join("");
}
function markApplied(applied = []) {
  for (const a of applied || []) {
    const em = document.querySelector(`#rx li[data-tool="${a.tool}"] em`);
    if (em) em.textContent = a.changed ? `✓ ${a.changed} fixed` : "✓ ok";
  }
}

function renderFindings(before, after) {
  $("#findCard").hidden = false;
  const left = new Set((after || before).map((f) => f.key));
  $("#findings").innerHTML = before.map((f) => `<li class="${f.sev}${after && !left.has(f.key) ? " fixed" : ""}"><div>${esc(f.cat)}: ${esc(f.title)}<small>${esc(f.detail)}</small></div></li>`).join("");
}

function showCompare() {
  $("#compare").hidden = false; setDev(state.dev);
}
function setDev(dev) {
  state.dev = dev;
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.dev === dev));
  $("#slider").className = "slider " + dev;
  $("#imgBefore").src = state.shots.before[dev]; $("#imgAfter").src = state.shots.after[dev];
  $("#imgAfter").onload = () => { $("#imgBefore").style.width = $("#slider").clientWidth + "px"; $("#imgBefore").style.height = "auto"; };
  moveHandle(50);
}
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setDev(b.dataset.dev)));
function moveHandle(pct) {
  pct = Math.max(0, Math.min(100, pct));
  $("#beforeWrap").style.width = pct + "%"; $("#handle").style.left = pct + "%"; $("#handle").setAttribute("aria-valuenow", Math.round(pct));
}
let dragging = false;
$("#slider").addEventListener("pointerdown", (e) => { dragging = true; $("#slider").setPointerCapture(e.pointerId); drag(e); });
$("#slider").addEventListener("pointermove", (e) => dragging && drag(e));
$("#slider").addEventListener("pointerup", () => (dragging = false));
function drag(e) { const r = $("#slider").getBoundingClientRect(); moveHandle(((e.clientX - r.left) / r.width) * 100); }
$("#handle").addEventListener("keydown", (e) => { const v = +$("#handle").getAttribute("aria-valuenow"); if (e.key === "ArrowLeft") moveHandle(v - 5); if (e.key === "ArrowRight") moveHandle(v + 5); });
addEventListener("resize", () => { if (!$("#compare").hidden) $("#imgBefore").style.width = $("#slider").clientWidth + "px"; });

function done(ev) {
  es?.close();
  $("#result").hidden = false;
  $("#summary").textContent = ev.summary;
  $("#human").innerHTML = (ev.needsHuman || []).map((h) => `<li>${esc(h)}</li>`).join("") || "<li style='color:var(--ok)'>Nothing left for a human. 🎉</li>";
  $("#dl").href = ev.fixUrl;
  line(`✔ Done: health score ${ev.before} → ${ev.after}. Verified fix ready.`, "sys");
}
$("#copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText('<script src="/sitedoctor-fix.js" defer></script>').catch(() => {});
  $("#copy").textContent = "Copied ✓"; setTimeout(() => ($("#copy").textContent = "Copy install line"), 1600);
});

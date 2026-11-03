// Real-world benchmark: runs the full SiteDoctor pipeline (sandboxed audit → prescription → sandboxed
// verification) on real Astana business websites and writes data/benchmark.json for the /api/benchmark page.
// Usage: start the server, then  node scripts/benchmark.mjs [http://localhost:8080]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:8080";
const SITES = JSON.parse(readFileSync(new URL("./astana-sites.json", import.meta.url), "utf8"));
const OUT = new URL("../bench/benchmark.json", import.meta.url).pathname; // committed, so the deployed VM shows it
const PARALLEL = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function one(site) {
  const r = await fetch(`${BASE}/api/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: site.url }) });
  const { id } = await r.json();
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const j = await (await fetch(`${BASE}/api/scan/${id}`)).json();
    if (j.status === "done") {
      const b = j.result.before, a = j.result.after;
      return { ...site, before: b.overall, after: a.overall, scoresBefore: b.scores, scoresAfter: a.scores, fixes: j.result.rx.actions.length,
        noViewport: b.findings.some((f) => f.key === "viewport"), trackers: b.trackers || 0, injection: (b.injection || []).length,
        attacks: b.findings.filter((f) => f.cat === "Security").length };
    }
    if (j.status === "failed") return { ...site, error: "could not load" };
  }
  return { ...site, error: "timeout" };
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (next < SITES.length) {
    const s = SITES[next++];
    const res = await one(s).catch((e) => ({ ...s, error: e.message }));
    results.push(res);
    console.log(`${results.length}/${SITES.length} ${s.name}: ${res.error || `${res.before} → ${res.after}`}`);
  }
}));

const ok = results.filter((r) => r.before != null);
const avg = (k) => Math.round(ok.reduce((s, r) => s + r[k], 0) / Math.max(1, ok.length));
const catAvg = (cat, when) => Math.round(ok.reduce((s, r) => s + r[when][cat], 0) / Math.max(1, ok.length));
const summary = {
  generatedAt: new Date().toISOString(), city: "Astana, Kazakhstan", count: ok.length, attempted: SITES.length,
  avgBefore: avg("before"), avgAfter: avg("after"),
  improved: ok.filter((r) => r.after > r.before).length,
  noViewport: ok.filter((r) => r.noViewport).length,
  trackers: ok.reduce((s, r) => s + r.trackers, 0),
  withSecurityFlags: ok.filter((r) => r.attacks).length,
  byCategory: Object.fromEntries(["Accessibility", "Mobile", "Performance", "SEO", "Reliability", "Security"].map((c) => [c, { before: catAvg(c, "scoresBefore"), after: catAvg(c, "scoresAfter") }])),
  sites: results.sort((x, y) => (y.after ?? -1) - (y.before ?? 0) - ((x.after ?? -1) - (x.before ?? 0))),
};
mkdirSync(new URL("../bench/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(`\nDone: ${summary.count}/${summary.attempted} sites · average ${summary.avgBefore} → ${summary.avgAfter} · improved ${summary.improved}`);

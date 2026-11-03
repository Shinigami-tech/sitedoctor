# SiteDoctor

**An AI agent that examines, repairs and proves a website healthy, without ever letting the website touch anything it shouldn't.**

Paste a URL. SiteDoctor opens it in a throwaway sandbox, runs six health checks on desktop and phone, asks Vultr Serverless Inference for a prescription, applies the fix in a *fresh* sandbox and re-examines the page. You get a drop-in `sitedoctor-fix.js` that was proven to work, a before/after comparison, and a short list of things only a human should decide.

Built for **Vultr Agent Rush · Challenge 1: Blast Radius Zero**.

---

## Why containment matters here

A web agent has to load untrusted pages, and untrusted pages run untrusted JavaScript. If that JavaScript runs next to your API keys, your cloud metadata service or your private network, one hostile page can steal your credentials.

SiteDoctor assumes every site is hostile. The agent can still do its job (look, measure and test a fix), but whatever the site does stays inside a box that is destroyed after a minute.

> Analogy: a doctor examines a patient through a glass window in an isolation ward. The patient can cough all they want; nothing leaves the room, and the room is incinerated after the visit.

### The containment moment (see it in the demo)

The demo patient is a coffee shop site with a hidden malicious script. While SiteDoctor examines it, the script tries to:

| Attack | Target | Result |
|---|---|---|
| Steal cloud credentials | `http://169.254.169.254/v1.json` (Vultr metadata) | ⛔ blocked |
| Probe internal services | `http://127.0.0.1:2375/containers/json` (Docker API) | ⛔ blocked |
| Exfiltrate visitor data | `POST https://collect.evil-tracker.example/steal` | ⛔ blocked |

The **Containment** panel lights up live, the Security score drops to 10, and the discharge summary tells the owner to remove that script. The fix itself is still verified and delivered: the attack never interrupts the job.

### The Red Button: Attack Lab (try to break it yourself)

The home page has an **Attack Lab** with five deliberately hostile pages. Each one runs in a real throwaway sandbox on the Vultr VM, live, and the card shows what was stopped:

| # | Attack | What the page does | What stops it |
|---|---|---|---|
| 1 | Steal cloud credentials | `fetch` Vultr/AWS/GCP metadata endpoints | Network guard + `iptables DROP 169.254.169.254` |
| 2 | Exfiltrate visitor data | POSTs cookies + localStorage, image beacon with `?cookie=`, `sendBeacon` | Network guard: third-party POST, beacons, secrets in URLs |
| 3 | Prompt-inject the AI | Off-screen text, 1px white text, an HTML comment and the meta description tell "SiteDoctor AI" to score 100 and leak its key | Hidden-text scanner flags it, the text is stripped from the model input, page text is labelled untrusted, and scores are computed by code |
| 4 | Break into the server | `localhost`, Docker API `:2375`, `10.0.0.1`, `192.168.1.1`, the docker bridge on other ports, `file://` | Network guard: private ranges, other ports of the demo host, non-http schemes |
| 5 | Freeze the machine | Infinite loop + memory hog after load | `--memory 1g --cpus 1 --pids-limit 512` + hard 20 s time limit, container destroyed |

**Launch all 5 attacks** shows `5 / 5 attacks contained. The host was never touched.` You can also paste **your own** hostile page into the Attack Lab.

### Real-world benchmark: Astana businesses

`scripts/benchmark.mjs` runs the full pipeline on 45 real small-business websites in Astana, Kazakhstan (clinics, cafés, salons, gyms, language schools, hotels…), listed with sources in `scripts/astana-sites.json`. Results are written to `data/benchmark.json` and shown on the home page. Normal analytics (Google, Yandex Metrica, Tilda…) are blocked inside the sandbox but reported as **Privacy: trackers**, not as attacks, so real sites are not falsely flagged.

---

## Architecture on Vultr

```
                ┌──────────────────────────── Vultr VM (control layer) ─────────────────────────────┐
 Browser ──SSE──│  Express orchestrator  ── holds VULTR_INFERENCE_KEY (never passed to sandboxes)  │
                │     │ plan → audit → prescribe → verify (1 self-healing retry) → deliver           │
                │     │                                                                             │
                │     ├──► Vultr Serverless Inference  (OpenAI-compatible /chat/completions)       │
                │     │       writes the prescription as JSON, chosen ONLY from a safe toolbox      │
                │     │                                                                             │
                │     └──► docker run --rm  sitedoctor-sandbox   (one per audit, one per verify)    │
                │             • non-root user, read-only FS, --cap-drop ALL, no-new-privileges      │
                │             • 1 GB RAM, 1 CPU, 512 pids, killed after 75 s                        │
                │             • clean env: no secrets inside                                        │
                │             • Playwright + axe-core, browser-level network guard                  │
                │  iptables DOCKER-USER: DROP 169.254.169.254 (second, kernel-level wall)            │
                └────────────────────────────────────────────────────────────────────────────────────┘
```

**Vultr components used**

- **Vultr Cloud Compute VM**: runs the control layer and the Docker sandboxes.
- **Vultr Serverless Inference**: plans the job, writes the prescription and the discharge summary. The model is auto-selected from `/v1/models` (prefers Kimi K2, then Qwen, DeepSeek, GLM, Llama) or set with `VULTR_MODEL`.

**Three walls of containment**

1. **Container**: a fresh, unprivileged, read-only, resource-capped container per task, removed afterwards. It holds no keys.
2. **Browser network guard**: every request the page makes is checked. Metadata IPs, private and loopback ranges, non-http schemes, and any non-GET request to a third party are aborted and logged as containment events.
3. **Kernel firewall**: an iptables rule on the VM drops all container traffic to `169.254.169.254`, even if the browser guard were bypassed.

**Safe actions only.** The model does not write arbitrary code. It picks from a fixed toolbox (`viewport`, `lang`, `description`, `altText`, `mainHeading`, `fitToViewport`, `minFontSize`, `tapTargets`, `contrast`) plus optional CSS, and the server discards anything else. Risky changes such as deleting scripts or links are returned as **needs a human** instead of being done automatically.

**Verified, not hoped.** A prescription only ships if a second, independent sandbox measures the patched page and the score does not go down. If it fails, the error is fed back to the model for one retry.

---

## Run it

### On a Vultr VM (production)

Easiest: paste `deploy/vultr-startup.sh` as a **Startup Script** when you create the VM (Ubuntu 24.04, 2 vCPU / 4 GB). It installs everything on first boot and opens a one-time page on port `8081` where you paste the Vultr Inference key; that page shuts itself down after saving. Or by hand:

```bash
git clone https://github.com/Shinigami-tech/sitedoctor && cd sitedoctor
sudo bash deploy/setup-vultr.sh        # Docker, Node 22, sandbox image, firewall rule, systemd
nano .env                              # paste VULTR_INFERENCE_KEY
sudo systemctl restart sitedoctor
```

Open `http://YOUR_VM_IP:8080`.

### Locally (Docker required)

```bash
npm install
npm run build:sandbox
cp .env.example .env                   # optional: add your inference key
node --env-file=.env app/server.mjs    # or: npm start
```

Without an inference key SiteDoctor runs in **rules mode**, using a deterministic prescription so the demo always works.

### Try this

1. Click **Try the demo patient**.
2. Watch **Containment**: three attacks are blocked within ~7 seconds.
3. Watch **Vitals**: the score goes from **49 → 80** (Accessibility 49 → 100, Mobile 6 → 100, SEO 60 → 100).
4. Drag the **Before / After** slider: the phone view goes from a zoomed-out desktop page to a readable mobile page.
5. Click **Download verified fix**.

---

## Project layout

```
app/server.mjs     control layer: API, SSE stream, job queue, plan → audit → rx → verify
app/sandbox.mjs    starts and destroys one hardened container per task
app/doctor.mjs     planning, prescription (LLM or rules), summary
app/llm.mjs        Vultr Serverless Inference client
app/score.mjs      turns raw measurements into six scores and findings
sandbox/           Dockerfile, Playwright runner with network guard, safe fix toolbox
demo/patient.html  deliberately broken site with a malicious script
web/               the UI
deploy/            one-shot Vultr VM setup
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VULTR_INFERENCE_KEY` | empty | Vultr Serverless Inference key; empty means rules mode |
| `VULTR_INFERENCE_URL` | `https://api.vultrinference.com/v1` | Inference base URL |
| `VULTR_MODEL` | auto | Force a model id |
| `PORT` | `8080` | HTTP port |
| `SD_PUBLIC_URL` | `http://localhost:PORT` | Public address (used for the demo link) |
| `SD_ALLOW_HOSTS` | empty | Private hosts the sandbox may load (e.g. `172.17.0.1` for the demo) |
| `SD_MAX_PARALLEL` | `2` | Concurrent jobs |
| `SD_DRIVER` | `docker` | `local` runs the browser without a container (development only) |

## Business value

Most small business sites fail basic accessibility and mobile checks, and their owners can't read a Lighthouse report. SiteDoctor gives them a working fix, not a list of problems, and the containment model makes it safe to offer as a hosted service that opens any URL from anyone.

## License

MIT

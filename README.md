# Ledger — Infra Agent Platform (prototype)

A working prototype of an AI agent that turns a plain-language project description
into a sized, priced infrastructure plan, then simulates a live monitoring console
with independent API-token and LLM-token budget tracking and data-driven optimization
recommendations.

This is a **simulation**: the "live" metrics are generated client-side (random walk +
compounding growth), not pulled from a real cloud account or LLM provider. It's meant
as a functional demo of the product flow, not a production monitoring tool.

## What it does

1. **Describe** — type a requirement in plain language (e.g. "RAG pipeline, 10,000
   daily users, sub-2s latency"). A lightweight parser extracts user count, latency
   target, and workload type.
2. **Plan** — generates two infrastructure options (cost-optimized vs.
   latency-optimized) with compute sizing, model choice, and a full monthly cost
   breakdown.
3. **Console** — after you "deploy," simulates live CPU/memory/GPU/latency/error
   metrics, and tracks API tokens and LLM tokens as separate budgets, each with a
   14-day usage history and a projected burn-rate chart (dashed line shows when
   you're on track to exceed budget).
4. **Optimize** — recommendations generated from the actual simulated numbers
   (prompt/completion token ratio, projected overrun dates, GPU idle time, error
   rate), not fixed copy.
5. **Export** — generates a parameterized Terraform snippet and Dockerfile from
   whichever plan you deployed.

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev
```

Then open the URL it prints (usually `http://localhost:5173`).

## Build for production

```bash
npm run build
npm run preview
```

## Project structure

```
├── index.html
├── src/
│   ├── main.jsx      # React entry point
│   └── App.jsx       # the whole app (parsing, simulation, UI)
├── package.json
└── vite.config.js
```

## Next steps if you want to make this real

- Swap the simulated live metrics for real data: cloud provider cost/usage APIs
  (AWS Cost Explorer, GCP Billing), your LLM provider's usage API, and an
  observability backend (Prometheus/Datadog) for CPU/memory/latency/errors.
- Replace the regex-based requirement parser with an actual LLM call for more
  robust intent extraction.
- Persist deployed plans and usage history somewhere durable instead of in-memory
  React state.
- Wire the "Export" tab to actually provision infrastructure (e.g. run the
  generated Terraform via an API/CI job) instead of just displaying it.

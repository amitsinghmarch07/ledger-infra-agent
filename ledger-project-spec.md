# Ledger — Infra Agent Platform
### Project Spec (for collaborators)

## 1. What this is
An AI-agent SaaS concept: a user describes their project in plain language
("RAG pipeline, 10k daily users, sub-2s latency") and the system:
- Recommends an infrastructure setup with cost estimates and trade-offs
- Monitors it in real time (compute, API tokens, LLM tokens, system health)
- Proactively surfaces cost/performance recommendations

## 2. Current status: frontend prototype only
- **What exists:** a React app (Vite) simulating the entire user flow end to end
- **What doesn't exist:** any backend, database, real LLM call, or real
  infrastructure/monitoring integration
- Everything currently runs and resets **in the browser only** — refresh the
  page and all state is gone

## 3. What's simulated (and needs to become real)
| Feature | Currently | Needs to be |
|---|---|---|
| Requirement parsing | Regex keyword matching | Real LLM call (e.g. Claude API) |
| Cost estimates | Hardcoded formulas | Real cloud pricing APIs |
| Live CPU/mem/GPU/latency/errors | `Math.random()` walk | Real observability data (Prometheus/Datadog/CloudWatch) |
| API & LLM token budgets | Synthetic generated history | Real usage from cloud/LLM provider billing APIs |
| Recommendations | Rule-based JS on fake data | Same logic, but fed real data |
| Data persistence | React state (in-memory) | Real database |

## 4. Current tech stack
- React 18 + Vite (build tool)
- `recharts` — charts
- `lucide-react` — icons
- No backend, no database, no auth

## 5. What needs to be built (to make it real)
- [ ] **Backend server** (Node/Express or Python/FastAPI) — browser can't safely
  hold API keys or call billing APIs directly
- [ ] **LLM integration** — replace the regex parser with a real Claude API call
  that turns plain language into structured infra requirements
- [ ] **Database** (e.g. Postgres) — store generated plans, deployed
  infrastructure, and historical usage instead of losing it on refresh
- [ ] **Real monitoring integrations:**
  - Cloud cost/usage APIs (AWS Cost Explorer, GCP Billing, Azure Cost Mgmt)
  - LLM provider usage APIs (token counts, cost per model)
  - Observability backend (Prometheus, Datadog, or CloudWatch) for CPU/mem/latency/errors
- [ ] **Auth** — needed once this supports more than one user/company
- [ ] **(Optional) Actual provisioning** — wire the Terraform/Docker export tab
  to really run against a cloud account, instead of just displaying config

## 6. Suggested build order
1. Backend + real LLM parsing (biggest jump from "fake" to "real")
2. Database for persistence
3. One real monitoring integration end-to-end (pick one cloud + one LLM provider)
4. Recommendation engine running on real data
5. Auth / multi-tenant support
6. Optional: real provisioning from the Export tab

## 7. Run the current prototype
```bash
npm install
npm run dev
```
Requires Node.js 18+. Opens at `http://localhost:5173`.

## 8. Repo
`ledger-infra-agent` — React/Vite project, MIT-style prototype, ready to extend.

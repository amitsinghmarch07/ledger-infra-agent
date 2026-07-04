import { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Terminal, Layers, Activity, Sparkles, Download, Cpu, Zap, ShieldAlert,
  ArrowRight, Copy, Check, Rocket, RefreshCw, Lock, ChevronRight, Server,
} from "lucide-react";

/* ============================================================
   MOCK AGENT LOGIC — pure functions, no UI concerns
   ============================================================ */

function parseRequirements(raw) {
  const text = raw.toLowerCase();

  let users = 1000;
  const userMatch = text.match(/([\d]{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*(k)?\s*(?:daily|monthly)?\s*(?:active\s*)?users?/);
  if (userMatch) {
    let n = parseFloat(userMatch[1].replace(/,/g, ""));
    if (userMatch[2]) n *= 1000;
    if (!isNaN(n) && n > 0) users = n;
  }

  let latencyMs = 2000;
  const subMatch = text.match(/sub[- ]?(\d+(?:\.\d+)?)\s*s\b/);
  const msMatch = text.match(/(\d+)\s*ms\b/);
  const sMatch = text.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/);
  if (subMatch) latencyMs = parseFloat(subMatch[1]) * 1000;
  else if (msMatch) latencyMs = parseFloat(msMatch[1]);
  else if (sMatch) latencyMs = parseFloat(sMatch[1]) * 1000;

  const flags = {
    rag: /\brag\b|retrieval/.test(text),
    chat: /\bchat\b|conversation|support bot|assistant/.test(text),
    classification: /classif/.test(text),
    image: /\bimage\b|vision/.test(text),
    video: /\bvideo\b/.test(text),
    voice: /\bvoice\b|speech|audio/.test(text),
  };
  if (!Object.values(flags).some(Boolean)) flags.chat = true;

  return { raw, users, latencyMs, flags };
}

function buildReasoningTrace(req) {
  const lines = [];
  const secs = req.latencyMs % 1000 === 0 ? (req.latencyMs / 1000).toFixed(0) : (req.latencyMs / 1000).toFixed(1);
  lines.push(`Reading requirement: ${fmtNum(req.users)} users, ${secs}s latency target`);
  const flagList = Object.entries(req.flags).filter(([, v]) => v).map(([k]) => k);
  lines.push(`Classifying workload: ${flagList.join(", ")}`);
  lines.push(`Sizing concurrency at roughly ${Math.max(5, Math.round(req.users * 0.045))} simultaneous sessions`);
  if (req.flags.rag) lines.push("Comparing managed vector index options for this scale");
  if (req.flags.image || req.flags.video || req.flags.voice) lines.push("Checking whether GPU inference is required");
  lines.push("Modeling monthly token burn — prompt, completion, and third-party API calls");
  lines.push("Drafting two infrastructure options and comparing trade-offs");
  return lines;
}

function estimateStack(req) {
  const concurrency = Math.max(5, Math.round(req.users * 0.045));
  const needsGpu = req.flags.image || req.flags.video || req.flags.voice;
  const needsVectorDb = req.flags.rag;
  const callsPerUserPerDay = req.flags.classification ? 9 : req.flags.rag ? 4 : req.flags.chat ? 6 : 3;
  const dailyLlmCalls = Math.max(50, Math.round(req.users * callsPerUserPerDay * 0.35));
  const dailyApiCalls = Math.max(80, Math.round(req.users * 1.8));

  function tierPlan(tier) {
    const isPerf = tier === "perf";
    const computeUnitCost = isPerf ? 64 : 36;
    const computeCost = Math.round((concurrency * computeUnitCost) / 10) * 10;
    const vectorDbCost = needsVectorDb ? Math.round((isPerf ? 150 : 65) + concurrency * (isPerf ? 0.55 : 0.3)) : 0;
    const avgPromptTokens = isPerf ? 1500 : 1000;
    const avgCompletionTokens = isPerf ? 320 : 230;
    const promptPrice = isPerf ? 7.5 : 2.0;
    const completionPrice = isPerf ? 22 : 7.5;
    const llmCost = Math.round(dailyLlmCalls * 30 * ((avgPromptTokens / 1e6) * promptPrice + (avgCompletionTokens / 1e6) * completionPrice));
    const apiCost = Math.round(dailyApiCalls * 30 * (isPerf ? 0.0009 : 0.0006));
    const total = computeCost + vectorDbCost + llmCost + apiCost;
    const estimatedLatencyMs = Math.round(req.latencyMs * (isPerf ? 0.72 : 1.28) * (needsGpu && !isPerf ? 1.15 : 1));
    return {
      key: tier,
      name: isPerf ? "Latency-optimized" : "Cost-optimized",
      needsGpu, needsVectorDb,
      flagsClassification: req.flags.classification,
      concurrency,
      estimatedLatencyMs,
      meetsTarget: estimatedLatencyMs <= req.latencyMs,
      computeDesc: needsGpu
        ? `${isPerf ? "Dedicated" : "Shared"} GPU inference pool · ${Math.max(2, Math.round(concurrency / 40))}–${Math.max(4, Math.round(concurrency / 22))} nodes`
        : `Autoscaling CPU pool · ${Math.max(2, Math.round(concurrency / 60))}–${Math.max(4, Math.round(concurrency / 28))} nodes`,
      modelDesc: isPerf ? "Frontier-tier reasoning model" : "Efficient-tier instruction model",
      smallModelDesc: req.flags.classification ? "Compact classifier model for routing/labeling calls" : null,
      vectorDbDesc: needsVectorDb ? (isPerf ? "Managed vector index · multi-zone" : "Managed vector index · single-zone") : null,
      costs: { compute: computeCost, vectorDb: vectorDbCost, llm: llmCost, api: apiCost, total },
      dailyLlmCalls, avgPromptTokens, avgCompletionTokens, dailyApiCalls,
      tradeoff: isPerf
        ? "Meets the latency target with margin. The added cost is mostly the model choice, not the infrastructure."
        : "Runs lean and costs less. Latency can drift above target under peak load — worth watching if p95 matters.",
    };
  }

  const cost = tierPlan("cost");
  const perf = tierPlan("perf");
  cost.recommended = cost.meetsTarget;
  perf.recommended = !cost.meetsTarget;
  return [cost, perf];
}

function buildHistory(avgDaily, weeklyGrowth, days) {
  const dailyGrowth = Math.pow(1 + weeklyGrowth, 1 / 7) - 1;
  let val = avgDaily / Math.pow(1 + dailyGrowth, days - 1);
  const arr = [];
  for (let i = 0; i < days; i++) {
    const noise = 1 + (Math.random() * 0.16 - 0.08);
    arr.push(Math.max(1, Math.round(val * noise)));
    val = val * (1 + dailyGrowth);
  }
  return arr;
}

function weeklyGrowthFromHistory(arr) {
  const n = arr.length;
  if (n < 14) return 0;
  const lastWeek = arr.slice(n - 7).reduce((a, b) => a + b, 0);
  const prevWeek = arr.slice(n - 14, n - 7).reduce((a, b) => a + b, 0);
  if (prevWeek <= 0) return 0;
  return (lastWeek - prevWeek) / prevWeek;
}

function buildBurnChartData(history, budget, cycleLengthDays = 30) {
  const n = history.length;
  const cum = [];
  let running = 0;
  for (let i = 0; i < n; i++) { running += history[i]; cum.push(running); }
  const weekly = weeklyGrowthFromHistory(history);
  const dailyGrowth = Math.pow(1 + Math.max(weekly, -0.5), 1 / 7) - 1;
  const points = cum.map((c, i) => ({ day: i + 1, actual: c, projected: null }));
  points[n - 1].projected = points[n - 1].actual;
  let val = history[n - 1];
  let runningProj = cum[n - 1];
  let overrunDay = null;
  const maxExtra = cycleLengthDays - n + 12;
  for (let i = 1; i <= maxExtra; i++) {
    val = val * (1 + dailyGrowth);
    runningProj += val;
    points.push({ day: n + i, actual: null, projected: Math.round(runningProj) });
    if (overrunDay === null && runningProj >= budget) overrunDay = n + i;
  }
  const daysUntilOverrun = overrunDay !== null ? overrunDay - n : null;
  const overrunWithinCycle = overrunDay !== null && overrunDay <= cycleLengthDays;
  return {
    points, daysUntilOverrun, overrunWithinCycle, dailyGrowth, weeklyGrowth: weekly,
    usedSoFar: cum[n - 1], currentDaily: history[n - 1],
  };
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function walk(arr, opts = {}) {
  const { min = 0, max = 100, step = 4, spikeChance = 0 } = opts;
  const last = arr[arr.length - 1].v;
  let delta = (Math.random() * 2 - 1) * step;
  if (spikeChance && Math.random() < spikeChance) delta += step * 4 * (Math.random() > 0.5 ? 1 : -1);
  const next = clamp(last + delta, min, max);
  const t = arr[arr.length - 1].t + 1;
  return [...arr.slice(1), { t, v: Math.round(next * 10) / 10 }];
}

function seedSeries(base, opts) {
  let arr = [{ t: 0, v: base }];
  for (let i = 1; i < 20; i++) arr = walk(arr, opts);
  return arr;
}

function avgSeries(arr) { return arr.reduce((a, b) => a + b.v, 0) / arr.length; }

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n).toString();
}
function fmtMoney(n) { return "$" + Math.round(n).toLocaleString("en-US"); }

function buildRecommendations({ plan, llm, api, liveAvg, promptShare }) {
  const recs = [];
  const ratio = promptShare / (1 - promptShare);
  if (ratio >= 2.2) {
    const pct = Math.min(35, Math.round((ratio - 1) * 8));
    recs.push({
      id: "prompt-compress", category: "llm", title: "Compress your system prompt",
      detail: `Prompt tokens are running ${ratio.toFixed(1)}x completion tokens. Trimming the system prompt and retrieval context typically recovers ${pct}% of LLM spend without changing output quality.`,
      impact: `~${fmtMoney((plan.costs.llm * pct) / 100)}/mo`,
    });
  }
  if (llm.overrunWithinCycle) {
    const weeklyPct = Math.round(llm.weeklyGrowth * 100);
    recs.push({
      id: "llm-budget", category: "llm", title: "LLM budget is on track to run out early",
      detail: `Usage has grown ${weeklyPct}% week-over-week. At this pace the monthly LLM token budget runs out in about ${llm.daysUntilOverrun} day${llm.daysUntilOverrun === 1 ? "" : "s"} — before the cycle ends.`,
      impact: "Budget risk",
    });
  }
  if (api.overrunWithinCycle) {
    recs.push({
      id: "api-budget", category: "api", title: "API token budget is trending over",
      detail: `At the current burn rate, the API token budget is projected to run out in about ${api.daysUntilOverrun} day${api.daysUntilOverrun === 1 ? "" : "s"}. Caching repeat calls or raising the cap would both help.`,
      impact: "Budget risk",
    });
  }
  if (plan.needsGpu && liveAvg.gpu < 18) {
    const savings = Math.round(plan.costs.compute * 0.35);
    recs.push({
      id: "gpu-idle", category: "compute", title: "Your GPU pool is mostly idle",
      detail: `Average GPU utilization is ${liveAvg.gpu.toFixed(0)}% over the monitoring window. Downsizing to a smaller GPU tier would likely cut this line item by about ${fmtMoney(savings)}/mo.`,
      impact: `~${fmtMoney(savings)}/mo`,
    });
  }
  if (plan.flagsClassification) {
    const savings = Math.round(plan.costs.llm * 0.18);
    recs.push({
      id: "small-model", category: "llm", title: "Route classification calls to a smaller model",
      detail: "Classification-style calls don't need a frontier model. Routing them to a compact model is projected to save roughly 40% of that slice of LLM spend.",
      impact: `~${fmtMoney(savings)}/mo`,
    });
  }
  if (liveAvg.error > 2.2) {
    recs.push({
      id: "error-rate", category: "reliability", title: "Error rate is above a healthy baseline",
      detail: `Errors are averaging ${liveAvg.error.toFixed(1)}% over the last few minutes, above the 2% baseline. Check retry and backoff settings on the calls that spiked.`,
      impact: "Reliability risk",
    });
  }
  if (recs.length === 0) {
    recs.push({
      id: "all-good", category: "compute", title: "Everything is within healthy range",
      detail: "No budget, utilization, or reliability signal needs attention right now.",
      impact: "—",
    });
  }
  return recs;
}

const EXAMPLES = [
  "We're building a RAG pipeline for 10,000 daily users with sub-2s latency",
  "Customer support chatbot for 50,000 monthly users, sub-1.5s latency",
  "Batch image classification pipeline, 200,000 images/day",
];

const CATEGORY_META = {
  compute: { label: "Compute", cls: "pill-compute", Icon: Cpu },
  api: { label: "API tokens", cls: "pill-api", Icon: Zap },
  llm: { label: "LLM tokens", cls: "pill-llm", Icon: Sparkles },
  reliability: { label: "Reliability", cls: "pill-reliability", Icon: ShieldAlert },
};

/* ============================================================
   SMALL UI ATOMS
   ============================================================ */

function MiniTrend({ data, color }) {
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <Area type="monotone" dataKey="v" stroke={color} fill={color} fillOpacity={0.16} strokeWidth={1.5} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function Progress({ value, max, color }) {
  const pct = clamp((value / max) * 100, 0, 100);
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function StatTile({ label, value, unit, color, series }) {
  return (
    <div className="panel stat-tile">
      <div className="stat-tile-top">
        <span className="label-sm">{label}</span>
        <span className="mono stat-value" style={{ color }}>{value}{unit}</span>
      </div>
      <MiniTrend data={series} color={color} />
    </div>
  );
}

/* ============================================================
   MAIN COMPONENT
   ============================================================ */

export default function InfraAgentPlatform() {
  const [stage, setStage] = useState("intake");
  const [inputText, setInputText] = useState("");
  const [req, setReq] = useState(null);
  const [plans, setPlans] = useState(null);
  const [reasoningLines, setReasoningLines] = useState([]);
  const [revealCount, setRevealCount] = useState(0);
  const [activeView, setActiveView] = useState("describe");
  const [isDeployed, setIsDeployed] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [monitor, setMonitor] = useState(null);
  const [dismissed, setDismissed] = useState([]);
  const [exportTab, setExportTab] = useState("terraform");
  const [copied, setCopied] = useState(false);

  const handleAnalyze = useCallback(() => {
    const text = inputText.trim() || EXAMPLES[0];
    const parsed = parseRequirements(text);
    setReq(parsed);
    setReasoningLines(buildReasoningTrace(parsed));
    setRevealCount(0);
    setStage("analyzing");
  }, [inputText]);

  useEffect(() => {
    if (stage !== "analyzing") return;
    if (revealCount >= reasoningLines.length) {
      const t = setTimeout(() => {
        setPlans(estimateStack(req));
        setStage("plan");
        setActiveView("plan");
      }, 550);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setRevealCount((c) => c + 1), 460);
    return () => clearTimeout(t);
  }, [stage, revealCount, reasoningLines, req]);

  const handleDeploy = useCallback((plan) => {
    const llmHistory = buildHistory(plan.dailyLlmCalls * (plan.avgPromptTokens + plan.avgCompletionTokens), 0.20, 14);
    const apiHistory = buildHistory(plan.dailyApiCalls, 0.06, 14);
    const llmBudget = Math.round((plan.dailyLlmCalls * (plan.avgPromptTokens + plan.avgCompletionTokens) * 30 * 1.06) / 1000) * 1000;
    const apiBudget = Math.round(plan.dailyApiCalls * 30 * 1.10);
    const promptShare = clamp(plan.avgPromptTokens / (plan.avgPromptTokens + plan.avgCompletionTokens) + (Math.random() * 0.05 - 0.025), 0.5, 0.92);

    setSelectedPlan(plan);
    setMonitor({
      llmHistory, apiHistory, llmBudget, apiBudget, promptShare,
      liveTicks: {
        cpu: seedSeries(42, { min: 8, max: 92, step: 5 }),
        mem: seedSeries(51, { min: 10, max: 90, step: 4 }),
        gpu: plan.needsGpu ? seedSeries(11, { min: 0, max: 95, step: 3 }) : null,
        latency: seedSeries(plan.estimatedLatencyMs, { min: plan.estimatedLatencyMs * 0.55, max: plan.estimatedLatencyMs * 1.9, step: plan.estimatedLatencyMs * 0.05 }),
        error: seedSeries(0.8, { min: 0, max: 15, step: 0.5, spikeChance: 0.05 }),
      },
    });
    setDismissed([]);
    setIsDeployed(true);
    setActiveView("console");
  }, []);

  useEffect(() => {
    if (!isDeployed) return;
    const id = setInterval(() => {
      setMonitor((m) => {
        if (!m) return m;
        const t = m.liveTicks;
        return {
          ...m,
          liveTicks: {
            cpu: walk(t.cpu, { min: 8, max: 92, step: 5 }),
            mem: walk(t.mem, { min: 10, max: 90, step: 4 }),
            gpu: t.gpu ? walk(t.gpu, { min: 0, max: 95, step: 3 }) : null,
            latency: walk(t.latency, { min: selectedPlan.estimatedLatencyMs * 0.55, max: selectedPlan.estimatedLatencyMs * 1.9, step: selectedPlan.estimatedLatencyMs * 0.05 }),
            error: walk(t.error, { min: 0, max: 15, step: 0.5, spikeChance: 0.05 }),
          },
        };
      });
    }, 2000);
    return () => clearInterval(id);
  }, [isDeployed, selectedPlan]);

  const liveAvg = useMemo(() => {
    if (!monitor) return { cpu: 0, mem: 0, gpu: 0, error: 0, latency: 0 };
    const t = monitor.liveTicks;
    return {
      cpu: avgSeries(t.cpu), mem: avgSeries(t.mem),
      gpu: t.gpu ? avgSeries(t.gpu) : 0,
      error: avgSeries(t.error), latency: avgSeries(t.latency),
    };
  }, [monitor]);

  const llmBurn = useMemo(() => monitor ? buildBurnChartData(monitor.llmHistory, monitor.llmBudget) : null, [monitor]);
  const apiBurn = useMemo(() => monitor ? buildBurnChartData(monitor.apiHistory, monitor.apiBudget) : null, [monitor]);

  const recommendations = useMemo(() => {
    if (!monitor || !selectedPlan || !llmBurn || !apiBurn) return [];
    return buildRecommendations({ plan: selectedPlan, llm: llmBurn, api: apiBurn, liveAvg, promptShare: monitor.promptShare })
      .filter((r) => !dismissed.includes(r.id));
  }, [monitor, selectedPlan, llmBurn, apiBurn, liveAvg, dismissed]);

  const handleReset = useCallback(() => {
    setStage("intake"); setInputText(""); setReq(null); setPlans(null);
    setReasoningLines([]); setRevealCount(0); setActiveView("describe");
    setIsDeployed(false); setSelectedPlan(null); setMonitor(null); setDismissed([]);
  }, []);

  const handleCopy = useCallback((text) => {
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) { /* clipboard unavailable — ignore */ }
  }, []);

  const railItems = [
    { id: "describe", num: "01", label: "Describe", Icon: Terminal, locked: false },
    { id: "plan", num: "02", label: "Plan", Icon: Layers, locked: !plans },
    { id: "console", num: "03", label: "Console", Icon: Activity, locked: !isDeployed },
    { id: "optimize", num: "04", label: "Optimize", Icon: Sparkles, locked: !isDeployed },
    { id: "export", num: "05", label: "Export", Icon: Download, locked: !isDeployed },
  ];

  return (
    <div className="app-shell">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

        .app-shell {
          --bg: #14161A; --panel: #1C1F26; --panel-alt: #20242D; --border: #2A2E38;
          --text: #E7E9ED; --text-muted: #8B90A0; --text-dim: #5B6070;
          --accent-compute: #5B8DEF; --accent-api: #E8A33D; --accent-llm: #B583F0;
          --good: #4FBF83; --bad: #E8564F;
          background: var(--bg); color: var(--text);
          font-family: 'IBM Plex Sans', sans-serif;
          border-radius: 14px; overflow: hidden;
          display: flex; min-height: 640px; max-width: 100%;
          border: 1px solid var(--border);
        }
        .app-shell * { box-sizing: border-box; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .display { font-family: 'Space Grotesk', sans-serif; }
        .label-sm { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }

        .rail {
          width: 76px; flex-shrink: 0; background: var(--panel-alt);
          border-right: 1px solid var(--border); display: flex; flex-direction: column;
          align-items: center; padding: 16px 0; gap: 4px;
        }
        .rail-brand { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg, var(--accent-llm), var(--accent-compute)); margin-bottom: 18px; }
        .rail-item {
          width: 60px; padding: 8px 2px; border-radius: 10px; background: transparent; border: none;
          display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer;
          color: var(--text-dim); transition: background 0.15s, color 0.15s;
        }
        .rail-item:hover:not(:disabled) { background: rgba(255,255,255,0.04); color: var(--text-muted); }
        .rail-item.active { background: rgba(255,255,255,0.07); color: var(--text); }
        .rail-item:disabled { cursor: not-allowed; opacity: 0.35; }
        .rail-num { font-size: 9px; font-family: 'IBM Plex Mono', monospace; letter-spacing: 0.05em; }
        .rail-label { font-size: 10px; }

        .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 22px; border-bottom: 1px solid var(--border); }
        .content { flex: 1; overflow-y: auto; padding: 24px; }

        .status-pill { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
        .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); }
        .status-dot.live { background: var(--good); box-shadow: 0 0 0 0 rgba(79,191,131,0.5); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(79,191,131,0.45); } 70% { box-shadow: 0 0 0 6px rgba(79,191,131,0); } 100% { box-shadow: 0 0 0 0 rgba(79,191,131,0); } }

        .btn-primary { background: var(--text); color: var(--bg); border: none; border-radius: 9px; padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
        .btn-primary:hover { opacity: 0.9; }
        .btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 9px; padding: 9px 14px; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
        .btn-ghost:hover { color: var(--text); border-color: var(--text-dim); }

        .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
        .panel-title { font-size: 13px; font-weight: 600; margin: 0 0 2px; }

        .chip { background: var(--panel-alt); border: 1px solid var(--border); border-radius: 20px; padding: 7px 13px; font-size: 12.5px; color: var(--text-muted); cursor: pointer; text-align: left; }
        .chip:hover { color: var(--text); border-color: var(--text-dim); }

        textarea.terminal-input { width: 100%; min-height: 120px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; color: var(--text); font-family: 'IBM Plex Mono', monospace; font-size: 14px; padding: 16px; resize: vertical; }
        textarea.terminal-input:focus { outline: none; border-color: var(--accent-llm); }
        textarea.terminal-input::placeholder { color: var(--text-dim); }

        .cursor { display: inline-block; width: 7px; height: 14px; background: var(--accent-llm); margin-left: 4px; animation: blink 1s step-start infinite; vertical-align: -2px; }
        @keyframes blink { 50% { opacity: 0; } }
        .reasoning-line { display: flex; gap: 10px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--text-muted); padding: 3px 0; opacity: 0; animation: fadeIn 0.4s forwards; }
        @keyframes fadeIn { to { opacity: 1; } }

        .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
        .plan-card { border: 1px solid var(--border); }
        .plan-card.recommended { border-color: var(--accent-llm); }
        .badge-rec { font-size: 10.5px; font-weight: 600; color: var(--accent-llm); background: rgba(181,131,240,0.12); border: 1px solid rgba(181,131,240,0.35); border-radius: 6px; padding: 2px 7px; letter-spacing: 0.03em; }

        .row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; padding: 5px 0; color: var(--text-muted); }
        .row strong { color: var(--text); font-family: 'IBM Plex Mono', monospace; font-weight: 500; }
        .divider { border-top: 1px solid var(--border); margin: 10px 0; }

        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap: 12px; }
        .stat-tile { padding: 12px 14px; }
        .stat-tile-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
        .stat-value { font-size: 17px; font-weight: 500; }

        .progress-track { width: 100%; height: 6px; border-radius: 4px; background: var(--panel-alt); overflow: hidden; margin: 8px 0; }
        .progress-fill { height: 100%; border-radius: 4px; transition: width 0.4s; }

        .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 600; padding: 3px 8px; border-radius: 6px; letter-spacing: 0.02em; }
        .pill-compute { background: rgba(91,141,239,0.12); color: var(--accent-compute); }
        .pill-api { background: rgba(232,163,61,0.12); color: var(--accent-api); }
        .pill-llm { background: rgba(181,131,240,0.12); color: var(--accent-llm); }
        .pill-reliability { background: rgba(232,86,79,0.12); color: var(--bad); }

        .rec-card { display: flex; gap: 12px; padding: 14px 16px; }
        .rec-icon { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .locked-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 60px 20px; color: var(--text-dim); text-align: center; }

        .tab-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
        .tab-toggle button { background: transparent; border: none; color: var(--text-muted); padding: 8px 16px; font-size: 12.5px; cursor: pointer; font-family: inherit; }
        .tab-toggle button.active { background: var(--panel-alt); color: var(--text); }

        .code-block { background: #10121600; background: var(--panel-alt); border: 1px solid var(--border); border-radius: 10px; padding: 16px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.65; color: #C7CBD6; overflow-x: auto; white-space: pre; }

        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
      `}</style>

      {/* RAIL */}
      <nav className="rail">
        <div className="rail-brand" />
        {railItems.map((item) => (
          <button
            key={item.id}
            className={`rail-item ${activeView === item.id ? "active" : ""}`}
            disabled={item.locked}
            title={item.locked ? `${item.label} — locked` : item.label}
            onClick={() => setActiveView(item.id)}
          >
            {item.locked ? <Lock size={16} /> : <item.Icon size={16} />}
            <span className="rail-num">{item.num}</span>
            <span className="rail-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* MAIN */}
      <div className="main">
        <div className="topbar">
          <div>
            <div className="display" style={{ fontWeight: 700, fontSize: 15 }}>LEDGER</div>
            <div className="label-sm" style={{ marginTop: 1 }}>Infra, priced and watched</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div className="status-pill">
              <span className={`status-dot ${isDeployed ? "live" : ""}`} />
              {isDeployed ? "Sandbox: live" : "Sandbox: idle"}
            </div>
            {stage !== "intake" && (
              <button className="btn-ghost" onClick={handleReset}>
                <RefreshCw size={13} /> New project
              </button>
            )}
          </div>
        </div>

        <div className="content">
          {/* ---------------- DESCRIBE ---------------- */}
          {activeView === "describe" && (
            <div style={{ maxWidth: 640 }}>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Describe what you're building</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
                Plain language in. A sized, priced infrastructure plan out.
              </p>

              {stage === "intake" && (
                <>
                  <textarea
                    className="terminal-input"
                    placeholder="We're building a RAG pipeline for 10,000 daily users with sub-2s latency..."
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0 20px" }}>
                    {EXAMPLES.map((ex, i) => (
                      <button key={i} className="chip" onClick={() => setInputText(ex)}>{ex}</button>
                    ))}
                  </div>
                  <button className="btn-primary" onClick={handleAnalyze}>
                    Design infrastructure <ArrowRight size={14} />
                  </button>
                </>
              )}

              {stage === "analyzing" && (
                <div className="panel" style={{ minHeight: 180 }}>
                  <div className="label-sm" style={{ marginBottom: 12 }}>Agent is reasoning</div>
                  {reasoningLines.slice(0, revealCount).map((line, i) => (
                    <div key={i} className="reasoning-line">
                      <ChevronRight size={13} style={{ marginTop: 2, flexShrink: 0 }} />
                      <span>{line}</span>
                    </div>
                  ))}
                  {revealCount < reasoningLines.length && <span className="cursor" />}
                </div>
              )}

              {stage === "plan" && (
                <div className="panel" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--good)" }}>
                  <Check size={16} /> Plan ready — open the <strong style={{ color: "var(--text)" }}>Plan</strong> tab.
                </div>
              )}
            </div>
          )}

          {/* ---------------- PLAN ---------------- */}
          {activeView === "plan" && plans && req && (
            <div>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Two ways to build this</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
                For {fmtNum(req.users)} users at a {(req.latencyMs / 1000).toFixed(req.latencyMs % 1000 === 0 ? 0 : 1)}s latency target.
              </p>
              <div className="plan-grid">
                {plans.map((plan) => (
                  <div key={plan.key} className={`panel plan-card ${plan.recommended ? "recommended" : ""}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <div className="panel-title display" style={{ fontSize: 15 }}>{plan.name}</div>
                      {plan.recommended && <span className="badge-rec">RECOMMENDED</span>}
                    </div>
                    <div style={{ fontSize: 12.5, color: plan.meetsTarget ? "var(--good)" : "var(--bad)", marginBottom: 12 }}>
                      Est. latency {Math.round(plan.estimatedLatencyMs)}ms — {plan.meetsTarget ? "meets target" : "above target"}
                    </div>

                    <div className="row"><span>Compute</span><strong>{plan.computeDesc}</strong></div>
                    <div className="row"><span>Model</span><strong>{plan.modelDesc}</strong></div>
                    {plan.smallModelDesc && <div className="row"><span>Secondary model</span><strong>{plan.smallModelDesc}</strong></div>}
                    {plan.vectorDbDesc && <div className="row"><span>Vector store</span><strong>{plan.vectorDbDesc}</strong></div>}

                    <div className="divider" />
                    <div className="row"><span>Compute</span><strong>{fmtMoney(plan.costs.compute)}/mo</strong></div>
                    {plan.needsVectorDb && <div className="row"><span>Vector DB</span><strong>{fmtMoney(plan.costs.vectorDb)}/mo</strong></div>}
                    <div className="row"><span>LLM tokens</span><strong>{fmtMoney(plan.costs.llm)}/mo</strong></div>
                    <div className="row"><span>API tokens</span><strong>{fmtMoney(plan.costs.api)}/mo</strong></div>
                    <div className="row" style={{ color: "var(--text)", fontWeight: 600 }}><span>Total</span><strong>{fmtMoney(plan.costs.total)}/mo</strong></div>

                    <div className="divider" />
                    <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.5 }}>{plan.tradeoff}</p>

                    <button className="btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => handleDeploy(plan)}>
                      <Rocket size={14} /> Deploy to sandbox
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ---------------- CONSOLE ---------------- */}
          {activeView === "console" && (!isDeployed ? (
            <LockedState onGoPlan={() => setActiveView(plans ? "plan" : "describe")} label="Deploy a plan first to open the console." />
          ) : (
            <div>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Live console</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
                {selectedPlan.name} · deployed to sandbox
              </p>

              <div className="stats-grid" style={{ marginBottom: 16 }}>
                <StatTile label="CPU" value={liveAvg.cpu.toFixed(0)} unit="%" color="var(--accent-compute)" series={monitor.liveTicks.cpu} />
                <StatTile label="Memory" value={liveAvg.mem.toFixed(0)} unit="%" color="var(--accent-compute)" series={monitor.liveTicks.mem} />
                {selectedPlan.needsGpu && (
                  <StatTile label="GPU" value={liveAvg.gpu.toFixed(0)} unit="%" color="var(--accent-compute)" series={monitor.liveTicks.gpu} />
                )}
                <StatTile label="Latency p95" value={Math.round(monitor.liveTicks.latency[monitor.liveTicks.latency.length - 1].v)} unit="ms" color="var(--accent-compute)" series={monitor.liveTicks.latency} />
                <StatTile label="Error rate" value={liveAvg.error.toFixed(1)} unit="%" color={liveAvg.error > 2.2 ? "var(--bad)" : "var(--good)"} series={monitor.liveTicks.error} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
                <BudgetPanel title="API tokens" color="var(--accent-api)" burn={apiBurn} budget={monitor.apiBudget} unit="calls" />
                <BudgetPanel title="LLM tokens" color="var(--accent-llm)" burn={llmBurn} budget={monitor.llmBudget} unit="tokens" extra={`Prompt/completion split ${Math.round(monitor.promptShare * 100)}% / ${Math.round((1 - monitor.promptShare) * 100)}%`} />
              </div>

              <div className="panel">
                <div className="panel-title">Cumulative LLM token usage vs. monthly budget</div>
                <div className="label-sm" style={{ marginBottom: 10 }}>Solid = observed · dashed = projected at current growth rate</div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={llmBurn.points} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: "var(--text-dim)", fontSize: 11 }} axisLine={{ stroke: "var(--border)" }} tickLine={false} label={{ value: "day of cycle", position: "insideBottom", offset: -3, fill: "var(--text-dim)", fontSize: 10 }} />
                    <YAxis tickFormatter={fmtNum} tick={{ fill: "var(--text-dim)", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip
                      contentStyle={{ background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "var(--text-muted)" }}
                      formatter={(v) => fmtNum(v)}
                    />
                    <ReferenceLine y={monitor.llmBudget} stroke="var(--bad)" strokeDasharray="4 4" label={{ value: "budget", position: "insideTopLeft", fill: "var(--bad)", fontSize: 11 }} />
                    <Line type="monotone" dataKey="actual" stroke="var(--accent-llm)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="projected" stroke="var(--accent-llm)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}

          {/* ---------------- OPTIMIZE ---------------- */}
          {activeView === "optimize" && (!isDeployed ? (
            <LockedState onGoPlan={() => setActiveView(plans ? "plan" : "describe")} label="Deploy a plan first to generate recommendations." />
          ) : (
            <div>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Recommendations</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
                Generated from what the console is observing right now — not fixed rules.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {recommendations.map((rec) => {
                  const meta = CATEGORY_META[rec.category];
                  return (
                    <div key={rec.id} className="panel rec-card">
                      <div className="rec-icon" style={{ background: `var(--panel-alt)` }}>
                        <meta.Icon size={16} className={meta.cls} style={{ color: `var(--accent-${rec.category === "reliability" ? "" : rec.category})` }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                          <span className={`pill ${meta.cls}`}>{meta.label}</span>
                          <span style={{ fontWeight: 600, fontSize: 13.5 }}>{rec.title}</span>
                        </div>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 6px", lineHeight: 1.55 }}>{rec.detail}</p>
                        <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{rec.impact}</span>
                      </div>
                      {rec.id !== "all-good" && (
                        <button
                          className="btn-ghost"
                          style={{ padding: "6px 10px", fontSize: 11, alignSelf: "flex-start" }}
                          onClick={() => setDismissed((d) => [...d, rec.id])}
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* ---------------- EXPORT ---------------- */}
          {activeView === "export" && (!isDeployed ? (
            <LockedState onGoPlan={() => setActiveView(plans ? "plan" : "describe")} label="Deploy a plan first to export its configuration." />
          ) : (
            <div>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Export the stack</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 18px" }}>
                Generated from the {selectedPlan.name} plan.
              </p>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div className="tab-toggle">
                  <button className={exportTab === "terraform" ? "active" : ""} onClick={() => setExportTab("terraform")}>Terraform</button>
                  <button className={exportTab === "docker" ? "active" : ""} onClick={() => setExportTab("docker")}>Dockerfile</button>
                </div>
                <button className="btn-ghost" onClick={() => handleCopy(exportTab === "terraform" ? terraformSnippet(selectedPlan) : dockerSnippet(selectedPlan))}>
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="code-block">
                {exportTab === "terraform" ? terraformSnippet(selectedPlan) : dockerSnippet(selectedPlan)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LockedState({ label, onGoPlan }) {
  return (
    <div className="locked-state">
      <Lock size={22} />
      <div style={{ fontSize: 14 }}>{label}</div>
      <button className="btn-ghost" onClick={onGoPlan}>
        <Server size={13} /> Go to plan
      </button>
    </div>
  );
}

function BudgetPanel({ title, color, burn, budget, unit, extra }) {
  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="panel-title">{title}</div>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>{fmtNum(burn.usedSoFar)} / {fmtNum(budget)} {unit}</span>
      </div>
      <Progress value={burn.usedSoFar} max={budget} color={color} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-muted)" }}>
        <span>{burn.weeklyGrowth >= 0 ? "+" : ""}{Math.round(burn.weeklyGrowth * 100)}% week-over-week</span>
        <span style={{ color: burn.overrunWithinCycle ? "var(--bad)" : "var(--good)" }}>
          {burn.overrunWithinCycle ? `Runway: ${burn.daysUntilOverrun}d` : "On budget"}
        </span>
      </div>
      {extra && <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>{extra}</div>}
    </div>
  );
}

function terraformSnippet(plan) {
  return `# Generated by Ledger — ${plan.name} plan
resource "aws_ecs_cluster" "app" {
  name = "app-${plan.key}-cluster"
}

resource "aws_ecs_service" "inference" {
  name            = "inference-service"
  cluster         = aws_ecs_cluster.app.id
  desired_count   = ${Math.max(2, Math.round(plan.concurrency / 40))}
  launch_type     = "${plan.needsGpu ? "EC2" : "FARGATE"}"
}

resource "aws_appautoscaling_target" "inference" {
  max_capacity       = ${Math.max(4, Math.round(plan.concurrency / 22))}
  min_capacity       = ${Math.max(2, Math.round(plan.concurrency / 60))}
  resource_id        = "service/app-${plan.key}-cluster/inference-service"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}
${plan.needsVectorDb ? `
resource "aws_opensearch_domain" "vectors" {
  domain_name    = "vector-index-${plan.key}"
  engine_version = "OpenSearch_2.11"
}` : ""}

variable "llm_monthly_token_budget" {
  default = ${plan.dailyLlmCalls * (plan.avgPromptTokens + plan.avgCompletionTokens) * 30}
}

variable "api_monthly_call_budget" {
  default = ${plan.dailyApiCalls * 30}
}
`;
}

function dockerSnippet(plan) {
  return `# Generated by Ledger — ${plan.name} plan
FROM ${plan.needsGpu ? "nvidia/cuda:12.2.0-runtime-ubuntu22.04" : "python:3.11-slim"}

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV LLM_MONTHLY_TOKEN_BUDGET=${plan.dailyLlmCalls * (plan.avgPromptTokens + plan.avgCompletionTokens) * 30}
ENV API_MONTHLY_CALL_BUDGET=${plan.dailyApiCalls * 30}
ENV TARGET_LATENCY_MS=${plan.estimatedLatencyMs}

EXPOSE 8080
CMD ["python", "serve.py"]
`;
}

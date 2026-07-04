import { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Terminal, Layers, Activity, Sparkles, Download, Cpu, Zap, ShieldAlert,
  ArrowRight, Copy, Check, Rocket, RefreshCw, Lock, ChevronRight, Server,
} from "lucide-react";

const API_ROOT = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

const EXAMPLES = [
  "We're building a RAG pipeline for 10,000 daily users with sub-2s latency",
  "Customer support chatbot for 50,000 monthly users, sub-1.5s latency",
  "Batch image classification pipeline, 200,000 images/day",
];

const CATEGORY_META = {
  compute: { label: "Compute", cls: "pill-compute", Icon: Cpu, color: "var(--accent-compute)" },
  api: { label: "API tokens", cls: "pill-api", Icon: Zap, color: "var(--accent-api)" },
  llm: { label: "LLM tokens", cls: "pill-llm", Icon: Sparkles, color: "var(--accent-llm)" },
  reliability: { label: "Reliability", cls: "pill-reliability", Icon: ShieldAlert, color: "var(--bad)" },
};

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : payload.detail || "Request failed";
    throw new Error(detail);
  }

  return payload;
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n).toString();
}

function fmtMoney(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

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

export default function InfraAgentPlatform() {
  const [stage, setStage] = useState("intake");
  const [inputText, setInputText] = useState("");
  const [req, setReq] = useState(null);
  const [plans, setPlans] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [reasoningLines, setReasoningLines] = useState([]);
  const [revealCount, setRevealCount] = useState(0);
  const [activeView, setActiveView] = useState("describe");
  const [isDeployed, setIsDeployed] = useState(false);
  const [deploymentId, setDeploymentId] = useState(null);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [monitor, setMonitor] = useState(null);
  const [burn, setBurn] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [dismissed, setDismissed] = useState([]);
  const [exportTab, setExportTab] = useState("terraform");
  const [exportsState, setExportsState] = useState({ terraform: "", docker: "" });
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const syncDeploymentState = useCallback((payload, resetDismissed = false) => {
    setDeploymentId(payload.deploymentId);
    setSelectedPlan(payload.selectedPlan);
    setMonitor(payload.monitor);
    setBurn(payload.burn);
    setRecommendations(payload.recommendations || []);
    setExportsState(payload.exports || { terraform: "", docker: "" });
    setIsDeployed(true);
    if (resetDismissed) setDismissed([]);
  }, []);

  const handleAnalyze = useCallback(async () => {
    const text = inputText.trim() || EXAMPLES[0];
    setError("");
    setPending(true);
    setStage("analyzing");
    setRevealCount(0);

    try {
      const result = await apiRequest("/analyze", {
        method: "POST",
        body: JSON.stringify({ requirement: text }),
      });
      setProjectId(result.projectId);
      setReq(result.requirement);
      setPlans(result.plans);
      setReasoningLines(result.reasoningLines);
    } catch (err) {
      setStage("intake");
      setError(err.message);
    } finally {
      setPending(false);
    }
  }, [inputText]);

  useEffect(() => {
    if (stage !== "analyzing" || reasoningLines.length === 0) return;
    if (revealCount >= reasoningLines.length) {
      const t = setTimeout(() => {
        setStage("plan");
        setActiveView("plan");
      }, 550);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setRevealCount((c) => c + 1), 460);
    return () => clearTimeout(t);
  }, [stage, revealCount, reasoningLines]);

  const handleDeploy = useCallback(async (plan) => {
    if (!projectId) return;
    setPending(true);
    setError("");
    try {
      const result = await apiRequest(`/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ planKey: plan.key }),
      });
      syncDeploymentState(result, true);
      setActiveView("console");
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }, [projectId, syncDeploymentState]);

  useEffect(() => {
    if (!deploymentId) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const result = await apiRequest(`/deployments/${deploymentId}`);
        if (!cancelled) syncDeploymentState(result, false);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };

    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [deploymentId, syncDeploymentState]);

  const visibleRecommendations = useMemo(
    () => recommendations.filter((rec) => !dismissed.includes(rec.id)),
    [recommendations, dismissed],
  );

  const handleReset = useCallback(() => {
    setStage("intake");
    setInputText("");
    setReq(null);
    setPlans(null);
    setProjectId(null);
    setReasoningLines([]);
    setRevealCount(0);
    setActiveView("describe");
    setIsDeployed(false);
    setDeploymentId(null);
    setSelectedPlan(null);
    setMonitor(null);
    setBurn(null);
    setRecommendations([]);
    setDismissed([]);
    setExportsState({ terraform: "", docker: "" });
    setError("");
    setPending(false);
  }, []);

  const handleCopy = useCallback((text) => {
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // ignore clipboard errors in unsupported contexts
    }
  }, []);

  const railItems = [
    { id: "describe", num: "01", label: "Describe", Icon: Terminal, locked: false },
    { id: "plan", num: "02", label: "Plan", Icon: Layers, locked: !plans },
    { id: "console", num: "03", label: "Console", Icon: Activity, locked: !isDeployed },
    { id: "optimize", num: "04", label: "Optimize", Icon: Sparkles, locked: !isDeployed },
    { id: "export", num: "05", label: "Export", Icon: Download, locked: !isDeployed },
  ];

  const llmBurn = burn?.llm;
  const apiBurn = burn?.api;
  const liveTicks = monitor?.liveTicks;
  const liveAverages = monitor?.liveAverages || { cpu: 0, mem: 0, gpu: 0, error: 0, latency: 0 };

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
        .btn-primary:hover:not(:disabled) { opacity: 0.9; }
        .btn-primary:disabled, .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 9px; padding: 9px 14px; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
        .btn-ghost:hover:not(:disabled) { color: var(--text); border-color: var(--text-dim); }

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

        .row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; padding: 5px 0; color: var(--text-muted); gap: 12px; }
        .row strong { color: var(--text); font-family: 'IBM Plex Mono', monospace; font-weight: 500; text-align: right; }
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

        .code-block { background: var(--panel-alt); border: 1px solid var(--border); border-radius: 10px; padding: 16px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.65; color: #C7CBD6; overflow-x: auto; white-space: pre; }
        .banner-error { margin-top: 14px; color: #FFD6D4; border-color: rgba(232,86,79,0.45); background: rgba(232,86,79,0.08); }

        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
      `}</style>

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

      <div className="main">
        <div className="topbar">
          <div>
            <div className="display" style={{ fontWeight: 700, fontSize: 15 }}>LEDGER</div>
            <div className="label-sm" style={{ marginTop: 1 }}>React UI over a Python planning service</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div className="status-pill">
              <span className={`status-dot ${isDeployed ? "live" : ""}`} />
              {isDeployed ? "Backend: live deployment" : "Backend: idle"}
            </div>
            {stage !== "intake" && (
              <button className="btn-ghost" onClick={handleReset}>
                <RefreshCw size={13} /> New project
              </button>
            )}
          </div>
        </div>

        <div className="content">
          {activeView === "describe" && (
            <div style={{ maxWidth: 640 }}>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Describe what you're building</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
                React sends plain language to a Python service that sizes, prices, and monitors the stack.
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
                  <button className="btn-primary" onClick={handleAnalyze} disabled={pending}>
                    Design infrastructure <ArrowRight size={14} />
                  </button>
                </>
              )}

              {stage === "analyzing" && (
                <div className="panel" style={{ minHeight: 180 }}>
                  <div className="label-sm" style={{ marginBottom: 12 }}>Python planner is reasoning</div>
                  {reasoningLines.length === 0 && (
                    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                      Waiting for backend response{pending ? "..." : "."}
                    </div>
                  )}
                  {reasoningLines.slice(0, revealCount).map((line, i) => (
                    <div key={i} className="reasoning-line">
                      <ChevronRight size={13} style={{ marginTop: 2, flexShrink: 0 }} />
                      <span>{line}</span>
                    </div>
                  ))}
                  {reasoningLines.length > 0 && revealCount < reasoningLines.length && <span className="cursor" />}
                </div>
              )}

              {stage === "plan" && (
                <div className="panel" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--good)" }}>
                  <Check size={16} /> Plan ready — open the <strong style={{ color: "var(--text)" }}>Plan</strong> tab.
                </div>
              )}

              {error && <div className="panel banner-error">{error}</div>}
            </div>
          )}

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

                    <button className="btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => handleDeploy(plan)} disabled={pending}>
                      <Rocket size={14} /> Deploy to backend sandbox
                    </button>
                  </div>
                ))}
              </div>
              {error && <div className="panel banner-error" style={{ marginTop: 16 }}>{error}</div>}
            </div>
          )}

          {activeView === "console" && (!isDeployed || !selectedPlan || !monitor || !llmBurn || !apiBurn ? (
            <LockedState onGoPlan={() => setActiveView(plans ? "plan" : "describe")} label="Deploy a plan first to open the console." />
          ) : (
            <div>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Live console</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
                {selectedPlan.name} · deployment {deploymentId}
              </p>

              <div className="stats-grid" style={{ marginBottom: 16 }}>
                <StatTile label="CPU" value={liveAverages.cpu.toFixed(0)} unit="%" color="var(--accent-compute)" series={liveTicks.cpu} />
                <StatTile label="Memory" value={liveAverages.mem.toFixed(0)} unit="%" color="var(--accent-compute)" series={liveTicks.mem} />
                {selectedPlan.needsGpu && (
                  <StatTile label="GPU" value={liveAverages.gpu.toFixed(0)} unit="%" color="var(--accent-compute)" series={liveTicks.gpu} />
                )}
                <StatTile label="Latency p95" value={Math.round(liveTicks.latency[liveTicks.latency.length - 1].v)} unit="ms" color="var(--accent-compute)" series={liveTicks.latency} />
                <StatTile label="Error rate" value={liveAverages.error.toFixed(1)} unit="%" color={liveAverages.error > 2.2 ? "var(--bad)" : "var(--good)"} series={liveTicks.error} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
                <BudgetPanel title="API tokens" color="var(--accent-api)" burn={apiBurn} budget={monitor.apiBudget} unit="calls" extra={`Current daily burn ${fmtNum(apiBurn.currentDaily)} calls`} />
                <BudgetPanel
                  title="LLM tokens"
                  color="var(--accent-llm)"
                  burn={llmBurn}
                  budget={monitor.llmBudget}
                  unit="tokens"
                  extra={`Prompt/completion ${monitor.promptTokensPerRequest} / ${monitor.completionTokensPerRequest} tokens per request`}
                />
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
              {error && <div className="panel banner-error" style={{ marginTop: 16 }}>{error}</div>}
            </div>
          ))}

          {activeView === "optimize" && (!isDeployed ? (
            <LockedState onGoPlan={() => setActiveView(plans ? "plan" : "describe")} label="Deploy a plan first to generate recommendations." />
          ) : (
            <div>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Recommendations</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 20px" }}>
                Generated server-side from persisted budgets, metrics, and token history.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {visibleRecommendations.map((rec) => {
                  const meta = CATEGORY_META[rec.category];
                  return (
                    <div key={rec.id} className="panel rec-card">
                      <div className="rec-icon" style={{ background: `var(--panel-alt)` }}>
                        <meta.Icon size={16} style={{ color: meta.color }} />
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

          {activeView === "export" && (!isDeployed ? (
            <LockedState onGoPlan={() => setActiveView(plans ? "plan" : "describe")} label="Deploy a plan first to export its configuration." />
          ) : (
            <div>
              <h2 className="display" style={{ fontSize: 24, margin: "0 0 6px" }}>Export the stack</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 18px" }}>
                Generated by the Python backend from the selected persisted plan.
              </p>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div className="tab-toggle">
                  <button className={exportTab === "terraform" ? "active" : ""} onClick={() => setExportTab("terraform")}>Terraform</button>
                  <button className={exportTab === "docker" ? "active" : ""} onClick={() => setExportTab("docker")}>Dockerfile</button>
                </div>
                <button className="btn-ghost" onClick={() => handleCopy(exportTab === "terraform" ? exportsState.terraform : exportsState.docker)}>
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="code-block">
                {exportTab === "terraform" ? exportsState.terraform : exportsState.docker}
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

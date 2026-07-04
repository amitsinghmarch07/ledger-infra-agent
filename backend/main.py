import json
import math
import random
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "backend" / "ledger.db"

app = FastAPI(title="Ledger Infra Agent API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    requirement: str = Field(min_length=3)


class DeployRequest(BaseModel):
    planKey: str = Field(min_length=1)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS project_requests (
              id TEXT PRIMARY KEY,
              raw_text TEXT NOT NULL,
              users REAL NOT NULL,
              latency_ms REAL NOT NULL,
              flags_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS generated_plans (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              plan_key TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES project_requests(id)
            );

            CREATE TABLE IF NOT EXISTS deployments (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              plan_key TEXT NOT NULL,
              status TEXT NOT NULL,
              selected_plan_json TEXT NOT NULL,
              monitor_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES project_requests(id)
            );

            CREATE TABLE IF NOT EXISTS monitor_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              deployment_id TEXT NOT NULL,
              snapshot_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(deployment_id) REFERENCES deployments(id)
            );
            """
        )


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/analyze")
def analyze(request: AnalyzeRequest) -> dict[str, Any]:
    requirement = parse_requirements(request.requirement.strip())
    project_id = new_id("proj")
    created_at = now_iso()
    plans = estimate_stack(requirement)

    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO project_requests (id, raw_text, users, latency_ms, flags_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                requirement["raw"],
                requirement["users"],
                requirement["latencyMs"],
                json.dumps(requirement["flags"]),
                created_at,
            ),
        )
        for plan in plans:
            conn.execute(
                """
                INSERT INTO generated_plans (id, project_id, plan_key, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (new_id("plan"), project_id, plan["key"], json.dumps(plan), created_at),
            )

    return {
        "projectId": project_id,
        "requirement": requirement,
        "reasoningLines": build_reasoning_trace(requirement),
        "plans": plans,
    }


@app.post("/api/projects/{project_id}/deploy")
def deploy(project_id: str, request: DeployRequest) -> dict[str, Any]:
    with db_connection() as conn:
        row = conn.execute(
            """
            SELECT payload_json
            FROM generated_plans
            WHERE project_id = ? AND plan_key = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (project_id, request.planKey),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Plan not found")

        plan = json.loads(row["payload_json"])
        monitor = build_monitor(plan)
        deployment_id = new_id("deploy")
        timestamp = now_iso()

        conn.execute(
            """
            INSERT INTO deployments (
              id, project_id, plan_key, status, selected_plan_json, monitor_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                deployment_id,
                project_id,
                request.planKey,
                "live",
                json.dumps(plan),
                json.dumps(monitor),
                timestamp,
                timestamp,
            ),
        )
        conn.execute(
            """
            INSERT INTO monitor_snapshots (deployment_id, snapshot_json, created_at)
            VALUES (?, ?, ?)
            """,
            (deployment_id, json.dumps(monitor), timestamp),
        )

    return serialize_deployment(deployment_id, plan, monitor)


@app.get("/api/deployments/{deployment_id}")
def get_deployment(deployment_id: str) -> dict[str, Any]:
    with db_connection() as conn:
        row = conn.execute(
            """
            SELECT selected_plan_json, monitor_json
            FROM deployments
            WHERE id = ?
            LIMIT 1
            """,
            (deployment_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Deployment not found")

        plan = json.loads(row["selected_plan_json"])
        monitor = json.loads(row["monitor_json"])
        monitor = advance_monitor(plan, monitor)
        timestamp = now_iso()

        conn.execute(
            """
            UPDATE deployments
            SET monitor_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (json.dumps(monitor), timestamp, deployment_id),
        )
        conn.execute(
            """
            INSERT INTO monitor_snapshots (deployment_id, snapshot_json, created_at)
            VALUES (?, ?, ?)
            """,
            (deployment_id, json.dumps(monitor), timestamp),
        )

    return serialize_deployment(deployment_id, plan, monitor)


def parse_requirements(raw: str) -> dict[str, Any]:
    text = raw.lower()

    users = 1000.0
    user_match = re.search(r"([\d]{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*(k)?\s*(?:daily|monthly)?\s*(?:active\s*)?users?", text)
    if user_match:
        value = float(user_match.group(1).replace(",", ""))
        if user_match.group(2):
            value *= 1000
        if value > 0:
            users = value

    latency_ms = 2000.0
    sub_match = re.search(r"sub[- ]?(\d+(?:\.\d+)?)\s*s\b", text)
    ms_match = re.search(r"(\d+)\s*ms\b", text)
    s_match = re.search(r"(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b", text)
    if sub_match:
        latency_ms = float(sub_match.group(1)) * 1000
    elif ms_match:
        latency_ms = float(ms_match.group(1))
    elif s_match:
        latency_ms = float(s_match.group(1)) * 1000

    flags = {
        "rag": bool(re.search(r"\brag\b|retrieval", text)),
        "chat": bool(re.search(r"\bchat\b|conversation|support bot|assistant", text)),
        "classification": "classif" in text,
        "image": bool(re.search(r"\bimage\b|vision", text)),
        "video": bool(re.search(r"\bvideo\b", text)),
        "voice": bool(re.search(r"\bvoice\b|speech|audio", text)),
    }
    if not any(flags.values()):
        flags["chat"] = True

    return {"raw": raw, "users": round(users), "latencyMs": latency_ms, "flags": flags}


def build_reasoning_trace(requirement: dict[str, Any]) -> list[str]:
    secs = f"{requirement['latencyMs'] / 1000:.1f}".rstrip("0").rstrip(".")
    flags = [name for name, enabled in requirement["flags"].items() if enabled]
    lines = [
        f"Reading requirement: {fmt_num(requirement['users'])} users, {secs}s latency target",
        f"Classifying workload: {', '.join(flags)}",
        f"Sizing concurrency at roughly {max(5, round(requirement['users'] * 0.045))} simultaneous sessions",
    ]
    if requirement["flags"]["rag"]:
        lines.append("Comparing managed vector index options for this scale")
    if requirement["flags"]["image"] or requirement["flags"]["video"] or requirement["flags"]["voice"]:
        lines.append("Checking whether GPU inference is required")
    lines.append("Modeling monthly token burn — prompt, completion, and third-party API calls")
    lines.append("Drafting two infrastructure options and comparing trade-offs")
    return lines


def estimate_stack(requirement: dict[str, Any]) -> list[dict[str, Any]]:
    concurrency = max(5, round(requirement["users"] * 0.045))
    needs_gpu = requirement["flags"]["image"] or requirement["flags"]["video"] or requirement["flags"]["voice"]
    needs_vector_db = requirement["flags"]["rag"]
    calls_per_user_per_day = (
        9 if requirement["flags"]["classification"] else 4 if requirement["flags"]["rag"] else 6 if requirement["flags"]["chat"] else 3
    )
    daily_llm_calls = max(50, round(requirement["users"] * calls_per_user_per_day * 0.35))
    daily_api_calls = max(80, round(requirement["users"] * 1.8))

    def tier_plan(tier: str) -> dict[str, Any]:
        is_perf = tier == "perf"
        compute_unit_cost = 64 if is_perf else 36
        compute_cost = round((concurrency * compute_unit_cost) / 10) * 10
        vector_db_cost = round((150 if is_perf else 65) + concurrency * (0.55 if is_perf else 0.3)) if needs_vector_db else 0
        avg_prompt_tokens = 1500 if is_perf else 1000
        avg_completion_tokens = 320 if is_perf else 230
        prompt_price = 7.5 if is_perf else 2.0
        completion_price = 22 if is_perf else 7.5
        llm_cost = round(
            daily_llm_calls * 30 * ((avg_prompt_tokens / 1e6) * prompt_price + (avg_completion_tokens / 1e6) * completion_price)
        )
        api_cost = round(daily_api_calls * 30 * (0.0009 if is_perf else 0.0006))
        total = compute_cost + vector_db_cost + llm_cost + api_cost
        estimated_latency_ms = round(
            requirement["latencyMs"] * (0.72 if is_perf else 1.28) * (1.15 if needs_gpu and not is_perf else 1)
        )
        min_nodes = max(2, round(concurrency / (40 if needs_gpu else 60)))
        max_nodes = max(4, round(concurrency / (22 if needs_gpu else 28)))
        return {
            "key": tier,
            "name": "Latency-optimized" if is_perf else "Cost-optimized",
            "needsGpu": needs_gpu,
            "needsVectorDb": needs_vector_db,
            "flagsClassification": requirement["flags"]["classification"],
            "concurrency": concurrency,
            "estimatedLatencyMs": estimated_latency_ms,
            "meetsTarget": estimated_latency_ms <= requirement["latencyMs"],
            "computeDesc": (
                f"{'Dedicated' if is_perf else 'Shared'} GPU inference pool · {min_nodes}–{max_nodes} nodes"
                if needs_gpu
                else f"Autoscaling CPU pool · {min_nodes}–{max_nodes} nodes"
            ),
            "modelDesc": "Frontier-tier reasoning model" if is_perf else "Efficient-tier instruction model",
            "smallModelDesc": "Compact classifier model for routing/labeling calls" if requirement["flags"]["classification"] else None,
            "vectorDbDesc": (
                "Managed vector index · multi-zone"
                if needs_vector_db and is_perf
                else "Managed vector index · single-zone"
                if needs_vector_db
                else None
            ),
            "costs": {"compute": compute_cost, "vectorDb": vector_db_cost, "llm": llm_cost, "api": api_cost, "total": total},
            "dailyLlmCalls": daily_llm_calls,
            "avgPromptTokens": avg_prompt_tokens,
            "avgCompletionTokens": avg_completion_tokens,
            "dailyApiCalls": daily_api_calls,
            "tradeoff": (
                "Meets the latency target with margin. The added cost is mostly the model choice, not the infrastructure."
                if is_perf
                else "Runs lean and costs less. Latency can drift above target under peak load — worth watching if p95 matters."
            ),
        }

    cost = tier_plan("cost")
    perf = tier_plan("perf")
    cost["recommended"] = cost["meetsTarget"]
    perf["recommended"] = not cost["meetsTarget"]
    return [cost, perf]


def build_monitor(plan: dict[str, Any]) -> dict[str, Any]:
    prompt_share = clamp(
        plan["avgPromptTokens"] / (plan["avgPromptTokens"] + plan["avgCompletionTokens"]) + (random.random() * 0.05 - 0.025),
        0.5,
        0.92,
    )
    llm_history = build_history(plan["dailyLlmCalls"] * (plan["avgPromptTokens"] + plan["avgCompletionTokens"]), 0.20, 14)
    api_history = build_history(plan["dailyApiCalls"], 0.06, 14)
    llm_budget = round((plan["dailyLlmCalls"] * (plan["avgPromptTokens"] + plan["avgCompletionTokens"]) * 30 * 1.06) / 1000) * 1000
    api_budget = round(plan["dailyApiCalls"] * 30 * 1.10)
    return {
        "llmHistory": llm_history,
        "apiHistory": api_history,
        "llmBudget": llm_budget,
        "apiBudget": api_budget,
        "promptShare": prompt_share,
        "promptTokensPerRequest": plan["avgPromptTokens"],
        "completionTokensPerRequest": plan["avgCompletionTokens"],
        "liveTicks": {
            "cpu": seed_series(42, {"min": 8, "max": 92, "step": 5}),
            "mem": seed_series(51, {"min": 10, "max": 90, "step": 4}),
            "gpu": seed_series(11, {"min": 0, "max": 95, "step": 3}) if plan["needsGpu"] else None,
            "latency": seed_series(
                plan["estimatedLatencyMs"],
                {"min": plan["estimatedLatencyMs"] * 0.55, "max": plan["estimatedLatencyMs"] * 1.9, "step": plan["estimatedLatencyMs"] * 0.05},
            ),
            "error": seed_series(0.8, {"min": 0, "max": 15, "step": 0.5, "spikeChance": 0.05}),
        },
        "updatedAt": now_iso(),
    }


def advance_monitor(plan: dict[str, Any], monitor: dict[str, Any]) -> dict[str, Any]:
    ticks = monitor["liveTicks"]
    updated = {
        **monitor,
        "liveTicks": {
            "cpu": walk(ticks["cpu"], {"min": 8, "max": 92, "step": 5}),
            "mem": walk(ticks["mem"], {"min": 10, "max": 90, "step": 4}),
            "gpu": walk(ticks["gpu"], {"min": 0, "max": 95, "step": 3}) if ticks.get("gpu") else None,
            "latency": walk(
                ticks["latency"],
                {"min": plan["estimatedLatencyMs"] * 0.55, "max": plan["estimatedLatencyMs"] * 1.9, "step": plan["estimatedLatencyMs"] * 0.05},
            ),
            "error": walk(ticks["error"], {"min": 0, "max": 15, "step": 0.5, "spikeChance": 0.05}),
        },
        "updatedAt": now_iso(),
    }
    return updated


def serialize_deployment(deployment_id: str, plan: dict[str, Any], monitor: dict[str, Any]) -> dict[str, Any]:
    live_averages = {
        "cpu": avg_series(monitor["liveTicks"]["cpu"]),
        "mem": avg_series(monitor["liveTicks"]["mem"]),
        "gpu": avg_series(monitor["liveTicks"]["gpu"]) if monitor["liveTicks"].get("gpu") else 0,
        "error": avg_series(monitor["liveTicks"]["error"]),
        "latency": avg_series(monitor["liveTicks"]["latency"]),
    }
    llm_burn = build_burn_chart_data(monitor["llmHistory"], monitor["llmBudget"])
    api_burn = build_burn_chart_data(monitor["apiHistory"], monitor["apiBudget"])
    monitor_payload = {**monitor, "liveAverages": live_averages}
    return {
        "deploymentId": deployment_id,
        "selectedPlan": plan,
        "monitor": monitor_payload,
        "burn": {"llm": llm_burn, "api": api_burn},
        "recommendations": build_recommendations(plan, llm_burn, api_burn, live_averages, monitor["promptShare"]),
        "exports": {"terraform": terraform_snippet(plan), "docker": docker_snippet(plan)},
    }


def build_history(avg_daily: int, weekly_growth: float, days: int) -> list[int]:
    daily_growth = math.pow(1 + weekly_growth, 1 / 7) - 1
    value = avg_daily / math.pow(1 + daily_growth, days - 1)
    history: list[int] = []
    for _ in range(days):
        noise = 1 + (random.random() * 0.16 - 0.08)
        history.append(max(1, round(value * noise)))
        value = value * (1 + daily_growth)
    return history


def weekly_growth_from_history(history: list[int]) -> float:
    if len(history) < 14:
        return 0
    last_week = sum(history[-7:])
    prev_week = sum(history[-14:-7])
    if prev_week <= 0:
        return 0
    return (last_week - prev_week) / prev_week


def build_burn_chart_data(history: list[int], budget: int, cycle_length_days: int = 30) -> dict[str, Any]:
    cumulative = []
    running = 0
    for value in history:
        running += value
        cumulative.append(running)

    weekly = weekly_growth_from_history(history)
    daily_growth = math.pow(1 + max(weekly, -0.5), 1 / 7) - 1
    points = [{"day": index + 1, "actual": value, "projected": None} for index, value in enumerate(cumulative)]
    points[-1]["projected"] = points[-1]["actual"]

    current = history[-1]
    running_projection = cumulative[-1]
    overrun_day = None
    max_extra = cycle_length_days - len(history) + 12
    for offset in range(1, max_extra + 1):
        current = current * (1 + daily_growth)
        running_projection += current
        points.append({"day": len(history) + offset, "actual": None, "projected": round(running_projection)})
        if overrun_day is None and running_projection >= budget:
            overrun_day = len(history) + offset

    days_until_overrun = overrun_day - len(history) if overrun_day is not None else None
    return {
        "points": points,
        "daysUntilOverrun": days_until_overrun,
        "overrunWithinCycle": overrun_day is not None and overrun_day <= cycle_length_days,
        "dailyGrowth": daily_growth,
        "weeklyGrowth": weekly,
        "usedSoFar": cumulative[-1],
        "currentDaily": history[-1],
    }


def build_recommendations(
    plan: dict[str, Any],
    llm_burn: dict[str, Any],
    api_burn: dict[str, Any],
    live_avg: dict[str, float],
    prompt_share: float,
) -> list[dict[str, str]]:
    recs: list[dict[str, str]] = []
    ratio = prompt_share / (1 - prompt_share)
    if ratio >= 2.2:
        pct = min(35, round((ratio - 1) * 8))
        recs.append(
            {
                "id": "prompt-compress",
                "category": "llm",
                "title": "Compress your system prompt",
                "detail": f"Prompt tokens are running {ratio:.1f}x completion tokens. Trimming the system prompt and retrieval context typically recovers {pct}% of LLM spend without changing output quality.",
                "impact": f"~{fmt_money((plan['costs']['llm'] * pct) / 100)}/mo",
            }
        )
    if llm_burn["overrunWithinCycle"]:
        weekly_pct = round(llm_burn["weeklyGrowth"] * 100)
        days = llm_burn["daysUntilOverrun"]
        suffix = "" if days == 1 else "s"
        recs.append(
            {
                "id": "llm-budget",
                "category": "llm",
                "title": "LLM budget is on track to run out early",
                "detail": f"Usage has grown {weekly_pct}% week-over-week. At this pace the monthly LLM token budget runs out in about {days} day{suffix} — before the cycle ends.",
                "impact": "Budget risk",
            }
        )
    if api_burn["overrunWithinCycle"]:
        days = api_burn["daysUntilOverrun"]
        suffix = "" if days == 1 else "s"
        recs.append(
            {
                "id": "api-budget",
                "category": "api",
                "title": "API token budget is trending over",
                "detail": f"At the current burn rate, the API token budget is projected to run out in about {days} day{suffix}. Caching repeat calls or raising the cap would both help.",
                "impact": "Budget risk",
            }
        )
    if plan["needsGpu"] and live_avg["gpu"] < 18:
        savings = round(plan["costs"]["compute"] * 0.35)
        recs.append(
            {
                "id": "gpu-idle",
                "category": "compute",
                "title": "Your GPU pool is mostly idle",
                "detail": f"Average GPU utilization is {live_avg['gpu']:.0f}% over the monitoring window. Downsizing to a smaller GPU tier would likely cut this line item by about {fmt_money(savings)}/mo.",
                "impact": f"~{fmt_money(savings)}/mo",
            }
        )
    if plan["flagsClassification"]:
        savings = round(plan["costs"]["llm"] * 0.18)
        recs.append(
            {
                "id": "small-model",
                "category": "llm",
                "title": "Route classification calls to a smaller model",
                "detail": "Classification-style calls don't need a frontier model. Routing them to a compact model is projected to save roughly 40% of that slice of LLM spend.",
                "impact": f"~{fmt_money(savings)}/mo",
            }
        )
    if live_avg["error"] > 2.2:
        recs.append(
            {
                "id": "error-rate",
                "category": "reliability",
                "title": "Error rate is above a healthy baseline",
                "detail": f"Errors are averaging {live_avg['error']:.1f}% over the last few minutes, above the 2% baseline. Check retry and backoff settings on the calls that spiked.",
                "impact": "Reliability risk",
            }
        )
    if not recs:
        recs.append(
            {
                "id": "all-good",
                "category": "compute",
                "title": "Everything is within healthy range",
                "detail": "No budget, utilization, or reliability signal needs attention right now.",
                "impact": "—",
            }
        )
    return recs


def walk(points: list[dict[str, float]], options: dict[str, float]) -> list[dict[str, float]]:
    minimum = options.get("min", 0)
    maximum = options.get("max", 100)
    step = options.get("step", 4)
    spike_chance = options.get("spikeChance", 0)
    last = points[-1]["v"]
    delta = (random.random() * 2 - 1) * step
    if spike_chance and random.random() < spike_chance:
        delta += step * 4 * (1 if random.random() > 0.5 else -1)
    nxt = clamp(last + delta, minimum, maximum)
    t = points[-1]["t"] + 1
    return [*points[1:], {"t": t, "v": round(nxt * 10) / 10}]


def seed_series(base: float, options: dict[str, float]) -> list[dict[str, float]]:
    points = [{"t": 0, "v": base}]
    for _ in range(1, 20):
        points = walk(points, options)
    return points


def avg_series(points: list[dict[str, float]] | None) -> float:
    if not points:
        return 0
    return sum(point["v"] for point in points) / len(points)


def terraform_snippet(plan: dict[str, Any]) -> str:
    return f"""# Generated by Ledger — {plan['name']} plan
resource "aws_ecs_cluster" "app" {{
  name = "app-{plan['key']}-cluster"
}}

resource "aws_ecs_service" "inference" {{
  name            = "inference-service"
  cluster         = aws_ecs_cluster.app.id
  desired_count   = {max(2, round(plan['concurrency'] / 40))}
  launch_type     = "{'EC2' if plan['needsGpu'] else 'FARGATE'}"
}}

resource "aws_appautoscaling_target" "inference" {{
  max_capacity       = {max(4, round(plan['concurrency'] / 22))}
  min_capacity       = {max(2, round(plan['concurrency'] / 60))}
  resource_id        = "service/app-{plan['key']}-cluster/inference-service"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}}
{f'''
resource "aws_opensearch_domain" "vectors" {{
  domain_name    = "vector-index-{plan['key']}"
  engine_version = "OpenSearch_2.11"
}}''' if plan['needsVectorDb'] else ''}

variable "llm_monthly_token_budget" {{
  default = {plan['dailyLlmCalls'] * (plan['avgPromptTokens'] + plan['avgCompletionTokens']) * 30}
}}

variable "api_monthly_call_budget" {{
  default = {plan['dailyApiCalls'] * 30}
}}
"""


def docker_snippet(plan: dict[str, Any]) -> str:
    return f"""# Generated by Ledger — {plan['name']} plan
FROM {"nvidia/cuda:12.2.0-runtime-ubuntu22.04" if plan['needsGpu'] else "python:3.11-slim"}

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV LLM_MONTHLY_TOKEN_BUDGET={plan['dailyLlmCalls'] * (plan['avgPromptTokens'] + plan['avgCompletionTokens']) * 30}
ENV API_MONTHLY_CALL_BUDGET={plan['dailyApiCalls'] * 30}
ENV TARGET_LATENCY_MS={plan['estimatedLatencyMs']}

EXPOSE 8080
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]
"""


def fmt_num(value: float) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1000:
        return f"{value / 1000:.1f}K"
    return str(round(value))


def fmt_money(value: float) -> str:
    return "$" + f"{round(value):,}"


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))

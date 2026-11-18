/**
 * Cloudflare Worker —— GitHub Actions 定时触发器（多目标版）
 *
 * 作用：Cloudflare Cron（准时）→ 调用 GitHub workflow_dispatch → 触发一个或多个仓库的工作流。
 * GitHub 自带的 schedule 事件会延迟 5-30 分钟，这里用外部调度器解决"推送不准时"。
 *
 * 支持多目标：通过 wrangler.toml 里的 TARGETS（JSON 数组）配置要触发的仓库列表，
 * 每个目标可独立指定触发的 cron 表达式。未配置 TARGETS 时回退到旧的单目标行为
 * （GITHUB_OWNER / GITHUB_REPO / WORKFLOW_FILE / GITHUB_REF）。
 *
 * 暴露端点：
 *   GET  /         存活探针（纯文本），确认 Worker 在跑
 *   GET  /health   诊断端点：环境变量检查 + 只读校验每个目标的 Token / 工作流 / 最近运行记录
 *                  （不会触发工作流，可放心反复访问）
 *   POST /trigger  手动触发一次（需 TRIGGER_TOKEN 保护），?target=<name> 可只触发某个目标
 *
 * 触发链路的每一步都会打结构化日志，Dashboard → lianhua → Logs 可见。
 */

const GH_API = "https://api.github.com";
const GH_API_VERSION = "2022-11-28";
const USER_AGENT = "lianghua-cloudflare-scheduler";

// 单目标回退时的历史默认 cron（保持 lianghua 原有行为）
const DEFAULT_CRONS = ["45 4 * * mon-fri", "15 9 * * mon-fri"];

// ─────────────────────────────────────────────────────────────
//  基础工具
// ─────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " +08:00";
}

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: ts(), level, msg, ...extra }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// 常量时间比较，避免 /trigger 的 token 被计时攻击
function safeEqual(a, b) {
  const s1 = String(a ?? "");
  const s2 = String(b ?? "");
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i += 1) {
    diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  }
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────
//  目标解析
// ─────────────────────────────────────────────────────────────

/**
 * 把 env 里的配置解析成目标列表。
 * 优先用 TARGETS（JSON 数组）；解析失败或为空时回退到单目标（GITHUB_OWNER 等）。
 * 每个目标：{ name, owner, repo, workflow, ref, inputs?, crons? }
 */
function resolveTargets(env) {
  if (env.TARGETS) {
    try {
      const parsed = JSON.parse(env.TARGETS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((t) => ({
          name: t.name || `${t.owner}/${t.repo}`,
          owner: t.owner,
          repo: t.repo,
          workflow: t.workflow || "daily_push.yml",
          ref: t.ref || "main",
          inputs: t.inputs && Object.keys(t.inputs).length > 0 ? t.inputs : undefined,
          crons: Array.isArray(t.crons) && t.crons.length > 0 ? t.crons : null,
        }));
      }
    } catch (e) {
      log("error", "TARGETS 解析失败，回退到单目标配置", { error: e.message });
    }
  }

  // 单目标回退（保持旧行为）
  return [
    {
      name: "default",
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      workflow: env.WORKFLOW_FILE || "daily_push.yml",
      ref: env.GITHUB_REF || "main",
      inputs: undefined,
      crons: DEFAULT_CRONS,
    },
  ];
}

// 缺任何一个关键项都会导致 dispatch 失败，/health 会点名
function missingVars(env) {
  const problems = [];
  if (!env.GH_TOKEN || String(env.GH_TOKEN).trim() === "") {
    problems.push("GH_TOKEN");
  }
  const targets = resolveTargets(env);
  for (const t of targets) {
    if (!t.owner) problems.push(`${t.name}.owner`);
    if (!t.repo) problems.push(`${t.name}.repo`);
  }
  return [...new Set(problems)];
}

function ghHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GH_API_VERSION,
    "User-Agent": USER_AGENT,
    ...extra,
  };
}

function targetSlug(t) {
  return `${t.owner}/${t.repo}`;
}

// 取 cron 的「时:分」（前两个字段），用于兜底匹配
function cronTimeKey(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  return `${parts[0]} ${parts[1]}`;
}

// 当前 cron 是否命中该目标（crons 为 null 表示匹配所有 cron）
//
// 先按字符串精确匹配；不一致时再比「时:分」。
// 为什么要有兜底：Cloudflare 的星期字段 1=周日（不是周一），把 `1-5`
// 当成工作日就会变成「周日~周四」，周五整天不触发；反过来如果只在
// wrangler.toml 改成 `mon-fri` 而没改 TARGETS，字符串匹配就会全部落空，
// 表现为「cron 到了但谁也没触发」的静默失败。按时刻兜底可以保证即使
// 两处写法不同（1-5 / mon-fri / Cloudflare 归一化后的形式），到点仍然发。
function targetMatchesCron(t, cron) {
  if (!t.crons) return true;
  if (t.crons.includes(cron)) return true;
  const key = cronTimeKey(cron);
  return key !== null && t.crons.some((c) => cronTimeKey(c) === key);
}

// ─────────────────────────────────────────────────────────────
//  GitHub 调用
// ─────────────────────────────────────────────────────────────

/**
 * 触发某个目标的 workflow_dispatch。
 * 成功返回 204（部分 API 版本返回 200），失败抛出带 status / body 的错误。
 */
async function dispatchWorkflow(target, env, inputs) {
  const url = `${GH_API}/repos/${targetSlug(target)}/actions/workflows/${target.workflow}/dispatches`;

  const payload = { ref: target.ref };
  // 只有显式指定时才带 inputs，否则沿用工作流文件里的默认值（避免输入项改名后 422）
  if (inputs && Object.keys(inputs).length > 0) payload.inputs = inputs;

  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  const elapsed = Date.now() - started;

  if (!response.ok) {
    const error = new Error(`GitHub dispatch failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return {
    status: response.status,
    elapsed_ms: elapsed,
    target: target.name,
    repo: targetSlug(target),
    workflow: target.workflow,
    ref: target.ref,
  };
}

/**
 * 只读诊断某个目标：Token 是否有效、工作流是否存在、最近几次运行是什么事件触发的。
 * 不产生任何副作用。
 */
async function describeGithub(target, env) {
  const result = { name: target.name, repo: targetSlug(target), workflow: target.workflow };

  // 1) Token 有效性
  try {
    const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(env) });
    result.token = { ok: res.ok, status: res.status };
    if (res.ok) {
      const body = await res.json();
      result.token.login = body.login;
    } else {
      result.token.error = (await res.text()).slice(0, 300);
    }
  } catch (err) {
    result.token = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  // 2) 工作流是否存在（文件必须在默认分支上）
  try {
    const res = await fetch(
      `${GH_API}/repos/${targetSlug(target)}/actions/workflows/${target.workflow}`,
      { headers: ghHeaders(env) },
    );
    result.workflow_ok = res.ok;
    result.workflow_status = res.status;
    if (res.ok) {
      const body = await res.json();
      result.workflow_name = body.name;
      result.workflow_state = body.state;
    } else {
      result.workflow_error = (await res.text()).slice(0, 300);
    }
  } catch (err) {
    result.workflow_ok = false;
    result.workflow_error = String(err && err.message ? err.message : err);
  }

  // 3) 最近运行：event=workflow_dispatch 说明 Cloudflare 触发成功，
  //    event=schedule 说明是 GitHub 自己的定时任务（可能延迟）
  try {
    const res = await fetch(
      `${GH_API}/repos/${targetSlug(target)}/actions/workflows/${target.workflow}/runs?per_page=5`,
      { headers: ghHeaders(env) },
    );
    result.recent_runs = { ok: res.ok, status: res.status };
    if (res.ok) {
      const body = await res.json();
      result.recent_runs.items = (body.workflow_runs || []).map((run) => ({
        id: run.id,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
      }));
    } else {
      result.recent_runs.error = (await res.text()).slice(0, 300);
    }
  } catch (err) {
    result.recent_runs = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
//  单个目标的调度（带重试）
// ─────────────────────────────────────────────────────────────

async function dispatchTarget(target, env, cron) {
  try {
    const dispatched = await dispatchWorkflow(target, env);
    log("info", "workflow dispatched", { cron, target: target.name, ...dispatched });
    return { ok: true, ...dispatched };
  } catch (err) {
    // 网络抖动 / GitHub 5xx：重试一次；4xx 属于配置或权限问题，重试没有意义
    const status = err && err.status;
    if (!status || status >= 500) {
      log("warn", "dispatch failed, retrying in 5s", {
        cron,
        target: target.name,
        status: status ?? null,
        error: err.message,
      });
      await sleep(5000);
      try {
        const dispatched = await dispatchWorkflow(target, env);
        log("info", "workflow dispatched on retry", { cron, target: target.name, ...dispatched });
        return { ok: true, ...dispatched };
      } catch (retryErr) {
        log("error", "dispatch failed after retry", {
          cron,
          target: target.name,
          status: retryErr.status ?? null,
          error: retryErr.message,
        });
        throw retryErr;
      }
    }
    log("error", "dispatch failed", { cron, target: target.name, status: status ?? null, error: err.message });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
//  事件处理器
// ─────────────────────────────────────────────────────────────

export default {
  async scheduled(controller, env) {
    const cron = (controller && controller.cron) || "unknown";
    log("info", "cron fired", { cron, utc: ts(), beijing: beijingNow() });

    const missing = missingVars(env);
    if (missing.length > 0) {
      log("error", "config error: missing env vars", { cron, missing });
      throw new Error(`missing environment variables: ${missing.join(", ")}`);
    }

    const targets = resolveTargets(env);
    const due = targets.filter((t) => targetMatchesCron(t, cron));

    if (due.length === 0) {
      log("warn", "cron fired but no target scheduled for it", {
        cron,
        targets: targets.map((t) => t.name),
      });
      return;
    }

    let lastErr = null;
    for (const t of due) {
      try {
        await dispatchTarget(t, env, cron);
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // 存活探针
    if (path === "/") {
      return new Response("lianghua scheduler is running\n", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // 诊断端点：只读，不触发任何工作流
    if (path === "/health") {
      const missing = missingVars(env);
      const targets = resolveTargets(env);
      const targetStatus =
        missing.length === 0 ? await Promise.all(targets.map((t) => describeGithub(t, env))) : [];
      const payload = {
        ok: missing.length === 0,
        mode: env.TARGETS ? "multi-target" : "single-target",
        checked_at: ts(),
        beijing: beijingNow(),
        env: {
          GH_TOKEN: env.GH_TOKEN ? `set(len=${env.GH_TOKEN.length})` : null,
          TRIGGER_TOKEN: env.TRIGGER_TOKEN ? "set" : null,
          targets: targets.map((t) => ({
            name: t.name,
            owner: t.owner || null,
            repo: t.repo || null,
            workflow: t.workflow,
            ref: t.ref,
            crons: t.crons,
          })),
        },
        missing,
        targets: targetStatus,
      };
      return json(payload, payload.ok ? 200 : 500);
    }

    // 手动触发：用来立刻验证 Cloudflare → GitHub 的整条链路
    if (path === "/trigger") {
      if (!env.TRIGGER_TOKEN) {
        return json({ ok: false, error: "TRIGGER_TOKEN not configured; /trigger is disabled" }, 403);
      }
      const provided = url.searchParams.get("token") || request.headers.get("x-trigger-token") || "";
      if (!safeEqual(provided, env.TRIGGER_TOKEN)) {
        return json({ ok: false, error: "invalid token" }, 401);
      }
      const missing = missingVars(env);
      if (missing.length > 0) {
        return json({ ok: false, error: `missing env vars: ${missing.join(", ")}` }, 500);
      }

      const targets = resolveTargets(env);
      const want = url.searchParams.get("target");
      let chosen = targets;
      if (want) {
        chosen = targets.filter(
          (t) => t.name === want || t.repo === want || targetSlug(t) === want,
        );
        if (chosen.length === 0) {
          return json(
            { ok: false, error: `no target matches '${want}'`, available: targets.map((t) => t.name) },
            404,
          );
        }
      }

      const dryRun = url.searchParams.get("dry_run") === "true";
      const results = [];
      let anyFail = false;
      for (const t of chosen) {
        try {
          const dispatched = await dispatchWorkflow(t, env, dryRun ? { dry_run: "true" } : undefined);
          results.push({ target: t.name, ok: true, ...dispatched });
        } catch (err) {
          anyFail = true;
          results.push({ target: t.name, ok: false, error: err.message, status: err.status ?? null });
        }
      }
      log("info", "manual trigger", { targets: results.map((r) => r.target), dry_run: dryRun });
      return json({ ok: !anyFail, results, dry_run: dryRun, checked_at: ts() }, anyFail ? 502 : 200);
    }

    return json({ ok: false, error: "not found", paths: ["/", "/health", "/trigger"] }, 404);
  },
};

/**
 * Worker 冒烟测试（零依赖，Node 内置 test runner）
 *
 *   cd deploy/cloudflare-scheduler && npm test
 *
 * 覆盖：存活探针、/health 诊断（多目标）、/trigger 鉴权与触发（含单目标/全量）、
 * cron 触发（按目标匹配）、缺变量报错、GitHub 5xx 重试。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;

function mockGithub({ dispatchStatus = 204 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const u = String(url);
    if (u.endsWith("/dispatches")) {
      // 204 是 null-body 状态码，不能带 body
      return dispatchStatus === 204
        ? new Response(null, { status: 204 })
        : new Response("boom", { status: dispatchStatus });
    }
    if (u.endsWith("/user")) {
      return Response.json({ login: "octocat" });
    }
    if (u.includes("/actions/workflows/") && u.includes("/runs")) {
      return Response.json({
        workflow_runs: [
          { id: 1, event: "workflow_dispatch", status: "completed", conclusion: "success", created_at: "2026-10-21T05:15:00Z" },
        ],
      });
    }
    if (u.includes("/actions/workflows/")) {
      return Response.json({ id: 9, name: "Daily Push", state: "active" });
    }
    return new Response("not found", { status: 404 });
  };
  return calls;
}

// 线上真实配置：两个目标共用同样两条 cron（Free 计划 5 条额度已满，不能新增）
//   45 4 UTC = 12:45 北京时间（午间休市）
//   15 9 UTC = 17:15 北京时间（盘后）
const TARGETS = JSON.stringify([
  { name: "lianghua", owner: "xihaoxiao", repo: "lianghua", workflow: "daily_push.yml", ref: "main", crons: ["45 4 * * mon-fri", "15 9 * * mon-fri"] },
  { name: "ashares", owner: "xihaoxiao", repo: "D-project-action", workflow: "daily.yml", ref: "main", crons: ["45 4 * * mon-fri", "15 9 * * mon-fri"] },
]);

const ENV = {
  GH_TOKEN: "ghp_test_token",
  TARGETS,
  TRIGGER_TOKEN: "s3cret",
};

const dispatches = (calls) => calls.filter((c) => c.url.endsWith("/dispatches"));
const findTarget = (targets, name) => targets.find((t) => t.name === name);

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("GET / 返回存活文本", async () => {
  globalThis.fetch = async () => {
    throw new Error("不应该发起网络请求");
  };
  const res = await worker.fetch(new Request("https://x.workers.dev/"), ENV);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /lianghua scheduler is running/);
});

test("GET /health 汇报多目标与 GitHub 连通性", async () => {
  mockGithub();
  const res = await worker.fetch(new Request("https://x.workers.dev/health"), ENV);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "multi-target");
  assert.equal(body.env.targets.length, 2);
  // body.env.targets 是配置（repo 为纯仓库名）
  const lhCfg = findTarget(body.env.targets, "lianghua");
  assert.ok(lhCfg, "应包含 lianghua 配置");
  assert.equal(lhCfg.repo, "lianghua");
  const asCfg = findTarget(body.env.targets, "ashares");
  assert.equal(asCfg.repo, "D-project-action");
  // body.targets 是 GitHub 诊断结果（repo 为 owner/repo 全名）
  const ghLh = findTarget(body.targets, "lianghua");
  assert.ok(ghLh, "应包含 lianghua 诊断");
  assert.equal(ghLh.repo, "xihaoxiao/lianghua");
  assert.equal(ghLh.token.ok, true);
  assert.equal(ghLh.token.login, "octocat");
});

test("GET /health 点名缺失的变量", async () => {
  globalThis.fetch = async () => {
    throw new Error("不应该发起网络请求");
  };
  const res = await worker.fetch(new Request("https://x.workers.dev/health"), { ...ENV, GH_TOKEN: "" });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.missing, ["GH_TOKEN"]);
});

test("POST /trigger 拒绝错误 token", async () => {
  globalThis.fetch = async () => {
    throw new Error("不应该发起网络请求");
  };
  const res = await worker.fetch(new Request("https://x.workers.dev/trigger?token=wrong"), ENV);
  assert.equal(res.status, 401);
});

test("POST /trigger ?target=lianghua 只触发 lianghua", async () => {
  const calls = mockGithub();
  const res = await worker.fetch(
    new Request("https://x.workers.dev/trigger?token=s3cret&target=lianghua", { method: "POST" }),
    ENV,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].target, "lianghua");
  const ds = dispatches(calls);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].url, "https://api.github.com/repos/xihaoxiao/lianghua/actions/workflows/daily_push.yml/dispatches");
});

test("POST /trigger 不带 target 触发全部目标", async () => {
  const calls = mockGithub();
  const res = await worker.fetch(
    new Request("https://x.workers.dev/trigger?token=s3cret", { method: "POST" }),
    ENV,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.results.length, 2);
  const ds = dispatches(calls);
  assert.equal(ds.length, 2);
});

test("POST /trigger 未知 target 返回 404", async () => {
  globalThis.fetch = async () => {
    throw new Error("不应该发起网络请求");
  };
  const res = await worker.fetch(
    new Request("https://x.workers.dev/trigger?token=s3cret&target=nope", { method: "POST" }),
    ENV,
  );
  assert.equal(res.status, 404);
});

test("POST /trigger 把 GitHub 错误透出", async () => {
  mockGithub({ dispatchStatus: 403 });
  const res = await worker.fetch(
    new Request("https://x.workers.dev/trigger?token=s3cret&target=lianghua", { method: "POST" }),
    ENV,
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.results[0].error, /HTTP 403/);
});

test("scheduled 午间 / 盘后两条 cron 都触发两个目标", async () => {
  // 12:45 北京时间（午间休市）
  const calls = mockGithub();
  await worker.scheduled({ cron: "45 4 * * mon-fri" }, ENV);
  let ds = dispatches(calls);
  assert.equal(ds.length, 2);
  assert.ok(ds.some((c) => c.url.includes("/xihaoxiao/lianghua/")), "午间应触发 lianghua");
  assert.ok(ds.some((c) => c.url.includes("/xihaoxiao/D-project-action/")), "午间应触发 ashares");

  // 17:15 北京时间（盘后）
  globalThis.fetch = realFetch;
  const calls2 = mockGithub();
  await worker.scheduled({ cron: "15 9 * * mon-fri" }, ENV);
  ds = dispatches(calls2);
  assert.equal(ds.length, 2);
  assert.ok(ds.some((c) => c.url.includes("/xihaoxiao/lianghua/")), "盘后应触发 lianghua");
  assert.ok(ds.some((c) => c.url.includes("/xihaoxiao/D-project-action/")), "盘后应触发 ashares");

  // 已经不再使用的旧时刻（13:15）不应再误触发
  globalThis.fetch = realFetch;
  const calls3 = mockGithub();
  await worker.scheduled({ cron: "15 5 * * mon-fri" }, ENV);
  assert.equal(dispatches(calls3).length, 0);
});

test("cron 星期写法不一致时按「时:分」兜底触发", async () => {
  // 背景：Cloudflare 的星期字段 1=周日（不是周一），所以 `1-5` 实际是周日~周四。
  // 若 wrangler.toml 改成 `mon-fri` 而 TARGETS 仍是 `1-5`（或反过来），
  // 字符串匹配会全部落空 →「cron 到了但谁也没触发」的静默失败。
  // 这里保证两处写法不同时，到点仍然发得出去。
  const mismatchEnv = {
    ...ENV,
    TARGETS: JSON.stringify([
      { name: "lianghua", owner: "xihaoxiao", repo: "lianghua", workflow: "daily_push.yml", ref: "main", crons: ["45 4 * * 1-5", "15 9 * * 1-5"] },
      { name: "ashares", owner: "xihaoxiao", repo: "D-project-action", workflow: "daily.yml", ref: "main", crons: ["45 4 * * 1-5", "15 9 * * 1-5"] },
    ]),
  };
  const calls = mockGithub();
  // TARGETS 里是 "15 9 * * 1-5"，实际触发写成 mon-fri
  await worker.scheduled({ cron: "15 9 * * mon-fri" }, mismatchEnv);
  let ds = dispatches(calls);
  assert.equal(ds.length, 2);
  assert.ok(ds.some((c) => c.url.includes("/xihaoxiao/lianghua/")));

  // 午间那条同样要兜底命中
  globalThis.fetch = realFetch;
  const calls2 = mockGithub();
  await worker.scheduled({ cron: "45 4 * * mon-fri" }, mismatchEnv);
  ds = dispatches(calls2);
  assert.equal(ds.length, 2);

  // 时刻不同则不应误触发
  globalThis.fetch = realFetch;
  const calls3 = mockGithub();
  await worker.scheduled({ cron: "30 9 * * mon-fri" }, mismatchEnv);
  assert.equal(dispatches(calls3).length, 0);
});

test("scheduled 缺变量时抛出明确错误", async () => {
  globalThis.fetch = async () => {
    throw new Error("不应该发起网络请求");
  };
  await assert.rejects(
    () => worker.scheduled({ cron: "45 4 * * mon-fri" }, { ...ENV, GH_TOKEN: "" }),
    /missing environment variables: GH_TOKEN/,
  );
});

test("scheduled 遇到 5xx 会重试一次再报错", async () => {
  let dispatchCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/dispatches")) {
      dispatchCalls += 1;
      return new Response("boom", { status: 502 });
    }
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(() => worker.scheduled({ cron: "45 4 * * mon-fri" }, ENV), /HTTP 502/);
  // 两个目标都命中该 cron，每个各重试一次 → 2 个目标 × 2 次 = 4
  assert.equal(dispatchCalls, 4);
});

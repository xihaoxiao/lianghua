async function dispatchWorkflow(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lianghua-cloudflare-scheduler",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main" }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${body}`);
  }
}

export default {
  async scheduled(controller, env) {
    console.log(`cron fired: ${controller.cron}`);
    await dispatchWorkflow(env);
    console.log("GitHub workflow dispatched");
  },

  async fetch() {
    return new Response("lianghua scheduler is running\n", { status: 200 });
  },
};

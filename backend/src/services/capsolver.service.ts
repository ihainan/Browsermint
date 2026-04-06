const CAPSOLVER_API = "https://api.capsolver.com";
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 120_000;

interface CreateTaskResponse {
  errorId: number;
  errorDescription?: string;
  taskId?: string;
}

interface GetTaskResultResponse {
  errorId: number;
  errorDescription?: string;
  status?: string;
  solution?: { gRecaptchaResponse: string };
}

export interface SolveResult {
  token: string;
  taskId: string;
}

export async function solveRecaptchaEnterprise(
  siteKey: string,
  pageURL: string,
  action: string,
  apiKey: string,
  userAgent?: string
): Promise<SolveResult> {
  // Strip JS challenge query params (solution=, js_challenge=, token=) so
  // capsolver receives a clean origin URL. Those params are ephemeral and are
  // not part of the reCAPTCHA Enterprise site registration.
  let cleanURL = pageURL;
  try {
    const u = new URL(pageURL);
    u.searchParams.delete("solution");
    u.searchParams.delete("js_challenge");
    u.searchParams.delete("token");
    cleanURL = u.toString();
  } catch { /* keep original if URL is malformed */ }

  const task: Record<string, unknown> = {
    type: "ReCaptchaV3EnterpriseTaskProxyless",
    websiteURL: cleanURL,
    websiteKey: siteKey,
    pageAction: action || "login",
    minScore: 0.9,
  };
  if (userAgent) task.userAgent = userAgent;

  const createResp = await fetch(`${CAPSOLVER_API}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
  });

  const createData = (await createResp.json()) as CreateTaskResponse;
  if (createData.errorId !== 0) {
    throw new Error(`CapSolver createTask failed: ${createData.errorDescription}`);
  }

  const taskId = createData.taskId!;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const resultResp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    const resultData = (await resultResp.json()) as GetTaskResultResponse;
    if (resultData.errorId !== 0) {
      throw new Error(`CapSolver getTaskResult failed: ${resultData.errorDescription}`);
    }

    if (resultData.status === "ready") {
      return { token: resultData.solution!.gRecaptchaResponse, taskId };
    }
  }

  throw new Error("CapSolver timed out after 120s");
}

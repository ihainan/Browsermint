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

export async function solveRecaptchaEnterprise(
  siteKey: string,
  pageURL: string,
  action: string,
  apiKey: string
): Promise<string> {
  const createResp = await fetch(`${CAPSOLVER_API}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: "ReCaptchaV3EnterpriseTaskProxyless",
        websiteURL: pageURL,
        websiteKey: siteKey,
        pageAction: action || "login",
        minScore: 0.7,
      },
    }),
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
      return resultData.solution!.gRecaptchaResponse;
    }
  }

  throw new Error("CapSolver timed out after 120s");
}

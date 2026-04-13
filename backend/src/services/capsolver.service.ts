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
  solution?: Record<string, unknown>;
}

export interface SolveResult {
  token: string;
  taskId: string;
}

export type CaptchaType = "recaptcha-enterprise" | "recaptcha-v2" | "recaptcha-v2-enterprise" | "recaptcha-v3" | "turnstile" | "hcaptcha";

function stripChallengeParams(pageURL: string): string {
  try {
    const u = new URL(pageURL);
    u.searchParams.delete("solution");
    u.searchParams.delete("js_challenge");
    u.searchParams.delete("token");
    return u.toString();
  } catch {
    return pageURL;
  }
}

async function createTask(task: Record<string, unknown>, apiKey: string): Promise<string> {
  const resp = await fetch(`${CAPSOLVER_API}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
  });
  const data = (await resp.json()) as CreateTaskResponse;
  if (data.errorId !== 0) {
    throw new Error(`CapSolver createTask failed: ${data.errorDescription}`);
  }
  return data.taskId!;
}

async function pollTaskResult(taskId: string, apiKey: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const resp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const data = (await resp.json()) as GetTaskResultResponse;
    if (data.errorId !== 0) {
      throw new Error(`CapSolver getTaskResult failed: ${data.errorDescription}`);
    }
    if (data.status === "ready") return data.solution!;
  }
  throw new Error("CapSolver timed out after 120s");
}

export async function solveCaptcha(
  type: CaptchaType,
  siteKey: string,
  pageURL: string,
  action: string,
  apiKey: string,
  userAgent?: string,
  enterprisePayload?: Record<string, string>
): Promise<SolveResult> {
  const cleanURL = stripChallengeParams(pageURL);

  let task: Record<string, unknown>;
  let extractToken: (solution: Record<string, unknown>) => string;

  switch (type) {
    case "recaptcha-v2":
      task = {
        type: "ReCaptchaV2TaskProxyless",
        websiteURL: cleanURL,
        websiteKey: siteKey,
        ...(userAgent ? { userAgent } : {}),
      };
      extractToken = (s) => s.gRecaptchaResponse as string;
      break;

    case "recaptcha-v2-enterprise":
      task = {
        type: "ReCaptchaV2EnterpriseTaskProxyless",
        websiteURL: cleanURL,
        websiteKey: siteKey,
        ...(enterprisePayload && Object.keys(enterprisePayload).length > 0 ? { enterprisePayload } : {}),
        ...(userAgent ? { userAgent } : {}),
      };
      extractToken = (s) => s.gRecaptchaResponse as string;
      break;

    case "recaptcha-enterprise":
      task = {
        type: "ReCaptchaV3EnterpriseTaskProxyless",
        websiteURL: cleanURL,
        websiteKey: siteKey,
        pageAction: action || "login",
        minScore: 0.9,
        ...(userAgent ? { userAgent } : {}),
      };
      extractToken = (s) => s.gRecaptchaResponse as string;
      break;

    case "recaptcha-v3":
      task = {
        type: "ReCaptchaV3TaskProxyless",
        websiteURL: cleanURL,
        websiteKey: siteKey,
        pageAction: action || "homepage",
        minScore: 0.7,
        ...(userAgent ? { userAgent } : {}),
      };
      extractToken = (s) => s.gRecaptchaResponse as string;
      break;

    case "turnstile":
      task = {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: cleanURL,
        websiteKey: siteKey,
        ...(userAgent ? { userAgent } : {}),
      };
      extractToken = (s) => s.token as string;
      break;

    case "hcaptcha":
      task = {
        type: "HCaptchaTaskProxyless",
        websiteURL: cleanURL,
        websiteKey: siteKey,
        ...(userAgent ? { userAgent } : {}),
      };
      extractToken = (s) => s.gRecaptchaResponse as string;
      break;

    default:
      throw new Error(`Unknown captcha type: ${type}`);
  }

  const taskId = await createTask(task, apiKey);
  const solution = await pollTaskResult(taskId, apiKey);
  return { token: extractToken(solution), taskId };
}

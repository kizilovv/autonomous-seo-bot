// Retry only responses that explicitly confirm zero spend. A transport timeout
// after a paid POST has an unknown outcome and must not be replayed blindly.
export interface DfsEnvelope {
  status_code: number;
  status_message: string;
  cost: number;
  tasks?: Array<{ status_code: number; status_message: string; cost: number; result?: any }>;
}
interface RetryDeps {
  request: () => Promise<Response>;
  beforeAttempt: () => void;
  recordSpend: (cost: number) => void;
  onRetry: (info: { attempt: number; delayMs: number; http: number; codes: number[] }) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}
const TRANSIENT = new Set([40202, 40209, 50000, 50001, 50301, 50302, 50303, 50304, 50401]);
const HTTP_TRANSIENT = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 30_000;

export async function requestWithRetry(deps: RetryDeps): Promise<DfsEnvelope> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  let waited = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    deps.beforeAttempt(); // Budget guards run again after each backoff.
    let res: Response;
    let raw: unknown;
    try {
      res = await deps.request();
      raw = await res.json();
    } catch {
      throw new Error(`DataForSEO transport/invalid-response error on attempt ${attempt}; charge unknown, not replayed`);
    }
    const json = raw as DfsEnvelope;
    const tasks = Array.isArray(json?.tasks) ? json.tasks : [];
    const validCosts = typeof json?.cost === 'number' && Number.isFinite(json.cost) && json.cost >= 0 &&
      tasks.every(t => t && typeof t.cost === 'number' && Number.isFinite(t.cost) && t.cost >= 0);
    // Do not ignore costs on HTTP errors. Task costs can be more informative
    // than a broken top-level envelope; never count both copies twice.
    const topCost = typeof json?.cost === 'number' && Number.isFinite(json.cost) && json.cost > 0 ? json.cost : 0;
    const taskCost = tasks.reduce((sum,t) => sum + (typeof t?.cost === 'number' && Number.isFinite(t.cost) && t.cost > 0 ? t.cost : 0),0);
    const cost = Math.max(topCost, taskCost);
    if (cost > 0) deps.recordSpend(cost);
    const valid = json && typeof json.status_code === 'number' && tasks.length === 1 &&
      tasks.every(t => t && typeof t.status_code === 'number') && validCosts;
    if (!valid) throw new Error(`DataForSEO invalid envelope on attempt ${attempt}; not replayed`);
    const codes = [json.status_code, ...tasks.map(t => t.status_code)];
    const failed = codes.filter(code => code !== 20000);
    if (res.ok && failed.length === 0) return { ...json, cost };
    const error = `DataForSEO HTTP ${res.status}, codes ${codes.join('/')}, attempt ${attempt}/${MAX_ATTEMPTS}`;
    // Successful tasks must not be replayed even if HTTP status is erroneous.
    const retryable = cost === 0 && tasks.every(t => TRANSIENT.has(t.status_code)) &&
      failed.every(code => TRANSIENT.has(code)) && (res.ok || HTTP_TRANSIENT.has(res.status));
    if (!retryable || attempt === MAX_ATTEMPTS) throw new Error(error);
    let delayMs = [2000, 5000][attempt - 1] + Math.floor((deps.random ?? Math.random)() * 500);
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const seconds = /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
      const required = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
      if (Number.isFinite(required)) delayMs = Math.max(delayMs, required);
    }
    if (waited + delayMs > MAX_WAIT_MS) throw new Error(`${error}; Retry-After exceeds retry wait budget`);
    deps.onRetry({ attempt, delayMs, http: res.status, codes });
    await sleep(delayMs);
    waited += delayMs;
  }
  throw new Error('DataForSEO retries exhausted');
}

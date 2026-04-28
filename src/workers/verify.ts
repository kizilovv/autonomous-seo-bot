import { runVerify as runInner } from "../verify/verifier.js";
import { startRun, finishRun, failRun } from "../db/repo.js";

export async function runVerify() {
  const id = startRun("verify");
  try {
    const stats = await runInner();
    finishRun(id, stats);
    return stats;
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}

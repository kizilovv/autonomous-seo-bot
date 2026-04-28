// Apply opportunities — dispatch through risk gate.
import { runApply as runInner } from "../apply/applier.js";
import { startRun, finishRun, failRun } from "../db/repo.js";

export async function runApply() {
  const id = startRun("apply");
  try {
    const stats = await runInner();
    finishRun(id, stats);
    return stats;
  } catch (e) {
    failRun(id, (e as Error).message);
    throw e;
  }
}

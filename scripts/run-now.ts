// Manual one-shot trigger for any worker — for first-time bootstrap and ad-hoc reruns.
//
//   tsx scripts/run-now.ts pull
//   tsx scripts/run-now.ts analyze
//   tsx scripts/run-now.ts generate
//   tsx scripts/run-now.ts apply
//   tsx scripts/run-now.ts daily-report
//   tsx scripts/run-now.ts verify
//   tsx scripts/run-now.ts full         # pull → analyze → generate → daily-report
import { runPull } from "../src/workers/pull.js";
import { runAnalyze } from "../src/workers/analyze.js";
import { runGenerate } from "../src/workers/generate.js";
import { runApply } from "../src/workers/apply.js";
import { runVerify } from "../src/workers/verify.js";
import { runDailyReport } from "../src/workers/daily-report.js";
import { runBlogGenerator } from "../src/workers/blog-generator.js";
import { closeDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";

async function main() {
  const target = (process.argv[2] || "").trim();
  runMigrations();
  switch (target) {
    case "pull":         console.log(await runPull()); break;
    case "analyze":      console.log(await runAnalyze()); break;
    case "generate":     console.log(await runGenerate()); break;
    case "apply":        console.log(await runApply()); break;
    case "verify":       console.log(await runVerify()); break;
    case "daily-report": console.log(await runDailyReport()); break;
    case "blog":         console.log(await runBlogGenerator()); break;
    case "full":
      console.log("== pull ==");        console.log(await runPull());
      console.log("== analyze ==");     console.log(await runAnalyze());
      console.log("== generate ==");    console.log(await runGenerate());
      console.log("== apply ==");       console.log(await runApply());
      console.log("== blog ==");        console.log(await runBlogGenerator());
      console.log("== daily-report =="); console.log(await runDailyReport());
      break;
    default:
      console.error("usage: tsx scripts/run-now.ts <pull|analyze|generate|apply|verify|daily-report|full>");
      process.exit(2);
  }
  closeDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

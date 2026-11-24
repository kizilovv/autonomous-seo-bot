import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cmsWriteBlockReason } from "../src/quality/cms-surface.js";

test("blog metadata needs a verified brief when the slug or query describes payouts", () => {
  assert.ok(cmsWriteBlockReason("/blog/csfade-withdraw-how-to-cash-out-cs2-skins-instantly-2026-guide", "description", "mycs2 withdraw"));
  assert.ok(cmsWriteBlockReason("/blog/2-2026", "title", "вывод на карту"));
  assert.ok(cmsWriteBlockReason("/blog/caseway-withdrawal-guide", "description", null));
  assert.equal(cmsWriteBlockReason("/blog/buy-butterfly-knife", "description", "купить нож бабочку"), null);
  assert.equal(cmsWriteBlockReason("/sell", "description", "продать скины с выводом"), null);
  assert.equal(cmsWriteBlockReason("/blog/cash-out", null, "cash out"), null);
});

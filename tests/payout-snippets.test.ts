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

test("the buy catalogue snippet can only be rewritten for catalogue-wide intent", () => {
  assert.ok(cmsWriteBlockReason("/buy", "description", "crab rave cs2 купить"));
  assert.ok(cmsWriteBlockReason("/buy/", "title", "buy ak-47 redline"));
  assert.ok(cmsWriteBlockReason("/buy", "title", "sell cs2 skins"));
  assert.equal(cmsWriteBlockReason("/buy", "description", "купить скины кс 2"), null);
  assert.equal(cmsWriteBlockReason("/buy", "title", "buy cs2 skins"), null);
  assert.equal(cmsWriteBlockReason("/buy", null, "crab rave cs2 купить"), null);
  assert.equal(cmsWriteBlockReason("/weapons/ak-47", "description", "buy ak-47 redline"), null);
});

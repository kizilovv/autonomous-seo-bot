import { mentionsCompetitor } from "./brand-guard.js";
// Owner-confirmed product facts, 2026-10-06. These are distinct transaction flows.
export const COMMERCIAL_FACTS = `
CSBoard fees: deposits 0%; P2P sales for money have a base fee of 2%; item-for-item P2P trades 0% because no money changes hands.
Active Premium discounts may reduce the effective P2P sales fee; describe the base 2% and conditional discount, never invent a fixed Premium rate.
Never describe all CSBoard trading, selling or P2P transactions as zero-fee or commission-free.
When mentioning a 0% fee, explicitly identify deposits or item-for-item exchange in the same sentence.
Do not infer instant-sell pricing, withdrawal charges or network fees from these three rates.
CSBoard's operator is Nextrade Labs. Transtrade (also spelled Transtreid / Транстрейд) is a payment processor, not the platform operator.
Only mention these entities when relevant; never replace an unknown legal registered name/address with a guess.
`.trim();

/** Conservative publishing guard, not a calculator. Unsupported claims require review. */
export function commercialClaimViolation(value: string, context: "csboard" | "editorial" = "csboard"): string | null {
  const text = value.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '; ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').replace(/(\d),(\d)/g, '$1.$2');
  const clauses = text.split(/[!?;,\n]|\.(?=\s|$)|\\n/).map(s => s.toLowerCase().replace(/[-‑–]/g, " "));
  for (const clause of clauses) {
    // Only explicit third-party attribution is exempt in neutral articles.
    // Mixed-brand, implicit and universal claims remain subject to our guard.
    if (context === "editorial" && mentionsCompetitor(clause) && !/cs\s?board|ксборд|кс\s+боард|\b(?:we|our|all|every)\b|(?:^|\s)(?:все|каждый|каждая|мы|наш[а-яё]*)(?:\s|$)/iu.test(clause)) continue;
    const explicitZeroFee = /(?:zero|no|0(?:[.,]0+)?\s*%|нулев[а-яё]*|без)\s*(?:[\wа-яё-]+\s+){0,3}(?:fees?|commission|комисси[а-яё]*)|(?:fee|commission|комисси[а-яё]*)[^,;]{0,20}\b0(?:[.,]0+)?\s*%|(?:fee|commission)[ -]free/iu.test(clause);
    const semanticZeroFee = /(?:нет|никаких)\s+(?:[а-яё]+\s+){0,3}комисси[а-яё]*|комисси[а-яё]*(?:\s+[а-яё]+){0,5}\s+отсутству[а-яё]*|(?:eliminat\w*|remov\w*|waiv\w*)(?:\s+\w+){0,3}\s+(?:fees?|commissions?)/iu.test(clause);
    const freeClaim = /(?:100\s*%|completely|entirely|totally)\s*free|(?:at\s+)?no\s+cost|полностью\s+бесплатн[а-яё]*/iu.test(clause);
    const proceedsClaim = /(?:keep|retain|receive|get)\s+(?:the\s+)?(?:full\s+)?100\s*%[^.!?;]{0,30}(?:sale|proceeds|payout|revenue)|(?:получ[а-яё]*|сохран[а-яё]*)[^.!?;]{0,25}100\s*%[^.!?;]{0,25}(?:продаж|выручк)/iu.test(clause);
    const browsingOnly = /brows(?:e|ing)|view(?:ing)?\s+(?:listings|inventory)|search(?:ing)?\s+(?:listings|inventory)|просмотр|поиск\s+(?:предмет|скин)/iu.test(clause);
    const scopedFree = /deposit|пополнени|депозит|item[ -]for[ -]item|skin[ -]for[ -]skin|предмет\s+на\s+предмет|скин\s+на\s+скин|обмен[^,;]{0,45}(?:без денег|без денежных)/iu.test(clause);
    const sales = /(?:p2p\s+)?sales?|sell(?:ing)?|продаж|прода[вёе]/iu.test(clause);
    const zeroFee = explicitZeroFee || semanticZeroFee || proceedsClaim || (freeClaim && (!browsingOnly || sales));
    if (zeroFee && sales) return 'P2P sales cost 2%; they are not zero-fee';
    if (sales && /(?:fee|commission|комисси)/iu.test(clause)) {
      const rates = [...clause.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map(m => Number(m[1].replace(',', '.')));
      const premiumDiscount = /premium|премиум/iu.test(clause) && /discount|скидк/iu.test(clause);
      const unsupported = premiumDiscount
        ? [...clause.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].some(m => {
            const rate = Number(m[1].replace(',', '.'));
            const following = clause.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 35);
            return !(rate > 0 && rate <= 2) && !/^\s*(?:premium\s+)?(?:discount|скидк)/iu.test(following);
          })
        : rates.some(rate => rate !== 2);
      if (unsupported) return 'P2P sales base commission is 2%; a lower effective fee requires an active Premium discount qualifier';
    }
    if (zeroFee && !scopedFree) return 'Unscoped zero-fee claim: deposits and item-for-item exchanges only; P2P sales cost 2%';
    if (/transtrade|transtreid|транстрейд/iu.test(clause) && /(?:operat(?:or|ed|es|ing)|own(?:ed|s)|владел|оператор|управля)/iu.test(clause) && !/(?:not|не)\s+(?:является\s+)?(?:the\s+)?(?:platform\s+)?(?:operator|оператор)/iu.test(clause)) return 'Operator is Nextrade Labs; Transtrade is the payment processor';
  }
  return null;
}

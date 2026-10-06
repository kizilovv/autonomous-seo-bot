// Owner-confirmed product facts, 2026-10-06. These are distinct transaction flows.
export const COMMERCIAL_FACTS = `
CSBoard fees: deposits 0%; P2P sales for money 2%; item-for-item P2P trades 0% because no money changes hands.
Never describe all CSBoard trading, selling or P2P transactions as zero-fee or commission-free.
When mentioning a 0% fee, explicitly identify deposits or item-for-item exchange in the same sentence.
Do not infer instant-sell pricing, withdrawal charges or network fees from these three rates.
CSBoard's operator is Nextrade Labs. Transtrade is a payment processor, not the platform operator.
Only mention these entities when relevant; never replace an unknown legal registered name/address with a guess.
`.trim();

/** Conservative publishing guard, not a calculator. Unsupported claims require review. */
export function commercialClaimViolation(value: string): string | null {
  const text = value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').replace(/(\d),(\d)/g, '$1.$2');
  const clauses = text.split(/[!?;,\n]|\.(?!\d)|\\n/).map(s => s.toLowerCase().replace(/[-‑–]/g, " "));
  for (const clause of clauses) {
    const zeroFee = /(?:zero|no|0(?:[.,]0+)?\s*%|нулев[а-яё]*|без)\s*(?:[\wа-яё-]+\s+){0,3}(?:fees?|commission|комисси[а-яё]*)|(?:fee|commission|комисси[а-яё]*)[^,;]{0,20}\b0(?:[.,]0+)?\s*%|(?:fee|commission)[ -]free/iu.test(clause);
    const scopedFree = /deposit|пополнени|депозит|item[ -]for[ -]item|skin[ -]for[ -]skin|предмет\s+на\s+предмет|скин\s+на\s+скин|обмен[^,;]{0,45}(?:без денег|без денежных)/iu.test(clause);
    const sales = /(?:p2p\s+)?sales?|selling|продаж/iu.test(clause);
    if (zeroFee && sales) return 'P2P sales cost 2%; they are not zero-fee';
    if (sales && /(?:fee|commission|комисси)/iu.test(clause)) {
      const rates = [...clause.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map(m => Number(m[1].replace(',', '.')));
      if (rates.some(rate => rate !== 2)) return 'P2P sales commission must be 2%';
    }
    if (zeroFee && !scopedFree) return 'Unscoped zero-fee claim: deposits and item-for-item exchanges only; P2P sales cost 2%';
    if (/transtrade/iu.test(clause) && /(?:operat(?:or|ed)|owned|владел|оператор|управля)/iu.test(clause) && !/(?:not|не)\s+(?:the\s+)?(?:platform\s+)?(?:operator|оператор)/iu.test(clause)) return 'Operator is Nextrade Labs; Transtrade is the payment processor';
  }
  return null;
}

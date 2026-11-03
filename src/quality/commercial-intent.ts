/** Pure transactional head queries belong to existing storefront landings.
 * Deliberately exact grammar: guides, comparisons, item names, integrations
 * and payment-specific questions still need their own intent assessment.
 */
export function commercialLandingForQuery(query: string): string | null {
  const q = query.toLowerCase().trim()
    .replace(/cs\s*:?\s*go|cs\s*2/gu, 'cs2')
    .replace(/tradeing/gu, 'trading')
    .replace(/\s+/gu, ' ');
  if (/^(?:buy|purchase) (?:cs2 )?skins(?: online)?$/u.test(q)) return '/buy';
  if (/^sell (?:cs2 )?skins(?: online)?$/u.test(q)) return '/sell';
  if (/^(?:swap|trade) (?:cs2 )?skins$/u.test(q)
    || /^cs2 (?:trade|trading)(?: (?:site|sites|website|websites))?$/u.test(q)
    || /^cs2 skin trading (?:site|sites|website|websites)$/u.test(q)) return '/trades';
  if (/^cs2 (?:market|markets|marketplace|marketplaces)$/u.test(q)) return '/buy';
  if (/^(?:купить скины?|покупка скинов)(?: (?:кс\s*2|кс\s*го|cs2))?$/u.test(q)) return '/buy';
  if (/^(?:продать скины?|скупка скинов|продажа скинов)(?: (?:кс\s*2|кс\s*го|cs2))?$/u.test(q)) return '/sell';
  return null;
}

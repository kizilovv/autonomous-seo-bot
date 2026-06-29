const {GoogleAuth} = require('google-auth-library');
(async () => {
  const auth = new GoogleAuth({
    keyFile: '/srv/csboard-seo/.secrets/google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const client = await auth.getClient();
  const url = 'https://analyticsdata.googleapis.com/v1beta/properties/337655668:runReport';
  const run = async (body) => (await client.request({url, method:'POST', data: body})).data;
  const dr = [{startDate:'30daysAgo', endDate:'today'}];

  // hostname filter to csboard only
  const csb = {filter:{fieldName:'hostName', stringFilter:{matchType:'CONTAINS', value:'csboard'}}};

  // 1) total site users/views (csboard hosts, 30d)
  const total = await run({dateRanges:dr, metrics:[{name:'activeUsers'},{name:'screenPageViews'},{name:'sessions'}], dimensionFilter:csb});
  console.log('TOTAL_SITE_30d (activeUsers, views, sessions):', JSON.stringify(total.rows?.[0]?.metricValues?.map(m=>m.value)));

  // 2) comparison page (path contains /comparison)
  const cmp = await run({dateRanges:dr,
    dimensions:[{name:'pagePath'}],
    metrics:[{name:'activeUsers'},{name:'screenPageViews'},{name:'sessions'}],
    dimensionFilter:{andGroup:{expressions:[csb,{filter:{fieldName:'pagePath',stringFilter:{matchType:'CONTAINS',value:'/comparison'}}}]}},
    orderBys:[{metric:{metricName:'activeUsers'},desc:true}], limit:20});
  console.log('\nCOMPARISON_PAGES_30d:');
  (cmp.rows||[]).forEach(r=>console.log('  ', r.dimensionValues[0].value, '=> users', r.metricValues[0].value, '| views', r.metricValues[1].value, '| sess', r.metricValues[2].value));
  if(!cmp.rows) console.log('   (no rows)');

  // 3) item pages (where MarketComparison sidebar lives)
  const items = await run({dateRanges:dr, metrics:[{name:'activeUsers'},{name:'screenPageViews'}],
    dimensionFilter:{andGroup:{expressions:[csb,{filter:{fieldName:'pagePath',stringFilter:{matchType:'CONTAINS',value:'/items/'}}}]}}});
  console.log('\nITEM_DETAIL_PAGES_30d (activeUsers, views):', JSON.stringify(items.rows?.[0]?.metricValues?.map(m=>m.value)));

  // 4) sniper-related events if any
  const ev = await run({dateRanges:dr, dimensions:[{name:'eventName'}], metrics:[{name:'eventCount'}],
    dimensionFilter:{andGroup:{expressions:[csb,{filter:{fieldName:'eventName',stringFilter:{matchType:'CONTAINS',value:'sniper'}}}]}}});
  console.log('\nSNIPER_EVENTS_30d:', ev.rows? JSON.stringify(ev.rows.map(r=>[r.dimensionValues[0].value, r.metricValues[0].value])) : 'none');
})().catch(e=>{console.error('ERR', e.response?.data || e.message);});

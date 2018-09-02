const fetch = require('node-fetch');


function utils(Apify, requestQueue){
  Apify = Apify || global.Apify;
  requestQueue = requestQueue || global.requestQueue;
  
  return {
    wait,
    shot,
    error,
    clearText,
    clearNum,
    trunc,
    randomNum,
    getSpreadsheet,
    getExchangeRate,
    queueUrls,
    
    getPageMatchSettings,
    filterRequests,
    pageMatcherResult,
  }
  
  async function wait(delay){
    return await new Promise(resolve => setTimeout(resolve, delay))
  }
  
  async function shot(p, h){
    h = h || 'local';
    const name = `${h}_${new Date().getTime()}.png`;
    await Apify.setValue(name, await p.screenshot({ fullPage: true }), { contentType: 'image/png' });
    console.log('[MATCHER] Screenshot', name);
  }
  
  async function error({ request: { url, errorMessages }, page }, status = 'request_timeout', error, takeShot){
    const host  = url.match(/^https?\:\/\/([^\/?#]+)(?:[\/?#]|$)/i)[1];
    status      = `${status}_${host}__${new Date().getTime()}`;
    //await shot(page, host);
    page && takeShot && await shot(page, status);
    await Apify.setValue(status, { status, error, url });
    return;
  }
  
  async function queueUrls(urls, reqQueue, limit, initial){
    global.allowTurnOff = false;
    if(typeof urls === 'function')
      urls = await urls();
    if(!urls || !urls.length) 
      return this.debug && console.log(`[MATCHER] Queueing empty URLS`);
    
    if(limit)
      urls = urls.slice(0, limit);
      
    reqQueue = reqQueue || this.requestQueue || global.requestQueue;
    let i, urlObj, url, userData;
    let batch = 1, perBatch = 100, delayAfterBatch = 5000;
    
    console.log(`[MATCHER] Queuing ${urls.length} + ${requestPendingCount(reqQueue)}`);
    for(i in urls){
      
      urlObj    = typeof urls[i] === 'string' ? { url: urls[i] } : urls[i];
      url       = urlObj.url;
      userData  = urlObj.userData ? { ...urlObj.userData, initial } : { ...urlObj, initial };
      
      delete userData.reclaim;
      
      if(initial){
        delete userData.url;
        delete userData.urls;
        delete userData.id;
        delete urlObj.id;
      }
      
      if(url && url.length){
        // console.log({ keepUrlFragment: true, ...urlObj, url, userData }, { forefront: urlObj.forefront });
        await reqQueue.addRequest(new Apify.Request({ keepUrlFragment: true, ...urlObj, url, userData }, { forefront: urlObj.forefront }));
        this.debug && console.log(`[MATCHER] Queued ${requestPendingCount(reqQueue)}`, trunc(url, 150, true), { userDataSize: Object.keys(userData).length });
        userData.initial && this.initialRequestsAmount++;
        
        if( (perBatch * batch) < i ){
          console.log(`[MATCHER] Queued ${perBatch * batch} / ${urls.length}`);
          await Apify.utils.sleep(delayAfterBatch);
          batch++;
        }
      } else {
        this.debug && console.log(`[MATCHER] Queuing empty url ${url}`);
      }
    }
  }
  
  function requestPendingCount(rq, cr){
    if(rq.pendingCount) return rq.pendingCount;
    const count = rq.requestsCache && rq.requestsCache.listDictionary.linkedList.length || 0;
    if(!cr) return count;
    return count - cr.handledRequestsCount;
  }
  
  function clearText(text){
    return typeof text === 'string' ? text.trim().replace(/\s{2,}/g, ' ').replace(/(\r\n|\n|\r|(  ))/gm, '') : text;
  }
  
  function clearNum(num){
    return typeof num === 'string' ? parseFloat(num.replace(/(?!-)[^0-9.,]/g, '').replace(/[,]/gm, '.')) : num;
  }
  
  function randomNum(start = 0, end = 1){
    return Math.floor(Math.random() * end) + start;
  }
  
  function trunc(str, length, isUrl, tail = ' ...'){
    if(!str instanceof String) return str;
    const newStr = isUrl ? encodeURI(str) : str;
    return length && newStr.length > length ? (newStr.substring(0, length) + tail) : newStr;
  }
  
  async function getSpreadsheet({ spreadsheetId, listId, max, start }, filterFn){
    // Generates url
    let url = [`https://spreadsheets.google.com/feeds/list/${spreadsheetId}/${listId}/public/values?alt=json`];
    start && url.push('start-index=' + start); max && url.push('max-results=' + max); url = url.join('&');
    // Fetches the json
    console.log('[MATCHER] Loading Spreadsheet', url);
    const result = await fetch(url).then(res => res.json());
    let entries = result.feed && result.feed.entry || [];
      
    return entries.reduce( (arr, entry) => {
      
      let newEntry = Object.keys(entry).reduce((obj, key) => {
        const val = entry[key]['$t'];
        if(!val || !~key.indexOf('gsx$')) return obj;
        
        const newKey = key.replace('gsx$', '').replace(/[-]/g, '');
        
        return Object.assign(obj, { [newKey]: val });
      }, {});
      
      !filterFn && arr.push(newEntry);
      
      newEntry = filterFn(newEntry);
      newEntry && arr.push(newEntry);
      
      return arr;
    }, []);
  }
  
  async function getExchangeRate(currency = 'EUR', symbols = 'USD', fixerKey = '2aec20cdd5d953fe6e52adc2ebb6de54'){
    const exchangeRates = {
      EUR: 1.15,
      RUB: 0.015,
      GBP: 1.28,
    }
    const url = `http://data.fixer.io/api/latest?access_key=${fixerKey}&base=${currency}&symbols=${symbols}`; console.log('[MATCHER] Loading Exchange Rate', url);
    return await fetch(url, { timeout: 5000 })
      .then( res => res.json() )
      .then( json => json.rates )
      .catch( err => {
        console.log(err);
        return { USD: exchangeRates[currency] }
      });
  }
  
  // Collects Matcher settings for matching (url or matcherLabel) page
  async function getPageMatchSettings(pageMatcherData, { userData, url }){
    const { matcherLabel } = userData;
    
    let pageMatch = pageMatcherData.find(
      matcher => matcherLabel 
        ? matcher.label === matcherLabel 
        : matcher.url === url || matcher.match instanceof Array ? matcher.match.filter( m => url.includes(m) ).length : url.includes(matcher.match)
    );
    
    if(!pageMatch){
      pageMatch = pageMatcherData.find( matcher => 
        matcher.ignoreMatch === url || 
        matcher.ignoreMatch instanceof Array ? matcher.ignoreMatch.filter( m => url.includes(m) ).length : url.includes(matcher.ignoreMatch)
      )
      if(pageMatch)
        return { status: 'ignore_match', msg: 'ignoreMatch is matching the url' }
    }
    
    if(!pageMatch || !pageMatch.func)
      return { err: 'missing_page_setting', msg: 'Missing PageMatcher setting for this page' };
      
    const blockResources  = userData.blockResources !== undefined ? userData.blockResources : pageMatch.blockResources;
    const noRedirects     = userData.noRedirects !== undefined    ? userData.noRedirects    : pageMatch.noRedirects;
    const clearCookies    = userData.clearCookies !== undefined   ? userData.clearCookies   : pageMatch.clearCookies;
    const disableJs       = userData.disableJs !== undefined      ? userData.disableJs      : pageMatch.disableJs;
    const disableCache    = userData.disableCache !== undefined   ? userData.disableCache   : pageMatch.disableCache;
    const wait            = userData.wait !== undefined           ? userData.wait           : pageMatch.wait;
    const timeout         = userData.timeout !== undefined        ? userData.timeout        : pageMatch.timeout;
    const type            = userData.type !== undefined           ? userData.type           : pageMatch.type;
    const conTimeout      = userData.conTimeout !== undefined     ? userData.conTimeout     : pageMatch.conTimeout;
    
    return { ...pageMatch, blockResources, noRedirects, clearCookies, disableJs, disableCache, wait, timeout, type, conTimeout };
  }
  
  async function pageMatcherResult(data, requestQueue){
    requestQueue = requestQueue || global.requestQueue;
      
    const { request, page, response, puppeteerPool, match } = data;
    const { template, func } = match;
    
    let result;
    
    if(data.result)
      result = data.result;
    else if(func)
      result = await func(data);
    
    const { skipUrls, limit, showSkip, urls, status, skip, reclaim } = result || {};
    
    if(!result)
      return console.log('[MATCHER] Empty Result', result);
      
    if(reclaim)
      await queueUrls([ { ...reclaim.userData, url: reclaim.url + '#' + new Date().getTime(), forefront: true } ], requestQueue, limit);
    
    // Add urls to queue
    if(!skipUrls && urls)
      await queueUrls(result.urls, requestQueue, limit);
    
    // Skip result
    if(skip || status === 'done')
      return showSkip && console.log('[MATCHER] Skipping Result', result);
    
    if(status)
      console.log('[MATCHER] Result', status);
    
    // Generate template
    if(template)
      result = result instanceof Array ? result.map(template) : template(result);
    
    // Adds result to Apify Store
    await Apify.pushData(result);
    return result;
  }
  
  async function filterRequests(page, filters, debug){
    const { noRedirects, blockResources, timeout, wait, url } = filters;
    
    await page.setRequestInterception(noRedirects || !!blockResources);
    if(!blockResources) return;
    
    const scriptTypes = [ 'script', 'other' ];
    const styleTypes  = [ 'image', 'media', 'font', 'texttrack', 'beacon', 'imageset', 'object', 'csp_report', 'stylesheet' ];
    const styleExts   = [ '.jpg', 'jpeg', '.png', '.gif', '.css'];
    const scriptExts  = [ '.js' ];
    const dataTypes   = [ 'xhr' ];
    const dataExts    = [ '.json' ];
    
    let types, exts;
    
    switch(blockResources){
      case 'style':
      case 'styles':
      case 'css':
        types = styleTypes;
        exts  = styleExts;
      break;
      case 'script':
      case 'scripts':
        types = scriptTypes;
        exts  = scriptExts;
      break;
      case 'image':
      case 'images':
      case 'img':
        types = styleTypes.slice(0, 8);
        exts  = styleExts.slice(0, 4);
      break;
      case 'data':
        types = dataTypes;
        exts  = dataExts;
      default:
        types = [ ...styleTypes, ...scriptTypes, ...dataTypes ];
        exts  = [ ...styleExts, ...scriptExts, ...dataExts ];
      break;
    }
    
    const blacklist = filters.blacklist !== undefined ? filters.blacklist : [
      'https://www.googleadservices.com/pagead/conversion.js',
      'https://www.google-analytics.com/analytics.js',
    ]
    
    page.on('request', req => allow(req, page));
    return;
    
    function allow(req, page){
      if(encodeURI(url) !== req.url() && !page.isConnected){
        debug && console.log('[MATCHER] Connected', url);
        page.isConnected = true;
      }
      // const isRedirect = req.isNavigationRequest() && req.redirectChain().length;
      const isResource = types.includes(req.resourceType()) || exts.includes(req.url()) || blacklist.includes(req.url());
      
      !isResource // (noRedirects && !isRedirect) 
        ? req.continue() && debug && console.log('[MATCHER] Alowed', req.resourceType(), req.url())
        : req.abort() && debug && console.log('[MATCHER] Blocked', req.resourceType(), req.url())
    }
    
  }
}

module.exports = utils;




/**
 * No connection checker example
 */
 
// Resource Connection checker
// let interval;
// let connected = false;

// setTimeout(function(){ clearInterval(interval) }, timeout);

// if(conTimeout && !connected && !page.noReconnects){
//   interval = setTimeout(async function(){
//     if(connected){
//       await page.waitFor(1);
//       page.noReconnects = true;
//       return clearInterval(interval);
//     }
      
//     console.log('NO CONNECTION');
//     //{ waitUntil: wait || 'domcontentloaded', timeout: timeout || 30000 }
//     // return await Promise.race[ 
//     //   page.goto(url, { waitUntil: wait || 'networkidle2', timeout: timeout || 30000 }),
//     //   new Promise( resolve => setTimeout(resolve, 4000) )
//     // ]
//   }, conTimeout || 6000);
// }
 
//let response;
// let num = 30;

// let pageGoto = page.goto(url, { waitUntil: wait || 'domcontentloaded', timeout: timeout || 30000 });

// let res;
// while(!page.isConnected && num > 0){
//   num--;
//   console.log(num);
//   page.removeAllListeners('request');
//   await page.goto('about:blank');
  
//   await filterRequests(page, { noRedirects, blockResources, timeout, wait, conTimeout, url });
//   res = page.goto(url, { waitUntil: wait || 'domcontentloaded', timeout: timeout || 30000 });
//   res.catch(err => { throw(err) });
//   await new Promise( resolve => setTimeout(resolve, 5000) );
// }

// console.log('PAGE IS CONNECTED', page.isConnected);
// const response = await res;

// console.log(response);



// const response = await page.goto(url, { waitUntil: wait || 'domcontentloaded', timeout: timeout || 30000 });
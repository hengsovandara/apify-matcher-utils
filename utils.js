const fetch = require('node-fetch');


function utils(Apify, requestQueue){
  Apify = Apify || global.Apify;
  requestQueue = requestQueue || global.requestQueue;
  
  return {
    // General
    wait,
    shot,
    error,
    clearText,
    onlyText,
    clearNum,
    trunc,
    randomNum,
    getDate,
    getCurrency,
    // External
    getSpreadsheet,
    getExchangeRate,
    // Apify Url / request utils
    reclaimRequest,
    queueUrls,
    // Puppeteer
    filterRequests,
    generateCookies,
    checkCaptcha,
    // Matcher
    getPageMatchSettings,
    pageMatcherResult,
    // Matcher Schema
    evaluatePage,
    modifyResult,
    // Matcher Apify
    gotoFunction,
    handlePageFunction,
    isFinishedFunction,
  }
  
  async function wait(delay){
    return await new Promise(resolve => setTimeout(resolve, delay))
  }
  
  async function shot(p, h){
    h = h || 'local';
    const name = `${h}_${new Date().getTime()}`;
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
  
  async function reclaimRequest(request, reqQueue, retry){
    const { userData, url } = request;
    await reqQueue.addRequest(new Apify.Request({ 
      keepUrlFragment: true, 
      url, 
      userData, 
      uniqueKey: 'reclaim_' + new Date().getTime(),
      retryCount: retry ? request.retryCount + 1 : 0
    }, { forefront: true }));
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
      delete urlObj.id;
      
      if(initial){
        delete userData.url;
        delete userData.urls;
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
  
  function onlyText(text){
    return typeof text === 'string' ? clearText(text.replace(/\d+/g, '')) : text;
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
        ? matcher.label === matcherLabel || matcher.matcherLabel === matcherLabel 
        : matcher.url === url || (matcher.match instanceof Array ? matcher.match.filter( m => url.includes(m) ).length : url.includes(matcher.match))
    );
    
    if(!pageMatch){
      pageMatch = pageMatcherData.find( matcher => 
        matcher.ignoreMatch === url || 
        matcher.ignoreMatch instanceof Array ? matcher.ignoreMatch.filter( m => url.includes(m) ).length : url.includes(matcher.ignoreMatch)
      )
      if(pageMatch)
        return { status: 'ignore_match', msg: 'ignoreMatch is matching the url' }
    }
    
    if(!pageMatch)
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
    const { template, func, schema, modify, actions, debug } = match;
    
    let result;
    
    if(actions && actions.before)
      await actions.before(data);
    
    if(data.result)
      result = data.result;
    else if(func)
      result = await func(data);
      
    if(schema){
      schema.waitFor && await page.waitFor(schema.waitFor, { visible: true });
      result = await page.evaluate(evaluatePage, { schema, extras: match });
    }
    
    if(modify)
      result = await modifyResult(result, modify, { url: page.url(), ...request.userData });
      
    if(actions && actions.after)
      result = await actions.after(data, result);
      
    
    const { skipUrls, limit, showSkip, urls, status, skip, reclaim, retry } = result || {};
    
    if(!result)
      return console.log('[MATCHER] Empty Result', result);
      
    if(reclaim){
      await reclaimRequest(request, requestQueue);
      return;
    }
    
    if(retry){
      await reclaimRequest(request, requestQueue, retry);
      return;
    }
    // Add urls to queue
    if(!skipUrls && urls)
      await queueUrls(result.urls, requestQueue, limit);
    
    // Skip result
    if(skip || status === 'done')
      return showSkip && console.log('[MATCHER] Skipping Result', result);
    
    // Generate template
    if(template)
      result = result instanceof Array ? result.map(template) : template(result);
      
    // Adds result to Apify Store
    !debug 
      ? await Apify.pushData(result)
      : console.log({ result });
      
    return result;
  }
  
  async function filterRequests(page, filters, debug){
    const { blockResources, wait, url, conTimeout } = filters;
    
    page.removeAllListeners('request');
    
    const interceptRequests = !!blockResources;
    await page.setRequestInterception(interceptRequests);
    if(!interceptRequests)
      return;
    
    const scriptTypes = [ 'script', 'other' ];
    const mediaTypes  = [ 'image', 'media', 'imageset', 'object' ];
    const specialTypes = [ 'beacon', 'csp_report' ];
    const styleTypes  = [ 'font', 'texttrack', 'stylesheet' ];
    const mediaExts   = [ '.jpg', 'jpeg', '.png', '.gif' ];
    const styleExts   = [ '.css' ];
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
      case 'visual':
        types = [ ...styleTypes, ...mediaTypes ];
        exts  = [ ...styleExts, ...mediaExts ];
      break;
      case 'script':
      case 'scripts':
        types = scriptTypes;
        exts  = scriptExts;
      break;
      case 'image':
      case 'images':
      case 'img':
      case 'media':
        types = mediaTypes;
        exts  = mediaExts;
      break;
      case 'special':
        types = specialTypes;
        exts  = [];
      break;
      case 'data':
        types = dataTypes;
        exts  = dataExts;
      break;
      default:
        types = [ ...styleTypes, ...scriptTypes, ...dataTypes, ...specialTypes, ...mediaTypes ];
        exts  = [ ...styleExts, ...scriptExts, ...dataExts, ...mediaExts ];
      break;
    }
    
    const blacklist = filters.blacklist !== undefined ? filters.blacklist : [
      // 'https://www.googleadservices.com/pagead/conversion.js',
      // 'https://www.google-analytics.com/analytics.js',
    ];
    
    // console.log(types, exts);
    
    page.on('request', req => allow(req, page));
    return;
    
    function allow(req, page){
      if(conTimeout && encodeURI(url) !== req.url() && !page.isConnected){
        debug && console.log('[MATCHER] Connected', url);
        page.isConnected = true;
      }
      // const isRedirect = req.isNavigationRequest() && req.redirectChain().length;
      const isResource = ~types.indexOf(req.resourceType()) || ~exts.indexOf(req.url()) || ~blacklist.indexOf(req.url());
      
      !isResource // (noRedirects && !isRedirect) 
        ? req.continue() && debug && console.log('[MATCHER] Alowed', req.resourceType(), req.url())
        : req.abort() && debug && console.log('[MATCHER] Blocked', req.resourceType(), req.url())
    }
    
  }
  
  async function checkCaptcha(page){
    const url = page.url();
    return ( url.includes('ipv4.google') || url.includes('google.com/sorry') || 
      await page.$eval('body', body => body ? [ "с вашего IP-адреса", 'CAPTCHA' ].find( str => !!~body.textContent.indexOf(str)) : false )) 
        ? true
        : false
  }
  
  function generateCookies(cookieData){
    if(!cookieData)
      return;
      
    if(cookieData instanceof Array)
      return cookieData;
      
    const general = {
      // domain: '.asos.com',
      // url: 'https://www.asos.com',
      path: '/',
      sameSite: 'no_restriction',
      httpOnly: false,
      secure: false,
      session: false,
      expires: new Date().getTime() + 86400000,
      ...(cookieData.general || {})
    }
      
    return Object.keys(cookieData).reduce( (arr, key) => {
      return key !== 'general' 
        ? arr.concat([{ name: key, value: cookieData[key], ...general }])
        : arr;
    }, []);
  }
  
  
  // Puppeteer Crawler predefined helper methods
  async function gotoFunction({ request, page, puppeteerPool }, extras = {}){
    const { url, userData } = request;
    const { pageMatcherSettings, requestQueue } = extras;
    
    const client = await page.target().createCDPSession();
    const match = await getPageMatchSettings(pageMatcherSettings, request);
    const { err, msg, clearCookies, timeout, wait, blockResources, disableJs, disableCache, noRedirects, conTimeout, debug, viewport } = match;
    const cookieData = generateCookies(match.cookies || extras.cookies);
    
    // These settings can be specified for every page or for pageMatcher
    if(err)
      throw(err);
    
    // Hide the puppeteer
    await page.setUserAgent(await Apify.utils.getRandomUserAgent());
    await Apify.utils.puppeteer.hideWebDriver(page);
    await page.setViewport({ width: 1280, height: 800 });
    
    // Clier cookies
    if(clearCookies){
      const cookies = await page.cookies(request.url);
      await page.deleteCookie(...cookies);
    }
    
    if(cookieData)
      await page.setCookie(...cookieData);

    if(viewport)
      await page.setViewport({ width: viewport.width || 1280, height: viewport.height || 800 });
    
    // Configure puppeteer page
    await page.setJavaScriptEnabled(!disableJs);
    await page.setCacheEnabled(!disableCache);
    
    await filterRequests(page, { noRedirects, blockResources, timeout, wait, conTimeout, url }, debug);
    // intercept requests
    
    console.log('[MATCHER] Opening', trunc(request.url, 150, true));
    console.time('[MATCHER] Opened ' + trunc(request.url, 150, true));
    
    let response;
    
    if(conTimeout){
      
      let num = (timeout || 30000) / conTimeout;
      let res;
      
      while(!page.isConnected && num > 0){
        num--;
        page.removeAllListeners('request');
        await page.goto('about:blank');
        
        if(!page.isConnected){
          await filterRequests(page, { noRedirects, blockResources, timeout, wait, conTimeout, url }, false);
          res = page.goto(url, { waitUntil: wait || 'networkidle2', timeout: timeout || 30000 });
        }
        
        await new Promise( resolve => setTimeout(resolve, conTimeout) );
        
        if(num <= 0){
          throw 'TimeoutError';
        }
      }
  
      // console.log('PAGE IS CONNECTED', page.isConnected);
      response = await res;
    
    } else {
      // await filterRequests(page, { noRedirects, blockResources, timeout, wait, conTimeout, url }, false);
      response = await page.goto(url, { waitUntil: wait || 'domcontentloaded', timeout: timeout || 30000 });
    
    }
    
    if(clearCookies)
      await client.send( 'Network.clearBrowserCookies' );
    
    return response;
  }

  async function handlePageFunction(data, extras = {}){
    
    const { pageMatcherSettings, requestQueue, evaluate } = extras;
    
    let result;
    
    if(await checkCaptcha(data.page) || data.response.status() > 400){
      
      const browser = await data.page.browser();
      await data.puppeteerPool.retire(browser);
      
      await reclaimRequest(data.request, requestQueue);
        
      console.log('CAPTCHA or STATUS error', data.response.status());
      
      return;
      // throw 'RECLAIM';
    }
    
    if(pageMatcherSettings){
      data.match = await getPageMatchSettings(pageMatcherSettings, data.request);
      result = await pageMatcherResult(data, requestQueue);
    }
    
    console.timeEnd('[MATCHER] Opened ' + trunc(data.request.url, 150, true));
    
    // if(evaluate)
    //   result = await evaluate(data);
    
    return result;
  }
  
  async function isFinishedFunction(){
    if(global.allowTurnOff)
      return true;
    
    await new Promise(res => setTimeout(res, 5000));
    console.log('Delay crawler turn off for', 5 + 's');
    global.allowTurnOff = true;
    return;
  }
  
  function modifyResult(result, modify, userData){
    // console.log({ result, modify, userData });
    switch(typeof modify){
      case 'function':
        return modify(result, userData); 
      case 'object':
        Object.keys(modify).forEach( key => {
          
          result[key] = typeof modify[key] === 'function'
            ? modify[key](result[key], result, userData) || result[key] || null
            : result[key] = result[key] || modify[key];
            
        });
        return result;
      default:
        return result;
    }
  }
  
  function evaluatePage({ schema, extras }){
    const doc = window.document;
    const debug = extras && extras.debug;
    
    return Object.keys(schema).reduce(schemaToResult, {});
    
    // extracts data using schema
    function schemaToResult(obj, key){
      let rule = schema[key];
      
      if(typeof rule === 'string'){
        debug ? obj[`_${key}`] = { ...ruleToObj(rule), rule } : null;
        return Object.assign( obj, { [key]: stringResult(ruleToObj(rule)) });
      }
          
      if(rule instanceof Array && rule.length === 1){
        const { selector, attr } = ruleToObj(rule[0]);
        debug ? obj[`_${key}`] = { selector, attr, rule } : null;
        
        const elems = attr === 'nodeValue'
          ? doc.querySelector(selector) && [ ...doc.querySelector(selector).childNodes ].filter(el => el.nodeType === 3)
          : [ ...doc.querySelectorAll(selector) ];
          
        const result = elems.map( elem => stringResult({ elem, attr }));
        return Object.assign( obj, { [key]: result });
      }
      
      if(rule instanceof Array){
        debug ? obj[`_${key}`] = { ...ruleToObj(rule), rule } : null;
        return Object.assign( obj, { [key]: rule.map( r => stringResult(ruleToObj(r))) });
      }
      
      return Object.assign( obj, { [key]: rule });
    }
    
    function ruleToObj(rule, separator = ' => '){
      let parts = rule.split(separator);
      const selector  = parts[0];
      const lastSelector = selector.split(' ').pop();
      const attr      = parts[1] 
        || lastSelector.includes('img')     && 'src'
        || lastSelector.indexOf('a') === 0  && 'href'
        || lastSelector.includes('meta')    && 'content';
      return { selector, attr }
    }
    
    function stringResult({ elem, attr, selector }){
      elem = elem || doc.querySelector(selector);
      
      if(!elem)
        return null;
      
      // if(attr === 'nodeValue')
      //   return [ ...elem.childNodes ].filter(el => el.nodeType === 3).map(el => el.textContent);
      
      return attr && attr !== 'nodeValue' 
        ? elem.getAttribute(attr) 
        : elem.textContent && utilsClearText(elem.textContent);
    }
    
    function utilsClearText(text){
      return text.trim().replace(/\s{2,}/g, ' ').replace(/(\r\n|\n|\r|(  ))/gm,'')
    }
  }
  
  function getDate(date, cfg = {}){
    const { sep } = cfg;
    const months = ["January", "February", "March", "April", "May", "June","July", "August", "September", "October", "November", "December"];
    date = date ? new Date(date) : new Date();
    
    const onejan = new Date(date.getFullYear(), 0, 1);
    
    const monthNum  = (date.getMonth() + 1) < 10 ? '0' + (date.getMonth() + 1) : (date.getMonth() + 1);
    const dayNum    = date.getDate() < 10 ? '0' + date.getDate() : date.getDate();
    
    return {
      month:  months[date.getUTCMonth()].substring(0, 3),
      week:   'Week ' + Math.ceil((((date.getTime() - onejan) / 86400000) + onejan.getDay() + 1) / 7),
      year:   date.getFullYear(),
      date:   [ dayNum, monthNum, date.getFullYear() ].join(sep || '-'),
      string:   date.toUTCString()
    }
  }
  
  function getCurrency(text){
    if(!text)
      return null;
      
    if(~text.indexOf('£'))
      return 'GBP';
    if(~text.indexOf('€'))
      return 'EUR';
      
    return 'USD';
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
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
    makePageUndetectable,
    retireAndReclaim,
    // Matcher
    getPageMatchSettings,
    pageMatcherResult,
    getResponse,
    // Matcher Schema
    evaluatePage,
    modifyResult,
    // Matcher Apify
    gotoFunction,
    handlePageFunction,
    isFinishedFunction,
    // launchers
    startPuppeteerMatcher
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
    global.allowTurnOff = false;
    const { userData, url } = request;
    await reqQueue.addRequest(new Apify.Request({ 
      keepUrlFragment: true, 
      url, 
      userData, 
      uniqueKey: String(`${retry ? 'retry' : 'reclaim'}_${new Date().getTime()}_${request.url}`),
      retryCount: retry ? request.retryCount + 1 : 0
    }, { forefront: retry ? false : true }));
    return;
  }
  
  async function queueUrls(urls, reqQueue, extras = {}){
    
    const limit = typeof extras === 'number' && extras || extras.limit;
    const initial = extras.initial;
    const debug   = extras.debug;
    
    global.allowTurnOff = false;
    if(typeof urls === 'function')
      urls = await urls();
    if(!urls || !urls.length) 
      return debug && console.log(`[MATCHER] Queueing empty URLS`);
    
    if(limit)
      urls = urls.slice(0, limit);
      
    reqQueue = reqQueue || this.requestQueue || global.requestQueue;
    let i, urlObj, url, userData;
    let batch = 1, perBatch = 100, delayAfterBatch = 5000;
    
    console.log(`[MATCHER] Queuing ${urls.length} + ${requestPendingCount(reqQueue)}`);
    
    try{
      for(i in urls){
        
        urlObj    = typeof urls[i] === 'string' ? { url: urls[i] } : urls[i];
        url       = urlObj.url;
        userData  = urlObj.userData ? { ...urlObj.userData } : { ...urlObj };
        
        if(url && !~url.indexOf('www') && !~url.indexOf('//')){
          console.log(`[MATCHER] Queuing url with incorrect protocol ${url}`);
          break;
        }
        // TODO!!!!
        // merge matcher data to userData properly
        
        delete userData.reclaim;
        delete urlObj.id;
        
        // if(initial){
        //   delete userData.url;
        delete userData.urls;
        // }
        
        if(url && url.length){
          // console.log({ keepUrlFragment: true, ...urlObj, url, userData }, { forefront: urlObj.forefront });
          await reqQueue.addRequest(new Apify.Request({ keepUrlFragment: true, ...urlObj, url, userData }, { forefront: urlObj.forefront }));
          console.log(`[MATCHER] Queued ${requestPendingCount(reqQueue)}`, trunc(url, 150, true), { userData });
          userData.initial && this.initialRequestsAmount++;
          
          if( (perBatch * batch) < i ){
            console.log(`[MATCHER] Queued ${perBatch * batch} / ${urls.length}`);
            await Apify.utils.sleep(delayAfterBatch);
            batch++;
          }
        } else {
          debug && console.log(`[MATCHER] Queuing empty url ${url}`);
        }
      }
    } catch(err){ console.log(err) }
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
    if(typeof num !== 'string')
      return num || null;
      
    const cleared = num.replace(/(?!-)[^0-9.,]/g, '');
    
    return ~cleared.indexOf('.')
      ? parseFloat(cleared.replace(/[,]/gm, ''))
      : parseFloat(cleared.replace(/[,]/gm, '.'))
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
    
    // console.log({ url, userData });
    
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
    const { template, func, schema, modify, actions, debug, evaluate, waitFor, skipResult, waitForTimeout } = match;
    
    let result;
    
    waitFor && await page.waitFor(waitFor, { visible: true, timeout: waitForTimeout || 10000 });
    
    if(match.shot)
      await shot(page, typeof match.shot === 'string' && match.shot);
    
    if(actions && actions.before)
      result = await actions.before(data, result);
    
    if(data.result)
      result = { ...data.result, ...(result || {}) };
    else if(func)
      result = await func(data, result);
    
    if(schema){
      const res = await page.evaluate(evaluatePage, { schema, extras: match });
      result = res ? Object.assign(result || {}, res) : result;
    }
    
    if(evaluate)
      result = await page.evaluate(evaluate, { match, result });

    if(modify){
      result = await modifyResult(result, modify, { url: request.url, ...request.userData }, page);
    }
      
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
    
    !template && debug && console.log({ result });
    
    // Add urls to queue
    if(!skipUrls && urls)
      await queueUrls(result.urls, requestQueue, { ...match, ...result });

    // Skip result
    if(match.skip || skipResult || skip || status === 'done')
      return showSkip && console.log('[MATCHER] Skipping Result', result);
    
    // Generate template
    if(template)
      result = result instanceof Array ? result.map(template) : await template(result);
      
    template && debug && console.log({ result });
      
    // Adds result to Apify Store
    
    await Apify.pushData(result);
      
    return result;
  }
  
  async function filterRequests(page, filters, debug){
    const { blockResources, url, conTimeout } = filters;
    
    page.removeAllListeners('request');
    
    const interceptRequests = !!blockResources;
    await page.setRequestInterception(interceptRequests);
    if(!interceptRequests)
      return;
    
    const scriptTypes = [ 'script', 'other' ];
    const mediaTypes  = [ 'image', 'media', 'imageset', 'object' ];
    const specialTypes = [ 'beacon', 'csp_report' ];
    const styleTypes  = [ 'font', 'texttrack', 'stylesheet' ];
    const mediaExts   = [ '.jpg', 'jpeg', '.png', '.gif', '.svg' ];
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
  
  async function makePageUndetectable(page){
    
    await page.setUserAgent(await Apify.utils.getRandomUserAgent());
    await Apify.utils.puppeteer.hideWebDriver(page);
    
    await page.evaluateOnNewDocument(() => {
      
      // Hider webdrive
      Object.defineProperty(window.navigator, 'webdriver', {
        get: () => false,
      });
      
      // Set chrome navigator props
      window.navigator.chrome = {
        app: {},
        webstore: {},
        runtime: {},
        PlatformArch: {},
        PlatformNaclArch: {},
        RequestUpdateCheckStatus: {},
        OnInstalledReason: {},
        OnRestartRequiredReason: {}
      };
      
      // Set Notifications
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: window.Notification.permission }) :
          originalQuery(parameters)
      );
      
      // Set Plugins
      Object.defineProperty(window.navigator, 'plugins', {
        // We can mock the plugins too if necessary.
        get: () => [1, 2, 3, 4, 5],
      });
      
      // Set Language
      Object.defineProperty(window.navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      
    });
  }
  
  function generateCookies(cookieData, { url }){
    if(!cookieData)
      return;
      
    if(cookieData instanceof Array)
      return cookieData;
    
    let domain;
    if(url){
      domain = url.split('/')[2];
      domain = domain && domain.split('.');
      domain[0] = '';
      domain = domain && domain.join('.');
    }
      
    const general = {
      // domain: '.asos.com',
      // url: 'https://www.asos.com',
      path: '/',
      sameSite: 'no_restriction',
      httpOnly: false,
      secure: false,
      session: false,
      expires: new Date().getTime() + 86400000,
      domain,
      ...(cookieData.general || {})
    }
      
    return Object.keys(cookieData).reduce( (arr, key) => {
      return key !== 'general' 
        ? arr.concat([{ name: key, value: cookieData[key], ...general }])
        : arr;
    }, []);
  }
  
  async function getResponse({ page, match, request }){
    
    const { blockResources, conTimeout, debug, wait, waitUntil } = match;
    const timeout = match.timeout || 30000;
    const { url } = request;
    
    if(blockResources || conTimeout)
      await filterRequests(page, { blockResources, conTimeout, url }, debug);
      
    if(!conTimeout)
      return page.goto(url, { waitUntil: wait || waitUntil || 'domcontentloaded', timeout: timeout || 30000 });
    
      
    let num = (timeout || 30000) / conTimeout;
    let res;
    
    while(!page.isConnected && num > 0){
      num--;
      
      debug && console.log('[MATCHER] Connecting', num, url);
      
      if(!page.isConnected){
        page.removeAllListeners('request');
        page.isConnected = false;
        await page.goto('about:blank');
        await filterRequests(page, { blockResources, conTimeout, url }, debug);
        res = page.goto(url, { waitUntil: wait || waitUntil || 'networkidle2', timeout: timeout || 30000 });
        await new Promise( resolve => setTimeout(resolve, conTimeout) );
      }
      
      if(num <= 0){
        throw new Error('No connection');
      }
    }

    debug && console.log('[MATCHER] Connected', page.isConnected);
    return res;
    
  }
  
  // Puppeteer Crawler predefined helper methods
  async function gotoFunction({ request, page, puppeteerPool }, extras = {}){
    const { url, userData } = request;
    const { pageMatcherSettings, requestQueue } = extras;
    
    const client = await page.target().createCDPSession();
    const match = await getPageMatchSettings(pageMatcherSettings, request);
    const { err, msg, clearCookies, timeout, wait, blockResources, disableJs, disableCache, noRedirects, conTimeout, debug, viewport } = match;
    const cookieData = generateCookies(match.cookies || extras.cookies, request);
    
    // These settings can be specified for every page or for pageMatcher
    if(err)
      throw(err);
    
    // Hide the puppeteer
    await makePageUndetectable(page);
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
    
    // intercept requests
    
    console.log('[MATCHER] Opening', trunc(request.url, 150, true));
    console.time('[MATCHER] Opened ' + trunc(request.url, 150, true));
    
    if(clearCookies && !cookieData)
      await client.send( 'Network.clearBrowserCookies' );
    
    return getResponse({ request, page, match });
  }

  async function handlePageFunction(data, extras = {}){
    
    const { pageMatcherSettings, requestQueue, evaluate } = extras;
    
    if(pageMatcherSettings)
      data.match = await getPageMatchSettings(pageMatcherSettings, data.request);
    
    let result;
    
    if(data.match){
      
      if(typeof data.match.check === 'function'){
        const checkRes = await data.match.check(data, extras);
        if(!checkRes) return;
      }
      
      if(!data.match.disableCaptchaCheck && await checkCaptcha(data.page))
        return await retireAndReclaim(data, requestQueue, 'CAPTCHA');
        
      if(!data.match.disableStatusCheck && ~[403].indexOf(data.response.status()))
        return await retireAndReclaim(data, requestQueue, 'STATUS ' + data.response.status());
        
      result = await pageMatcherResult(data, requestQueue);
    }
      
    
    console.timeEnd('[MATCHER] Opened ' + trunc(data.request.url, 150, true));
    
    // if(evaluate)
    //   result = await evaluate(data);
    
    return result;
  }
  
  async function isFinishedFunction(func){
    const delayTime = 10000;
    
    if(global.allowTurnOff){
      func && await func();
      console.log('[MATCHER] Actor Done');
      return true;
    }
    
    await new Promise(res => setTimeout(res, delayTime));
    console.log('[MATCHER] Delay actors turn off time by', (delayTime/1000) + 's');
    global.allowTurnOff = true;
    return;
  }
  
  async function retireAndReclaim({ page, puppeteerPool, request }, requestQueue, debug){
    const browser = await page.browser();
    await puppeteerPool.retire(browser);
    await reclaimRequest(request, requestQueue);
    debug && console.log(debug);
    return;
  }
  
  function modifyResult(result, modify, userData, page){
    // console.log({ result, modify, userData });
    switch(typeof modify){
      case 'function':
        return modify(result, userData); 
      case 'object':
        Object.keys(modify).forEach( key => {
          
          result[key] = typeof modify[key] === 'function'
            ? modify[key](result[key], result, userData, page) || result[key] || null
            : result[key] = result[key] || modify[key];
            
        });
        return result;
      default:
        return result;
    }
  }
  
  function startPuppeteerMatcher(config){
    
      return async () => {
        // Configs
        const INPUT   = await Apify.getValue('INPUT');
        config = typeof config === 'function' ? await config(Apify, { INPUT }) : config;
        
        config.puppteer = config.puppteer || {
          headless: true,
          useChrome: false,
          userAgent: await Apify.utils.getRandomUserAgent(),
          ignoreHTTPSErrors: true,
          useApifyProxy: true,
          apifyProxyGroups: [ 'BUYPROXIES94952' ],
        }
        
        config.crawler = config.crawler || {
          maxRequestRetries: 1,
          retireInstanceAfterRequestCount: 10,
          minConcurrency: INPUT.minConcurrency || INPUT.concurrency || 2,
          maxConcurrency: INPUT.maxConcurrency || INPUT.concurrency || 5,
          handlePageTimeoutSecs: 3000,
          launchPuppeteerOptions: config.puppteer
        }
        
        // Variables
        const { limit } = INPUT;
        const { startUrls, cookies, webhook } = config.main;
        
        // Requests
        const requestQueue = global.requestQueue = await Apify.openRequestQueue();
        queueUrls(startUrls, requestQueue, limit);
        
        // Crawler
        const crawler = new Apify.PuppeteerCrawler({
          requestQueue,
          ...config.crawler,
          handlePageFunction: async data => await handlePageFunction(data, { pageMatcherSettings: config.matcher, requestQueue }),
          gotoFunction: async data => await gotoFunction(data, { pageMatcherSettings: config.matcher, requestQueue, cookies }),
          autoscaledPoolOptions: {
            isFinishedFunction: async () => await isFinishedFunction(webhook),
          },
          handleFailedRequestFunction: (data) => {
            console.log('FAILED', { data });
          }
        });
        
        await crawler.run();
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
        debug ? obj[`_${key}`] = rule.map( r => ({ ...ruleToObj(r), rule: r })) : null;
        return Object.assign( obj, { [key]: rule.map( r => stringResult(ruleToObj(r)))});
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
        || lastSelector.includes('meta')    && 'content'
        || lastSelector.includes('input') || lastSelector.includes('option') && 'value'
      return { selector, attr }
    }
    
    function stringResult({ elem, attr, selector }){
      elem = elem || doc.querySelector(selector);
      
      if(!elem)
        return null;
      
      // if(attr === 'nodeValue')
      //   return [ ...elem.childNodes ].filter(el => el.nodeType === 3).map(el => el.textContent);
      
      if(!attr || ~[ 'nodeValue', 'text', 'textContent' ].indexOf(attr))
        return elem.textContent && utilsClearText(elem.textContent);
      
      return elem.getAttribute(attr);
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
      
    if(~text.indexOf('£') || ~text.indexOf('GBP'))
      return 'GBP';
    else if(~text.indexOf('€') || ~text.indexOf('EUR'))
      return 'EUR';
    else if(~text.indexOf('AED'))
      return 'AED';
    
      
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
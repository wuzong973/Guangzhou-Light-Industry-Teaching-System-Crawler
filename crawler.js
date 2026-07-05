const axios = require('axios');
const wrapper = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const cheerio = require('cheerio');
const qs = require('querystring');
const fs = require('fs').promises;
const path = require('path');
const { recognizeCaptcha } = require('./captcha-ocr');

wrapper.wrapper(axios);

/**
 * 广东信息工程职业学院教务系统爬虫
 * 技术栈：Node.js + axios + cheerio + tough-cookie
 *
 * 功能：登录认证、单周课表抓取、多周批量抓取、主动限流、指数退避重试
 */
class JwCrawler {
  constructor(options = {}) {
    this.options = {
      // 统一域名：最新 HAR 确认登录入口和业务页面都在 https://jw.gdipu.edu.cn
      // 旧入口 http://jw.gdip.edu.cn 已 301/302 重定向到 https://jw.gdipu.edu.cn
      baseURL: options.baseURL || 'https://jw.gdipu.edu.cn',

      // 最大重定向次数
      maxRedirects: options.maxRedirects || 5,

      // 请求超时（毫秒）
      timeout: options.timeout ?? 15000,

      // ========== 限流配置 ==========
      // 基础请求间隔（毫秒），每次请求后至少等待
      baseDelay: options.baseDelay ?? 1500,

      // 随机抖动范围（毫秒），实际延迟 = baseDelay + Math.random() * jitter
      jitter: options.jitter ?? 800,

      // 最大重试次数（被限流或网络错误时）
      maxRetries: options.maxRetries ?? 3,

      // 指数退避基数（毫秒），首次重试等待 baseDelay，第二次 baseDelay*2，第三次 baseDelay*4
      retryBackoffBase: options.retryBackoffBase ?? 2000,

      // 是否启用详细日志
      verbose: options.verbose !== undefined ? options.verbose : true,

      // 验证码保存路径；设为 null/false 可不落盘
      captchaPath: options.captchaPath || './captcha.png',

      // 是否启用本地 OCR 自动识别验证码
      useOcr: options.useOcr || false,

      // 验证码识别/输入失败后的最大重新获取次数，默认只尝试一次
      maxCaptchaAttempts: options.maxCaptchaAttempts || 1,

      // OCR 最低置信度。Tesseract 对短验证码的 confidence 经常偏低，默认只校验格式。
      minOcrConfidence: options.minOcrConfidence || 0,

      // 登录失败时保存诊断文件，便于对照浏览器 HAR。
      loginDebugDir: options.loginDebugDir || './login_debug',

      ...options
    };

    // 请求计数（用于限流统计）
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.networkLog = {
      enabled: Boolean(options.recordNetwork),
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.networkRequestSeq = 0;

    // 使用 tough-cookie 管理 Cookie，支持同名的 JSESSIONID 按 Path 区分
    this.jar = new tough.CookieJar();

    this.instance = axios.create({
      baseURL: this.options.baseURL,
      withCredentials: true,
      jar: this.jar,
      // 禁用 axios 自动重定向，手动处理 302
      // 原因：服务端 302 返回 http:// 但浏览器会自动升级为 https://，
      // axios 不会自动升级，导致跟到 HTTP 后会话 Cookie 丢失
      maxRedirects: 0,
      // 接受 3xx 状态码，不当作错误抛出
      validateStatus: (status) => status < 400,
      timeout: this.options.timeout,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0'
      }
    });

    if (this.networkLog.enabled) {
      this.installNetworkRecorder();
    }
  }

  // ==================== 限流工具 ====================

  installNetworkRecorder() {
    this.instance.interceptors.request.use(async (config) => {
      const requestId = ++this.networkRequestSeq;
      const url = this.resolveUrl(config.url, config.baseURL);
      config.metadata = {
        ...(config.metadata || {}),
        requestId,
        startedAt: Date.now(),
        url,
      };

      this.networkLog.events.push({
        type: 'request',
        id: requestId,
        timestamp: new Date().toISOString(),
        method: String(config.method || 'get').toUpperCase(),
        url,
        headers: this.serializeHeaders(config.headers),
        cookieHeader: this.redactSecretText(await this.getCookieHeader(url)),
        body: this.serializeBody(config.data),
      });

      return config;
    });

    this.instance.interceptors.response.use(
      async (response) => {
        await this.recordResponse(response);
        return response;
      },
      async (error) => {
        if (error.response) {
          await this.recordResponse(error.response, error);
        } else {
          const config = error.config || {};
          const metadata = config.metadata || {};
          this.networkLog.events.push({
            type: 'error',
            id: metadata.requestId || ++this.networkRequestSeq,
            timestamp: new Date().toISOString(),
            method: String(config.method || 'get').toUpperCase(),
            url: metadata.url || this.resolveUrl(config.url, config.baseURL),
            code: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    );
  }

  async recordResponse(response, error = null) {
    const config = response.config || {};
    const metadata = config.metadata || {};
    const url = response.request?.res?.responseUrl || metadata.url || this.resolveUrl(config.url, config.baseURL);

    this.networkLog.events.push({
      type: error ? 'response-error' : 'response',
      id: metadata.requestId || ++this.networkRequestSeq,
      timestamp: new Date().toISOString(),
      durationMs: metadata.startedAt ? Date.now() - metadata.startedAt : null,
      method: String(config.method || 'get').toUpperCase(),
      url,
      status: response.status,
      statusText: response.statusText,
      requestHeaders: this.serializeHeaders(config.headers),
      responseHeaders: this.serializeHeaders(response.headers),
      setCookie: '[redacted]',
      cookiesAfterResponse: await this.getCookiesForUrl(url),
      body: this.serializeBody(response.data),
      error: error ? { code: error.code, message: error.message } : undefined,
    });
  }

  resolveUrl(url = '', baseURL = this.options.baseURL) {
    try {
      return new URL(url, baseURL || this.options.baseURL).toString();
    } catch (err) {
      return String(url || '');
    }
  }

  serializeHeaders(headers = {}) {
    const result = {};
    if (!headers) return result;

    const plainHeaders = typeof headers.toJSON === 'function' ? headers.toJSON() : headers;
    for (const [key, value] of Object.entries(plainHeaders)) {
      if (value === undefined) continue;
      const lowerKey = String(key).toLowerCase();
      if (['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(lowerKey)) {
        result[key] = '[redacted]';
        continue;
      }
      result[key] = Array.isArray(value) ? value.map(item => this.redactSecretText(String(item))) : this.redactSecretText(String(value));
    }
    return result;
  }

  serializeBody(data) {
    if (data === undefined || data === null) {
      return null;
    }

    if (Buffer.isBuffer(data)) {
      return {
        encoding: 'base64',
        byteLength: data.length,
        value: data.toString('base64'),
      };
    }

    if (data instanceof ArrayBuffer) {
      const buffer = Buffer.from(data);
      return {
        encoding: 'base64',
        byteLength: buffer.length,
        value: buffer.toString('base64'),
      };
    }

    if (ArrayBuffer.isView(data)) {
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      return {
        encoding: 'base64',
        byteLength: buffer.length,
        value: buffer.toString('base64'),
      };
    }

    if (typeof data === 'string') {
      return {
        encoding: 'utf8',
        charLength: data.length,
        value: this.redactSecretText(data),
      };
    }

    return {
      encoding: 'json',
      value: this.redactSecretValue(data),
    };
  }

  redactSecretValue(value) {
    if (Array.isArray(value)) {
      return value.map(item => this.redactSecretValue(item));
    }

    if (value && typeof value === 'object') {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (/password|passwd|pwd|encoded|randomcode|captcha|cookie|authorization|token|secret/i.test(key)) {
          result[key] = '[redacted]';
        } else {
          result[key] = this.redactSecretValue(item);
        }
      }
      return result;
    }

    if (typeof value === 'string') {
      return this.redactSecretText(value);
    }

    return value;
  }

  redactSecretText(value) {
    let text = String(value || '');
    text = text.replace(/(userPassword|password|passwd|pwd|encoded|RANDOMCODE|captcha|token|secret)=([^&\s]+)/gi, '$1=[redacted]');
    text = text.replace(/(Cookie|Authorization|Set-Cookie):\s*[^\r\n]+/gi, '$1: [redacted]');
    return text;
  }

  async getCookieHeader(url) {
    try {
      return await this.jar.getCookieString(url);
    } catch (err) {
      return '';
    }
  }

  async getCookiesForUrl(url) {
    try {
      const cookies = await this.jar.getCookies(url);
      return cookies.map(cookie => ({
        key: cookie.key,
        value: '[redacted]',
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires instanceof Date ? cookie.expires.toISOString() : String(cookie.expires),
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
      }));
    } catch (err) {
      return [];
    }
  }

  getNetworkLog() {
    return {
      ...this.networkLog,
      endedAt: new Date().toISOString(),
      requestCount: this.networkRequestSeq,
    };
  }

  async saveNetworkLog(filePath) {
    const log = this.getNetworkLog();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(log, null, 2), 'utf-8');
    return log;
  }

  /**
   * 暂停指定毫秒
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 主动限流：每次请求前调用，确保请求间隔
   */
  async throttle() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const minDelay = this.options.baseDelay + Math.random() * this.options.jitter;
    const waitTime = Math.max(0, minDelay - elapsed);

    if (waitTime > 0 && this.lastRequestTime > 0) {
      if (this.options.verbose) {
        console.log(`  [限流] 等待 ${Math.round(waitTime)}ms...`);
      }
      await this.sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  /**
   * 带重试和指数退避的请求包装器
   * 自动处理 3xx 重定向，把 http:// 升级为 https://
   * @param {Function} requestFn 返回 axios Promise 的请求函数
   * @param {string} label 请求描述（用于日志）
   */
  async requestWithRetry(requestFn, label = '请求') {
    let lastError;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoff = this.options.retryBackoffBase * Math.pow(2, attempt - 1);
          const jitter = Math.random() * 500;
          const waitTime = backoff + jitter;
          console.log(`  [重试] ${label} 第 ${attempt} 次重试，等待 ${Math.round(waitTime)}ms...`);
          await this.sleep(waitTime);
        }

        await this.throttle();
        let res = await requestFn();
        let currentUrl = this.getResponseUrl(res);
        await this.storeResponseCookies(res, currentUrl);

        // 手动跟随 3xx 重定向（把 http:// 升级为 https://）
        let redirectCount = 0;
        while (res.status >= 300 && res.status < 400 && res.headers.location) {
          redirectCount++;
          if (redirectCount > this.options.maxRedirects) {
            throw new Error('重定向次数超过限制');
          }

          let nextUrl = this.normalizeRedirectUrl(res.headers.location, currentUrl);

          if (this.options.verbose) {
            console.log(`  [重定向] ${res.status} → ${nextUrl}`);
          }

          await this.throttle();
          res = await this.instance.get(nextUrl, {
            responseType: res.config?.responseType,
            headers: this.buildRedirectHeaders(nextUrl, currentUrl),
          });
          currentUrl = this.getResponseUrl(res, nextUrl);
          await this.storeResponseCookies(res, currentUrl);
        }

        if (this.options.verbose) {
          const size = typeof res.data === 'string' ? res.data.length : (res.data ? res.data.byteLength || '?' : 0);
          console.log(`  [${res.status}] ${label} (${size} bytes)`);
        }

        return res;
      } catch (err) {
        lastError = err;

        const isRetryable = this.isRetryableError(err);
        if (!isRetryable || attempt >= this.options.maxRetries) {
          throw err;
        }

        console.warn(`  [警告] ${label} 失败: ${err.message}，准备重试...`);
      }
    }

    throw lastError;
  }

  getResponseUrl(res, fallback = '') {
    const rawUrl = res.request?.res?.responseUrl || res.config?.url || fallback || this.options.baseURL;
    try {
      return new URL(rawUrl, this.options.baseURL).toString();
    } catch (err) {
      return this.options.baseURL;
    }
  }

  normalizeRedirectUrl(location, currentUrl = this.options.baseURL) {
    let nextUrl = new URL(location, currentUrl).toString();

    // 旧域名统一到当前域名；jw.gdipu.edu.cn 返回的 http 跳转保持原样，
    // 强智 LoginToXk ticket 在 HTTP 入口上完成子系统会话初始化。
    if (nextUrl.startsWith('http://jw.gdip.edu.cn')) {
      nextUrl = nextUrl.replace('http://jw.gdip.edu.cn', 'https://jw.gdipu.edu.cn');
    }

    return nextUrl;
  }

  buildRedirectHeaders(nextUrl, currentUrl) {
    const headers = {
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Microsoft Edge";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    };

    try {
      const next = new URL(nextUrl, this.options.baseURL);
      const current = new URL(currentUrl, this.options.baseURL);

      if (next.pathname.includes('/jsxsd/xk/LoginToXk') ||
        next.pathname.includes('/jsxsd/framework/xsMain.jsp')) {
        headers['Sec-Fetch-Dest'] = 'document';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = next.origin === current.origin ? 'same-origin' : 'cross-site';
        headers['Sec-Fetch-User'] = '?1';
        return headers;
      }

      headers.Referer = currentUrl;
      return headers;
    } catch (err) {
      headers.Referer = currentUrl;
      return headers;
    }
  }

  async storeResponseCookies(res, currentUrl) {
    const setCookie = res.headers?.['set-cookie'];
    if (!setCookie) return;

    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of cookies) {
      await this.jar.setCookie(cookie, currentUrl);
    }
  }

  async debugCookies(label = 'Cookie') {
    if (!this.options.verbose) return;

    const cookies = await this.jar.getCookies(this.options.baseURL);
    const jsxsdCookies = await this.jar.getCookies(`${this.options.baseURL}/jsxsd/framework/xsMain.jsp`);
    console.log(`[调试] ${label} /: ${cookies.map(c => `${c.key}@${c.path}`).join(', ') || '(空)'}`);
    console.log(`[调试] ${label} /jsxsd: ${jsxsdCookies.map(c => `${c.key}@${c.path}`).join(', ') || '(空)'}`);
  }

  async getCookieDiagnostics() {
    const urls = [
      this.options.baseURL,
      `${this.options.baseURL}/Logon.do?method=logon`,
      `${this.options.baseURL}/jsxsd/xk/LoginToXk`,
      `${this.options.baseURL}/jsxsd/framework/xsMain.jsp`,
    ];

    const lines = [];
    for (const url of urls) {
      const cookies = await this.jar.getCookies(url);
      const cookieString = await this.jar.getCookieString(url);
      lines.push(`URL: ${url}`);
      lines.push(`Cookie header: ${this.maskCookieHeader(cookieString) || '(empty)'}`);
      for (const cookie of cookies) {
        lines.push(`  - ${cookie.key}@${cookie.domain || 'host'}${cookie.path}=${this.maskValue(cookie.value)}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  maskValue(value, visible = 4) {
    const text = String(value || '');
    if (text.length <= visible * 2) return '*'.repeat(Math.max(text.length, 1));
    return `${text.slice(0, visible)}...${text.slice(-visible)}`;
  }

  maskAccount(account) {
    const text = String(account || '');
    if (text.length <= 4) return this.maskValue(text, 1);
    return `${text.slice(0, 4)}***${text.slice(-3)}`;
  }

  maskCookieHeader(header) {
    return String(header || '').replace(/=([^;]+)/g, (_, value) => `=${this.maskValue(value)}`);
  }

  maskEncoded(encoded) {
    const text = String(encoded || '');
    if (!text) return '(空)';
    return `${this.maskValue(text, 8)} (len=${text.length})`;
  }

  async saveLoginDebug(html, meta = {}) {
    const dir = this.options.loginDebugDir;
    if (!dir) return;

    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlPath = path.join(dir, `login_failed_${stamp}.html`);
    const metaPath = path.join(dir, `login_failed_${stamp}.txt`);

    await fs.writeFile(htmlPath, html || '', 'utf-8');
    const metaText = [
      `time=${new Date().toISOString()}`,
      `finalUrl=${meta.finalUrl || ''}`,
      `status=${meta.status || ''}`,
      `factorLength=${meta.factorLength || 0}`,
      `encodedLength=${meta.encodedLength || 0}`,
      '',
      await this.getCookieDiagnostics(),
    ].join('\n');
    await fs.writeFile(metaPath, metaText, 'utf-8');

    console.log(`[调试] 登录失败页已保存: ${path.resolve(htmlPath)}`);
    console.log(`[调试] Cookie 诊断已保存: ${path.resolve(metaPath)}`);
  }

  /**
   * 判断错误是否可重试
   */
  isRetryableError(err) {
    // 网络错误（超时、连接重置、DNS）
    if (err.code === 'ECONNRESET' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNABORTED' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'EPIPE') {
      return true;
    }

    // HTTP 429 / 503 / 502
    if (err.response) {
      const status = err.response.status;
      return status === 429 || status === 503 || status === 502;
    }

    return false;
  }

  // ==================== 登录流程 ====================

  /**
   * 步骤1：访问登录页，初始化 JSESSIONID / acw_tc / SERVERID
   *
   * 注意：acw_tc 有效期约 10 分钟，整个登录流程需要在此时间内完成
   */
  async initLoginPage() {
    const res = await this.requestWithRetry(
      () => this.instance.get('/Logon.do?method=logon'),
      '初始化登录页'
    );
    return res.data;
  }

  /**
   * 步骤2：获取验证码图片
   * @param {string} savePath - 验证码保存路径，默认 ./captcha.png
   * @returns {Buffer} 验证码图片二进制数据
   */
  async getCaptcha(savePath = './captcha.png') {
    const res = await this.requestWithRetry(
      () => this.instance.get('/verifycode.servlet?t=' + Date.now(), {
        responseType: 'arraybuffer'
      }),
      '获取验证码'
    );

    if (savePath) {
      await fs.writeFile(savePath, res.data);
    }

    return res.data;
  }

  async initJsxsdLoginPage() {
    const res = await this.requestWithRetry(
      () => this.instance.get('/jsxsd/framework/xsMain.jsp'),
      '初始化教务子系统登录页'
    );
    return res.data;
  }

  async getJsxsdCaptcha(savePath = './captcha.png') {
    const res = await this.requestWithRetry(
      () => this.instance.get('/jsxsd/verifycode.servlet?t=' + Math.random(), {
        responseType: 'arraybuffer'
      }),
      '获取教务子系统验证码'
    );

    if (savePath) {
      await fs.writeFile(savePath, res.data);
    }

    return res.data;
  }

  /**
   * 步骤3：获取密码加密因子
   * @returns {string} 格式：scode#sxh
   */
  async getEncryptFactor() {
    const res = await this.requestWithRetry(
      () => this.instance.post('/Logon.do?method=logon&flag=sess', '', {
        headers: {
          'Accept': 'text/plain, */*; q=0.01',
          'Content-Length': 0,
          'Origin': this.options.baseURL,
          'Referer': `${this.options.baseURL}/`,
          'X-Requested-With': 'XMLHttpRequest',
        }
      }),
      '获取加密因子'
    );
    return res.data;
  }

  /**
   * 初始化一次完整登录挑战：同一会话内获取登录页、验证码和加密因子
   */
  async createLoginChallenge(options = {}) {
    const captchaPath = options.captchaPath !== undefined ? options.captchaPath : this.options.captchaPath;

    await this.initLoginPage();
    const captchaBuffer = await this.getCaptcha(captchaPath);

    let factor = '';
    try {
      factor = await this.getEncryptFactor();
    } catch (err) {
      console.warn('[警告] 获取加密因子失败，使用回退加密方式');
    }

    return {
      captchaBuffer,
      captchaPath,
      factor,
    };
  }

  /**
   * 使用本地 OCR 识别验证码。识别不满足 4 位小写字母/数字时返回 valid=false。
   */
  async recognizeCaptcha(input, options = {}) {
    const result = await recognizeCaptcha(input, {
      verbose: options.verbose !== undefined ? options.verbose : false,
      expectedLength: options.expectedLength || 4,
      minConfidence: options.minConfidence || this.options.minOcrConfidence,
    });

    if (this.options.verbose) {
      const confidence = Number.isFinite(result.confidence) ? result.confidence.toFixed(1) : '未知';
      console.log(`[OCR] 原始="${result.rawText.trim()}" 规整="${result.text}" 置信度=${confidence}`);
    }

    return result;
  }

  /**
   * 前端加密算法转 Node.js
   *
   * 真实逻辑：
   * 1. 调用 POST /Logon.do?method=logon&flag=sess 获取 scode#sxh
   * 2. code = userAccount + '%%%' + userPassword
   * 3. 按 sxh 每位数字从 scode 中取相应长度字符，插入到 code 的字符之间
   */
  encryptPassword(userAccount, userPassword, scode = '', sxh = '') {
    try {
      let code = userAccount + '%%%' + userPassword;
      let encoded = '';

      for (let i = 0; i < code.length; i++) {
        const step = parseInt((sxh || '').substring(i, i + 1) || '0', 10);
        if (i < 20) {
          encoded += code.substring(i, i + 1) + scode.substring(0, step);
          scode = scode.substring(step);
        } else {
          // sxh 只有 20 位，超出后直接追加剩余 code
          encoded += code.substring(i);
          break;
        }
      }

      return encoded;
    } catch (e) {
      console.warn('[警告] 加密异常，使用回退方式:', e.message);
      try {
        const a = Buffer.from(String(userAccount)).toString('base64');
        const p = Buffer.from(String(userPassword)).toString('base64');
        return `${a}%%%${p}`;
      } catch (err) {
        return '';
      }
    }
  }

  buildLoginForm(userAccount, userPassword, randomCode, factor = '') {
    const [scode, sxh] = (factor || '').split('#');
    const encoded = this.encryptPassword(userAccount, userPassword, scode, sxh);

    if (this.options.verbose) {
      console.log('[调试] 加密因子:', factor || '(空)');
      console.log('[调试] encoded:', this.maskEncoded(encoded));
    }

    return {
      encoded,
      body: qs.stringify({
        userAccount: '',         // 前端 JS 会在提交前清空账号密码字段
        userPassword: '',
        RANDOMCODE: randomCode,
        encoded,
      }),
    };
  }

  encodeInp(value) {
    return Buffer.from(String(value || ''), 'utf-8').toString('base64');
  }

  buildJsxsdLoginForm(userAccount, userPassword, randomCode) {
    let password = String(userPassword || '');
    let pwdstr1 = '';
    let pwdstr2 = '';

    for (let i = 0; i < password.length; i++) {
      if (password.charAt(i) === '。') {
        password = password.substring(0, i) + '.' + password.substring(i + 1);
        pwdstr1 += `${i},`;
      } else if (password.charAt(i) === '，') {
        password = password.substring(0, i) + ',' + password.substring(i + 1);
        pwdstr2 += `${i},`;
      }
    }

    const encoded = `${this.encodeInp(userAccount)}%%%${this.encodeInp(password)}`;

    if (this.options.verbose) {
      console.log('[调试] 子系统 encoded:', this.maskEncoded(encoded));
    }

    return {
      encoded,
      body: qs.stringify({
        userAccount,
        userPassword: '',
        RANDOMCODE: randomCode,
        encoded,
        pwdstr1,
        pwdstr2,
      }),
    };
  }

  /**
   * 步骤4：提交登录。
   *
   * 注意：调用此方法前应先用 createLoginChallenge() 获取验证码，保证验证码和 Cookie 属于同一会话。
   */
  async submitLogin(userAccount, userPassword, randomCode, factor = '') {
    console.log(`[登录] 账号 ${this.maskAccount(userAccount)} 开始登录...`);

    const formData = this.buildLoginForm(userAccount, userPassword, randomCode, factor);

    const res = await this.requestWithRetry(
      () => this.instance.post('/Logon.do?method=logon', formData.body, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': this.options.baseURL,
          'Referer': `${this.options.baseURL}/`,
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'sec-ch-ua': '"Microsoft Edge";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
        }
      }),
      '提交登录'
    );

    // 登录接口返回 302，axios 默认会跟随重定向
    console.log('[调试] 登录响应最终URL:', res.request?.res?.responseUrl || '未知');

    const html = typeof res.data === 'string' ? res.data : '';
    await this.debugCookies('登录后');

    // 检查登录是否成功
    if (html.includes('该账号不存在或密码错误') ||
      html.includes('验证码错误') ||
      html.includes('请输入账号') ||
      html.includes('请输入密码') ||
      html.includes('请输入验证码') ||
      html.includes('请先登录系统')) {
      await this.saveLoginDebug(html, {
        finalUrl: res.request?.res?.responseUrl || this.getResponseUrl(res),
        status: res.status,
        factorLength: String(factor || '').length,
        encodedLength: formData.encoded.length,
      });
      const $ = cheerio.load(html);
      const errMsg = $('#showMsg').text().trim() || $('body').text().replace(/\s+/g, ' ').trim() || '未知错误';
      throw new Error(`登录失败: ${errMsg}`);
    }

    // 检查最终是否到达首页或教务系统内部页面
    const finalUrl = res.request?.res?.responseUrl || '';
    if (finalUrl.includes('xsMain.jsp') ||
      finalUrl.includes('xsMain_new.jsp') ||
      html.includes('xsMain.jsp') ||
      html.includes('教学一体化服务平台')) {
      console.log('[登录] 成功');
      return res.data;
    }

    console.warn('[登录] 未检测到明确登录成功标记，返回结果可能为重定向页面');
    return res.data;
  }

  async submitJsxsdLogin(userAccount, userPassword, randomCode) {
    console.log(`[登录] 账号 ${this.maskAccount(userAccount)} 开始登录教务子系统...`);

    const formData = this.buildJsxsdLoginForm(userAccount, userPassword, randomCode);
    const res = await this.requestWithRetry(
      () => this.instance.post('/jsxsd/xk/LoginToXk', formData.body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': this.options.baseURL,
          'Referer': `${this.options.baseURL}/jsxsd/framework/xsMain.jsp`,
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
        }
      }),
      '提交教务子系统登录'
    );

    const html = typeof res.data === 'string' ? res.data : '';
    await this.debugCookies('子系统登录后');

    if (html.includes('教学一体化服务平台') ||
      html.includes('/jsxsd/framework/xsMain_new.jsp') ||
      html.includes('LogoutGLD') ||
      html.includes('我的课表')) {
      console.log('[登录] 教务子系统登录成功');
      return res.data;
    }

    if (html.includes('该账号不存在或密码错误') ||
      html.includes('验证码错误') ||
      html.includes('请输入账号') ||
      html.includes('请输入密码') ||
      html.includes('请输入验证码') ||
      html.includes('请先登录系统')) {
      await this.saveLoginDebug(html, {
        finalUrl: res.request?.res?.responseUrl || this.getResponseUrl(res),
        status: res.status,
        encodedLength: formData.encoded.length,
      });
      const $ = cheerio.load(html);
      const errMsg = $('#showMsg').text().trim() || $('body').text().replace(/\s+/g, ' ').trim() || '未知错误';
      throw new Error(`教务子系统登录失败: ${errMsg}`);
    }

    console.warn('[登录] 未检测到明确教务子系统登录成功标记，返回结果可能需要人工核对');
    return res.data;
  }

  /**
   * 兼容旧调用：手动传入验证码时，默认会初始化登录页并获取加密因子。
   * 如果验证码已由 createLoginChallenge() 获取，请传入 { skipInit: true, factor }。
   */
  async login(userAccount, userPassword, randomCode, options = {}) {
    let factor = options.factor || '';

    if (!options.skipInit) {
      await this.initLoginPage();
      try {
        factor = await this.getEncryptFactor();
      } catch (err) {
        console.warn('[警告] 获取加密因子失败，使用回退加密方式');
      }
    }

    return this.submitLogin(userAccount, userPassword, randomCode, factor);
  }

  /**
   * 自动完成验证码获取、OCR/人工输入和登录。
   */
  async loginWithCaptcha(userAccount, userPassword, options = {}) {
    const {
      useOcr = this.options.useOcr,
      captchaPath = this.options.captchaPath,
      manualCaptcha,
      promptCaptcha,
      maxCaptchaAttempts = this.options.maxCaptchaAttempts,
    } = options;

    let lastError;
    const attempts = Math.max(1, maxCaptchaAttempts);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        console.log(`[验证码] 第 ${attempt}/${attempts} 次重新获取验证码...`);
      }

      const challenge = await this.createLoginChallenge({ captchaPath });
      let randomCode = manualCaptcha ? String(manualCaptcha).trim().toLowerCase() : '';

      if (!randomCode && useOcr) {
        const ocrResult = await this.recognizeCaptcha(challenge.captchaBuffer);
        const confidenceOk = !ocrResult.minConfidence || !Number.isFinite(ocrResult.confidence) || ocrResult.confidence >= ocrResult.minConfidence;
        if (ocrResult.valid && confidenceOk) {
          randomCode = ocrResult.text;
          console.log(`[验证码] OCR 识别结果：${randomCode}`);
        } else {
          console.warn('[验证码] OCR 未得到可信的 4 位结果');
        }
      }

      if (!randomCode && typeof promptCaptcha === 'function') {
        if (captchaPath) {
          console.log(`[验证码] 图片已保存到 ${captchaPath}`);
        }
        randomCode = String(await promptCaptcha(challenge)).trim().toLowerCase();
      }

      if (!/^[a-z0-9]{4}$/.test(randomCode)) {
        throw new Error('验证码必须是 4 位小写字母/数字');
      }

      try {
        return await this.submitLogin(userAccount, userPassword, randomCode, challenge.factor);
      } catch (err) {
        lastError = err;
        if (!/验证码/.test(err.message) || attempt >= attempts) {
          throw err;
        }
        console.warn(`[验证码] ${err.message}，准备重新获取验证码`);
      }
    }

    throw lastError;
  }

  async loginJsxsdWithCaptcha(userAccount, userPassword, options = {}) {
    const {
      useOcr = this.options.useOcr,
      captchaPath = this.options.captchaPath,
      manualCaptcha,
      promptCaptcha,
      maxCaptchaAttempts = this.options.maxCaptchaAttempts,
    } = options;

    let lastError;
    const attempts = Math.max(1, maxCaptchaAttempts);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        console.log(`[验证码] 第 ${attempt}/${attempts} 次重新获取子系统验证码...`);
      }

      await this.initJsxsdLoginPage();
      const captchaBuffer = await this.getJsxsdCaptcha(captchaPath);
      let randomCode = manualCaptcha ? String(manualCaptcha).trim().toLowerCase() : '';

      if (!randomCode && useOcr) {
        const ocrResult = await this.recognizeCaptcha(captchaBuffer);
        const confidenceOk = !ocrResult.minConfidence || !Number.isFinite(ocrResult.confidence) || ocrResult.confidence >= ocrResult.minConfidence;
        if (ocrResult.valid && confidenceOk) {
          randomCode = ocrResult.text;
          console.log(`[验证码] OCR 识别结果：${randomCode}`);
        } else {
          console.warn('[验证码] OCR 未得到可信的 4 位结果');
        }
      }

      if (!randomCode && typeof promptCaptcha === 'function') {
        if (captchaPath) {
          console.log(`[验证码] 图片已保存到 ${captchaPath}`);
        }
        randomCode = String(await promptCaptcha({ captchaBuffer, captchaPath })).trim().toLowerCase();
      }

      if (!/^[a-z0-9]{4}$/.test(randomCode)) {
        throw new Error('验证码必须是 4 位小写字母/数字');
      }

      try {
        return await this.submitJsxsdLogin(userAccount, userPassword, randomCode);
      } catch (err) {
        lastError = err;
        if (!/验证码/.test(err.message) || attempt >= attempts) {
          throw err;
        }
        console.warn(`[验证码] ${err.message}，准备重新获取验证码`);
      }
    }

    throw lastError;
  }

  // ==================== 课表抓取 ====================

  /**
   * 获取课表主页，提取 sjmsValue
   */
  async getSchedulePage() {
    const res = await this.requestWithRetry(
      () => this.instance.get('/jsxsd/framework/xsMain_new.jsp?t1=1', {
        headers: {
          'Referer': `${this.options.baseURL}/jsxsd/framework/xsMain.jsp`
        }
      }),
      '获取课表主页'
    );
    return res.data;
  }

  /**
   * 获取课表原始 HTML（不解析）
   */
  async getScheduleRaw(rq, extraParams = {}) {
    const pageHtml = await this.getSchedulePage();
    const $page = cheerio.load(pageHtml);
    const sjmsValue = $page('#sjms').val();

    if (!sjmsValue) {
      throw new Error('无法从课表主页提取 sjmsValue，可能未登录或登录已过期');
    }

    const params = { rq, sjmsValue, ...extraParams };

    const res = await this.requestWithRetry(
      () => this.instance.post('/jsxsd/framework/main_index_loadkb.jsp', qs.stringify(params), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': `${this.options.baseURL}/jsxsd/framework/xsMain_new.jsp?t1=1`,
          'X-Requested-With': 'XMLHttpRequest'
        }
      }),
      `课表数据 ${rq}`
    );

    return res.data;
  }

  /**
   * 获取并解析单周课表
   */
  async getSchedule(rq = this.formatDate(new Date()), extraParams = {}) {
    const html = await this.getScheduleRaw(rq, extraParams);
    return this.parseSchedule(html);
  }

  /**
   * 批量抓取多周课表
   * @param {string[]} dates 日期数组，格式 ['2026-07-01', '2026-07-08', ...]
   * @param {object} options 选项
   * @param {boolean} options.saveRaw 是否保存原始 HTML 到文件
   * @param {string} options.saveDir 原始 HTML 保存目录
   */
  async getScheduleBatch(dates, options = {}) {
    const { saveRaw = true, saveDir = './schedule_samples' } = options;
    const results = [];

    if (saveRaw) {
      try { await fs.mkdir(saveDir, { recursive: true }); } catch (e) { }
    }

    console.log(`\n[批量抓取] 共 ${dates.length} 周，预计耗时 ${Math.round(dates.length * (this.options.baseDelay + this.options.jitter) / 1000)}s`);
    console.log(`[限流] 基础间隔 ${this.options.baseDelay}ms + 随机抖动 0~${this.options.jitter}ms\n`);

    for (let i = 0; i < dates.length; i++) {
      const rq = dates[i];
      console.log(`[${i + 1}/${dates.length}] 抓取 ${rq}...`);

      try {
        const html = await this.getScheduleRaw(rq);
        const courses = this.parseSchedule(html);

        results.push({ rq, courses, courseCount: courses.length });

        if (saveRaw) {
          const safeName = rq.replace(/-/g, '');
          await fs.writeFile(`${saveDir}/kb_${safeName}.html`, html);
          console.log(`  -> 解析到 ${courses.length} 门课，HTML 已保存`);
        } else {
          console.log(`  -> 解析到 ${courses.length} 门课`);
        }
      } catch (err) {
        console.error(`  [错误] ${rq}: ${err.message}`);
        results.push({ rq, courses: [], courseCount: 0, error: err.message });
      }
    }

    return results;
  }

  // ==================== 课表解析 ====================

  /**
   * 解析课表 HTML 为结构化数组
   */
  parseSchedule(html) {
    const $ = cheerio.load(html);
    const courses = [];
    const weekDays = ['节次', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

    $('#tab1 tbody tr').each((rowIndex, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 8) return;

      const timeSlotText = $(cells[0]).text().trim().replace(/\s+/g, ' ');
      const timeSlotInfo = this.parseTimeSlot(timeSlotText);

      cells.slice(1).each((colIndex, td) => {
        const $td = $(td);
        const cellHtml = $td.html().trim();

        if (!cellHtml || cellHtml === '' || cellHtml === '&nbsp;') return;

        const $p = $td.find('p');
        if ($p.length === 0) return;

        const title = $p.attr('title') || '';
        const courseInfo = this.parseCourseTitle(title);

        courses.push({
          weekDay: weekDays[colIndex + 1],
          weekDayIndex: colIndex + 1,
          ...timeSlotInfo,
          ...courseInfo,
          rawTitle: title
        });
      });
    });

    return courses;
  }

  parseTimeSlot(text) {
    const lines = text.split(' ').map(s => s.trim()).filter(Boolean);
    const result = {
      sectionRange: '',
      sections: '',
      timeRange: '',
      startSection: null,
      endSection: null,
      startTime: '',
      endTime: ''
    };

    for (const line of lines) {
      if (line.includes('小节')) {
        result.sections = line;
      } else if (line.includes(':') && line.includes('-')) {
        result.timeRange = line;
        const [start, end] = line.split('-');
        result.startTime = start.trim();
        result.endTime = end.trim();
      } else if (/^\d+(-\d+)?$/.test(line)) {
        result.sectionRange = line;
        const parts = line.split('-');
        result.startSection = parseInt(parts[0], 10);
        result.endSection = parseInt(parts[1] || parts[0], 10);
      }
    }

    return result;
  }

  parseCourseTitle(title) {
    const lines = title.split(/<br\s*\/?>/i).map(line => line.trim()).filter(Boolean);
    const map = {};

    for (const line of lines) {
      const separatorIndex = line.indexOf('：');
      if (separatorIndex > -1) {
        const key = line.substring(0, separatorIndex).trim();
        const value = line.substring(separatorIndex + 1).trim();
        map[key] = value;
      }
    }

    return {
      courseName: map['课程名称'] || '',
      credits: map['课程学分'] || '',
      attribute: map['课程属性'] || '',
      courseTime: map['上课时间'] || '',
      location: map['上课地点'] || '',
      campus: map['上课校区'] || '',
      groupName: map['分组名'] || ''
    };
  }

  // ==================== 工具方法 ====================

  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 生成一个学期的每周一日期列表
   * @param {string} semesterStart 学期第一周周一的日期 YYYY-MM-DD
   * @param {number} totalWeeks 总周数
   */
  static generateWeekDates(semesterStart, totalWeeks) {
    const dates = [];
    const start = new Date(semesterStart);
    for (let i = 0; i < totalWeeks; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i * 7);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.push(`${year}-${month}-${day}`);
    }
    return dates;
  }

  /**
   * 测试：解析本地 kb.html
   */
  async testParseLocal(filePath = './kb.html') {
    const html = await fs.readFile(filePath, 'utf-8');
    const courses = this.parseSchedule(html);
    console.log(`共解析到 ${courses.length} 门课程：\n`);
    console.log(JSON.stringify(courses, null, 2));
    return courses;
  }
}

module.exports = JwCrawler;

function parseCliArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;

    const raw = item.slice(2);
    const eqIndex = raw.indexOf('=');
    if (eqIndex > -1) {
      args[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1);
      continue;
    }

    if (raw.startsWith('no-')) {
      args[raw.slice(3)] = false;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[raw] = next;
      i++;
    } else {
      args[raw] = true;
    }
  }

  return args;
}

function readBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function ask(question) {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    readline.question(question, answer => {
      readline.close();
      resolve(answer);
    });
  });
}

function printUsage() {
  console.log(`
用法：
  node crawler.js --parse-only
  node crawler.js --account <学号> --password <密码> --ocr

环境变量：
  JW_ACCOUNT          学号
  JW_PASSWORD         密码
  JW_USE_OCR=1        启用本地 OCR 自动识别验证码
  JW_CAPTCHA          手动指定验证码（通常只用于调试）
  JW_CAPTCHA_ATTEMPTS OCR/验证码错误后重新获取验证码的次数，默认 1
  JW_OCR_MIN_CONFIDENCE OCR 最低置信度，默认 0
  JW_RECORD_NETWORK=1  保存完整网络日志
  JW_NETWORK_LOG      网络日志保存路径，默认 .logs/jw-network-<timestamp>.json
  JW_SEMESTER_START   学期第一周周一，默认 2026-03-02
  JW_TOTAL_WEEKS      抓取周数，默认 19

常用参数：
  --date 2026-07-03          只抓取指定日期所在周
  --semester-start 2026-03-02
  --weeks 19
  --output courses_all.json
  --captcha-path captcha.png
  --captcha-attempts 3
  --ocr-min-confidence 50
  --record-network
  --network-log .logs/login.json
  --login-mode direct|unified|auto
  --login-only
  --no-save-raw
  --quiet
`.trim());
}

async function saveCliNetworkLog(crawler, args) {
  if (!crawler.networkLog.enabled) return null;
  const logPath = args['network-log'] || process.env.JW_NETWORK_LOG || path.join('.logs', `jw-network-${Date.now()}.json`);
  await crawler.saveNetworkLog(logPath);
  return path.resolve(logPath);
}

// 命令行直接运行时
if (require.main === module) {
  (async () => {
    const args = parseCliArgs(process.argv.slice(2));

    if (args.help || args.h) {
      printUsage();
      return;
    }

    const useOcr = args.ocr !== undefined
      ? readBool(args.ocr, true)
      : readBool(process.env.JW_USE_OCR, false);

    const crawler = new JwCrawler({
      useOcr,
      verbose: args.quiet ? false : true,
      captchaPath: args['captcha-path'] || process.env.JW_CAPTCHA_PATH || './captcha.png',
      maxCaptchaAttempts: Number(args['captcha-attempts'] || process.env.JW_CAPTCHA_ATTEMPTS || 1),
      minOcrConfidence: Number(args['ocr-min-confidence'] || process.env.JW_OCR_MIN_CONFIDENCE || 0),
      loginDebugDir: args['login-debug-dir'] || process.env.JW_LOGIN_DEBUG_DIR || './login_debug',
      recordNetwork: args['record-network'] !== undefined || readBool(process.env.JW_RECORD_NETWORK, false),
    });

    try {
      if (args['parse-only']) {
        await crawler.testParseLocal(args.file || './kb.html');
        return;
      }

      const userAccount = args.account || process.env.JW_ACCOUNT;
      const userPassword = args.password || process.env.JW_PASSWORD;

      if (!userAccount || !userPassword) {
        console.log('未提供账号或密码，已跳过真实登录；下面只测试本地 kb.html 解析。');
        console.log('需要登录时可使用 --account/--password，或设置 JW_ACCOUNT/JW_PASSWORD。');
        await crawler.testParseLocal(args.file || './kb.html');
        return;
      }

      const manualCaptcha = args.captcha || process.env.JW_CAPTCHA || '';
      const promptCaptcha = async () => ask('验证码: ');
      const loginMode = args['login-mode'] || process.env.JW_LOGIN_MODE || 'direct';

      if (loginMode === 'unified') {
        await crawler.loginWithCaptcha(userAccount, userPassword, {
          useOcr,
          manualCaptcha,
          promptCaptcha,
        });
      } else if (loginMode === 'auto') {
        try {
          await crawler.loginWithCaptcha(userAccount, userPassword, {
            useOcr,
            manualCaptcha,
            promptCaptcha,
          });
        } catch (err) {
          console.warn(`[登录] 统一认证失败，改用教务子系统直登: ${err.message}`);
          await crawler.loginJsxsdWithCaptcha(userAccount, userPassword, {
            useOcr,
            manualCaptcha: '',
            promptCaptcha,
          });
        }
      } else {
        await crawler.loginJsxsdWithCaptcha(userAccount, userPassword, {
          useOcr,
          manualCaptcha,
          promptCaptcha,
        });
      }

      if (args['login-only']) {
        const logPath = await saveCliNetworkLog(crawler, args);
        if (logPath) {
          console.log(`网络日志已保存到 ${logPath}`);
        }
        console.log('[完成] 登录验证成功');
        return;
      }

      const dates = args.date
        ? [args.date]
        : JwCrawler.generateWeekDates(
          args['semester-start'] || process.env.JW_SEMESTER_START || '2026-03-02',
          Number(args.weeks || process.env.JW_TOTAL_WEEKS || 19)
        );

      const output = args.output || process.env.JW_OUTPUT || 'courses_all.json';
      const saveRaw = args['save-raw'] === false ? false : (args['save-raw'] !== undefined ? readBool(args['save-raw'], true) : true);
      const saveDir = args['save-dir'] || process.env.JW_SAVE_DIR || './schedule_samples';

      const results = await crawler.getScheduleBatch(dates, {
        saveRaw,
        saveDir,
      });

      await fs.writeFile(output, JSON.stringify(results, null, 2), 'utf-8');
      const logPath = await saveCliNetworkLog(crawler, args);
      if (logPath) {
        console.log(`网络日志已保存到 ${logPath}`);
      }
      console.log(`\n全部完成！结果已保存到 ${path.resolve(output)}`);
    } catch (err) {
      try {
        const logPath = await saveCliNetworkLog(crawler, args);
        if (logPath) {
          console.error(`网络日志已保存到 ${logPath}`);
        }
      } catch (logErr) {
        console.error('网络日志保存失败：', logErr.message);
      }
      console.error('运行失败：', err.message);
      if (args.debug) {
        console.error(err.stack);
      }
      process.exitCode = 1;
    }
  })();
}

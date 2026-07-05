const axios = require('axios');
const wrapper = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const cheerio = require('cheerio');
const qs = require('querystring');
const fs = require('fs').promises;

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
      // 基础域名（已通过浏览器地址栏截图确认）
      baseURL: options.baseURL || 'https://jw.gdipu.edu.cn',

      // 登录提交接口（已通过抓包确认）
      loginEndpoint: options.loginEndpoint || '/Logon.do?method=logon',

      // 最大重定向次数
      maxRedirects: options.maxRedirects || 5,

      // 请求超时（毫秒）
      timeout: options.timeout || 15000,

      // ========== 限流配置 ==========
      // 基础请求间隔（毫秒），每次请求后至少等待
      baseDelay: options.baseDelay || 1500,

      // 随机抖动范围（毫秒），实际延迟 = baseDelay + Math.random() * jitter
      jitter: options.jitter || 800,

      // 最大重试次数（被限流或网络错误时）
      maxRetries: options.maxRetries || 3,

      // 指数退避基数（毫秒），首次重试等待 baseDelay，第二次 baseDelay*2，第三次 baseDelay*4
      retryBackoffBase: options.retryBackoffBase || 2000,

      // 是否启用详细日志
      verbose: options.verbose !== undefined ? options.verbose : true,

      ...options
    };

    // 请求计数（用于限流统计）
    this.requestCount = 0;
    this.lastRequestTime = 0;

    // 使用 tough-cookie 管理 Cookie，支持同名的 JSESSIONID 按 Path 区分
    this.jar = new tough.CookieJar();

    this.instance = axios.create({
      baseURL: this.options.baseURL,
      withCredentials: true,
      jar: this.jar,
      maxRedirects: this.options.maxRedirects,
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
  }

  // ==================== 限流工具 ====================

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
        const res = await requestFn();

        if (this.options.verbose) {
          const size = typeof res.data === 'string' ? res.data.length : (res.data ? res.data.byteLength || '?' : 0);
          console.log(`  [${res.status}] ${label} (${size} bytes)`);
        }

        return res;
      } catch (err) {
        lastError = err;

        // 判断是否值得重试
        const isRetryable = this.isRetryableError(err);
        if (!isRetryable || attempt >= this.options.maxRetries) {
          throw err;
        }

        console.warn(`  [警告] ${label} 失败: ${err.message}，准备重试...`);
      }
    }

    throw lastError;
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

  /**
   * 步骤3：获取密码加密因子
   * @returns {string} 格式：scode#sxh
   */
  async getEncryptFactor() {
    const res = await this.requestWithRetry(
      () => this.instance.post('/Logon.do?method=logon&flag=sess', '', {
        headers: { 'Content-Length': 0 }
      }),
      '获取加密因子'
    );
    return res.data;
  }

  /**
   * 前端加密算法转 Node.js
   */
  encryptPassword(userAccount, userPassword, scode, sxh) {
    let code = userAccount + '%%' + userPassword;
    let encoded = '';

    for (let i = 0; i < code.length; i++) {
      if (i < 20) {
        encoded += code.substring(i, i + 1) + code.substring(0, parseInt(sxh.substring(i, i + 1)));
        scode = scode.substring(parseInt(sxh.substring(i, i + 1)), scode.length);
      } else {
        encoded += code.substring(i, code.length);
      }
      i = code.length;
    }

    return encoded;
  }

  /**
   * 步骤4：提交登录
   */
  async login(userAccount, userPassword, randomCode) {
    console.log(`[登录] 账号 ${userAccount} 开始登录...`);

    await this.initLoginPage();

    const factor = await this.getEncryptFactor();
    const [scode, sxh] = factor.split('#');

    if (!scode || !sxh) {
      throw new Error(`加密因子获取异常: ${factor}`);
    }

    const encoded = this.encryptPassword(userAccount, userPassword, scode, sxh);

    const formData = qs.stringify({
      userAccount,
      userPassword: '',
      RANDOMCODE: randomCode,
      encoded,
      pwdstr1: '',
      pwdstr2: ''
    });

    const res = await this.requestWithRetry(
      () => this.instance.post(this.options.loginEndpoint, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${this.options.baseURL}/Logon.do?method=logon`
        }
      }),
      '提交登录'
    );

    // 检查登录是否成功
    const html = typeof res.data === 'string' ? res.data : '';
    if (html.includes('该账号不存在或密码错误') ||
        html.includes('验证码错误') ||
        html.includes('请输入账号') ||
        html.includes('请输入密码') ||
        html.includes('请输入验证码')) {
      const $ = cheerio.load(html);
      const errMsg = $('#showMsg').text().trim() || '未知错误';
      throw new Error(`登录失败: ${errMsg}`);
    }

    console.log('[登录] 成功');
    return res.data;
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
      try { await fs.mkdir(saveDir, { recursive: true }); } catch (e) {}
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

// 命令行直接运行时
if (require.main === module) {
  (async () => {
    const crawler = new JwCrawler();

    try {
      // 方式1：测试本地解析
      await crawler.testParseLocal();

      // 方式2：真实登录 + 批量抓取
      /*
      const userAccount = '2025220502332';
      const userPassword = '你的密码';

      // 下载验证码
      await crawler.getCaptcha('./captcha.png');
      console.log('验证码已保存到 captcha.png，请查看后输入 4 位验证码：');

      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });
      const randomCode = await new Promise(resolve => {
        readline.question('验证码: ', answer => {
          readline.close();
          resolve(answer.trim());
        });
      });

      await crawler.login(userAccount, userPassword, randomCode);

      // 批量抓取多周课表
      const dates = JwCrawler.generateWeekDates('2026-03-02', 19);
      const results = await crawler.getScheduleBatch(dates, {
        saveRaw: true,
        saveDir: './schedule_samples'
      });

      await fs.writeFile('courses_all.json', JSON.stringify(results, null, 2));
      console.log('\n全部完成！结果已保存到 courses_all.json');
      */
    } catch (err) {
      console.error('运行失败：', err.message);
      console.error(err.stack);
    }
  })();
}
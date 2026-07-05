/**
 * WAF 阈值 / IP 封禁测试脚本
 *
 * 用途：探测目标站点对请求频率的容忍上限，找到不会触发限流的安全间隔
 *
 * 使用方法：
 * 1. 先正常登录一次（获取有效 Cookie）
 * 2. 运行本脚本：node waf-test.js
 * 3. 脚本会以不同间隔（2000ms → 1000ms → 500ms → 200ms → 100ms）连续请求课表页面
 * 4. 观察何时返回 403/429 或 WAF 拦截页，确定安全阈值
 *
 * 安全提示：
 * - 本脚本会触发实际的 WAF 检测，可能导致 IP 被临时封禁
 * - 建议在非高峰时段测试
 * - 如果 IP 被封，通常 10-30 分钟后自动恢复
 */

const JwCrawler = require('./crawler');
const fs = require('fs').promises;

// ============ 配置 ============
const CONFIG = {
  // 测试的间隔序列（毫秒）
  testIntervals: [2000, 1500, 1000, 800, 500, 300, 200, 100],

  // 每个间隔发送的请求数
  requestsPerInterval: 10,

  // 间隔之间额外等待时间（秒），让 WAF 冷却
  cooldownBetweenTests: 10,

  // 测试目标接口
  testEndpoint: '/jsxsd/framework/xsMain_new.jsp?t1=1',

  // 结果保存路径
  resultPath: './waf_test_result.json',
};

// ============ WAF 拦截特征检测 ============

/**
 * 检测响应是否被 WAF 拦截
 */
function isWafBlocked(response) {
  // 阿里云 WAF 特征
  if (response.status === 403 || response.status === 429) return true;

  const html = typeof response.data === 'string' ? response.data : '';

  // 阿里云 WAF 拦截页特征
  const wafPatterns = [
    'acw_tc',           // 阿里云 WAF 验证 Cookie
    'WAF',              // 通用 WAF 字样
    '数据安全防护',      // 阿里云 WAF 文案
    '校验失败',          // WAF 拦截提示
    '请求过于频繁',      // 限流提示
    '当前访问疑似异常',   // 异常检测
    '请稍后再试',        // 通用限流
    '您访问的页面出错了',  // 服务端错误
    'too many requests', // 英文限流
    'request denied',    // 请求被拒绝
  ];

  return wafPatterns.some(p => html.includes(p));
}

/**
 * 检测响应是否被重定向到登录页（会话过期）
 */
function isSessionExpired(response) {
  const html = typeof response.data === 'string' ? response.data : '';
  return html.includes('Logon.do') || html.includes('登录');
}

// ============ 主测试逻辑 ============

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWafTest() {
  console.log('══════════════════════════════════════════════');
  console.log('  WAF / IP 封禁阈值测试');
  console.log('══════════════════════════════════════════════\n');

  const crawler = new JwCrawler({
    verbose: false,  // 关闭详细日志，保持输出清晰
    baseDelay: 0,    // 关闭自动限流，由本脚本控制
    maxRetries: 0,   // 不重试，直接记录结果
  });

  // 先发一个请求初始化会话
  console.log('>>> 初始化会话...');
  await crawler.initLoginPage();
  console.log('>>> 会话初始化完成（未登录，仅测试 WAF 行为）\n');

  const results = [];

  for (let i = 0; i < CONFIG.testIntervals.length; i++) {
    const interval = CONFIG.testIntervals[i];
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  测试轮 ${i + 1}/${CONFIG.testIntervals.length}: 间隔 ${interval}ms`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const round = {
      interval,
      totalRequests: CONFIG.requestsPerInterval,
      blocked: 0,
      errors: 0,
      success: 0,
      avgResponseTime: 0,
      responses: [],
    };

    const startTime = Date.now();

    for (let j = 0; j < CONFIG.requestsPerInterval; j++) {
      const reqStart = Date.now();
      let status = 'unknown';
      let blocked = false;
      let error = null;

      try {
        const res = await crawler.instance.get(CONFIG.testEndpoint);
        const elapsed = Date.now() - reqStart;

        blocked = isWafBlocked(res);
        status = blocked ? 'BLOCKED' : 'OK';

        round.responses.push({
          index: j,
          status: res.status,
          blocked,
          elapsed,
          contentLength: String(res.data).length,
        });

        if (blocked) {
          round.blocked++;
          process.stdout.write(`  [${j + 1}] ⛔ ${res.status} WAF拦截 (${elapsed}ms)\n`);
        } else {
          round.success++;
          process.stdout.write(`  [${j + 1}] ✅ ${res.status} (${elapsed}ms)\n`);
        }
      } catch (err) {
        round.errors++;
        status = 'ERROR';
        error = err.message;
        process.stdout.write(`  [${j + 1}] ❌ ${err.code || 'ERROR'}: ${err.message}\n`);

        round.responses.push({
          index: j,
          status: 0,
          blocked: false,
          elapsed: Date.now() - reqStart,
          error: err.message,
        });
      }

      // 按指定间隔等待
      if (j < CONFIG.requestsPerInterval - 1) {
        await sleep(interval);
      }
    }

    round.totalTime = Date.now() - startTime;
    round.avgResponseTime = round.responses.reduce((sum, r) => sum + r.elapsed, 0) / round.responses.length;

    round.result = round.blocked === 0 ? 'PASS ✅' :
                   round.blocked === CONFIG.requestsPerInterval ? 'FAIL ❌' :
                   'PARTIAL ⚠️';

    results.push(round);

    console.log(`\n  结果: ${round.result}`);
    console.log(`  成功: ${round.success} | 拦截: ${round.blocked} | 错误: ${round.errors}`);
    console.log(`  平均耗时: ${round.avgResponseTime.toFixed(0)}ms | 总耗时: ${round.totalTime}ms`);

    // 如果全部被拦截，缩短后续测试
    if (round.blocked === CONFIG.requestsPerInterval) {
      console.log(`\n  ⚠️ 间隔 ${interval}ms 时全部被拦截，建议安全间隔 >= ${CONFIG.testIntervals[Math.max(0, i - 1)]}ms`);
      if (i >= CONFIG.testIntervals.length - 1) break;
    }

    // 间隔间冷却
    if (i < CONFIG.testIntervals.length - 1) {
      console.log(`\n  [冷却] 等待 ${CONFIG.cooldownBetweenTests}s...`);
      await sleep(CONFIG.cooldownBetweenTests * 1000);
    }
  }

  // 汇总
  console.log('\n\n══════════════════════════════════════════════');
  console.log('  测试汇总');
  console.log('══════════════════════════════════════════════');
  console.log('');

  const summary = {
    testTime: new Date().toISOString(),
    target: CONFIG.testEndpoint,
    rounds: results,
    recommendation: null,
  };

  // 找出安全间隔
  const safeRounds = results.filter(r => r.blocked === 0);
  if (safeRounds.length > 0) {
    const minSafe = Math.min(...safeRounds.map(r => r.interval));
    summary.recommendation = {
      safeInterval: minSafe,
      description: `建议基础间隔 >= ${minSafe}ms，以确保不触发 WAF 限流`,
    };
    console.log(`  ✅ 安全间隔: >= ${minSafe}ms`);
  } else {
    summary.recommendation = {
      safeInterval: CONFIG.testIntervals[0],
      description: `所有间隔均被拦截，建议使用最大间隔 ${CONFIG.testIntervals[0]}ms 并增加随机抖动`,
    };
    console.log(`  ⚠️ 所有间隔均触发限流，建议使用 ${CONFIG.testIntervals[0]}ms + 随机抖动`);
  }

  // 保存结果
  await fs.writeFile(CONFIG.resultPath, JSON.stringify(summary, null, 2));
  console.log(`\n  详细结果已保存到 ${CONFIG.resultPath}`);

  return summary;
}

// 运行
runWafTest().then(summary => {
  console.log('\n测试完成！');
}).catch(err => {
  console.error('测试异常:', err.message);
  process.exit(1);
});
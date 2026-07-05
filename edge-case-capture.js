/**
 * 特殊场景课表样本抓取脚本
 *
 * 用途：抓取空课表、单双周、调课、跨学期等边界场景的课表 HTML
 * 覆盖以下场景：
 *   1. 空课表（寒暑假/考试周，无课程排课）
 *   2. 单双周课程（如体育课、实验课标记单周/双周）
 *   3. 学期初/末（课程交替，前半学期A课后半学期B课）
 *   4. 节假日前后（调课、补课标记）
 *   5. 跨学期边界（放假前后的课表行为）
 *
 * 使用方法：
 *   1. 设置 JW_ACCOUNT/JW_PASSWORD，或传入 --account/--password
 *   2. node edge-case-capture.js --ocr --captcha-attempts 3
 *   3. 脚本会自动抓取各种边界日期的课表 HTML
 *   4. 结果保存在 ./edge_case_samples/ 目录
 */

const JwCrawler = require('./crawler');
const fs = require('fs').promises;

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
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

// ============ 边界场景配置 ============
const SCENARIOS = [
  // 场景1：空课表（寒暑假）
  {
    name: 'empty_summer',
    label: '暑假（7月）',
    dates: ['2026-07-15', '2026-07-22', '2026-08-01'],
    expect: '应返回空课表，无课程或提示"暂无课表"',
  },
  {
    name: 'empty_winter',
    label: '寒假（1月）',
    dates: ['2026-01-15', '2026-01-22'],
    expect: '应返回空课表或提示',
  },

  // 场景2：学期初/末课程交替
  {
    name: 'semester_start',
    label: '学期初（第1-2周）',
    dates: ['2026-03-02', '2026-03-09'],
    expect: '可能出现前半学期课程，或课程尚未开始',
  },
  {
    name: 'semester_end',
    label: '学期末（第18-19周）',
    dates: ['2026-07-06', '2026-07-13'],
    expect: '可能有课程已结束，或出现复习周标记',
  },

  // 场景3：节假日前后（调课/补课）
  // 2026年五一：5月1-5日放假，4月27日补课
  {
    name: 'holiday_before',
    label: '五一假期前（补课周）',
    dates: ['2026-04-20', '2026-04-27'],
    expect: '可能出现补课标记或调课信息',
  },
  {
    name: 'holiday_after',
    label: '五一假期后',
    dates: ['2026-05-04', '2026-05-11'],
    expect: '课表恢复正常',
  },

  // 场景4：国庆前后
  {
    name: 'national_day',
    label: '国庆假期前后',
    dates: ['2026-09-28', '2026-10-12'],
    expect: '可能有调课/补课安排',
  },

  // 场景5：考试周
  {
    name: 'exam_week',
    label: '考试周（第19-20周）',
    dates: ['2026-07-06', '2026-07-13'],
    expect: '可能出现"考试"标记或无课表',
  },

  // 场景6：跨学期边界
  {
    name: 'semester_boundary',
    label: '学期边界（9月初开学前）',
    dates: ['2026-08-31', '2026-09-01'],
    expect: '可能返回上学期或下学期课表，或空数据',
  },
];

// ============ 主逻辑 ============

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureEdgeCases() {
  const args = parseCliArgs(process.argv.slice(2));

  console.log('══════════════════════════════════════════════');
  console.log('  特殊场景课表样本抓取');
  console.log('══════════════════════════════════════════════\n');

  const saveDir = './edge_case_samples';
  await fs.mkdir(saveDir, { recursive: true });

  // 使用保守的限流参数
  const crawler = new JwCrawler({
    baseDelay: 2000,
    jitter: 500,
    maxRetries: 2,
    verbose: true,
    useOcr: args.ocr !== undefined ? readBool(args.ocr, true) : readBool(process.env.JW_USE_OCR, false),
    captchaPath: args['captcha-path'] || process.env.JW_CAPTCHA_PATH || './captcha.png',
    maxCaptchaAttempts: Number(args['captcha-attempts'] || process.env.JW_CAPTCHA_ATTEMPTS || 1),
    minOcrConfidence: Number(args['ocr-min-confidence'] || process.env.JW_OCR_MIN_CONFIDENCE || 0),
  });

  // 先测试本地解析是否正常
  console.log('>>> 验证本地解析...');
  try {
    const courses = await crawler.testParseLocal('./kb.html');
    console.log(`>>> 本地解析通过：${courses.length} 门课\n`);
  } catch (err) {
    console.error('>>> 本地解析失败，请检查 kb.html');
    return;
  }

  const summary = [];
  let totalSuccess = 0;
  let totalFail = 0;

  const userAccount = args.account || process.env.JW_ACCOUNT;
  const userPassword = args.password || process.env.JW_PASSWORD;

  if (!userAccount || !userPassword) {
    console.log('未提供账号或密码，已跳过在线抓取。');
    console.log('需要在线抓取时可使用 --account/--password，或设置 JW_ACCOUNT/JW_PASSWORD。');
    console.log(`样本保存目录：${saveDir}/`);
    return summary;
  }

  const manualCaptcha = args.captcha || process.env.JW_CAPTCHA || '';
  const promptCaptcha = async () => ask('验证码: ');
  const loginMode = args['login-mode'] || process.env.JW_LOGIN_MODE || 'direct';

  if (loginMode === 'unified') {
    await crawler.loginWithCaptcha(userAccount, userPassword, {
      useOcr: crawler.options.useOcr,
      manualCaptcha,
      promptCaptcha,
    });
  } else if (loginMode === 'auto') {
    try {
      await crawler.loginWithCaptcha(userAccount, userPassword, {
        useOcr: crawler.options.useOcr,
        manualCaptcha,
        promptCaptcha,
      });
    } catch (err) {
      console.warn(`[登录] 统一认证失败，改用教务子系统直登: ${err.message}`);
      await crawler.loginJsxsdWithCaptcha(userAccount, userPassword, {
        useOcr: crawler.options.useOcr,
        manualCaptcha: '',
        promptCaptcha,
      });
    }
  } else {
    await crawler.loginJsxsdWithCaptcha(userAccount, userPassword, {
      useOcr: crawler.options.useOcr,
      manualCaptcha,
      promptCaptcha,
    });
  }

  for (const scenario of SCENARIOS) {
    console.log(`\n─── ${scenario.label} ───`);
    console.log(`  预期: ${scenario.expect}`);

    const scenarioResults = [];
    for (const rq of scenario.dates) {
      try {
        const html = await crawler.getScheduleRaw(rq);
        const courses = crawler.parseSchedule(html);

        // 保存 HTML
        const safeName = `${scenario.name}_${rq.replace(/-/g, '')}`;
        await fs.writeFile(`${saveDir}/${safeName}.html`, html);

        // 检查特殊标记
        const specialMarks = [];
        for (const c of courses) {
          if (c.courseTime?.includes('单周')) specialMarks.push('单周');
          if (c.courseTime?.includes('双周')) specialMarks.push('双周');
          if (c.courseTime?.includes('补课')) specialMarks.push('补课');
          if (c.courseTime?.includes('调课')) specialMarks.push('调课');
          if (c.courseTime?.includes('考试')) specialMarks.push('考试');
        }

        scenarioResults.push({
          rq,
          courseCount: courses.length,
          courses,
          specialMarks: [...new Set(specialMarks)],
          savedTo: `${safeName}.html`,
        });

        totalSuccess++;
        console.log(`  ✅ ${rq}: ${courses.length} 门课${specialMarks.length ? ' (' + specialMarks.join(', ') + ')' : ''}`);
      } catch (err) {
        scenarioResults.push({
          rq,
          courseCount: 0,
          error: err.message,
        });
        totalFail++;
        console.log(`  ❌ ${rq}: ${err.message}`);
      }
    }

    summary.push({
      scenario: scenario.name,
      label: scenario.label,
      results: scenarioResults,
    });
  }

  // 保存汇总
  const report = {
    captureTime: new Date().toISOString(),
    totalScenarios: SCENARIOS.length,
    totalSuccess,
    totalFail,
    summary,
  };
  await fs.writeFile(`${saveDir}/summary.json`, JSON.stringify(report, null, 2));


  // 输出场景列表（离线模式）
  console.log('┌──────┬──────────────────────┬──────────────┬──────────────────────────────┐');
  console.log('│ 序号 │ 场景                 │ 日期         │ 预期                         │');
  console.log('├──────┼──────────────────────┼──────────────┼──────────────────────────────┤');
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    console.log(`│ ${String(i + 1).padStart(2)}   │ ${s.label.padEnd(20)} │ ${s.dates[0].padEnd(12)} │ ${s.expect.padEnd(28)} │`);
  }
  console.log('└──────┴──────────────────────┴──────────────┴──────────────────────────────┘');

  console.log(`\n共 ${SCENARIOS.length} 个场景，${SCENARIOS.reduce((sum, s) => sum + s.dates.length, 0)} 个日期`);
  console.log(`\n启用在线抓取：编辑本文件，取消注释 "在线抓取" 部分的代码`);
  console.log(`样本保存目录：${saveDir}/`);

  return summary;
}

captureEdgeCases().catch(err => {
  console.error('异常:', err.message);
  process.exit(1);
});

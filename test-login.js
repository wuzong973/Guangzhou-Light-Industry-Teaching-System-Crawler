require('dotenv').config({ quiet: true });
const JwCrawler = require('./crawler');

const account = '2025220502332';
const password = '20060722';

async function testLogin() {
  console.log('开始测试登录...');
  console.log('账号:', account);
  console.log('密码:', password);
  console.log('');

  const crawler = new JwCrawler({
    verbose: true,
    useOcr: true,
    maxCaptchaAttempts: 3,
    minOcrConfidence: 0,
    baseDelay: 1500,
    jitter: 800,
  });

  try {
    console.log('尝试直接登录（教学子系统）...');
    await crawler.loginJsxsdWithCaptcha(account, password, {
      useOcr: true,
      maxCaptchaAttempts: 3,
    });

    console.log('');
    console.log('登录成功！');
    console.log('');

    // 测试获取课表
    console.log('尝试获取课表...');
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    console.log('查询日期:', dateStr);
    const html = await crawler.getScheduleRaw(dateStr);
    const courses = crawler.parseSchedule(html);

    console.log('');
    console.log(`获取到 ${courses.length} 条课程记录`);

    if (courses.length > 0) {
      console.log('');
      console.log('课程示例：');
      courses.slice(0, 3).forEach((course, index) => {
        console.log(`  ${index + 1}. ${course.courseName || course.name}`);
        console.log(`     教师: ${course.teacher || ''}`);
        console.log(`     地点: ${course.location || ''}`);
        console.log(`     时间: ${course.weekDay || ''} 第${course.startSection}-${course.endSection}节`);
        console.log(`     周次: ${course.courseTime || ''}`);
        console.log('');
      });
    }

    console.log('测试完成！');

  } catch (err) {
    console.error('');
    console.error('登录失败:', err.message);

    if (err.message.includes('captcha') || err.message.includes('验证码')) {
      console.error('');
      console.error('需要手动输入验证码。');
      console.error('验证码图片已保存到 captcha.png');
    }
  }
}

testLogin();
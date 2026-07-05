require('dotenv').config({ quiet: true });
const JwCrawler = require('./crawler');

const account = '2025220502332';
const password = '20060722';
const semesterStart = '2026-03-02';
const totalWeeks = 19;

async function testSemesterSchedule() {
  console.log('开始测试学期课表查询...');
  console.log('账号:', account);
  console.log('学期开始:', semesterStart);
  console.log('总周数:', totalWeeks);
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
    console.log('尝试登录...');
    await crawler.loginJsxsdWithCaptcha(account, password, {
      useOcr: true,
      maxCaptchaAttempts: 3,
    });

    console.log('登录成功！');
    console.log('');

    // 生成学期所有周的起始日期
    const dates = JwCrawler.generateWeekDates(semesterStart, totalWeeks);
    console.log(`将查询 ${dates.length} 周的课表数据`);
    console.log('');

    const allCourses = [];
    const weekSummary = [];

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const weekNum = i + 1;

      console.log(`查询第 ${weekNum} 周 (${date})...`);

      try {
        const html = await crawler.getScheduleRaw(date);
        const courses = crawler.parseSchedule(html);

        allCourses.push(...courses);

        weekSummary.push({
          week: weekNum,
          date: date,
          courseCount: courses.length,
          courses: courses.map(c => ({
            name: c.courseName || c.name || '',
            teacher: c.teacher || '',
            location: c.location || '',
            weekDay: c.weekDay || '',
            sections: `${c.startSection}-${c.endSection}`,
            weeks: c.courseTime || ''
          }))
        });

        console.log(`  获取到 ${courses.length} 条课程记录`);

      } catch (err) {
        console.error(`  第 ${weekNum} 周查询失败:`, err.message);
        weekSummary.push({
          week: weekNum,
          date: date,
          courseCount: 0,
          error: err.message
        });
      }

      // 每周之间添加延迟
      if (i < dates.length - 1) {
        const delay = 1500 + Math.random() * 800;
        console.log(`  等待 ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.log('');
    console.log('========== 学期课表汇总 ==========');
    console.log(`总课程记录数: ${allCourses.length}`);
    console.log('');

    // 按周显示汇总
    console.log('每周课程数量:');
    weekSummary.forEach(ws => {
      console.log(`  第 ${ws.week} 周 (${ws.date}): ${ws.courseCount} 条记录`);
    });

    console.log('');
    console.log('========== 课程去重统计 ==========');

    // 按课程名称去重统计
    const courseMap = new Map();
    allCourses.forEach(course => {
      const name = course.courseName || course.name || '未知课程';
      if (!courseMap.has(name)) {
        courseMap.set(name, {
          name: name,
          teacher: course.teacher || '',
          location: course.location || '',
          count: 0,
          weeks: new Set()
        });
      }
      const info = courseMap.get(name);
      info.count++;
      if (course.courseTime) {
        info.weeks.add(course.courseTime);
      }
    });

    console.log(`本学期共 ${courseMap.size} 门不同课程:`);
    console.log('');

    let index = 1;
    courseMap.forEach((info, name) => {
      console.log(`${index}. ${name}`);
      console.log(`   教师: ${info.teacher || '未知'}`);
      console.log(`   地点: ${info.location || '未知'}`);
      console.log(`   上课次数: ${info.count} 次`);
      console.log(`   周次: ${Array.from(info.weeks).join(', ') || '未知'}`);
      console.log('');
      index++;
    });

    console.log('测试完成！');

  } catch (err) {
    console.error('');
    console.error('测试失败:', err.message);

    if (err.message.includes('captcha') || err.message.includes('验证码')) {
      console.error('');
      console.error('需要手动输入验证码。');
      console.error('验证码图片已保存到 captcha.png');
    }
  }
}

testSemesterSchedule();
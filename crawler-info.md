# 教务系统爬虫 — 信息梳理文档

> **目标系统**：广东信息工程职业学院教务系统  
> **技术栈**：Node.js + axios + cheerio + tough-cookie  
> **整理时间**：2026-07-03（最新更新）  
> **信息来源**：2 份 HAR 抓包文件、10+ 张浏览器 DevTools 截图、1 份课表 HTML 样本、已实现的 4 个代码文件

---

## 2026-07-03 实测更新

### 已验证可用路径

| 模块               | 结果                                                           |
| ------------------ | -------------------------------------------------------------- |
| 教务子系统直登     | ✅ 成功                                                        |
| 子系统登录入口     | `GET /jsxsd/framework/xsMain.jsp`                              |
| 子系统验证码       | `GET /jsxsd/verifycode.servlet?t=<随机数>`                     |
| 子系统登录提交     | `POST /jsxsd/xk/LoginToXk`                                     |
| 子系统密码编码     | `encoded = base64(userAccount) + "%%%" + base64(userPassword)` |
| 子系统登录成功标记 | 页面包含 `教学一体化服务平台`、`LogoutGLD`、`我的课表`         |
| 课表主页           | ✅ `GET /jsxsd/framework/xsMain_new.jsp?t1=1`                  |
| 课表数据           | ✅ `POST /jsxsd/framework/main_index_loadkb.jsp`               |

实测账号登录后，`2026-07-03` 所在周课表成功解析出 5 门课程。完整网络日志保存于：

```text
D:\校园论坛\.logs\final-direct\network-full.json
D:\校园论坛\.logs\final-direct\schedule-2026-07-03.json
```

### 统一认证路径状态

统一认证路径仍保留在代码中，但本次实测未作为默认路径：

```text
GET  /Logon.do?method=logon
GET  /verifycode.servlet?t=<时间戳>
POST /Logon.do?method=logon&flag=sess
POST /Logon.do?method=logon
GET  /jsxsd/xk/LoginToXk?method=jwxt&ticqzket=<ticket>
GET  /jsxsd/framework/xsMain.jsp
```

实测现象：统一认证会返回 `ticqzket` ticket，并且 `LoginToXk` 会设置 `/jsxsd` 路径的 `JSESSIONID`，但最终 `xsMain.jsp` 返回子系统登录页并提示 `请先登录系统`。因此当前爬虫默认使用已验证成功的“教务子系统直登”模式；统一认证作为 `--login-mode unified` 或 `--login-mode auto` 的研究/兜底路径保留。

### OCR 状态

已接入 `tesseract.js` + `sharp` 本地 OCR，支持：

- 原图、灰度放大、二值化、反色二值化多候选识别
- 小写字母/数字白名单
- 4 位格式校验
- OCR 失败时人工输入兜底

实测结论：验证码整体简单，但 Tesseract 对个别字符仍会误读，例如 `8/g`、`q/g` 一类字符，需要保留人工兜底或继续采集样本训练。

## 一、已知信息

### 1.1 项目基本信息

| 项        | 内容                                     |
| --------- | ---------------------------------------- |
| 项目名称  | jw-crawler                               |
| 版本      | 1.0.0                                    |
| 目标系统  | 广轻工职业学院教务系统（强智教务系统）   |
| 技术栈    | Node.js + axios + cheerio + tough-cookie |
| 服务器 IP | `47.115.158.249`（阿里云）               |

### 1.2 目标系统域名与协议

| 域名              | 协议  | 用途                                      | 状态                                  |
| ----------------- | ----- | ----------------------------------------- | ------------------------------------- |
| `jw.gdip.edu.cn`  | HTTP  | 旧登录入口                                | 已 301/302 重定向到 `jw.gdipu.edu.cn` |
| `jw.gdipu.edu.cn` | HTTPS | **统一域名**：登录入口 + 所有教务业务页面 | ✅ 当前有效                           |

**确认方式**：用户报告两个域名都能打开，但从 `http://jw.gdip.edu.cn` 登录进去后域名自动变成 `https://jw.gdipu.edu.cn`。第二个 HAR 文件中登录提交直接发往 `https://jw.gdipu.edu.cn/Logon.do?method=logon`。

### 1.3 全局请求头（所有接口必须携带）

```
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
Accept-Encoding: gzip, deflate
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6
Cache-Control: max-age=0
Connection: keep-alive
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0
```

页面编码：全站 UTF-8。

### 1.4 登录流程（4 步，已完全确认）

| 步骤 | 方法 | URL                                | 说明                               |
| ---- | ---- | ---------------------------------- | ---------------------------------- |
| 1    | GET  | `/Logon.do?method=logon`           | 加载登录页，初始化 Cookie          |
| 2    | GET  | `/verifycode.servlet?t=<时间戳>`   | 获取 4 位图形验证码图片            |
| 3    | POST | `/Logon.do?method=logon&flag=sess` | 获取密码加密因子，返回 `scode#sxh` |
| 4    | POST | `/Logon.do?method=logon`           | 提交登录表单                       |

**步骤 3 请求体**：空内容，`Content-Length: 0`  
**步骤 3 返回**：纯文本，格式 `scode#sxh`，例如：

```
XqpLMy84784I56dU087x771JrXLMR0422GX80#31122311313111332221
```

### 1.5 登录表单字段（HAR 已确认）

| 字段           | 值（HAR 实例）           | 说明                          |
| -------------- | ------------------------ | ----------------------------- |
| `userAccount`  | （空字符串）             | 前端 JS 在提交前清空          |
| `userPassword` | （空字符串）             | 前端 JS 在提交前清空          |
| `RANDOMCODE`   | `r7jj` / `ud1w` / `mlhr` | 4 位验证码                    |
| `encoded`      | `215x0V42855502wTe...`   | 通过 `scode#sxh` 加密后的凭证 |

**注意**：`pwdstr1`、`pwdstr2` 在第一个 HAR 中出现过但第二个 HAR 中没有，推测不是必须字段，代码中已删除。

### 1.6 密码加密算法（HAR 已验证逻辑）

```
1. 调用 POST /Logon.do?method=logon&flag=sess 获取 scode#sxh
2. code = userAccount + "%%%" + userPassword
3. 遍历 code 的每个字符：
   - 取 sxh 第 i 位的数字作为 step
   - encoded += code[i] + scode 的前 step 个字符
   - scode = scode 截掉前 step 个字符
   - 循环只执行一次（i = code.length 强制退出）
```

代码已实现在 `crawler.js` 的 `encryptPassword()` 方法中。

### 1.7 登录成功后的重定向链（HAR 已确认）

```
POST  https://jw.gdipu.edu.cn/Logon.do?method=logon
  ↓ 302 Location: http://jw.gdipu.edu.cn/jsxsd/xk/LoginToXk?method=jwxt&ticqzket=<hex-token>
GET   http://jw.gdipu.edu.cn/jsxsd/xk/LoginToXk?method=jwxt&ticqzket=...
  ↓ 302（浏览器自动升级 HTTPS）
GET   https://jw.gdipu.edu.cn/jsxsd/xk/LoginToXk?method=jwxt&ticqzket=...
  ↓ 302 Location: http://jw.gdipu.edu.cn/jsxsd/framework/xsMain.jsp
GET   http://jw.gdipu.edu.cn/jsxsd/framework/xsMain.jsp
  ↓ 302（浏览器自动升级 HTTPS）
GET   https://jw.gdipu.edu.cn/jsxsd/framework/xsMain.jsp  [200] ← 最终首页
```

`ticqzket` 是服务端在登录提交后生成的 ticket 令牌，通过 URL 参数传递，一次性使用。

### 1.8 登录失败判断（代码中已实现）

通过检查返回 HTML 中的 `#showMsg` 标签文案判断：

| 错误类型   | 文案                                   |
| ---------- | -------------------------------------- |
| 账号不存在 | 该账号不存在或密码错误，请联系管理员！ |
| 验证码错误 | 验证码错误!!                           |
| 空输入     | 请输入账号 / 请输入密码 / 请输入验证码 |

### 1.9 Cookie 机制（第二个 HAR 已确认）

| Cookie                | 值示例           | Path     | Domain            | Expires    | HttpOnly | 生成时机                 |
| --------------------- | ---------------- | -------- | ----------------- | ---------- | -------- | ------------------------ |
| `acw_tc`              | `2f739ef9178...` | `/`      | `jw.gdipu.edu.cn` | 约 10 分钟 | ✅       | 登录页加载时已存在       |
| `JSESSIONID`（根）    | `2584AB642...`   | `/`      | `jw.gdipu.edu.cn` | Session    | ✅       | 登录页加载时已存在       |
| `JSESSIONID`（jsxsd） | `6D778FD9E...`   | `/jsxsd` | `jw.gdipu.edu.cn` | Session    | ✅       | `LoginToXk` 步骤首次出现 |
| `SERVERID`            | `122`            | `/`      | `jw.gdipu.edu.cn` | Session    | ❌       | 登录页加载时已存在       |

**关键结论**：

- 所有 Cookie 的 Domain 都是 `jw.gdipu.edu.cn`，不存在跨子域 Cookie 问题
- 两个同名 `JSESSIONID` 按 Path 区分：`/`（统一认证）和 `/jsxsd`（教务子系统）
- `acw_tc` 有效期约 10 分钟，整个登录流程必须在此时间内完成
- 代码使用 `tough-cookie` + `axios-cookiejar-support` 自动管理，支持同名 Cookie 按 Path 区分

### 1.10 验证码

| 项       | 内容                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 接口     | `GET /verifycode.servlet?t=<时间戳>`                                       |
| 返回类型 | 图片二进制（`responseType: 'arraybuffer'`）                                |
| 字符长度 | 4 位                                                                       |
| 字符类型 | 小写字母 + 数字混合                                                        |
| 干扰程度 | 有轻微干扰线/噪点，整体清晰                                                |
| 刷新方式 | 点击验证码图片触发 `ReShowCode()`，或重新请求接口                          |
| 当前处理 | 已接入本地 `tesseract.js` OCR 辅助识别；识别失败或置信度不足时回退人工输入 |

### 1.10.1 验证码 OCR 当前实现

| 项           | 内容                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| 文件         | `captcha-ocr.js`                                                                |
| 引擎         | `tesseract.js`                                                                  |
| 语言包       | 优先使用项目根目录 `eng.traineddata`；不存在时由 `tesseract.js` 走默认下载/缓存 |
| 字符白名单   | `abcdefghijklmnopqrstuvwxyz0123456789`                                          |
| 识别模式     | 单行文本模式（`tessedit_pageseg_mode=7`）                                       |
| 命令行自测   | `node captcha-ocr.js captcha.png` 或 `npm run ocr`                              |
| 主流程启用   | `node crawler.js --account <学号> --password <密码> --ocr --captcha-attempts 3` |
| 环境变量启用 | `JW_USE_OCR=1`、`JW_CAPTCHA_ATTEMPTS=3`                                         |
| 人工兜底     | OCR 没得到 4 位字母/数字时，会提示查看保存的 `captcha.png` 并手输               |

**已验证样本**：当前 `captcha.png` 可被 OCR 识别为 4 位结果。  
**注意**：短验证码的 Tesseract 置信度可能为 `0` 但文本仍可能可用，所以默认 `JW_OCR_MIN_CONFIDENCE=0`，先按格式校验；如果后续样本充足，可再设置置信度阈值。

### 1.11 课表主页

| 项      | 内容                                                              |
| ------- | ----------------------------------------------------------------- |
| URL     | `GET https://jw.gdipu.edu.cn/jsxsd/framework/xsMain_new.jsp?t1=1` |
| Referer | `https://jw.gdipu.edu.cn/jsxsd/framework/xsMain.jsp`              |
| 作用    | 提取 `sjmsValue` 动态令牌                                         |

**`sjmsValue` 提取方式**：

- 元素：`<select name="sjms" id="sjms" style="width:120px" onchange="selectWdatePicker2()">`
- 提取：`$('#sjms').val()`
- 默认值：`96BE0728A94D4297E0530100007F0427`（默认节次模式）
- 另一个选项：`00A66608A4784E4491EA878C507131F3`（新课表节次）

**页面中其他元素**：

- 日期输入框 `id="rq"`，如 `2026-07-03`
- 当前周次显示：`第17周/19周`

### 1.12 课表数据接口（HAR 已确认）

| 项               | 内容                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| URL              | `POST https://jw.gdipu.edu.cn/jsxsd/framework/main_index_loadkb.jsp` |
| Content-Type     | `application/x-www-form-urlencoded; charset=UTF-8`                   |
| X-Requested-With | `XMLHttpRequest`                                                     |
| Referer          | `https://jw.gdipu.edu.cn/jsxsd/framework/xsMain_new.jsp?t1=1`        |

**请求参数**：

| 参数        | 值示例                             | 说明                           |
| ----------- | ---------------------------------- | ------------------------------ |
| `rq`        | `2026-07-03`                       | 查询日期，系统自动匹配对应周次 |
| `sjmsValue` | `96BE0728A94D4297E0530100007F0427` | 从课表主页 `#sjms` 提取        |

**返回**：`text/html;charset=UTF-8`，HTML 片段，包含 `<table id="tab1" class="kb_table">`。

`rq` 可传任意日期，系统自动匹配对应周的课表。HAR 中抓到过 `2026-02-04`、`2026-03-03`、`2026-04-01`、`2026-07-09`、`2026-07-23` 等多个日期的请求。

### 1.13 课表 HTML 解析规则（已通过 kb.html 验证）

**表格结构**：

- 表格 ID：`#tab1`
- `thead`：第一列为节次段，第 2~8 列对应周一到周日
- `tbody`：每行代表一个节次段（1-2节、3-4节、5节、6节、7-8节、9-10节、11节、12-13节、14节）

**课程单元格**：

- 课程信息在 `<p title="...">` 的 `title` 属性中
- `title` 中以 `<br/>` 分隔键值对
- 字段顺序固定：课程学分、课程属性、课程名称、上课时间、上课地点、上课校区、分组名（可选）

**`title` 属性示例**：

```
课程学分：2.5<br/>课程属性：必修<br/>课程名称：网络通信基础<br/>上课时间：第17周 星期三 [01-02]节<br/>上课地点：第四工业实训楼B303<br/>上课校区：南海校区(北区)
```

**已解析字段**：

- 课程名称、课程学分、课程属性、上课时间、上课地点、上课校区、分组名
- 星期、节次范围、小节、时间范围

**验证结果**：`kb.html`（第 17 周）成功解析出 5 门课程。

### 1.14 已实现的代码功能

| 文件                   | 功能                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `crawler.js`           | 登录认证、课表抓取、课表解析、主动限流、指数退避重试、批量抓取、日期生成 |
| `captcha-ocr.js`       | 本地验证码 OCR 识别，支持命令行自测和本地语言包                          |
| `waf-test.js`          | WAF 阈值/IP 封禁探测脚本                                                 |
| `edge-case-capture.js` | 特殊场景课表样本抓取脚本（7 类场景，17 个日期）                          |

**`crawler.js` 主要方法**：

| 方法                                      | 说明                                     |
| ----------------------------------------- | ---------------------------------------- |
| `initLoginPage()`                         | 访问登录页，初始化 Cookie                |
| `getCaptcha(path)`                        | 获取验证码图片并保存                     |
| `recognizeCaptcha(input)`                 | 使用本地 OCR 识别验证码                  |
| `loginWithCaptcha(account, pwd, options)` | 获取验证码、OCR/人工输入并提交登录       |
| `getEncryptFactor()`                      | 获取 `scode#sxh` 加密因子                |
| `encryptPassword()`                       | 密码加密                                 |
| `login(account, pwd, code)`               | 完整登录流程                             |
| `getSchedulePage()`                       | 获取课表主页，提取 `sjmsValue`           |
| `getScheduleRaw(rq)`                      | 获取课表原始 HTML                        |
| `getSchedule(rq)`                         | 获取并解析课表                           |
| `getScheduleBatch(dates)`                 | 批量抓取多周课表                         |
| `parseSchedule(html)`                     | 解析课表 HTML                            |
| `throttle()`                              | 主动限流（`baseDelay + random(jitter)`） |
| `requestWithRetry(fn)`                    | 带指数退避重试的请求包装器               |

### 1.15 限流与重试配置

| 参数               | 默认值  | 说明                                                                             |
| ------------------ | ------- | -------------------------------------------------------------------------------- |
| `baseDelay`        | 1500 ms | 基础请求间隔                                                                     |
| `jitter`           | 800 ms  | 随机抖动范围                                                                     |
| `maxRetries`       | 3       | 最大重试次数                                                                     |
| `retryBackoffBase` | 2000 ms | 指数退避基数（2s → 4s → 8s）                                                     |
| 可重试错误         | —       | ECONNRESET / ETIMEDOUT / ECONNABORTED / ENOTFOUND / EPIPE / HTTP 429 / 503 / 502 |

### 1.16 其他已知功能入口（从首页菜单提取）

| 功能         | URL 路径                      |
| ------------ | ----------------------------- |
| 学期理论课表 | `/jsxsd/xskb/xskb_list.do`    |
| 班级课表查询 | `/jsxsd/kbcx/kbxx_xzb`        |
| 教师课表查询 | `/jsxsd/kbcx/kbxx_teacher`    |
| 教室课表查询 | `/jsxsd/kbcx/kbxx_classroom`  |
| 调停课查询   | `/jsxsd/xskb/xskb_ttkmx.do`   |
| 课程成绩查询 | `/jsxsd/kscj/cjcx_frm`        |
| 考试安排查询 | `/jsxsd/xsks/xsksap_query`    |
| 学籍卡片     | `/jsxsd/grxx/xsxx`            |
| 教学周历查看 | `/jsxsd/jxzl/jxzl_query`      |
| 学生选课中心 | `/jsxsd/xsxk/xklc_list`       |
| 社会考试报名 | `/jsxsd/xsdjks/xsdjks_list`   |
| 补考报名     | `/jsxsd/kscj/bkbm_query`      |
| 重修报名选课 | `/jsxsd/kscj/cxbmxk_query_xq` |
| 成绩置换申请 | `/jsxsd/kscj/cjzh_query`      |
| 执行计划     | `/jsxsd/pyfa/pyfa_query`      |

### 1.17 其他发现

- **xsMain.jsp 中的隐藏表单**（用于教务子系统回跳统一认证）：
  ```html
  <form
    action="http://47.115.158.249/Logon.do?method=logonFromJsxsd"
    method="post"
    id="loginForm1"
  >
    <input type="hidden" id="view" name="view" />
    <input type="hidden" id="useraccount" name="useraccount" />
    <input type="hidden" id="ticket" name="ticket" />
  </form>
  ```
- **页面包含学生个人信息**：`xsMain.jsp` 会渲染当前登录学生的姓名、学号、院系、专业、班级等字段；调试日志和样例文件应脱敏或忽略。
- **字节跳动埋点请求**：`abtestvm.bytedance.com`、`mcs.zijieapi.com`，用于用户行为采集，非学校站点 WAF

---

## 二、不确定信息（需进一步验证）

### 2.1 代码生成的 `encoded` 是否正确

- **现状**：代码中实现了加密算法，但没有 `scode#sxh` 的响应样本，无法离线验证
- **风险**：如果算法实现有细微差异，登录会失败
- **验证方法**：运行真实登录，对比代码生成的 `encoded` 与浏览器 HAR 中的 `encoded`

### 2.2 HTTPS 证书是否自签名

- **现状**：代码使用 `https://jw.gdipu.edu.cn`，axios 默认校验证书
- **风险**：如果服务器使用自签名证书，axios 会报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
- **验证方法**：运行真实请求，如果报证书错误则添加 `rejectUnauthorized: false`

### 2.3 tough-cookie 能否正确处理两个同名 JSESSIONID

- **现状**：两个 `JSESSIONID` 按 Path 区分（`/` 和 `/jsxsd`），代码依赖 `tough-cookie` 自动管理
- **风险**：如果 `tough-cookie` 在发送请求时只发送一个 `JSESSIONID`，可能导致会话无效
- **验证方法**：登录后检查 `jar.getCookies()` 输出，确认两个 Cookie 都存在

### 2.4 axios 跨 HTTP/HTTPS 重定向时 Cookie 传递

- **现状**：登录提交后服务端 302 到 `http://jw.gdipu.edu.cn`，浏览器自动升级为 HTTPS
- **风险**：axios 跟随 302 时，如果从 HTTPS 降到 HTTP，可能不会发送 Secure Cookie
- **验证方法**：运行真实登录，检查 `LoginToXk` 请求是否携带了 Cookie

### 2.5 `sjmsValue` 的有效期

- **现状**：从课表主页提取，批量抓取时复用
- **风险**：如果 `sjmsValue` 在一定时间后过期，批量抓取中途会失败
- **验证方法**：记录一次 `sjmsValue`，等待 5/10/30 分钟后再请求，看是否有效

### 2.6 验证码是否区分大小写

- **现状**：HAR 中验证码为 `r7jj`、`ud1w`、`mlhr`，都是小写
- **风险**：如果用户输入大写，可能登录失败
- **验证方法**：分别用大小写输入同一验证码测试

### 2.7 验证码失效时间

- **现状**：验证码获取后多久过期未知
- **风险**：人工输入耗时过长，验证码可能已失效
- **验证方法**：获取验证码后等待不同时间再提交登录

### 2.8 登录失败后验证码是否需要重新获取

- **现状**：密码错误或验证码错误后，原验证码是否还能用未知
- **风险**：重试登录时用了过期验证码，导致连续失败
- **验证方法**：故意输错一次密码，用同一验证码再试一次

### 2.9 多周课表 HTML 结构是否一致

- **现状**：只有第 17 周一个样本
- **风险**：空课表、单双周、调课、考试周等场景的 HTML 结构可能不同
- **验证方法**：抓取第 1、10、19 周及特殊日期的课表 HTML

### 2.10 课表是否有额外可选参数

- **现状**：页面 JS 中发现 `startZc`、`endZc`、`iskhfs` 参数入口，但 HAR 中实际请求只用了 `rq` 和 `sjmsValue`
- **风险**：某些功能可能需要额外参数
- **验证方法**：分别带和不带这些参数请求，对比返回结果

### 2.11 WAF 实际阈值

- **现状**：`waf-test.js` 已编写但尚未运行
- **风险**：不知道安全的最小请求间隔
- **验证方法**：非高峰时段运行 `waf-test.js`

### 2.12 其他业务接口的请求与响应格式

- **现状**：从首页菜单提取了 15+ 个功能 URL，但都没有实际请求样本
- **风险**：扩展成绩、考试、学籍等功能时需要重新抓包
- **验证方法**：逐个模块抓包

---

## 三、缺失信息（完全没有）

### 3.1 真实登录凭据

| 缺项     | 说明                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 真实密码 | 代码不再保存明文密码；需要通过 `--password` 或 `JW_PASSWORD` 在本地运行时提供，未进行真实登录测试 |

### 3.2 加密因子响应样本

| 缺项               | 说明                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| `scode#sxh` 响应体 | 两个 HAR 都没有记录 `flag=sess` 接口的响应内容，无法离线验证 `encoded` 生成结果 |

### 3.3 多周课表 HTML 样本

| 缺项              | 说明                                    |
| ----------------- | --------------------------------------- |
| 第 1 周课表 HTML  | 验证学期初课表结构                      |
| 第 10 周课表 HTML | 验证学期中课表结构                      |
| 第 19 周课表 HTML | 验证学期末课表结构                      |
| 空课表 HTML       | 寒暑假/考试周，验证无课程时的 HTML 结构 |
| 单双周课程 HTML   | 验证"单周"/"双周"标记的格式             |
| 调课/补课 HTML    | 验证节假日调课标记                      |
| 跨多节课程 HTML   | 验证 `rowspan` 处理                     |

### 3.4 错误页面样本

| 缺项                    | 说明                               |
| ----------------------- | ---------------------------------- |
| 密码错误页面完整 HTML   | 验证 `#showMsg` 标签结构           |
| 验证码错误页面完整 HTML | 同上                               |
| 会话过期页面            | 识别 `JSESSIONID` 失效后的响应特征 |
| WAF 拦截页面            | 识别被 WAF 拦截时的响应特征        |

### 3.5 验证码识别效果评估

| 缺项         | 说明                                                       |
| ------------ | ---------------------------------------------------------- |
| 多样本识别率 | 当前只有少量样本，无法统计 OCR 准确率                      |
| 混淆字符规则 | `0/o`、`1/l/i`、`5/s` 等字符需要更多样本确认是否应自动纠错 |
| 失败重试策略 | 已支持重新获取验证码，但最佳重试次数仍需实测               |

### 3.6 会话管理

| 缺项             | 说明                           |
| ---------------- | ------------------------------ |
| 会话过期检测规则 | 如何自动识别 `JSESSIONID` 失效 |
| 自动重登策略     | 会话过期后如何自动重新登录     |
| 退出登录接口     | 优雅退出，释放服务端会话       |

### 3.7 学期与周次

| 缺项            | 说明                               |
| --------------- | ---------------------------------- |
| 学期切换接口    | 无法批量切换学年学期               |
| 学期起止日期    | 不知道当前学期第一周周一的准确日期 |
| `rq` 跨学期行为 | 寒暑假日期传入 `rq` 返回什么       |

### 3.8 反爬策略

| 缺项              | 说明                         |
| ----------------- | ---------------------------- |
| WAF 限流阈值      | 单 IP/单账号的请求频率上限   |
| IP 封禁时长       | 触发限流后多久恢复           |
| 账号锁定策略      | 连续登录失败几次会锁定       |
| `acw_tc` 刷新机制 | 过期后是否需要重新获取登录页 |

### 3.9 数据持久化

| 缺项       | 说明                  |
| ---------- | --------------------- |
| 数据库方案 | MySQL / SQLite / 其他 |
| 数据表结构 | 课程表的入库字段设计  |

---

## 四、信息完整度评估

| 模块         | 完整度 | 说明                                     |
| ------------ | ------ | ---------------------------------------- |
| 登录流程     | 95%    | 缺真实密码验证和 `scode#sxh` 样本        |
| Cookie 机制  | 90%    | 缺 `Set-Cookie` 原始头（HAR 未保留）     |
| 验证码       | 90%    | 已接入本地 OCR，仍缺识别率统计和失效时间 |
| 课表抓取     | 90%    | 缺多周样本验证                           |
| 课表解析     | 80%    | 只验证了 1 个样本，缺边界场景            |
| 限流与重试   | 70%    | 代码已实现，缺 WAF 实际阈值              |
| 会话管理     | 40%    | 缺过期检测和自动重登                     |
| 其他业务接口 | 20%    | 只有 URL，无请求/响应样本                |
| 数据持久化   | 0%     | 未开始                                   |

---

## 五、下一步建议（按优先级排序）

### P0：验证登录（最高优先级）

1. 在 `crawler.js` 底部取消注释登录代码，填入真实账号密码
2. 运行 `node crawler.js`，观察是否能成功登录
3. 如果报错，检查：
   - HTTPS 证书问题 → 添加 `rejectUnauthorized: false`
   - Cookie 问题 → 检查 `jar.getCookies()` 输出
   - `encoded` 生成错误 → 对比浏览器 HAR 中的 `encoded`
   - 验证码问题 → 确认输入的验证码与图片一致

### P1：验证课表抓取

4. 登录成功后，调用 `getSchedule('2026-07-03')` 获取课表
5. 对比返回结果与 `kb.html` 的解析结果
6. 运行 `getScheduleBatch` 批量抓取 1~19 周，保存原始 HTML

### P2：稳定性验证

7. 运行 `waf-test.js` 测试安全间隔（非高峰时段）
8. 运行 `edge-case-capture.js` 抓取边界场景样本
9. 根据实测结果调整 `baseDelay` 和 `jitter`

### P3：功能扩展

10. 抓取成绩查询接口的请求/响应
11. 抓取考试安排接口的请求/响应
12. 实现会话过期检测和自动重登
13. 接入数据库持久化

### P4：工程化

14. 将账号密码等敏感配置移到环境变量
15. 增加单元测试（覆盖 `parseSchedule`、`encryptPassword`）
16. 收集 30~50 张验证码样本，统计 OCR 识别率并微调字符纠错策略

---

## 附 A：关键文件清单

| 文件                               | 说明                                 |
| ---------------------------------- | ------------------------------------ |
| `d:\校园论坛\crawler.js`           | 爬虫主代码                           |
| `d:\校园论坛\waf-test.js`          | WAF 阈值测试脚本                     |
| `d:\校园论坛\edge-case-capture.js` | 边界场景抓取脚本                     |
| `d:\校园论坛\package.json`         | 依赖配置                             |
| `d:\校园论坛\kb.html`              | 第 17 周课表 HTML 样本               |
| `d:\校园论坛\jw.gdip.edu.cn.har`   | 第一个 HAR 抓包（旧域名，无 Cookie） |
| `d:\校园论坛\jw.gdipu.edu.cn.har`  | 第二个 HAR 抓包（新域名，含 Cookie） |

---

## 附 B：文件依赖关系

```
crawler.js (核心类 JwCrawler)
  ├── axios + axios-cookiejar-support + tough-cookie  (HTTP/Cookie)
  ├── cheerio                                          (HTML解析)
  └── captcha-ocr.js                                   (验证码OCR)
        └── tesseract.js + eng.traineddata

waf-test.js
  └── crawler.js

edge-case-capture.js
  └── crawler.js
```

---

## 附 C：环境变量与配置一览

| 环境变量                | 命令行参数             | 默认值               | 说明                     |
| ----------------------- | ---------------------- | -------------------- | ------------------------ |
| `JW_ACCOUNT`            | `--account`            | -                    | 学号                     |
| `JW_PASSWORD`           | `--password`           | -                    | 密码                     |
| `JW_USE_OCR`            | `--ocr`                | `false`              | 启用本地 OCR             |
| `JW_CAPTCHA`            | `--captcha`            | -                    | 手动指定验证码（调试用） |
| `JW_CAPTCHA_ATTEMPTS`   | `--captcha-attempts`   | `1`                  | 验证码重试次数           |
| `JW_OCR_MIN_CONFIDENCE` | `--ocr-min-confidence` | `0`                  | OCR 最低置信度           |
| `JW_CAPTCHA_PATH`       | `--captcha-path`       | `./captcha.png`      | 验证码保存路径           |
| `JW_SEMESTER_START`     | `--semester-start`     | `2026-03-02`         | 学期第一周周一           |
| `JW_TOTAL_WEEKS`        | `--weeks`              | `19`                 | 抓取周数                 |
| `JW_OUTPUT`             | `--output`             | `courses_all.json`   | 输出文件                 |
| `JW_SAVE_DIR`           | `--save-dir`           | `./schedule_samples` | 原始 HTML 保存目录       |

---

## 附 D：风险矩阵（不确定项评估）

| 编号 | 不确定项                 | 影响程度 | 发生概率 | 风险等级  | 缓解措施                                |
| ---- | ------------------------ | -------- | -------- | --------- | --------------------------------------- |
| 2.1  | `encoded` 是否正确       | 🔴 高    | 🟡 中    | 🔴 **高** | 获取 `scode#sxh` 样本后离线比对         |
| 2.2  | HTTPS 证书自签名         | 🟡 中    | 🟢 低    | 🟢 **低** | 已准备 `rejectUnauthorized: false` 回退 |
| 2.3  | 两个 JSESSIONID 处理     | 🟡 中    | 🟢 低    | 🟢 **低** | 依赖 tough-cookie，登录后检查 jar 内容  |
| 2.4  | 跨协议重定向 Cookie 传递 | 🔴 高    | 🟡 中    | 🔴 **高** | 已手动处理 302 并把 http 升级为 https   |
| 2.5  | `sjmsValue` 有效期       | 🟡 中    | 🟢 低    | 🟢 **低** | 批量抓取时复用，失效后重新提取          |
| 2.6  | 验证码大小写             | 🟡 中    | 🟢 低    | 🟢 **低** | 统一转小写后提交                        |
| 2.7  | 验证码失效时间           | 🟡 中    | 🟡 中    | 🟡 **中** | OCR 自动识别减少人工等待时间            |
| 2.8  | 登录失败后验证码复用     | 🟡 中    | 🟡 中    | 🟡 **中** | 每次重试重新获取验证码                  |
| 2.9  | 多周课表 HTML 一致性     | 🔴 高    | 🟡 中    | 🔴 **高** | 抓取多周样本验证解析鲁棒性              |
| 2.10 | 课表额外参数             | 🟢 低    | 🟢 低    | 🟢 **低** | 当前功能无需额外参数                    |
| 2.11 | WAF 实际阈值             | 🟡 中    | 🟢 低    | 🟢 **低** | 已准备 waf-test.js，非高峰测试          |
| 2.12 | 其他业务接口格式         | 🟢 低    | 🟢 低    | 🟢 **低** | 扩展时再抓包                            |

**高优先级风险（需立即关注）**：2.1（加密正确性）、2.4（重定向 Cookie）、2.9（多周 HTML 一致性）

---

## 附 E：数据流说明

```
用户输入账号密码
    ↓
[1] GET /Logon.do?method=logon  →  初始化 Cookie (acw_tc, JSESSIONID/, SERVERID)
    ↓
[2] GET /verifycode.servlet?t=xxx  →  获取验证码图片 → 保存为 captcha.png
    ↓
[3] OCR 识别 / 人工输入  →  得到 4 位验证码 (如 r7jj)
    ↓
[4] POST /Logon.do?method=logon&flag=sess  →  获取加密因子 scode#sxh
    ↓
[5] encryptPassword()  →  生成 encoded
    ↓
[6] POST /Logon.do?method=logon  →  提交登录 (userAccount=, userPassword=, RANDOMCODE=, encoded=)
    ↓
[7] 302 重定向链  →  LoginToXk → xsMain.jsp  →  登录成功，获得 JSESSIONID/jsxsd
    ↓
[8] GET /jsxsd/framework/xsMain_new.jsp?t1=1  →  提取 sjmsValue
    ↓
[9] POST /jsxsd/framework/main_index_loadkb.jsp  →  传入 rq + sjmsValue 获取课表 HTML
    ↓
[10] parseSchedule()  →  解析为结构化课程数组
    ↓
[11] 保存为 JSON / 原始 HTML
```

---

## 附 F：更新日志

| 日期       | 更新内容                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 2026-07-03 | 梳理文档结构，补充文件依赖关系、环境变量、风险矩阵、数据流说明            |
| 2026-07-03 | 完成 crawler-info.md 初版：已知/不确定/缺失信息分类                       |
| 2026-07-03 | 分析第二份 HAR，确认统一域名 `jw.gdipu.edu.cn`、Cookie 机制、简化登录字段 |
| 2026-07-02 | 实现 `crawler.js` 主爬虫、验证码 OCR、课表解析                            |
| 2026-07-02 | 分析第一份 HAR 和课表 HTML 样本 `kb.html`                                 |

# 小程序多用户课表 API

后端支持多个学生账号。每个用户提交自己的教务账号和密码后，服务端会：

- 生成稳定的 `userId`
- 为该用户维护独立 crawler/cookie 会话
- 用 `APP_SECRET` 加密保存教务密码
- 将课表缓存隔离到 `.cache/users/<userId>/schedules/`

## 启动

```powershell
Copy-Item .env.example .env
npm run server
```

`.env` 至少需要：

```dotenv
API_KEY=replace-with-a-random-api-key
APP_SECRET=replace-with-a-long-random-secret-at-least-16-chars
```

`APP_SECRET` 上线后不要修改，否则旧的 `userId` 和已加密密码无法继续复用。

## 推荐流程

```text
用户打开小程序
  -> 输入学号 + 密码
  -> POST /api/user/login
  -> 如果返回 409 CAPTCHA_REQUIRED，显示 captcha.dataUrl
  -> POST /api/user/captcha/:challengeId
  -> 登录成功，保存 userId
  -> 后端后台同步当天课表
  -> GET /api/user/status?userId=xxx 查看同步状态
  -> GET /api/user/schedule?userId=xxx 显示课表
```

现在登录接口不会阻塞等待课表同步完成，真机端不需要长时间卡在 loading。

## 请求头

```http
x-api-key: your-api-key
```

## 接口

### `POST /api/user/login`

```json
{
  "account": "学号",
  "password": "教务密码"
}
```

成功：

```json
{
  "ok": true,
  "userId": "32-char-hex-id",
  "authenticated": true,
  "auth": {
    "status": "authenticated",
    "authenticated": true
  },
  "sync": {
    "status": "syncing",
    "date": "2026-07-05"
  }
}
```

需要验证码时返回 HTTP `409`：

```json
{
  "ok": false,
  "code": "CAPTCHA_REQUIRED",
  "userId": "32-char-hex-id",
  "challengeId": "uuid",
  "captcha": {
    "dataUrl": "data:image/png;base64,..."
  }
}
```

### `POST /api/user/captcha/:challengeId`

```json
{
  "code": "a1b2"
}
```

成功响应和 `/api/user/login` 一样，包含 `userId`。

### `GET /api/user/status?userId=xxx`

返回登录状态、缓存数量和后台同步状态。

`sync.status` 可能是：

- `syncing`: 登录成功，正在后台导入当天课表
- `done`: 当天课表已导入并缓存
- `failed`: 登录成功，但课表导入失败，可让用户重试或调用课表接口重新拉取

### `GET /api/user/schedule?userId=xxx&date=2026-07-05&format=mini`

返回某一周课表。如果缓存有效会直接返回缓存；如果会话过期，会读取该用户加密凭据并重新登录。

### `GET /api/user/schedule/weeks?userId=xxx&semesterStart=2026-03-02&weeks=19`

批量同步多周课表。这个接口仍然可能较慢，不建议在真机页面主流程里直接阻塞等待。

## 小程序示例

```js
const API_BASE = 'https://your-domain.example.com';
const API_KEY = 'same-as-backend-api-key';

function apiRequest({ url, method = 'GET', data = {} }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE}${url}`,
      method,
      data,
      timeout: 20000,
      header: { 'x-api-key': API_KEY },
      success(res) {
        if (res.statusCode === 409 && res.data.code === 'CAPTCHA_REQUIRED') {
          resolve({ needCaptcha: true, challenge: res.data });
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data.ok) {
          resolve(res.data);
          return;
        }
        reject(new Error(res.data?.message || 'request failed'));
      },
      fail: reject,
    });
  });
}

async function login(account, password) {
  const result = await apiRequest({
    url: '/api/user/login',
    method: 'POST',
    data: { account, password },
  });

  if (result.needCaptcha) return result;
  wx.setStorageSync('jwUserId', result.userId);
  return result;
}

async function submitCaptcha(challengeId, code) {
  const result = await apiRequest({
    url: `/api/user/captcha/${challengeId}`,
    method: 'POST',
    data: { code },
  });
  wx.setStorageSync('jwUserId', result.userId);
  return result;
}

function getSchedule(date) {
  const userId = wx.getStorageSync('jwUserId');
  return apiRequest({
    url: '/api/user/schedule',
    data: { userId, date, format: 'mini' },
  });
}
```

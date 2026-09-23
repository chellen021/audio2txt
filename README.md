# audio2txt

一个免费的在线音频转文字网站：上传录音，得到文字稿，并可下载 TXT 文本和 SRT、VTT 字幕。

线上地址：**https://stt.chinamed.tech**

- **识别模型**：OpenAI Whisper large-v3-turbo，支持普通话、粤语、英语、日语、韩语、法语、德语、西班牙语、俄语，也可以自动识别语言
- **主力线路**：Cloudflare Workers AI（每日免费额度）
- **备用线路**：Hugging Face ZeroGPU Space（使用 HF PRO 账号的 GPU 额度）
- **登录**：[Clerk](https://clerk.com)，支持邮箱验证码、Google、GitHub 三种方式；登录后才能转写，按用户限流
- **隐私**：音频和文字稿都不保存，网站没有数据库，见 [隐私政策](https://stt.chinamed.tech/privacy)

## 工作原理

```
浏览器
  │ 1. 在本地把音频解码成 16kHz 单声道，按约 60 秒切段（切点选在附近最安静处）
  │ 2. 用户通过 Clerk 登录，前端取得短期会话令牌（有效期约 1 分钟，自动续期）
  │ 3. 每段转成 WAV，带着令牌发给 /api/transcribe（同时 2 段）
  ▼
Cloudflare Worker（stt.chinamed.tech）
  │ · 返回首页时注入 Clerk 发布密钥
  │ · 用 @clerk/backend 校验令牌、按用户限流
  │ · 先调用 Workers AI whisper-large-v3-turbo
  │ · 失败或当日免费额度用完时，改为调用 HF Space
  ▼
Hugging Face Space（私有，ZeroGPU）
    Gradio + transformers 运行 whisper-large-v3-turbo
```

浏览器收到每段结果后，把时间戳换算到整段音频上，拼成文字稿和字幕。切段在浏览器里做，所以单个请求很小，不会超时，页面也能显示逐段进度。

登录弹窗、账户菜单由 Clerk 的前端组件提供，从 jsDelivr 加载，界面为简体中文。前端没有构建步骤，`public/` 里的文件原样发布。

## 目录结构

```
audio2txt/
├── web/                     Cloudflare Worker：网站页面 + 接口
│   ├── wrangler.jsonc       Worker 配置：域名、AI 绑定、限流、环境变量
│   ├── package.json         依赖：@clerk/backend
│   ├── src/index.js         接口 /api/transcribe、/api/health；首页注入 Clerk 发布密钥
│   └── public/              前端静态文件
│       ├── index.html
│       ├── privacy.html     隐私政策（中英双语，Google 品牌验证需要）
│       ├── style.css
│       └── app.js           登录、解码、切段、上传、波形进度、导出字幕
└── hf-space/                Hugging Face Space：备用转写后端
    ├── README.md            Space 配置（SDK、版本）
    ├── app.py               Gradio 接口 transcribe(audio, language, prompt)
    ├── requirements.txt
    └── packages.txt         系统依赖 ffmpeg
```

## 接口

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/transcribe?language=zh` | POST | 请求体为音频（WAV，单段不超过 8 MB），请求头 `Authorization: Bearer <Clerk 会话令牌>`；返回 `{"provider", "text", "segments"}` |
| `/api/health` | GET | 健康检查 |

`language` 可选值：留空（自动识别）、`zh`、`yue`、`en`、`ja`、`ko`、`fr`、`de`、`es`、`ru`。选 `zh` 时会附带提示词，让输出为简体中文并带标点。

`provider` 为 `workers-ai` 或 `huggingface`，表示这一段由哪条线路完成。

错误码：

| 状态码 | 含义 |
|---|---|
| 400 | 语言不支持，或音频分段为空 |
| 401 | 没有登录，或令牌无效、已过期（`code: "auth_required"`） |
| 413 | 音频分段超过 8 MB |
| 429 | 超过限流，稍后重试 |
| 503 | 两条转写线路都不可用 |

## 配置项

| 名称 | 类型 | 说明 |
|---|---|---|
| `HF_SPACE_URL` | 变量（`wrangler.jsonc`） | 备用线路 Space 的地址 |
| `CLERK_PUBLISHABLE_KEY` | 变量（`wrangler.jsonc`） | Clerk 发布密钥，可以公开；线上为 `pk_live_` |
| `CLERK_SECRET_KEY` | Secret | Clerk 私钥，只在 Worker 里使用，**不能出现在前端代码中** |
| `HF_TOKEN` | Secret | HF fine-grained token，只需该 Space 的读取权限 |
| `CLERK_JWT_KEY` | Secret，可选 | Clerk 的 JWT 公钥（PEM），设置后校验令牌不再请求 Clerk |
| `FORCE_PROVIDER` | 变量，可选 | 设为 `hf` 时只走备用线路，用于测试 |

## 部署

需要：Node.js 22 以上、[wrangler](https://developers.cloudflare.com/workers/wrangler/)、[hf CLI](https://huggingface.co/docs/huggingface_hub/guides/cli)，一个托管了域名的 Cloudflare 账号，一个 Hugging Face PRO 账号（ZeroGPU 需要 PRO），一个 Clerk 账号。

### 1. 部署 Hugging Face Space

```bash
hf auth login
hf repos create <用户名>/audio2txt-whisper --type space --sdk gradio --flavor zero-a10g --private
hf upload <用户名>/audio2txt-whisper hf-space . --type space
```

构建完成后，Space 地址形如 `https://<用户名>-audio2txt-whisper.hf.space`，把它填到 `web/wrangler.jsonc` 的 `HF_SPACE_URL`。

### 2. 创建 Clerk 应用

在 [Clerk 控制台](https://dashboard.clerk.com) 新建应用，勾选邮箱登录。新应用默认是 Development 实例（`pk_test_` / `sk_test_`），可以直接用于本地开发和试运行。

正式上线要切换到 Production 实例：

1. 在控制台顶部的实例下拉菜单里选 **Create production instance**，选择复制 Development 实例的设置。
2. 填写应用域名。本项目用的是根域名 `chinamed.tech`，Clerk 前端接口在 `clerk.chinamed.tech`，登录状态在 chinamed.tech 的各个子域名之间共享。
3. 打开 **Domains** 页面，把列出的 5 条 CNAME 记录（`clerk`、`accounts`、`clkmail`、`clk._domainkey`、`clk2._domainkey`）加到 DNS。在 Cloudflare 里**必须设为“仅 DNS”（灰色云朵）**，开代理会导致验证失败。
4. 验证通过后点 **Deploy certificates**，等 `https://clerk.<域名>/v1/environment` 能正常访问。
5. 在 **API Keys** 页面取得 `pk_live_` 和 `sk_live_`，分别用于第 5 步的 `CLERK_PUBLISHABLE_KEY` 和 `CLERK_SECRET_KEY`。

Production 实例是全新的，Development 实例里的用户不会带过去。

### 3. 配置 Google 登录（可选）

Production 实例必须使用自己的 Google OAuth 凭据：

1. 在 Clerk 的 **SSO connections → Add connection → For all users → Google** 里，打开 **Enable for sign-up and sign-in** 和 **Use custom credentials**，复制回调地址（`https://clerk.<域名>/v1/oauth_callback`）。
2. 在 [Google Cloud 控制台](https://console.cloud.google.com) 新建项目，在 **Google Auth Platform** 里：
   - **Branding**：填写应用名称和支持邮箱；首页填 `https://stt.chinamed.tech`，隐私权政策填 `https://stt.chinamed.tech/privacy`，已获授权的网域加上 `chinamed.tech`。
   - **Audience**：用户类型选 External，然后点 **Publish app** 改为 **In production**。停留在 Testing 状态时只有测试用户能登录。
   - **Clients**：新建 Web application 类型的客户端；JavaScript 来源填 `https://stt.chinamed.tech`，重定向 URI 填第 1 步的回调地址。
3. 把 Client ID 和 Client Secret 填回 Clerk 并保存。

**品牌验证**：Google 会审核同意页上的品牌信息，要求：

- 首页域名已在 [Search Console](https://search.google.com/search-console) 里由项目所有者验证。本项目用“网域”资源验证了 `chinamed.tech`，方法是在 DNS 里添加一条 `google-site-verification` TXT 记录。
- 同一域名下有隐私政策页面，首页有链接指向它，并说明如何使用 Google 用户数据。
- 首页说明了应用的功能。

只申请邮箱和基本资料权限、不上传 Logo 时，不需要等审核就能正常登录。

中国大陆无法访问 Google，这部分用户需要用邮箱验证码或 GitHub 登录。

### 4. 配置 GitHub 登录（可选）

1. 在 Clerk 的 **SSO connections → Add connection → For all users → GitHub** 里，打开 **Enable for sign-up and sign-in** 和 **Use custom credentials**，复制回调地址。
2. 在 GitHub 的 [Developer settings → OAuth Apps](https://github.com/settings/developers) 新建 OAuth App：
   - **Homepage URL**：`https://stt.chinamed.tech`
   - **Authorization callback URL**：第 1 步的回调地址
   - **Enable Device Flow**：不勾选
3. 生成 Client Secret（只显示一次），把 Client ID 和 Client Secret 填回 Clerk 并保存。

Clerk 默认只申请 `user:email read:user`，不涉及代码仓库，不需要额外添加 scope。

### 5. 部署 Cloudflare Worker

修改 `web/wrangler.jsonc` 里 `routes` 的域名和 `CLERK_PUBLISHABLE_KEY`，然后：

```bash
cd web
npm install
wrangler deploy
wrangler secret put HF_TOKEN
wrangler secret put CLERK_SECRET_KEY
```

`routes` 中的 `custom_domain: true` 会让 Cloudflare 自动创建 DNS 记录和证书。

更换 Clerk 密钥时，可以用一次部署同时更新发布密钥和私钥，避免中间出现登录失败的窗口：

```bash
wrangler deploy --secrets-file <包含 CLERK_SECRET_KEY=... 的文件>
```

### 更新

```bash
cd web && npm install && wrangler deploy                         # 更新网站和接口
hf upload <用户名>/audio2txt-whisper hf-space . --type space     # 更新 Space
```

## 本地开发

在 `web/` 下新建 `.dev.vars`（已被 git 忽略）：

```
CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx
HF_TOKEN=hf_xxx
# 取消下一行注释可强制只走 HF 线路，用来测试备用线路
# FORCE_PROVIDER=hf
```

然后运行 `npm install && wrangler dev`，打开 http://localhost:8787 。

- Clerk 的 Production 实例不能在 localhost 上使用，本地开发必须用 Development 实例的密钥。`.dev.vars` 里的值会覆盖 `wrangler.jsonc` 里的线上配置。
- Workers AI 在本地开发时也会调用线上服务，会消耗额度。

## 配置和限制

| 项目 | 位置 | 当前值 |
|---|---|---|
| 上传文件大小上限 | `app.js` `MAX_FILE_BYTES` | 50 MB |
| 每段时长 | `app.js` `CHUNK_SECONDS` | 60 秒 |
| 同时处理的段数 | `app.js` `CONCURRENCY` | 2 |
| 单段请求失败重试次数 | `app.js` `MAX_ATTEMPTS` | 4 |
| 限流 | `wrangler.jsonc` `ratelimits` | 每个用户每分钟 30 段 |
| Space 上传文件清理 | `app.py` `delete_cache` | 每小时清理超过 1 小时的文件 |

注意事项：

- **备用线路只在 Workers 免费套餐下触发。** 付费套餐超出免费额度后会直接计费，请求不会失败，也就不会切换到 HF。
- **音频解码依赖浏览器。** 很长的音频解码后占用内存较多，手机上可能失败，所以设了 50 MB 上限。
- **ZeroGPU 额度按天计算。** Space 长时间没人访问会休眠，第一次走备用线路时需要等待启动。

## 常见问题

**页面提示“登录组件加载失败”。** Clerk 的前端脚本从 cdn.jsdelivr.net 加载，前端接口在 `clerk.<域名>`。广告拦截插件或网络问题可能拦截它们，可以关闭插件或换个网络再试。

**所有转写请求都返回 401。** 检查 `CLERK_PUBLISHABLE_KEY` 和 `CLERK_SECRET_KEY` 是否来自同一个 Clerk 实例（都是 `test` 或都是 `live`）。另外，令牌里的 `azp` 必须和网站地址一致，Worker 用请求的来源地址校验它。

**Google 或 GitHub 登录报 `redirect_uri` 错误。** OAuth 应用里填的回调地址要和 Clerk 显示的完全一致，包括 `https://` 和路径。

**改了账户区的样式，头像位置却不对。** Clerk 挂载 UserButton 时会把挂载节点的 `class` 换成它自己的，所以 `app.js` 把组件挂在 `#account` 里面的子元素上。不要直接挂到带样式的元素上。

## 许可证

本项目代码以 [MIT 许可证](LICENSE) 发布。使用的 Whisper 模型（openai/whisper-large-v3-turbo）同样采用 MIT 许可证。

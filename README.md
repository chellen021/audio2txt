# audio2txt

一个免费的在线音频转文字网站：上传录音，得到文字稿，并可下载 TXT 文本和 SRT、VTT 字幕。

线上地址：**https://stt.chinamed.tech**

- 识别模型：OpenAI Whisper large-v3-turbo，支持普通话、粤语、英语、日语、韩语等
- 主力线路：Cloudflare Workers AI（每日免费额度）
- 备用线路：Hugging Face ZeroGPU Space（使用 HF PRO 账号的 GPU 额度）
- 登录与防滥用：[Clerk](https://clerk.com) 账号登录，按用户限流

## 工作原理

```
浏览器
  │ 1. 在本地把音频解码成 16kHz 单声道，按约 60 秒切段（切点选在附近最安静处）
  │ 2. 用户通过 Clerk 登录，前端取得短期会话令牌
  │ 3. 每段转成 WAV，带着令牌发给 /api/transcribe（同时 2 段）
  ▼
Cloudflare Worker（stt.chinamed.tech）
  │ · 用 @clerk/backend 校验令牌、按用户限流
  │ · 先调用 Workers AI whisper-large-v3-turbo
  │ · 失败或当日免费额度用完时，改为调用 HF Space
  ▼
Hugging Face Space（私有，ZeroGPU）
    Gradio + transformers 运行 whisper-large-v3-turbo
```

浏览器收到每段结果后，把时间戳换算到整段音频上，拼成文字稿和字幕。切段在浏览器里做，所以单个请求很小，不会超时，页面也能显示逐段进度；网站不需要数据库，也不保存用户音频。

## 目录结构

```
audio2txt/
├── web/                     Cloudflare Worker：网站页面 + 接口
│   ├── wrangler.jsonc       Worker 配置：域名、AI 绑定、限流、环境变量
│   ├── package.json         依赖：@clerk/backend
│   ├── src/index.js         接口：/api/transcribe、/api/health
│   └── public/              前端静态文件
│       ├── index.html
│       ├── privacy.html     隐私政策（Google 品牌验证需要）
│       ├── style.css
│       └── app.js           解码、切段、上传、波形进度、导出字幕
└── hf-space/                Hugging Face Space：备用转写后端
    ├── README.md            Space 配置（SDK、版本）
    ├── app.py               Gradio 接口 transcribe(audio, language, prompt)
    ├── requirements.txt
    └── packages.txt         系统依赖 ffmpeg
```

## 接口

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/transcribe?language=zh` | POST | 请求体为音频（WAV，单段不超过 8 MB），请求头 `Authorization: Bearer <Clerk 会话令牌>`；返回 `{"provider", "text", "segments"}`，未登录返回 401 |
| `/api/health` | GET | 健康检查 |

`language` 可选值：留空（自动识别）、`zh`、`yue`、`en`、`ja`、`ko`、`fr`、`de`、`es`、`ru`。选 `zh` 时会附带提示词，让输出为简体中文并带标点。

`provider` 为 `workers-ai` 或 `huggingface`，表示这一段由哪条线路完成。

## 部署

需要：Node.js 18 以上、[wrangler](https://developers.cloudflare.com/workers/wrangler/)、[hf CLI](https://huggingface.co/docs/huggingface_hub/guides/cli)，一个托管了域名的 Cloudflare 账号，一个 Hugging Face PRO 账号（ZeroGPU 需要 PRO）。

### 1. 部署 Hugging Face Space

```bash
hf auth login
hf repos create <用户名>/audio2txt-whisper --type space --sdk gradio --flavor zero-a10g --private
hf upload <用户名>/audio2txt-whisper hf-space . --type space
```

构建完成后，Space 地址形如 `https://<用户名>-audio2txt-whisper.hf.space`，把它填到 `web/wrangler.jsonc` 的 `HF_SPACE_URL`。

### 2. 创建 Clerk 应用

在 [Clerk 控制台](https://dashboard.clerk.com) 新建应用，选好登录方式（邮箱、手机号、第三方账号等）。在 API Keys 页面：

- 把 **Publishable Key**（`pk_` 开头）填到 `web/wrangler.jsonc` 的 `CLERK_PUBLISHABLE_KEY`，Worker 返回首页时会把它注入页面
- **Secret Key**（`sk_` 开头）下一步使用

线上使用 Production 实例（`pk_live_` / `sk_live_`），Clerk 应用域名为根域名 `chinamed.tech`（前端接口在 `clerk.chinamed.tech`），登录状态在 chinamed.tech 的各个子域名之间共享。Clerk 要求的 DNS 记录在 Cloudflare 里必须设为“仅 DNS”（灰色云朵），不能开代理。Production 实例不能在 localhost 上使用，本地开发继续用 Development 实例的密钥（见“本地开发”）。

### 3. 部署 Cloudflare Worker

修改 `web/wrangler.jsonc` 里 `routes` 的域名，然后：

```bash
cd web
npm install
wrangler deploy
wrangler secret put HF_TOKEN            # HF fine-grained token，只需该 Space 的读取权限
wrangler secret put CLERK_SECRET_KEY    # Clerk 的 Secret Key
# 可选：wrangler secret put CLERK_JWT_KEY  # API Keys 页面的 JWT 公钥（PEM），设置后校验令牌不再请求 Clerk
```

`routes` 中的 `custom_domain: true` 会让 Cloudflare 自动创建 DNS 记录和证书。

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

然后运行 `npm install && wrangler dev`。本地开发用 Clerk 的 Development 实例密钥即可，`localhost` 可以直接登录。Workers AI 在本地开发时也会调用线上服务，会消耗额度。

## 配置和限制

| 项目 | 位置 | 当前值 |
|---|---|---|
| 上传文件大小上限 | `app.js` `MAX_FILE_BYTES` | 50 MB |
| 每段时长 | `app.js` `CHUNK_SECONDS` | 60 秒 |
| 同时处理的段数 | `app.js` `CONCURRENCY` | 2 |
| 限流 | `wrangler.jsonc` `ratelimits` | 每个用户每分钟 30 段 |
| Space 上传文件清理 | `app.py` `delete_cache` | 每小时清理超过 1 小时的文件 |

注意事项：

- **备用线路只在 Workers 免费套餐下触发。** 付费套餐超出免费额度后会直接计费，请求不会失败，也就不会切换到 HF。
- **音频解码依赖浏览器。** 很长的音频解码后占用内存较多，手机上可能失败，所以设了 50 MB 上限。
- **ZeroGPU 额度按天计算。** Space 长时间没人访问会休眠，第一次走备用线路时需要等待启动。

## 许可证

本项目代码以 [MIT 许可证](LICENSE) 发布。使用的 Whisper 模型（openai/whisper-large-v3-turbo）同样采用 MIT 许可证。

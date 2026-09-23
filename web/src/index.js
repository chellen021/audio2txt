const AI_MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const LANGUAGES = new Set(["", "zh", "en", "ja", "ko", "yue", "fr", "de", "es", "ru"]);
const SESSION_TTL_SECONDS = 2 * 60 * 60;
const PROMPTS = {
  zh: "以下是普通话的句子，使用简体中文和标点符号。",
};

// Workers AI 免费额度用完后，本 isolate 内直到 UTC 次日零点都直接走 HF，省去一次必然失败的请求。
let aiExhaustedUntil = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") {
      if (request.method !== "POST") return json({ error: "只支持 POST 请求" }, 405);
      return handleSession(request, env);
    }
    if (url.pathname === "/api/transcribe") {
      if (request.method !== "POST") return json({ error: "只支持 POST 请求" }, 405);
      if (!(await verifySession(request.headers.get("x-session"), env))) {
        return json({ error: "人机验证已过期，请重新验证", code: "session_required" }, 401);
      }
      return handleTranscribe(request, env, url);
    }
    if (url.pathname === "/api/health") return json({ ok: true });
    if (url.pathname.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
    return env.ASSETS.fetch(request);
  },
};

// 用户通过 Turnstile 后换取一张 2 小时有效的签名通行证，之后每个分段请求只校验通行证
async function handleSession(request, env) {
  const { token } = await request.json().catch(() => ({}));
  if (!token) return json({ error: "缺少人机验证结果" }, 400);

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const outcome = await res.json();
  if (!outcome.success) {
    console.warn("Turnstile rejected", outcome["error-codes"]);
    return json({ error: "人机验证没有通过，请刷新页面重试" }, 403);
  }

  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ exp: expires })));
  return json({ session: `${payload}.${await sign(payload, env)}`, expires });
}

async function verifySession(session, env) {
  if (!session) return false;
  const [payload, signature] = session.split(".");
  if (!payload || !signature) return false;
  try {
    const key = await hmacKey(env);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64url(signature), new TextEncoder().encode(payload));
    if (!valid) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    return exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

async function sign(payload, env) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(payload));
  return base64url(new Uint8Array(signature));
}

function hmacKey(env) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

function base64url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function handleTranscribe(request, env, url) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "请求太频繁，请稍等一分钟再试" }, 429);
  }

  const language = url.searchParams.get("language") || "";
  if (!LANGUAGES.has(language)) return json({ error: "不支持的语言" }, 400);
  const prompt = PROMPTS[language] || "";

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return json({ error: "音频分段为空" }, 400);
  if (bytes.length > MAX_CHUNK_BYTES) return json({ error: "音频分段过大" }, 413);

  const errors = [];
  if (env.FORCE_PROVIDER !== "hf" && Date.now() >= aiExhaustedUntil) {
    try {
      return json(await transcribeWithWorkersAI(env, bytes, language, prompt));
    } catch (err) {
      const message = String(err?.message || err);
      errors.push(`workers-ai: ${message}`);
      if (/4006|daily free allocation|neurons|quota/i.test(message)) {
        const tomorrow = new Date();
        tomorrow.setUTCHours(24, 0, 0, 0);
        aiExhaustedUntil = tomorrow.getTime();
      }
      console.warn("Workers AI failed, falling back to HF", message);
    }
  }

  if (!env.HF_TOKEN) {
    return json({ error: "转写服务暂时不可用，请稍后再试", detail: errors }, 503);
  }
  try {
    return json(await transcribeWithHF(env, bytes, language, prompt));
  } catch (err) {
    errors.push(`hf: ${String(err?.message || err)}`);
    console.error("HF fallback failed", errors);
    return json({ error: "转写服务暂时不可用，请稍后再试", detail: errors }, 503);
  }
}

async function transcribeWithWorkersAI(env, bytes, language, prompt) {
  const input = {
    audio: toBase64(bytes),
    task: "transcribe",
    vad_filter: true,
    condition_on_previous_text: false,
  };
  if (language) input.language = language;
  if (prompt) input.initial_prompt = prompt;

  const out = await env.AI.run(AI_MODEL, input);
  return {
    provider: "workers-ai",
    text: (out.text || "").trim(),
    segments: (out.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
  };
}

async function transcribeWithHF(env, bytes, language, prompt) {
  const base = env.HF_SPACE_URL;
  const auth = { Authorization: `Bearer ${env.HF_TOKEN}` };

  const form = new FormData();
  form.append("files", new Blob([bytes], { type: "audio/wav" }), "chunk.wav");
  const upload = await fetch(`${base}/gradio_api/upload`, { method: "POST", headers: auth, body: form });
  if (!upload.ok) throw new Error(`upload ${upload.status}: ${await upload.text()}`);
  const [path] = await upload.json();

  const call = await fetch(`${base}/gradio_api/call/transcribe`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{ path, meta: { _type: "gradio.FileData" } }, language, prompt],
    }),
  });
  if (!call.ok) throw new Error(`call ${call.status}: ${await call.text()}`);
  const { event_id } = await call.json();

  const result = await fetch(`${base}/gradio_api/call/transcribe/${event_id}`, { headers: auth });
  if (!result.ok) throw new Error(`result ${result.status}: ${await result.text()}`);
  const out = parseGradioEvents(await result.text());

  return {
    provider: "huggingface",
    text: (out.text || "").trim(),
    segments: (out.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
  };
}

// Gradio 以 SSE 返回结果：event: complete / error，data 为 JSON 数组
function parseGradioEvents(body) {
  for (const block of body.split("\n\n")) {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    if (event === "complete") return JSON.parse(data)[0];
    if (event === "error") throw new Error(`space error: ${data}`);
  }
  throw new Error(`space returned no result: ${body.slice(0, 200)}`);
}

function toBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

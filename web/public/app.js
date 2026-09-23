const SAMPLE_RATE = 16000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK_SECONDS = 60;
// 在目标切分点前后这么多秒内找最安静的位置下刀，避免把一个字切成两半
const SEARCH_SECONDS = 5;
const CONCURRENCY = 2;
const MAX_ATTEMPTS = 4;
const TURNSTILE_SITEKEY = "0x4AAAAAAFAtXXnTIEQz1iJX";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), wave: $("wave"), meta: $("meta"),
  fileName: $("fileName"), fileInfo: $("fileInfo"), language: $("language"),
  start: $("start"), cancel: $("cancel"), status: $("status"), result: $("result"),
  text: $("text"), copy: $("copy"), dlTxt: $("dlTxt"), dlSrt: $("dlSrt"), dlVtt: $("dlVtt"),
};

let audio = null;        // { name, pcm, chunks: [{ start, end }] }，start/end 为采样点下标
let chunkState = [];     // "pending" | "active" | "done"
let results = [];        // 每段的转写结果
let controller = null;
let peaksCache = null;

// ---------- 读取音频 ----------

els.file.addEventListener("change", () => {
  if (els.file.files[0]) loadFile(els.file.files[0]);
});

for (const type of ["dragenter", "dragover"]) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.drop.addEventListener(type, () => els.drop.classList.remove("over"));
}
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  if (controller) return;
  audio = null;
  results = [];
  chunkState = [];
  peaksCache = null;
  els.start.disabled = true;
  els.result.hidden = true;
  els.drop.classList.remove("loaded");
  els.meta.hidden = true;
  draw();

  if (file.size > MAX_FILE_BYTES) {
    return setStatus(`文件有 ${formatBytes(file.size)}，超过 50 MB 上限。请先压缩或剪短后再上传。`, true);
  }

  setStatus("正在读取音频…");
  let pcm;
  try {
    pcm = await decodeToMono16k(await file.arrayBuffer());
  } catch {
    return setStatus("无法读取这个文件。请换成 MP3、M4A 或 WAV 格式再试。", true);
  }
  if (pcm.length < SAMPLE_RATE / 2) {
    return setStatus("音频太短，至少需要半秒。", true);
  }

  audio = { name: file.name, pcm, chunks: splitChunks(pcm) };
  chunkState = audio.chunks.map(() => "pending");
  els.drop.classList.add("loaded");
  els.meta.hidden = false;
  els.fileName.textContent = file.name;
  els.fileInfo.textContent = `${formatDuration(pcm.length / SAMPLE_RATE)}，共 ${audio.chunks.length} 段`;
  els.start.disabled = false;
  setStatus("选好语言后点击“开始转写”。");
  draw();
}

async function decodeToMono16k(buffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buffer);
  } finally {
    ctx.close();
  }
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * SAMPLE_RATE), SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function splitChunks(pcm) {
  const target = CHUNK_SECONDS * SAMPLE_RATE;
  const search = SEARCH_SECONDS * SAMPLE_RATE;
  const frame = Math.round(0.05 * SAMPLE_RATE);
  const chunks = [];
  let start = 0;
  while (pcm.length - start > target + search) {
    let best = start + target;
    let bestEnergy = Infinity;
    for (let f = start + target - search; f + frame <= start + target + search; f += frame) {
      let energy = 0;
      for (let i = f; i < f + frame; i += 4) energy += pcm[i] * pcm[i];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        best = f + (frame >> 1);
      }
    }
    chunks.push({ start, end: best });
    start = best;
  }
  chunks.push({ start, end: pcm.length });
  return chunks;
}

function encodeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------- 转写 ----------

els.start.addEventListener("click", run);
els.cancel.addEventListener("click", () => controller?.abort());

async function run() {
  if (!audio || controller) return;
  controller = new AbortController();
  const { signal } = controller;
  const language = els.language.value;
  const total = audio.chunks.length;
  const startedAt = Date.now();
  results = new Array(total);
  chunkState = audio.chunks.map(() => "pending");
  let next = 0;
  let done = 0;

  setBusy(true);
  els.result.hidden = false;
  els.text.value = "";
  setStatus(`正在转写：0 / ${total} 段`);
  draw();

  const worker = async () => {
    while (next < total && !signal.aborted) {
      const i = next++;
      chunkState[i] = "active";
      draw();
      results[i] = await transcribeChunk(i, language, signal);
      chunkState[i] = "done";
      done++;
      els.text.value = buildText();
      setStatus(`正在转写：${done} / ${total} 段`);
      draw();
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    setStatus(`转写完成，用时 ${formatDuration(seconds)}。${providerNote()}`);
  } catch (err) {
    controller.abort();
    chunkState = chunkState.map((s) => (s === "active" ? "pending" : s));
    if (err.name === "AbortError") {
      setStatus(`已停止，完成了 ${done} / ${total} 段。`);
    } else {
      setStatus(`${err.message}。已完成的 ${done} 段保留在下方。`, true);
    }
    draw();
  } finally {
    controller = null;
    setBusy(false);
    els.text.value = buildText();
  }
}

async function transcribeChunk(index, language, signal) {
  const { start, end } = audio.chunks[index];
  const body = encodeWav(audio.pcm.subarray(start, end));
  const url = `/api/transcribe?language=${encodeURIComponent(language)}`;
  let lastError = "转写失败";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pass = await ensureSession(signal);
    let res;
    try {
      res = await fetch(url, { method: "POST", body, headers: { "Content-Type": "audio/wav", "X-Session": pass }, signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = "网络连接中断";
      await sleep(2000 * attempt, signal);
      continue;
    }
    if (res.ok) return res.json();

    const data = await res.json().catch(() => ({}));
    lastError = data.error || `服务器返回错误 ${res.status}`;
    if (res.status === 401) {
      if (session?.session === pass) session = null;
    } else if (res.status === 429) {
      setStatus("请求太频繁，稍等片刻后自动继续…");
      await sleep(20000, signal);
    } else if (res.status >= 500) {
      await sleep(3000 * attempt, signal);
    } else {
      break;
    }
  }
  throw new Error(`第 ${index + 1} 段${lastError}`);
}

// ---------- 人机验证 ----------

let widgetId = null;
let turnstileToken = null;
let turnstileError = null;
let tokenWaiters = [];
let session = null;          // { session, expires }，expires 为秒级时间戳
let sessionPromise = null;

function initTurnstile() {
  widgetId = window.turnstile.render("#captcha", {
    sitekey: TURNSTILE_SITEKEY,
    appearance: "interaction-only",
    language: "zh-cn",
    callback: (token) => {
      turnstileToken = token;
      turnstileError = null;
      flushWaiters();
    },
    "expired-callback": () => { turnstileToken = null; },
    "error-callback": () => {
      turnstileError = "人机验证加载失败。请刷新页面，或暂时关闭广告拦截插件后重试";
      flushWaiters();
    },
  });
}

if (window.turnstile) initTurnstile();
else document.getElementById("turnstileScript").addEventListener("load", initTurnstile);

function flushWaiters() {
  const waiters = tokenWaiters;
  tokenWaiters = [];
  waiters.forEach((w) => w());
}

// 取一个 Turnstile 结果；需要用户点选时，验证框会自动出现在按钮下方
function takeTurnstileToken(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(), 120000);
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      tokenWaiters = tokenWaiters.filter((w) => w !== finish);
      if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
      if (turnstileToken) {
        const token = turnstileToken;
        turnstileToken = null;
        return resolve(token);
      }
      reject(new Error(turnstileError || "人机验证超时，请刷新页面重试"));
    }
    if (turnstileToken || turnstileError) return finish();
    setStatus("正在进行人机验证…");
    tokenWaiters.push(finish);
  });
}

async function ensureSession(signal) {
  if (session && session.expires * 1000 - Date.now() > 60000) return session.session;
  sessionPromise ??= (async () => {
    try {
      const token = await takeTurnstileToken(signal);
      // 用掉的结果不能再用，立刻重置，为下一次换通行证做准备
      if (widgetId !== null) window.turnstile.reset(widgetId);
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `人机验证失败（${res.status}）`);
      session = data;
      return data.session;
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function setBusy(busy) {
  els.start.hidden = busy;
  els.cancel.hidden = !busy;
  els.language.disabled = busy;
  els.file.disabled = busy;
  els.text.readOnly = busy;
  for (const b of [els.copy, els.dlTxt, els.dlSrt, els.dlVtt]) b.disabled = busy;
}

window.addEventListener("beforeunload", (e) => {
  if (controller) e.preventDefault();
});

function providerNote() {
  const used = new Set(results.filter(Boolean).map((r) => r.provider));
  if (used.has("huggingface")) return "部分内容由备用线路完成。";
  return "";
}

// ---------- 结果与导出 ----------

// 把每段的相对时间换算成整段音频的绝对时间
function allSegments() {
  const segments = [];
  results.forEach((r, i) => {
    if (!r) return;
    const offset = audio.chunks[i].start / SAMPLE_RATE;
    const length = (audio.chunks[i].end - audio.chunks[i].start) / SAMPLE_RATE;
    const parts = r.segments?.length ? r.segments : r.text ? [{ start: 0, end: length, text: r.text }] : [];
    for (const s of parts) {
      if (!s.text) continue;
      const startTime = Math.min(Math.max(s.start ?? 0, 0), length);
      const endTime = Math.min(s.end ?? length, length);
      segments.push({ start: offset + startTime, end: offset + Math.max(endTime, startTime + 0.3), text: s.text });
    }
  });
  return segments;
}

function buildText() {
  const paragraphs = [];
  results.forEach((r) => {
    if (!r) return;
    const parts = r.segments?.length ? r.segments.map((s) => s.text) : [r.text];
    let paragraph = "";
    for (const part of parts) {
      if (!part) continue;
      paragraph += paragraph && !isCjk(paragraph.at(-1)) && !isCjk(part[0]) ? ` ${part}` : part;
    }
    if (paragraph) paragraphs.push(paragraph);
  });
  return paragraphs.join("\n\n");
}

function isCjk(ch) {
  return /[　-ヿ㐀-鿿가-힯＀-￯]/.test(ch);
}

function toSrt(segments) {
  return segments
    .map((s, i) => `${i + 1}\n${timestamp(s.start, ",")} --> ${timestamp(s.end, ",")}\n${s.text}\n`)
    .join("\n");
}

function toVtt(segments) {
  return "WEBVTT\n\n" + segments
    .map((s) => `${timestamp(s.start, ".")} --> ${timestamp(s.end, ".")}\n${s.text}\n`)
    .join("\n");
}

function timestamp(seconds, sep) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

function download(content, ext, mime) {
  const base = (audio?.name || "transcript").replace(/\.[^.]+$/, "");
  const blob = new Blob(["﻿", content], { type: `${mime};charset=utf-8` });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${base}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

els.dlTxt.addEventListener("click", () => download(els.text.value, "txt", "text/plain"));
els.dlSrt.addEventListener("click", () => download(toSrt(allSegments()), "srt", "application/x-subrip"));
els.dlVtt.addEventListener("click", () => download(toVtt(allSegments()), "vtt", "text/vtt"));
els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.text.value);
    els.copy.textContent = "已复制";
  } catch {
    els.text.select();
    els.copy.textContent = "请按 Ctrl+C";
  }
  setTimeout(() => (els.copy.textContent = "复制"), 1500);
});

// ---------- 波形 ----------

function draw() {
  const canvas = els.wave;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  if (!audio) return;

  const bar = 3;
  const gap = 2;
  const padding = 16;
  const count = Math.max(1, Math.floor((width - padding * 2 + gap) / (bar + gap)));
  const peaks = getPeaks(count);
  const style = getComputedStyle(document.documentElement);
  const colors = {
    pending: style.getPropertyValue("--wave-idle"),
    active: style.getPropertyValue("--wave-active"),
    done: style.getPropertyValue("--accent"),
  };
  const mid = height / 2;
  const maxHeight = height - padding * 2;

  let chunk = 0;
  for (let i = 0; i < count; i++) {
    const sample = Math.floor(((i + 0.5) / count) * audio.pcm.length);
    while (chunk < audio.chunks.length - 1 && sample >= audio.chunks[chunk].end) chunk++;
    ctx.fillStyle = colors[chunkState[chunk] || "pending"];
    const h = Math.max(2, peaks[i] * maxHeight);
    ctx.beginPath();
    ctx.roundRect(padding + i * (bar + gap), mid - h / 2, bar, h, 1.5);
    ctx.fill();
  }
}

function getPeaks(count) {
  if (peaksCache?.count === count) return peaksCache.peaks;
  const { pcm } = audio;
  const size = pcm.length / count;
  const step = Math.max(1, Math.floor(size / 200));
  const peaks = new Float32Array(count);
  let max = 0;
  for (let i = 0; i < count; i++) {
    let peak = 0;
    for (let j = Math.floor(i * size); j < Math.floor((i + 1) * size); j += step) {
      const v = Math.abs(pcm[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) for (let i = 0; i < count; i++) peaks[i] = Math.sqrt(peaks[i] / max);
  peaksCache = { count, peaks };
  return peaks;
}

new ResizeObserver(() => draw()).observe(els.wave);

// ---------- 工具 ----------

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

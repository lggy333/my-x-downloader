const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局功能配置（稳定版参数）
// ======================
const CONFIG = {
  BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,
  MIN_DISPLAY_HEIGHT: 240,
  HEAD_TIMEOUT: 2500,
  DOWNLOAD_TIMEOUT: 20000,
  TWEET_CACHE_MS: 10 * 60 * 1000,
  SIZE_CACHE_MS: 30 * 60 * 1000,
  MAX_CACHE: 500,
  HEAD_CONCURRENCY: 4,
  TG_API_TIMEOUT: 5000
};

// ======================
// 基础工具函数
// ======================
function escapeHTML (str) {
  if (!str) return '';
  return str.replace (/&/g, '&').replace (/</g, '<').replace (/>/g, '>');
}

async function quickFetch(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function tg(method, data, parse = true) {
  const start = performance.now();
  const res = await quickFetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(data)
    },
    CONFIG.TG_API_TIMEOUT
  );
  console.log(`⏱️ [TG API] ${method} 耗时: ${(performance.now() - start).toFixed(2)}ms`);
  if (!parse) return res.ok;
  return await res.json();
}

async function limitConcurrency(tasks, limit = CONFIG.HEAD_CONCURRENCY) {
  const start = performance.now();
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = await tasks[i]();
      } catch {
        results[i] = 0;
      }
    }
  }
  const workers = Array(Math.min(limit, tasks.length)).fill().map(worker);
  await Promise.all(workers);
  console.log(`⏱️ [并发任务] 执行 ${tasks.length} 项任务耗时: ${(performance.now() - start).toFixed(2)}ms`);
  return results;
}

// ======================
// 画质列表处理工具
// ======================
function uniqueQualityVariants (list) {
  const map = new Map ();
  for (const v of list) {
    const quality = Math.max (v.width, v.height);
    const old = map.get (quality);
    if (!old || v.bitrate > old.bitrate) {
      map.set (quality, v);
    }
  }
  return [...map.values ()].sort (compareVariant);
}

function prepareDisplayVariants(variants) {
  let bestUnderLimitFound = false;
  return variants.filter(v => {
    if (v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) {
      if (bestUnderLimitFound) return false;
      bestUnderLimitFound = true;
      return true;
    }
    return true;
  });
}

// ======================
// 消息文案生成
// ======================
function buildCaption (tweet, options = {}) {
  const { variant = null, isManual = false, isOverSize = false, autoSelected = false } = options;
  const authorLink = `https://x.com/${tweet.author.screen_name}`;
  const originalTweetLink = `https://x.com/i/status/${tweet.id}`;
  const lines = [];

  if (variant) {
    const sizeMB = variant.size > 0 ? `${(variant.size / (1024 * 1024)).toFixed(1)} MB` : ' 未知大小 ';
    lines.push (`🎞 ${variant.label} · ${sizeMB}`);
  }

  lines.push(`👤 <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a> (@${tweet.author.screen_name})`);
  lines.push(`🔗 <a href="${originalTweetLink}">查看原推文</a>`);

  if (isOverSize && variant) {
    const sizeMB = variant.size > 0 ? `${(variant.size / (1024 * 1024)).toFixed(1)} MB` : ' 未知 ';
    if (variant.url.length > 300) {
      lines.push (`⚠️ 该画质过大 (${sizeMB}MB) 无法直接发送\n🚀 高清原片链接过长，请通过画质按钮选择下载`);
    } else {
      lines.push(`⚠️ 该画质过大 (${sizeMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载高清原片</a>`);
    }
  }

  lines.push('──────────');
  lines.push(escapeHTML(tweet.text));

  if (variant) {
    if (isManual) lines.push(`\n⚙️ <i>手动指定投递画质: ${variant.label}</i>`);
    else if (autoSelected) lines.push(`\n💡 <i>画质已智能适配调整至: ${variant.label}</i>`);
  }

  return lines.join('\n');
}

// ======================
// LRU 缓存机制
// ======================
function cacheSet (cache, key, value) {
  if (cache.size >= CONFIG.MAX_CACHE) {
    const first = cache.keys ().next ().value;
    cache.delete (first);
  }
  cache.set (key, value);
}

// ======================
// 推文数据缓存
// ======================
const tweetCache = new Map ();
const tweetPending = new Map ();

async function getTweet(tweetId) {
  const start = performance.now();
  const cached = tweetCache.get(tweetId);
  if (cached && Date.now() - cached.time < CONFIG.TWEET_CACHE_MS) {
    console.log(`⏱️ [getTweet] 命中缓存 耗时: ${(performance.now() - start).toFixed(2)}ms`);
    return cached;
  }

  if (tweetPending.has(tweetId)) {
    console.log(`⏱️ [getTweet] 命中 Pending 请求`);
    return tweetPending.get(tweetId);
  }

  const requestPromise = (async () => {
    try {
      const fetchStart = performance.now();
      const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, CONFIG.TG_API_TIMEOUT);
      console.log(`⏱️ [getTweet] 请求 FXTwitter API 耗时: ${(performance.now() - fetchStart).toFixed(2)}ms`);

      if (!fxRes.ok) throw new Error ("解析失败");
      const json = await fxRes.json ();
      const rawVariants = collectVideoVariants(json.tweet.media);
      const baseVariants = dedupeVariants(rawVariants);
      baseVariants.sort(compareVariant);

      const cacheData = {
        time: Date.now(),
        tweet: json.tweet,
        baseVariants
      };

      cacheSet(tweetCache, tweetId, cacheData);
      console.log(`⏱️ [getTweet] 完整获取与解析推文 耗时: ${(performance.now() - start).toFixed(2)}ms`);
      return cacheData;
    } finally {
      tweetPending.delete(tweetId);
    }
  })();

  tweetPending.set(tweetId, requestPromise);
  return requestPromise;
}

// ======================
// 文件大小缓存（核心修复区）
// ======================
const sizeCache = new Map ();
const sizePending = new Map ();

async function getFileSizeInternal(url) {
  const start = performance.now();
  const cached = sizeCache.get(url);
  if (cached && Date.now() - cached.time < CONFIG.SIZE_CACHE_MS) {
    console.log(`⏱️ [getFileSize] 命中缓存 耗时: ${(performance.now() - start).toFixed(2)}ms`);
    return cached.size;
  }

  if (sizePending.has(url)) {
    return sizePending.get(url);
  }

  const requestPromise = (async () => {
    try {
      const fetchStart = performance.now();
      const rRes = await quickFetch (url, {
        method: "GET",
        headers: {
          "Range": "bytes=0-1",
          "Accept-Encoding": "identity"
        }
      }, CONFIG.HEAD_TIMEOUT);

      rRes.body?.cancel?.();
      console.log(`⏱️ [getFileSize] 网络请求 Range 耗时: ${(performance.now() - fetchStart).toFixed(2)}ms`);

      const contentRange = rRes.headers.get ("content-range");
      if (contentRange) {
        const match = contentRange.match (/\/(\d+)$/);
        if (match) {
          const size = parseInt (match [1], 10);
          cacheSet (sizeCache, url, { time: Date.now (), size });
          return size;
        }
      }

      const contentLength = rRes.headers.get ("content-length");
      if (contentLength) {
        const size = parseInt (contentLength, 10);
        cacheSet (sizeCache, url, { time: Date.now (), size });
        return size;
      }

      return 0;
    } catch {
      return 0;
    } finally {
      sizePending.delete(url);
      console.log(`⏱️ [getFileSize] 单个文件获取大小 耗时: ${(performance.now() - start).toFixed(2)}ms`);
    }
  })();

  sizePending.set(url, requestPromise);
  return requestPromise;
}

async function getFileSize(url) {
  return await getFileSizeInternal(url);
}

async function fillVariantsSize(variants) {
  const start = performance.now();
  const tasks = variants.map(v => () => getFileSize(v.url));
  const sizes = await limitConcurrency(tasks, CONFIG.HEAD_CONCURRENCY);
  variants.forEach((v, idx) => v.size = sizes[idx]);
  console.log(`⏱️ [fillVariantsSize] 批量填充 ${variants.length} 个视频大小 耗时: ${(performance.now() - start).toFixed(2)}ms`);
  return variants;
}

// ======================
// 视频画质处理工具
// ======================
function normalizeVideoUrl (url) {
  return url.trim ();
}

function dedupeVariants(list) {
  const map = new Map();
  for (const v of list) {
    const key = `${v.width}x${v.height}_${v.bitrate}`;
    if (!map.has(key)) {
      map.set(key, v);
      continue;
    }
    if (v.bitrate > map.get(key).bitrate) {
      map.set(key, v);
    }
  }
  return [...map.values()];
}

function compareVariant(a, b) {
  if (a.height !== b.height) return b.height - a.height;
  if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
  return 0;
}

function parseVideoVariant(v, idx = 0) {
  let width = 0;
  let height = 0;

  if (v.width && v.height) {
    width = v.width;
    height = v.height;
  } else {
    const match = v.url.match(/(\d+)x(\d+)/);
    if (match) {
      width = Number(match[1]);
      height = Number(match[2]);
    }
  }

  const label = width && height ? `${width}×${height}` : `未知画质 ${idx + 1}`;
  const type = v.content_type || v.container || "video/mp4";
  const isHLS = type.includes("mpegURL") || type.includes("m3u8");

  return {
    url: normalizeVideoUrl(v.url),
    width,
    height,
    bitrate: v.bitrate || 0,
    label,
    size: 0,
    isHLS,
    source: isHLS ? "m3u8" : "mp4"
  };
}

function walkMedia(obj, collector, visited) {
  if (!obj) return;
  if (typeof obj === 'object') {
    if (visited.has(obj)) return;
    visited.add(obj);
  }

  if (Array.isArray(obj)) {
    obj.forEach(item => walkMedia(item, collector, visited));
    return;
  }

  if (typeof obj !== "object") return;

  if (Array.isArray(obj.variants)) collector.push(...obj.variants);
  if (Array.isArray(obj.formats)) collector.push(...obj.formats);
  if (Array.isArray(obj.videos)) collector.push(...obj.videos);
  if (Array.isArray(obj.all_videos)) collector.push(...obj.all_videos);

  for (const value of Object.values(obj)) {
    walkMedia(value, collector, visited);
  }
}

function collectVideoVariants(media = {}) {
  const rawItems = [];
  const visited = new WeakSet();
  walkMedia(media, rawItems, visited);

  const parsedList = [];
  rawItems.forEach(item => {
    if (!item || !item.url) return;
    if (item.content_type && !item.content_type.includes("video") && !item.content_type.includes("mpegURL")) return;
    if (item.container && item.container !== "mp4" && item.container !== "m3u8") return;

    const parsed = parseVideoVariant(item);
    parsed.bitrate = item.bitrate || parsed.bitrate || 0;
    parsedList.push(parsed);
  });

  const deduped = dedupeVariants(parsedList);

  return deduped.filter(v => {
    if (v.isHLS) return false;
    if (v.width <= 0 || v.height <= 0) return false;
    if (v.width > 7680 || v.height > 7680) return false;
    if (v.height < CONFIG.MIN_DISPLAY_HEIGHT) return false;
    return true;
  });
}

// ======================
// 核心选图与发送逻辑
// ======================
async function findBestUnderLimit (variants) {
  const start = performance.now();
  for (const v of variants) {
    if (v.size === 0) {
      v.size = await getFileSize (v.url);
    }
    if (v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) {
      console.log(`⏱️ [findBestUnderLimit] 选出最优画质耗时: ${(performance.now() - start).toFixed(2)}ms`);
      return v;
    }
  }
  console.log(`⏱️ [findBestUnderLimit] 匹配无合适画质耗时: ${(performance.now() - start).toFixed(2)}ms`);
  return null;
}

async function sendSpecificVideo (chatId, tweet, variant, options = {}) {
  const start = performance.now();
  const { isManual = false, isOverSize = false } = options;
  const tweetId = tweet.id;

  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
  };

  const caption = buildCaption(tweet, { variant, isManual, isOverSize });

  if (variant.size > 0 && variant.size <= CONFIG.BOT_UPLOAD_LIMIT) {
    let urlSent = false;
    const payload = {
      chat_id: chatId,
      video: variant.url,
      caption,
      parse_mode: 'HTML',
      show_caption_above_media: true,
      reply_markup: replyMarkup,
      supports_streaming: true,
      width: variant.width,
      height: variant.height,
      disable_content_type_detection: true
    };

    for (let attempt = 0; attempt < 2 && !urlSent; attempt++) {
      try {
        const sendStart = performance.now();
        const json = await tg ('sendVideo', payload);
        console.log(`⏱️ [sendSpecificVideo] Direct URL 发送第 ${attempt + 1} 次尝试耗时: ${(performance.now() - sendStart).toFixed(2)}ms`);
        if (json.ok) urlSent = true;
        else throw new Error (json.description || "Direct URL send failed");
      } catch (e) {
        if (attempt === 0) await new Promise (r => setTimeout (r, 200));
        else console.log ("URL 发送失败，降级为上传:", e.message);
      }
    }

    if (!urlSent) {
      const dlStart = performance.now();
      const videoRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
      const arrayBuffer = await videoRes.arrayBuffer();
      console.log(`⏱️ [sendSpecificVideo] 降级本地下载视频耗时: ${(performance.now() - dlStart).toFixed(2)}ms`);

      const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
      const formData = new FormData();
      formData.append('chat_id', String(chatId));
      formData.append('caption', caption);
      formData.append('parse_mode', 'HTML');
      formData.append('show_caption_above_media', 'true');
      formData.append('reply_markup', JSON.stringify(replyMarkup));
      formData.append('supports_streaming', 'true');
      formData.append('width', String(variant.width));
      formData.append('height', String(variant.height));
      formData.append('disable_content_type_detection', 'true');
      formData.append('video', videoBlob, 'video.mp4');

      const ulStart = performance.now();
      await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
      console.log(`⏱️ [sendSpecificVideo] 降级文件上传至 TG 耗时: ${(performance.now() - ulStart).toFixed(2)}ms`);
    }
  } else {
    await tg('sendMessage', {
      chat_id: chatId,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
  }
  console.log(`⏱️ [sendSpecificVideo] 整体完成耗时: ${(performance.now() - start).toFixed(2)}ms`);
}

// ======================
// Serverless 主入口
// ======================
export default async function handler (req, res) {
  const reqStart = performance.now();
  console.log("🚀 [Handler] 收到请求，计时开始");

  if (req.method !== 'POST') return res.status (405).send ('Method Not Allowed');

  //---------- 1. 回调按钮事件 ----------
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const chatId = callback.message.chat.id;
    const callbackData = callback.data;

    tg('answerCallbackQuery', { callback_query_id: callback.id }, false).catch(() => {});

    // 1.1 查看所有画质列表
    if (callbackData.startsWith ('list_q:')) {
      const tweetId = callbackData.split (':')[1];
      const progressData = await tg ('sendMessage', { chat_id: chatId, text: "🔍 正在加载画质列表..." });
      const progressMsgId = progressData.result?.message_id;

      if (!progressMsgId) {
        console.log(`⏱️ [Handler] Callback list_q 结束，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
        return res.status(200).send('OK');
      }

      try {
        const cacheData = await getTweet (tweetId);
        const { tweet, baseVariants } = cacheData;

        if (!tweet || baseVariants.length === 0) {
          await tg ('editMessageText', {
            chat_id: chatId,
            message_id: progressMsgId,
            text: "❌ 未能获取到有效的视频流资料。"
          });
          console.log(`⏱️ [Handler] Callback list_q 无视频流结束，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
          return res.status (200).send ('OK');
        }

        const displayVariants = uniqueQualityVariants(baseVariants).slice(0, 6);
        await fillVariantsSize(displayVariants);
        const finalVariants = prepareDisplayVariants(displayVariants);

        const keyboard = finalVariants.map((v) => {
          const sizeText = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : ' 未知大小 ';
          const originalIndex = baseVariants.indexOf (v);
          return [{
            text: `${v.label} · ${sizeText}`,
            callback_data: `send_q:${tweetId}:${originalIndex}`
          }];
        });

        await tg('editMessageText', {
          chat_id: chatId,
          message_id: progressMsgId,
          text: `📊 <b>推文 [${tweetId}] 画质清单</b>`,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (err) {
        console.error('[list_q] 加载异常:', err.message);
        try {
          await tg('editMessageText', {
            chat_id: chatId,
            message_id: progressMsgId,
            text: `❌ 加载发生异常: ${err.message}`
          });
        } catch {}
      }

      console.log(`⏱️ [Handler] Callback list_q 处理完毕，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
      return res.status(200).send('OK');
    }

    // 1.2 发送指定画质
    if (callbackData.startsWith ('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split (':');
      const variantIndex = parseInt (indexStr, 10);

      try {
        const cacheData = await getTweet(tweetId);
        const { tweet, baseVariants } = cacheData;
        if (!tweet || !baseVariants[variantIndex]) {
          console.log(`⏱️ [Handler] Callback send_q 无效画质索引，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
          return res.status(200).send('OK');
        }

        const chosenVariant = baseVariants[variantIndex];
        if (chosenVariant.size === 0) {
          chosenVariant.size = await getFileSize(chosenVariant.url);
        }

        const isOverSize = chosenVariant.size > CONFIG.BOT_UPLOAD_LIMIT;
        await sendSpecificVideo (chatId, tweet, chosenVariant, { isManual: true, isOverSize});
      } catch (e) {
        console.error ('[send_q] 手动投递失败 ', e.message);
      }

      console.log(`⏱️ [Handler] Callback send_q 处理完毕，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
      return res.status (200).send ('OK');
    }

    console.log(`⏱️ [Handler] Callback 未匹配事件，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
    return res.status (200).send ('OK');
  }

  //---------- 2. 普通消息处理 ----------
  const msg = req.body.message || req.body.channel_post;
  if (!msg || !msg.text) {
    console.log(`⏱️ [Handler] 非文本消息，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
    return res.status (200).send ('OK');
  }

  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  tg('deleteMessage', { chat_id: chatId, message_id: messageId }, false).catch(() => {});

  if (text === '/start') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `<b>🤖 X/Twitter 视频解析机器人</b>
📌 使用方式：直接发送 X / Twitter 推文链接，机器人会自动解析并发送视频 / 图片。
✨ 功能特性：
・自动选择 ≤50MB 的最高画质发送
・支持手动切换不同清晰度
・自动识别图片与纯文本推文
・超 50MB 视频提供下载链接 `,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log(`⏱️ [Handler] /start 响应完毕，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
    return res.status (200).send ('OK');
  }

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) {
    console.log(`⏱️ [Handler] 未匹配推文链接，总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
    return res.status(200).send('OK');
  }

  const tweetId = match[1];

  try {
    const cacheData = await getTweet(tweetId);
    const { tweet, baseVariants } = cacheData;
    const photos = tweet.media?.photos || [];

    if (baseVariants.length > 0) {
      const best = await findBestUnderLimit(baseVariants);
      cacheData.time = Date.now();

      if (best) {
        await sendSpecificVideo (chatId, tweet, best, { autoSelected: true });
      } else {
        const topVariant = baseVariants [0];
        if (topVariant.size === 0) {
          topVariant.size = await getFileSize (topVariant.url);
        }
        await sendSpecificVideo (chatId, tweet, topVariant, { isOverSize: true });
      }
    } else if (photos.length > 0) {
      const replyMarkup = { inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]] };
      const caption = buildCaption(tweet);

      if (photos.length === 1) {
        await tg('sendPhoto', {
          chat_id: chatId,
          photo: photos[0].url,
          caption,
          parse_mode: 'HTML',
          show_caption_above_media: true,
          reply_markup: replyMarkup
        });
      } else {
        const mediaGroup = photos.map((p, idx) => ({
          type: 'photo',
          media: p.url,
          caption: idx === 0 ? caption : '',
          parse_mode: idx === 0 ? 'HTML' : undefined,
          show_caption_above_media: idx === 0 ? true : undefined
        }));
        await tg('sendMediaGroup', { chat_id: chatId, media: mediaGroup });
      }
    } else {
      await tg('sendMessage', {
        chat_id: chatId,
        text: buildCaption(tweet),
        parse_mode: 'HTML'
      });
    }
  } catch (error) {
    console.error ('[总线报错]:', error.message);
  }

  console.log(`⏱️ [Handler] 消息处理全部完成，请求响应总耗时: ${(performance.now() - reqStart).toFixed(2)}ms`);
  return res.status(200).send('OK');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局配置（已优化参数）
// ======================
const CONFIG = {
  BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,
  MIN_DISPLAY_HEIGHT: 480,
  AUTO_MIN_HEIGHT: 720,
  HEAD_TIMEOUT: 800,          // 优化1：从1800ms降至800ms，超时快速切Range兜底
  DOWNLOAD_TIMEOUT: 20000,
  TWEET_CACHE_MS: 5 * 60 * 1000,
  SIZE_CACHE_MS: 10 * 60 * 1000,
  MAX_CACHE: 300,
  HEAD_CONCURRENCY: 6,       // 优化2：从3提升至6，批量探测速度翻倍
  URL_SEND_RETRY_DELAY: 200
};

// ======================
// 基础工具函数
// ======================
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// 并发控制器
async function limitConcurrency(tasks, limit = CONFIG.HEAD_CONCURRENCY) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array(Math.min(limit, tasks.length)).fill().map(worker);
  await Promise.all(workers);
  return results;
}

// 统一Caption生成
function buildCaption(tweet, options = {}) {
  const { variant = null, isManual = false, isOverSize = false, autoSelected = false } = options;
  const authorLink = `https://x.com/${tweet.author.screen_name}`;
  const originalTweetLink = `https://x.com/i/status/${tweet.id}`;
  const lines = [];

  if (variant) {
    const sizeMB = variant.size > 0 ? `${(variant.size / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
    lines.push(`🎞 ${variant.label} · ${sizeMB}`);
  }
  lines.push(`👤 <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a> (@${tweet.author.screen_name})`);
  lines.push(`🔗 <a href="${originalTweetLink}">查看原推文</a>`);

  if (isOverSize && variant) {
    const sizeMB = variant.size > 0 ? `${(variant.size / (1024 * 1024)).toFixed(1)} MB` : '未知';
    lines.push(`⚠️ 该画质过大 (${sizeMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载高清原片</a>`);
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
function cacheSet(cache, key, value) {
  if (cache.size >= CONFIG.MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, value);
}

// ======================
// Tweet 缓存（Promise级去重）
// ======================
const tweetCache = new Map();
const tweetPending = new Map();

async function getTweet(tweetId) {
  const cached = tweetCache.get(tweetId);
  if (cached && Date.now() - cached.time < CONFIG.TWEET_CACHE_MS) {
    return cached;
  }
  if (tweetPending.has(tweetId)) {
    return tweetPending.get(tweetId);
  }

  const requestPromise = (async () => {
    try {
      const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
      if (!fxRes.ok) throw new Error("解析失败");
      const json = await fxRes.json();
      const rawVariants = collectVideoVariants(json.tweet.media);
      const baseVariants = dedupeVariants(rawVariants);
      baseVariants.sort(compareVariant);
      const cacheData = { time: Date.now(), tweet: json.tweet, baseVariants };
      cacheSet(tweetCache, tweetId, cacheData);
      return cacheData;
    } finally {
      tweetPending.delete(tweetId);
    }
  })();

  tweetPending.set(tweetId, requestPromise);
  return requestPromise;
}

// ======================
// 文件大小缓存（Promise级去重 + Range请求兜底）
// ======================
const sizeCache = new Map();
const sizePending = new Map();

async function getFileSizeInternal(url) {
  const cached = sizeCache.get(url);
  if (cached && Date.now() - cached.time < CONFIG.SIZE_CACHE_MS) {
    return cached.size;
  }
  if (sizePending.has(url)) {
    return sizePending.get(url);
  }

  const requestPromise = (async () => {
    try {
      // 第一优先级：HEAD请求
      const hRes = await quickFetch(url, { method: "HEAD" }, CONFIG.HEAD_TIMEOUT);
      const contentLength = hRes.headers.get("content-length");
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        cacheSet(sizeCache, url, { time: Date.now(), size });
        return size;
      }
      throw new Error("No Content-Length");
    } catch {
      // 第二优先级：GET + Range请求，从Content-Range获取总大小
      try {
        const rRes = await quickFetch(url, {
          method: "GET",
          headers: { "Range": "bytes=0-0" },
          cache: "no-store" // 优化3：禁用缓存，避免CDN缓存拖慢响应
        }, CONFIG.HEAD_TIMEOUT);
        const contentRange = rRes.headers.get("content-range");
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) {
            const size = parseInt(match[1], 10);
            cacheSet(sizeCache, url, { time: Date.now(), size });
            return size;
          }
        }
        return 0;
      } catch {
        return 0;
      }
    } finally {
      sizePending.delete(url);
    }
  })();

  sizePending.set(url, requestPromise);
  return requestPromise;
}

async function getFileSize(url) {
  return await getFileSizeInternal(url);
}

// 批量回填size（仅后台预探测使用）
async function fillVariantsSize(variants) {
  const tasks = variants.map(v => () => getFileSize(v.url));
  const sizes = await limitConcurrency(tasks, CONFIG.HEAD_CONCURRENCY);
  variants.forEach((v, idx) => v.size = sizes[idx]);
  return variants;
}

// ======================
// URL 规范化
// ======================
function normalizeVideoUrl(url) {
  return url.trim();
}

// ======================
// 去重：宽高+码率联合去重
// ======================
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

// ======================
// 排序规则：分辨率(高度优先) → 码率降序
// ======================
function compareVariant(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
  return 0;
}

// ======================
// 解析单条视频画质
// ======================
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
  const score = height;
  const label = width && height ? `${width}×${height}` : `未知画质 ${idx + 1}`;
  const type = v.content_type || v.container || "video/mp4";
  const isHLS = type.includes("mpegURL") || type.includes("m3u8");
  return {
    url: normalizeVideoUrl(v.url),
    width, height, score,
    bitrate: v.bitrate || 0,
    label, size: 0, isHLS,
    source: isHLS ? "m3u8" : "mp4"
  };
}

// ======================
// 递归收集视频条目（WeakSet防重复+防循环引用）
// ======================
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

// ======================
// 收集并过滤有效视频画质
// ======================
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
    if (!v.url.endsWith('.mp4') && !v.url.includes('.mp4?')) return false;
    if (v.width <= 0 || v.height <= 0) return false;
    if (v.width > 7680 || v.height > 7680) return false;
    if (v.score < CONFIG.MIN_DISPLAY_HEIGHT) return false;
    return true;
  });
}

// ======================
// 按钮列表精简：>50MB全保留，≤50MB只留最高一档
// ======================
function trimVariantsForButton(list) {
  let foundUnderLimit = false;
  return list.filter(v => {
    if (v.size > CONFIG.BOT_UPLOAD_LIMIT) return true;
    if (!foundUnderLimit) {
      foundUnderLimit = true;
      return true;
    }
    return false;
  });
}

// ======================
// 核心发送函数（流式上传优化）
// ======================
async function sendSpecificVideo(chatId, tweet, variant, options = {}) {
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

    // URL直发 + 一次重试
    for (let attempt = 0; attempt < 2 && !urlSent; attempt++) {
      try {
        const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.ok) urlSent = true;
        else throw new Error(json.description || "Direct URL send failed");
      } catch (e) {
        if (attempt === 0) await new Promise(r => setTimeout(r, CONFIG.URL_SEND_RETRY_DELAY));
        else console.log("URL 发送失败，降级为流式上传:", e.message);
      }
    }

    // 兜底：流式上传，减少内存拷贝
    if (!urlSent) {
      const videoRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
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
      formData.append('video', videoRes.body, 'video.mp4');
      await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
    }
  } else {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      })
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 回调按钮事件 =================
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    if (ALLOWED_USER_ID && String(callback.from?.id) !== String(ALLOWED_USER_ID)) {
      return res.status(200).send('OK');
    }
    const chatId = callback.message.chat.id;
    const callbackData = callback.data;

    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ callback_query_id: callback.id })
    }).catch(() => {});

    // ========== 画质列表：核心修复，边探测边更新 ==========
    if (callbackData.startsWith('list_q:')) {
      const tweetId = callbackData.split(':')[1];
      const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          chat_id: chatId,
          text: "🔍 正在探测画质与体积，结果将逐档刷新..."
        })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const cacheData = await getTweet(tweetId);
        const { tweet, baseVariants } = cacheData;

        if (!tweet || baseVariants.length === 0) {
          if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
              chat_id: chatId,
              message_id: progressMsgId,
              text: "❌ 未能获取到有效的视频流资料。"
            })
          });
          return res.status(200).send('OK');
        }

        const buttonVariants = [];
        let foundUnderLimit = false;

        // 实时渲染按钮的工具函数
        const renderKeyboard = async () => {
          const keyboard = buttonVariants.map(v => {
            const sizeMB = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : '探测中...';
            const encodedUrl = encodeURIComponent(v.url);
            return [{ text: `${v.label} · ${sizeMB}`, callback_data: `send_q:${tweetId}:${encodedUrl}` }];
          });

          await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
              chat_id: chatId,
              message_id: progressMsgId,
              text: `📊 <b>推文 [${tweetId}] 画质清单</b>`,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: keyboard }
            })
          }).catch(() => {});
        };

        // 优化4：从高到低逐档探测，找到第一档≤50MB即停止，减少无效请求
        for (const variant of baseVariants) {
          if (foundUnderLimit) break;

          if (variant.size === 0) {
            variant.size = await getFileSize(variant.url);
            cacheData.time = Date.now();
          }

          buttonVariants.push(variant);
          await renderKeyboard(); // 每探测完一档就更新一次界面

          // 命中可发送的最高画质，后续低画质无需探测
          if (variant.size <= CONFIG.BOT_UPLOAD_LIMIT && variant.size > 0) {
            foundUnderLimit = true;
          }
        }

        // 优化5：后台异步继续探测剩余档位，不阻塞用户，缓存后下次秒开
        (async () => {
          try {
            const remaining = baseVariants.filter(v => v.size === 0);
            if (remaining.length > 0) {
              await fillVariantsSize(remaining);
              cacheData.time = Date.now();
            }
          } catch {}
        })();

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: progressMsgId,
            text: `❌ 探测发生异常: ${err.message}`
          })
        });
      }
    }

    // 指定画质发送
    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, encodedUrl] = callbackData.split(':');
      const targetUrl = decodeURIComponent(encodedUrl);
      try {
        const cacheData = await getTweet(tweetId);
        const { tweet, baseVariants } = cacheData;
        if (!tweet) return res.status(200).send('OK');

        const chosenVariant = baseVariants.find(v => v.url === targetUrl);
        if (!chosenVariant) return res.status(200).send('OK');

        if (chosenVariant.size === 0) {
          chosenVariant.size = await getFileSize(chosenVariant.url);
          cacheData.time = Date.now();
        }

        const isOverSize = chosenVariant.size > CONFIG.BOT_UPLOAD_LIMIT;
        await sendSpecificVideo(chatId, tweet, chosenVariant, { isManual: true, isOverSize });
      } catch (e) {
        console.error('手动投递失败', e.message);
      }
    }

    return res.status(200).send('OK');
  }

  // ================= 用户消息处理（自动发送 + 后台预探测）
  const msg = req.body.message;
  if (!msg || !msg.text) return res.status(200).send('OK');
  if (ALLOWED_USER_ID && String(msg.from?.id) !== String(ALLOWED_USER_ID)) {
    return res.status(200).send('OK');
  }

  const text = msg.text;
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  try {
    await fetch(`${TELEGRAM_API}/deleteMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
  } catch (e) {
    console.error('删除消息权限不足:', e.message);
  }

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK');
  const tweetId = match[1];

  try {
    const cacheData = await getTweet(tweetId);
    const { tweet, baseVariants } = cacheData;
    const photos = tweet.media?.photos || [];

    if (baseVariants.length > 0) {
      // 逐个探测，找到第一个符合条件的立即停止
      let best = null;
      for (const variant of baseVariants) {
        variant.size = await getFileSize(variant.url);
        if (
          variant.size > 0 &&
          variant.size <= CONFIG.BOT_UPLOAD_LIMIT &&
          variant.score >= CONFIG.AUTO_MIN_HEIGHT
        ) {
          best = variant;
          break;
        }
      }

      // 后台异步预探测剩余所有档位，不阻塞发送
      (async () => {
        try {
          for (const v of baseVariants) {
            if (v.size === 0) await getFileSize(v.url);
          }
          cacheData.time = Date.now();
        } catch {}
      })();

      cacheData.time = Date.now();

      if (best) {
        await sendSpecificVideo(chatId, tweet, best, { autoSelected: true });
      } else {
        const topVariant = baseVariants[0];
        topVariant.size = topVariant.size || await getFileSize(topVariant.url);
        await sendSpecificVideo(chatId, tweet, topVariant, { isOverSize: true });
      }
    } else if (photos.length > 0) {
      const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
      };
      const caption = buildCaption(tweet);

      if (photos.length === 1) {
        await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            photo: photos[0].url,
            caption,
            parse_mode: 'HTML',
            show_caption_above_media: true,
            reply_markup: replyMarkup
          })
        });
      } else {
        const mediaGroup = photos.map((p, idx) => ({
          type: 'photo',
          media: p.url,
          caption: idx === 0 ? caption : '',
          parse_mode: idx === 0 ? 'HTML' : undefined,
          show_caption_above_media: idx === 0 ? true : undefined
        }));
        await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, media: mediaGroup })
        });
      }
    } else {
      const caption = buildCaption(tweet);
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' })
      });
    }
  } catch (error) {
    console.error('[总线报错]:', error.message);
  }

  return res.status(200).send('OK');
}

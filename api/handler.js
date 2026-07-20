const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "identity"
};

const CONFIG = {
    BOT_UPLOAD_LIMIT: 45 * 1024 * 1024,
    MIN_DISPLAY_HEIGHT: 160,
    HEAD_TIMEOUT: 2000,
    DOWNLOAD_TIMEOUT: 35000,
    TWEET_CACHE_MS: 10 * 60 * 1000,
    SIZE_CACHE_MS: 30 * 60 * 1000,
    MAX_CACHE: 500,
    HEAD_CONCURRENCY: 4,
    TG_API_TIMEOUT: 5000
};

// ======================
// 性能监控与分析 (Profiler)
// ======================
function createTimer(label) {
    const start = Date.now();
    return {
        end(extra = '') {
            const cost = Date.now() - start;
            const extraStr = extra ? ` | ${extra}` : '';
            console.log(`⏱️ [PERF] ${label}: ${cost}ms${extraStr}`);
            return cost;
        }
    };
}

function getMemoryUsageMB() {
    if (typeof process !== 'undefined' && process.memoryUsage) {
        const mem = process.memoryUsage();
        return `RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`;
    }
    return 'N/A';
}

// ======================
// 基础工具函数
// ======================
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function quickFetch(url, options = {}, timeoutMs = CONFIG.TG_API_TIMEOUT) {
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
    const res = await quickFetch(
        `${TELEGRAM_API}/${method}`,
        {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(data)
        },
        CONFIG.TG_API_TIMEOUT
    );
    if (!parse) return res.ok;
    return await res.json();
}

async function tgMultipart(method, fields, fileField, fileBlob, fileName = "video.mp4") {
    const formData = new FormData();
    for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'object') {
            formData.append(k, JSON.stringify(v));
        } else if (v !== undefined && v !== null) {
            formData.append(k, String(v));
        }
    }
    formData.append(fileField, fileBlob, fileName);

    const res = await fetch(`${TELEGRAM_API}/${method}`, {
        method: 'POST',
        body: formData
    });
    return await res.json();
}

async function limitConcurrency(tasks, limit = CONFIG.HEAD_CONCURRENCY) {
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
    return results;
}

// ======================
// 画质去重与展示（严格按分辨率唯一化）
// ======================
function dedupeVariants(list) {
    const map = new Map();
    for (const v of list) {
        const key = `${v.width}x${v.height}`;
        const existing = map.get(key);
        if (!existing || v.bitrate > existing.bitrate) {
            map.set(key, v);
        }
    }
    return [...map.values()];
}

function uniqueQualityVariants(list) {
    return dedupeVariants(list).sort(compareVariant);
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
        if (variant.url.length > 300) {
            lines.push(`⚠️ 该画质过大 (${sizeMB}) 无法直接发送\n🚀 高清原片链接过长，请通过画质按钮选择下载`);
        } else {
            lines.push(`⚠️ 该画质过大 (${sizeMB}) 无法直接发送\n🚀 <a href="${variant.url}">点此下载高清原片</a>`);
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
function cacheSet(cache, key, value) {
    if (cache.size >= CONFIG.MAX_CACHE) {
        const first = cache.keys().next().value;
        cache.delete(first);
    }
    cache.set(key, value);
}

// ======================
// 推文数据获取与缓存
// ======================
const tweetCache = new Map();
const tweetPending = new Map();

async function getTweet(tweetId) {
    const timer = createTimer(`getTweet [${tweetId}]`);

    const cached = tweetCache.get(tweetId);
    if (cached && Date.now() - cached.time < CONFIG.TWEET_CACHE_MS) {
        timer.end('命中本地 LRU 缓存');
        return cached;
    }

    if (tweetPending.has(tweetId)) {
        const res = await tweetPending.get(tweetId);
        timer.end('合并并发请求等待');
        return res;
    }

    const requestPromise = (async () => {
        try {
            const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, CONFIG.TG_API_TIMEOUT);
            if (!fxRes.ok) throw new Error("FxTwitter 请求失败");

            const json = await fxRes.json();
            const rawVariants = collectVideoVariants(json.tweet.media);
            const baseVariants = dedupeVariants(rawVariants);
            baseVariants.sort(compareVariant);

            const cacheData = {
                time: Date.now(),
                tweet: json.tweet,
                baseVariants
            };
            cacheSet(tweetCache, tweetId, cacheData);
            return cacheData;
        } finally {
            tweetPending.delete(tweetId);
        }
    })();

    tweetPending.set(tweetId, requestPromise);
    const result = await requestPromise;
    timer.end(`解析完成, 找到 ${result.baseVariants.length} 个唯一分辨率视频流`);
    return result;
}

// ======================
// 文件大小探测 (Range: bytes=0-1)
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
            const rRes = await quickFetch(url, {
                method: "GET",
                headers: {
                    ...BROWSER_HEADERS,
                    "Range": "bytes=0-1"
                }
            }, CONFIG.HEAD_TIMEOUT);

            rRes.body?.cancel?.();

            const contentRange = rRes.headers.get("content-range");
            if (contentRange) {
                const match = contentRange.match(/\/(\d+)$/);
                if (match) {
                    const size = parseInt(match[1], 10);
                    cacheSet(sizeCache, url, { time: Date.now(), size });
                    return size;
                }
            }

            const contentLength = rRes.headers.get("content-length");
            if (contentLength) {
                const size = parseInt(contentLength, 10);
                cacheSet(sizeCache, url, { time: Date.now(), size });
                return size;
            }

            return 0;
        } catch {
            return 0;
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

async function fillVariantsSize(variants) {
    const timer = createTimer(`fillVariantsSize [${variants.length}个画质探测]`);
    const tasks = variants.map(v => () => getFileSize(v.url));
    const sizes = await limitConcurrency(tasks, CONFIG.HEAD_CONCURRENCY);
    variants.forEach((v, idx) => v.size = sizes[idx]);
    timer.end(variants.map(v => `${v.label}: ${(v.size / 1024 / 1024).toFixed(1)}MB`).join(', '));
    return variants;
}

// ======================
// 视频画质处理工具
// ======================
function normalizeVideoUrl(url) {
    return url.trim();
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

async function findBestUnderLimit(variants) {
    await fillVariantsSize(variants);
    return variants.find(v => v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) || null;
}

// ======================
// 核心发送逻辑 (纯粹的直传优先 + Worker 兜底)
// ======================
async function sendSpecificVideo(chatId, tweet, variant, options = {}) {
    const totalTimer = createTimer(`sendSpecificVideo [${variant.label}]`);
    const { isManual = false, autoSelected = false } = options;
    const tweetId = tweet.id;
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
    };

    // 1. 超大视频退化
    if (variant.size > CONFIG.BOT_UPLOAD_LIMIT) {
        await tg('sendMessage', {
            chat_id: chatId,
            text: buildCaption(tweet, { variant, isManual, autoSelected, isOverSize: true }),
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
        totalTimer.end('视频超限(>45MB)，退化发送文本链接');
        return;
    }

    const caption = buildCaption(tweet, { variant, isManual, autoSelected });

    // 2. 永远优先尝试一次 TG URL 直传
    const tgDirectTimer = createTimer(`TG URL Direct Upload [${variant.label}]`);
    try {
        const json = await tg('sendVideo', {
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
        });

        if (json.ok) {
            tgDirectTimer.end('直传成功 🎉');
            totalTimer.end('总发送完成 (URL 直传通道)');
            return;
        }
        tgDirectTimer.end(`直传被拒: ${json.description}`);
    } catch (e) {
        tgDirectTimer.end(`直传网络异常: ${e.message}`);
    }

    // 3. 直传失败，立刻平滑进入 Worker 中转通道
    console.log(`⚠️ 进入降级中转模式... 当前内存: ${getMemoryUsageMB()}`);
    
    // 3.1 下载阶段
    const downloadTimer = createTimer(`Worker Download Video`);
    let blob;
    try {
        const fileRes = await quickFetch(variant.url, { headers: BROWSER_HEADERS }, CONFIG.DOWNLOAD_TIMEOUT);
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);

        blob = await fileRes.blob();
        downloadTimer.end(`下载完成, 大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
        downloadTimer.end(`下载失败: ${err.message}`);
        await tg('sendMessage', {
            chat_id: chatId,
            text: buildCaption(tweet, { variant, isManual, autoSelected, isOverSize: true }),
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
        totalTimer.end('Worker 中转下载失败，回退文本链接');
        return;
    }

    // 3.2 上传阶段
    const uploadTimer = createTimer(`TG Multipart Upload`);
    try {
        const uploadJson = await tgMultipart('sendVideo', {
            chat_id: chatId,
            caption,
            parse_mode: 'HTML',
            show_caption_above_media: true,
            reply_markup: replyMarkup,
            supports_streaming: true,
            width: variant.width,
            height: variant.height,
            disable_content_type_detection: true
        }, 'video', blob, `${tweetId}.mp4`);

        if (uploadJson.ok) {
            uploadTimer.end('上传成功 🎉');
            totalTimer.end(`总发送完成 (Worker 中转通道) | 峰值内存: ${getMemoryUsageMB()}`);
            return;
        }
        uploadTimer.end(`上传被 TG 拒绝: ${uploadJson.description}`);
    } catch (err) {
        uploadTimer.end(`上传网络异常: ${err.message}`);
    }

    // 4. 最终兜底
    await tg('sendMessage', {
        chat_id: chatId,
        text: buildCaption(tweet, { variant, isManual, autoSelected, isOverSize: true }),
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    });
    totalTimer.end('中转上传失败，最终回退文本链接');
}

// ======================
// Serverless 主入口
// ======================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const reqTimer = createTimer('Full Serverless Request Lifetime');

    if (req.body.callback_query) {
        const callback = req.body.callback_query;
        const chatId = callback.message.chat.id;
        const callbackData = callback.data;

        tg('answerCallbackQuery', { callback_query_id: callback.id }, false).catch(() => {});

        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressData = await tg('sendMessage', { chat_id: chatId, text: "🔍 正在加载画质列表..." });
            const progressMsgId = progressData.result?.message_id;

            if (!progressMsgId) {
                reqTimer.end('Callback list_q: 进度条发送失败');
                return res.status(200).send('OK');
            }

            try {
                const cacheData = await getTweet(tweetId);
                const { tweet, baseVariants } = cacheData;

                if (!tweet || baseVariants.length === 0) {
                    await tg('editMessageText', {
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: "❌ 未能获取到有效的视频流资料。"
                    });
                    reqTimer.end('Callback list_q: 无视频流');
                    return res.status(200).send('OK');
                }

                const displayVariants = uniqueQualityVariants(baseVariants).slice(0, 6);
                await fillVariantsSize(displayVariants);

                const finalVariants = prepareDisplayVariants(displayVariants);
                const keyboard = finalVariants.map((v) => {
                    const sizeText = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
                    const originalIndex = baseVariants.indexOf(v);
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
                console.error(`[list_q] 加载异常:`, err.message);
                try {
                    await tg('editMessageText', {
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: `❌ 加载发生异常: ${err.message}`
                    });
                } catch {}
            }
            reqTimer.end('Callback list_q 处理完成');
            return res.status(200).send('OK');
        }

        if (callbackData.startsWith('send_q:')) {
            const [, tweetId, indexStr] = callbackData.split(':');
            const variantIndex = parseInt(indexStr, 10);

            try {
                const cacheData = await getTweet(tweetId);
                const { tweet, baseVariants } = cacheData;
                if (tweet && baseVariants[variantIndex]) {
                    const chosenVariant = baseVariants[variantIndex];
                    if (chosenVariant.size === 0) {
                        chosenVariant.size = await getFileSize(chosenVariant.url);
                    }
                    await sendSpecificVideo(chatId, tweet, chosenVariant, { isManual: true });
                }
            } catch (e) {
                console.error('[send_q] 手动投递失败', e.message);
            }
            reqTimer.end('Callback send_q 处理完成');
            return res.status(200).send('OK');
        }

        reqTimer.end('Unknown Callback Query');
        return res.status(200).send('OK');
    }

    const msg = req.body.message || req.body.channel_post;
    if (!msg || !msg.text) {
        reqTimer.end('非文本消息，略过');
        return res.status(200).send('OK');
    }

    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    tg('deleteMessage', { chat_id: chatId, message_id: messageId }, false).catch(() => {});

    if (text === '/start') {
        await tg('sendMessage', {
            chat_id: chatId,
            text: `<b>🤖 X/Twitter 视频解析机器人</b>\n📌 使用方式：直接发送 X / Twitter 推文链接，机器人会自动解析并发送视频 / 图片。\n✨ 功能特性：\n• 自动选择 ≤45MB 的最高画质发送\n• 支持手动切换不同清晰度\n• 自动识别图片与纯文本推文\n• 超 45MB 视频提供下载链接`,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        reqTimer.end('/start 指令响应完成');
        return res.status(200).send('OK');
    }

    const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
    const match = text.match(twitterRegex);
    if (!match) {
        reqTimer.end('非 Twitter 链接，忽略');
        return res.status(200).send('OK');
    }

    const tweetId = match[1];

    try {
        const cacheData = await getTweet(tweetId);
        const { tweet, baseVariants } = cacheData;
        const photos = tweet.media?.photos || [];

        if (baseVariants.length > 0) {
            const bestVariant = await findBestUnderLimit(baseVariants);

            if (bestVariant) {
                await sendSpecificVideo(chatId, tweet, bestVariant, { autoSelected: true });
            } else {
                const topVariant = baseVariants[0];
                if (topVariant.size === 0) {
                    topVariant.size = await getFileSize(topVariant.url);
                }
                await sendSpecificVideo(chatId, tweet, topVariant, { isManual: false });
            }
        } 
        else if (photos.length > 0) {
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
        } 
        else {
            await tg('sendMessage', {
                chat_id: chatId,
                text: buildCaption(tweet),
                parse_mode: 'HTML'
            });
        }

    } catch (error) {
        console.error('[总线报错]:', error.message);
    }

    reqTimer.end(`推文 [${tweetId}] 处理总流程结束`);
    return res.status(200).send('OK');
}

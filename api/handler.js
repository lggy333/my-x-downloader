const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局功能配置（精简最优参数）
// ======================
const CONFIG = {
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,
    MIN_DISPLAY_HEIGHT: 240,
    HEAD_TIMEOUT: 1500,
    DOWNLOAD_TIMEOUT: 20000,
    TWEET_CACHE_MS: 15 * 60 * 1000,
    SIZE_CACHE_MS: 60 * 60 * 1000,
    MAX_CACHE: 500,
    HEAD_CONCURRENCY: 3,
    TG_API_TIMEOUT: 5000
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

// Telegram API 统一封装，非关键请求可跳过JSON解析
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
// 缓存机制（精简FIFO，取消无意义LRU操作）
// ======================
function cacheGet(cache, key) {
    return cache.get(key);
}

function cacheSet(cache, key, value) {
    if (cache.size >= CONFIG.MAX_CACHE) {
        const first = cache.keys().next().value;
        cache.delete(first);
    }
    cache.set(key, value);
}

// ======================
// 画质列表处理工具
// ======================
// 按长边分辨率去重，同档位保留最高码率
function uniqueQualityVariants(list) {
    const map = new Map();
    for (const v of list) {
        const quality = Math.max(v.width, v.height);
        const old = map.get(quality);
        if (!old || v.bitrate > old.bitrate) {
            map.set(quality, v);
        }
    }
    return [...map.values()].sort(compareVariant);
}

// 展示过滤：大于50MB全部保留，≤50MB仅保留最高清一个
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
            lines.push(`⚠️ 该画质过大 (${sizeMB}MB) 无法直接发送\n🚀 高清原片链接过长，请通过画质按钮选择下载`);
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
// 推文数据缓存
// ======================
const tweetCache = new Map();
const tweetPending = new Map();

async function getTweet(tweetId) {
    const cached = cacheGet(tweetCache, tweetId);
    if (cached && Date.now() - cached.time < CONFIG.TWEET_CACHE_MS) {
        // 命中缓存刷新生命周期，热门内容不提前过期
        cached.time = Date.now();
        return cached;
    }

    if (tweetPending.has(tweetId)) {
        return tweetPending.get(tweetId);
    }

    const requestPromise = (async () => {
        try {
            const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, CONFIG.TG_API_TIMEOUT);
            if (!fxRes.ok) throw new Error("解析失败");
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
    return requestPromise;
}

// ======================
// 文件大小探测（单请求方案，取消多余HEAD兜底）
// ======================
const sizeCache = new Map();
const sizePending = new Map();

async function getFileSizeInternal(url) {
    const cached = cacheGet(sizeCache, url);
    if (cached && Date.now() - cached.time < CONFIG.SIZE_CACHE_MS) {
        return cached.size;
    }

    if (sizePending.has(url)) {
        return sizePending.get(url);
    }

    const requestPromise = (async () => {
        let size = 0;
        try {
            const rRes = await quickFetch(url, {
                method: "GET",
                headers: {
                    "Range": "bytes=0-1",
                    "Accept-Encoding": "identity"
                }
            }, CONFIG.HEAD_TIMEOUT);

            // 主动释放连接，避免CDN挂起
            rRes.body?.cancel?.();

            // 优先从 content-range 提取
            const contentRange = rRes.headers.get("content-range");
            if (contentRange) {
                const match = contentRange.match(/\/(\d+)$/);
                if (match) {
                    size = parseInt(match[1], 10);
                }
            }

            // 同请求内兜底 content-length，不发起额外请求
            if (!size) {
                const contentLength = rRes.headers.get("content-length");
                if (contentLength) {
                    size = parseInt(contentLength, 10);
                }
            }
        } catch {}

        // 无论成功失败都写入缓存，避免重复请求异常节点
        cacheSet(sizeCache, url, { time: Date.now(), size });
        return size;
    })();

    sizePending.set(url, requestPromise);
    return requestPromise;
}

async function getFileSize(url) {
    return await getFileSizeInternal(url);
}

async function fillVariantsSize(variants) {
    const tasks = variants.map(v => () => getFileSize(v.url));
    const sizes = await limitConcurrency(tasks, CONFIG.HEAD_CONCURRENCY);
    variants.forEach((v, idx) => v.size = sizes[idx]);
    return variants;
}

// ======================
// 视频画质处理工具
// ======================
function normalizeVideoUrl(url) {
    return url.trim();
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

// 恢复按高度排序，符合视频档位直觉
function compareVariant(a, b) {
    if (a.height !== b.height) return b.height - a.height;
    return b.bitrate - a.bitrate;
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
// 串行逐个检测，找到第一个合规档立即返回，速度最稳定
async function findBestUnderLimit(variants) {
    for (const v of variants) {
        if (v.size === 0) {
            v.size = await getFileSize(v.url);
        }
        if (v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) {
            return v;
        }
    }
    return null;
}

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

        // 直发仅尝试1次，失败立即降级，减少无效等待
        try {
            const json = await tg('sendVideo', payload);
            if (json.ok) urlSent = true;
        } catch (e) {
            console.log("URL 发送失败，降级为上传:", e.message);
        }

        // 兜底：全量下载后FormData上传
        if (!urlSent) {
            const videoRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
            const arrayBuffer = await videoRes.arrayBuffer();
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
            
            await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
        }
    } 
    else {
        await tg('sendMessage', {
            chat_id: chatId,
            text: caption,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
    }
}

// ======================
// Serverless 主入口
// ======================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // ---------- 1. 回调按钮事件 ----------
    if (req.body.callback_query) {
        const callback = req.body.callback_query;
        const chatId = callback.message.chat.id;
        const callbackData = callback.data;

        // 非关键请求跳过解析
        tg('answerCallbackQuery', { callback_query_id: callback.id }, false).catch(() => {});

        // 1.1 查看所有画质列表
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressData = await tg('sendMessage', { chat_id: chatId, text: "🔍 正在加载画质列表..." });
            const progressMsgId = progressData.result?.message_id;

            if (!progressMsgId) {
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
                    return res.status(200).send('OK');
                }

                // 去重后最多保留6档，覆盖全分辨率
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
            return res.status(200).send('OK');
        }

        // 1.2 发送指定画质
        if (callbackData.startsWith('send_q:')) {
            const [, tweetId, indexStr] = callbackData.split(':');
            const variantIndex = parseInt(indexStr, 10);

            try {
                const cacheData = await getTweet(tweetId);
                const { tweet, baseVariants } = cacheData;
                if (!tweet || !baseVariants[variantIndex]) return res.status(200).send('OK');

                const chosenVariant = baseVariants[variantIndex];
                if (chosenVariant.size === 0) {
                    chosenVariant.size = await getFileSize(chosenVariant.url);
                }

                const isOverSize = chosenVariant.size > CONFIG.BOT_UPLOAD_LIMIT;
                await sendSpecificVideo(chatId, tweet, chosenVariant, { isManual: true, isOverSize });
            } catch (e) {
                console.error('[send_q] 手动投递失败', e.message);
            }
            return res.status(200).send('OK');
        }
        return res.status(200).send('OK');
    }

    // ---------- 2. 普通消息处理 ----------
    const msg = req.body.message || req.body.channel_post;
    if (!msg || !msg.text) return res.status(200).send('OK');

    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    // 删消息跳过解析
    tg('deleteMessage', { chat_id: chatId, message_id: messageId }, false).catch(() => {});

    if (text === '/start') {
        await tg('sendMessage', {
            chat_id: chatId,
            text: `<b>🤖 X/Twitter 视频解析机器人</b>

📌 使用方式：直接发送 X / Twitter 推文链接，机器人会自动解析并发送视频/图片。

✨ 功能特性：
• 自动选择 ≤50MB 的最高画质发送
• 支持手动切换不同清晰度
• 自动识别图片与纯文本推文
• 超 50MB 视频提供下载链接`,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        return res.status(200).send('OK');
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
            const best = await findBestUnderLimit(baseVariants);
            cacheData.time = Date.now();

            if (best) {
                await sendSpecificVideo(chatId, tweet, best, { autoSelected: true });
            } else {
                const topVariant = baseVariants[0];
                if (topVariant.size === 0) {
                    topVariant.size = await getFileSize(topVariant.url);
                }
                await sendSpecificVideo(chatId, tweet, topVariant, { isOverSize: true });
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

    return res.status(200).send('OK');
}

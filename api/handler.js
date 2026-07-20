const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局功能配置
// ======================
const CONFIG = {
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,   // Telegram 单文件上传上限 50MB
    MIN_DISPLAY_HEIGHT: 480,              // 最低有效画质高度（过滤极低画质）
    HEAD_TIMEOUT: 5000,                   // 文件大小探测超时（ms），适配X平台CDN波动
    DOWNLOAD_TIMEOUT: 20000,               // 视频下载超时（ms）
    TWEET_CACHE_MS: 5 * 60 * 1000,        // 推文数据缓存时长 5分钟
    SIZE_CACHE_MS: 30 * 60 * 1000,        // 文件大小缓存时长 30分钟
    MAX_CACHE: 300,                       // LRU 缓存最大条目数
    HEAD_CONCURRENCY: 4,                   // 体积探测最大并发数，降低限流风险
    URL_SEND_RETRY_DELAY: 200,             // URL 直发失败重试间隔（ms）
    TG_API_TIMEOUT: 5000                   // Telegram API 调用超时（ms）
};

// ======================
// 基础工具函数
// ======================
/** HTML 特殊字符转义，防止注入 */
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 带超时控制的 fetch 封装 */
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

/** 并发任务控制器，限制同时执行的任务数量，单任务失败不阻塞整体 */
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
// 画质列表处理工具
// ======================
/** 按分辨率高度去重，同高度保留最高码率版本（需提前排序） */
function uniqueQualityVariants(list) {
    const map = new Map();
    for (const v of list) {
        if (!map.has(v.height)) {
            map.set(v.height, v);
        }
    }
    return [...map.values()];
}

// ======================
// 消息文案生成
// ======================
/** 统一构建消息标题文案 */
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
/** 向 LRU 缓存写入数据，超出容量自动淘汰最旧条目 */
function cacheSet(cache, key, value) {
    if (cache.size >= CONFIG.MAX_CACHE) {
        const first = cache.keys().next().value;
        cache.delete(first);
    }
    cache.set(key, value);
}

// ======================
// 推文数据缓存（含 Promise 去重）
// ======================
const tweetCache = new Map();
const tweetPending = new Map();

/** 获取解析后的推文数据，带缓存与并发去重 */
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
// 文件大小缓存（含 Promise 去重 + Range 直连）
// ======================
const sizeCache = new Map();
const sizePending = new Map();

/** 内部实现：探测单个文件大小，Range 请求 + 主动释放连接，避免挂起 */
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
                    "Range": "bytes=0-0",
                    "Accept-Encoding": "identity"
                }
            }, CONFIG.HEAD_TIMEOUT);

            // 修复：await 确保 cancel 执行完成，彻底释放连接
            if (rRes.body) {
                try { await rRes.body.cancel(); } catch {}
            }

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
        } finally {
            sizePending.delete(url);
        }
    })();

    sizePending.set(url, requestPromise);
    return requestPromise;
}

/** 对外暴露：获取文件大小 */
async function getFileSize(url) {
    return await getFileSizeInternal(url);
}

/**
 * 批量填充画质列表的文件体积（优化版：单任务独立超时，单个坏链不拖整体）
 * 目前查看列表已改用逐级探测，本函数作为备用能力保留
 */
async function fillVariantsSize(variants) {
    await Promise.all(
        variants.map(async v => {
            if (v.size === 0) {
                v.size = await Promise.race([
                    getFileSize(v.url),
                    new Promise(resolve => setTimeout(() => resolve(0), CONFIG.HEAD_TIMEOUT))
                ]);
            }
        })
    );
    return variants;
}

// ======================
// 视频画质处理工具
// ======================
/** 规范化视频链接 */
function normalizeVideoUrl(url) {
    return url.trim();
}

/** 按「分辨率+码率」联合去重，保留同档位最高码率 */
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

/** 画质排序规则：分辨率高度降序 → 码率降序，保证最高画质在前 */
function compareVariant(a, b) {
    if (a.height !== b.height) return b.height - a.height;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    return 0;
}

/** 解析单条视频流信息 */
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

/** 递归遍历媒体对象，收集所有视频条目（WeakSet 防循环引用） */
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

/** 收集并过滤所有有效视频画质 */
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
        if (v.height < CONFIG.MIN_DISPLAY_HEIGHT) return false;
        return true;
    });
}

// ======================
// 核心选图与发送逻辑
// ======================
/**
 * 自动选择 ≤50MB 的最高画质
 * 从最高分辨率开始逐个探测，找到符合条件的立即返回，最小化请求次数
 */
async function findBestUnderLimit(variants) {
    for (const variant of variants) {
        if (variant.size === 0) {
            variant.size = await getFileSize(variant.url);
        }
        if (variant.size > 0 && variant.size <= CONFIG.BOT_UPLOAD_LIMIT) {
            return variant;
        }
    }
    return null;
}

/** 发送指定画质的视频，支持 URL 直发 + 全量上传兜底 */
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

        for (let attempt = 0; attempt < 2 && !urlSent; attempt++) {
            try {
                const res = await quickFetch(`${TELEGRAM_API}/sendVideo`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify(payload)
                }, CONFIG.TG_API_TIMEOUT);
                const json = await res.json();
                if (json.ok) urlSent = true;
                else throw new Error(json.description || "Direct URL send failed");
            } catch (e) {
                if (attempt === 0) await new Promise(r => setTimeout(r, CONFIG.URL_SEND_RETRY_DELAY));
                else console.log("URL 发送失败，降级为上传:", e.message);
            }
        }

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
        await quickFetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ 
                chat_id: chatId, 
                text: caption, 
                parse_mode: 'HTML', 
                reply_markup: replyMarkup 
            })
        }, CONFIG.TG_API_TIMEOUT);
    }
}

// ======================
// Serverless 主入口
// ======================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // ---------- 1. 处理回调按钮事件 ----------
    if (req.body.callback_query) {
        const callback = req.body.callback_query;
        const chatId = callback.message.chat.id;
        const callbackData = callback.data;

        quickFetch(`${TELEGRAM_API}/answerCallbackQuery`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ callback_query_id: callback.id })
        }, CONFIG.TG_API_TIMEOUT).catch(() => {});

        // 1.1 查看所有画质列表
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressRes = await quickFetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: "🔍 正在加载画质列表..." })
            }, CONFIG.TG_API_TIMEOUT);
            const progressData = await progressRes.json();
            const progressMsgId = progressData.result?.message_id;

            if (!progressMsgId) {
                return res.status(200).send('OK');
            }

            try {
                const cacheData = await getTweet(tweetId);
                const { tweet, baseVariants } = cacheData;
                if (!tweet || baseVariants.length === 0) {
                    await quickFetch(`${TELEGRAM_API}/editMessageText`, { 
                        method: 'POST', 
                        headers: JSON_HEADERS, 
                        body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 未能获取到有效的视频流资料。" }) 
                    }, CONFIG.TG_API_TIMEOUT);
                    return res.status(200).send('OK');
                }

                // 第一步：按分辨率去重，硬限制最多6个档位，避免极端场景探测过多
                const displayVariants = uniqueQualityVariants(baseVariants).slice(0, 6);
                console.log(`[list_q] 推文${tweetId} 原始画质${baseVariants.length}个，去重后待检测${displayVariants.length}个`);

                // 第二步：从高到低逐级探测，找到第一个≤50MB立即停止，后续档位不探测
                console.log(`[list_q] 开始逐级检测文件大小...`);
                let foundUnderLimit = false;
                for (const v of displayVariants) {
                    if (foundUnderLimit) {
                        v.size = -1; // 标记为无需展示
                        continue;
                    }
                    v.size = await getFileSize(v.url);
                    if (v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) {
                        foundUnderLimit = true;
                    }
                }
                console.log(`[list_q] 大小检测完成，是否找到可发送档位: ${foundUnderLimit}`);
                cacheData.time = Date.now();

                // 第三步：过滤掉标记为无需展示的低清档位
                const finalVariants = displayVariants.filter(v => v.size !== -1);

                const keyboard = finalVariants.map((v) => {
                    const sizeText = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
                    const encodedUrl = encodeURIComponent(v.url);
                    return [{
                        text: `${v.label} · ${sizeText}`,
                        callback_data: `send_q:${tweetId}:${encodedUrl}`
                    }];
                });

                await quickFetch(`${TELEGRAM_API}/editMessageText`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: `📊 <b>推文 [${tweetId}] 画质清单</b>`,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    })
                }, CONFIG.TG_API_TIMEOUT);
            } catch (err) {
                console.error(`[list_q] 加载异常:`, err.message);
                await quickFetch(`${TELEGRAM_API}/editMessageText`, { 
                    method: 'POST', 
                    headers: JSON_HEADERS, 
                    body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 加载发生异常: ${err.message}` }) 
                }, CONFIG.TG_API_TIMEOUT);
            }
            return res.status(200).send('OK');
        }

        // 1.2 发送用户选中的指定画质
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
            return res.status(200).send('OK');
        }
        return res.status(200).send('OK');
    }

    // ---------- 2. 处理用户普通消息 ----------
    const msg = req.body.message || req.body.channel_post;
    if (!msg || !msg.text) return res.status(200).send('OK');

    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    quickFetch(`${TELEGRAM_API}/deleteMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    }, CONFIG.TG_API_TIMEOUT).catch(() => {});

    if (text === '/start') {
        const welcomeText = `<b>🤖 X/Twitter 视频解析机器人</b>

📌 使用方式：直接发送 X / Twitter 推文链接，机器人会自动解析并发送视频/图片。

✨ 功能特性：
• 自动选择 ≤50MB 的最高画质发送
• 支持手动切换不同清晰度
• 自动识别图片与纯文本推文
• 超 50MB 视频提供下载链接`;

        await quickFetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                chat_id: chatId,
                text: welcomeText,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        }, CONFIG.TG_API_TIMEOUT);
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
            // 从高到低逐个探测，找到第一个≤50MB的画质立即返回
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
                await quickFetch(`${TELEGRAM_API}/sendPhoto`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ chat_id: chatId, photo: photos[0].url, caption, parse_mode: 'HTML', show_caption_above_media: true, reply_markup: replyMarkup })
                }, CONFIG.TG_API_TIMEOUT);
            } else {
                const mediaGroup = photos.map((p, idx) => ({
                    type: 'photo', media: p.url, caption: idx === 0 ? caption : '', parse_mode: idx === 0 ? 'HTML' : undefined, show_caption_above_media: idx === 0 ? true : undefined
                }));
                await quickFetch(`${TELEGRAM_API}/sendMediaGroup`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ chat_id: chatId, media: mediaGroup })
                }, CONFIG.TG_API_TIMEOUT);
            }
        } 
        else {
            const caption = buildCaption(tweet);
            await quickFetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' })
            }, CONFIG.TG_API_TIMEOUT);
        }

    } catch (error) {
        console.error('[总线报错]:', error.message);
    }

    return res.status(200).send('OK');
}

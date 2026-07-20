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
    HEAD_TIMEOUT: 3000,                   // HEAD 请求超时（ms），适配X平台CDN波动
    DOWNLOAD_TIMEOUT: 20000,               // 视频下载超时（ms）
    TWEET_CACHE_MS: 5 * 60 * 1000,        // 推文数据缓存时长 5分钟
    SIZE_CACHE_MS: 10 * 60 * 1000,        // 文件大小缓存时长 10分钟
    MAX_CACHE: 300,                       // LRU 缓存最大条目数
    HEAD_CONCURRENCY: 8,                   // 体积探测最大并发数，加快全量扫描
    URL_SEND_RETRY_DELAY: 200              // URL 直发失败重试间隔（ms）
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

/** 并发任务控制器，限制同时执行的任务数量 */
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
    // 命中有效缓存直接返回
    const cached = tweetCache.get(tweetId);
    if (cached && Date.now() - cached.time < CONFIG.TWEET_CACHE_MS) {
        return cached;
    }

    // 已有进行中的请求，直接复用 Promise
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
// 文件大小缓存（含 Promise 去重 + Range 兜底）
// ======================
const sizeCache = new Map();
const sizePending = new Map();

/** 内部实现：探测单个文件大小，HEAD 优先，Range 兜底 */
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
            // 方案1：HEAD 请求读取 Content-Length
            const hRes = await quickFetch(url, { method: "HEAD" }, CONFIG.HEAD_TIMEOUT);
            const contentLength = hRes.headers.get("content-length");
            if (contentLength) {
                const size = parseInt(contentLength, 10);
                cacheSet(sizeCache, url, { time: Date.now(), size });
                return size;
            }
            throw new Error("No Content-Length");
        } catch {
            // 方案2：GET + Range 请求读取 Content-Range
            try {
                const rRes = await quickFetch(url, {
                    method: "GET",
                    headers: { "Range": "bytes=0-0" }
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

/** 对外暴露：获取文件大小 */
async function getFileSize(url) {
    return await getFileSizeInternal(url);
}

/** 批量填充画质列表的文件体积 */
async function fillVariantsSize(variants) {
    const tasks = variants.map(v => () => getFileSize(v.url));
    const sizes = await limitConcurrency(tasks, CONFIG.HEAD_CONCURRENCY);
    variants.forEach((v, idx) => v.size = sizes[idx]);
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

/** 【修正】画质排序规则：分辨率高度降序 → 码率降序，保证最高画质在前 */
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

    // 过滤无效、过低画质、非 MP4 格式
    return deduped.filter(v => {
        if (v.isHLS) return false;
        if (!v.url.endsWith('.mp4') && !v.url.includes('.mp4?')) return false;
        if (v.width <= 0 || v.height <= 0) return false;
        if (v.width > 7680 || v.height > 7680) return false;
        if (v.height < CONFIG.MIN_DISPLAY_HEIGHT) return false;
        return true;
    });
}

/** 【修改】完整展示所有画质档位，不再裁剪 */
function trimVariantsForButton(list) {
    return list;
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

    // 体积合规：尝试 URL 直发，失败降级为上传
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

        // URL 直发 + 一次重试
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
                else console.log("URL 发送失败，降级为上传:", e.message);
            }
        }

        // 兜底：全量读取后 FormData 上传
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
    // 体积超限：发送文字消息+下载链接
    else {
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

// ======================
// Serverless 主入口
// ======================
export default async function handler(req, res) {
    // 仅允许 POST 请求
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // ---------- 1. 处理回调按钮事件 ----------
    if (req.body.callback_query) {
        const callback = req.body.callback_query;
        const chatId = callback.message.chat.id;
        const callbackData = callback.data;

        // 回执回调查询，消除按钮加载状态
        fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ callback_query_id: callback.id })
        }).catch(() => {});

        // 1.1 查看所有画质列表
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: "🔍 正在加载画质列表..." })
            });
            const progressData = await progressRes.json();
            const progressMsgId = progressData.result?.message_id;

            // 空值保护：发送失败直接终止，避免后续报错
            if (!progressMsgId) {
                return res.status(200).send('OK');
            }

            try {
                const cacheData = await getTweet(tweetId);
                const { tweet, baseVariants } = cacheData;
                if (!tweet || baseVariants.length === 0) {
                    await fetch(`${TELEGRAM_API}/editMessageText`, { 
                        method: 'POST', 
                        headers: JSON_HEADERS, 
                        body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 未能获取到有效的视频流资料。" }) 
                    });
                    return res.status(200).send('OK');
                }

                // ========== 核心修复：异步探测，不阻塞响应 ==========
                // 后台静默填充所有画质体积，完成后自动写入缓存
                fillVariantsSize(baseVariants)
                    .then(() => { cacheData.time = Date.now(); })
                    .catch(() => {});

                // 立即渲染画质列表，未探测的大小显示「检测中」
                const buttonVariants = trimVariantsForButton(baseVariants);
                const keyboard = buttonVariants.map((v) => {
                    const sizeText = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : '检测中...';
                    const encodedUrl = encodeURIComponent(v.url);
                    return [{
                        text: `${v.label} · ${sizeText}`,
                        callback_data: `send_q:${tweetId}:${encodedUrl}`
                    }];
                });

                await fetch(`${TELEGRAM_API}/editMessageText`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: `📊 <b>推文 [${tweetId}] 画质清单</b>\n<i>大小后台自动更新，稍后查看即可刷新</i>`,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    })
                });
            } catch (err) {
                await fetch(`${TELEGRAM_API}/editMessageText`, { 
                    method: 'POST', 
                    headers: JSON_HEADERS, 
                    body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 加载发生异常: ${err.message}` }) 
                });
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

                // 仅探测当前选中档位的体积
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

    // 自动删除用户发送的链接
    try {
        fetch(`${TELEGRAM_API}/deleteMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        }).catch(() => {});
    } catch (e) {
        console.log('无法删除消息，请检查机器人权限');
    }

    // /start 欢迎命令
    if (text === '/start') {
        const welcomeText = `<b>🤖 X/Twitter 视频解析机器人</b>

📌 使用方式：直接发送 X / Twitter 推文链接，机器人会自动解析并发送视频/图片。

✨ 功能特性：
• 自动选择 ≤50MB 的最高画质发送
• 支持手动切换不同清晰度
• 自动识别图片与纯文本推文
• 超 50MB 视频提供下载链接`;

        await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                chat_id: chatId,
                text: welcomeText,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
        return res.status(200).send('OK');
    }

    // 匹配 X/Twitter 链接，提取推文 ID
    const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
    const match = text.match(twitterRegex);
    if (!match) return res.status(200).send('OK');
    const tweetId = match[1];

    try {
        const cacheData = await getTweet(tweetId);
        const { tweet, baseVariants } = cacheData;
        const photos = tweet.media?.photos || [];

        // 2.1 存在视频：自动选最优画质发送
        if (baseVariants.length > 0) {
            // 从高到低逐个探测，找到第一个≤50MB的画质
            const best = await findBestUnderLimit(baseVariants);

            // 后台异步预探测剩余所有档位体积，不阻塞发送
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
                // 所有画质都超限，发送最高清档+超限提示
                const topVariant = baseVariants[0];
                if (topVariant.size === 0) {
                    topVariant.size = await getFileSize(topVariant.url);
                }
                await sendSpecificVideo(chatId, tweet, topVariant, { isOverSize: true });
            }
        } 
        // 2.2 无视频有图片：发送图片
        else if (photos.length > 0) {
            const replyMarkup = { inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]] };
            const caption = buildCaption(tweet);
            if (photos.length === 1) {
                await fetch(`${TELEGRAM_API}/sendPhoto`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ chat_id: chatId, photo: photos[0].url, caption, parse_mode: 'HTML', show_caption_above_media: true, reply_markup: replyMarkup })
                });
            } else {
                const mediaGroup = photos.map((p, idx) => ({
                    type: 'photo', media: p.url, caption: idx === 0 ? caption : '', parse_mode: idx === 0 ? 'HTML' : undefined, show_caption_above_media: idx === 0 ? true : undefined
                }));
                await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ chat_id: chatId, media: mediaGroup })
                });
            }
        } 
        // 2.3 纯文本推文：发送文字消息
        else {
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

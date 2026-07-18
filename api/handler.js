const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局配置
// ======================
const CONFIG = {
    // Telegram Bot 上传限制
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,
    // 最低展示分辨率
    MIN_DISPLAY_HEIGHT: 480,
    // 自动选择最低画质
    AUTO_MIN_HEIGHT: 720,
    // HEAD 超时
    HEAD_TIMEOUT: 1800,
    // 下载超时
    DOWNLOAD_TIMEOUT: 8000,
    // Tweet缓存
    TWEET_CACHE_MS: 5 * 60 * 1000,
    // 文件大小缓存有效期
    SIZE_CACHE_MS: 10 * 60 * 1000,
    // 最大缓存数量
    MAX_CACHE: 300
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

// 统一Caption生成：画质→作者→链接→正文
function buildCaption(tweet, options = {}) {
    const { 
        variant = null, 
        isManual = false, 
        isOverSize = false, 
        autoSelected = false 
    } = options;
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
        if (isManual) {
            lines.push(`\n⚙️ <i>手动指定投递画质: ${variant.label}</i>`);
        } else if (autoSelected) {
            lines.push(`\n💡 <i>画质已智能适配调整至: ${variant.label}</i>`);
        }
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
// Tweet 缓存
// ======================
const tweetCache = new Map();
async function getTweet(tweetId) {
    const cached = tweetCache.get(tweetId);
    if (cached && Date.now() - cached.time < CONFIG.TWEET_CACHE_MS) {
        return cached.data;
    }
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
    if (!fxRes.ok) {
        throw new Error("解析失败");
    }
    const json = await fxRes.json();
    cacheSet(tweetCache, tweetId, { time: Date.now(), data: json.tweet });
    return json.tweet;
}

// ======================
// 文件大小缓存 + 并发探测
// ======================
const sizeCache = new Map();
async function getFileSizeInternal(url) {
    const cached = sizeCache.get(url);
    if (cached && Date.now() - cached.time < CONFIG.SIZE_CACHE_MS) {
        return cached.size;
    }
    try {
        const hRes = await quickFetch(url, { method: "HEAD" }, CONFIG.HEAD_TIMEOUT);
        const size = parseInt(hRes.headers.get("content-length") || "0", 10);
        cacheSet(sizeCache, url, { time: Date.now(), size });
        return size;
    } catch {
        return 0;
    }
}

async function getFileSize(url) {
    try {
        let size = await getFileSizeInternal(url);
        if (size > 0) return size;
        throw new Error("Force Retry");
    } catch {
        try {
            await new Promise(r => setTimeout(r, 500));
            return await getFileSizeInternal(url);
        } catch {
            return 0;
        }
    }
}

// ======================
// URL 去重
// ======================
function normalizeVideoUrl(url) {
    return url.replace(/\?.*$/, "").trim();
}

// ======================
// 同分辨率保留最高码率
// ======================
function dedupeVariants(list) {
    const map = new Map();
    for (const v of list) {
        const key = `${v.width}x${v.height}`;
        if (!map.has(key)) {
            map.set(key, v);
            continue;
        }
        const old = map.get(key);
        if (v.bitrate > old.bitrate) {
            map.set(key, v);
        }
    }
    return [...map.values()];
}

// ======================
// 统一排序规则（从高到低）
// ======================
function compareVariant(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    if ((b.size || 0) !== (a.size || 0)) return (a.size || 0) - (b.size || 0);
    return 0;
}

// ======================
// 智能解析视频画质
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

    const score = Math.max(width, height);
    let label = width && height ? `${width}×${height}` : `未知画质 ${idx + 1}`;
    const type = v.content_type || v.container || "video/mp4";
    const isHLS = type.includes("mpegURL") || type.includes("m3u8");

    return {
        url: normalizeVideoUrl(v.url),
        width,
        height,
        score,
        bitrate: v.bitrate || 0,
        label,
        size: 0,
        isHLS,
        source: isHLS ? "m3u8" : "mp4"
    };
}

// ======================
// 收集并过滤有效视频画质
// ======================
function collectVideoVariants(media = {}) {
    const map = new Map();
    const addVariant = (item) => {
        if (!item || !item.url) return;
        
        if (
            item.content_type &&
            !item.content_type.includes("video") &&
            !item.content_type.includes("mpegURL")
        ) return;

        if (
            item.container &&
            item.container !== "mp4" &&
            item.container !== "m3u8"
        ) return;

        const parsed = parseVideoVariant(item);
        parsed.bitrate = item.bitrate || parsed.bitrate || 0;

        if (!map.has(parsed.url)) {
            map.set(parsed.url, parsed);
        }
    };

    const collectFromVideo = (video) => {
        if (!video) return;
        addVariant(video);
        if (Array.isArray(video.variants)) video.variants.forEach(addVariant);
        if (Array.isArray(video.formats)) video.formats.forEach(addVariant);
    };

    (media.videos || []).forEach(collectFromVideo);
    (media.all_videos || []).forEach(collectFromVideo);

    // 基础过滤：只保留有效MP4
    return [...map.values()].filter(v => {
        if (v.isHLS) return false;
        if (!v.url.endsWith('.mp4')) return false;
        if (v.width <= 0 || v.height <= 0) return false;
        if (v.width > 7680 || v.height > 7680) return false;
        if (v.score < CONFIG.MIN_DISPLAY_HEIGHT) return false;
        return true;
    });
}

// ======================
// 按钮列表精简：>50MB 全保留，≤50MB 只留最高一档
// ======================
function trimVariantsForButton(list) {
    let hasUnderLimit = false;
    return list.filter(v => {
        if (v.size > CONFIG.BOT_UPLOAD_LIMIT) {
            return true; // 大于50MB的全部保留
        } else {
            if (!hasUnderLimit) {
                hasUnderLimit = true;
                return true; // 第一个≤50MB的保留
            }
            return false; // 后续更低的全部砍掉
        }
    });
}

// ======================
// 核心发送函数
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
        
        // 优先URL直发 + 显式宽高 + 流式播放
        try {
            const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: chatId, 
                    video: variant.url, 
                    caption, 
                    parse_mode: 'HTML',
                    show_caption_above_media: true, 
                    reply_markup: replyMarkup,
                    supports_streaming: true,
                    width: variant.width,
                    height: variant.height
                })
            });
            const json = await res.json();
            if (json.ok) {
                urlSent = true;
            } else {
                throw new Error("Direct URL fallback triggered");
            }
        } catch (e) {
            console.log("URL 发送失败，降级为服务器下载上传:", e.message);
        }

        // 兜底：下载后上传
        if (!urlSent) {
            const videoRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
            const arrayBuffer = await videoRes.arrayBuffer();
            const formData = new FormData();
            formData.append('chat_id', String(chatId));
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
            formData.append('show_caption_above_media', 'true');
            formData.append('reply_markup', JSON.stringify(replyMarkup));
            formData.append('supports_streaming', 'true');
            formData.append('width', String(variant.width));
            formData.append('height', String(variant.height));
            const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
            formData.append('video', videoBlob, 'video.mp4');
            await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
        }
    } else {
        // 超出50MB：文本直链
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

        // 画质列表
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: "🔍 正在探测画质与体积..." })
            });
            const progressData = await progressRes.json();
            const progressMsgId = progressData.result?.message_id;

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet || (!tweet.media?.videos && !tweet.media?.all_videos)) {
                    if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 未能获取到有效的视频流资料。" }) });
                    return res.status(200).send('OK');
                }

                let rawVariants = collectVideoVariants(tweet.media);
                let sortedVariants = dedupeVariants(rawVariants);

                // 并发探测大小
                const sizes = await Promise.all(sortedVariants.map(v => getFileSize(v.url)));
                sortedVariants.forEach((v, idx) => v.size = sizes[idx]);
                sortedVariants.sort(compareVariant);

                // 精简按钮列表：≤50MB 只留最高一档
                const buttonVariants = trimVariantsForButton(sortedVariants);

                // 生成按钮（只显示分辨率 + 大小）
                const keyboard = [];
                buttonVariants.forEach((v, idx) => {
                    const sizeMB = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
                    // 注意：这里索引用原始 sortedVariants 的真实索引，保证点击时定位准确
                    const realIndex = sortedVariants.findIndex(item => item.url === v.url);
                    keyboard.push([{
                        text: `${v.label} · ${sizeMB}`,
                        callback_data: `send_q:${tweetId}:${realIndex}`
                    }]);
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
                });
            } catch (err) {
                if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生异常: ${err.message}` }) });
            }
        }

        // 指定画质发送
        if (callbackData.startsWith('send_q:')) {
            const [, tweetId, indexStr] = callbackData.split(':');
            const targetIdx = parseInt(indexStr, 10);

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet) return res.status(200).send('OK');

                let rawVariants = collectVideoVariants(tweet.media);
                let sortedVariants = dedupeVariants(rawVariants);
                
                const sizes = await Promise.all(sortedVariants.map(v => getFileSize(v.url)));
                sortedVariants.forEach((v, idx) => v.size = sizes[idx]);
                sortedVariants.sort(compareVariant);

                const chosenVariant = sortedVariants[targetIdx];
                if (!chosenVariant) return res.status(200).send('OK');

                const isOverSize = chosenVariant.size > CONFIG.BOT_UPLOAD_LIMIT;
                await sendSpecificVideo(chatId, tweet, chosenVariant, { isManual: true, isOverSize });
            } catch (e) {
                console.error('手动投递失败', e.message);
            }
        }
        return res.status(200).send('OK');
    }

    // ================= 用户消息处理 =================
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
        const tweet = await getTweet(tweetId);
        if (!tweet) return res.status(200).send('OK');

        let rawVariants = collectVideoVariants(tweet.media);
        const photos = tweet.media?.photos || [];

        if (rawVariants.length > 0) {
            let sortedVariants = dedupeVariants(rawVariants);
            
            const sizes = await Promise.all(sortedVariants.map(v => getFileSize(v.url)));
            sortedVariants.forEach((v, idx) => v.size = sizes[idx]);
            sortedVariants.sort(compareVariant);

            // 智能选最优：50MB内 + 不低于最低画质
            let best = null;
            for (const variant of sortedVariants) {
                if (variant.size === 0 || variant.size > CONFIG.BOT_UPLOAD_LIMIT) continue;
                if (variant.score < CONFIG.AUTO_MIN_HEIGHT) continue;

                if (!best || compareVariant(variant, best) < 0) {
                    best = variant;
                }
            }

            if (best) {
                await sendSpecificVideo(chatId, tweet, best, { autoSelected: true });
            } else {
                const topVariant = sortedVariants[0];
                await sendSpecificVideo(chatId, tweet, topVariant, { isOverSize: true });
            }

        } else if (photos.length > 0) {
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

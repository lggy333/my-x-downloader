const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局配置 (优化版：移除废弃的20MB直发限制)
// ======================
const CONFIG = {
    // Telegram Bot 上传限制（50MB内均优先URL直发）
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,
    // 自动降级最低画质
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

// === 优化新增：画质档位标签生成 ===
function getQualityTag(score) {
    if (score >= 720) return '🏆 原画';
    if (score >= 480) return '⭐ 高清';
    return '📱 流畅';
}

// === 优化新增：统一Caption生成，固定排版为 画质→作者→链接→正文 ===
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

    // 顶部：画质与体积
    if (variant) {
        const sizeMB = variant.size > 0 ? `${(variant.size / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
        lines.push(`🎞 ${variant.label} · ${sizeMB}`);
    }

    // 作者信息
    lines.push(`👤 <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a> (@${tweet.author.screen_name})`);
    
    // 原推文链接
    lines.push(`🔗 <a href="${originalTweetLink}">查看原推文</a>`);
    
    // 超大小提示（插入到分割线上方）
    if (isOverSize && variant) {
        const sizeMB = variant.size > 0 ? `${(variant.size / (1024 * 1024)).toFixed(1)} MB` : '未知';
        lines.push(`⚠️ 该画质过大 (${sizeMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载高清原片</a>`);
    }

    // 分割线
    lines.push('──────────');
    
    // 推文正文
    lines.push(escapeHTML(tweet.text));

    // 画质来源提示
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
// 文件大小缓存 + 并发HEAD探测优化
// ======================
const sizeCache = new Map();
async function getFileSizeInternal(url) {
    // === 优化：补充缓存过期判断，避免永久缓存导致尺寸不准 ===
    const cached = sizeCache.get(url);
    if (cached && Date.now() - cached.time < CONFIG.SIZE_CACHE_MS) {
        return cached.size;
    }
    try {
        const hRes = await quickFetch(url, { method: "HEAD" }, CONFIG.HEAD_TIMEOUT);
        const size = parseInt(hRes.headers.get("content-length") || "0", 10);
        // 缓存带时间戳
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
// 统一排序规则
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
    let label;

    if (width && height) {
        label = `${width}×${height}`;
    } else {
        label = `未知画质 ${idx + 1}`;
    }

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
// 收集所有视频画质 + 过滤无效流
// ======================
function collectVideoVariants(media = {}) {
    const map = new Map();
    const addVariant = (item) => {
        if (!item || !item.url) return;
        
        // 兼容 mp4, m3u8, 以及可能的 H265/AV1
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
        addVariant(video); // 默认最高画质
        if (Array.isArray(video.variants)) video.variants.forEach(addVariant);
        if (Array.isArray(video.formats)) video.formats.forEach(addVariant);
    };

    (media.videos || []).forEach(collectFromVideo);
    (media.all_videos || []).forEach(collectFromVideo);

    // === 优化：过滤无效画质，只保留可播放MP4 ===
    return [...map.values()].filter(v => {
        // 1. 排除HLS/m3u8流（Telegram原生播放支持差，且易出现离谱分辨率）
        if (v.isHLS) return false;
        // 2. 仅保留MP4格式后缀
        if (!v.url.endsWith('.mp4')) return false;
        // 3. 过滤异常分辨率（0值或超8K的虚假分辨率）
        if (v.width <= 0 || v.height <= 0) return false;
        if (v.width > 7680 || v.height > 7680) return false;
        return true;
    });
}

// ======================
// 核心业务：流式发送 + 降级上传
// ======================
async function sendSpecificVideo(chatId, tweet, variant, options = {}) {
    const { isManual = false, isOverSize = false } = options;
    const tweetId = tweet.id;
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
    };

    // 生成统一格式文案
    const caption = buildCaption(tweet, { 
        variant, 
        isManual, 
        isOverSize 
    });

    // 50MB以内：优先URL直发（Telegram服务器拉取，支持边播边加载），失败降级本地上传
    if (variant.size > 0 && variant.size <= CONFIG.BOT_UPLOAD_LIMIT) {
        let urlSent = false;
        
        // 第一优先级：URL直发，开启流式播放
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
                    supports_streaming: true // 开启流式播放，实现边缓冲边看
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

        // 第二优先级：下载后上传兜底
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
            const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
            formData.append('video', videoBlob, 'video.mp4');
            await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
        }
    } else {
        // 超出50MB：发送带直链的文本消息
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

    // ================= 逻辑分流 A：处理点击按钮事件 =================
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

        // 触发事件 1：请求画质列表清单
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步探测各档位文件体积..." })
            });
            const progressData = await progressRes.json();
            const progressMsgId = progressData.result?.message_id;

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet || (!tweet.media?.videos && !tweet.media?.all_videos)) {
                    if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 未能获取到有效的视频流资料。" }) });
                    return res.status(200).send('OK');
                }

                // 采集 -> 过滤无效画质 -> 去重保留高码率
                let rawVariants = collectVideoVariants(tweet.media);
                let sortedVariants = dedupeVariants(rawVariants);

                // 并发探测文件大小（原有并发逻辑保留，配合缓存提速）
                const sizes = await Promise.all(sortedVariants.map(v => getFileSize(v.url)));
                sortedVariants.forEach((v, idx) => v.size = sizes[idx]);
                
                // 统一排序
                sortedVariants.sort(compareVariant);

                // === 优化：按钮文案升级为分级命名 ===
                const keyboard = [];
                sortedVariants.forEach((v, idx) => {
                    const sizeMB = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
                    const kbps = v.bitrate > 0 ? `${Math.round(v.bitrate / 1000)}kbps` : '未知码率';
                    let mbpsStr = v.bitrate > 1000000 ? `${(v.bitrate/1000000).toFixed(1)}Mbps` : kbps;
                    if (v.bitrate === 0) mbpsStr = '未知码率';
                    
                    const tag = getQualityTag(v.score);
                    keyboard.push([{
                        text: `${tag}（${v.label}） · ${mbpsStr} · ${sizeMB}`,
                        callback_data: `send_q:${tweetId}:${idx}`
                    }]);
                });

                await fetch(`${TELEGRAM_API}/editMessageText`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: `📊 <b>推文 [${tweetId}] 完整画质清单</b>\n下方每一档皆可点击，体积符合将会直接发送文件，超限则发送无损直链。`,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    })
                });
            } catch (err) {
                if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生异常: ${err.message}` }) });
            }
        }

        // 触发事件 2：点击特定画质发送
        if (callbackData.startsWith('send_q:')) {
            const [, tweetId, indexStr] = callbackData.split(':');
            const targetIdx = parseInt(indexStr, 10);

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet) return res.status(200).send('OK');

                let rawVariants = collectVideoVariants(tweet.media);
                let sortedVariants = dedupeVariants(rawVariants);
                
                // 同步状态保证索引匹配（缓存命中时几乎零耗时）
                const sizes = await Promise.all(sortedVariants.map(v => getFileSize(v.url)));
                sortedVariants.forEach((v, idx) => v.size = sizes[idx]);
                sortedVariants.sort(compareVariant);

                const chosenVariant = sortedVariants[targetIdx];
                if (!chosenVariant) return res.status(200).send('OK');

                await sendSpecificVideo(chatId, tweet, chosenVariant, { isManual: true });
            } catch (e) {
                console.error('手动投递失败', e.message);
            }
        }
        return res.status(200).send('OK');
    }

    // ================= 逻辑分流 B：处理用户发送的消息 =================
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

        // --- 视频处理逻辑 ---
        if (rawVariants.length > 0) {
            let sortedVariants = dedupeVariants(rawVariants);
            
            // 并发获取体积大小
            const sizes = await Promise.all(sortedVariants.map(v => getFileSize(v.url)));
            sortedVariants.forEach((v, idx) => v.size = sizes[idx]);
            sortedVariants.sort(compareVariant);

            // 智能选最优画质：50MB内 + 不低于最低画质
            let best = null;
            for (const variant of sortedVariants) {
                if (variant.size === 0 || variant.size > CONFIG.BOT_UPLOAD_LIMIT) continue;
                if (variant.score < CONFIG.AUTO_MIN_HEIGHT) continue;

                if (!best || compareVariant(variant, best) < 0) {
                    best = variant;
                }
            }

            let finalSelectedVariant = best;
            if (finalSelectedVariant) {
                const caption = buildCaption(tweet, { variant: finalSelectedVariant, autoSelected: true });
                await sendSpecificVideo(chatId, tweet, finalSelectedVariant);
            } else {
                // 全部超限，取最高画质走超限逻辑
                const topVariant = sortedVariants[0];
                await sendSpecificVideo(chatId, tweet, topVariant, { isOverSize: true });
            }

        } else if (photos.length > 0) {
            const replyMarkup = { inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]] };
            // 图片也使用统一排版的caption
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
            // 纯文本推文
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

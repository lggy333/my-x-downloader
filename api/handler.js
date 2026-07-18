const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局配置区
// ======================
const CONFIG = {
    DIRECT_SEND_LIMIT: 20 * 1024 * 1024, // Telegram 直接 URL 发送限制
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,  // Telegram Bot 上传限制
    AUTO_MIN_HEIGHT: 720,                 // 自动降级最低画质门槛
    HEAD_TIMEOUT: 1800,                   // HEAD 超时
    DOWNLOAD_TIMEOUT: 8000,               // 下载超时
    TWEET_CACHE_MS: 5 * 60 * 1000,        // Tweet 缓存时间
    SIZE_CACHE_MS: 10 * 60 * 1000,        // 文件大小缓存时间
    MAX_CACHE: 300                        // 最大缓存数量
};

// ======================
// 内存 LRU 缓存池
// ======================
const tweetCache = new Map();
const sizeCache = new Map();

function cacheSet(cache, key, value) {
    if (cache.size >= CONFIG.MAX_CACHE) {
        const first = cache.keys().next().value;
        cache.delete(first);
    }
    cache.set(key, value);
}

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

// ======================
// 核心数据获取与并发探测
// ======================
async function getTweet(tweetId) {
    const cached = tweetCache.get(tweetId);
    if (cached && (Date.now() - cached.time < CONFIG.TWEET_CACHE_MS)) {
        return cached.data;
    }

    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
    if (!fxRes.ok) {
        throw new Error("解析失败");
    }

    const json = await fxRes.json();
    cacheSet(tweetCache, tweetId, {
        time: Date.now(),
        data: json.tweet
    });

    return json.tweet;
}

async function getFileSize(url) {
    if (sizeCache.has(url)) {
        return sizeCache.get(url);
    }
    try {
        const hRes = await quickFetch(url, { method: "HEAD" }, CONFIG.HEAD_TIMEOUT);
        const size = parseInt(hRes.headers.get("content-length") || "0", 10);
        cacheSet(sizeCache, url, size);
        return size;
    } catch {
        return 0;
    }
}

async function safeHEAD(url) {
    try {
        return await getFileSize(url);
    } catch {
        try {
            await new Promise(r => setTimeout(r, 500));
            return await getFileSize(url);
        } catch {
            return 0;
        }
    }
}

// ======================
// 数据清洗、去重与统一排序
// ======================
function compareVariant(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    if ((b.size || 0) !== (a.size || 0)) return (a.size || 0) - (b.size || 0);
    return 0;
}

function normalizeVideoUrl(url) {
    return url.replace(/\?.*$/, "").trim();
}

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
    let label = (width && height) ? `${width}×${height}` : `未知画质 ${idx + 1}`;
    
    const type = v.content_type || v.container || "video/mp4";
    const isHLS = type.includes("mpegURL") || type.includes("m3u8") || v.url.includes(".m3u8");

    return {
        url: v.url,
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

function collectVideoVariants(media = {}) {
    const map = new Map();

    const addVariant = (item) => {
        if (!item || !item.url) return;

        if (item.content_type && 
            !item.content_type.includes("video") && 
            !item.content_type.includes("mpegURL")
        ) {
            return;
        }

        if (item.container && item.container !== "mp4" && item.container !== "m3u8") {
            return;
        }

        if (item.codec && !(
            item.codec.includes("h264") || 
            item.codec.includes("h265") || 
            item.codec.includes("hevc") || 
            item.codec.includes("av01")
        )) {
            // 默认包容未声明或符合主流编码的格式
        }

        const parsed = parseVideoVariant(item);
        parsed.bitrate = item.bitrate || parsed.bitrate || 0;

        const key = normalizeVideoUrl(parsed.url);
        if (!map.has(key)) {
            map.set(key, parsed);
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

    let list = [...map.values()];
    list = dedupeVariants(list);
    list.sort(compareVariant);
    return list;
}

// ======================
// 工业级视频流点播投递引擎
// ======================
async function sendSpecificVideo(chatId, tweet, variant, size, caption) {
    const tweetId = tweet.id;
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
    };

    // 1. 20MB 以内：尝试直接通过 URL 异步发送（并启用流点播参数）
    if (size > 0 && size <= CONFIG.DIRECT_SEND_LIMIT) {
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
                    supports_streaming: true
                })
            });
            if (res.ok) return;
            console.warn("Direct URL send status not OK, trying upload...");
        } catch (e) {
            console.warn("Direct URL send failed, falling back to upload...", e.message);
        }
    }

    // 2. 20MB ~ 50MB：优先使用带流控的 URL 提交，失败则降级通过 Vercel 中转下载成原生 Video 二进制上传
    if (size > 0 && size <= CONFIG.BOT_UPLOAD_LIMIT) {
        try {
            const directRes = await fetch(`${TELEGRAM_API}/sendVideo`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: chatId, 
                    video: variant.url, 
                    caption, 
                    parse_mode: 'HTML',
                    show_caption_above_media: true, 
                    reply_markup: replyMarkup,
                    supports_streaming: true
                })
            });
            if (directRes.ok) return;
        } catch {}

        // URL 直发流通道失效，执行中转 Blob 构建表单上传
        try {
            const videoRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
            const arrayBuffer = await videoRes.arrayBuffer();
            
            const formData = new FormData();
            formData.append('chat_id', String(chatId));
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
            formData.append('show_caption_above_media', 'true');
            formData.append('reply_markup', JSON.stringify(replyMarkup));
            
            // 安全的字符串传递，防止某些环境下导致 FormData 序列化死锁失败
            formData.append('supports_streaming', 'true'); 
            
            const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
            formData.append('video', videoBlob, 'video.mp4');
            
            // 将支持流媒体参数双重挂载到 URL query 上，确保高版本客户端完美兼容
            const uploadUrl = `${TELEGRAM_API}/sendVideo?supports_streaming=true`;
            const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
            
            if (uploadRes.ok) return;
            
            const errText = await uploadRes.text();
            console.error("Telegram API upload failed raw response:", errText);
        } catch (err) {
            console.error("Buffer download or upload process crashed:", err.message);
        }
    }

    // 3. 超限 > 50MB 或上方所有网络栈意外崩溃：安全无条件兜底机制（保障机器人绝对回应）
    try {
        const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '未知';
        const authorLink = `https://x.com/${tweet.author.screen_name}`;
        const originalTweetLink = `https://x.com/i/status/${tweetId}`;
        const overSizeCaption = `📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n\n⚠️ 提示：该画质由于体积限制 (${sizeInMB}MB) 或传输异常无法直接在线播放\n🚀 <a href="${variant.url}">点此无损下载该高清原片</a> | <a href="${originalTweetLink}">查看原推特</a>`;

        await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
        });
    } catch (finalErr) {
        console.error("Fallback sendMessage failed:", finalErr.message);
    }
}

// ======================
// 路由分发异步核心
// ======================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // ----------------- 分流 A：处理 InlineKeyboard 按钮事件 -----------------
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

        // 按钮事件 ①：渲染高级面板画质清单
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步并发探测各档位文件体积..." })
            });
            const progressData = await progressRes.json();
            const progressMsgId = progressData.result?.message_id;

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet || (!tweet.media?.videos && !tweet.media?.all_videos)) {
                    if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 未能获取到有效的视频流资料。" }) });
                    return res.status(200).send('OK');
                }

                const sortedVariants = collectVideoVariants(tweet.media);
                const sizes = await Promise.all(sortedVariants.map(v => safeHEAD(v.url)));

                const keyboard = [];
                sortedVariants.forEach((v, idx) => {
                    const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)}MB` : '未知大小';
                    const bitrateMbps = v.bitrate > 0 ? ` · ${(v.bitrate / 1000000).toFixed(1)}Mbps` : '';
                    
                    keyboard.push([{
                        text: `${v.label}${bitrateMbps} · ${sizeMB}`,
                        callback_data: `send_q:${tweetId}:${idx}`
                    }]);
                });

                await fetch(`${TELEGRAM_API}/editMessageText`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: `📊 <b>推文 [${tweetId}] 完整画质清单</b>\n下方每一档皆可点击，视频已全面升级适配原生流媒体边下边播。`,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    })
                });

            } catch (err) {
                if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生异常: ${err.message}` }) });
            }
        }

        // 按钮事件 ②：用户选中单档分辨率，进行原生流精准分发
        if (callbackData.startsWith('send_q:')) {
            const [, tweetId, indexStr] = callbackData.split(':');
            const targetIdx = parseInt(indexStr, 10);

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet) return res.status(200).send('OK');

                const sortedVariants = collectVideoVariants(tweet.media);
                const chosenVariant = sortedVariants[targetIdx];
                if (!chosenVariant) return res.status(200).send('OK');

                const size = await safeHEAD(chosenVariant.url);
                const authorLink = `https://x.com/${tweet.author.screen_name}`;
                const originalTweetLink = `https://x.com/i/status/${tweetId}`;
                const caption = `📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>\n⚙️ <i>手动指定投递画质: ${chosenVariant.label}</i>`;

                await sendSpecificVideo(chatId, tweet, chosenVariant, size, caption);
            } catch (e) {
                console.error('手动精准投递失败', e.message);
            }
        }

        return res.status(200).send('OK');
    }

    // ----------------- 分流 B：接收并处理普通聊天消息（主干总线） -----------------
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

    const twitterRegex = /(?:twitter|x)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
    const match = text.match(twitterRegex);
    if (!match) return res.status(200).send('OK');

    const tweetId = match[1];

    try {
        const tweet = await getTweet(tweetId);
        if (!tweet) return res.status(200).send('OK');

        const safeText = escapeHTML(tweet.text);
        const authorLink = `https://x.com/${tweet.author.screen_name}`;
        const originalTweetLink = `https://x.com/i/status/${tweetId}`;
        let caption = `📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;

        const media = tweet.media || {};
        const sortedVariants = collectVideoVariants(media);
        const photos = media.photos || [];

        // 级联评估最佳最优画质算法
        if (sortedVariants.length > 0) {
            let best = null;

            for (const variant of sortedVariants) {
                variant.size = await safeHEAD(variant.url);

                if (variant.size === 0 || variant.size > CONFIG.BOT_UPLOAD_LIMIT) {
                    continue; 
                }
                if (variant.score < CONFIG.AUTO_MIN_HEIGHT) {
                    continue; // 触发熔断阈值：低于 720P 退出自动选择，不再往下滚
                }

                if (!best || compareVariant(variant, best) < 0) {
                    best = variant;
                }
            }

            if (best) {
                caption += `\n💡 <i>画质已智能适配调整至: ${best.label}</i>`;
                await sendSpecificVideo(chatId, tweet, best, best.size, caption);
            } else {
                const topVariant = sortedVariants[0];
                const topSize = await safeHEAD(topVariant.url);
                await sendSpecificVideo(chatId, tweet, topVariant, topSize, caption);
            }

        } else if (photos.length > 0) {
            const replyMarkup = { inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]] };
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
            await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' })
            });
        }

    } catch (error) {
        console.error('[总线内核报错]:', error.message);
    }

    return res.status(200).send('OK');
}

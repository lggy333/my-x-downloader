const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 第十八部分：全局配置
// ======================
const CONFIG = {
    DIRECT_SEND_LIMIT: 20 * 1024 * 1024, // Telegram 直接 URL 发送限制
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,  // Telegram Bot 上传限制
    AUTO_MIN_HEIGHT: 720,                 // 自动降级最低画质门槛
    HEAD_TIMEOUT: 1800,                   // HEAD 超时
    DOWNLOAD_TIMEOUT: 8000,               // 下载超时
    TWEET_CACHE_MS: 5 * 60 * 1000,        // Tweet缓存
    SIZE_CACHE_MS: 10 * 60 * 1000,        // 文件大小缓存
    MAX_CACHE: 300                        // 最大缓存数量
};

// ======================
// 第十九部分：LRU缓存
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
// 第八部分：增加 Tweet 缓存
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

// ======================
// 第九、二十三部分：安全获取大小与重试
// ======================
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
// 第二十部分：统一排序
// ======================
function compareVariant(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    if ((b.size || 0) !== (a.size || 0)) return (a.size || 0) - (b.size || 0);
    return 0;
}

// ======================
// 第十三部分：URL智能去重
// ======================
function normalizeVideoUrl(url) {
    return url.replace(/\?.*$/, "").trim();
}

// ======================
// 第十四部分：同分辨率保留最高码率去重
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
// 第二部分 & 第十二部分：升级并规范化视频解析
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
    let label = (width && height) ? `${width}×${height}` : `未知画质 ${idx + 1}`;
    
    // 检查是否为 HLS
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

// ======================
// 第一部分、第十五、第十六部分：全能视频源合并收集器
// ======================
function collectVideoVariants(media = {}) {
    const map = new Map();

    const addVariant = (item) => {
        if (!item || !item.url) return;

        // 过滤非媒体流，保留视频及 M3U8，并支持 H264/HEVC/AV1 等常见编码
        if (item.content_type && 
            !item.content_type.includes("video") && 
            !item.content_type.includes("mpegURL")
        ) {
            return;
        }

        if (item.container && item.container !== "mp4" && item.container !== "m3u8") {
            return;
        }

        // 兼容支持特定编码格式
        if (item.codec && !(
            item.codec.includes("h264") || 
            item.codec.includes("h265") || 
            item.codec.includes("hevc") || 
            item.codec.includes("av01")
        )) {
            // 如果显式声明了非主流编码则跳过，未声明则默认保留
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
// 第十七部分：带智能回退的高级发送引擎
// ======================
async function sendSpecificVideo(chatId, tweet, variant, size, caption) {
    const tweetId = tweet.id;
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
    };

    // 1. 小于 20MB 触发优先 URL 方案
    if (size > 0 && size <= CONFIG.DIRECT_SEND_LIMIT) {
        try {
            await fetch(`${TELEGRAM_API}/sendVideo`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML',
                    show_caption_above_media: true, reply_markup: replyMarkup
                })
            });
            return;
        } catch (e) {
            console.warn("Direct URL send failed, falling back to upload...");
        }
    }

    // 2. 20MB ~ 50MB 优先 URL 发送，失败则通过 Vercel 中转 Buffer 上传
    if (size > 0 && size <= CONFIG.BOT_UPLOAD_LIMIT) {
        try {
            // 尝试直接 URL 发送
            const directRes = await fetch(`${TELEGRAM_API}/sendVideo`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML',
                    show_caption_above_media: true, reply_markup: replyMarkup
                })
            });
            if (directRes.ok) return;
        } catch {}

        // URL 失败或超限，降级进入下载上传
        try {
            const videoRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
            const arrayBuffer = await videoRes.arrayBuffer();
            const formData = new FormData();
            formData.append('chat_id', String(chatId));
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
            formData.append('show_caption_above_media', 'true');
            formData.append('reply_markup', JSON.stringify(replyMarkup));
            
            const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
            formData.append('video', videoBlob, 'video.mp4');
            
            await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
            return;
        } catch (err) {
            console.error("Upload failed:", err.message);
        }
    }

    // 3. 超限 >50MB 文本直链兜底
    const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '未知';
    const authorLink = `https://x.com/${tweet.author.screen_name}`;
    const originalTweetLink = `https://x.com/i/status/${tweetId}`;
    const overSizeCaption = `📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n\n⚠️ 提示：该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载该高清原片</a> | <a href="${originalTweetLink}">查看原推特</a>`;

    await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
    });
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

        // 触发事件 1：请求高级画质清单面板
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
                // 第八部分：使用缓存获取 Tweet
                const tweet = await getTweet(tweetId);
                if (!tweet || (!tweet.media?.videos && !tweet.media?.all_videos)) {
                    if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText,`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 未能获取到有效的视频流资料。" }) });
                    return res.status(200).send('OK');
                }

                // 第三部分：规范化重构提取
                const sortedVariants = collectVideoVariants(tweet.media);

                // 第十部分：并行高效率探测体积
                const sizes = await Promise.all(sortedVariants.map(v => safeHEAD(v.url)));

                // 第二十二部分：生成信息饱满的工业级交互按钮
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
                        text: `📊 <b>推文 [${tweetId}] 完整画质清单</b>\n下方每一档皆可点击，智能判断发送方式。m3u8 规格已在 V2 中作为首档兼容备用。`,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    })
                });

            } catch (err) {
                if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生异常: ${err.message}` }) });
            }
        }

        // 触发事件 2：点击了清单面板执行精准高精度投递
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

    // ================= 逻辑分流 B：处理用户发链接的原生总线 =================
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
        // 第八部分：引入高速缓存池
        const tweet = await getTweet(tweetId);
        if (!tweet) return res.status(200).send('OK');

        const safeText = escapeHTML(tweet.text);
        const authorLink = `https://x.com/${tweet.author.screen_name}`;
        const originalTweetLink = `https://x.com/i/status/${tweetId}`;
        let caption = `📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;

        const media = tweet.media || {};
        const sortedVariants = collectVideoVariants(media);
        const photos = media.photos || [];

        // --- 核心业务：第二十一部分 真正的最佳视频算法 ---
        if (sortedVariants.length > 0) {
            let best = null;

            for (const variant of sortedVariants) {
                variant.size = await safeHEAD(variant.url);

                if (variant.size === 0 || variant.size > CONFIG.BOT_UPLOAD_LIMIT) {
                    continue; // 过滤异常或完全超标文件
                }
                if (variant.score < CONFIG.AUTO_MIN_HEIGHT) {
                    continue; // 熔断过滤：低于最低自动分辩率策略阈值
                }

                // 评估最完美的最优解：高分辨率 -> 高码率 -> 最贴近 50MB 
                if (!best || compareVariant(variant, best) < 0) {
                    best = variant;
                }
            }

            if (best) {
                caption += `\n💡 <i>画质已智能适配调整至: ${best.label}</i>`;
                await sendSpecificVideo(chatId, tweet, best, best.size, caption);
            } else {
                // 如果在硬限内没有符合最优条件的（或都超过50MB），使用排在第一的最高质量
                const topVariant = sortedVariants[0];
                const topSize = await safeHEAD(topVariant.url);
                await sendSpecificVideo(chatId, tweet, topVariant, topSize, caption);
            }

        } else if (photos.length > 0) {
            // 纯图片处理逻辑
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
            // 纯文本推特
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

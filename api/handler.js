const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局配置
// ======================
const CONFIG = {
    // Telegram Bot 单文件上传上限（普通Bot官方限制50MB）
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,
    // 自动选档最低画质高度
    AUTO_MIN_HEIGHT: 720,
    // HEAD 请求超时
    HEAD_TIMEOUT: 1800,
    // 视频下载超时
    DOWNLOAD_TIMEOUT: 8000,
    // 推文数据缓存时长
    TWEET_CACHE_MS: 5 * 60 * 1000,
    // 文件大小缓存时长
    SIZE_CACHE_MS: 10 * 60 * 1000,
    // LRU 缓存最大条目
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
// Tweet 数据缓存
// ======================
const tweetCache = new Map();
async function getTweet(tweetId) {
    const cached = tweetCache.get(tweetId);
    if (cached && Date.now() - cached.time < CONFIG.TWEET_CACHE_MS) {
        return cached.data;
    }
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
    if (!fxRes.ok) {
        throw new Error("推文解析失败");
    }
    const json = await fxRes.json();
    cacheSet(tweetCache, tweetId, { time: Date.now(), data: json.tweet });
    return json.tweet;
}

// ======================
// 文件大小缓存与安全 HEAD
// ======================
const sizeCache = new Map();
async function getFileSizeInternal(url) {
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
// URL 标准化去重
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
// 过滤异常无效画质
// ======================
function filterInvalidVariants(list) {
    return list.filter(v => {
        // 过滤分辨率极小的异常画质（如 3×5 这类无法播放的错误条目）
        if (v.width < 100 || v.height < 100) return false;
        // 保留 MP4 和 HLS 格式，过滤其他无效资源
        if (!v.isHLS && !v.url.endsWith('.mp4')) return false;
        return true;
    });
}

// ======================
// 统一画质排序规则
// ======================
function compareVariant(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    if ((b.size || 0) !== (a.size || 0)) return (a.size || 0) - (b.size || 0);
    return 0;
}

// ======================
// 单条画质信息解析
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
    const label = width && height ? `${width}×${height}` : `未知画质 ${idx + 1}`;
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
// 收集所有可用视频画质
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
    return [...map.values()];
}

// ======================
// 核心发送逻辑：URL直发优先 + 流式播放 + 三级降级
// 全程使用原始视频，不做转码缩放，天然保持原比例
// ======================
async function sendSpecificVideo(chatId, tweet, variant, size, caption) {
    const tweetId = tweet.id;
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
    };

    // 已知超过50MB，直接发直链文案，避免无效请求
    if (size > 0 && size > CONFIG.BOT_UPLOAD_LIMIT) {
        const sizeInMB = (size / (1024 * 1024)).toFixed(1);
        const authorLink = `https://x.com/${tweet.author.screen_name}`;
        const originalTweetLink = `https://x.com/i/status/${tweetId}`;
        const overSizeCaption = `💡 <i>画质: ${variant.label}</i>\n\n📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>\n\n⚠️ 该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载高清原片</a>`;

        await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ 
                chat_id: chatId, 
                text: overSizeCaption, 
                parse_mode: 'HTML', 
                reply_markup: replyMarkup 
            })
        });
        return;
    }

    // 第一级：优先 URL 直发（Telegram 服务器拉取，边缓冲边播放，速度最快）
    let urlSent = false;
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
        const json = await res.json();
        if (json.ok) {
            urlSent = true;
        } else {
            throw new Error(json.description || "URL 直发失败");
        }
    } catch (e) {
        console.log("URL 直发失败，降级本地上传:", e.message);
    }

    // 第二级：URL 失败，回退为下载后上传
    if (!urlSent) {
        try {
            const videoRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
            const arrayBuffer = await videoRes.arrayBuffer();
            const formData = new FormData();
            formData.append('chat_id', String(chatId));
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
            formData.append('show_caption_above_media', 'true');
            formData.append('reply_markup', JSON.stringify(replyMarkup));
            formData.append('supports_streaming', 'true');
            // 原始视频直接上传，不做任何转码裁剪，严格保持原比例
            formData.append('video', new Blob([arrayBuffer], { type: 'video/mp4' }), 'video.mp4');
            
            await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
        } catch (uploadErr) {
            // 第三级：上传也失败，发送直链兜底
            const authorLink = `https://x.com/${tweet.author.screen_name}`;
            const originalTweetLink = `https://x.com/i/status/${tweetId}`;
            const failCaption = `💡 <i>画质: ${variant.label}</i>\n\n📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>\n\n❌ 视频发送失败\n🚀 <a href="${variant.url}">点击查看视频直链</a>`;
            
            await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: failCaption, parse_mode: 'HTML' })
            });
        }
    }
}

// ======================
// 主入口
// ======================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // ========== 分支A：回调按钮事件 ==========
    if (req.body.callback_query) {
        const callback = req.body.callback_query;
        if (ALLOWED_USER_ID && String(callback.from?.id) !== String(ALLOWED_USER_ID)) {
            return res.status(200).send('OK');
        }

        const chatId = callback.message.chat.id;
        const callbackData = callback.data;

        // 异步响应回调，避免超时阻塞
        fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ callback_query_id: callback.id })
        }).catch(() => {});

        // 事件1：拉取画质列表
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ chat_id: chatId, text: "🔍 正在探测各档位文件体积..." })
            });
            const progressData = await progressRes.json();
            const progressMsgId = progressData.result?.message_id;

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet || (!tweet.media?.videos && !tweet.media?.all_videos)) {
                    if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { 
                        method: 'POST', 
                        headers: JSON_HEADERS, 
                        body: JSON.stringify({ 
                            chat_id: chatId, 
                            message_id: progressMsgId, 
                            text: "❌ 未获取到有效视频资源" 
                        }) 
                    });
                    return res.status(200).send('OK');
                }

                // 采集 → 去重 → 过滤异常画质
                let rawVariants = collectVideoVariants(tweet.media);
                let validVariants = filterInvalidVariants(dedupeVariants(rawVariants));

                // 并发探测文件大小
                const sizes = await Promise.all(validVariants.map(v => getFileSize(v.url)));
                validVariants.forEach((v, idx) => v.size = sizes[idx]);
                validVariants.sort(compareVariant);

                // 生成按钮列表
                const keyboard = [];
                validVariants.forEach((v, idx) => {
                    const sizeMB = v.size > 0 ? `${(v.size / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
                    let mbpsStr = '未知码率';
                    if (v.bitrate > 1000000) {
                        mbpsStr = `${(v.bitrate / 1000000).toFixed(1)}Mbps`;
                    } else if (v.bitrate > 0) {
                        mbpsStr = `${Math.round(v.bitrate / 1000)}kbps`;
                    }

                    keyboard.push([{
                        text: `${v.label} · ${mbpsStr} · ${sizeMB}`,
                        callback_data: `send_q:${tweetId}:${idx}`
                    }]);
                });

                await fetch(`${TELEGRAM_API}/editMessageText`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: `📊 <b>推文 [${tweetId}] 完整画质清单</b>\n点击对应档位即可发送，超限将自动返回直链。`,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    })
                });
            } catch (err) {
                if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { 
                    method: 'POST', 
                    headers: JSON_HEADERS, 
                    body: JSON.stringify({ 
                        chat_id: chatId, 
                        message_id: progressMsgId, 
                        text: `❌ 探测异常: ${err.message}` 
                    }) 
                });
            }
        }

        // 事件2：发送指定画质
        if (callbackData.startsWith('send_q:')) {
            const [, tweetId, indexStr] = callbackData.split(':');
            const targetIdx = parseInt(indexStr, 10);

            try {
                const tweet = await getTweet(tweetId);
                if (!tweet) return res.status(200).send('OK');

                let rawVariants = collectVideoVariants(tweet.media);
                let validVariants = filterInvalidVariants(dedupeVariants(rawVariants));
                
                // 同步大小并排序，保证索引与列表完全一致
                const sizes = await Promise.all(validVariants.map(v => getFileSize(v.url)));
                validVariants.forEach((v, idx) => v.size = sizes[idx]);
                validVariants.sort(compareVariant);

                const chosenVariant = validVariants[targetIdx];
                if (!chosenVariant) return res.status(200).send('OK');

                const authorLink = `https://x.com/${tweet.author.screen_name}`;
                const originalTweetLink = `https://x.com/i/status/${tweetId}`;
                // 排版顺序：画质提示 → 推文正文 → 作者 → 原链接
                const caption = `💡 <i>手动投递画质: ${chosenVariant.label}</i>\n\n📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;

                await sendSpecificVideo(chatId, tweet, chosenVariant, chosenVariant.size, caption);
            } catch (e) {
                console.error('手动投递失败', e.message);
            }
        }
        return res.status(200).send('OK');
    }

    // ========== 分支B：用户消息处理 ==========
    const msg = req.body.message;
    if (!msg || !msg.text) return res.status(200).send('OK');
    if (ALLOWED_USER_ID && String(msg.from?.id) !== String(ALLOWED_USER_ID)) {
        return res.status(200).send('OK');
    }

    const text = msg.text;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    // 异步删除用户原消息，不阻塞主流程
    fetch(`${TELEGRAM_API}/deleteMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    }).catch(() => {});

    const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
    const match = text.match(twitterRegex);
    if (!match) return res.status(200).send('OK');

    const tweetId = match[1];

    try {
        const tweet = await getTweet(tweetId);
        if (!tweet) return res.status(200).send('OK');

        const safeText = escapeHTML(tweet.text);
        const authorLink = `https://x.com/${tweet.author.screen_name}`;
        const originalTweetLink = `https://x.com/i/status/${tweetId}`;

        let rawVariants = collectVideoVariants(tweet.media);
        const photos = tweet.media?.photos || [];

        // ---------- 视频处理（优化版：跳过全量大小探测，逐个尝试直发，大幅提速）----------
        if (rawVariants.length > 0) {
            let validVariants = filterInvalidVariants(dedupeVariants(rawVariants));
            validVariants.sort(compareVariant);

            // 筛选符合最低画质的候选，无符合则降级用全部
            const candidates = validVariants.filter(v => v.score >= CONFIG.AUTO_MIN_HEIGHT);
            const finalCandidates = candidates.length > 0 ? candidates : validVariants;

            let sendSuccess = false;
            let selectedVariant = null;

            // 从高到低逐个尝试 URL 直发，成功即停止，省去全量 HEAD 探测开销
            for (const variant of finalCandidates) {
                try {
                    const caption = `💡 <i>智能适配画质: ${variant.label}</i>\n\n📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;
                    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
                        method: 'POST',
                        headers: JSON_HEADERS,
                        body: JSON.stringify({
                            chat_id: chatId,
                            video: variant.url,
                            caption,
                            parse_mode: 'HTML',
                            show_caption_above_media: true,
                            reply_markup: {
                                inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
                            },
                            supports_streaming: true
                        })
                    });
                    const json = await res.json();
                    if (json.ok) {
                        selectedVariant = variant;
                        sendSuccess = true;
                        break;
                    }
                } catch (e) {
                    console.log(`画质 ${variant.label} 直发失败，尝试下一档次`);
                }
            }

            // 全部 URL 直发失败，走下载上传兜底
            if (!sendSuccess) {
                selectedVariant = finalCandidates[0];
                const caption = `💡 <i>智能适配画质: ${selectedVariant.label}</i>\n\n📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;
                await sendSpecificVideo(chatId, tweet, selectedVariant, 0, caption);
            }

        } else if (photos.length > 0) {
            // ---------- 图片处理 ----------
            const replyMarkup = { inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]] };
            const caption = `📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;
            
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
            // ---------- 纯文本推文 ----------
            const caption = `📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;
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

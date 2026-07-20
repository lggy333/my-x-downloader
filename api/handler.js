const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局功能配置（稳定版参数）
// ======================
const CONFIG = {
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024,
    MIN_DISPLAY_HEIGHT: 240,
    HEAD_TIMEOUT: 2500,
    DOWNLOAD_TIMEOUT: 20000,
    TWEET_CACHE_MS: 10 * 60 * 1000,
    SIZE_CACHE_MS: 30 * 60 * 1000,
    FAIL_SIZE_CACHE_MS: 1 * 60 * 1000,
    MAX_CACHE: 500,
    HEAD_CONCURRENCY: 4,
    TG_API_TIMEOUT: 5000,
    URL_CHECK_TIMEOUT: 2000 // 新增：视频URL检测超时
};

// ======================
// 性能计时器（全链路总览）
// ======================
function createTimer(name = "TOTAL") {
    const start = Date.now();
    const points = {};

    return {
        mark(label) {
            points[label] = Date.now() - start;
        },

        end() {
            const total = Date.now() - start;
            console.log(`\n===== ${name} 性能报告 =====`);
            for (const [k, v] of Object.entries(points)) {
                console.log(`${k}: ${v}ms`);
            }
            console.log(`TOTAL: ${total}ms`);
            console.log("====================\n");
            return { total, points };
        }
    };
}

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

// 新增：视频URL可用性检测（仅打日志，不拦截）
async function checkVideoUrl(url) {
    try {
        const r = await quickFetch(url, {
            method: "HEAD"
        }, CONFIG.URL_CHECK_TIMEOUT);

        const result = {
            ok: r.ok,
            type: r.headers.get("content-type"),
            length: r.headers.get("content-length")
        };
        console.log("[视频URL检测]", result);
        return result;
    } catch {
        console.log("[视频URL检测] 请求失败");
        return { ok: false };
    }
}

// ======================
// 画质列表处理工具
// ======================
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
// 推文数据缓存（已加入细粒度计时）
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
            console.time("fx请求耗时");
            const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, CONFIG.TG_API_TIMEOUT);
            console.timeEnd("fx请求耗时");

            if (!fxRes.ok) throw new Error("解析失败");

            console.time("fx JSON解析耗时");
            const json = await fxRes.json();
            console.timeEnd("fx JSON解析耗时");

            console.time("视频流扫描耗时");
            const rawVariants = collectVideoVariants(json.tweet.media);
            console.timeEnd("视频流扫描耗时");

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
// 文件大小缓存（成功/失败分级缓存 + 细粒度计时）
// ======================
const sizeCache = new Map();
const sizePending = new Map();

async function getFileSizeInternal(url) {
    const cached = sizeCache.get(url);
    if (cached) {
        const isSuccessValid = !cached.fail && Date.now() - cached.time < CONFIG.SIZE_CACHE_MS;
        const isFailValid = cached.fail && Date.now() - cached.time < CONFIG.FAIL_SIZE_CACHE_MS;
        if (isSuccessValid || isFailValid) {
            return cached.size;
        }
    }

    if (sizePending.has(url)) {
        return sizePending.get(url);
    }

    const requestPromise = (async () => {
        try {
            console.time("单文件大小探测耗时");
            const rRes = await quickFetch(url, {
                method: "GET",
                headers: {
                    "Range": "bytes=0-1",
                    "Accept-Encoding": "identity"
                }
            }, CONFIG.HEAD_TIMEOUT);
            console.timeEnd("单文件大小探测耗时");

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

            cacheSet(sizeCache, url, {
                time: Date.now(),
                size: 0,
                fail: true
            });
            return 0;
        } catch {
            cacheSet(sizeCache, url, {
                time: Date.now(),
                size: 0,
                fail: true
            });
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

// ======================
// 核心选档逻辑（前2档并发 + 后续串行兜底）
// ======================
async function findBestUnderLimit(variants) {
    const top = variants.slice(0, 2);
    const result = await Promise.all(
        top.map(async v => {
            if (!v.size) {
                v.size = await getFileSize(v.url);
            }
            return v;
        })
    );

    const ok = result
        .filter(v => v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT)
        .sort(compareVariant);

    if (ok.length) return ok[0];

    for (let i = 2; i < variants.length; i++) {
        let v = variants[i];
        if (!v.size) v.size = await getFileSize(v.url);
        if (v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) return v;
    }

    return null;
}

// ======================
// 视频发送逻辑（核心改动：移除上传降级 + 直链检测日志 + 细粒度计时）
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

        // 发送前检测URL状态（仅打日志）
        await checkVideoUrl(variant.url);

        for (let attempt = 0; attempt < 2 && !urlSent; attempt++) {
            try {
                console.time("TG sendVideo 直链耗时");
                const json = await tg('sendVideo', payload);
                console.timeEnd("TG sendVideo 直链耗时");

                if (json.ok) urlSent = true;
                else throw new Error(json.description || "Direct URL send failed");
            } catch (e) {
                if (attempt === 0) await new Promise(r => setTimeout(r, 200));
                else console.log("URL 发送失败，直接返回下载链接:", e.message);
            }
        }

        // 改动：移除下载上传降级逻辑，失败直接发送带下载链接的消息
        if (!urlSent) {
            console.log("Telegram直链发送全部失败，跳过上传降级，返回下载链接");
            await tg('sendMessage', {
                chat_id: chatId,
                text: buildCaption(tweet, {
                    variant,
                    isOverSize: true
                }),
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            });
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
// Serverless 主入口（全链路计时器保持不变）
// ======================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const timer = createTimer("X VIDEO BOT");

    // ---------- 1. 回调按钮事件 ----------
    if (req.body.callback_query) {
        const callback = req.body.callback_query;
        const chatId = callback.message.chat.id;
        const callbackData = callback.data;

        tg('answerCallbackQuery', { callback_query_id: callback.id }, false).catch(() => {});

        // 1.1 查看所有画质列表
        if (callbackData.startsWith('list_q:')) {
            const tweetId = callbackData.split(':')[1];
            const progressData = await tg('sendMessage', { chat_id: chatId, text: "🔍 正在加载画质列表..." });
            const progressMsgId = progressData.result?.message_id;

            if (!progressMsgId) {
                timer.end();
                return res.status(200).send('OK');
            }

            try {
                const cacheData = await getTweet(tweetId);
                timer.mark("fxTwitter解析完成");

                const { tweet, baseVariants } = cacheData;
                if (!tweet || baseVariants.length === 0) {
                    await tg('editMessageText', {
                        chat_id: chatId,
                        message_id: progressMsgId,
                        text: "❌ 未能获取到有效的视频流资料。"
                    });
                    timer.end();
                    return res.status(200).send('OK');
                }

                const displayVariants = uniqueQualityVariants(baseVariants).slice(0, 6);
                await fillVariantsSize(displayVariants);
                timer.mark("画质体积探测完成");

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
            timer.end();
            return res.status(200).send('OK');
        }

        // 1.2 发送指定画质
        if (callbackData.startsWith('send_q:')) {
            const [, tweetId, indexStr] = callbackData.split(':');
            const variantIndex = parseInt(indexStr, 10);

            try {
                const cacheData = await getTweet(tweetId);
                timer.mark("fxTwitter解析完成");

                const { tweet, baseVariants } = cacheData;
                if (!tweet || !baseVariants[variantIndex]) {
                    timer.end();
                    return res.status(200).send('OK');
                }

                const chosenVariant = baseVariants[variantIndex];
                if (chosenVariant.size === 0) {
                    chosenVariant.size = await getFileSize(chosenVariant.url);
                }
                timer.mark("画质体积探测完成");

                const isOverSize = chosenVariant.size > CONFIG.BOT_UPLOAD_LIMIT;
                timer.mark("开始发送Telegram");
                await sendSpecificVideo(chatId, tweet, chosenVariant, { isManual: true, isOverSize });
                timer.mark("Telegram发送完成");
            } catch (e) {
                console.error('[send_q] 手动投递失败', e.message);
            }
            timer.end();
            return res.status(200).send('OK');
        }

        timer.end();
        return res.status(200).send('OK');
    }

    // ---------- 2. 普通消息处理 ----------
    const msg = req.body.message || req.body.channel_post;
    if (!msg || !msg.text) {
        timer.end();
        return res.status(200).send('OK');
    }

    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

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
        timer.end();
        return res.status(200).send('OK');
    }

    const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
    const match = text.match(twitterRegex);
    if (!match) {
        timer.end();
        return res.status(200).send('OK');
    }
    const tweetId = match[1];

    try {
        const cacheData = await getTweet(tweetId);
        timer.mark("fxTwitter解析完成");

        const { tweet, baseVariants } = cacheData;
        const photos = tweet.media?.photos || [];

        if (baseVariants.length > 0) {
            const best = await findBestUnderLimit(baseVariants);
            timer.mark("画质选择完成");
            cacheData.time = Date.now();

            if (best) {
                timer.mark("开始发送Telegram");
                await sendSpecificVideo(chatId, tweet, best, { autoSelected: true });
                timer.mark("Telegram发送完成");
            } else {
                const topVariant = baseVariants[0];
                if (topVariant.size === 0) {
                    topVariant.size = await getFileSize(topVariant.url);
                }
                timer.mark("开始发送Telegram");
                await sendSpecificVideo(chatId, tweet, topVariant, { isOverSize: true });
                timer.mark("Telegram发送完成");
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
            timer.mark("媒体发送完成");
        } 
        else {
            await tg('sendMessage', {
                chat_id: chatId,
                text: buildCaption(tweet),
                parse_mode: 'HTML'
            });
            timer.mark("文本发送完成");
        }

    } catch (error) {
        console.error('[总线报错]:', error.message);
    }

    timer.end();
    return res.status(200).send('OK');
}

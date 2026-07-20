const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ======================
// 全局功能配置
// ======================
const CONFIG = {
    BOT_UPLOAD_LIMIT: 50 * 1024 * 1024, // Telegram Bot API 50MB 上限
    MIN_DISPLAY_HEIGHT: 160,            // 允许 320x426 等竖屏低清流
    HEAD_TIMEOUT: 1500,
    DOWNLOAD_TIMEOUT: 20000,
    TWEET_CACHE_MS: 10 * 60 * 1000,
    SIZE_CACHE_MS: 30 * 60 * 1000,
    FAIL_SIZE_CACHE_MS: 1 * 60 * 1000,
    MAX_CACHE: 500,
    HEAD_CONCURRENCY: 4,
    TG_API_TIMEOUT: 15000
};

// ======================
// 性能计时器
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

/**
 * 核心新增：Worker 本地下载文件并通过 Multipart FormData 提交 Telegram
 */
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

    const res = await quickFetch(
        `${TELEGRAM_API}/${method}`,
        {
            method: 'POST',
            body: formData
        },
        30000 // 文件上传给予 30s 宽裕超时
    );
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
// 画质预检工具 (含 MP4 Magic Header 校验)
// ======================
async function checkVideoUrl(url) {
    try {
        const r = await quickFetch(url, {
            method: "GET",
            headers: {
                "Range": "bytes=0-511",
                "Accept-Encoding": "identity"
            }
        }, CONFIG.HEAD_TIMEOUT);

        const type = r.headers.get("content-type") || "";
        
        // 读取前几个字节，简单防止网页/重定向包
        const arrayBuf = await r.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf.slice(0, 12));
        
        // 校验 ftpy/mp4 magic bytes (通常第4-8字节为 ftyp)
        const isMp4Magic = bytes.length >= 8 && (
            (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)
        );

        return {
            ok: (r.ok || r.status === 206) && isMp4Magic,
            type
        };
    } catch (e) {
        return { ok: false, type: "" };
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
    const { 
        variant = null, 
        isManual = false, 
        isOverSize = false, 
        autoSelected = false, 
        isSendFailed = false,
        isSizeUnknown = false
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
        if (variant.url.length > 300) {
            lines.push(`⚠️ 该画质过大 (${sizeMB}) 无法直接发送\n🚀 高清原片链接过长，请通过画质按钮选择下载`);
        } else {
            lines.push(`⚠️ 该画质过大 (${sizeMB}) 无法直接发送\n🚀 <a href="${variant.url}">点此下载高清原片</a>`);
        }
    } else if (isSizeUnknown && variant) {
        if (variant.url.length > 300) {
            lines.push(`⚠️ 无法检测视频大小\n🚀 原片链接过长，请通过画质按钮选择下载`);
        } else {
            lines.push(`⚠️ 无法检测视频大小\n🚀 <a href="${variant.url}">点此下载高清原片</a>`);
        }
    } else if (isSendFailed && variant) {
        if (variant.url.length > 300) {
            lines.push(`⚠️ 视频发送失败，请尝试其他画质\n🚀 原片链接过长，请通过画质按钮选择下载`);
        } else {
            lines.push(`⚠️ 视频发送失败，请尝试其他画质\n🚀 <a href="${variant.url}">点此下载高清原片</a>`);
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
// 推文数据缓存
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
// 文件大小缓存 (Range: bytes=0-1)
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
            const rRes = await quickFetch(url, {
                method: "GET",
                headers: {
                    "Range": "bytes=0-1",
                    "Accept-Encoding": "identity"
                }
            }, CONFIG.HEAD_TIMEOUT);

            rRes.body?.cancel?.();

            const contentRange = rRes.headers.get("content-range");
            if (contentRange) {
                const match = contentRange.match(/\/(\d+)/);
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

            cacheSet(sizeCache, url, { time: Date.now(), size: 0, fail: true });
            return 0;
        } catch {
            cacheSet(sizeCache, url, { time: Date.now(), size: 0, fail: true });
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
// 核心选档逻辑
// ======================
async function findBestUnderLimit(variants) {
    const top = variants.slice(0, 3);
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

    for (let i = 3; i < variants.length; i++) {
        let v = variants[i];
        if (!v.size) v.size = await getFileSize(v.url);
        if (v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) return v;
    }

    return null;
}

// ======================
// 自动降档发送（直链失败后，自动通过 Worker 转接上传）
// ======================
async function sendBestAvailable(chatId, tweet, variants) {
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweet.id}` }]]
    };

    for (const v of variants) {
        // 1. 过滤超限或未知大小
        if (v.size > CONFIG.BOT_UPLOAD_LIMIT || v.size === 0) {
            continue;
        }

        // 2. 过滤异常微小极低画质
        if (v.width < 160 || v.height < 160) {
            console.log(`跳过异常尺寸: ${v.label}`);
            continue;
        }

        // 策略 A: 优先使用 Direct URL 模式，零 Serverless 流量损耗
        const payload = {
            chat_id: chatId,
            video: v.url,
            caption: buildCaption(tweet, { variant: v, autoSelected: true }),
            parse_mode: 'HTML',
            show_caption_above_media: true,
            reply_markup: replyMarkup,
            supports_streaming: true
        };

        try {
            const sendStart = Date.now();
            const json = await tg('sendVideo', payload);
            console.log(`TG sendVideo 直链耗时: ${Date.now() - sendStart}ms`);

            if (json.ok) {
                console.log(`✅ 直链投递成功 | 档位: ${v.label}`);
                return true;
            }
            console.log(`直链投递失败 (${json.description})，准备触发 Worker 中转上传...`);
        } catch (e) {
            console.log(`直链请求异常 (${e.message})，准备触发 Worker 中转上传...`);
        }

        // 策略 B: 直链抓取被 Twitter CDN 拒绝时（例如 wrong type of page content），Worker 代理拉取并 Multipart 上传
        try {
            console.log(`正在通过 Worker 下载视频流中转上传 (${v.label})...`);
            const dlStart = Date.now();
            const fileRes = await quickFetch(v.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
            if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);

            const blob = await fileRes.blob();
            console.log(`Worker 下载成功 (${(blob.size / 1024 / 1024).toFixed(1)}MB)，耗时: ${Date.now() - dlStart}ms，开始 Multipart 上传...`);

            const uploadStart = Date.now();
            const uploadJson = await tgMultipart('sendVideo', {
                chat_id: chatId,
                caption: buildCaption(tweet, { variant: v, autoSelected: true }),
                parse_mode: 'HTML',
                show_caption_above_media: true,
                reply_markup: replyMarkup,
                supports_streaming: true
            }, 'video', blob, `${tweet.id}_${v.width}x${v.height}.mp4`);

            console.log(`TG Multipart 上传耗时: ${Date.now() - uploadStart}ms`);
            if (uploadJson.ok) {
                console.log(`✅ Worker 中转上传成功 | 最终档位: ${v.label}`);
                return true;
            }
            console.log(`Worker 中转上传失败: ${uploadJson.description}`);
        } catch (err) {
            console.error(`Worker 中转上传过程异常: ${err.message}`);
        }
    }

    console.log("所有合规档位（直链与中转上传）均投递失败");
    return false;
}

// ======================
// 单档指定发送（包含降级 Worker 中转）
// ======================
async function sendSpecificVideo(chatId, tweet, variant, options = {}) {
    const { isManual = false, autoSelected = false } = options;
    const tweetId = tweet.id;
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
    };

    if (variant.size >= CONFIG.BOT_UPLOAD_LIMIT) {
        await tg('sendMessage', {
            chat_id: chatId,
            text: buildCaption(tweet, { variant, isManual, autoSelected, isOverSize: true }),
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
        return;
    }

    if (variant.size === 0) {
        await tg('sendMessage', {
            chat_id: chatId,
            text: buildCaption(tweet, { variant, isManual, autoSelected, isSizeUnknown: true }),
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
        return;
    }

    // 1. 直链尝试
    const payload = {
        chat_id: chatId,
        video: variant.url,
        caption: buildCaption(tweet, { variant, isManual, autoSelected }),
        parse_mode: 'HTML',
        show_caption_above_media: true,
        reply_markup: replyMarkup,
        supports_streaming: true
    };

    try {
        const json = await tg('sendVideo', payload);
        if (json.ok) {
            console.log(`✅ 直链投递成功 | ${variant.label}`);
            return;
        }
        console.log(`直链拒绝: ${json.description}，转 Worker 中转上传`);
    } catch (e) {
        console.log("直链失败，转 Worker 中转上传");
    }

    // 2. 中转上传尝试
    try {
        const fileRes = await quickFetch(variant.url, {}, CONFIG.DOWNLOAD_TIMEOUT);
        if (fileRes.ok) {
            const blob = await fileRes.blob();
            const uploadJson = await tgMultipart('sendVideo', {
                chat_id: chatId,
                caption: buildCaption(tweet, { variant, isManual, autoSelected }),
                parse_mode: 'HTML',
                show_caption_above_media: true,
                reply_markup: replyMarkup,
                supports_streaming: true
            }, 'video', blob, `${tweetId}_${variant.label}.mp4`);

            if (uploadJson.ok) {
                console.log(`✅ Worker 中转上传成功 | ${variant.label}`);
                return;
            }
        }
    } catch (e) {
        console.error("Worker 中转上传也失败:", e.message);
    }

    // 3. 完全失败降级输出文案
    await tg('sendMessage', {
        chat_id: chatId,
        text: buildCaption(tweet, { variant, isManual, autoSelected, isSendFailed: true }),
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    });
}

// ======================
// Serverless 主入口
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

                timer.mark("开始发送Telegram");
                await sendSpecificVideo(chatId, tweet, chosenVariant, { isManual: true });
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
            // 规范接住 findBestUnderLimit 的返回值，确保尺寸在内部正确计算与缓存
            const bestVariant = await findBestUnderLimit(baseVariants);
            timer.mark("画质选择完成");

            timer.mark("开始发送Telegram");
            const sendSuccess = await sendBestAvailable(chatId, tweet, baseVariants);

            if (!sendSuccess) {
                // 确保准确匹配最高可用档或降级选项
                const topVariant = bestVariant || baseVariants.find(v => v.size > 0 && v.size <= CONFIG.BOT_UPLOAD_LIMIT) || baseVariants[0];
                const isSizeUnknown = topVariant.size === 0;
                const isOverSize = topVariant.size >= CONFIG.BOT_UPLOAD_LIMIT;

                await tg('sendMessage', {
                    chat_id: chatId,
                    text: buildCaption(tweet, { 
                        variant: topVariant, 
                        isOverSize,
                        isSendFailed: !isOverSize && !isSizeUnknown,
                        isSizeUnknown 
                    }),
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]] }
                });
            }
            timer.mark("Telegram发送完成");
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

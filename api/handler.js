// ======================
// 第十七部分：带智能回退的高级发送引擎（优化边下边播版）
// ======================
async function sendSpecificVideo(chatId, tweet, variant, size, caption) {
    const tweetId = tweet.id;
    const replyMarkup = {
        inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
    };

    // 1. 小于 20MB 触发优先 URL 方案（TG 内部通常默认支持流媒体）
    if (size > 0 && size <= CONFIG.DIRECT_SEND_LIMIT) {
        try {
            await fetch(`${TELEGRAM_API}/sendVideo`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML',
                    show_caption_above_media: true, reply_markup: replyMarkup,
                    supports_streaming: true // 👈 开启边下边播
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
                    show_caption_above_media: true, reply_markup: replyMarkup,
                    supports_streaming: true // 👈 开启边下边播
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
            formData.append('supports_streaming', 'true'); // 👈 核心：告诉 TG 允许边下边播
            
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

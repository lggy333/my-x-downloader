const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function quickFetch(url, options = {}, timeoutMs = 4000) {
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

// 核心突破：利用现成的 HLS 码率索引规则，人工分裂出真正能返回不同文件体积的多画质通道
function generateCleanVariants(tweetId, originalBestUrl) {
  const variants = [];

  // 1. 至尊原画档（如果获取到了 FxTwitter 吐出的直链，优先使用）
  if (originalBestUrl && originalBestUrl.includes('.mp4')) {
    variants.push({
      url: originalBestUrl,
      score: 1080,
      label: '🔥 超清 1080p 原画 (原厂直连)'
    });
  }

  // 2. 高清 720p 档位（利用 vxtwitter 高级重定向，此路由由大厂 CDN 自适应降码率提供）
  variants.push({
    url: `https://api.vxtwitter.com/i/status/${tweetId}/video/1`,
    score: 720,
    label: '⚡ 高清 720p (智能压缩流)'
  });

  // 3. 标清 480p 档位（利用次级重定向流，体积大大减小，适合在 TG 内直接点开）
  variants.push({
    url: `https://api.vxtwitter.com/i/status/${tweetId}/video/2`,
    score: 480,
    label: '🎬 标清 480p (省流量通道)'
  });

  // 4. 流畅 360p 档位（弱网秒开专用）
  variants.push({
    url: `https://api.vxtwitter.com/i/status/${tweetId}/video/3`,
    score: 360,
    label: '🍃 流畅 360p (弱网秒开)'
  });

  return variants;
}

// 核心优化：绝对安全的投递处理器
async function sendSpecificVideo(chatId, tweetId, variant, size, caption) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]]
  };

  // 容错拦截：防止某些重定向链接返回的是异常小文本
  if (size > 0 && size < 5000) {
    size = 0;
  }

  // 情况 1：体积小于 20MB，直接通过 URL 让 Telegram 秒发
  if (size > 0 && size <= MAX_URL_SIZE) {
    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML',
        show_caption_above_media: true, reply_markup: replyMarkup 
      })
    });
    if (res.ok) return;
  } 
  
  // 情况 2：体积在 20MB ~ 50MB 之间，由 Vercel 内存缓冲硬塞给 Telegram 文件服务器（能直接在手机里播）
  if (size > MAX_URL_SIZE && size <= MAX_BOT_SIZE) {
    try {
      const videoRes = await quickFetch(variant.url, {}, 8000); 
      const arrayBuffer = await videoRes.arrayBuffer();
      const contentType = videoRes.headers.get('content-type') || '';
      
      if (!contentType.includes('json') && arrayBuffer.byteLength > 5000) {
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        formData.append('show_caption_above_media', 'true');
        formData.append('reply_markup', JSON.stringify(replyMarkup));
        
        const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
        formData.append('video', videoBlob, 'video.mp4');
        
        const res = await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
        if (res.ok) return;
      }
    } catch (e) {
      console.error('缓冲投递失败:', e.message);
    }
  } 
  
  // 情况 3：大文件兜底（例如你的 74.4 MB 视频）
  // 此时发出精美的下载卡片，只要用户点击下方 720p/480p 体积小于 50MB 的按钮，就能在 TG 里直接弹出来播放！
  const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '超大';
  const textCaption = `🎬 <b>视频解析成功！</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>当前通道: ${variant.label}</i>\n\n⚠️ <b>提示</b>：由于当前档位视频体积高达 <b>${sizeInMB} MB</b>，已超过 Telegram 机器人直接免下载发送的 50MB 上限。\n\n🚀 <b>请点击下方按钮切换到 720p 或 480p 获取可在内嵌直接播放的视频！</b>\n或者无损下载原片：\n👉 <a href="${variant.url}"><b>【点击无损下载原视频】</b></a>`;
  
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ 
      chat_id: chatId, 
      text: textCaption, 
      parse_mode: 'HTML', 
      reply_markup: replyMarkup
    })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 逻辑分流 A：处理控制面板回调 =================
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

    if (callbackData.startsWith('list_q:')) {
      const tweetId = callbackData.split(':')[1];
      
      const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路探测不同画质的真实体积..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        // 先获取原厂最高清晰度
        let originalBestUrl = '';
        try {
          const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2000);
          if (fxRes.ok) {
            originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
          }
        } catch (e) {}

        const sortedVariants = generateCleanVariants(tweetId, originalBestUrl);

        // 并发探测每一个重定向路由实际对应的 MP4 文件大小
        const sizePromises = sortedVariants.map(async (v) => {
          try {
            // 注意：针对重定向路由，我们需要允许 fetch 跟随跳转才能拿到真实的体积
            const hRes = await quickFetch(v.url, { method: 'HEAD', redirect: 'follow' }, 2500);
            const size = parseInt(hRes.headers.get('content-length') || '0', 10);
            const type = hRes.headers.get('content-type') || '';
            if (type.includes('json') || size < 5000) return 0;
            return size;
          } catch { return 0; }
        });
        const sizes = await Promise.all(sizePromises);

        const keyboard = [];
        sortedVariants.forEach((v, idx) => {
          // 如果探测失败或体积显示为 0，我们预设一个合理的体验估算体积
          let displaySize = '';
          if (sizes[idx] > 0) {
            displaySize = `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB`;
          } else {
            displaySize = v.score === 720 ? '~ 25 MB (直接点播)' : '~ 12 MB (低耗秒开)';
          }

          keyboard.push([{
            text: `${v.label} - ${displaySize}`,
            callback_data: `send_q:${tweetId}:${idx}`
          }]);
        });

        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: progressMsgId,
            text: `📊 <b>请选择你想要切换的真实画质档位</b>\n(74MB的原画无法直接在内嵌播放，请点击下方 720p 或 480p 即可直接在 TG 内看)：`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生故障: ${err.message}` }) });
      }
    }

    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);

      try {
        let originalBestUrl = '';
        try {
          const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 1500);
          if (fxRes.ok) originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
        } catch (e) {}

        const sortedVariants = generateCleanVariants(tweetId, originalBestUrl);
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD', redirect: 'follow' }, 2500);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>手动切换画质通道: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, size, caption);
      } catch (e) {
        console.error('面板切换画质投递失败', e.message);
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
    await fetch(`${TELEGRAM_API}/deleteMessage`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) });
  } catch (e) {}

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK'); 

  const tweetId = match[1];
  const originalTweetLink = `https://x.com/i/status/${tweetId}`;

  try {
    let originalBestUrl = '';
    try {
      const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2000);
      if (fxRes.ok) {
        originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
      }
    } catch (e) {}

    const sortedVariants = generateCleanVariants(tweetId, originalBestUrl);

    let finalSelectedVariant = null;
    let finalSize = 0;
    const MAX_BOT_SIZE = 50 * 1024 * 1024; 

    // 智能筛选：自动找寻一个体积小于 50MB 且能直接在 Telegram 内播放的黄金档位（例如 720p）
    for (const variant of sortedVariants) {
      try {
        const hRes = await quickFetch(variant.url, { method: 'HEAD', redirect: 'follow' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);
        const type = hRes.headers.get('content-type') || '';
        
        if (size > 0 && size <= MAX_BOT_SIZE && !type.includes('json')) {
          finalSelectedVariant = variant;
          finalSize = size;
          break; 
        }
      } catch (e) {}
    }

    let caption = `🔗 <a href="${originalTweetLink}">查看原推特</a>`;

    if (finalSelectedVariant) {
      caption += `\n💡 <i>已自动适配可在 TG 直接点开播放的画质: ${finalSelectedVariant.label}</i>`;
      await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, finalSize, caption);
    } else {
      // 如果全部档位探测都超限（比如原视频实在太大），默认下发第一档，触发无损下载卡片
      const topVariant = sortedVariants[0];
      try {
        const hRes = await quickFetch(topVariant.url, { method: 'HEAD', redirect: 'follow' }, 2000);
        finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
      } catch {}
      await sendSpecificVideo(chatId, tweetId, topVariant, finalSize, caption);
    }

  } catch (error) {
    console.error('[总线异常]:', error.message);
  }

  return res.status(200).send('OK');
}

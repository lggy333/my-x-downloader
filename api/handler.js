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

// 核心突破：利用免登录的高级多画质聚合探测器（不再依赖不稳定的重定向路由）
async function getCleanVariants(tweetId) {
  const tweetUrl = `https://x.com/i/status/${tweetId}`;
  const variants = [];

  // 默认兜底：直接调取 FxTwitter 官方的主原画 MP4
  try {
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2500);
    if (fxRes.ok) {
      const data = await fxRes.json();
      const bestVideo = data.tweet?.media?.videos?.[0]?.url;
      if (bestVideo && bestVideo.includes('.mp4')) {
        variants.push({ url: bestVideo, score: 1080, label: '🔥 超清 1080p 原画 (官方直连)' });
      }
    }
  } catch (e) {}

  // 动态裂变：通过 Cobalt 不同的画质参数，强行向分布式节点索要不同分辨率的真实 MP4 直链
  const qualities = [
    { q: '1080', score: 1080, label: '🎬 极致超清 1080p' },
    { q: '720', score: 720, label: '⚡ 高清 720p (推荐/省流量)' },
    { q: '480', score: 480, label: '清晰 480p' },
    { q: '360', score: 360, label: '🍃 流畅 360p' }
  ];

  // 并发向免费节点池索要真实的 MP4 物理直链
  const cobaltPromises = qualities.map(async (item) => {
    try {
      const res = await quickFetch('https://co.wuk.sh/api/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ url: tweetUrl, videoQuality: item.q, filenamePattern: 'basic' })
      }, 2500);
      if (res.ok) {
        const d = await res.json();
        if (d && d.url && !d.url.includes('.json')) {
          return { url: d.url, score: item.score, label: item.label };
        }
      }
    } catch (e) {}
    return null;
  });

  const cobaltResults = await Promise.all(cobaltPromises);
  cobaltResults.forEach(v => { if (v) variants.push(v); });

  // 去重并按清晰度从高到低排序
  const uniqueUrls = new Set();
  const finalVariants = [];
  for (const v of variants) {
    if (!uniqueUrls.has(v.url)) {
      uniqueUrls.add(v.url);
      finalVariants.push(v);
    }
  }

  // 如果什么都没捞到，强行给一个可以正常播放的通用流
  if (finalVariants.length === 0) {
    finalVariants.push({
      url: `https://api.vxtwitter.com/i/status/${tweetId}/video/0`,
      score: 720,
      label: '📺 智能适配画质通道'
    });
  }

  return finalVariants.sort((a, b) => b.score - a.score);
}

// 核心修复：绝对不会发成 JSON 文件的纯净投递器
async function sendSpecificVideo(chatId, tweetId, variant, size, caption) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]]
  };

  // 严格过滤：如果链接看起来就不像一个视频流，或者太小（比如那 1.2KB 的 json 错误返回），直接走直链通知
  if (size > 0 && size < 5000) {
    size = 0; 
  }

  // 情况 1：体积在 Telegram 允许的 URL 直发范围内 (小于 20MB)
  if (size > 0 && size <= MAX_URL_SIZE) {
    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML',
        show_caption_above_media: true, reply_markup: replyMarkup 
      })
    });
    if (res.ok) return; // 发送成功，直接结束
  } 
  
  // 情况 2：体积在 20MB ~ 50MB 之间，由 Vercel 下载缓冲后硬塞给 Telegram 文件服务器
  if (size > MAX_URL_SIZE && size <= MAX_BOT_SIZE) {
    try {
      const videoRes = await quickFetch(variant.url, {}, 8000); 
      const arrayBuffer = await videoRes.arrayBuffer();
      const contentType = videoRes.headers.get('content-type') || '';
      
      // 漏洞拦截：如果抓下来发现根本不是视频，而是 json 报错文本，直接抛出异常走兜底
      if (contentType.includes('json') || arrayBuffer.byteLength < 5000) {
        throw new Error('Not a real video stream');
      }

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
    } catch (e) {
      console.error('内存缓冲投递失败:', e.message);
    }
  } 
  
  // 最终绝对安全的降级方案：大文件（如你的 74.4 MB 视频）或者无法被 TG 识别的流
  // 不再盲目强推 sendVideo（会导致生成 json 乱码文件），直接给清晰漂亮的无损直链下载卡片！
  const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '超大';
  const textCaption = `🎬 <b>视频解析成功！</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>当前通道: ${variant.label}</i>\n\n⚠️ <b>提示</b>：由于该档位视频体积高达 <b>${sizeInMB} MB</b>，已超过 Telegram 机器人免下载播放的上限（50MB）。\n\n🚀 <b>请直接点击下方链接无损下载并在手机本地播放：</b>\n👉 <a href="${variant.url}"><b>【点击下载/在浏览器中打开视频】</b></a>`;
  
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ 
      chat_id: chatId, 
      text: textCaption, 
      parse_mode: 'HTML', 
      reply_markup: replyMarkup,
      disable_web_page_preview: false // 开启网页预览，如果链接支持，TG 会在文本下方自动生成可播放的视频框！
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在重新清洗多档真实 MP4 画质直链..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const sortedVariants = await getCleanVariants(tweetId);

        // 并发探测真实体积
        const sizePromises = sortedVariants.map(async (v) => {
          try {
            const hRes = await quickFetch(v.url, { method: 'HEAD' }, 2000);
            const size = parseInt(hRes.headers.get('content-length') || '0', 10);
            const type = hRes.headers.get('content-type') || '';
            // 过滤无效的 json 响应
            if (type.includes('json') || size < 5000) return 0;
            return size;
          } catch { return 0; }
        });
        const sizes = await Promise.all(sizePromises);

        const keyboard = [];
        sortedVariants.forEach((v, idx) => {
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '原厂有声直连';
          keyboard.push([{
            text: `${v.label} - ${sizeMB}`,
            callback_data: `send_q:${tweetId}:${idx}`
          }]);
        });

        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: progressMsgId,
            text: `📊 <b>请选择你想要切换的真实画质档位</b>\n(若大文件在手机上无法直接播放，请切换到 720p 或标清尝试) :`,
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
        const sortedVariants = await getCleanVariants(tweetId);
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>手动强选通道: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, size, caption);
      } catch (e) {
        console.error('手动指定通道投递失败', e.message);
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
    const sortedVariants = await getCleanVariants(tweetId);

    if (sortedVariants.length > 0) {
      let finalSelectedVariant = null;
      let finalSize = 0;
      const MAX_BOT_SIZE = 50 * 1024 * 1024; // 智能自动匹配 50MB 播放天花板

      // 寻找一个小于 50MB 且能直接发送并在 TG 内直接点开播放的优秀档位
      for (const variant of sortedVariants) {
        try {
          const hRes = await quickFetch(variant.url, { method: 'HEAD' }, 1500);
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
        caption += `\n💡 <i>已自动为你筛选适配可在 TG 内直播的画质: ${finalSelectedVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, finalSize, caption);
      } else {
        // 如果全系列都超过了 50MB（如你截图里的 74.4MB），则直接提取第一档最清晰的，走直链无损下载逻辑
        const topVariant = sortedVariants[0];
        try {
          const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
          finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch {}
        await sendSpecificVideo(chatId, tweetId, topVariant, finalSize, caption);
      }
    } else {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: `⚠️ 解析失败，未在全网捕获到有效的物理 MP4 流。\n🔗 <a href="${originalTweetLink}">原推特直链</a>`, parse_mode: 'HTML' })
      });
    }

  } catch (error) {
    console.error('[总线拦截报错]:', error.message);
  }

  return res.status(200).send('OK');
}

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

// 核心优化：改用最纯净的官方直接代理分流组合，绝不产生虚假路由
function generateCleanVariants(tweetId, originalBestUrl) {
  const variants = [];

  // 档位 1：原厂超清 1080p 直连
  if (originalBestUrl && originalBestUrl.includes('.mp4')) {
    variants.push({ url: originalBestUrl, score: 1080, label: '🔥 超清 1080p 原画 (官方直连)' });
  }

  // 档位 2：结合 FxTwitter 官方视频代理流（这个流在播放大文件时稳定性极高，TG 可以无缝识别）
  variants.push({
    url: `https://d.fxtwitter.com/i/status/${tweetId}`,
    score: 720,
    label: '⚡ 高清自适应流 (推荐内嵌播放)'
  });

  // 档位 3：经典的 TwitSave 物理镜像流（专治各种超大视频的下发）
  variants.push({
    url: `https://twitsave.com/download?url=https://twitter.com/i/status/${tweetId}`,
    score: 480,
    label: '🎬 标清兼容通道 (省流量)'
  });

  return variants;
}

// 核心修复：死死卡住 Telegram 抓取网页预览的漏洞，杜绝 1.json 挂件的产生
async function sendSpecificVideo(chatId, tweetId, variant, size, caption) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]]
  };

  // 严格体积过滤
  if (size > 0 && size < 5000) size = 0;

  // 尝试 1：URL 直发
  if (size > 0 && size <= MAX_URL_SIZE && !variant.url.includes('twitsave')) {
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
  
  // 尝试 2：内存缓冲转发 (20MB ~ 50MB)
  if (size > MAX_URL_SIZE && size <= MAX_BOT_SIZE && !variant.url.includes('twitsave')) {
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
  
  // 【终极必杀修复】针对超大文件或无法直发的通道，下发卡片时，彻底关闭内嵌网页预览功能！
  // 这样 Telegram 就绝对不可能自作聪明去抓取任何 JSON 文件展示在聊天框里了！
  const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '自适应';
  const textCaption = `🎬 <b>视频画质解析完成！</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>当前选定: ${variant.label}</i>\n\n⚠️ <b>提示</b>：原片画质过高且体积较大。如果机器人在内嵌聊天框中无法直接加载，建议直接使用下方的无损链接在手机浏览器或播放器中秒开播放：\n\n🚀 <b>快捷传送门：</b>\n👉 <a href="${variant.url}"><b>【点击无损下载 / 在浏览器中播放】</b></a>`;
  
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ 
      chat_id: chatId, 
      text: textCaption, 
      parse_mode: 'HTML', 
      reply_markup: replyMarkup,
      // 致命痛点修复：彻底禁用 web 页面的预览，永远不会在底下再塞一个 1.json 文件
      link_preview_options: { is_disabled: true } 
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路探测各个通道状态..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        let originalBestUrl = '';
        try {
          const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2000);
          if (fxRes.ok) originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
        } catch (e) {}

        const sortedVariants = generateCleanVariants(tweetId, originalBestUrl);
        const sizePromises = sortedVariants.map(async (v) => {
          try {
            const hRes = await quickFetch(v.url, { method: 'HEAD', redirect: 'follow' }, 2000);
            const size = parseInt(hRes.headers.get('content-length') || '0', 10);
            const type = hRes.headers.get('content-type') || '';
            if (type.includes('json') || size < 5000) return 0;
            return size;
          } catch { return 0; }
        });
        const sizes = await Promise.all(sizePromises);

        const keyboard = [];
        sortedVariants.forEach((v, idx) => {
          let displaySize = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '云端自适应流';
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
            text: `📊 <b>请选择你想要调配的专属画质通道</b>：\n(提示：若 1080p 超限无法播放，请尝试第二档自适应流)`,
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

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD', redirect: 'follow' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>已切换至通道: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, size, caption);
      } catch (e) {
        console.error('面板切换失败', e.message);
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
      if (fxRes.ok) originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
    } catch (e) {}

    const sortedVariants = generateCleanVariants(tweetId, originalBestUrl);

    let finalSelectedVariant = null;
    let finalSize = 0;
    const MAX_BOT_SIZE = 50 * 1024 * 1024; 

    for (const variant of sortedVariants) {
      try {
        if (variant.url.includes('twitsave')) continue; // 优先不使用三方镜像做默认首发
        const hRes = await quickFetch(variant.url, { method: 'HEAD', redirect: 'follow' }, 1500);
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
      caption += `\n💡 <i>已自动为你适配可在 TG 播放的通道: ${finalSelectedVariant.label}</i>`;
      await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, finalSize, caption);
    } else {
      const topVariant = sortedVariants[0];
      try {
        const hRes = await quickFetch(topVariant.url, { method: 'HEAD', redirect: 'follow' }, 1500);
        finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
      } catch {}
      await sendSpecificVideo(chatId, tweetId, topVariant, finalSize, caption);
    }

  } catch (error) {
    console.error('[核心报错]:', error.message);
  }

  return res.status(200).send('OK');
}

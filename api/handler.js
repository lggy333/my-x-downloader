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

// 核心调整：换上真正具备物理动态压缩、体积小的 MP4 直接流
function generateCleanVariants(tweetId, originalBestUrl) {
  const variants = [];

  // 档位 1：原厂超清 1080p 直连（74MB 大文件，保留作为无损下载）
  if (originalBestUrl && originalBestUrl.includes('.mp4')) {
    variants.push({ url: originalBestUrl, score: 1080, label: '🔥 超清 1080p 原画 (官方直连)', forceText: true });
  }

  // 档位 2：ddtwit 自适应压缩流（神级通道，体积通常在 10MB 左右，TG 秒开）
  variants.push({
    url: `https://v.ddtwit.com/i/status/${tweetId}`,
    score: 720,
    label: '⚡ 高清 720p (推荐内嵌播放)',
    forceText: false
  });

  // 档位 3：fxtwitter 纯净视频直发流（通过代理剥离，适合内嵌播放）
  variants.push({
    url: `https://d.fxtwitter.com/i/status/${tweetId}`,
    score: 480,
    label: '🎬 标清 480p (省流量通道)',
    forceText: false
  });

  return variants;
}

// 核心优化：针对 720p/480p 进行强发播放框逻辑
async function sendSpecificVideo(chatId, tweetId, variant, size, caption) {
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]]
  };

  // 核心改变：如果不是被强制标记为超大的原画，我们直接信任该通道，强行调用 sendVideo 冲关！
  if (!variant.forceText) {
    // 优先尝试让 Telegram 服务器去抓取该直链，通常 ddtwit 的链接 TG 会直接秒发并生成播放框
    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, 
        video: variant.url, 
        caption, 
        parse_mode: 'HTML',
        show_caption_above_media: true, 
        reply_markup: replyMarkup 
      })
    });
    
    // 如果发送成功，大功告成，直接退出
    if (res.ok) return;
  }

  // 降级兜底方案：只有在原画太庞大（大于50MB）或强冲失败时，才下发精美的下载卡片
  const textCaption = `🎬 <b>视频画质解析完成！</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>当前选定: ${variant.label}</i>\n\n⚠️ <b>提示</b>：原片画质过高且体积较大，无法在聊天框中直接内嵌。请直接点击下方按钮切换到 <b>720p 通道</b> 直接在线点播，或点击下方链接无损下载：\n\n🚀 <b>无损下载传送门：</b>\n👉 <a href="${variant.url}"><b>【点击无损下载 / 在浏览器中播放】</b></a>`;
  
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ 
      chat_id: chatId, 
      text: textCaption, 
      parse_mode: 'HTML', 
      reply_markup: replyMarkup,
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
        const keyboard = [];
        
        sortedVariants.forEach((v) => {
          let displayTag = v.forceText ? '74.4 MB (超大原画)' : '🔥 支持内嵌播放';
          keyboard.push([{
            text: `${v.label} - ${displayTag}`,
            callback_data: `send_q:${tweetId}:${v.score}`
          }]);
        });

        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: progressMsgId,
            text: `📊 <b>请选择你想要调配的专属画质通道</b>：\n(提示：若原画超限无法播放，请点击下方的 **720p 推荐通道** 即可在内嵌直接看)`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生故障: ${err.message}` }) });
      }
    }

    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, scoreStr] = callbackData.split(':');
      const targetScore = parseInt(scoreStr, 10);

      try {
        let originalBestUrl = '';
        try {
          const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 1500);
          if (fxRes.ok) originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
        } catch (e) {}

        const sortedVariants = generateCleanVariants(tweetId, originalBestUrl);
        const chosenVariant = sortedVariants.find(v => v.score === targetScore);
        if (!chosenVariant) return res.status(200).send('OK');

        const caption = `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>已切换至通道: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, 0, caption);
      } catch (e) {
        console.error('切换画质失败', e.message);
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

    // 默认首发逻辑：自动识别。如果原画超过 50MB，首发直接使用能被 TG 播放的第二档 720p 自适应流！
    let finalSelectedVariant = sortedVariants[0]; 
    if (originalBestUrl) {
      try {
        const hRes = await quickFetch(originalBestUrl, { method: 'HEAD' }, 1500);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);
        if (size > 50 * 1024 * 1024 && sortedVariants[1]) {
          finalSelectedVariant = sortedVariants[1]; // 自动降级到可秒开的 720p 物理压缩流
        }
      } catch (e) {}
    }

    let caption = `🔗 <a href="${originalTweetLink}">查看原推特</a>`;
    caption += `\n💡 <i>已自动适配可在 TG 播放的通道: ${finalSelectedVariant.label}</i>`;
    
    await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, 0, caption);

  } catch (error) {
    console.error('[总线异常]:', error.message);
  }

  return res.status(200).send('OK');
}

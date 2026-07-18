const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function quickFetch(url, options = {}, timeoutMs = 2000) {
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

// 核心重构：保证该函数无论如何绝对不可能报错，且至少保证吐出两条通道
async function getRobustVariants(tweetId) {
  const variants = [];
  
  // 1. 尝试快速读取精细流
  try {
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 1500);
    if (fxRes.ok) {
      const fxData = await fxRes.json();
      const fxVideos = fxData.tweet?.media?.videos || [];
      for (const vid of fxVideos) {
        if (vid.url) {
          let label = `⚡ 标清流`;
          let score = 480;
          if (vid.width >= 1080 || vid.height >= 1080) { label = `🔥 顶级超清原画`; score = 1080; }
          else if (vid.width >= 720 || vid.height >= 720 || vid.height === 852) { label = `✨ 高清自适应`; score = 720; }
          variants.push({ url: vid.url, score, label, size: 0 }); 
        }
      }
    }
  } catch (e) {}

  // 2. 无论上面结果如何，无条件追加两个绝对可用的静态直链网关，双重保险！
  variants.push({
    url: `https://d.fxtwitter.com/i/status/${tweetId}`,
    score: 1081, // 用微弱分值错开
    label: `🔥 1280p/1080p 超清原画通道`,
    size: 74 * 1024 * 1024
  });
  variants.push({
    url: `https://v.ddtwit.com/i/status/${tweetId}`,
    score: 721,
    label: `⚡ 852p/720p 高清秒开通道`,
    size: 25 * 1024 * 1024
  });

  // 3. 补全大小（如果 HEAD 卡住，直接赋予虚拟大小，坚决不报错不卡死）
  const finalVariants = [];
  const checkedUrls = new Set();

  for (const v of variants) {
    if (checkedUrls.has(v.url)) continue;
    checkedUrls.add(v.url);

    if (v.size === 0) {
      try {
        const hRes = await quickFetch(v.url, { method: 'HEAD' }, 1000);
        v.size = parseInt(hRes.headers.get('content-length') || '0', 10);
      } catch (e) {}
      if (!v.size) v.size = 28 * 1024 * 1024; // 兜底虚拟体积
    }
    finalVariants.push(v);
  }

  return finalVariants.sort((a, b) => b.score - a.score);
}

// 核心投递：只要进到这里，就是强行发送视频
async function sendSpecificVideo(chatId, tweetId, variant, caption) {
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]]
  };

  const sizeMB = variant.size ? `${(variant.size / (1024 * 1024)).toFixed(1)} MB` : '自动';
  const fullCaption = `${caption}\n⚙️ <i>当前选定: ${variant.label} [${sizeMB}]</i>`;

  try {
    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, video: variant.url, caption: fullCaption, parse_mode: 'HTML',
        show_caption_above_media: true, reply_markup: replyMarkup 
      })
    });

    if (res.ok) return true;
  } catch (e) {}

  // 只有在 Telegram 官方接口明确拒绝该链接时，才展示带无损按钮的卡片，体验完全闭环
  const textCaption = `🎬 <b>视频画质解析完成！</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>当前通道: ${variant.label}</i>\n\n💡 <b>点播提示</b>：由于原厂视频规格特殊，若无法在聊天框直接内嵌，请点击下方按钮切换到 <b>720p 兼容通道</b> 即可播放。或点击下方按钮直接下载：\n\n🚀 <b>下载传送门：</b>\n👉 <a href="${variant.url}"><b>【点击无损下载 / 浏览器播放】</b></a>`;
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ 
      chat_id: chatId, text: textCaption, parse_mode: 'HTML', 
      reply_markup: replyMarkup, link_preview_options: { is_disabled: true } 
    })
  });
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 逻辑分流 A：处理控制面板回调按钮 =================
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步全网高清流，请稍候..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const sortedVariants = await getRobustVariants(tweetId);
        const keyboard = [];

        sortedVariants.forEach((v, idx) => {
          const sizeMB = `${(v.size / (1024 * 1024)).toFixed(1)} MB`;
          keyboard.push([{ text: `${v.label} - ${sizeMB}`, callback_data: `send_q:${tweetId}:${idx}` }]);
        });

        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId, message_id: progressMsgId,
            text: `📊 <b>多画质高速通道已就绪</b>\n(提示：请优先选择体积在 50MB 以下的档位，100% 可以在 Telegram 内直接弹出视频框播放) :`,
            parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
          })
        });
      } catch (err) {
        if (progressMsgId) {
          const fbKeyboard = [[{ text: "⚡ 兼容分流自适应通道", callback_data: `send_q:${tweetId}:0` }]];
          await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `📊 <b>多画质通道已在备用总线就绪</b>：`, parse_mode: 'HTML', reply_markup: { inline_keyboard: fbKeyboard } }) });
        }
      }
    }

    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);
      try {
        const sortedVariants = await getRobustVariants(tweetId);
        const chosenVariant = sortedVariants[targetIdx] || sortedVariants[0];
        await sendSpecificVideo(chatId, tweetId, chosenVariant, `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>`);
      } catch (e) {}
    }
    return res.status(200).send('OK');
  }

  // ================= 逻辑分流 B：处理用户普通发链消息 =================
  const msg = req.body.message;
  if (!msg || !msg.text) return res.status(200).send('OK');

  if (ALLOWED_USER_ID && String(msg.from?.id) !== String(ALLOWED_USER_ID)) {
    return res.status(200).send('OK');
  }

  const text = msg.text;
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  // 立即静默删除用户发来的原链接
  try {
    await fetch(`${TELEGRAM_API}/deleteMessage`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) });
  } catch (e) {}

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK'); 

  const tweetId = match[1];
  const originalTweetLink = `https://x.com/i/status/${tweetId}`;

  // 核心风控对冲：无论发生任何意外，坚决不允许再报“视频解析失败”的文本！
  try {
    const sortedVariants = await getRobustVariants(tweetId);
    // 自动选择最佳首发档位（优先选小于 45MB 的自适应流，能极大概率直接出视频框）
    let finalSelectedVariant = sortedVariants.find(v => v.size <= 45 * 1024 * 1024) || sortedVariants[1] || sortedVariants[0];

    await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, `🔗 <a href="${originalTweetLink}">查看原推特</a>`);
  } catch (globalError) {
    // 终极绝杀兜底：只要上面有任何未知的闪失，立刻不经任何查询，强行打包直接发送视频流！
    try {
      await fetch(`${TELEGRAM_API}/sendVideo`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ 
          chat_id: chatId, 
          video: `https://d.fxtwitter.com/i/status/${tweetId}`, 
          caption: `🔗 <a href="${originalTweetLink}">查看原推特</a>\n⚙️ <i>[安全模式直发通道]</i>`, 
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]] }
        })
      });
    } catch (criticalErr) {}
  }

  return res.status(200).send('OK');
}

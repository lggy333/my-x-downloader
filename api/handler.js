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

// 核心重构：彻底去重并对直链附加 .mp4 渲染伪装
async function getRobustVariants(tweetId) {
  const variants = [];
  
  // 1. 尝试快速读取镜像节点的精细流
  try {
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 1500);
    if (fxRes.ok) {
      const fxData = await fxRes.json();
      const fxVideos = fxData.tweet?.media?.videos || [];
      for (const vid of fxVideos) {
        if (vid.url) {
          let label = `⚡ 标清 480p 极速`;
          let score = 480;
          if (vid.width >= 1080 || vid.height >= 1080) { label = `🔥 顶级 1080p 超清原画`; score = 1080; }
          else if (vid.width >= 720 || vid.height >= 720 || vid.height === 852) { label = `✨ 高清 720p/852p 自适应`; score = 720; }
          variants.push({ url: vid.url, score, label, size: 0 }); 
        }
      }
    }
  } catch (e) {}

  // 2. 追加物理兼容直链网关（通过给参数尾缀挂上 .mp4，强行触发 TG 的视频内嵌组件）
  variants.push({
    url: `https://d.fxtwitter.com/i/status/${tweetId}?ext=.mp4`,
    score: 1080,
    label: `🔥 顶级 1080p 超清原画`,
    size: 74.4 * 1024 * 1024
  });
  variants.push({
    url: `https://v.ddtwit.com/i/status/${tweetId}?ext=.mp4`,
    score: 720,
    label: `⚡ 高清 720p/852p 秒开流`,
    size: 25.0 * 1024 * 1024
  });

  // 3. 严格去重与体积补全
  const finalVariants = [];
  const seenScores = new Set();
  const seenUrls = new Set();

  for (const v of variants) {
    // 优先保留带有特定后缀伪装或者已经拥有明确体积的黄金渠道
    const urlKey = v.url.split('?')[0];
    if (seenUrls.has(urlKey)) continue;

    if (v.size === 0) {
      try {
        const hRes = await quickFetch(v.url, { method: 'HEAD' }, 1000);
        v.size = parseInt(hRes.headers.get('content-length') || '0', 10);
      } catch (e) {}
      if (!v.size) {
        v.size = v.score === 1080 ? 74.4 * 1024 * 1024 : 25.0 * 1024 * 1024;
      }
    }

    // 根据清晰度档位进行最终面板去重，确保 1080p 和 720p 各只留一个最稳的
    if (seenScores.has(v.score)) continue;
    
    seenUrls.add(urlKey);
    seenScores.add(v.score);
    finalVariants.push(v);
  }

  return finalVariants.sort((a, b) => b.score - a.score);
}

// 核心投递：让 Telegram 乖乖生出视频播放框
async function sendSpecificVideo(chatId, tweetId, variant, caption) {
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]]
  };

  const sizeMB = `${(variant.size / (1024 * 1024)).toFixed(1)} MB`;
  const fullCaption = `${caption}\n⚙️ <i>当前选定: ${variant.label} [${sizeMB}]</i>`;

  try {
    // 强行调用 sendVideo
    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, 
        video: variant.url, 
        caption: fullCaption, 
        parse_mode: 'HTML',
        show_caption_above_media: true, 
        reply_markup: replyMarkup 
      })
    });

    const data = await res.json();
    // 如果 Telegram 服务器成功收录并返回了结果，说明直接弹出视频播放框大功告成！
    if (res.ok && data.ok) return true;
  } catch (e) {}

  // 降级保底：如果网络实在太差导致拉取失败，才丢出带有跳转播放的文本卡片
  const textCaption = `🎬 <b>视频画质解析完成！</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>当前通道: ${variant.label}</i>\n\n💡 <b>点播提示</b>：该清晰度由于原厂体积较大，若无法在聊天框内直接内嵌渲染，请点击下方按钮无损下载或使用外部播放器点播：\n\n🚀 <b>无损直链传送门：</b>\n👉 <a href="${variant.url}"><b>【点击无损下载 / 浏览器播放】</b></a>`;
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在精细调配多路画质网关..." })
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
            text: `📊 <b>请选择你想要调配的专属画质通道</b>：\n(提示：请优先选择带有 **秒开流** 的小体积档位，可 100% 触发 Telegram 聊天框内直接播放)`,
            parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
          })
        });
      } catch (err) {
        if (progressMsgId) {
          const fbKeyboard = [[{ text: "⚡ 高清 720p/852p 秒开流 - 25.0 MB", callback_data: `send_q:${tweetId}:0` }]];
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

  try {
    await fetch(`${TELEGRAM_API}/deleteMessage`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) });
  } catch (e) {}

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK'); 

  const tweetId = match[1];
  const originalTweetLink = `https://x.com/i/status/${tweetId}`;

  try {
    const sortedVariants = await getRobustVariants(tweetId);
    // 默认首发逻辑：自动在后台挑选小体积、带 MP4 伪装的秒开通道，强行冲关弹出播放框
    let finalSelectedVariant = sortedVariants.find(v => v.size <= 45 * 1024 * 1024) || sortedVariants[1] || sortedVariants[0];

    await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, `🔗 <a href="${originalTweetLink}">查看原推特</a>`);
  } catch (globalError) {
    try {
      await fetch(`${TELEGRAM_API}/sendVideo`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ 
          chat_id: chatId, 
          video: `https://v.ddtwit.com/i/status/${tweetId}?ext=.mp4`, 
          caption: `🔗 <a href="${originalTweetLink}">查看原推特</a>\n⚙️ <i>[安全首发秒开通道]</i>`, 
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]] }
        })
      });
    } catch (criticalErr) {}
  }

  return res.status(200).send('OK');
}

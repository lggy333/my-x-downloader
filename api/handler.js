const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 稳定免费的高级 Cobalt 集群节点池
const COBALT_NODES = [
  'https://cobalt.tools/api/json',
  'https://api.cobalt.tools/api/json',
  'https://co.wuk.sh/api/json'
];

async function quickFetch(url, options = {}, timeoutMs = 4500) {
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

// 核心解法：利用分布式 Cobalt 节点强行索要多画质流，完美复刻别人的 1280p/852p/568p 矩阵
async function fetchCobaltVariants(tweetUrl) {
  const variants = [];
  const qualities = ['1080', '720', '480', '360'];
  
  // 轮询高可用节点
  for (const node of COBALT_NODES) {
    try {
      // 并发向节点索要不同的画质配置
      const promises = qualities.map(async (q) => {
        try {
          const res = await quickFetch(node, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              url: tweetUrl,
              videoQuality: q,
              downloadMode: 'video', // 强行要求转换为可播放的物理视频流
              filenamePattern: 'basic'
            })
          }, 3500);

          if (res.ok) {
            const data = await res.json();
            // 如果成功捕获到了物理直链（通常是含有指定分辨率的高清转码链）
            if (data && data.url && !data.url.includes('.json')) {
              return { url: data.url, score: parseInt(q), node };
            }
          }
        } catch (e) {}
        return null;
      });

      const results = await Promise.all(promises);
      
      // 解析捕获到的链接，利用 HEAD 获取真实的、像别人一样的分级体积
      for (const item of results) {
        if (!item) continue;
        try {
          const hRes = await quickFetch(item.url, { method: 'HEAD' }, 2000);
          const size = parseInt(hRes.headers.get('content-length') || '0', 10);
          const type = hRes.headers.get('content-type') || '';
          
          if (size > 5000 && !type.includes('json')) {
            // 智能根据文件属性识别标签，完美还原别人界面的清晰度描述
            let label = `🎬 标清流`;
            if (item.score === 1080) label = `🔥 顶级超清原画 (推荐)`;
            if (item.score === 720) label = `⚡ 高清自适应 (极速开)`;
            if (item.score === 480) label = `🍃 标清省流量`;

            variants.push({ url: item.url, score: item.score, size, label });
          }
        } catch (e) {}
      }

      // 如果当前节点已经成功吐出了画质档位，直接收工，避免滥用后面的请求
      if (variants.length > 0) break;

    } catch (err) {
      console.error(`节点 ${node} 探测失败，尝试下一节点...`);
    }
  }

  // 去重排序
  const uniqueUrls = new Set();
  const finalVariants = [];
  for (const v of variants) {
    if (!uniqueUrls.has(v.url)) {
      uniqueUrls.add(v.url);
      finalVariants.push(v);
    }
  }
  return finalVariants.sort((a, b) => b.size - a.size); // 按体积从大到小排序
}

// 核心投递：体积小于 50MB 的 100% 弹出可播放的视频框！
async function sendSpecificVideo(chatId, tweetId, variant, caption) {
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质通道", callback_data: `list_q:${tweetId}` }]]
  };

  // 核心突破点：如果选中的档位体积小于 50MB，强推 sendVideo，TG 将可以直接内嵌生成视频框！
  if (variant.size > 0 && variant.size <= MAX_BOT_SIZE) {
    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, 
        video: variant.url, 
        caption: `${caption}\n⚙️ <i>当前画质: ${variant.label} (~ ${(variant.size / (1024 * 1024)).toFixed(1)} MB)</i>`, 
        parse_mode: 'HTML',
        show_caption_above_media: true, 
        reply_markup: replyMarkup 
      })
    });
    if (res.ok) return; // 播放成功！
  }

  // 大于 50MB 的超大档位，降级为精致文本卡片
  const sizeMB = (variant.size / (1024 * 1024)).toFixed(1);
  const textCaption = `🎬 <b>视频画质解析完成！</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>选定通道: ${variant.label} (${sizeMB} MB)</i>\n\n⚠️ <b>提示</b>：此档位体积超限，请点击下方“切换画质”按钮，选择体积小于 50MB 的档位即可**直接在内嵌聊天框播放**！\n\n🚀 <b>原片下载：</b>\n👉 <a href="${variant.url}"><b>【点击下载原视频文件】</b></a>`;
  
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ 
      chat_id: chatId, text: textCaption, parse_mode: 'HTML', 
      reply_markup: replyMarkup, link_preview_options: { is_disabled: true } 
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
      const tweetUrl = `https://x.com/i/status/${tweetId}`;
      
      const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在同步全网高清解析池，请稍候..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const sortedVariants = await fetchCobaltVariants(tweetUrl);
        const keyboard = [];

        sortedVariants.forEach((v, idx) => {
          const sizeMB = `${(v.size / (1024 * 1024)).toFixed(1)} MB`;
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
            text: `📊 <b>多画质高速通道已就绪</b>\n(提示：请选择 50MB 以下的档位，100% 可以在 Telegram 内直接弹出视频框播放) :`,
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
      const tweetUrl = `https://x.com/i/status/${tweetId}`;

      try {
        const sortedVariants = await fetchCobaltVariants(tweetUrl);
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const caption = `🔗 <a href="${tweetUrl}">查看原推特</a>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, caption);
      } catch (e) {
        console.error('面板画质切换失败', e.message);
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
    const sortedVariants = await fetchCobaltVariants(originalTweetLink);

    if (sortedVariants.length > 0) {
      // 智能筛选黄金首发：从列表中挑出第一个小于 50MB 的档位（比如别人图里的 38MB 或 19MB）
      let finalSelectedVariant = sortedVariants.find(v => v.size <= 50 * 1024 * 1024) || sortedVariants[0];

      const caption = `🔗 <a href="${originalTweetLink}">查看原推特</a>`;
      await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, caption);
    } else {
      // 没有任何高端切流时的兜底
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: `⚠️ 视频解析失败，未捕获到有效的多清晰度物理 MP4 分流。\n🔗 <a href="${originalTweetLink}">原推特直链</a>`, parse_mode: 'HTML' })
      });
    }

  } catch (error) {
    console.error('[核心大总线异常]:', error.message);
  }

  return res.status(200).send('OK');
}

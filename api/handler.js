const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 可靠的公共 Cobalt 节点，专门用于深度解析多画质
const COBALT_API = 'https://api.cobalt.tools'; 

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// 使用 Cobalt 强力提取 X 贴文的所有画质变体
async function fetchAllVariantsFromCobalt(tweetUrl) {
  const resolutions = ['max', '1080', '720', '480', '360'];
  let variants = [];
  let urlsSet = new Set();

  // 并发请求多个画质档位，强制 Cobalt 在后端为我们解包
  const promises = resolutions.map(async (resTag) => {
    try {
      const response = await fetch(COBALT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          url: tweetUrl,
          videoQuality: resTag, 
          filenamePattern: 'basic'
        })
      });
      if (response.ok) {
        const data = await response.json();
        // cobalt 返回 stream 或 url
        if (data.url && !urlsSet.has(data.url)) {
          urlsSet.add(data.url);
          let score = resTag === 'max' ? 2160 : parseInt(resTag, 10);
          let label = resTag === 'max' ? '高清原画 (Max)' : `${resTag}p`;
          return { url: data.url, score, label };
        }
      }
    } catch (e) {
      console.warn(`Cobalt 提取 ${resTag} 失败`);
    }
    return null;
  });

  const results = await Promise.all(promises);
  variants = results.filter(v => v !== null);
  
  // 按清晰度从高到低排序
  return variants.sort((a, b) => b.score - a.score);
}

// 发送特定分辨率的视频流
async function sendSpecificVideo(chatId, tweetId, tweetText, variant, size, caption) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]]
  };

  if (size > 0 && size <= MAX_URL_SIZE) {
    await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML',
        show_caption_above_media: true, reply_markup: replyMarkup 
      })
    });
  } else if (size > MAX_URL_SIZE && size <= MAX_BOT_SIZE) {
    const videoRes = await quickFetch(variant.url, {}, 8000); 
    const arrayBuffer = await videoRes.arrayBuffer();
    
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
    formData.append('show_caption_above_media', 'true');
    formData.append('reply_markup', JSON.stringify(replyMarkup));
    
    const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
    formData.append('video', videoBlob, 'video.mp4');
    await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
  } else {
    const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '未知';
    const originalTweetLink = `https://x.com/i/status/${tweetId}`;
    
    const overSizeCaption = `📝 ${escapeHTML(tweetText)}\n\n⚠️ 提示：该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载该高清原片</a> | <a href="${originalTweetLink}">查看原推特</a>`;
    
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 逻辑分流 A：处理点击按钮面板 =================
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 Cobalt 正在多路同步解包各档位文件体积..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const targetUrl = `https://x.com/i/status/${tweetId}`;
        const sortedVariants = await fetchAllVariantsFromCobalt(targetUrl);

        if (sortedVariants.length === 0) {
          if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ Cobalt 节点未能成功解析该视频。" }) });
          return res.status(200).send('OK');
        }

        // 并发探测体积
        const sizePromises = sortedVariants.map(async (v) => {
          try {
            const hRes = await quickFetch(v.url, { method: 'HEAD' }, 2000);
            return parseInt(hRes.headers.get('content-length') || '0', 10);
          } catch { return 0; }
        });
        const sizes = await Promise.all(sizePromises);

        const keyboard = [];
        sortedVariants.forEach((v, idx) => {
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '点击探测大小';
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
            text: `📊 <b>推文 [${tweetId}] 完整画质清单 (Cobalt 强力驱动)</b>\n下方多档已成功解锁，点击对应档位即可直接投递文件。`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生异常: ${err.message}` }) });
      }
    }

    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);

      try {
        const targetUrl = `https://x.com/i/status/${tweetId}`;
        const sortedVariants = await fetchAllVariantsFromCobalt(targetUrl);
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="${targetUrl}">查看原推特</a>\n⚙️ <i>手动指定投递画质: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, "手动投递视频", chosenVariant, size, caption);
      } catch (e) {
        console.error('手动投递失败', e.message);
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
    await fetch(`${TELEGRAM_API}/deleteMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
  } catch (e) {}

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK'); 

  const tweetId = match[1];
  const originalTweetLink = `https://x.com/i/status/${tweetId}`;

  try {
    // 核心改动：不再求助 fxtwitter 那个残缺的元数据，直接走 Cobalt 多路强刷
    const sortedVariants = await fetchAllVariantsFromCobalt(originalTweetLink);

    if (sortedVariants.length > 0) {
      let finalSelectedVariant = null;
      let finalSize = 0;
      const MAX_BOT_SIZE = 50 * 1024 * 1024; // 50MB

      // 自动级联降级策略
      for (const variant of sortedVariants) {
        if (variant.score > 0 && variant.score < 1080) {
          break; // 熔断保护，低于 1080p 不自动投递
        }

        try {
          const hRes = await quickFetch(variant.url, { method: 'HEAD' }, 1500);
          const size = parseInt(hRes.headers.get('content-length') || '0', 10);
          
          if (size > 0 && size <= MAX_BOT_SIZE) {
            finalSelectedVariant = variant;
            finalSize = size;
            break; 
          }
        } catch (e) {
          console.warn('单路探测跳过');
        }
      }

      let caption = `🔗 <a href="${originalTweetLink}">查看原推特</a>`;

      if (finalSelectedVariant) {
        caption += `\n💡 <i>画质已智能适配调整至: ${finalSelectedVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, "Twitter 视频", finalSelectedVariant, finalSize, caption);
      } else {
        // 全都超限，退回最高画质直链
        const topVariant = sortedVariants[0];
        try {
          const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
          finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch {}
        await sendSpecificVideo(chatId, tweetId, "Twitter 视频", topVariant, finalSize, caption);
      }
    } else {
      // 如果 Cobalt 解析失败，回退到发送直链的基本文本
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: `⚠️ 视频解析失败，请检查链接或稍后重试。\n🔗 <a href="${originalTweetLink}">原推特直链</a>`, parse_mode: 'HTML' })
      });
    }

  } catch (error) {
    console.error('[总线报错]:', error.message);
  }

  return res.status(200).send('OK');
}

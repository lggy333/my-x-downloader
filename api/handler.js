const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 收集了多个目前存活且低调的 Cobalt 公共节点进行轮询，防止单点失效
const COBALT_NODES = [
  'https://cobalt.hyonsu.com',
  'https://api.cobalt.tools',
  'https://co.wuk.sh'
];

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function quickFetch(url, options = {}, timeoutMs = 3000) {
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

// 尝试从不同的 Cobalt 节点深度解析多画质
async function fetchFromCobaltWithFallback(tweetUrl) {
  const resolutions = ['max', '1080', '720', '480'];
  
  // 轮询节点
  for (const node of COBALT_NODES) {
    try {
      let variants = [];
      let urlsSet = new Set();
      
      const promises = resolutions.map(async (resTag) => {
        try {
          const response = await quickFetch(node, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ url: tweetUrl, videoQuality: resTag, filenamePattern: 'basic' })
          }, 2500);
          
          if (response.ok) {
            const data = await response.json();
            if (data.url && !urlsSet.has(data.url)) {
              urlsSet.add(data.url);
              let score = resTag === 'max' ? 2160 : parseInt(resTag, 10);
              let label = resTag === 'max' ? '高清原画 (Max)' : `${resTag}p`;
              return { url: data.url, score, label };
            }
          }
        } catch (e) {}
        return null;
      });

      const results = await Promise.all(promises);
      variants = results.filter(v => v !== null);
      
      if (variants.length > 0) {
        return variants.sort((a, b) => b.score - a.score);
      }
    } catch (err) {
      console.warn(`节点 ${node} 尝试失败，切换下一节点...`);
    }
  }
  return [];
}

// 终极兜底方案：如果 Cobalt 全挂了，用 FxTwitter 提取单档画质，确保机器人绝不罢工
async function fetchFxTwitterFallback(tweetId) {
  try {
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 3000);
    if (!fxRes.ok) return [];
    const data = await fxRes.json();
    const videoUrl = data.tweet?.media?.videos?.[0]?.url;
    if (videoUrl) {
      return [{ url: videoUrl, score: 1080, label: '标准画质 (兜底)' }];
    }
  } catch (e) {
    console.error('兜底 FxTwitter 也失败:', e.message);
  }
  return [];
}

// 发送视频的核心业务逻辑
async function sendSpecificVideo(chatId, tweetId, variant, size, caption) {
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
    
    const overSizeCaption = `⚠️ 提示：该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载该高清原片</a> | <a href="${originalTweetLink}">查看原推特</a>`;
    
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 逻辑分流 A：处理点击面板 =================
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路解析各档位文件体积..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const targetUrl = `https://x.com/i/status/${tweetId}`;
        let sortedVariants = await fetchFromCobaltWithFallback(targetUrl);
        
        // 如果多节点全挂，清单也用 Fx 兜底
        if (sortedVariants.length === 0) {
          sortedVariants = await fetchFxTwitterFallback(tweetId);
        }

        if (sortedVariants.length === 0) {
          if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 视频解析失败，所有解析服务暂不可用。" }) });
          return res.status(200).send('OK');
        }

        const sizePromises = sortedVariants.map(async (v) => {
          try {
            const hRes = await quickFetch(v.url, { method: 'HEAD' }, 2000);
            return parseInt(hRes.headers.get('content-length') || '0', 10);
          } catch { return 0; }
        });
        const sizes = await Promise.all(sizePromises);

        const keyboard = [];
        sortedVariants.forEach((v, idx) => {
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '点击直接投递';
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
            text: `📊 <b>推文 [${tweetId}] 画质清单</b>\n点击对应档位执行精准投递：`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 异常: ${err.message}` }) });
      }
    }

    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);

      try {
        const targetUrl = `https://x.com/i/status/${tweetId}`;
        let sortedVariants = await fetchFromCobaltWithFallback(targetUrl);
        if (sortedVariants.length === 0) {
          sortedVariants = await fetchFxTwitterFallback(tweetId);
        }
        
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="${targetUrl}">查看原推特</a>\n⚙️ <i>指定投递: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, size, caption);
      } catch (e) {
        console.error('手动投递失败', e.message);
      }
    }

    return res.status(200).send('OK');
  }

  // ================= 逻辑分流 B：处理发送消息 =================
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
    // 1. 优先使用多节点 Cobalt 冲锋，拿多清晰度列表
    let sortedVariants = await fetchFromCobaltWithFallback(originalTweetLink);
    let isFallback = false;

    // 2. 如果 Cobalt 节点今天全军覆没，立马启用 FxTwitter 提取单清晰度直链兜底，绝对不报解析失败
    if (sortedVariants.length === 0) {
      sortedVariants = await fetchFxTwitterFallback(tweetId);
      isFallback = true;
    }

    if (sortedVariants.length > 0) {
      let finalSelectedVariant = null;
      let finalSize = 0;
      const MAX_BOT_SIZE = 50 * 1024 * 1024;

      // 自动级联降级策略
      for (const variant of sortedVariants) {
        if (!isFallback && variant.score > 0 && variant.score < 1080) {
          break; // 熔断保护
        }
        try {
          const hRes = await quickFetch(variant.url, { method: 'HEAD' }, 1500);
          const size = parseInt(hRes.headers.get('content-length') || '0', 10);
          if (size > 0 && size <= MAX_BOT_SIZE) {
            finalSelectedVariant = variant;
            finalSize = size;
            break; 
          }
        } catch (e) {}
      }

      let caption = `🔗 <a href="${originalTweetLink}">查看原推特</a>`;
      if (isFallback) {
        caption += `\n⚠️ <i>高级多画质节点正忙，已自动切换到单画质兜底模式</i>`;
      }

      if (finalSelectedVariant) {
        if (!isFallback) caption += `\n💡 <i>画质已智能适配调整至: ${finalSelectedVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, finalSize, caption);
      } else {
        const topVariant = sortedVariants[0];
        try {
          const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
          finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch {}
        await sendSpecificVideo(chatId, tweetId, topVariant, finalSize, caption);
      }
    } else {
      // 极其罕见的两边都挂了，才下发基础文本
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: `⚠️ 视频网关响应异常，请重试。\n🔗 <a href="${originalTweetLink}">原推特直链</a>`, parse_mode: 'HTML' })
      });
    }

  } catch (error) {
    console.error('[总线报错]:', error.message);
  }

  return res.status(200).send('OK');
}

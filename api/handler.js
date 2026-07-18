const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

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

// 智能提取和估算画质
function parseVideoVariant(v, idx) {
  let score = 0;
  let label = '';
  if (v.height) {
    score = v.height;
    label = `${score}p`;
  } else {
    const match = v.url.match(/(\d+)x(\d+)/) || v.url.match(/tag=(\d+)/);
    if (match) {
      score = parseInt(match[1]);
      label = `${score}p`;
    } else {
      score = 1080 - (idx * 240);
      label = idx === 0 ? '🔥 原画最高清' : `预设 ${score}p`;
    }
  }
  return { url: v.url, score, label };
}

// 核心通用投递函数 (成功后返回 true，失败返回 false)
async function sendSpecificVideo(chatId, originalText, variant, size, tweetId) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const twitterUrl = `https://x.com/i/status/${tweetId}`;
  const caption = `📝 ${escapeHTML(originalText)}\n\n🔗 <a href="${twitterUrl}">查看原推特</a>\n⚙️ <i>当前投递画质: ${variant.label}</i>`;
  
  // 严格控制：回调数据仅保留小体积数字 id 传递，杜绝超过 64 字节被 Telegram 掐断响应
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `lq:${tweetId}` }]]
  };

  try {
    if (size > 0 && size <= MAX_URL_SIZE) {
      const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML', show_caption_above_media: true, reply_markup: replyMarkup })
      });
      return res.ok;
    } else if (size > MAX_URL_SIZE && size <= MAX_BOT_SIZE) {
      const videoRes = await quickFetch(variant.url, {}, 6500); 
      if (!videoRes.ok) return false;
      const arrayBuffer = await videoRes.arrayBuffer();
      
      const formData = new FormData();
      formData.append('chat_id', String(chatId));
      formData.append('caption', caption);
      formData.append('parse_mode', 'HTML');
      formData.append('show_caption_above_media', 'true');
      formData.append('reply_markup', JSON.stringify(replyMarkup));
      
      const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
      formData.append('video', videoBlob, 'video.mp4');
      const res = await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
      return res.ok;
    } else {
      const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '未知';
      const overSizeCaption = `📝 ${escapeHTML(originalText)}\n\n⚠️ 提示：该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载该高清原片</a> | <a href="${twitterUrl}">查看原推特</a>`;
      
      const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
      });
      return res.ok;
    }
  } catch (e) {
    console.error("投递动作请求异常", e.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 逻辑分流 A：处理点击按钮事件 =================
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

    // 用户点击：展开画质列表
    if (callbackData.startsWith('lq:')) {
      const tweetId = callbackData.split(':')[1];
      
      const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步探测各档位文件体积..." })
      });
      const progressMsgId = (await progressRes.json()).result?.message_id;

      let variants = [];
      let defaultTitle = "来自 X (Twitter) 的视频";

      try {
        const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
        if (fxRes.ok) {
          const fxData = await fxRes.json();
          if (fxData.tweet) {
            defaultTitle = fxData.tweet.text || defaultTitle;
            let rawVariants = fxData.tweet.media?.videos || [];
            if (fxData.tweet.media?.all_videos && Array.isArray(fxData.tweet.media.all_videos)) {
              rawVariants = rawVariants.concat(fxData.tweet.media.all_videos);
            }
            const uniqueUrls = new Set();
            rawVariants.forEach((v, idx) => {
              if (!uniqueUrls.has(v.url)) {
                uniqueUrls.add(v.url);
                variants.push(parseVideoVariant(v, idx));
              }
            });
          }
        }
      } catch (e) {}

      if (variants.length === 0) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 暂时未能抓取到视频的分流清单，请稍候再试。" }) });
        return res.status(200).send('OK');
      }

      variants.sort((a, b) => b.score - a.score);

      // 并发测体积极速响应
      const sizes = await Promise.all(variants.map(async (v) => {
        try {
          const hRes = await quickFetch(v.url, { method: 'HEAD' }, 1800);
          return parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch { return 0; }
      }));

      const keyboard = [];
      variants.forEach((v, idx) => {
        const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
        // 缩短回调标识符，确保绝对安全
        keyboard.push([{ text: `${v.label} - ${sizeMB}`, callback_data: `sq:${tweetId}:${idx}` }]);
      });

      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          chat_id: chatId, message_id: progressMsgId,
          text: `📊 <b>当前推文多分辨率画质清单</b>\n点击下方任何一档，机器人将为您强制转存该物理文件。`,
          parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
        })
      });
    }

    // 用户点击：手动强制发送某一档
    if (callbackData.startsWith('sq:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);

      let variants = [];
      let defaultTitle = "X 视频转存";

      try {
        const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
        if (fxRes.ok) {
          const fxData = await fxRes.json();
          if (fxData.tweet) {
            defaultTitle = fxData.tweet.text || defaultTitle;
            let rawVariants = fxData.tweet.media?.videos || [];
            const uniqueUrls = new Set();
            rawVariants.forEach((v, idx) => {
              if (!uniqueUrls.has(v.url)) { uniqueUrls.add(v.url); variants.push(parseVideoVariant(v, idx)); }
            });
          }
        }
      } catch (e) {}

      variants.sort((a, b) => b.score - a.score);
      const chosen = variants[targetIdx];
      if (!chosen) return res.status(200).send('OK');

      const hRes = await quickFetch(chosen.url, { method: 'HEAD' }, 2000);
      const size = parseInt(hRes.headers.get('content-length') || '0', 10);

      await sendSpecificVideo(chatId, defaultTitle, chosen, size, tweetId);
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

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK'); 

  const tweetId = match[1];
  let sortedVariants = [];
  let defaultTitle = "来自 X (Twitter) 的高清分享";

  try {
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
    if (!fxRes.ok) throw new Error("FxTwitter网关不通");
    
    const fxData = await fxRes.json();
    if (fxData.tweet) {
      defaultTitle = fxData.tweet.text || defaultTitle;
      let rawVariants = fxData.tweet.media?.videos || [];
      if (fxData.tweet.media?.all_videos && Array.isArray(fxData.tweet.media.all_videos)) {
        rawVariants = rawVariants.concat(fxData.tweet.media.all_videos);
      }
      
      const uniqueUrls = new Set();
      rawVariants.forEach((v, idx) => {
        if (!uniqueUrls.has(v.url)) {
          uniqueUrls.add(v.url);
          sortedVariants.push(parseVideoVariant(v, idx));
        }
      });
    }

    if (sortedVariants.length > 0) {
      sortedVariants.sort((a, b) => b.score - a.score);

      let finalSelectedVariant = null;
      let finalSize = 0;
      const MAX_BOT_SIZE = 50 * 1024 * 1024;

      // 级联探测符合大小的画质 (1080p底线)
      for (const variant of sortedVariants) {
        if (variant.score > 0 && variant.score < 1080) break; 
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

      let success = false;
      if (finalSelectedVariant) {
        success = await sendSpecificVideo(chatId, defaultTitle, finalSelectedVariant, finalSize, tweetId);
      } else {
        const topVariant = sortedVariants[0];
        try {
          const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
          finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch {}
        success = await sendSpecificVideo(chatId, defaultTitle, topVariant, finalSize, tweetId);
      }

      // 【核心安全策略】：只有新消息确认发送成功了，才执行删除原链接的动作
      if (success) {
        await fetch(`${TELEGRAM_API}/deleteMessage`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error('[总线拦截报错]:', error.message);
  }

  return res.status(200).send('OK');
}
}

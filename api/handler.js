const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 高可用 Cobalt 节点
const COBALT_API = "https://api.cobalt.tools";

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// 智能提取和估算画质标签
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
      label = idx === 0 ? '🔥 默认最高清' : `次高清 ${label}`;
    }
  }
  return { url: v.url, score, label };
}

// 核心通用投递函数
async function sendSpecificVideo(chatId, originalText, variant, size, twitterUrl) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const encodedUrl = Buffer.from(twitterUrl).toString('base64url');
  const caption = `📝 ${escapeHTML(originalText)}\n\n🔗 <a href="${twitterUrl}">查看原推特</a>\n⚙️ <i>当前投递画质: ${variant.label}</i>`;
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${encodedUrl}` }]]
  };

  if (size > 0 && size <= MAX_URL_SIZE) {
    await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML', show_caption_above_media: true, reply_markup: replyMarkup })
    });
  } else if (size > MAX_URL_SIZE && size <= MAX_BOT_SIZE) {
    const videoRes = await quickFetch(variant.url, {}, 6000); 
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
    const overSizeCaption = `📝 ${escapeHTML(originalText)}\n\n⚠️ 提示：该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载该高清原片</a> | <a href="${twitterUrl}">查看原推特</a>`;
    
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
    });
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

    // 用户点击：展开完整的画质和体积面板
    if (callbackData.startsWith('list_q:')) {
      const encodedUrl = callbackData.split(':')[1];
      const twitterUrl = Buffer.from(encodedUrl, 'base64url').toString();
      const tweetId = twitterUrl.match(/status\/(\d+)/)?.[1] || "";
      
      const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步探测各档位文件体积..." })
      });
      const progressMsgId = (await progressRes.json()).result?.message_id;

      let variants = [];

      try {
        // 第一轨：尝试从 Cobalt 获取
        const cobRes = await fetch(COBALT_API, {
          method: 'POST',
          headers: { ...JSON_HEADERS, 'Accept': 'application/json' },
          body: JSON.stringify({ url: twitterUrl, videoQuality: 'max' })
        });
        const cobData = await cobRes.json();
        if (cobData.picker && Array.isArray(cobData.picker)) {
          variants = cobData.picker.map((p, i) => ({ url: p.url, score: 2000 - i * 200, label: p.type || `${1080 - i * 240}p` }));
        } else if (cobData.url) {
          variants = [{ url: cobData.url, score: 1080, label: '🔥 原画最高清' }];
        }
      } catch (e) {
        console.warn('Cobalt 探测失败，准备降级');
      }

      // 第二轨降级：如果 Cobalt 没给齐或者报错，调用 fxtwitter 补全多流
      if (variants.length <= 1 && tweetId) {
        try {
          const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
          const tweet = fxRes.ok ? (await fxRes.json()).tweet : null;
          if (tweet && tweet.media?.videos) {
            let rawV = tweet.media.videos;
            if (tweet.media.all_videos && Array.isArray(tweet.media.all_videos)) {
              rawV = rawV.concat(tweet.media.all_videos);
            }
            const uniqueUrls = new Set(variants.map(v => v.url));
            rawV.forEach((v, idx) => {
              if (!uniqueUrls.has(v.url)) {
                uniqueUrls.add(v.url);
                variants.push(parseVideoVariant(v, idx));
              }
            });
          }
        } catch (e) {}
      }

      if (variants.length === 0) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 各路网关均未响应有效的多流清单。" }) });
        return res.status(200).send('OK');
      }

      variants.sort((a, b) => b.score - a.score);

      // 并发检测体积
      const sizes = await Promise.all(variants.map(async (v) => {
        try {
          const hRes = await quickFetch(v.url, { method: 'HEAD' }, 1800);
          return parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch { return 0; }
      }));

      const keyboard = [];
      variants.forEach((v, idx) => {
        const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
        keyboard.push([{ text: `${v.label} - ${sizeMB}`, callback_data: `send_q:${encodedUrl}:${idx}` }]);
      });

      await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          chat_id: chatId, message_id: progressMsgId,
          text: `📊 <b>当前推文画质探测清单</b>\n点击下方按钮，会自动将对应文件直接转存至你的窗口中。`,
          parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
        })
      });
    }

    // 用户点击：指定了具体的某一个画质档位进行发送
    if (callbackData.startsWith('send_q:')) {
      const [, encodedUrl, indexStr] = callbackData.split(':');
      const twitterUrl = Buffer.from(encodedUrl, 'base64url').toString();
      const tweetId = twitterUrl.match(/status\/(\d+)/)?.[1] || "";
      const targetIdx = parseInt(indexStr, 10);

      let variants = [];
      // 重新拉取一次并对齐列表
      try {
        const cobRes = await fetch(COBALT_API, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ url: twitterUrl, videoQuality: 'max' }) });
        const cobData = await cobRes.json();
        if (cobData.picker && Array.isArray(cobData.picker)) {
          variants = cobData.picker.map((p, i) => ({ url: p.url, score: 2000 - i * 200, label: p.type || `${1080 - i * 240}p` }));
        } else if (cobData.url) {
          variants = [{ url: cobData.url, score: 1080, label: '🔥 原画最高清' }];
        }
      } catch (e) {}

      if (variants.length <= 1 && tweetId) {
        try {
          const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
          const tweet = fxRes.ok ? (await fxRes.json()).tweet : null;
          if (tweet && tweet.media?.videos) {
            let rawV = tweet.media.videos;
            const uniqueUrls = new Set(variants.map(v => v.url));
            rawV.forEach((v, idx) => {
              if (!uniqueUrls.has(v.url)) { uniqueUrls.add(v.url); variants.push(parseVideoVariant(v, idx)); }
            });
          }
        } catch (e) {}
      }

      variants.sort((a, b) => b.score - a.score);
      const chosen = variants[targetIdx];
      if (!chosen) return res.status(200).send('OK');

      const hRes = await quickFetch(chosen.url, { method: 'HEAD' }, 2000);
      const size = parseInt(hRes.headers.get('content-length') || '0', 10);
      const originalText = callback.message.text || "X 视频转存";

      await sendSpecificVideo(chatId, originalText, chosen, size, twitterUrl);
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

  const originalTwitterUrl = match[0].startsWith('http') ? match[0] : `https://${match[0]}`;
  const tweetId = match[1];

  let sortedVariants = [];
  let defaultTitle = "来自 X (Twitter) 的高清分享";

  // 1. 先用快如闪电且带多画质的 fxtwitter 做第一路由首发探测
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
            sortedVariants.push(parseVideoVariant(v, idx));
          }
        });
      }
    }
  } catch (e) {
    console.warn('Fxtwitter 首发探测失败');
  }

  // 2. 如果 fxtwitter 没捞到视频，启动 Cobalt 强行补充
  if (sortedVariants.length === 0) {
    try {
      const cobRes = await fetch(COBALT_API, { method: 'POST', headers: { ...JSON_HEADERS, 'Accept': 'application/json' }, body: JSON.stringify({ url: originalTwitterUrl, videoQuality: 'max' }) });
      if (cobRes.ok) {
        const cobData = await cobRes.json();
        if (cobData.picker && Array.isArray(cobData.picker)) {
          sortedVariants = cobData.picker.map((p, i) => ({ url: p.url, score: 2000 - i * 200, label: p.type || `${1080 - i * 240}p` }));
        } else if (cobData.url) {
          sortedVariants = [{ url: cobData.url, score: 1080, label: '原画高清' }];
        }
      }
    } catch (e) {
      console.error('Cobalt 补全失败');
    }
  }

  // 开始进入画质筛选与级联投递
  if (sortedVariants.length > 0) {
    sortedVariants.sort((a, b) => b.score - a.score);

    let finalSelectedVariant = null;
    let finalSize = 0;
    const MAX_BOT_SIZE = 50 * 1024 * 1024;

    for (const variant of sortedVariants) {
      if (variant.score > 0 && variant.score < 1080) break; // 1080p 熔断保护
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

    if (finalSelectedVariant) {
      await sendSpecificVideo(chatId, defaultTitle, finalSelectedVariant, finalSize, originalTwitterUrl);
    } else {
      const topVariant = sortedVariants[0];
      try {
        const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
        finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
      } catch { finalSize = 0; }
      await sendSpecificVideo(chatId, defaultTitle, topVariant, finalSize, originalTwitterUrl);
    }
  }

  return res.status(200).send('OK');
}

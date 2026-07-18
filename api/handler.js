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

// 突破核心：利用 TwitSave 搬运网关，极速套出真正分级的有声 MP4 直链
async function fetchMultiQualities(tweetId) {
  const targetUrl = `https://twitsave.com/info?url=https://x.com/i/status/${tweetId}`;
  let variants = [];
  
  try {
    const res = await quickFetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    }, 3500);
    
    if (!res.ok) return [];
    const html = await res.text();

    // 正则提取包含有声 MP4 的下载按钮区域
    // TwitSave 格式通常为: href="https://...download.php?vid=..." 并在附近有 (HD) 或 (SD) 字样
    const downloadBlockRegex = /href="([^"]+download\.php[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    let urlsSet = new Set();

    while ((match = downloadBlockRegex.exec(html)) !== null) {
      let downloadUrl = match[1];
      let innerText = match[2].toUpperCase();
      
      if (urlsSet.has(downloadUrl)) continue;
      urlsSet.add(downloadUrl);

      let score = 360;
      let label = '标清画质 (SD)';

      if (innerText.includes('HD') || innerText.includes('ORIGINAL') || innerText.includes('HIGH')) {
        score = 1080;
        label = '超清原画 (HD)';
      } else if (innerText.includes('720')) {
        score = 720;
        label = '高清 720p';
      } else if (innerText.includes('480')) {
        score = 480;
        label = '清晰 480p';
      }

      variants.push({ url: downloadUrl, score, label });
    }
  } catch (e) {
    console.error('TwitSave 深度解析失败:', e.message);
  }

  // 如果连高并发转码平台都拿不到，最后使用 fxtwitter 吐出的单档原画做底牌保护
  if (variants.length === 0) {
    try {
      const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2000);
      if (fxRes.ok) {
        const fxData = await fxRes.json();
        const fallbackUrl = fxData.tweet?.media?.videos?.[0]?.url;
        if (fallbackUrl) {
          variants.push({ url: fallbackUrl, score: 1080, label: '原厂画质 (单档兜底)' });
        }
      }
    } catch (e) {}
  }

  return variants.sort((a, b) => b.score - a.score);
}

// 发送视频流封装逻辑
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
    
    const overSizeCaption = `⚠️ 提示：该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此无损下载该视频</a> | <a href="${originalTweetLink}">查看原推特</a>`;
    
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
    });
  }
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步请求转码网关探测体积..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const sortedVariants = await fetchMultiQualities(tweetId);

        if (sortedVariants.length === 0) {
          if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 暂未获取到有效的视频流分级列表。" }) });
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
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '极速直连投递';
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
            text: `📊 <b>该视频多档转码清晰度清单</b>\n下方每一档皆可点击，体积符合直接发文件，超限发送直链：`,
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
        const sortedVariants = await fetchMultiQualities(tweetId);
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>手动指定投递画质: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, size, caption);
      } catch (e) {
        console.error('面板手动投递失败', e.message);
      }
    }

    return res.status(200).send('OK');
  }

  // ================= 逻辑分流 B：处理用户发送的 X 链接 =================
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
    // 核心调用：去第三方高能缓存库套出多清晰度
    const sortedVariants = await fetchMultiQualities(tweetId);

    if (sortedVariants.length > 0) {
      let finalSelectedVariant = null;
      let finalSize = 0;
      const MAX_BOT_SIZE = 50 * 1024 * 1024; // 50MB限制

      // 级联智能降级尝试
      for (const variant of sortedVariants) {
        // 如果遇到了低于底线 1080p 且我们拿到了多档，执行级联熔断保护
        if (sortedVariants.length > 1 && variant.score < 1080) {
          break;
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
          console.warn('级联单路探测越过');
        }
      }

      let caption = `🔗 <a href="${originalTweetLink}">查看原推特</a>`;

      if (finalSelectedVariant) {
        // 如果发生了降级选择（选的不是最高清晰度），给用户打个小标签提示
        if (finalSelectedVariant.url !== sortedVariants[0].url) {
          caption += `\n💡 <i>最高画质超限，已智能降级适配至: ${finalSelectedVariant.label}</i>`;
        } else {
          caption += `\n💡 <i>完美适配，以最高品投递: ${finalSelectedVariant.label}</i>`;
        }
        await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, finalSize, caption);
      } else {
        // 哪怕所有清晰度都超限了，也拿第一档（最大最清晰的）下发无损直链通知
        const topVariant = sortedVariants[0];
        try {
          const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
          finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch {}
        await sendSpecificVideo(chatId, tweetId, topVariant, finalSize, caption);
      }
    } else {
      // 容错备用
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: `⚠️ 视频解析失败，请检查原推特链接。\n🔗 <a href="${originalTweetLink}">原推特直链</a>`, parse_mode: 'HTML' })
      });
    }

  } catch (error) {
    console.error('[总线报错]:', error.message);
  }

  return res.status(200).send('OK');
}

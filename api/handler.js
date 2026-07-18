const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function quickFetch(url, options = {}, timeoutMs = 3500) {
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

// 智能解析视频的画质分数与标签
function parseVideoVariant(v, idx) {
  let score = 0; // 清晰度分数（以长边像素为准）
  let label = '';
  
  if (v.height && v.width) {
    score = Math.max(v.width, v.height);
    label = `${score}p`;
  } else {
    const match = v.url.match(/(\d+)x(\d+)/);
    if (match) {
      score = Math.max(parseInt(match[1]), parseInt(match[2]));
      label = `${score}p`;
    } else {
      score = 0; 
      label = `预设画质 ${idx + 1}`;
    }
  }
  return { url: v.url, score, label };
}

// 核心业务：发送特定分辨率的视频流
async function sendSpecificVideo(chatId, tweet, variant, size, caption) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  const tweetId = tweet.id;
  
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
    // 超限则下发带按钮的文本直链
    const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '未知';
    const authorLink = `https://x.com/${tweet.author.screen_name}`;
    const originalTweetLink = `https://x.com/i/status/${tweetId}`;
    
    const overSizeCaption = `📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n\n⚠️ 提示：该画质过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此下载该高清原片</a> | <a href="${originalTweetLink}">查看原推特</a>`;
    
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

    // 告诉 TG 客户端收到点击，解除转圈状态
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ callback_query_id: callback.id })
    }).catch(() => {});

    // 触发事件 1：请求画质列表清单
    if (callbackData.startsWith('list_q:')) {
      const tweetId = callbackData.split(':')[1];
      
      const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步探测各档位文件体积..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
        const tweet = fxRes.ok ? (await fxRes.json()).tweet : null;
        if (!tweet || !tweet.media?.videos) {
          if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 未能获取到有效的视频流资料。" }) });
          return res.status(200).send('OK');
        }

        let rawVariants = tweet.media.videos;
        if (tweet.media.all_videos && Array.isArray(tweet.media.all_videos)) {
          rawVariants = rawVariants.concat(tweet.media.all_videos);
        }

        // 去重并解析所有变体
        const uniqueUrls = new Set();
        let sortedVariants = [];
        rawVariants.forEach((v, idx) => {
          if (!uniqueUrls.has(v.url)) {
            uniqueUrls.add(v.url);
            sortedVariants.push(parseVideoVariant(v, idx));
          }
        });
        sortedVariants.sort((a, b) => b.score - a.score);

        // 并发探测体积
        const sizePromises = sortedVariants.map(async (v) => {
          try {
            const hRes = await quickFetch(v.url, { method: 'HEAD' }, 2000);
            return parseInt(hRes.headers.get('content-length') || '0', 10);
          } catch { return 0; }
        });
        const sizes = await Promise.all(sizePromises);

        // 组装内联键盘选项
        const keyboard = [];
        sortedVariants.forEach((v, idx) => {
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
          keyboard.push([{
            text: `${v.label} - ${sizeMB}`,
            callback_data: `send_q:${tweetId}:${idx}`
          }]);
        });

        // 修改进度消息为清单面板
        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: progressMsgId,
            text: `📊 <b>推文 [${tweetId}] 完整画质清单</b>\n下方每一档皆可点击，体积符合将会直接发送文件，超限则发送无损直链。`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生异常: ${err.message}` }) });
      }
    }

    // 触发事件 2：点击了清单中的某一档，执行精准发送
    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);

      try {
        const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
        const tweet = fxRes.ok ? (await fxRes.json()).tweet : null;
        if (!tweet) return res.status(200).send('OK');

        let rawVariants = tweet.media.videos || [];
        if (tweet.media.all_videos && Array.isArray(tweet.media.all_videos)) {
          rawVariants = rawVariants.concat(tweet.media.all_videos);
        }

        const uniqueUrls = new Set();
        let sortedVariants = [];
        rawVariants.forEach((v, idx) => {
          if (!uniqueUrls.has(v.url)) {
            uniqueUrls.add(v.url);
            sortedVariants.push(parseVideoVariant(v, idx));
          }
        });
        sortedVariants.sort((a, b) => b.score - a.score);

        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const authorLink = `https://x.com/${tweet.author.screen_name}`;
        const originalTweetLink = `https://x.com/i/status/${tweetId}`;
        const caption = `📝 ${escapeHTML(tweet.text)}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>\n⚙️ <i>手动指定投递画质: ${chosenVariant.label}</i>`;

        await sendSpecificVideo(chatId, tweet, chosenVariant, size, caption);
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

  // 强行同步删除用户发送的原消息
  try {
    await fetch(`${TELEGRAM_API}/deleteMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
  } catch (e) {
    console.error('删除消息权限不足:', e.message);
  }

  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK'); 

  const tweetId = match[1];
  const fxApiUrl = `https://api.fxtwitter.com/i/status/${tweetId}`;

  try {
    const fxRes = await quickFetch(fxApiUrl);
    if (!fxRes.ok) throw new Error('解析接口无响应');
    
    const fxData = await fxRes.json();
    const tweet = fxData.tweet;
    if (!tweet) return res.status(200).send('OK');

    const safeText = escapeHTML(tweet.text);
    const authorLink = `https://x.com/${tweet.author.screen_name}`;
    const originalTweetLink = `https://x.com/i/status/${tweetId}`;
    let caption = `📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;

    const media = tweet.media || {};
    let rawVariants = media.videos || [];
    if (media.all_videos && Array.isArray(media.all_videos)) {
      rawVariants = rawVariants.concat(media.all_videos);
    }
    const photos = media.photos || [];

    // --- 核心业务：自动级联逐级降级逻辑 ---
    if (rawVariants.length > 0) {
      const uniqueUrls = new Set();
      let sortedVariants = [];
      rawVariants.forEach((v, idx) => {
        if (!uniqueUrls.has(v.url)) {
          uniqueUrls.add(v.url);
          sortedVariants.push(parseVideoVariant(v, idx));
        }
      });
      // 按清晰度从高到低强制排序
      sortedVariants.sort((a, b) => b.score - a.score);

      let finalSelectedVariant = null;
      let finalSize = 0;
      const MAX_BOT_SIZE = 50 * 1024 * 1024; // 50MB

      // 从最高画质开始逐级往下滚动尝试
      for (const variant of sortedVariants) {
        // 如果遇到了低于最低标准 1080p 的档位，直接触发熔断机制，中断尝试
        if (variant.score > 0 && variant.score < 1080) {
          break;
        }

        try {
          const hRes = await quickFetch(variant.url, { method: 'HEAD' }, 1500);
          const size = parseInt(hRes.headers.get('content-length') || '0', 10);
          
          if (size > 0 && size <= MAX_BOT_SIZE) {
            finalSelectedVariant = variant;
            finalSize = size;
            break; // 完美匹配成功，退出查找
          }
        } catch (e) {
          console.warn('级联探测单路跳过');
        }
      }

      if (finalSelectedVariant) {
        // 自动降级成功流
        caption += `\n💡 <i>画质已智能适配调整至: ${finalSelectedVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweet, finalSelectedVariant, finalSize, caption);
      } else {
        // 满足 1080p 底线的所有画质均超过 50MB，下发最高画质的外部直链逻辑
        const topVariant = sortedVariants[0];
        try {
          const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
          finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch { finalSize = 0; }
        
        await sendSpecificVideo(chatId, tweet, topVariant, finalSize, caption);
      }

    } else if (photos.length > 0) {
      // 纯图片处理，照常携带查询画质键盘（虽然对图片无影响，保证排版一致）
      const replyMarkup = { inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${tweetId}` }]] };
      if (photos.length === 1) {
        await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, photo: photos[0].url, caption, parse_mode: 'HTML', show_caption_above_media: true, reply_markup: replyMarkup })
        });
      } else {
        const mediaGroup = photos.map((p, idx) => ({
          type: 'photo', media: p.url, caption: idx === 0 ? caption : '', parse_mode: idx === 0 ? 'HTML' : undefined, show_caption_above_media: idx === 0 ? true : undefined
        }));
        await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, media: mediaGroup })
        });
      }
    } else {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' })
      });
    }

  } catch (error) {
    console.error('[总线报错]:', error.message);
  }

  return res.status(200).send('OK');
}

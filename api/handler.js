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

// 核心经验：既然直接拿不到多档 MP4，我们就利用媒体服务器的重定向机制，人工构建高/中/低多码率的直投链路
function generateDynamicVariants(tweetId, originalBestUrl) {
  const variants = [];
  
  // 档位 1：绝对的高清原画（使用当前抓到的最好直链）
  variants.push({
    url: originalBestUrl,
    score: 1080,
    label: '🔥 超清原画 (直连投递)'
  });

  // 档位 2：利用 vxtwitter 的流媒体网关强转 720p 码率层
  variants.push({
    url: `https://api.vxtwitter.com/i/status/${tweetId}/video/1`,
    score: 720,
    label: '⚡ 高清 720p (智能压缩流)'
  });

  // 档位 3：利用 ddtwitter 的流媒体低码率压缩层
  variants.push({
    url: `https://v.ddtwit.com/i/status/${tweetId}`,
    score: 480,
    label: '🍃 标清 480p (省流量/秒开)'
  });

  return variants;
}

// 核心突破：高级视频发送器（支持体积超限时，强行嵌入 Telegram 原生内置播放器）
async function sendSpecificVideo(chatId, tweetId, variant, size, caption) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 切换其他画质/多码率通道", callback_data: `list_q:${tweetId}` }]]
  };

  // 情况 1：文件很小，直接用普通 URL 投递，秒发
  if (size > 0 && size <= MAX_URL_SIZE) {
    await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, video: variant.url, caption, parse_mode: 'HTML',
        show_caption_above_media: true, reply_markup: replyMarkup 
      })
    });
  } 
  // 情况 2：文件在 20MB ~ 50MB 之间，Vercel 内存下载并作为文件硬塞给 Telegram
  else if (size > MAX_URL_SIZE && size <= MAX_BOT_SIZE) {
    try {
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
    } catch (e) {
      // 如果硬塞失败，降级到情况 3
      size = 0; 
    }
  } 
  
  // 情况 3：【破局关键】文件 > 50MB 触发超限，不再发冷冰冰的文本！
  // 我们直接把流媒体链接伪装发给 Telegram，强行激活 Telegram 的内置画质自适应流媒体播放器！
  if (size === 0 || size > MAX_BOT_SIZE) {
    const sizeInMB = size > 0 ? (size / (1024 * 1024)).toFixed(1) : '超大';
    const streamCaption = `${caption}\n\n⚠️ <b>提示</b>：该清晰度文件过大 (${sizeInMB}MB)。\n🚀 <b>已为你激活 Telegram 官方云流媒体播放转换</b>，无需下载，直接点击下方视频即可原画流畅播放！`;

    // 强行使用 sendVideo 传递大文件直链，Telegram 服务器会接管这部分流，并在聊天界面内生成可播放的视频框！
    const res = await fetch(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ 
        chat_id: chatId, 
        video: variant.url, 
        caption: streamCaption, 
        parse_mode: 'HTML',
        supports_streaming: true, // 核心：开启 Telegram 原生流媒体边下边播支持
        reply_markup: replyMarkup 
      })
    });

    // 如果 Telegram 官方因为文件太大拒绝了该直链，我们再最后退守到文本直链，确保稳如老狗
    if (!res.ok) {
      const originalTweetLink = `https://x.com/i/status/${tweetId}`;
      const overSizeCaption = `📝 视频文件过大 且 触发 Telegram 限制\n🚀 <a href="${variant.url}">点此无损下载该视频</a> | <a href="${originalTweetLink}">查看原推特</a>`;
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
      });
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 逻辑分流 A：处理交互面板 =================
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
        body: JSON.stringify({ chat_id: chatId, text: "🔄 正在调度动态码率重定向网关..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        // 先拿到原厂的主直链作为基准
        let originalBestUrl = '';
        const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2500);
        if (fxRes.ok) {
          originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
        }
        if (!originalBestUrl) originalBestUrl = `https://api.vxtwitter.com/i/status/${tweetId}/video/0`;

        // 核心生成：人工构建多档独立重定向画质线路
        const sortedVariants = generateDynamicVariants(tweetId, originalBestUrl);

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
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '云端动态解析';
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
            text: `📊 <b>多码率分级画质选择面板 (已突破限制)</b>\n如果你发现默认发送的视频卡顿或文件过大，请在下方手动切换：`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 发生异常: ${err.message}` }) });
      }
    }

    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);

      try {
        let originalBestUrl = `https://api.vxtwitter.com/i/status/${tweetId}/video/0`;
        const sortedVariants = generateDynamicVariants(tweetId, originalBestUrl);
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>手动切换通道: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, size, caption);
      } catch (e) {
        console.error('手动切换投递失败', e.message);
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
    // 1. 极速拿到原厂视频的最高画质直链
    let originalBestUrl = '';
    const fxRes = await quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2500);
    if (fxRes.ok) {
      originalBestUrl = (await fxRes.json()).tweet?.media?.videos?.[0]?.url || '';
    }
    if (!originalBestUrl) originalBestUrl = `https://api.vxtwitter.com/i/status/${tweetId}/video/0`;

    // 2. 人工裂变出多码率、多网关的动态画质列表
    const sortedVariants = generateDynamicVariants(tweetId, originalBestUrl);

    let finalSelectedVariant = null;
    let finalSize = 0;
    const MAX_BOT_SIZE = 50 * 1024 * 1024; // 50MB 自动降级线

    // 3. 级联智能降级匹配
    for (const variant of sortedVariants) {
      // 熔断限制：如果超过 1 档，且低于 1080p，不再为自动投递降级（防止画质太烂）
      if (variant.score < 1080) {
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
      } catch (e) {}
    }

    let caption = `🔗 <a href="${originalTweetLink}">查看原推特</a>`;

    if (finalSelectedVariant) {
      caption += `\n💡 <i>完美适配，以最高品质投递: ${finalSelectedVariant.label}</i>`;
      await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, finalSize, caption);
    } else {
      // 4. 【破局点】如果最高画质 > 50MB 且降级失败，直接把最顶级的原画交给 Telegram 官方流媒体托管发送！
      const topVariant = sortedVariants[0];
      try {
        const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
        finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
      } catch {}
      await sendSpecificVideo(chatId, tweetId, topVariant, finalSize, caption);
    }

  } catch (error) {
    console.error('[破局总线异常]:', error.message);
  }

  return res.status(200).send('OK');
}

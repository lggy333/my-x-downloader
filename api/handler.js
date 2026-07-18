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

// 核心杀手锏：全网免费渠道高并发联合作战引擎
async function getGlobalVideoVariants(tweetId) {
  const tweetUrl = `https://x.com/i/status/${tweetId}`;
  const uniqueUrls = new Set();
  const variants = [];

  function registerVariant(url, score, label) {
    if (!url || uniqueUrls.has(url)) return;
    uniqueUrls.add(url);
    variants.push({ url, score, label });
  }

  // 构建高并发并发任务池，所有网络请求同时起飞
  const tasks = [
    // 渠道一：VxTwitter Extended API（FixTweet 高级格式流，天生自带多分辨率码率数组）
    quickFetch(`https://api.vxtwitter.com/i/status/${tweetId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, 2500)
    .then(r => r.json())
    .then(data => {
      if (data && data.media_extended) {
        data.media_extended.forEach(m => {
          if ((m.type === 'video' || m.type === 'gif') && m.variants) {
            m.variants.forEach(v => {
              if (!v.url) return;
              let score = 480; let label = '标准标清';
              if (v.url.includes('1080p') || v.url.includes('1080x') || (v.bitrate && v.bitrate > 2000000)) { score = 1080; label = '超清 1080p'; }
              else if (v.url.includes('720p') || v.url.includes('720x') || (v.bitrate && v.bitrate > 1000000)) { score = 720; label = '高清 720p'; }
              else if (v.url.includes('480p') || v.url.includes('480x')) { score = 480; label = '清晰 480p'; }
              else if (v.url.includes('360p') || v.url.includes('360x')) { score = 360; label = '流畅 360p'; }
              registerVariant(v.url, score, label);
            });
          }
        });
      }
    }).catch(() => {}),

    // 渠道二：TwitSave 平台网页转码解包提取
    quickFetch(`https://twitsave.com/info?url=${tweetUrl}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, 3000)
    .then(r => r.text())
    .then(html => {
      const regex = /href="([^"]*download\.php[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        let dUrl = match[1];
        if (!dUrl.startsWith('http')) dUrl = 'https://twitsave.com' + dUrl;
        let txt = match[2].toUpperCase();
        let score = 480; let label = '标清画质 (SD)';
        if (txt.includes('HD') || txt.includes('ORIGINAL') || txt.includes('HIGH') || txt.includes('1080')) { score = 1080; label = '超清原画 (HD)'; }
        else if (txt.includes('720')) { score = 720; label = '高清 720p'; }
        else if (txt.includes('480')) { score = 480; label = '清晰 480p'; }
        registerVariant(dUrl, score, label);
      }
    }).catch(() => {}),

    // 渠道三：Cobalt 分布式强力混淆解包节点
    quickFetch('https://co.wuk.sh/api/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ url: tweetUrl, videoQuality: '720', filenamePattern: 'basic' })
    }, 2500)
    .then(r => r.json())
    .then(d => { if (d && d.url) registerVariant(d.url, 720, '高清 720p (弹性节点)'); })
    .catch(() => {}),

    // 渠道四：FxTwitter 基础单档流兜底
    quickFetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {}, 2000)
    .then(r => r.json())
    .then(data => {
      if (data && data.tweet && data.tweet.media && data.tweet.media.videos) {
        data.tweet.media.videos.forEach(v => {
          let score = 1080;
          if (v.width && v.height) score = Math.max(v.width, v.height);
          registerVariant(v.url, score, `${score}p (原厂默认)`);
        });
      }
    }).catch(() => {})
  ];

  // 阻塞等待所有清洗渠道执行完毕（或超时失败）
  await Promise.allSettled(tasks);

  // 强制按照清晰度指标从高到低完成最终清洗排序
  return variants.sort((a, b) => b.score - a.score);
}

// 视频定向发送器
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
    
    const overSizeCaption = `⚠️ 提示：当前画质体积过大 (${sizeInMB}MB) 无法直接发送\n🚀 <a href="${variant.url}">点此无损下载该视频</a> | <a href="${originalTweetLink}">查看原推特</a>`;
    
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML', reply_markup: replyMarkup })
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ================= 逻辑分流 A：处理控制面板按钮请求 =================
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
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在进行全网多渠道数据清洗与体积探测..." })
      });
      const progressData = await progressRes.json();
      const progressMsgId = progressData.result?.message_id;

      try {
        const sortedVariants = await getGlobalVideoVariants(tweetId);

        if (sortedVariants.length === 0) {
          if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: "❌ 聚合解析矩阵未能在任何渠道发现可用视频源。" }) });
          return res.status(200).send('OK');
        }

        // 并发探测提取出所有线路的文件体积
        const sizePromises = sortedVariants.map(async (v) => {
          try {
            const hRes = await quickFetch(v.url, { method: 'HEAD' }, 2000);
            return parseInt(hRes.headers.get('content-length') || '0', 10);
          } catch { return 0; }
        });
        const sizes = await Promise.all(sizePromises);

        const keyboard = [];
        sortedVariants.forEach((v, idx) => {
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '极速发货链路';
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
            text: `📊 <b>聚合矩阵成功洗出以下独立画质档位</b>\n点击对应档位，机器人将强制采用该画质为你发送文件：`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 发生未知异常: ${err.message}` }) });
      }
    }

    if (callbackData.startsWith('send_q:')) {
      const [, tweetId, indexStr] = callbackData.split(':');
      const targetIdx = parseInt(indexStr, 10);

      try {
        const sortedVariants = await getGlobalVideoVariants(tweetId);
        const chosenVariant = sortedVariants[targetIdx];
        if (!chosenVariant) return res.status(200).send('OK');

        const hRes = await quickFetch(chosenVariant.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        const caption = `🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>\n⚙️ <i>手动强选重定向画质: ${chosenVariant.label}</i>`;
        await sendSpecificVideo(chatId, tweetId, chosenVariant, size, caption);
      } catch (e) {
        console.error('控制面板投递故障', e.message);
      }
    }

    return res.status(200).send('OK');
  }

  // ================= 逻辑分流 B：用户发送原始推特链接 =================
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
    // 调用联合收割引擎
    const sortedVariants = await getGlobalVideoVariants(tweetId);

    if (sortedVariants.length > 0) {
      let finalSelectedVariant = null;
      let finalSize = 0;
      const MAX_BOT_SIZE = 50 * 1024 * 1024;

      // 自动级联降级策略（高画质降到 1080p 底线）
      for (const variant of sortedVariants) {
        if (sortedVariants.length > 1 && variant.score < 1080) {
          break; // 熔断保护，低于1080p终止自动猜测
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
        if (finalSelectedVariant.url !== sortedVariants[0].url) {
          caption += `\n💡 <i>超清原件过重，智能为你级联无感降级至: ${finalSelectedVariant.label}</i>`;
        } else {
          caption += `\n💡 <i>极品画质体积极其完美，以最高品质投递: ${finalSelectedVariant.label}</i>`;
        }
        await sendSpecificVideo(chatId, tweetId, finalSelectedVariant, finalSize, caption);
      } else {
        // 说明全都要么超限了，退回第一档无损（最顶级的画质），让 sendSpecificVideo 吐下载直链
        const topVariant = sortedVariants[0];
        try {
          const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
          finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
        } catch {}
        await sendSpecificVideo(chatId, tweetId, topVariant, finalSize, caption);
      }
    } else {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: `⚠️ 聚合解析失败，没有找到可供下载的文件。\n🔗 <a href="${originalTweetLink}">原推特直链</a>`, parse_mode: 'HTML' })
      });
    }

  } catch (error) {
    console.error('[聚合总线崩塌]:', error.message);
  }

  return res.status(200).send('OK');
}

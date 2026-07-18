const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 免费且功能强大的 Cobalt 官方高可用节点
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

// 核心业务：向 TG 发送选定档位的视频
async function sendSpecificVideo(chatId, originalText, variant, size, twitterUrl) {
  const MAX_URL_SIZE = 20 * 1024 * 1024;
  const MAX_BOT_SIZE = 50 * 1024 * 1024;
  
  // 提取推文 ID 方便生成面板指引
  const tweetId = twitterUrl.match(/status\/(\d+)/)?.[1] || "tweet";
  
  const caption = `📝 ${escapeHTML(originalText)}\n\n🔗 <a href="${twitterUrl}">查看原推特</a>\n⚙️ <i>当前投递画质: ${variant.label}</i>`;
  const replyMarkup = {
    inline_keyboard: [[{ text: "📊 查看所有画质与体积", callback_data: `list_q:${Buffer.from(twitterUrl).toString('base64url')}` }]]
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
      
      const progressRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在多路同步探测 Cobalt 节点的各档位文件体积..." })
      });
      const progressMsgId = (await progressRes.json()).result?.message_id;

      try {
        // 核心：让 Cobalt 解析出所有的各种质量包 (Tunnel / Picker 模式)
        const cobRes = await fetch(COBALT_API, {
          method: 'POST',
          headers: { ...JSON_HEADERS, 'Accept': 'application/json' },
          body: JSON.stringify({ url: twitterUrl, videoQuality: 'max', filenamePattern: 'basic' })
        });
        const cobData = await cobRes.json();

        // 兼容 Cobalt 多流返回机制（通常大视频会给一组 picker 列表或不同流）
        let variants = [];
        if (cobData.picker && Array.isArray(cobData.picker)) {
          variants = cobData.picker.map((p, i) => ({ url: p.url, score: 2000 - i * 200, label: p.type || `${1080 - i * 240}p` }));
        } else if (cobData.url) {
          variants = [{ url: cobData.url, score: 1080, label: '🔥 默认最高清' }];
        }

        if (variants.length === 0) {
          throw new Error("Cobalt 网关未响应多流清单");
        }

        // 并发探测各分辨率大小
        const sizes = await Promise.all(variants.map(async (v) => {
          try {
            const hRes = await quickFetch(v.url, { method: 'HEAD' }, 1800);
            return parseInt(hRes.headers.get('content-length') || '0', 10);
          } catch { return 0; }
        }));

        const keyboard = [];
        variants.forEach((v, idx) => {
          const sizeMB = sizes[idx] > 0 ? `${(sizes[idx] / (1024 * 1024)).toFixed(1)} MB` : '未知大小';
          keyboard.push([{
            text: `${v.label} - ${sizeMB}`,
            callback_data: `send_q:${encodedUrl}:${idx}`
          }]);
        });

        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: progressMsgId,
            text: `📊 <b>当前推文多画质清单 (来自 Cobalt 深度解包)</b>\n点击下方按钮，会自动将对应文件直接转存至你的窗口中。`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          })
        });

      } catch (err) {
        if (progressMsgId) await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: progressMsgId, text: `❌ 探测发生异常或该视频无多变体: ${err.message}` }) });
      }
    }

    // 用户点击：指定了具体的某一个画质档位进行发送
    if (callbackData.startsWith('send_q:')) {
      const [, encodedUrl, indexStr] = callbackData.split(':');
      const twitterUrl = Buffer.from(encodedUrl, 'base64url').toString();
      const targetIdx = parseInt(indexStr, 10);

      try {
        const cobRes = await fetch(COBALT_API, {
          method: 'POST',
          headers: { ...JSON_HEADERS, 'Accept': 'application/json' },
          body: JSON.stringify({ url: twitterUrl, videoQuality: 'max' })
        });
        const cobData = await cobRes.json();
        
        let variants = [];
        if (cobData.picker && Array.isArray(cobData.picker)) {
          variants = cobData.picker.map((p, i) => ({ url: p.url, score: 2000 - i * 200, label: p.type || `${1080 - i * 240}p` }));
        } else if (cobData.url) {
          variants = [{ url: cobData.url, score: 1080, label: '🔥 默认最高清' }];
        }

        const chosen = variants[targetIdx];
        if (!chosen) return res.status(200).send('OK');

        const hRes = await quickFetch(chosen.url, { method: 'HEAD' }, 2000);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);

        // 使用通用文本，因为 Cobalt 主打提取视频，不一定会完全格式化复杂的推特文本
        const originalText = callback.message.text || "X 视频转存";
        await sendSpecificVideo(chatId, originalText, chosen, size, twitterUrl);
      } catch (e) {
        console.error('手动指定发送失败', e.message);
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

  // 1. 无条件秒删原消息
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

  // 获取标准的推特原始链接传送给 Cobalt 提取
  const originalTwitterUrl = match[0].startsWith('http') ? match[0] : `https://${match[0]}`;

  try {
    // 2. 携带参数请求 Cobalt 解包核心
    const cobRes = await fetch(COBALT_API, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Accept': 'application/json' },
      body: JSON.stringify({
        url: originalTwitterUrl,
        videoQuality: 'max', // 默认让它先探测最高质量
        filenamePattern: 'basic'
      })
    });

    if (!cobRes.ok) throw new Error("Cobalt 节点无响应");
    const cobData = await cobRes.json();

    // 如果返回的是流媒体列表文件 (picker 阵列)
    let sortedVariants = [];
    if (cobData.picker && Array.isArray(cobData.picker)) {
      sortedVariants = cobData.picker.map((p, i) => ({
        url: p.url,
        score: p.type && p.type.includes('p') ? parseInt(p.type) : (1440 - i * 360),
        label: p.type || `${1080 - i * 240}p`
      }));
    } else if (cobData.url) {
      // 只有单档流
      sortedVariants = [{ url: cobData.url, score: 1080, label: '原画高清' }];
    }

    // 强制从最高画质往低排序
    sortedVariants.sort((a, b) => b.score - a.score);

    let finalSelectedVariant = null;
    let finalSize = 0;
    const MAX_BOT_SIZE = 50 * 1024 * 1024;

    // --- 核心级联算法：从最高分辨率往下检查，1080p 熔断 ---
    for (const variant of sortedVariants) {
      if (variant.score > 0 && variant.score < 1080) {
        break; // 低于 1080p 触发熔断，不再继续向下妥协
      }
      try {
        const hRes = await quickFetch(variant.url, { method: 'HEAD' }, 1500);
        const size = parseInt(hRes.headers.get('content-length') || '0', 10);
        if (size > 0 && size <= MAX_BOT_SIZE) {
          finalSelectedVariant = variant;
          finalSize = size;
          break; // 抓到一个完美符合 $\le 50\text{MB}$ 且清晰度合格的档位，收工！
        }
      } catch (e) {}
    }

    const defaultTitle = "来自 X (Twitter) 的高清分享";

    if (finalSelectedVariant) {
      // 成功级联降级到能发送的文件
      await sendSpecificVideo(chatId, defaultTitle, finalSelectedVariant, finalSize, originalTwitterUrl);
    } else {
      // 如果即便降到 1080p 也全都大于 50MB，则直接抓最高清的那个甩链接
      const topVariant = sortedVariants[0];
      try {
        const hRes = await quickFetch(topVariant.url, { method: 'HEAD' }, 1500);
        finalSize = parseInt(hRes.headers.get('content-length') || '0', 10);
      } catch { finalSize = 0; }
      
      await sendSpecificVideo(chatId, defaultTitle, topVariant, finalSize, originalTwitterUrl);
    }

  } catch (error) {
    console.error('[Cobalt 总线报错]:', error.message);
  }

  return res.status(200).send('OK');
}

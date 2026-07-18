const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; 
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// HTML 安全转义，防止推文自带特殊符号导致 TG 报错拒收
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const msg = req.body.message;
  if (!msg || !msg.text) return res.status(200).send('OK');

  if (ALLOWED_USER_ID && String(msg.from?.id) !== String(ALLOWED_USER_ID)) {
    return res.status(200).send('OK');
  }

  const text = msg.text;
  const chatId = msg.chat.id;

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

    // 重新编排的极简精美格式
    const safeText = escapeHTML(tweet.text);
    const authorLink = `https://x.com/${tweet.author.screen_name}`;
    const originalTweetLink = `https://x.com/i/status/${tweetId}`;
    
    // 作者名挂载跳转链接，长链接收纳进最后一行“查看原推特”中
    const caption = `📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n🔗 <a href="${originalTweetLink}">查看原推特</a>`;

    const media = tweet.media || {};
    const videos = media.videos || [];
    const photos = media.photos || [];

    if (videos.length > 0) {
      const videoUrl = videos[0].url;
      let contentLength = 0;

      try {
        const headRes = await quickFetch(videoUrl, { method: 'HEAD' }, 2000);
        contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
      } catch (e) {
        console.warn('大小探测失败');
      }

      const MAX_URL_SIZE = 20 * 1024 * 1024;
      const MAX_BOT_SIZE = 50 * 1024 * 1024; 

      if (contentLength > 0 && contentLength <= MAX_URL_SIZE) {
        await fetch(`${TELEGRAM_API}/sendVideo`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, video: videoUrl, caption, parse_mode: 'HTML' })
        });
      } else if (contentLength > MAX_URL_SIZE && contentLength <= MAX_BOT_SIZE) {
        const videoRes = await quickFetch(videoUrl, {}, 5000); 
        const arrayBuffer = await videoRes.arrayBuffer();
        
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        
        const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
        formData.append('video', videoBlob, 'video.mp4');

        await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
      } else {
        // 大于 50MB 的超大视频排版同步优化
        const sizeInMB = contentLength > 0 ? (contentLength / (1024 * 1024)).toFixed(1) : '未知';
        const overSizeCaption = `📝 ${safeText}\n\n👤 作者: <a href="${authorLink}">${escapeHTML(tweet.author.name)}</a>\n\n⚠️ 提示：视频过大 (${sizeInMB}MB) 无法直接保存\n🚀 <a href="${videoUrl}">点此下载高清原片</a> | <a href="${originalTweetLink}">查看原推特</a>`;
        
        await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'HTML' })
        });
      }
    } else if (photos.length > 0) {
      if (photos.length === 1) {
        await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, photo: photos[0].url, caption, parse_mode: 'HTML' })
        });
      } else {
        const mediaGroup = photos.map((p, idx) => ({
          type: 'photo',
          media: p.url,
          caption: idx === 0 ? caption : '',
          parse_mode: idx === 0 ? 'HTML' : undefined
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
    console.error('[报错]:', error.message);
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, text: '❌ 资料转存出现网络波动，请稍后再试。' })
    }).catch(() => {});
  }

  return res.status(200).send('OK');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; // 你的个人 TG ID 锁
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 受控的高速 Fetch
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

  // 【安全锁】非你本人发送，机器人直接装死，保护 Vercel 额度
  if (ALLOWED_USER_ID && String(msg.from?.id) !== String(ALLOWED_USER_ID)) {
    return res.status(200).send('OK');
  }

  const text = msg.text;
  const chatId = msg.chat.id;

  // 正则命中推特链接
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

    const caption = `📝 ${tweet.text}\n\n👤 作者: ${tweet.author.name} (@${tweet.author.screen_name})`;
    const media = tweet.media || {};
    const videos = media.videos || [];
    const photos = media.photos || [];

    // --- 核心逻辑：50MB分流转存 ---
    if (videos.length > 0) {
      const videoUrl = videos[0].url; // 获取最高清直链
      let contentLength = 0;

      try {
        // 探测视频大小
        const headRes = await quickFetch(videoUrl, { method: 'HEAD' }, 2000);
        contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
      } catch (e) {
        console.warn('大小探测失败');
      }

      const MAX_URL_SIZE = 20 * 1024 * 1024; // 20MB
      const MAX_BOT_SIZE = 50 * 1024 * 1024; // 50MB 

      if (contentLength > 0 && contentLength <= MAX_URL_SIZE) {
        // 【情况 A】小于 20MB：秒级转存到 TG
        await fetch(`${TELEGRAM_API}/sendVideo`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, video: videoUrl, caption })
        });
      } else if (contentLength > MAX_URL_SIZE && contentLength <= MAX_BOT_SIZE) {
        // 【情况 B】20MB ~ 50MB：中转成文件流上传，强行留存
        const videoRes = await quickFetch(videoUrl, {}, 5000); 
        const arrayBuffer = await videoRes.arrayBuffer();
        
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        formData.append('caption', caption);
        
        const videoBlob = new Blob([arrayBuffer], { type: 'video/mp4' });
        formData.append('video', videoBlob, 'video.mp4');

        await fetch(`${TELEGRAM_API}/sendVideo`, { method: 'POST', body: formData });
      } else {
        // 【情况 C】大于 50MB：吐出链接，你自己去点着下载
        const sizeInMB = contentLength > 0 ? (contentLength / (1024 * 1024)).toFixed(1) : '未知';
        const overSizeCaption = `${caption}\n\n⚠️ **提示**：该视频体积太大 (${sizeInMB}MB)，已超过 TG 机器人永久保存的限制。\n\n🚀 [点此直接下载无损高清原片到本地](${videoUrl})`;
        
        await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, text: overSizeCaption, parse_mode: 'Markdown' })
        });
      }
    } else if (photos.length > 0) {
      // 图片转存（永久留存）
      if (photos.length === 1) {
        await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, photo: photos[0].url, caption })
        });
      } else {
        const mediaGroup = photos.map((p, idx) => ({
          type: 'photo',
          media: p.url,
          caption: idx === 0 ? caption : ''
        }));
        await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, media: mediaGroup })
        });
      }
    } else {
      // 纯文本
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, text: caption })
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

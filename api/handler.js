const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendVideoDirectly(chatId, videoUrl, caption) {
  // 核心：直接发 URL，让 Telegram 服务端自己去拉取，速度极快
  return await fetch(`${TELEGRAM_API}/sendVideo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      video: videoUrl,
      caption: caption,
      parse_mode: 'HTML'
    })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const { message } = req.body;
  if (!message || !message.text) return res.status(200).send('OK');

  // 权限检查
  if (ALLOWED_USER_ID && String(message.from.id) !== String(ALLOWED_USER_ID)) {
    return res.status(200).send('OK');
  }

  const text = message.text;
  const twitterRegex = /(?:x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/(\d+)/i;
  const match = text.match(twitterRegex);
  if (!match) return res.status(200).send('OK');

  const tweetId = match[1];

  try {
    // 1. 获取视频信息 (利用 fxtwitter 的轻量接口)
    const fxRes = await fetch(`https://api.fxtwitter.com/i/status/${tweetId}`);
    const fxData = await fxRes.json();

    if (!fxData.tweet || !fxData.tweet.media?.videos?.[0]) {
      throw new Error("未能解析视频");
    }

    const videoUrl = fxData.tweet.media.videos[0].url;
    const caption = `✅ <b>解析成功</b>\n🔗 <a href="https://x.com/i/status/${tweetId}">查看原推特</a>`;

    // 2. 直接发送 (不再下载，不走 buffer)
    const sendRes = await sendVideoDirectly(message.chat.id, videoUrl, caption);
    
    // 3. 如果发送成功，删除原消息
    if (sendRes.ok) {
      await fetch(`${TELEGRAM_API}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: message.chat.id, message_id: message.message_id })
      });
    }

  } catch (error) {
    console.error("处理失败:", error);
  }

  return res.status(200).send('OK');
}

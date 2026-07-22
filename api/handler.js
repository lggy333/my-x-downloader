const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID_ENV = process.env.CHANNEL_ID;
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()).filter(Boolean) : [];
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID;
const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 单实例队列 & 全局 429 熔断冷却器
// ---------------------------------------------------------
let nextAllowedCopyTime = 0;
let copyTaskQueue = Promise.resolve();

function enqueueTask(taskFn) {
  const result = copyTaskQueue.then(() => taskFn());
  copyTaskQueue = result.catch(() => {});
  return result;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------
// Telegram API 请求封装
// ---------------------------------------------------------
async function telegramFetch(url, options, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const apiMethod = url.split('/').pop();

  try {
    options.signal = controller.signal;
    const response = await fetch(url, options);
    clearTimeout(timeoutId);

    const data = await response.json().catch(() => null);

    if (response.status === 429) {
      const retryAfter = data?.parameters?.retry_after || 5;
      console.warn(`🚨 [429 限流] ${apiMethod} | retry_after: ${retryAfter}s`);
      return { ok: false, isRateLimit: true, retryAfter, data };
    }

    if (!response.ok) {
      return { ok: false, httpStatus: response.status, data };
    }

    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, isTimeout: err.name === 'AbortError', error: err };
  }
}

// ---------------------------------------------------------
// Redis 封装与 60s 长效配置缓存
// ---------------------------------------------------------
async function redisCmd(command, ...args) {
  if (!UPSTASH_REST_URL || !UPSTASH_REST_TOKEN) return { ok: false, error: '未配置 Redis' };
  try {
    const endpoint = [command, ...args].map(a => encodeURIComponent(a)).join('/');
    const res = await fetch(`${UPSTASH_REST_URL}/${endpoint}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REST_TOKEN}` }
    });
    const data = await res.json();
    if (res.status !== 200 || data.error) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

let cachedSettings = null;
let cachedSettingsTime = 0;
async function getBotSettingsCached() {
  const now = Date.now();
  if (cachedSettings && (now - cachedSettingsTime < 60000)) return cachedSettings;

  const dedupRes = await redisCmd('get', 'config:dedup_enabled');
  const backupRes = await redisCmd('get', 'config:backup_enabled');
  cachedSettings = {
    dedupEnabled: dedupRes.result !== '0',
    backupEnabled: backupRes.result !== '0'
  };
  cachedSettingsTime = now;
  return cachedSettings;
}

// ---------------------------------------------------------
// Telegram 跳转链接生成
// ---------------------------------------------------------
function getMessageLink(chatId, messageId) {
  const strId = String(chatId);
  if (strId.startsWith('-100')) {
    return `https://t.me/c/${strId.replace('-100', '')}/${messageId}`;
  }
  return `https://t.me/${strId.replace('@', '')}/${messageId}`;
}

// ---------------------------------------------------------
// Redis 去重记录：兼容旧值 "1"，新值存最早消息位置
// ---------------------------------------------------------
export function buildDedupRecord(chatId, messageId, now = 0) {
  return JSON.stringify({
    chatId: String(chatId),
    messageId,
    createdAt: now
  });
}

export function parseDedupRecord(value) {
  if (!value) {
    return { exists: false, hasSourceMessage: false, chatId: null, messageId: null };
  }

  if (value === '1') {
    return { exists: true, hasSourceMessage: false, chatId: null, messageId: null };
  }

  try {
    const data = JSON.parse(value);
    if (data?.chatId && Number.isInteger(data?.messageId)) {
      return {
        exists: true,
        hasSourceMessage: true,
        chatId: String(data.chatId),
        messageId: data.messageId
      };
    }
  } catch {
    // 非 JSON 的老数据也按已去重处理，避免误删历史记录。
  }

  return { exists: true, hasSourceMessage: false, chatId: null, messageId: null };
}

export function shouldResetStaleDedupRecord(copyResult) {
  if (copyResult?.isRateLimit || copyResult?.isTimeout) return false;
  return copyResult?.httpStatus === 400 || copyResult?.httpStatus === 403;
}

// ---------------------------------------------------------
// 重复文件备份：发文本链接 + copy 当前重复文件备份
// ---------------------------------------------------------
async function sendDuplicateNotice(chatTitle, currentMessageId, meta, sourceRecord) {
  if (!ADMIN_USER_ID) return { noticeSent: false };

  const sourceLink = sourceRecord.hasSourceMessage
    ? getMessageLink(sourceRecord.chatId, sourceRecord.messageId)
    : null;
  const fileNameText = meta.fileName ? `\n文件：${meta.fileName}` : '';
  const sourceText = sourceLink
    ? `\n最早消息：${sourceLink}`
    : '\n最早消息：旧版记录未保存消息位置';

  return telegramFetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      chat_id: ADMIN_USER_ID,
      text: `检测到重复文件\n频道：${chatTitle}\n类型：${meta.mediaType}${fileNameText}\n大小：${meta.fileSizeFormatted}\n当前消息ID：${currentMessageId}${sourceText}`,
      disable_web_page_preview: true
    })
  });
}

async function copyMessageToAdmin(fromChatId, messageId) {
  if (!ADMIN_USER_ID) return { ok: false, error: '未配置管理员' };
  return telegramFetch(`${TELEGRAM_API}/copyMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      chat_id: ADMIN_USER_ID,
      from_chat_id: fromChatId,
      message_id: messageId
    })
  });
}

// ---------------------------------------------------------
// 队列驱动 + 熔断 + maxRetries=2 次重试 (针对正常非重复消息)
// ---------------------------------------------------------
async function executeCopyTaskWithRetry(chatId, fromChatId, messageId, maxRetries = 2) {
  return enqueueTask(async () => {
    for (let i = 0; i < maxRetries; i++) {
      const now = Date.now();
      if (now < nextAllowedCopyTime) {
        await sleep(nextAllowedCopyTime - now);
      }

      await sleep(350);

      const res = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, from_chat_id: fromChatId, message_id: messageId })
      });

      if (res.ok && res.data?.ok) return { success: true };

      if (res.isRateLimit) {
        nextAllowedCopyTime = Date.now() + (res.retryAfter * 1000) + 350;
        await sleep((res.retryAfter * 1000) + 350);
        continue;
      }

      await sleep(500 * Math.pow(2, i));
    }
    return { success: false };
  });
}

// ---------------------------------------------------------
// 删除消息与失败异常监控
// ---------------------------------------------------------
async function safeDeleteMessage(chatId, messageId) {
  const delRes = await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });

  if (!delRes.ok) {
    console.error(`❌ [Delete Failed] chat_id: ${chatId} | message_id: ${messageId} | Status: ${delRes.httpStatus || 'Network Error'}`);
  }
}

// ---------------------------------------------------------
// Webhook 主入口
// ---------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const body = req.body || {};

  try {
    const message = body.channel_post || body.message;
    if (!message) return res.status(200).send('OK');
    if (!BOT_TOKEN || ALLOWED_CHANNELS.length === 0) return res.status(200).send('OK');

    const currentChatId = String(message.chat.id);
    if (!ALLOWED_CHANNELS.includes(currentChatId)) return res.status(200).send('OK');
    if (message.author_signature === 'Bot' || message.from?.is_bot) return res.status(200).send('OK');

    const video = message.video;
    const photo = message.photo;
    const animation = message.animation;
    const document = message.document;

    if (!video && !photo && !animation && !document) return res.status(200).send('OK');

    const messageId = message.message_id;
    const chatTitle = message.chat.title || currentChatId;

    let uniqueId = null;
    let rawSizeBytes = 0;
    let fileName = null;
    let mediaType = 'Unknown';

    if (video) {
      uniqueId = video.file_unique_id;
      rawSizeBytes = video.file_size || 0;
      fileName = video.file_name || null;
      mediaType = 'Video';
    } else if (photo) {
      uniqueId = photo[photo.length - 1].file_unique_id;
      rawSizeBytes = photo[photo.length - 1].file_size || 0;
      mediaType = 'Photo';
    } else if (animation) {
      uniqueId = animation.file_unique_id;
      rawSizeBytes = animation.file_size || 0;
      fileName = animation.file_name || null;
      mediaType = 'Animation';
    } else if (document) {
      uniqueId = document.file_unique_id;
      rawSizeBytes = document.file_size || 0;
      fileName = document.file_name || null;
      mediaType = 'Document';
    }

    const fileSizeFormatted = rawSizeBytes > 0
      ? (rawSizeBytes > 1048576 ? `${(rawSizeBytes / 1048576).toFixed(2)} MB` : `${(rawSizeBytes / 1024).toFixed(1)} KB`)
      : 'Unknown';

    const settings = await getBotSettingsCached();

    // ---------------------------------------------------------
    // 分支 1: Redis 去重拦截
    // ---------------------------------------------------------
    if (uniqueId && settings.dedupEnabled) {
      const redisKey = `file:${currentChatId}:${uniqueId}`;
      const setRes = await redisCmd('set', redisKey, buildDedupRecord(currentChatId, messageId, Date.now()), 'NX');

      if (setRes.ok && setRes.result !== 'OK') {
        const existingRes = await redisCmd('get', redisKey);
        const sourceRecord = parseDedupRecord(existingRes.ok ? existingRes.result : null);

        if (sourceRecord.hasSourceMessage) {
          if (!settings.backupEnabled || !ADMIN_USER_ID) {
            await safeDeleteMessage(currentChatId, messageId);
            return res.status(200).send('OK');
          }

          const sourceCopyRes = await copyMessageToAdmin(sourceRecord.chatId, sourceRecord.messageId);

          if (sourceCopyRes.ok && sourceCopyRes.data?.ok) {
            await sendDuplicateNotice(chatTitle, messageId, {
              mediaType, fileName, fileSizeFormatted
            }, sourceRecord);
            await safeDeleteMessage(currentChatId, messageId);
            return res.status(200).send('OK');
          }

          if (shouldResetStaleDedupRecord(sourceCopyRes)) {
            await redisCmd('del', redisKey);
            const resetRes = await redisCmd('set', redisKey, buildDedupRecord(currentChatId, messageId, Date.now()), 'NX');
            if (!resetRes.ok || resetRes.result !== 'OK') {
              await safeDeleteMessage(currentChatId, messageId);
              return res.status(200).send('OK');
            }
          } else {
            await safeDeleteMessage(currentChatId, messageId);
            return res.status(200).send('OK');
          }
        } else {
          if (settings.backupEnabled && ADMIN_USER_ID) {
            await sendDuplicateNotice(chatTitle, messageId, {
              mediaType, fileName, fileSizeFormatted
            }, sourceRecord);
            await copyMessageToAdmin(currentChatId, messageId);
          }

          await safeDeleteMessage(currentChatId, messageId);
          return res.status(200).send('OK');
        }
      }
    }

    // ---------------------------------------------------------
    // 分支 2: 正常新消息（复制无头卡片并删除原消息）
    // ---------------------------------------------------------
    const copyProcess = await executeCopyTaskWithRetry(currentChatId, currentChatId, messageId);

    if (copyProcess.success) {
      await safeDeleteMessage(currentChatId, messageId);
    }

    return res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(200).send('OK');
  }
}

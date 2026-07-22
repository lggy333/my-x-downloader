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
async function telegramFetch(url, options, timeoutMs = 7000) {
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
// Redis 封装与 60s 配置缓存
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
    dedupEnabled: dedupRes.ok ? dedupRes.result !== '0' : false,
    backupEnabled: backupRes.ok ? backupRes.result !== '0' : false
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
// 异步备份任务 (留底记录)
// ---------------------------------------------------------
async function processDuplicateBackup(chatTitle, fromChatId, messageId, meta) {
  if (!ADMIN_USER_ID) return null;

  const msgLink = getMessageLink(fromChatId, messageId);
  let adminMsgId = null;
  let backupSuccess = false;

  const fwdRes = await telegramFetch(`${TELEGRAM_API}/forwardMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: ADMIN_USER_ID, from_chat_id: fromChatId, message_id: messageId })
  });

  if (fwdRes.ok && fwdRes.data?.ok) {
    backupSuccess = true;
    adminMsgId = fwdRes.data.result.message_id;
  } else {
    const copyRes = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: ADMIN_USER_ID, from_chat_id: fromChatId, message_id: messageId })
    });
    if (copyRes.ok && copyRes.data?.ok) {
      backupSuccess = true;
      adminMsgId = copyRes.data.result.message_id;
    }
  }

  const fileNameText = meta.fileName ? `\n📁 **文件：** \`${meta.fileName}\`` : '';
  const statusNotice = !backupSuccess ? '\n⚠️ *(备份失败：源消息权限受限)*' : '';

  await telegramFetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      chat_id: ADMIN_USER_ID,
      text: `⚠️ **检测到重复文件**\n\n📢 **频道：** ${chatTitle}\n📦 **类型：** ${meta.mediaType}${fileNameText}\n📊 **大小：** ${meta.fileSizeFormatted}\n🆔 **消息ID：** \`${messageId}\`${statusNotice}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: `🔗 原消息 (#${messageId})`, url: msgLink }]]
      }
    })
  });

  return adminMsgId;
}

// ---------------------------------------------------------
// 核心复制队列
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

      if (res.ok && res.data?.ok) {
        return { success: true, messageId: res.data.result.message_id };
      }

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
// 静默删除
// ---------------------------------------------------------
async function safeDeleteMessage(chatId, messageId) {
  const delRes = await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });

  if (!delRes.ok) {
    console.warn(`⚠️ [Delete Failed] chat_id: ${chatId} | message_id: ${messageId}`);
  }
}

// ---------------------------------------------------------
// 辅助工具：下发跳转提醒卡片
// ---------------------------------------------------------
async function sendDuplicateNotice(chatId, targetChatId, originMsgId) {
  const originLink = getMessageLink(targetChatId, originMsgId);
  await telegramFetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ 
      chat_id: chatId, 
      text: `🔗 **发现重复文件**\n[点击跳转查看原消息](${originLink})`, 
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    })
  });
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
    // 分支 1: Redis 查重拦截 (直接拦截 + 老数据兼容)
    // ---------------------------------------------------------
    if (uniqueId && settings.dedupEnabled) {
      const redisKey = `file:${currentChatId}:${uniqueId}`;
      const recordRes = await redisCmd('get', redisKey);

      if (!recordRes.ok) {
        console.error('❌ Redis 连接异常，终止处理以保护数据');
        return res.status(200).send('OK');
      }

      if (recordRes.result !== null) {
        const valStr = String(recordRes.result);

        // 1.1 处理新 JSON 数据格式
        let originData = null;
        try { originData = JSON.parse(valStr); } catch (e) { originData = null; }

        if (originData && originData.origin_message_id) {
          const targetChatId = originData.origin_chat_id || currentChatId;
          const originMsgId = originData.origin_message_id;
          
          await safeDeleteMessage(currentChatId, messageId);
          await sendDuplicateNotice(currentChatId, targetChatId, originMsgId);
          return res.status(200).send('OK');
        }

        // 1.2 兼容老数据 "1"：备份后直接删掉
        if (valStr === "1") {
          if (settings.backupEnabled && ADMIN_USER_ID) {
            processDuplicateBackup(chatTitle, currentChatId, messageId, {
              mediaType, fileName, fileSizeFormatted
            }).catch(() => {});
          }
          await safeDeleteMessage(currentChatId, messageId);
          return res.status(200).send('OK');
        }
      }
    }

    // ---------------------------------------------------------
    // 分支 2: 正常新消息处理 (抢锁 SET NX -> 成功后备份 -> 删除原消息)
    // ---------------------------------------------------------
    // 步骤 1: 复制为无头消息
    const copyProcess = await executeCopyTaskWithRetry(currentChatId, currentChatId, messageId);

    if (copyProcess.success) {
      // 步骤 2: 尝试抢占写入 Redis
      if (uniqueId && settings.dedupEnabled) {
        const redisKey = `file:${currentChatId}:${uniqueId}`;
        
        // 极致轻量的数据结构
        const originPayload = JSON.stringify({
          origin_chat_id: currentChatId,
          origin_message_id: copyProcess.messageId,
          backup_message_id: null
        });

        // ⭐ SET ... NX: 防并发写入
        const setRes = await redisCmd('set', redisKey, originPayload, 'NX');
        
        // 【抢锁失败降级】：并发下被别人抢先写入了
        if (!setRes.ok || setRes.result !== "OK") {
          console.warn(`⚡ [高并发抢锁] 抢锁失败，降级为去重流程`);
          
          // 清理掉多余无头件和原始消息
          await safeDeleteMessage(currentChatId, copyProcess.messageId);
          await safeDeleteMessage(currentChatId, messageId);

          // 重新读取赢家记录，下发跳转
          const winRecord = await redisCmd('get', redisKey);
          if (winRecord.ok && winRecord.result) {
            try {
              const winData = JSON.parse(winRecord.result);
              if (winData.origin_message_id) {
                await sendDuplicateNotice(currentChatId, winData.origin_chat_id || currentChatId, winData.origin_message_id);
              }
            } catch (e) {}
          }
          return res.status(200).send('OK');
        }

        // 步骤 3: 只有抢锁成功（成为真正唯一赢家）后，才触发管理员备份！
        if (settings.backupEnabled && ADMIN_USER_ID) {
          const backupMsgId = await processDuplicateBackup(chatTitle, currentChatId, messageId, {
            mediaType, fileName, fileSizeFormatted
          }).catch(() => null);

          // 备份成功后，补写一次 backup_message_id 留底
          if (backupMsgId) {
            const updatedPayload = JSON.stringify({
              origin_chat_id: currentChatId,
              origin_message_id: copyProcess.messageId,
              backup_message_id: backupMsgId
            });
            await redisCmd('set', redisKey, updatedPayload);
          }
        }
      }

      // 步骤 4: 顺利删除带头的用户原始消息
      await safeDeleteMessage(currentChatId, messageId);
    }

    return res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook Unhandled Error:', err);
    return res.status(200).send('OK');
  }
}

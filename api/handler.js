const BOT_TOKEN = process.env.BOT_TOKEN; 
const CHANNEL_ID_ENV = process.env.CHANNEL_ID; 
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()).filter(Boolean) : [];
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID;
const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 1. 单实例队列 & 全局 429 熔断冷却器
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
// 2. Telegram API 请求封装
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
// 3. Redis 操作封装与配置缓存
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
    dedupEnabled: dedupRes.ok ? dedupRes.result !== '0' : true,
    backupEnabled: backupRes.ok ? backupRes.result !== '0' : true
  };
  cachedSettingsTime = now;
  return cachedSettings;
}

function clearSettingsCache() {
  cachedSettings = null;
}

// ---------------------------------------------------------
// 4. 管理后台辅助工具函数 (从最早版本移植)
// ---------------------------------------------------------
async function getChannelsInfo() {
  const list = [];
  for (const id of ALLOWED_CHANNELS) {
    const res = await telegramFetch(`${TELEGRAM_API}/getChat`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: id })
    });
    if (res.ok && res.data?.ok) {
      list.push({ id, title: res.data.result.title || id });
    } else {
      list.push({ id, title: `未命名频道 (${id})` });
    }
  }
  return list;
}

async function getChannelKeyCount(channelId) {
  const pattern = channelId ? `file:${channelId}:*` : `file:*`;
  const keysRes = await redisCmd('keys', pattern);
  return keysRes.ok && Array.isArray(keysRes.result) ? keysRes.result.length : 0;
}

async function clearChannelKeys(channelId) {
  const pattern = channelId ? `file:${channelId}:*` : `file:*`;
  const keysRes = await redisCmd('keys', pattern);
  if (!keysRes.ok || !Array.isArray(keysRes.result) || keysRes.result.length === 0) {
    return { ok: true, count: 0 };
  }

  const keys = keysRes.result;
  const pipelineBody = keys.map(k => ["DEL", k]);
  
  try {
    await fetch(`${UPSTASH_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipelineBody)
    });
    return { ok: true, count: keys.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function buildMainMenu() {
  const settings = await getBotSettingsCached();
  const text = `🤖 **控制面板**\n\n` +
               `点击下方按钮即可进行管理操作：`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "📢 选择频道管理记忆", callback_data: "select_channel" }
      ],
      [
        { text: `去重功能: ${settings.dedupEnabled ? '✅ 开启中' : '❌ 已暂停'}`, callback_data: "toggle_dedup" },
        { text: `私发备份: ${settings.backupEnabled ? '✅ 开启中' : '❌ 已关闭'}`, callback_data: "toggle_backup" }
      ],
      [
        { text: "🩺 一键系统自检", callback_data: "system_health" },
        { text: "🗑️ 清空所有记录", callback_data: "confirm_clean_all" }
      ]
    ]
  };

  return { text, reply_markup: keyboard };
}

// ---------------------------------------------------------
// 5. 频道处理专用工具函数
// ---------------------------------------------------------
function getMessageLink(chatId, messageId) {
  const strId = String(chatId);
  if (strId.startsWith('-100')) {
    return `https://t.me/c/${strId.replace('-100', '')}/${messageId}`;
  }
  return `https://t.me/${strId.replace('@', '')}/${messageId}`;
}

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

async function safeDeleteMessage(chatId, messageId) {
  await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

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
// 6. Webhook 主入口 (完整三大路由分发)
// ---------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const body = req.body || {};

  try {
    // =========================================================
    // 路由 1：处理管理员后台交互按钮 (Callback Query)
    // =========================================================
    if (body.callback_query) {
      const cb = body.callback_query;
      const userId = String(cb.from.id);
      const cbId = cb.id;
      const chatId = cb.message.chat.id;
      const msgId = cb.message.message_id;

      if (ADMIN_USER_ID && userId !== String(ADMIN_USER_ID)) {
        await telegramFetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ callback_query_id: cbId, text: '⛔ 仅管理员可操作！', show_alert: true })
        });
        return res.status(200).send('OK');
      }

      const action = cb.data;

      if (action === 'menu_main') {
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
        });
      }
      else if (action === 'select_channel') {
        const channels = await getChannelsInfo();
        const buttons = channels.map(c => ([
          { text: `📢 ${c.title}`, callback_data: `view_chan_${c.id}` }
        ]));
        buttons.push([{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]);

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: `📢 **请点击要管理的频道名字：**`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
          })
        });
      }
      else if (action.startsWith('view_chan_')) {
        const chanId = action.replace('view_chan_', '');
        const count = await getChannelKeyCount(chanId);
        
        const resChan = await telegramFetch(`${TELEGRAM_API}/getChat`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chanId })
        });
        const title = resChan.ok ? resChan.data.result.title : chanId;

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: `📌 **频道名称：** \`${title}\`\n` +
                  `🆔 **频道 ID：** \`${chanId}\`\n` +
                  `💾 **已记录去重文件数：** \`${count}\` 个\n\n` +
                  `你可以点击下方按钮清空该频道的记忆，以便重新发送过往文件：`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: `🗑️ 清空「${title}」的去重记忆`, callback_data: `clean_chan_${chanId}` }],
                [{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]
              ]
            }
          })
        });
      }
      else if (action.startsWith('clean_chan_')) {
        const chanId = action.replace('clean_chan_', '');
        const resClean = await clearChannelKeys(chanId);
        const msgText = resClean.ok 
          ? `✅ **清理完成！**\n已清空该频道 \`${resClean.count}\` 条文件记忆。`
          : `❌ 清理失败：${resClean.error}`;

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: msgText,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]] }
          })
        });
      }
      else if (action === 'toggle_dedup') {
        const settings = await getBotSettingsCached();
        await redisCmd('set', 'config:dedup_enabled', settings.dedupEnabled ? '0' : '1');
        clearSettingsCache();
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
        });
      }
      else if (action === 'toggle_backup') {
        const settings = await getBotSettingsCached();
        await redisCmd('set', 'config:backup_enabled', settings.backupEnabled ? '0' : '1');
        clearSettingsCache();
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
        });
      }
      else if (action === 'confirm_clean_all') {
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: `⚠️ **高危操作确认**\n\n确定要清空**所有频道**的去重记忆吗？`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "🔥 确认彻底清空", callback_data: "do_clean_all" },
                  { text: "❌ 取消", callback_data: "menu_main" }
                ]
              ]
            }
          })
        });
      }
      else if (action === 'do_clean_all') {
        const resClean = await clearChannelKeys(null);
        const msgText = resClean.ok ? `✅ **全局清理成功！** 共清除 \`${resClean.count}\` 条数据库记录。` : `❌ 清理失败：${resClean.error}`;
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: msgText,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]] }
          })
        });
      }
      else if (action === 'system_health') {
        let report = `🩺 **系统健康自检报告**\n\n`;

        const startT = Date.now();
        const pingRes = await redisCmd('ping');
        const delay = Date.now() - startT;
        report += `💾 **Redis 数据库：** ${pingRes.ok ? `✅ 正常 (${delay}ms)` : `❌ 异常 (${pingRes.error})`}\n\n`;

        report += `📢 **频道管理员权限检测：**\n`;
        const channels = await getChannelsInfo();
        const botId = BOT_TOKEN ? BOT_TOKEN.split(':')[0] : '';
        for (const c of channels) {
          const memberRes = await telegramFetch(`${TELEGRAM_API}/getChatMember`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ chat_id: c.id, user_id: botId })
          });

          if (memberRes.ok && memberRes.data?.result?.status === 'administrator') {
            const adm = memberRes.data.result;
            const canDelete = adm.can_delete_messages ? '✅' : '❌无删除权限';
            const canPost = adm.can_post_messages ? '✅' : '❌无发帖权限';
            report += `• **${c.title}**\n  - 发帖: ${canPost} | 删帖: ${canDelete}\n`;
          } else {
            report += `• **${c.title}**\n  - ❌ 机器人未获取到管理员身份\n`;
          }
        }

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: report,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]] }
          })
        });
      }

      await telegramFetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ callback_query_id: cbId })
      });

      return res.status(200).send('OK');
    }

    // =========================================================
    // 路由 2：处理私聊消息（管理员弹出主控制面板）
    // =========================================================
    const message = body.channel_post || body.message;
    if (!message) return res.status(200).send('OK');
    if (!BOT_TOKEN || ALLOWED_CHANNELS.length === 0) return res.status(200).send('OK');

    const currentChatId = String(message.chat.id);
    const isPrivate = message.chat.type === 'private';
    const userId = String(message.from?.id || '');

    if (isPrivate) {
      if (ADMIN_USER_ID && userId !== String(ADMIN_USER_ID)) {
        return res.status(200).send('OK - Unauthorized');
      }
      const menu = await buildMainMenu();
      await telegramFetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: currentChatId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
      });
      return res.status(200).send('OK');
    }

    // =========================================================
    // 路由 3：核心频道转发去重逻辑 (原汁原味的优化版)
    // =========================================================
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
    // 分支 3.1: Redis 查重拦截 (拦截 + 老数据兼容)
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

        // 新 JSON 格式处理
        let originData = null;
        try { originData = JSON.parse(valStr); } catch (e) { originData = null; }

        if (originData && originData.origin_message_id) {
          const targetChatId = originData.origin_chat_id || currentChatId;
          const originMsgId = originData.origin_message_id;
          
          await safeDeleteMessage(currentChatId, messageId);
          await sendDuplicateNotice(currentChatId, targetChatId, originMsgId);
          return res.status(200).send('OK');
        }

        // 老数据 "1" 兼容处理
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
    // 分支 3.2: 正常新文件 (复制无头件 -> SET NX 抢锁 -> 备份 -> 删原件)
    // ---------------------------------------------------------
    const copyProcess = await executeCopyTaskWithRetry(currentChatId, currentChatId, messageId);

    if (copyProcess.success) {
      if (uniqueId && settings.dedupEnabled) {
        const redisKey = `file:${currentChatId}:${uniqueId}`;
        
        const originPayload = JSON.stringify({
          origin_chat_id: currentChatId,
          origin_message_id: copyProcess.messageId,
          backup_message_id: null
        });

        // SET NX 防并发
        const setRes = await redisCmd('set', redisKey, originPayload, 'NX');
        
        // 抢锁失败降级处理
        if (!setRes.ok || setRes.result !== "OK") {
          console.warn(`⚡ [高并发抢锁] 抢锁失败，降级为去重流程`);
          
          await safeDeleteMessage(currentChatId, copyProcess.messageId);
          await safeDeleteMessage(currentChatId, messageId);

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

        // 抢锁成功者（唯一赢家）触发备份
        if (settings.backupEnabled && ADMIN_USER_ID) {
          const backupMsgId = await processDuplicateBackup(chatTitle, currentChatId, messageId, {
            mediaType, fileName, fileSizeFormatted
          }).catch(() => null);

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

      // 删除用户带头的原始消息
      await safeDeleteMessage(currentChatId, messageId);
    }

    return res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook Unhandled Error:', err);
    return res.status(200).send('OK');
  }
}

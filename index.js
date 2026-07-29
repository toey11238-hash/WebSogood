const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, EmbedBuilder, ChannelType,
  PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

// ระบบข้อมูล/AI/UI ทั้งหมดถูกแยกออกไปอยู่ใน lib/ เพื่อให้ไฟล์นี้ (index.js) เหลือแค่ส่วน
// "เชื่อมต่อ Discord จริง" (Client, Event handlers) — ดูรายละเอียดแต่ละไฟล์ได้ที่คอมเมนต์หัวไฟล์ใน lib/
const storage = require('./lib/storage');
const ai = require('./lib/ai');
const panels = require('./lib/panels');

const {
  globalConfig, saveGlobalConfig, DEFAULT_GUILD_CONFIG,
  getGuildConfig, saveGuildConfig, resetGuildConfig, safeMergeGuildConfig,
  getLevelData, saveLevelData, resetLevelData, calculateLevel, makeProgressBar, parseRoleRewards,
  getGiveaways, saveGiveaways, parseDuration,
  getProphecies, saveProphecies,
  MODE_LABELS,
} = storage;

const {
  getAiResponse, generateImage,
  runCouncilDebate, runCouncilVerdict,
  generateProphecyText, generateProphecyEpilogue,
} = ai;

const {
  buildMainPanel, buildAdvancedPanel, buildAccessPanel, buildLevelingPanel, buildWelcomePanel, buildStatsPanel,
  buildAiReplyPayload, buildHelpEmbed, buildImagineEmbed, buildGiveawayEmbed, buildProphecyEmbed,
} = panels;

// ==========================================
// 🌐 0. Web Server สำหรับ Render (กันบอทหลับ) + Health/Status Endpoint
// ==========================================
const app = express();
const port = process.env.PORT || 3000;
const BOOT_TIME = Date.now();

app.get('/', (req, res) => {
  res.send('Discord AI Bot is running and awake! 🤖');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptimeMs: Date.now() - BOOT_TIME,
    guilds: global.__client ? global.__client.guilds.cache.size : 0,
    ready: global.__client ? global.__client.isReady() : false,
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🌐 Web server is running on port ${port}`);
});

// ==========================================
// ⚙️ 1. อ่านค่า Environment Variables
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID_RAW = process.env.OWNER_ID ? process.env.OWNER_ID.trim() : 'ALL';
const OWNER_IDS = OWNER_ID_RAW.split(',').map((id) => id.trim()).filter(Boolean);
const PANEL_COMMAND = process.env.PANEL_CMD ? process.env.PANEL_CMD.trim() : '!panel';

if (!TOKEN) {
  console.error('❌ ไม่พบ DISCORD_TOKEN ใน Environment Variables ของ Render!');
  process.exit(1);
}

// ตรวจสิทธิ์: เจ้าของบอท (OWNER_ID) หรือแอดมินเซิร์ฟเวอร์ (ถ้าเปิด allowAdminAccess ไว้ในตั้งค่าของกิลด์นั้น)
function checkHasPermission(userId, member, guildId) {
  if (OWNER_IDS.includes('ALL') || OWNER_IDS.length === 0) return true;
  if (OWNER_IDS.includes(userId)) return true;
  try {
    if (member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) {
      const gcfg = guildId ? getGuildConfig(guildId) : null;
      if (gcfg && gcfg.allowAdminAccess) return true;
    }
  } catch (e) {
    // เผื่อ getGuildConfig ยังไม่ถูกประกาศตอน hoisting - จะไม่มีทางเกิดเพราะ function declaration ถูก hoist อยู่แล้ว
  }
  return false;
}

// ==========================================
// 📦 หมายเหตุ: ระบบ Config (Global/Guild), ข้อมูลเลเวล, Giveaway, คำทำนาย, และตรรกะเรียก AI ทั้งหมด
// ถูกย้ายไปอยู่ใน lib/storage.js และ lib/ai.js แล้ว (ดูรายละเอียดที่ต้นไฟล์นั้นๆ)
// ไฟล์นี้ (index.js) เหลือแค่ส่วนที่ต้อง "เชื่อมกับ Discord จริง" เท่านั้น
// ==========================================

// ==========================================
// 🎨 4.5 ระบบสร้างภาพด้วย AI (ฟรี 100% ไม่ต้องมี API Key ใช้ Pollinations Image API)
// ==========================================
const IMAGE_GEN_COOLDOWN_SECONDS = 15; // กันสแปมยิงคำขอสร้างภาพรัวๆ (ค่าคงที่ทั้งบอท เพื่อความง่าย)
const imageGenCooldownMap = new Map();
function isOnImageGenCooldown(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const last = imageGenCooldownMap.get(key) || 0;
  const now = Date.now();
  if (now - last < IMAGE_GEN_COOLDOWN_SECONDS * 1000) return true;
  imageGenCooldownMap.set(key, now);
  return false;
}

// ==========================================
// 🏛️ 4.6 ระบบ "สภา AI" (AI Council) — เอาบุคลิกของบอทเอง 2 โหมด มาโต้วาทีกันสดๆ แล้วมีกรรมการ AI ตัดสิน
// ไอเดีย: ใช้โครงสร้าง MODE_PROMPTS ที่มีอยู่แล้วเป็น "ตัวละคร" มาเถียงกันในหัวข้อที่ผู้ใช้กำหนด
// แต่ละฝ่ายมีความจำของตัวเอง (เห็นแค่ฝั่งตัวเอง + คำพูดล่าสุดของอีกฝ่าย) เพื่อให้คงคาแรกเตอร์ตลอดการโต้วาที
// ==========================================
const COUNCIL_COOLDOWN_SECONDS = 60; // ใช้ AI หลายครั้งต่อ 1 คำสั่ง กันสแปมไว้นานหน่อย
const councilCooldownMap = new Map();
function isOnCouncilCooldown(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const last = councilCooldownMap.get(key) || 0;
  const now = Date.now();
  if (now - last < COUNCIL_COOLDOWN_SECONDS * 1000) return true;
  councilCooldownMap.set(key, now);
  return false;
}

// ==========================================
// 🔮 4.7 ระบบคำทำนาย AI (Prophecy) — ให้เหตุผลด้านความปลอดภัย: บังคับให้ AI พูดแนวสนุกสนานเกี่ยวกับ
// "บรรยากาศ/กิจกรรมในเซิร์ฟเวอร์" เท่านั้น ห้ามทำนายเรื่องจริงจัง (ภัยพิบัติ/การเมือง/ความรุนแรง/เรื่องส่วนตัว)
// เพื่อไม่ให้ใครเข้าใจผิดว่าเป็นการทำนายจริงจัง — เป็นฟีเจอร์เพื่อความบันเทิงล้วนๆ
// ==========================================
const PROPHECY_COOLDOWN_SECONDS = 30;
const prophecyCooldownMap = new Map();
function isOnProphecyCooldown(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const last = prophecyCooldownMap.get(key) || 0;
  const now = Date.now();
  if (now - last < PROPHECY_COOLDOWN_SECONDS * 1000) return true;
  prophecyCooldownMap.set(key, now);
  return false;
}



async function revealProphecy(guildId, messageId) {
  const prophecies = getProphecies(guildId);
  const p = prophecies[messageId];
  if (!p || p.revealed) return;

  try {
    const cfg = getGuildConfig(guildId);
    const epilogue = await generateProphecyEpilogue(cfg, p.prediction);
    p.revealed = true;
    p.epilogue = epilogue;
    saveProphecies(guildId);

    const channel = await client.channels.fetch(p.channelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const embed = buildProphecyEmbed(p.topic, p.prediction, p.revealTime, true, epilogue);
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed] }).catch(() => {});
      } else {
        await channel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('❌ เปิดผนึกคำทำนายล้มเหลว:', e.message);
  }
}

// เช็คทุก 30 วินาทีว่ามีคำทำนายไหนครบเวลาผนึกแล้วบ้าง (ดึงเซิร์ฟเวอร์จาก client แทน cache)
setInterval(() => {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const prophecies = getProphecies(guild.id);
    for (const [messageId, p] of Object.entries(prophecies)) {
      if (!p.revealed && p.revealTime <= now) {
        revealProphecy(guild.id, messageId).catch(() => {});
      }
    }
  }
}, 30000);

// ==========================================
// 🖼️ 5. สุ่มรูปโปรไฟล์ (เป็นค่าระดับบอททั้งตัว เพราะ Discord อนุญาตรูปโปรไฟล์บอทได้ค่าเดียว)
// ==========================================
const AVATAR_SOURCES = [
  { name: 'Waifu.pics', getUrl: async () => (await axios.get('https://api.waifu.pics/sfw/waifu', { timeout: 6000 })).data.url },
  { name: 'DiceBear', getUrl: async () => `https://api.dicebear.com/7.x/adventurer/png?seed=${Date.now()}` },
  { name: 'Picsum', getUrl: async () => `https://picsum.photos/seed/${Date.now()}/512` },
];

async function changeAvatarFromApi() {
  for (const src of AVATAR_SOURCES) {
    try {
      const imageUrl = await src.getUrl();
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 8000 });
      await client.user.setAvatar(Buffer.from(imgRes.data));
      return { success: true, source: src.name };
    } catch (e) {
      continue;
    }
  }
  return { success: false, source: null };
}

let avatarRotateInterval = null;
function startAvatarAutoRotate() {
  if (avatarRotateInterval) clearInterval(avatarRotateInterval);
  if (!globalConfig.avatarAutoRotate) return;
  const minutes = Math.max(5, globalConfig.avatarRotateMinutes || 60);
  avatarRotateInterval = setInterval(() => changeAvatarFromApi(), minutes * 60 * 1000);
  console.log(`🖼️ เปิดระบบสุ่มรูปโปรไฟล์อัตโนมัติทุก ${minutes} นาที`);
}

// ==========================================
// 💬 6. ระบบความจำบทสนทนา (Conversation Memory) - ทำให้บอทคุยแบบต่อเนื่องได้จริงแบบเรียลไทม์
// ==========================================
const MEMORY_TTL_MS = 30 * 60 * 1000; // ลืมอัตโนมัติถ้าไม่ได้คุยกันเกิน 30 นาที
const conversationMemory = new Map(); // key: "guildId:userId" -> { messages: [{role, content}], lastActive }

function getMemoryKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getConversationHistory(guildId, userId, cfg) {
  if (!cfg.memoryEnabled) return [];
  const key = getMemoryKey(guildId, userId);
  const entry = conversationMemory.get(key);
  if (!entry) return [];
  if (Date.now() - entry.lastActive > MEMORY_TTL_MS) {
    conversationMemory.delete(key);
    return [];
  }
  return entry.messages;
}

function pushConversationTurn(guildId, userId, cfg, userText, aiText) {
  if (!cfg.memoryEnabled) return;
  const key = getMemoryKey(guildId, userId);
  let entry = conversationMemory.get(key);
  if (!entry) entry = { messages: [], lastActive: Date.now() };
  entry.messages.push({ role: 'user', content: userText });
  entry.messages.push({ role: 'assistant', content: aiText });
  const maxMessages = Math.max(2, (cfg.memoryTurns || 6) * 2);
  while (entry.messages.length > maxMessages) entry.messages.shift();
  entry.lastActive = Date.now();
  conversationMemory.set(key, entry);
}

function popLastConversationTurn(guildId, userId) {
  const key = getMemoryKey(guildId, userId);
  const entry = conversationMemory.get(key);
  if (entry && entry.messages.length >= 2) {
    entry.messages.splice(entry.messages.length - 2, 2);
  }
}

function clearConversationHistory(guildId, userId) {
  conversationMemory.delete(getMemoryKey(guildId, userId));
}

// เก็บกวาดความจำที่หมดอายุทุก 5 นาที กันหน่วยความจำบวมตอนบอทรันนานๆ
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of conversationMemory.entries()) {
    if (now - entry.lastActive > MEMORY_TTL_MS) conversationMemory.delete(key);
  }
}, 5 * 60 * 1000);

// Loop ส่งสถานะ "กำลังพิมพ์..." ต่อเนื่องระหว่างรอ AI ตอบ (Discord typing indicator อยู่ได้แค่ ~10 วิ/ครั้ง)
function startTypingLoop(channel) {
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  return () => clearInterval(interval);
}

// ==========================================
// 📊 7. ระบบสถิติแบบเรียลไทม์ (แยกตามเซิร์ฟเวอร์ - เก็บในหน่วยความจำ รีเซ็ตเมื่อรีสตาร์ทบอท)
// ==========================================
const guildStats = new Map(); // guildId -> stats object

function startOfNextDay() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function getGuildStats(guildId) {
  if (!guildStats.has(guildId)) {
    guildStats.set(guildId, {
      startTime: Date.now(),
      totalMessages: 0,
      totalErrors: 0,
      providerUsage: {},   // providerName -> count
      lastProvider: null,
      lastLatencyMs: null,
      userCounts: {},      // userId -> count
      dailyCount: 0,
      dailyResetAt: startOfNextDay(),
    });
  }
  const stats = guildStats.get(guildId);
  if (Date.now() > stats.dailyResetAt) {
    stats.dailyCount = 0;
    stats.dailyResetAt = startOfNextDay();
  }
  return stats;
}

function resetGuildStats(guildId) {
  guildStats.set(guildId, {
    startTime: Date.now(),
    totalMessages: 0,
    totalErrors: 0,
    providerUsage: {},
    lastProvider: null,
    lastLatencyMs: null,
    userCounts: {},
    dailyCount: 0,
    dailyResetAt: startOfNextDay(),
  });
}

function recordStat(guildId, { userId, provider, latencyMs, error }) {
  const stats = getGuildStats(guildId);
  if (error) {
    stats.totalErrors++;
    return;
  }
  stats.totalMessages++;
  stats.dailyCount++;
  stats.lastProvider = provider;
  stats.lastLatencyMs = latencyMs;
  if (provider) stats.providerUsage[provider] = (stats.providerUsage[provider] || 0) + 1;
  if (userId) stats.userCounts[userId] = (stats.userCounts[userId] || 0) + 1;
}

// ==========================================
// ⏱️ 8. Cooldown (แยกตามเซิร์ฟเวอร์ + ผู้ใช้)
// ==========================================
const cooldownMap = new Map();
function isOnCooldown(guildId, userId, cooldownSeconds) {
  const key = `${guildId}:${userId}`;
  const last = cooldownMap.get(key) || 0;
  const now = Date.now();
  if (now - last < cooldownSeconds * 1000) return true;
  cooldownMap.set(key, now);
  return false;
}

// Cooldown แยกต่างหากสำหรับระบบเลเวล/XP (กันคนสแปมข้อความรัวๆเพื่อฟาร์ม XP)
const levelXpCooldownMap = new Map();
function isOnLevelCooldown(guildId, userId, cooldownSeconds) {
  const key = `${guildId}:${userId}`;
  const last = levelXpCooldownMap.get(key) || 0;
  const now = Date.now();
  if (now - last < cooldownSeconds * 1000) return true;
  levelXpCooldownMap.set(key, now);
  return false;
}

// ==========================================
// 🤖 9. Client Setup
// ==========================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});
global.__client = client;

// ==========================================
// 📟 10. Slash Commands (นอกเหนือจากคำสั่ง Prefix แบบเดิม)
// ==========================================
const slashCommandDefs = [
  new SlashCommandBuilder().setName('panel').setDescription('เปิดแผงควบคุมบอท AI (สำหรับเจ้าของบอท/แอดมิน)'),
  new SlashCommandBuilder().setName('avatar').setDescription('สุ่มเปลี่ยนรูปโปรไฟล์บอท (สำหรับเจ้าของบอท/แอดมิน)'),
  new SlashCommandBuilder().setName('stats').setDescription('ดูสถิติการใช้งานบอทแบบเรียลไทม์'),
  new SlashCommandBuilder().setName('help').setDescription('วิธีใช้งานบอท'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('ถามคำถามกับ AI โดยตรง')
    .addStringOption((opt) => opt.setName('คำถาม').setDescription('ข้อความที่ต้องการถาม AI').setRequired(true)),
  new SlashCommandBuilder().setName('reset-memory').setDescription('ล้างความจำบทสนทนาของคุณกับ AI ในเซิร์ฟเวอร์นี้'),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('ดูเลเวลและ XP ของคุณ (หรือของคนอื่น)')
    .addUserOption((opt) => opt.setName('ผู้ใช้').setDescription('ดูเลเวลของคนอื่น (ไม่ใส่ = ตัวเอง)').setRequired(false)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('ดูอันดับ XP สูงสุดในเซิร์ฟเวอร์นี้'),
  new SlashCommandBuilder()
    .setName('imagine')
    .setDescription('สร้างภาพด้วย AI จากคำบรรยาย (ฟรี ไม่ต้องมี API Key)')
    .addStringOption((opt) => opt.setName('พรอมต์').setDescription('บรรยายภาพที่ต้องการ (พิมพ์เป็นภาษาอังกฤษจะได้ผลลัพธ์ดีกว่า)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('จัดกิจกรรมแจกของรางวัลในเซิร์ฟเวอร์ (แอดมิน/เจ้าของบอท)')
    .addSubcommand((sub) => sub.setName('start').setDescription('เริ่มกิจกรรมแจกของรางวัลใหม่')
      .addStringOption((opt) => opt.setName('ระยะเวลา').setDescription('เช่น 30s, 10m, 2h, 1d (สูงสุด 28 วัน)').setRequired(true))
      .addStringOption((opt) => opt.setName('รางวัล').setDescription('ของรางวัลที่จะแจก').setRequired(true))
      .addIntegerOption((opt) => opt.setName('ผู้ชนะ').setDescription('จำนวนผู้ชนะ (ค่าเริ่มต้น 1)').setRequired(false).setMinValue(1).setMaxValue(20)))
    .addSubcommand((sub) => sub.setName('end').setDescription('จบกิจกรรมก่อนเวลาแล้วสุ่มผู้ชนะทันที')
      .addStringOption((opt) => opt.setName('message_id').setDescription('ID ของข้อความกิจกรรม').setRequired(true)))
    .addSubcommand((sub) => sub.setName('reroll').setDescription('สุ่มผู้ชนะใหม่ของกิจกรรมที่จบไปแล้ว')
      .addStringOption((opt) => opt.setName('message_id').setDescription('ID ของข้อความกิจกรรม').setRequired(true))),
  new SlashCommandBuilder()
    .setName('council')
    .setDescription('🏛️ เปิดสภา AI ให้ 2 บุคลิกของบอทโต้วาทีกันสดๆ พร้อมกรรมการ AI ตัดสิน (ฟีเจอร์พิเศษ)')
    .addStringOption((opt) => opt.setName('หัวข้อ').setDescription('หัวข้อที่ต้องการให้ AI โต้วาทีกัน').setRequired(true))
    .addStringOption((opt) => opt.setName('ฝ่ายก').setDescription('เลือกบุคลิกฝ่ายที่ 1 (ไม่เลือก = สุ่ม)').setRequired(false)
      .addChoices(...Object.entries(MODE_LABELS).map(([value, name]) => ({ name, value }))))
    .addStringOption((opt) => opt.setName('ฝ่ายข').setDescription('เลือกบุคลิกฝ่ายที่ 2 (ไม่เลือก = สุ่ม)').setRequired(false)
      .addChoices(...Object.entries(MODE_LABELS).map(([value, name]) => ({ name, value })))),
  new SlashCommandBuilder()
    .setName('prophecy')
    .setDescription('🔮 ให้บอททำนายเรื่องสนุกๆ ของเซิร์ฟเวอร์ ผนึกไว้แล้วเปิดเผยเองเมื่อครบเวลา (เพื่อความบันเทิงล้วนๆ)')
    .addStringOption((opt) => opt.setName('ระยะเวลา').setDescription('นานแค่ไหนกว่าจะเปิดผนึก เช่น 1h, 1d (5 นาที - 7 วัน)').setRequired(true))
    .addStringOption((opt) => opt.setName('เรื่อง').setDescription('อยากให้ทำนายเรื่องอะไร (ไม่ใส่ = ให้บอทสุ่มทำนายเอง)').setRequired(false)),
].map((cmd) => cmd.toJSON());

async function registerSlashCommandsForGuild(guild) {
  try {
    await guild.commands.set(slashCommandDefs);
  } catch (e) {
    console.error(`⚠️ ลงทะเบียน Slash Command สำหรับ "${guild.name}" ล้มเหลว:`, e.message);
  }
}

// ==========================================
// 🎛️ 11. ตัวสร้างหน้าแผงควบคุม (หลายหน้า: หลัก / ขั้นสูง / สิทธิ์การใช้ / สถิติ)
// ==========================================

// อัปเดตหน้าสถิติอัตโนมัติทุก 5 วินาที (นาน 5 นาที) ให้ความรู้สึก "เรียลไทม์จริง"
const activeStatsIntervals = new Map(); // messageId -> intervalId
function startStatsAutoRefresh(message, guildId) {
  stopStatsAutoRefresh(message.id);
  const intervalId = setInterval(async () => {
    try {
      const stats = getGuildStats(guildId);
      await message.edit(buildStatsPanel(stats, message.guild));
    } catch (e) {
      stopStatsAutoRefresh(message.id);
    }
  }, 5000);
  activeStatsIntervals.set(message.id, intervalId);
  setTimeout(() => stopStatsAutoRefresh(message.id), 5 * 60 * 1000);
}
function stopStatsAutoRefresh(messageId) {
  if (activeStatsIntervals.has(messageId)) {
    clearInterval(activeStatsIntervals.get(messageId));
    activeStatsIntervals.delete(messageId);
  }
}


// ==========================================
// ✅ 12. Ready / GuildCreate / MessageDelete Events
// ==========================================
client.once(Events.ClientReady, async () => {
  console.log('==========================================');
  console.log(`✅ ล็อกอินสำเร็จ: ${client.user.tag}`);
  console.log(`🔑 คำสั่งเปิดแผงควบคุมคือ: ${PANEL_COMMAND}`);
  console.log(`👑 เจ้าของบอทที่อนุญาต: ${OWNER_IDS.join(', ')}`);
  console.log(`🏠 จำนวนเซิร์ฟเวอร์ที่บอทอยู่: ${client.guilds.cache.size}`);
  console.log('==========================================');

  client.user.setActivity(globalConfig.statusText, { type: ActivityType.Playing });
  startAvatarAutoRotate();

  try {
    await client.application.fetch();
    await client.application.commands.set(slashCommandDefs);
    console.log('✅ ลงทะเบียน Slash Commands แบบ Global สำเร็จ (การอัปเดตอาจใช้เวลาถึง 1 ชม.)');
  } catch (e) {
    console.error('⚠️ ลงทะเบียน Global Slash Commands ล้มเหลว:', e.message);
  }

  // ลงทะเบียนคำสั่งแบบเฉพาะเซิร์ฟเวอร์ด้วย เพื่อให้ใช้งานได้ทันทีในทุกเซิร์ฟเวอร์ที่มีอยู่แล้ว (ไม่ต้องรอ Global Sync)
  for (const guild of client.guilds.cache.values()) {
    getGuildConfig(guild.id);
    await registerSlashCommandsForGuild(guild);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`➕ บอทถูกเชิญเข้าเซิร์ฟเวอร์ใหม่: ${guild.name} (${guild.id})`);
  getGuildConfig(guild.id);
  await registerSlashCommandsForGuild(guild);
  try {
    if (guild.systemChannel) {
      await guild.systemChannel.send({
        content:
          `👋 สวัสดีครับ! ขอบคุณที่เชิญผมเข้าเซิร์ฟเวอร์นี้\n` +
          `พิมพ์ \`${PANEL_COMMAND}\` หรือใช้คำสั่ง \`/panel\` เพื่อเปิดแผงควบคุมและตั้งค่าบอท (สำหรับแอดมิน/เจ้าของบอทเท่านั้น)\n` +
          `หรือพิมพ์ \`/help\` เพื่อดูวิธีใช้งานทั้งหมด`,
      });
    }
  } catch (e) {
    // ไม่มีสิทธิ์ส่งข้อความในห้องระบบ ก็ไม่เป็นไร ข้ามไป
  }
});

client.on(Events.MessageDelete, (msg) => {
  stopStatsAutoRefresh(msg.id);
});

// ==========================================
// 👋 12.5 ระบบต้อนรับ/อำลาสมาชิก + ยศอัตโนมัติ (ฟรี ใช้ Event ของ Discord เอง ไม่ต้องพึ่ง API ภายนอก)
// ==========================================
function formatWelcomeMessage(template, member) {
  return String(template)
    .replace(/{user}/g, `${member}`)
    .replace(/{username}/g, member.user ? member.user.username : 'Unknown')
    .replace(/{server}/g, member.guild.name)
    .replace(/{membercount}/g, member.guild.memberCount);
}

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const cfg = getGuildConfig(member.guild.id);

    if (cfg.autoRoleId) {
      const role = await member.guild.roles.fetch(cfg.autoRoleId).catch(() => null);
      if (role) await member.roles.add(role).catch(() => {});
    }

    if (cfg.welcomeEnabled && cfg.welcomeChannelId) {
      const channel = await member.guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        const text = formatWelcomeMessage(cfg.welcomeMessage || DEFAULT_GUILD_CONFIG.welcomeMessage, member);
        const embed = new EmbedBuilder().setColor(0x2ECA53).setDescription(text);
        if (member.user) embed.setThumbnail(member.user.displayAvatarURL());
        await channel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('❌ GuildMemberAdd Error:', e.message);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const cfg = getGuildConfig(member.guild.id);
    if (cfg.leaveEnabled && cfg.leaveChannelId) {
      const channel = await member.guild.channels.fetch(cfg.leaveChannelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        const text = formatWelcomeMessage(cfg.leaveMessage || DEFAULT_GUILD_CONFIG.leaveMessage, member);
        const embed = new EmbedBuilder().setColor(0xE74C3C).setDescription(text);
        if (member.user) embed.setThumbnail(member.user.displayAvatarURL());
        await channel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('❌ GuildMemberRemove Error:', e.message);
  }
});

// ==========================================
// 🎉 12.6 ระบบ Giveaway — สร้างงาน, จับเวลา, สุ่มผู้ชนะอัตโนมัติ
// ==========================================

async function endGiveaway(guildId, messageId) {
  const giveaways = getGiveaways(guildId);
  const g = giveaways[messageId];
  if (!g || g.ended) return;

  g.ended = true;
  const pool = [...(g.entries || [])];
  const winners = [];
  const winnerCount = Math.min(g.winnerCount, pool.length);
  for (let i = 0; i < winnerCount; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  g.winners = winners;
  saveGiveaways(guildId);

  try {
    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const embed = buildGiveawayEmbed(g.prize, g.winnerCount, g.endTime, true, winners);
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
      if (winners.length) {
        await channel.send({ content: `🎉 ยินดีด้วย ${winners.map((id) => `<@${id}>`).join(', ')} ได้รับ **${g.prize}**!` }).catch(() => {});
      } else {
        await channel.send({ content: `😢 ไม่มีผู้เข้าร่วมกิจกรรม **${g.prize}** เลย งั้นยังไม่มีใครได้รางวัลนี้ไป` }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('❌ ประกาศผล Giveaway ล้มเหลว:', e.message);
  }
}

// เช็คทุก 20 วินาทีว่ามีกิจกรรมไหนครบเวลาแล้วบ้าง (ดึงเซิร์ฟเวอร์จาก client แทน cache)
setInterval(() => {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const giveaways = getGiveaways(guild.id);
    for (const [messageId, g] of Object.entries(giveaways)) {
      if (!g.ended && g.endTime <= now) {
        endGiveaway(guild.id, messageId).catch(() => {});
      }
    }
  }
}, 20000);

// ==========================================
// 📜 13. ระบบส่ง Log ไปห้องที่กำหนด (ถ้าตั้งค่าไว้)
// ==========================================
async function sendGuildLog(guild, cfg, payload) {
  if (!cfg.logChannelId || !guild) return;
  try {
    const channel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel.send(typeof payload === 'string' ? { content: payload } : payload).catch(() => {});
    }
  } catch (e) {
    // ห้อง log อาจถูกลบหรือบอทไม่มีสิทธิ์ ก็ข้ามไปเงียบๆ กันบอทพัง
  }
}

// ==========================================
// 🏆 13.5 ระบบให้ XP + ประกาศเลเวลอัพ + แจกยศรางวัล
// ==========================================
async function handleLevelUp(message, cfg, newLevel) {
  let channel = message.channel;
  if (cfg.levelingAnnounceChannelId) {
    const announceChannel = await message.guild.channels.fetch(cfg.levelingAnnounceChannelId).catch(() => null);
    if (announceChannel && announceChannel.isTextBased()) channel = announceChannel;
  }

  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setDescription(`🎉 ยินดีด้วย ${message.author} เลื่อนขึ้นเป็น **เลเวล ${newLevel}** แล้ว!`);
  await channel.send({ embeds: [embed] }).catch(() => {});

  const rewards = parseRoleRewards(cfg.levelingRoleRewards);
  const roleId = rewards[newLevel];
  if (roleId) {
    try {
      const member = await message.guild.members.fetch(message.author.id);
      const role = await message.guild.roles.fetch(roleId).catch(() => null);
      if (role && !member.roles.cache.has(roleId)) {
        await member.roles.add(roleId);
        await channel.send({ content: `🏅 ${message.author} ได้รับยศ ${role} จากการถึงเลเวล ${newLevel}!` }).catch(() => {});
      }
    } catch (e) {
      // บอทอาจไม่มีสิทธิ์จัดการยศนี้ (เช่นยศสูงกว่าบอท) ข้ามไปเงียบๆ กันบอทพัง
    }
  }
}

// ให้ XP แก่ผู้ส่งข้อความ (ถ้าเปิดระบบเลเวลไว้) แล้วเช็คว่าขึ้นเลเวลใหม่หรือยัง
async function awardLevelXp(message, cfg) {
  if (!cfg.levelingEnabled) return;
  if (!message.content.trim()) return;
  if (cfg.levelingIgnoredChannelIds.includes(message.channel.id)) return;
  if (isOnLevelCooldown(message.guild.id, message.author.id, cfg.levelingCooldownSeconds)) return;

  const guildId = message.guild.id;
  const data = getLevelData(guildId);
  const prevEntry = data[message.author.id] || { xp: 0 };
  const min = Math.min(cfg.levelingXpMin, cfg.levelingXpMax);
  const max = Math.max(cfg.levelingXpMin, cfg.levelingXpMax);
  const gained = Math.floor(Math.random() * (max - min + 1)) + min;

  const before = calculateLevel(prevEntry.xp || 0);
  const newXp = (prevEntry.xp || 0) + gained;
  const after = calculateLevel(newXp);

  data[message.author.id] = { xp: newXp, lastMessageAt: Date.now() };
  saveLevelData(guildId);

  if (after.level > before.level) {
    handleLevelUp(message, cfg, after.level).catch(() => {});
  }
}

// ==========================================
// ✉️ 14. Message Handling (คำสั่ง Prefix + ระบบตอบอัตโนมัติ AI)
// ==========================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  const cfg = getGuildConfig(guildId);
  const hasPerm = checkHasPermission(message.author.id, message.member, guildId);

  // ให้ XP ระบบเลเวลก่อนเสมอ (ทำงานเป็นระบบแยกอิสระจากระบบแชท AI ไม่ขึ้นกับ cfg.isActive)
  awardLevelXp(message, cfg).catch(() => {});

  if (message.content === '!help') {
    return message.reply({ embeds: [buildHelpEmbed()] }).catch(() => {});
  }

  if (message.content === '!ping') {
    const sent = await message.reply('🏓 กำลังวัดความหน่วง...');
    const ping = sent.createdTimestamp - message.createdTimestamp;
    return sent.edit(`🏓 Pong! ความหน่วงข้อความ: ${ping}ms | WebSocket: ${Math.round(client.ws.ping)}ms`).catch(() => {});
  }

  if (message.content === '!reset' || message.content === '!ลืม') {
    clearConversationHistory(guildId, message.author.id);
    return message.reply('🧹 ล้างความจำบทสนทนาของคุณเรียบร้อยแล้ว! เริ่มคุยใหม่ได้เลย').catch(() => {});
  }

  if (message.content === PANEL_COMMAND) {
    if (!hasPerm) {
      return message.reply({ content: `❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้! (ID ของคุณ: \`${message.author.id}\`)` }).catch(() => {});
    }
    try {
      return await message.reply(buildMainPanel(cfg, message.guild));
    } catch (err) {
      return message.reply('เกิดข้อผิดพลาดในการสร้างแผงควบคุม').catch(() => {});
    }
  }

  if (message.content === '!stats') {
    const stats = getGuildStats(guildId);
    const sent = await message.reply(buildStatsPanel(stats, message.guild)).catch(() => null);
    if (sent) startStatsAutoRefresh(sent, guildId);
    return;
  }

  if (message.content === '!avatar' && hasPerm) {
    const msg = await message.reply('⏳ กำลังเปลี่ยนรูปโปรไฟล์...');
    const r = await changeAvatarFromApi();
    return msg.edit(r.success ? `✅ สำเร็จ! (${r.source})` : '❌ ไม่สำเร็จ ลองใหม่อีกครั้ง').catch(() => {});
  }

  if (message.content === '!rank') {
    const data = getLevelData(guildId);
    const entry = data[message.author.id] || { xp: 0 };
    const { level, xpIntoLevel, xpForNext } = calculateLevel(entry.xp || 0);
    const bar = makeProgressBar(xpIntoLevel, xpForNext);
    const embed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setDescription(`🏆 เลเวล **${level}**\n✨ XP รวม: **${entry.xp || 0}**\n${bar}\n${xpIntoLevel} / ${xpForNext} XP ไปเลเวลถัดไป`);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  if (message.content === '!leaderboard') {
    const data = getLevelData(guildId);
    const sorted = Object.entries(data).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).slice(0, 10);
    if (!sorted.length) {
      return message.reply('📉 ยังไม่มีใครมี XP ในเซิร์ฟเวอร์นี้เลย').catch(() => {});
    }
    const lines = sorted.map(([userId, d], i) => {
      const { level } = calculateLevel(d.xp || 0);
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `${medal} <@${userId}> — เลเวล ${level} (${d.xp} XP)`;
    }).join('\n');
    const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 อันดับ XP สูงสุด').setDescription(lines);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  if (message.content.startsWith('!imagine ') || message.content === '!imagine') {
    const prompt = message.content.slice('!imagine'.length).trim();
    if (!prompt) {
      return message.reply('❌ พิมพ์คำบรรยายภาพต่อท้ายด้วย เช่น `!imagine cat wearing sunglasses`').catch(() => {});
    }
    if (!cfg.imageGenEnabled) {
      return message.reply('🔴 ระบบสร้างภาพถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้').catch(() => {});
    }
    if (isOnImageGenCooldown(guildId, message.author.id)) {
      return message.react('⏳').catch(() => {});
    }
    const loadingMsg = await message.reply('🎨 กำลังสร้างภาพ...');
    try {
      const buffer = await generateImage(prompt);
      const embed = buildImagineEmbed(prompt, message.author.tag);
      return loadingMsg.edit({ content: '', embeds: [embed], files: [{ attachment: buffer, name: 'imagine.png' }] }).catch(() => {});
    } catch (e) {
      console.error('❌ !imagine เกิดข้อผิดพลาด:', e.message);
      return loadingMsg.edit('❌ สร้างภาพไม่สำเร็จ เซิร์ฟเวอร์ภาพอาจกำลังหน่วง ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
    }
  }

  // ระบบตอบอัตโนมัติ AI
  if (!cfg.isActive) return;
  if (message.content.startsWith('!')) return;
  if (!message.content.trim()) return;

  const allowed = cfg.filterMode === 'whitelist'
    ? cfg.whitelistUserIds.includes(message.author.id)
    : !cfg.blacklistUserIds.includes(message.author.id);
  if (!allowed) return;

  if (cfg.targetChannelIds.length && !cfg.targetChannelIds.includes(message.channel.id)) return;

  if (cfg.targetRoleIds.length) {
    const hasRole = message.member?.roles.cache.some((r) => cfg.targetRoleIds.includes(r.id));
    if (!hasRole) return;
  }

  if (isOnCooldown(guildId, message.author.id, cfg.cooldownSeconds)) {
    return message.react('⏳').catch(() => {});
  }

  const stopTyping = startTypingLoop(message.channel);
  try {
    const history = getConversationHistory(guildId, message.author.id, cfg);
    const result = await getAiResponse(cfg, history, message.content);
    stopTyping();

    pushConversationTurn(guildId, message.author.id, cfg, message.content, result.text);
    recordStat(guildId, { userId: message.author.id, provider: result.provider, latencyMs: result.latencyMs, error: false });

    const payload = buildAiReplyPayload(cfg, message.author.id, result.text);
    await message.reply(payload).catch(() => {});

    if (cfg.logChannelId) {
      const logEmbed = new EmbedBuilder()
        .setColor(result.usedFallback ? 0xF1C40F : 0x2ECA53)
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .addFields(
          { name: '❓ คำถาม', value: message.content.slice(0, 1000) || '(ว่าง)' },
          { name: '💬 คำตอบ', value: (result.text || '').slice(0, 1000) || '(ว่าง)' },
          { name: '🌐 ค่าย', value: `${result.provider} (${result.latencyMs}ms)`, inline: true },
          { name: '📌 ห้อง', value: `<#${message.channel.id}>`, inline: true }
        )
        .setTimestamp();
      sendGuildLog(message.guild, cfg, { embeds: [logEmbed] });
    }
  } catch (err) {
    stopTyping();
    recordStat(guildId, { error: true });
    console.error('❌ เกิดข้อผิดพลาดตอนตอบ AI:', err.message);
    await message.reply('เกิดข้อผิดพลาดบางอย่าง ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
  }
});

// ==========================================
// 🧩 15. Helper: วาดหน้าแผงควบคุมหน้าที่ต้องการ แล้วอัปเดตข้อความเดิม (สำหรับ Component/Modal ทุกชนิด)
// ==========================================
async function renderPanel(interaction, page, guildId, cfg) {
  saveGuildConfig(guildId);

  let payload;
  if (page === 'advanced') payload = buildAdvancedPanel(cfg, interaction.guild);
  else if (page === 'access') payload = buildAccessPanel(cfg, interaction.guild);
  else if (page === 'stats') payload = buildStatsPanel(getGuildStats(guildId), interaction.guild);
  else if (page === 'leveling') payload = buildLevelingPanel(cfg, interaction.guild);
  else if (page === 'welcome') payload = buildWelcomePanel(cfg, interaction.guild);
  else payload = buildMainPanel(cfg, interaction.guild);

  try {
    if (interaction.isModalSubmit() && typeof interaction.isFromMessage === 'function' && !interaction.isFromMessage()) {
      // เผื่อกรณี Modal ไม่ได้ผูกกับข้อความ (ไม่ควรเกิดในบอทนี้ แต่กันไว้ไม่ให้พัง)
      await interaction.reply({ ...payload, ephemeral: true });
    } else {
      await interaction.update(payload);
    }
  } catch (e) {
    console.error('⚠️ อัปเดตแผงควบคุมล้มเหลว:', e.message);
  }

  if (page === 'stats') {
    try {
      const msg = interaction.message || (await interaction.fetchReply());
      if (msg) startStatsAutoRefresh(msg, guildId);
    } catch (e) {
      // เงียบไว้ กันบอทพัง
    }
  }
}

// ==========================================
// 🗨️ 16. Handler สำหรับ Slash Commands
// ==========================================
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'help') {
    return interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true }).catch(() => {});
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({ content: '❌ คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์เท่านั้น', ephemeral: true }).catch(() => {});
  }

  const cfg = getGuildConfig(guildId);

  if (commandName === 'panel') {
    if (!checkHasPermission(interaction.user.id, interaction.member, guildId)) {
      return interaction.reply({ content: `❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้! (ID ของคุณ: \`${interaction.user.id}\`)`, ephemeral: true }).catch(() => {});
    }
    return interaction.reply(buildMainPanel(cfg, interaction.guild)).catch(() => {});
  }

  if (commandName === 'avatar') {
    if (!checkHasPermission(interaction.user.id, interaction.member, guildId)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้!', ephemeral: true }).catch(() => {});
    }
    await interaction.deferReply();
    const r = await changeAvatarFromApi();
    return interaction.editReply(r.success ? `✅ สำเร็จ! (${r.source})` : '❌ ไม่สำเร็จ ลองใหม่อีกครั้ง').catch(() => {});
  }

  if (commandName === 'stats') {
    const stats = getGuildStats(guildId);
    await interaction.reply(buildStatsPanel(stats, interaction.guild)).catch(() => {});
    try {
      const msg = await interaction.fetchReply();
      startStatsAutoRefresh(msg, guildId);
    } catch (e) {
      // เงียบไว้
    }
    return;
  }

  if (commandName === 'reset-memory') {
    clearConversationHistory(guildId, interaction.user.id);
    return interaction.reply({ content: '🧹 ล้างความจำบทสนทนาของคุณเรียบร้อยแล้ว! เริ่มคุยใหม่ได้เลย', ephemeral: true }).catch(() => {});
  }

  if (commandName === 'rank') {
    const targetUser = interaction.options.getUser('ผู้ใช้') || interaction.user;
    const data = getLevelData(guildId);
    const entry = data[targetUser.id] || { xp: 0 };
    const { level, xpIntoLevel, xpForNext } = calculateLevel(entry.xp || 0);
    const bar = makeProgressBar(xpIntoLevel, xpForNext);
    const embed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL() })
      .setDescription(`🏆 เลเวล **${level}**\n✨ XP รวม: **${entry.xp || 0}**\n${bar}\n${xpIntoLevel} / ${xpForNext} XP ไปเลเวลถัดไป`);
    return interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  if (commandName === 'leaderboard') {
    const data = getLevelData(guildId);
    const sorted = Object.entries(data).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).slice(0, 10);
    if (!sorted.length) {
      return interaction.reply({ content: '📉 ยังไม่มีใครมี XP ในเซิร์ฟเวอร์นี้เลย', ephemeral: true }).catch(() => {});
    }
    const lines = sorted.map(([userId, d], i) => {
      const { level } = calculateLevel(d.xp || 0);
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `${medal} <@${userId}> — เลเวล ${level} (${d.xp} XP)`;
    }).join('\n');
    const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 อันดับ XP สูงสุด').setDescription(lines);
    return interaction.reply({ embeds: [embed] }).catch(() => {});
  }

  if (commandName === 'imagine') {
    if (!cfg.imageGenEnabled) {
      return interaction.reply({ content: '🔴 ระบบสร้างภาพถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
    }
    if (isOnImageGenCooldown(guildId, interaction.user.id)) {
      return interaction.reply({ content: `⏳ ใจเย็นๆ นะ กันสแปมอยู่ (${IMAGE_GEN_COOLDOWN_SECONDS} วินาทีต่อครั้ง) ลองใหม่อีกสักครู่`, ephemeral: true }).catch(() => {});
    }
    const prompt = interaction.options.getString('พรอมต์', true);
    await interaction.deferReply();
    try {
      const buffer = await generateImage(prompt);
      const embed = buildImagineEmbed(prompt, interaction.user.tag);
      return interaction.editReply({ embeds: [embed], files: [{ attachment: buffer, name: 'imagine.png' }] }).catch(() => {});
    } catch (e) {
      console.error('❌ /imagine เกิดข้อผิดพลาด:', e.message);
      return interaction.editReply('❌ สร้างภาพไม่สำเร็จ เซิร์ฟเวอร์ภาพอาจกำลังหน่วง ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
    }
  }

  if (commandName === 'giveaway') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      if (!checkHasPermission(interaction.user.id, interaction.member, guildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์เริ่มกิจกรรมนี้!', ephemeral: true }).catch(() => {});
      }
      const durationText = interaction.options.getString('ระยะเวลา', true);
      const prize = interaction.options.getString('รางวัล', true);
      const winnerCount = interaction.options.getInteger('ผู้ชนะ') || 1;

      const durationMs = parseDuration(durationText);
      const MAX_GIVEAWAY_MS = 28 * 24 * 60 * 60 * 1000;
      if (!durationMs || durationMs < 10000 || durationMs > MAX_GIVEAWAY_MS) {
        return interaction.reply({ content: '❌ ระยะเวลาไม่ถูกต้อง ใช้รูปแบบเช่น `30s` `10m` `2h` `1d` (อย่างน้อย 10 วินาที สูงสุด 28 วัน)', ephemeral: true }).catch(() => {});
      }

      const endTime = Date.now() + durationMs;
      const embed = buildGiveawayEmbed(prize, winnerCount, endTime, false, []);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('giveaway_join').setLabel('🎉 เข้าร่วม').setStyle(ButtonStyle.Primary)
      );
      await interaction.reply({ embeds: [embed], components: [row] });
      const msg = await interaction.fetchReply();

      const giveaways = getGiveaways(guildId);
      giveaways[msg.id] = {
        prize, winnerCount, entries: [], endTime, channelId: interaction.channelId, ended: false, startedBy: interaction.user.id,
      };
      saveGiveaways(guildId);
      return;
    }

    if (sub === 'end') {
      if (!checkHasPermission(interaction.user.id, interaction.member, guildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์จบกิจกรรมนี้!', ephemeral: true }).catch(() => {});
      }
      const messageId = interaction.options.getString('message_id', true).trim();
      const giveaways = getGiveaways(guildId);
      if (!giveaways[messageId]) {
        return interaction.reply({ content: '❌ ไม่พบกิจกรรมที่มี ID นี้', ephemeral: true }).catch(() => {});
      }
      if (giveaways[messageId].ended) {
        return interaction.reply({ content: '❌ กิจกรรมนี้จบไปแล้ว', ephemeral: true }).catch(() => {});
      }
      await endGiveaway(guildId, messageId);
      return interaction.reply({ content: '✅ จบกิจกรรมและประกาศผลเรียบร้อยแล้ว', ephemeral: true }).catch(() => {});
    }

    if (sub === 'reroll') {
      if (!checkHasPermission(interaction.user.id, interaction.member, guildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์สุ่มผู้ชนะใหม่!', ephemeral: true }).catch(() => {});
      }
      const messageId = interaction.options.getString('message_id', true).trim();
      const giveaways = getGiveaways(guildId);
      const g = giveaways[messageId];
      if (!g || !g.ended) {
        return interaction.reply({ content: '❌ ไม่พบกิจกรรมที่จบแล้วด้วย ID นี้', ephemeral: true }).catch(() => {});
      }
      const pool = [...(g.entries || [])];
      if (!pool.length) {
        return interaction.reply({ content: '❌ กิจกรรมนี้ไม่มีผู้เข้าร่วมเลย สุ่มใหม่ไม่ได้', ephemeral: true }).catch(() => {});
      }
      const winners = [];
      const winnerCount = Math.min(g.winnerCount, pool.length);
      for (let i = 0; i < winnerCount; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        winners.push(pool.splice(idx, 1)[0]);
      }
      g.winners = winners;
      saveGiveaways(guildId);
      const channel = await client.channels.fetch(g.channelId).catch(() => null);
      if (channel) {
        await channel.send({ content: `🔄 สุ่มใหม่! ผู้ชนะคนใหม่ของ **${g.prize}** คือ ${winners.map((id) => `<@${id}>`).join(', ')}` }).catch(() => {});
      }
      return interaction.reply({ content: '✅ สุ่มผู้ชนะใหม่เรียบร้อยแล้ว', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (commandName === 'council') {
    if (!cfg.isActive) {
      return interaction.reply({ content: '🔴 ระบบ AI ถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
    }
    if (isOnCouncilCooldown(guildId, interaction.user.id)) {
      return interaction.reply({ content: `⏳ สภา AI ใช้เวลาประมวลผลนานหน่อย กันสแปมไว้ ${COUNCIL_COOLDOWN_SECONDS} วินาที/ครั้ง ลองใหม่อีกสักครู่นะครับ`, ephemeral: true }).catch(() => {});
    }

    const topic = interaction.options.getString('หัวข้อ', true);
    const allModes = Object.keys(MODE_LABELS);
    let modeA = interaction.options.getString('ฝ่ายก');
    let modeB = interaction.options.getString('ฝ่ายข');
    if (!modeA || !allModes.includes(modeA)) modeA = allModes[Math.floor(Math.random() * allModes.length)];
    if (!modeB || !allModes.includes(modeB) || modeB === modeA) {
      const remaining = allModes.filter((m) => m !== modeA);
      modeB = remaining[Math.floor(Math.random() * remaining.length)];
    }

    await interaction.deferReply();
    const introEmbed = new EmbedBuilder()
      .setColor(0x1ABC9C)
      .setTitle('🏛️ เปิดสภา AI!')
      .setDescription(`หัวข้อ: **${topic}**\n\n🅰️ ${MODE_LABELS[modeA]}\n🆚\n🅱️ ${MODE_LABELS[modeB]}\n\n⏳ กำลังโต้วาที... (อาจใช้เวลาสักครู่)`);
    await interaction.editReply({ embeds: [introEmbed] }).catch(() => {});

    try {
      const transcript = await runCouncilDebate(cfg, topic, modeA, modeB, 3);
      const lines = transcript.map((t) => {
        const speakerLabel = t.mode === modeA ? `🅰️ ${MODE_LABELS[modeA]}` : `🅱️ ${MODE_LABELS[modeB]}`;
        return `**${speakerLabel}**\n${t.text}`;
      }).join('\n\n').slice(0, 3000);
      const verdict = (await runCouncilVerdict(cfg, topic, transcript)).slice(0, 500);

      const finalEmbed = new EmbedBuilder()
        .setColor(0x1ABC9C)
        .setTitle('🏛️ ผลการโต้วาทีสภา AI')
        .setDescription(`หัวข้อ: **${topic}**\n\n${lines}\n\n⚖️ **คำตัดสิน**\n${verdict}`)
        .setFooter({ text: `🅰️ ${MODE_LABELS[modeA]}  🆚  🅱️ ${MODE_LABELS[modeB]}` });
      return interaction.editReply({ embeds: [finalEmbed] }).catch(() => {});
    } catch (e) {
      console.error('❌ /council เกิดข้อผิดพลาด:', e.message);
      return interaction.editReply('❌ เปิดสภาไม่สำเร็จ ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
    }
  }

  if (commandName === 'prophecy') {
    if (!cfg.isActive) {
      return interaction.reply({ content: '🔴 ระบบ AI ถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
    }
    if (isOnProphecyCooldown(guildId, interaction.user.id)) {
      return interaction.reply({ content: `⏳ ใจเย็นๆ นะ กันสแปมไว้ ${PROPHECY_COOLDOWN_SECONDS} วินาที/ครั้ง ลองใหม่อีกสักครู่`, ephemeral: true }).catch(() => {});
    }

    const durationText = interaction.options.getString('ระยะเวลา', true);
    const topic = interaction.options.getString('เรื่อง') || '';
    const durationMs = parseDuration(durationText);
    const MIN_PROPHECY_MS = 5 * 60 * 1000;
    const MAX_PROPHECY_MS = 7 * 24 * 60 * 60 * 1000;
    if (!durationMs || durationMs < MIN_PROPHECY_MS || durationMs > MAX_PROPHECY_MS) {
      return interaction.reply({ content: '❌ ระยะเวลาไม่ถูกต้อง ใช้รูปแบบเช่น `10m` `1h` `1d` (อย่างน้อย 5 นาที สูงสุด 7 วัน)', ephemeral: true }).catch(() => {});
    }

    await interaction.deferReply();
    try {
      const prediction = await generateProphecyText(cfg, topic);
      const revealTime = Date.now() + durationMs;
      const embed = buildProphecyEmbed(topic, prediction, revealTime, false, null);
      await interaction.editReply({ embeds: [embed] });
      const msg = await interaction.fetchReply();

      const prophecies = getProphecies(guildId);
      prophecies[msg.id] = {
        topic, prediction, revealTime, channelId: interaction.channelId, authorId: interaction.user.id, revealed: false, epilogue: null,
      };
      saveProphecies(guildId);
      return;
    } catch (e) {
      console.error('❌ /prophecy เกิดข้อผิดพลาด:', e.message);
      return interaction.editReply('❌ ทำนายไม่สำเร็จ ลูกแก้วอาจขุ่นมัวชั่วคราว ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
    }
  }

  if (commandName === 'ask') {
    const question = interaction.options.getString('คำถาม', true);

    if (!cfg.isActive) {
      return interaction.reply({ content: '🔴 ตอนนี้ระบบ AI ถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
    }
    const allowed = cfg.filterMode === 'whitelist'
      ? cfg.whitelistUserIds.includes(interaction.user.id)
      : !cfg.blacklistUserIds.includes(interaction.user.id);
    if (!allowed) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ใช้งาน AI ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
    }
    if (cfg.targetChannelIds.length && !cfg.targetChannelIds.includes(interaction.channelId)) {
      return interaction.reply({ content: '❌ ห้องนี้ไม่ได้รับอนุญาตให้ใช้ AI', ephemeral: true }).catch(() => {});
    }
    if (cfg.targetRoleIds.length) {
      const hasRole = interaction.member?.roles.cache.some((r) => cfg.targetRoleIds.includes(r.id));
      if (!hasRole) {
        return interaction.reply({ content: '❌ คุณไม่มียศที่ได้รับอนุญาตให้ใช้ AI', ephemeral: true }).catch(() => {});
      }
    }
    if (isOnCooldown(guildId, interaction.user.id, cfg.cooldownSeconds)) {
      return interaction.reply({ content: '⏳ ใจเย็นๆ นะ กำลังกันสแปมอยู่ ลองใหม่อีกสักครู่', ephemeral: true }).catch(() => {});
    }

    await interaction.deferReply();
    const stopTyping = startTypingLoop(interaction.channel);
    try {
      const history = getConversationHistory(guildId, interaction.user.id, cfg);
      const result = await getAiResponse(cfg, history, question);
      stopTyping();
      pushConversationTurn(guildId, interaction.user.id, cfg, question, result.text);
      recordStat(guildId, { userId: interaction.user.id, provider: result.provider, latencyMs: result.latencyMs, error: false });
      const payload = buildAiReplyPayload(cfg, interaction.user.id, result.text);
      await interaction.editReply(payload).catch(() => {});
      if (cfg.logChannelId) {
        const logEmbed = new EmbedBuilder()
          .setColor(result.usedFallback ? 0xF1C40F : 0x2ECA53)
          .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
          .addFields(
            { name: '❓ คำถาม (/ask)', value: question.slice(0, 1000) || '(ว่าง)' },
            { name: '💬 คำตอบ', value: (result.text || '').slice(0, 1000) || '(ว่าง)' },
            { name: '🌐 ค่าย', value: `${result.provider} (${result.latencyMs}ms)`, inline: true },
            { name: '📌 ห้อง', value: `<#${interaction.channelId}>`, inline: true }
          )
          .setTimestamp();
        sendGuildLog(interaction.guild, cfg, { embeds: [logEmbed] });
      }
      return;
    } catch (err) {
      stopTyping();
      recordStat(guildId, { error: true });
      console.error('❌ /ask เกิดข้อผิดพลาด:', err.message);
      return interaction.editReply('เกิดข้อผิดพลาดบางอย่าง ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
    }
  }
}

// ==========================================
// 🔄 17. Handler สำหรับปุ่ม "ตอบใหม่" (Regenerate)
// ==========================================
async function handleRegenerate(interaction) {
  const ownerId = interaction.customId.split('_')[1];
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: '❌ คุณไม่ใช่คนถาม รีเจนคำตอบไม่ได้!', ephemeral: true }).catch(() => {});
  }
  const guildId = interaction.guildId;
  if (!guildId) return;
  const cfg = getGuildConfig(guildId);

  const ref = interaction.message.reference;
  const originalMsg = ref ? await interaction.channel.messages.fetch(ref.messageId).catch(() => null) : null;
  if (!originalMsg) {
    return interaction.reply({ content: '❌ ไม่พบข้อความคำถามต้นฉบับ (อาจถูกลบไปแล้ว)', ephemeral: true }).catch(() => {});
  }

  await interaction.deferUpdate().catch(() => {});
  const stopTyping = startTypingLoop(interaction.channel);
  try {
    popLastConversationTurn(guildId, ownerId); // เอาคู่สนทนารอบล่าสุดออกก่อน กันซ้ำซ้อนตอนขอคำตอบใหม่
    const history = getConversationHistory(guildId, ownerId, cfg);
    const result = await getAiResponse(cfg, history, originalMsg.content);
    stopTyping();
    pushConversationTurn(guildId, ownerId, cfg, originalMsg.content, result.text);
    recordStat(guildId, { userId: ownerId, provider: result.provider, latencyMs: result.latencyMs, error: false });
    const payload = buildAiReplyPayload(cfg, ownerId, result.text);
    await interaction.editReply(payload).catch(() => {});
  } catch (err) {
    stopTyping();
    recordStat(guildId, { error: true });
    console.error('❌ Regenerate เกิดข้อผิดพลาด:', err.message);
  }
}

// ==========================================
// 🕹️ 18. Interaction Handling (ศูนย์กลางจัดการทุก Interaction)
// ==========================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---------- Slash Commands ----------
    if (interaction.isChatInputCommand()) {
      return handleSlashCommand(interaction);
    }

    // ---------- ปุ่มลบข้อความคำตอบ AI (เฉพาะเจ้าของคำถาม) ----------
    if (interaction.isButton() && interaction.customId.startsWith('del_')) {
      const ownerId = interaction.customId.split('_')[1];
      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ คุณไม่ใช่คนถาม ลบไม่ได้!', ephemeral: true }).catch(() => {});
      }
      await interaction.deferUpdate().catch(() => {});
      return interaction.message.delete().catch(() => {});
    }

    // ---------- ปุ่มตอบใหม่ (Regenerate) ----------
    if (interaction.isButton() && interaction.customId.startsWith('regen_')) {
      return handleRegenerate(interaction);
    }

    // ---------- ปุ่มเข้าร่วม Giveaway (ใครก็กดได้ ไม่ต้องมีสิทธิ์แอดมิน) ----------
    if (interaction.isButton() && interaction.customId === 'giveaway_join') {
      const gGuildId = interaction.guildId;
      if (!gGuildId) return;
      const giveaways = getGiveaways(gGuildId);
      const g = giveaways[interaction.message.id];
      if (!g || g.ended) {
        return interaction.reply({ content: '❌ กิจกรรมนี้จบไปแล้วหรือไม่พบข้อมูล', ephemeral: true }).catch(() => {});
      }
      if (g.entries.includes(interaction.user.id)) {
        g.entries = g.entries.filter((id) => id !== interaction.user.id);
        saveGiveaways(gGuildId);
        return interaction.reply({ content: '↩️ คุณออกจากกิจกรรมนี้แล้ว (กดปุ่มอีกครั้งเพื่อเข้าร่วมใหม่)', ephemeral: true }).catch(() => {});
      }
      g.entries.push(interaction.user.id);
      saveGiveaways(gGuildId);
      return interaction.reply({ content: '🎉 เข้าร่วมกิจกรรมเรียบร้อย! ขอให้โชคดี 🍀', ephemeral: true }).catch(() => {});
    }

    // ---------- ปุ่มยกเลิกการยืนยันรีเซ็ต ----------
    if (interaction.isButton() && interaction.customId === 'btn_reset_cancel') {
      return interaction.update({ content: '❎ ยกเลิกการรีเซ็ตแล้ว', embeds: [], components: [] }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === 'btn_reset_stats_cancel') {
      return interaction.update({ content: '❎ ยกเลิกการรีเซ็ตสถิติแล้ว', embeds: [], components: [] }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === 'btn_reset_levels_cancel') {
      return interaction.update({ content: '❎ ยกเลิกการรีเซ็ตเลเวลแล้ว', embeds: [], components: [] }).catch(() => {});
    }

    // ---------- ปุ่มยืนยันรีเซ็ต Config ----------
    if (interaction.isButton() && interaction.customId.startsWith('btn_reset_confirm_')) {
      if (!checkHasPermission(interaction.user.id, interaction.member, interaction.guildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ทำรายการนี้!', ephemeral: true }).catch(() => {});
      }
      const parts = interaction.customId.split('_'); // btn, reset, confirm, channelId, messageId
      const channelId = parts[3];
      const messageId = parts[4];
      resetGuildConfig(interaction.guildId);
      await interaction.update({ content: '✅ รีเซ็ตการตั้งค่าทั้งหมดกลับเป็นค่าเริ่มต้นเรียบร้อยแล้ว', embeds: [], components: [] }).catch(() => {});
      try {
        const channel = await client.channels.fetch(channelId);
        const panelMsg = await channel.messages.fetch(messageId);
        await panelMsg.edit(buildMainPanel(getGuildConfig(interaction.guildId), interaction.guild));
      } catch (e) {
        // ข้อความแผงควบคุมต้นฉบับอาจถูกลบไปแล้ว ไม่เป็นไร
      }
      return;
    }

    // ---------- ปุ่มยืนยันรีเซ็ต Stats ----------
    if (interaction.isButton() && interaction.customId.startsWith('btn_reset_stats_confirm_')) {
      if (!checkHasPermission(interaction.user.id, interaction.member, interaction.guildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ทำรายการนี้!', ephemeral: true }).catch(() => {});
      }
      const parts = interaction.customId.split('_'); // btn, reset, stats, confirm, channelId, messageId
      const channelId = parts[4];
      const messageId = parts[5];
      resetGuildStats(interaction.guildId);
      await interaction.update({ content: '✅ รีเซ็ตสถิติเรียบร้อยแล้ว', embeds: [], components: [] }).catch(() => {});
      try {
        const channel = await client.channels.fetch(channelId);
        const panelMsg = await channel.messages.fetch(messageId);
        const stats = getGuildStats(interaction.guildId);
        await panelMsg.edit(buildStatsPanel(stats, interaction.guild));
        startStatsAutoRefresh(panelMsg, interaction.guildId);
      } catch (e) {
        // ข้อความแผงควบคุมต้นฉบับอาจถูกลบไปแล้ว ไม่เป็นไร
      }
      return;
    }

    // ---------- ปุ่มยืนยันรีเซ็ต XP/เลเวล ----------
    if (interaction.isButton() && interaction.customId.startsWith('btn_reset_levels_confirm_')) {
      if (!checkHasPermission(interaction.user.id, interaction.member, interaction.guildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ทำรายการนี้!', ephemeral: true }).catch(() => {});
      }
      const parts = interaction.customId.split('_'); // btn, reset, levels, confirm, channelId, messageId
      const channelId = parts[4];
      const messageId = parts[5];
      resetLevelData(interaction.guildId);
      await interaction.update({ content: '✅ รีเซ็ต XP/เลเวลของทุกคนเรียบร้อยแล้ว', embeds: [], components: [] }).catch(() => {});
      try {
        const channel = await client.channels.fetch(channelId);
        const panelMsg = await channel.messages.fetch(messageId);
        await panelMsg.edit(buildLevelingPanel(getGuildConfig(interaction.guildId), interaction.guild));
      } catch (e) {
        // ข้อความแผงควบคุมต้นฉบับอาจถูกลบไปแล้ว ไม่เป็นไร
      }
      return;
    }

    // ---------- รายชื่อ customId ทั้งหมดของแผงควบคุม (ต้องมีสิทธิ์เท่านั้น) ----------
    const panelButtonIds = [
      'nav_main', 'nav_advanced', 'nav_access', 'nav_stats', 'nav_leveling', 'nav_welcome',
      'btn_toggle', 'btn_refresh', 'btn_avatar',
      'btn_set_prompt', 'btn_clear_prompt', 'btn_set_api', 'btn_clear_api',
      'btn_set_cooldown', 'btn_toggle_avatar_rotate', 'btn_set_avatar_interval', 'btn_set_status_text', 'btn_toggle_language',
      'btn_set_ai_params', 'btn_toggle_response_format', 'btn_set_embed_color', 'btn_toggle_memory', 'btn_set_memory_turns',
      'btn_export_config', 'btn_import_config', 'btn_reset_config', 'btn_toggle_admin_access',
      'btn_toggle_filter_mode', 'btn_clear_blacklist', 'btn_clear_whitelist',
      'btn_refresh_stats', 'btn_reset_stats',
      'btn_toggle_leveling', 'btn_set_leveling_xp', 'btn_set_leveling_cooldown', 'btn_set_role_rewards', 'btn_reset_levels',
      'btn_toggle_imagegen',
      'btn_toggle_welcome', 'btn_set_welcome_message', 'btn_toggle_leave', 'btn_set_leave_message',
      'btn_close_panel',
    ];
    const panelSelectIds = [
      'select_mode', 'select_roles', 'select_channels', 'select_log_channel', 'select_blacklist_users', 'select_whitelist_users',
      'select_leveling_ignored_channels', 'select_leveling_announce_channel',
      'select_welcome_channel', 'select_leave_channel', 'select_auto_role',
    ];
    const panelModalSubmitIds = [
      'modal_set_prompt', 'modal_set_api', 'modal_set_cooldown', 'modal_set_avatar_interval',
      'modal_set_status_text', 'modal_set_ai_params', 'modal_set_embed_color', 'modal_set_memory_turns', 'modal_import_config',
      'modal_set_leveling_xp', 'modal_set_leveling_cooldown', 'modal_set_role_rewards',
      'modal_set_welcome_message', 'modal_set_leave_message',
    ];

    const isKnownSelect = interaction.isStringSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.() || interaction.isUserSelectMenu?.();
    const isPanelInteraction =
      (interaction.isButton() && panelButtonIds.includes(interaction.customId)) ||
      (isKnownSelect && panelSelectIds.includes(interaction.customId)) ||
      (interaction.isModalSubmit() && panelModalSubmitIds.includes(interaction.customId));

    if (!isPanelInteraction) return; // ไม่ใช่ interaction ที่บอทรู้จัก ข้ามไปเงียบๆ
    if (!interaction.guildId) return; // แผงควบคุมใช้ได้เฉพาะในเซิร์ฟเวอร์เท่านั้น

    if (!checkHasPermission(interaction.user.id, interaction.member, interaction.guildId)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์กดแผงควบคุมนี้!', ephemeral: true }).catch(() => {});
    }

    const guildId = interaction.guildId;
    const cfg = getGuildConfig(guildId);

    // ----- ปุ่มที่ต้องเปิด Modal (ต้องเรียก showModal ทันที ห้ามตอบอย่างอื่นก่อน) -----
    if (interaction.isButton() && interaction.customId === 'btn_set_prompt') {
      const modal = new ModalBuilder().setCustomId('modal_set_prompt').setTitle('ตั้ง Prompt นิสัยบอทเอง');
      const input = new TextInputBuilder()
        .setCustomId('prompt_input').setLabel('ใส่บทบาท/นิสัยบอท').setStyle(TextInputStyle.Paragraph)
        .setValue(cfg.customPrompt || '').setMaxLength(1000).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_api') {
      const modal = new ModalBuilder().setCustomId('modal_set_api').setTitle('🔑 ตั้งค่า API Key');
      const keyInput = new TextInputBuilder()
        .setCustomId('api_keys').setLabel('API Key (ใส่ได้หลายคีย์ คั่นด้วย ,)').setStyle(TextInputStyle.Paragraph)
        .setValue(cfg.customApiKey || '').setRequired(false).setMaxLength(2000);
      const urlInput = new TextInputBuilder()
        .setCustomId('api_url').setLabel('Base URL กำหนดเอง (ไม่บังคับ)').setStyle(TextInputStyle.Short)
        .setValue(cfg.customApiUrl || '').setRequired(false).setMaxLength(300);
      const modelInput = new TextInputBuilder()
        .setCustomId('api_model').setLabel('ชื่อโมเดลกำหนดเอง (ไม่บังคับ)').setStyle(TextInputStyle.Short)
        .setValue(cfg.customApiModel || '').setRequired(false).setMaxLength(100);
      modal.addComponents(
        new ActionRowBuilder().addComponents(keyInput),
        new ActionRowBuilder().addComponents(urlInput),
        new ActionRowBuilder().addComponents(modelInput)
      );
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_cooldown') {
      const modal = new ModalBuilder().setCustomId('modal_set_cooldown').setTitle('⏱️ ตั้งค่า Cooldown กันสแปม');
      const input = new TextInputBuilder()
        .setCustomId('cooldown_seconds').setLabel('จำนวนวินาที (0-3600)').setStyle(TextInputStyle.Short)
        .setValue(String(cfg.cooldownSeconds)).setRequired(true).setMaxLength(5);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_avatar_interval') {
      const modal = new ModalBuilder().setCustomId('modal_set_avatar_interval').setTitle('⏲️ ตั้งรอบเวลาสุ่มรูป (ทั้งบอท)');
      const input = new TextInputBuilder()
        .setCustomId('avatar_minutes').setLabel('ทุกกี่นาที (ขั้นต่ำ 5)').setStyle(TextInputStyle.Short)
        .setValue(String(globalConfig.avatarRotateMinutes)).setRequired(true).setMaxLength(6);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_status_text') {
      const modal = new ModalBuilder().setCustomId('modal_set_status_text').setTitle('🏷️ ตั้งข้อความสถานะบอท (ทั้งบอท)');
      const input = new TextInputBuilder()
        .setCustomId('status_text').setLabel('ข้อความสถานะ (แสดงว่า "Playing ...")').setStyle(TextInputStyle.Short)
        .setValue(globalConfig.statusText || '').setRequired(true).setMaxLength(128);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_ai_params') {
      const modal = new ModalBuilder().setCustomId('modal_set_ai_params').setTitle('🧠 ตั้งค่า Max Tokens / Temperature');
      const tokenInput = new TextInputBuilder()
        .setCustomId('max_tokens').setLabel('Max Tokens (50-4096)').setStyle(TextInputStyle.Short)
        .setValue(String(cfg.maxTokens)).setRequired(true).setMaxLength(5);
      const tempInput = new TextInputBuilder()
        .setCustomId('temperature').setLabel('Temperature (0.0-2.0)').setStyle(TextInputStyle.Short)
        .setValue(String(cfg.temperature)).setRequired(true).setMaxLength(4);
      modal.addComponents(
        new ActionRowBuilder().addComponents(tokenInput),
        new ActionRowBuilder().addComponents(tempInput)
      );
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_embed_color') {
      const modal = new ModalBuilder().setCustomId('modal_set_embed_color').setTitle('🎨 ตั้งสี Embed คำตอบ AI');
      const input = new TextInputBuilder()
        .setCustomId('embed_color').setLabel('รหัสสี Hex เช่น #2ECA53').setStyle(TextInputStyle.Short)
        .setValue(cfg.embedColor || '#2ECA53').setRequired(true).setMaxLength(7);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_memory_turns') {
      const modal = new ModalBuilder().setCustomId('modal_set_memory_turns').setTitle('🔢 ตั้งจำนวนรอบความจำบทสนทนา');
      const input = new TextInputBuilder()
        .setCustomId('memory_turns').setLabel('จำนวนรอบสนทนาที่จำ (1-20)').setStyle(TextInputStyle.Short)
        .setValue(String(cfg.memoryTurns)).setRequired(true).setMaxLength(2);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_import_config') {
      const modal = new ModalBuilder().setCustomId('modal_import_config').setTitle('📥 Import Config (วาง JSON)');
      const input = new TextInputBuilder()
        .setCustomId('import_json').setLabel('วาง JSON ที่ได้จาก Export Config').setStyle(TextInputStyle.Paragraph)
        .setRequired(true).setMaxLength(4000);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_leveling_xp') {
      const modal = new ModalBuilder().setCustomId('modal_set_leveling_xp').setTitle('✨ ตั้งช่วง XP ต่อข้อความ');
      const minInput = new TextInputBuilder()
        .setCustomId('xp_min').setLabel('XP ต่ำสุด').setStyle(TextInputStyle.Short)
        .setValue(String(cfg.levelingXpMin)).setRequired(true).setMaxLength(5);
      const maxInput = new TextInputBuilder()
        .setCustomId('xp_max').setLabel('XP สูงสุด').setStyle(TextInputStyle.Short)
        .setValue(String(cfg.levelingXpMax)).setRequired(true).setMaxLength(5);
      modal.addComponents(
        new ActionRowBuilder().addComponents(minInput),
        new ActionRowBuilder().addComponents(maxInput)
      );
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_leveling_cooldown') {
      const modal = new ModalBuilder().setCustomId('modal_set_leveling_cooldown').setTitle('⏱️ ตั้ง Cooldown รับ XP');
      const input = new TextInputBuilder()
        .setCustomId('leveling_cooldown_seconds').setLabel('จำนวนวินาที (0-3600)').setStyle(TextInputStyle.Short)
        .setValue(String(cfg.levelingCooldownSeconds)).setRequired(true).setMaxLength(5);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_role_rewards') {
      const modal = new ModalBuilder().setCustomId('modal_set_role_rewards').setTitle('🎁 ตั้งยศรางวัลตามเลเวล');
      const input = new TextInputBuilder()
        .setCustomId('role_rewards_input').setLabel('1 บรรทัดต่อ 1 ยศ รูปแบบ เลเวล:RoleID').setStyle(TextInputStyle.Paragraph)
        .setValue(cfg.levelingRoleRewards || '').setRequired(false).setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_welcome_message') {
      const modal = new ModalBuilder().setCustomId('modal_set_welcome_message').setTitle('🎉 ตั้งข้อความต้อนรับ');
      const input = new TextInputBuilder()
        .setCustomId('welcome_message_input').setLabel('ใช้ {user} {server} {membercount} ได้').setStyle(TextInputStyle.Paragraph)
        .setValue(cfg.welcomeMessage || '').setRequired(true).setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_set_leave_message') {
      const modal = new ModalBuilder().setCustomId('modal_set_leave_message').setTitle('🚪 ตั้งข้อความอำลา');
      const input = new TextInputBuilder()
        .setCustomId('leave_message_input').setLabel('ใช้ {user} {server} {membercount} ได้').setStyle(TextInputStyle.Paragraph)
        .setValue(cfg.leaveMessage || '').setRequired(true).setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    // ----- ปุ่มพิเศษที่ไม่ผ่าน renderPanel แบบปกติ -----
    if (interaction.isButton() && interaction.customId === 'btn_avatar') {
      await interaction.update(buildMainPanel(cfg, interaction.guild)).catch(() => {});
      const r = await changeAvatarFromApi();
      return interaction.followUp({ content: r.success ? `✅ เปลี่ยนรูปแล้ว (${r.source})` : '❌ เปลี่ยนรูปไม่สำเร็จ ลองใหม่อีกครั้ง', ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_close_panel') {
      stopStatsAutoRefresh(interaction.message.id);
      await interaction.deferUpdate().catch(() => {});
      return interaction.message.delete().catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_export_config') {
      const buffer = Buffer.from(JSON.stringify(cfg, null, 2), 'utf-8');
      return interaction.reply({
        content: '📤 นี่คือไฟล์ Config ปัจจุบันของเซิร์ฟเวอร์นี้ (เก็บไว้ใช้ Import กลับได้ในอนาคต)',
        files: [{ attachment: buffer, name: `bot-config-${guildId}.json` }],
        ephemeral: true,
      }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_reset_config') {
      return interaction.reply({
        content: '⚠️ ยืนยันการรีเซ็ตการตั้งค่าทั้งหมดของเซิร์ฟเวอร์นี้กลับเป็นค่าเริ่มต้น?\nการกระทำนี้ไม่สามารถย้อนกลับได้!',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`btn_reset_confirm_${interaction.channelId}_${interaction.message.id}`).setLabel('✅ ยืนยันรีเซ็ต').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('btn_reset_cancel').setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Secondary)
        )],
        ephemeral: true,
      }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_reset_stats') {
      return interaction.reply({
        content: '⚠️ ยืนยันการรีเซ็ตสถิติทั้งหมดของเซิร์ฟเวอร์นี้?',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`btn_reset_stats_confirm_${interaction.channelId}_${interaction.message.id}`).setLabel('✅ ยืนยันรีเซ็ต').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('btn_reset_stats_cancel').setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Secondary)
        )],
        ephemeral: true,
      }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_reset_levels') {
      return interaction.reply({
        content: '⚠️ ยืนยันการรีเซ็ต XP/เลเวลของทุกคนในเซิร์ฟเวอร์นี้?\nการกระทำนี้ไม่สามารถย้อนกลับได้!',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`btn_reset_levels_confirm_${interaction.channelId}_${interaction.message.id}`).setLabel('✅ ยืนยันรีเซ็ต').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('btn_reset_levels_cancel').setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Secondary)
        )],
        ephemeral: true,
      }).catch(() => {});
    }

    // ----- ปุ่ม/เมนู/Modal ทั่วไป ที่แค่แก้ค่าแล้ววาดหน้าเดิม/หน้าที่เกี่ยวข้องใหม่ -----
    let renderPage = null;

    if (interaction.isButton() && interaction.customId === 'btn_toggle') {
      cfg.isActive = !cfg.isActive;
      renderPage = 'main';
    } else if (interaction.isButton() && interaction.customId === 'btn_refresh') {
      renderPage = 'main';
    } else if (interaction.isButton() && interaction.customId === 'btn_clear_prompt') {
      cfg.customPrompt = '';
      renderPage = 'main';
    } else if (interaction.isButton() && interaction.customId === 'btn_clear_api') {
      cfg.customApiKey = '';
      cfg.customApiUrl = '';
      cfg.customApiModel = '';
      renderPage = 'main';
    } else if (interaction.isButton() && interaction.customId === 'nav_main') {
      renderPage = 'main';
    } else if (interaction.isButton() && interaction.customId === 'nav_advanced') {
      renderPage = 'advanced';
    } else if (interaction.isButton() && interaction.customId === 'nav_access') {
      renderPage = 'access';
    } else if (interaction.isButton() && interaction.customId === 'nav_stats') {
      renderPage = 'stats';
    } else if (interaction.isButton() && interaction.customId === 'nav_leveling') {
      renderPage = 'leveling';
    } else if (interaction.isButton() && interaction.customId === 'nav_welcome') {
      renderPage = 'welcome';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_imagegen') {
      cfg.imageGenEnabled = !cfg.imageGenEnabled;
      renderPage = 'advanced';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_avatar_rotate') {
      globalConfig.avatarAutoRotate = !globalConfig.avatarAutoRotate;
      saveGlobalConfig();
      startAvatarAutoRotate();
      renderPage = 'advanced';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_language') {
      cfg.replyLanguage = cfg.replyLanguage === 'en' ? 'th' : 'en';
      renderPage = 'advanced';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_response_format') {
      cfg.responseFormat = cfg.responseFormat === 'embed' ? 'text' : 'embed';
      renderPage = 'advanced';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_memory') {
      cfg.memoryEnabled = !cfg.memoryEnabled;
      renderPage = 'advanced';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_admin_access') {
      cfg.allowAdminAccess = !cfg.allowAdminAccess;
      renderPage = 'advanced';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_filter_mode') {
      cfg.filterMode = cfg.filterMode === 'whitelist' ? 'blacklist' : 'whitelist';
      renderPage = 'access';
    } else if (interaction.isButton() && interaction.customId === 'btn_clear_blacklist') {
      cfg.blacklistUserIds = [];
      renderPage = 'access';
    } else if (interaction.isButton() && interaction.customId === 'btn_clear_whitelist') {
      cfg.whitelistUserIds = [];
      renderPage = 'access';
    } else if (interaction.isButton() && interaction.customId === 'btn_refresh_stats') {
      renderPage = 'stats';
    } else if (interaction.isStringSelectMenu() && interaction.customId === 'select_mode') {
      cfg.mode = interaction.values[0];
      cfg.customPrompt = '';
      renderPage = 'main';
    } else if (interaction.isRoleSelectMenu() && interaction.customId === 'select_roles') {
      cfg.targetRoleIds = interaction.values;
      renderPage = 'main';
    } else if (interaction.isChannelSelectMenu() && interaction.customId === 'select_channels') {
      cfg.targetChannelIds = interaction.values;
      renderPage = 'main';
    } else if (interaction.isChannelSelectMenu() && interaction.customId === 'select_log_channel') {
      cfg.logChannelId = interaction.values[0] || '';
      renderPage = 'advanced';
    } else if (interaction.isUserSelectMenu() && interaction.customId === 'select_blacklist_users') {
      cfg.blacklistUserIds = interaction.values;
      renderPage = 'access';
    } else if (interaction.isUserSelectMenu() && interaction.customId === 'select_whitelist_users') {
      cfg.whitelistUserIds = interaction.values;
      renderPage = 'access';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_prompt') {
      cfg.customPrompt = interaction.fields.getTextInputValue('prompt_input').trim();
      renderPage = 'main';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_api') {
      cfg.customApiKey = interaction.fields.getTextInputValue('api_keys').trim();
      cfg.customApiUrl = interaction.fields.getTextInputValue('api_url').trim();
      cfg.customApiModel = interaction.fields.getTextInputValue('api_model').trim();
      renderPage = 'main';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_cooldown') {
      const raw = parseInt(interaction.fields.getTextInputValue('cooldown_seconds'), 10);
      if (Number.isNaN(raw) || raw < 0 || raw > 3600) {
        return interaction.reply({ content: '❌ กรุณาใส่ตัวเลขวินาทีระหว่าง 0-3600', ephemeral: true }).catch(() => {});
      }
      cfg.cooldownSeconds = raw;
      renderPage = 'advanced';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_avatar_interval') {
      const raw = parseInt(interaction.fields.getTextInputValue('avatar_minutes'), 10);
      if (Number.isNaN(raw) || raw < 5 || raw > 10080) {
        return interaction.reply({ content: '❌ กรุณาใส่ตัวเลขนาทีระหว่าง 5-10080 (7 วัน)', ephemeral: true }).catch(() => {});
      }
      globalConfig.avatarRotateMinutes = raw;
      saveGlobalConfig();
      startAvatarAutoRotate();
      renderPage = 'advanced';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_status_text') {
      const raw = interaction.fields.getTextInputValue('status_text').trim();
      if (!raw) {
        return interaction.reply({ content: '❌ ข้อความสถานะห้ามว่าง', ephemeral: true }).catch(() => {});
      }
      globalConfig.statusText = raw;
      saveGlobalConfig();
      client.user.setActivity(globalConfig.statusText, { type: ActivityType.Playing });
      renderPage = 'advanced';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_ai_params') {
      const tokens = parseInt(interaction.fields.getTextInputValue('max_tokens'), 10);
      const temp = parseFloat(interaction.fields.getTextInputValue('temperature'));
      if (Number.isNaN(tokens) || tokens < 50 || tokens > 4096) {
        return interaction.reply({ content: '❌ Max Tokens ต้องเป็นตัวเลขระหว่าง 50-4096', ephemeral: true }).catch(() => {});
      }
      if (Number.isNaN(temp) || temp < 0 || temp > 2) {
        return interaction.reply({ content: '❌ Temperature ต้องเป็นตัวเลขระหว่าง 0.0-2.0', ephemeral: true }).catch(() => {});
      }
      cfg.maxTokens = tokens;
      cfg.temperature = temp;
      renderPage = 'advanced';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_embed_color') {
      const raw = interaction.fields.getTextInputValue('embed_color').trim();
      const clean = raw.startsWith('#') ? raw : `#${raw}`;
      if (!/^#[0-9A-Fa-f]{6}$/.test(clean)) {
        return interaction.reply({ content: '❌ รูปแบบสีไม่ถูกต้อง กรุณาใส่ Hex Code เช่น #2ECA53', ephemeral: true }).catch(() => {});
      }
      cfg.embedColor = clean.toUpperCase();
      renderPage = 'advanced';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_memory_turns') {
      const raw = parseInt(interaction.fields.getTextInputValue('memory_turns'), 10);
      if (Number.isNaN(raw) || raw < 1 || raw > 20) {
        return interaction.reply({ content: '❌ กรุณาใส่ตัวเลขระหว่าง 1-20', ephemeral: true }).catch(() => {});
      }
      cfg.memoryTurns = raw;
      renderPage = 'advanced';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_import_config') {
      const raw = interaction.fields.getTextInputValue('import_json');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return interaction.reply({ content: '❌ JSON ไม่ถูกต้อง กรุณาตรวจสอบรูปแบบอีกครั้ง', ephemeral: true }).catch(() => {});
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return interaction.reply({ content: '❌ ข้อมูลที่วางไม่ใช่ Config ที่ถูกต้อง', ephemeral: true }).catch(() => {});
      }
      safeMergeGuildConfig(guildId, parsed);
      renderPage = 'main';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_leveling') {
      cfg.levelingEnabled = !cfg.levelingEnabled;
      renderPage = 'leveling';
    } else if (interaction.isChannelSelectMenu() && interaction.customId === 'select_leveling_ignored_channels') {
      cfg.levelingIgnoredChannelIds = interaction.values;
      renderPage = 'leveling';
    } else if (interaction.isChannelSelectMenu() && interaction.customId === 'select_leveling_announce_channel') {
      cfg.levelingAnnounceChannelId = interaction.values[0] || '';
      renderPage = 'leveling';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_leveling_xp') {
      const min = parseInt(interaction.fields.getTextInputValue('xp_min'), 10);
      const max = parseInt(interaction.fields.getTextInputValue('xp_max'), 10);
      if (Number.isNaN(min) || Number.isNaN(max) || min < 1 || max < min || max > 1000) {
        return interaction.reply({ content: '❌ กรุณาใส่ตัวเลขให้ถูกต้อง (ขั้นต่ำ >= 1, สูงสุด >= ขั้นต่ำ, ไม่เกิน 1000)', ephemeral: true }).catch(() => {});
      }
      cfg.levelingXpMin = min;
      cfg.levelingXpMax = max;
      renderPage = 'leveling';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_leveling_cooldown') {
      const raw = parseInt(interaction.fields.getTextInputValue('leveling_cooldown_seconds'), 10);
      if (Number.isNaN(raw) || raw < 0 || raw > 3600) {
        return interaction.reply({ content: '❌ กรุณาใส่ตัวเลขวินาทีระหว่าง 0-3600', ephemeral: true }).catch(() => {});
      }
      cfg.levelingCooldownSeconds = raw;
      renderPage = 'leveling';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_role_rewards') {
      cfg.levelingRoleRewards = interaction.fields.getTextInputValue('role_rewards_input').trim();
      renderPage = 'leveling';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_welcome') {
      cfg.welcomeEnabled = !cfg.welcomeEnabled;
      renderPage = 'welcome';
    } else if (interaction.isButton() && interaction.customId === 'btn_toggle_leave') {
      cfg.leaveEnabled = !cfg.leaveEnabled;
      renderPage = 'welcome';
    } else if (interaction.isChannelSelectMenu() && interaction.customId === 'select_welcome_channel') {
      cfg.welcomeChannelId = interaction.values[0] || '';
      renderPage = 'welcome';
    } else if (interaction.isChannelSelectMenu() && interaction.customId === 'select_leave_channel') {
      cfg.leaveChannelId = interaction.values[0] || '';
      renderPage = 'welcome';
    } else if (interaction.isRoleSelectMenu() && interaction.customId === 'select_auto_role') {
      cfg.autoRoleId = interaction.values[0] || '';
      renderPage = 'welcome';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_welcome_message') {
      const raw = interaction.fields.getTextInputValue('welcome_message_input').trim();
      if (!raw) {
        return interaction.reply({ content: '❌ ข้อความห้ามว่าง', ephemeral: true }).catch(() => {});
      }
      cfg.welcomeMessage = raw;
      renderPage = 'welcome';
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_leave_message') {
      const raw = interaction.fields.getTextInputValue('leave_message_input').trim();
      if (!raw) {
        return interaction.reply({ content: '❌ ข้อความห้ามว่าง', ephemeral: true }).catch(() => {});
      }
      cfg.leaveMessage = raw;
      renderPage = 'welcome';
    }

    if (renderPage) {
      return renderPanel(interaction, renderPage, guildId, cfg);
    }
  } catch (err) {
    console.error('❌ Interaction Error:', err.message);
  }
});

// ==========================================
// 🛡️ 19. ป้องกันบอทล่มจาก Error ที่ไม่คาดคิด + เริ่มการทำงาน
// ==========================================
process.on('unhandledRejection', (reason) => {
  console.error('🔴 Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🔴 Uncaught Exception:', err);
});

client.login(TOKEN);

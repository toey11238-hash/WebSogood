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
// 📁 2. ระบบ Config (แยกตามเซิร์ฟเวอร์ - Multi-Guild) + Config บอทรวม (Global)
// ==========================================
// เหตุผลที่แยก 2 ระดับ:
//  - "Global Config" คือค่าที่เป็นของ "ตัวบอท" เอง เช่น รูปโปรไฟล์/สถานะ ซึ่งใช้ร่วมกันทุกเซิร์ฟเวอร์
//    (เพราะ Discord ให้บอท 1 ตัวมีรูปโปรไฟล์ได้ค่าเดียวเท่านั้น ไม่สามารถแยกตามเซิร์ฟเวอร์ได้จริง)
//  - "Guild Config" คือค่าที่เป็นของ "แต่ละเซิร์ฟเวอร์" เช่น โหมด, ห้องที่ตอบ, ยศที่ตอบ, API Key ฯลฯ
const DATA_DIR = path.join(__dirname, 'data');
const GUILDS_DIR = path.join(DATA_DIR, 'guilds');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GUILDS_DIR)) fs.mkdirSync(GUILDS_DIR, { recursive: true });

const GLOBAL_CONFIG_PATH = path.join(DATA_DIR, 'global-config.json');
const DEFAULT_GLOBAL_CONFIG = {
  statusText: 'รอรับคำสั่งเจ้านาย 💬',
  avatarAutoRotate: false,
  avatarRotateMinutes: 60,
};

function loadGlobalConfig() {
  try {
    if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
      fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(DEFAULT_GLOBAL_CONFIG, null, 2));
      return { ...DEFAULT_GLOBAL_CONFIG };
    }
    const raw = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_GLOBAL_CONFIG, ...raw };
  } catch (e) {
    console.error('⚠️ อ่าน global-config.json ไม่สำเร็จ ใช้ค่าเริ่มต้นแทน:', e.message);
    return { ...DEFAULT_GLOBAL_CONFIG };
  }
}

function saveGlobalConfig() {
  try {
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
  } catch (e) {
    console.error('⚠️ ไม่สามารถบันทึก global-config.json ได้:', e.message);
  }
}

let globalConfig = loadGlobalConfig();

const DEFAULT_GUILD_CONFIG = {
  isActive: true,
  mode: 'normal',
  customPrompt: '',
  customApiKey: '',       // รองรับหลาย Key คั่นด้วย , หรือขึ้นบรรทัดใหม่ (ใช้สำรองกันโควต้าหมด)
  customApiUrl: '',       // (ไม่บังคับ) กำหนด Base URL เองสำหรับ API ที่ Compatible กับ OpenAI
  customApiModel: '',     // (ไม่บังคับ) กำหนดชื่อโมเดลเอง
  targetChannelIds: [],
  targetRoleIds: [],
  filterMode: 'blacklist', // 'blacklist' = แบนบางคน / 'whitelist' = อนุญาตเฉพาะบางคน
  blacklistUserIds: [],
  whitelistUserIds: [],
  cooldownSeconds: 3,
  responseFormat: 'text',  // 'text' หรือ 'embed'
  embedColor: '#2ECA53',
  replyLanguage: 'th',     // 'th' หรือ 'en'
  maxTokens: 1000,
  temperature: 0.8,
  memoryEnabled: true,     // จำบทสนทนาก่อนหน้าของแต่ละคนเพื่อคุยแบบต่อเนื่อง (เรียลไทม์)
  memoryTurns: 6,          // จำกี่รอบสนทนาย้อนหลัง
  allowAdminAccess: true,  // อนุญาตให้ "แอดมินเซิร์ฟเวอร์" ใช้แผงควบคุมได้ (นอกเหนือจาก OWNER_ID)
  logChannelId: '',        // ห้องสำหรับส่ง log การตอบ/ข้อผิดพลาด (ไม่บังคับ)

  // ----- ระบบเลเวล/XP (ใหม่) -----
  levelingEnabled: false,       // เปิด/ปิดระบบเลเวล
  levelingXpMin: 15,            // XP ต่ำสุดที่ได้ต่อ 1 ข้อความ
  levelingXpMax: 25,            // XP สูงสุดที่ได้ต่อ 1 ข้อความ
  levelingCooldownSeconds: 60,  // กันสแปม XP (แยกต่างหากจาก Cooldown ของ AI)
  levelingIgnoredChannelIds: [], // ห้องที่ไม่นับ XP
  levelingAnnounceChannelId: '', // ห้องประกาศเลเวลอัพ (ว่าง = ประกาศในห้องที่คุยอยู่)
  levelingRoleRewards: '',       // ยศรางวัลตามเลเวล รูปแบบ "เลเวล:RoleID" 1 บรรทัดต่อ 1 ยศ

  // ----- ระบบสร้างภาพด้วย AI (ใหม่ - ฟรี ไม่ต้องมี API Key) -----
  imageGenEnabled: true, // เปิด/ปิดคำสั่ง /imagine และ !imagine

  // ----- ระบบต้อนรับ/อำลาสมาชิก + ยศอัตโนมัติ (ใหม่ - ฟรี ไม่ต้องมี API ใดๆ) -----
  welcomeEnabled: false,
  welcomeChannelId: '',
  welcomeMessage: 'ยินดีต้อนรับ {user} เข้าสู่ {server}! ตอนนี้เรามีสมาชิกทั้งหมด {membercount} คนแล้ว 🎉',
  leaveEnabled: false,
  leaveChannelId: '',
  leaveMessage: '{user} ออกจากเซิร์ฟเวอร์ไปแล้ว 👋',
  autoRoleId: '', // ยศที่จะแจกให้อัตโนมัติเมื่อมีคนเข้าเซิร์ฟเวอร์ใหม่
};

function guildConfigPath(guildId) {
  return path.join(GUILDS_DIR, `${guildId}.json`);
}

const guildConfigCache = new Map();

function getGuildConfig(guildId) {
  if (guildConfigCache.has(guildId)) return guildConfigCache.get(guildId);
  const filePath = guildConfigPath(guildId);
  let cfg;
  try {
    if (!fs.existsSync(filePath)) {
      cfg = { ...DEFAULT_GUILD_CONFIG };
      fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
    } else {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      cfg = { ...DEFAULT_GUILD_CONFIG, ...raw };
    }
  } catch (e) {
    console.error(`⚠️ อ่าน config ของกิลด์ ${guildId} ไม่สำเร็จ ใช้ค่าเริ่มต้นแทน:`, e.message);
    cfg = { ...DEFAULT_GUILD_CONFIG };
  }
  guildConfigCache.set(guildId, cfg);
  return cfg;
}

function saveGuildConfig(guildId) {
  const cfg = guildConfigCache.get(guildId);
  if (!cfg) return;
  try {
    fs.writeFileSync(guildConfigPath(guildId), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error(`⚠️ ไม่สามารถบันทึก config ของกิลด์ ${guildId} ได้:`, e.message);
  }
}

function resetGuildConfig(guildId) {
  const fresh = { ...DEFAULT_GUILD_CONFIG };
  guildConfigCache.set(guildId, fresh);
  saveGuildConfig(guildId);
  return fresh;
}

// Merge เฉพาะ key ที่รู้จักเท่านั้น (กันข้อมูลแปลกปลอมตอน Import Config)
function safeMergeGuildConfig(guildId, incomingObj) {
  const cfg = getGuildConfig(guildId);
  const allowedKeys = Object.keys(DEFAULT_GUILD_CONFIG);
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(incomingObj, key)) {
      const defaultVal = DEFAULT_GUILD_CONFIG[key];
      const incomingVal = incomingObj[key];
      // ตรวจชนิดข้อมูลคร่าวๆ ให้ตรงกับค่าเริ่มต้น กันพัง
      if (Array.isArray(defaultVal)) {
        if (Array.isArray(incomingVal)) cfg[key] = incomingVal.filter((v) => typeof v === 'string');
      } else if (typeof defaultVal === 'boolean') {
        if (typeof incomingVal === 'boolean') cfg[key] = incomingVal;
      } else if (typeof defaultVal === 'number') {
        if (typeof incomingVal === 'number' && !Number.isNaN(incomingVal)) cfg[key] = incomingVal;
      } else {
        if (typeof incomingVal === 'string') cfg[key] = incomingVal;
      }
    }
  }
  saveGuildConfig(guildId);
  return cfg;
}

// ==========================================
// 🏆 2.5 ระบบเลเวล/XP — เก็บข้อมูล XP ของแต่ละคนแยกตามเซิร์ฟเวอร์ (คนละไฟล์กับ Config)
// ==========================================
const LEVELS_DIR = path.join(DATA_DIR, 'levels');
if (!fs.existsSync(LEVELS_DIR)) fs.mkdirSync(LEVELS_DIR, { recursive: true });

const levelDataCache = new Map(); // guildId -> { [userId]: { xp, lastMessageAt } }

function levelDataPath(guildId) {
  return path.join(LEVELS_DIR, `${guildId}.json`);
}

function getLevelData(guildId) {
  if (levelDataCache.has(guildId)) return levelDataCache.get(guildId);
  let data = {};
  try {
    const p = levelDataPath(guildId);
    if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`⚠️ อ่านข้อมูลเลเวลของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    data = {};
  }
  levelDataCache.set(guildId, data);
  return data;
}

function saveLevelData(guildId) {
  const data = levelDataCache.get(guildId);
  if (!data) return;
  try {
    fs.writeFileSync(levelDataPath(guildId), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`⚠️ ไม่สามารถบันทึกข้อมูลเลเวลของกิลด์ ${guildId} ได้:`, e.message);
  }
}

function resetLevelData(guildId) {
  levelDataCache.set(guildId, {});
  saveLevelData(guildId);
}

// สูตรคำนวณ XP ที่ต้องใช้เพื่อขึ้นจาก `level` ไปเป็น `level + 1` (โตแบบ Quadratic ให้ยิ่งเลเวลสูงยิ่งใช้ XP เยอะขึ้น)
function xpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

// แปลง XP รวมทั้งหมด -> เลเวลปัจจุบัน + ความคืบหน้าในเลเวลนี้
function calculateLevel(totalXp) {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: xpForLevel(level) };
}

// สร้างแถบความคืบหน้าแบบอิโมจิ (ไม่ต้องพึ่ง Canvas/รูปภาพ เบาและเสถียรกว่า)
function makeProgressBar(current, max, size = 12) {
  const ratio = max > 0 ? Math.min(1, current / max) : 0;
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  return '🟩'.repeat(filled) + '⬜'.repeat(Math.max(0, size - filled));
}

// แปลงข้อความ "เลเวล:RoleID" (1 บรรทัดต่อ 1 ยศ) เป็น Object { level: roleId }
function parseRoleRewards(raw) {
  const map = {};
  if (!raw) return map;
  raw.split('\n').forEach((line) => {
    const parts = line.split(':').map((s) => s.trim());
    const lvl = parseInt(parts[0], 10);
    const roleId = parts[1];
    if (!Number.isNaN(lvl) && roleId) map[lvl] = roleId;
  });
  return map;
}

// ==========================================
// 🎉 2.6 ระบบ Giveaway — เก็บข้อมูลกิจกรรมแจกของรางวัลแยกตามเซิร์ฟเวอร์ (ฟรี ไม่ต้องพึ่ง API ภายนอก)
// ==========================================
const GIVEAWAYS_DIR = path.join(DATA_DIR, 'giveaways');
if (!fs.existsSync(GIVEAWAYS_DIR)) fs.mkdirSync(GIVEAWAYS_DIR, { recursive: true });

const giveawayCache = new Map(); // guildId -> { [messageId]: { prize, winnerCount, entries, endTime, channelId, ended, winners } }

function giveawayPath(guildId) {
  return path.join(GIVEAWAYS_DIR, `${guildId}.json`);
}

function getGiveaways(guildId) {
  if (giveawayCache.has(guildId)) return giveawayCache.get(guildId);
  let data = {};
  try {
    const p = giveawayPath(guildId);
    if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`⚠️ อ่านข้อมูล Giveaway ของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    data = {};
  }
  giveawayCache.set(guildId, data);
  return data;
}

function saveGiveaways(guildId) {
  const data = giveawayCache.get(guildId);
  if (!data) return;
  try {
    fs.writeFileSync(giveawayPath(guildId), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`⚠️ ไม่สามารถบันทึกข้อมูล Giveaway ของกิลด์ ${guildId} ได้:`, e.message);
  }
}

// โหลดไฟล์ Giveaway ทั้งหมดที่มีอยู่บนดิสก์เข้าหน่วยความจำตอนบอทเริ่มทำงาน
// เพื่อให้กิจกรรมที่ค้างอยู่ (ยังไม่ครบเวลา) ถูกตรวจเช็คและจบได้ถูกต้องแม้บอทจะรีสตาร์ทไปแล้ว
function loadAllGiveawaysFromDisk() {
  try {
    const files = fs.readdirSync(GIVEAWAYS_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const guildId = file.replace('.json', '');
        getGiveaways(guildId);
      }
    }
  } catch (e) {
    console.error('⚠️ โหลดข้อมูล Giveaway จากดิสก์ไม่สำเร็จ:', e.message);
  }
}
loadAllGiveawaysFromDisk();

// แปลงข้อความระยะเวลาแบบอ่านง่าย เช่น "30s", "10m", "2h", "1d" ให้เป็นมิลลิวินาที (คืนค่า null ถ้ารูปแบบผิด)
function parseDuration(text) {
  const match = /^(\d+)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day)s?$/i.exec(String(text).trim());
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000, sec: 1000, second: 1000,
    m: 60000, min: 60000, minute: 60000,
    h: 3600000, hr: 3600000, hour: 3600000,
    d: 86400000, day: 86400000,
  };
  return num * (multipliers[unit] || 0);
}

// ==========================================
// 🔮 2.7 ระบบคำทำนาย AI (Prophecy) — บอททำนายเรื่องสนุกๆ ของเซิร์ฟเวอร์ ผนึกไว้ แล้วเปิดผนึกเองเมื่อครบเวลา
// ==========================================
const PROPHECIES_DIR = path.join(DATA_DIR, 'prophecies');
if (!fs.existsSync(PROPHECIES_DIR)) fs.mkdirSync(PROPHECIES_DIR, { recursive: true });

const propheciesCache = new Map(); // guildId -> { [messageId]: { topic, prediction, mode, revealTime, channelId, authorId, revealed, epilogue } }

function propheciesPath(guildId) {
  return path.join(PROPHECIES_DIR, `${guildId}.json`);
}

function getProphecies(guildId) {
  if (propheciesCache.has(guildId)) return propheciesCache.get(guildId);
  let data = {};
  try {
    const p = propheciesPath(guildId);
    if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`⚠️ อ่านข้อมูลคำทำนายของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    data = {};
  }
  propheciesCache.set(guildId, data);
  return data;
}

function saveProphecies(guildId) {
  const data = propheciesCache.get(guildId);
  if (!data) return;
  try {
    fs.writeFileSync(propheciesPath(guildId), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`⚠️ ไม่สามารถบันทึกข้อมูลคำทำนายของกิลด์ ${guildId} ได้:`, e.message);
  }
}

function loadAllPropheciesFromDisk() {
  try {
    const files = fs.readdirSync(PROPHECIES_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) getProphecies(file.replace('.json', ''));
    }
  } catch (e) {
    console.error('⚠️ โหลดข้อมูลคำทำนายจากดิสก์ไม่สำเร็จ:', e.message);
  }
}
loadAllPropheciesFromDisk();

// ==========================================
// 🎭 3. โหมดบอท
// ==========================================
const MODE_LABELS = {
  normal: '😊 ปกติ (น่ารัก)',
  troll: '😜 กวนโอ๊ย',
  serious: '🧐 จริงจัง',
  polite: '🙏 สุภาพ',
  teacher: '📚 ครูใจดี',
  friend: '🧑‍🤝‍🧑 เพื่อนสนิท',
  hacker: '💻 นักพัฒนา/สายเทค',
};
const MODE_PROMPTS = {
  normal: 'คุณคือผู้ช่วยสุดน่ารัก ตอบเป็นภาษาไทย สั้นๆ กระชับ เป็นมิตร',
  troll: 'คุณคือเพื่อนซี้ปากแจ๋ว ตอบเป็นภาษาไทยแบบกวนโอ๊ยขำๆแต่ไม่หยาบคาย สั้นๆ',
  serious: 'คุณคือผู้เชี่ยวชาญ ตอบเป็นภาษาไทย มีสาระ ตรงไปตรงมา กระชับ',
  polite: 'คุณคือผู้ช่วยสุภาพเรียบร้อย ตอบเป็นภาษาไทย ใช้คำสุภาพลงท้ายด้วยครับ/ค่ะเสมอ',
  teacher: 'คุณคือครูใจดีที่อธิบายเรื่องยากๆให้เข้าใจง่ายด้วยตัวอย่างสั้นๆ ตอบเป็นภาษาไทย',
  friend: 'คุณคือเพื่อนสนิทที่คุยเป็นกันเอง ใช้ภาษาพูดปกติแบบเพื่อนแชทกัน ตอบเป็นภาษาไทย สั้นกระชับ',
  hacker: 'คุณคือผู้เชี่ยวชาญด้านโปรแกรมมิ่งและเทคโนโลยี ตอบเป็นภาษาไทยแบบกระชับตรงประเด็น ใส่โค้ดตัวอย่างเมื่อจำเป็น',
};

function getSystemPrompt(cfg) {
  const base = cfg.customPrompt && cfg.customPrompt.trim()
    ? cfg.customPrompt.trim()
    : (MODE_PROMPTS[cfg.mode] || MODE_PROMPTS.normal);
  if (cfg.replyLanguage === 'en') {
    return `${base}\n\n(Important: Always respond in English, regardless of what language the user writes in.)`;
  }
  return base;
}

// ==========================================
// 🧠 4. ระบบ AI หลายค่าย (ตรวจจับอัตโนมัติ + รองรับหลาย Key สำรอง + Custom Endpoint)
// ==========================================
function parseApiKeys(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function detectApiProvider(key, customUrl, customModel) {
  const k = (key || '').trim();
  let provider;

  if (k.startsWith('gsk_')) {
    // 1. Groq API (แจกฟรี 100% ตอบไวมาก)
    provider = { name: 'Groq (Llama 3.3)', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', key: k, type: 'openai' };
  } else if (k.startsWith('sk-or-v1-')) {
    // 2. OpenRouter API (แจกฟรีหลายโมเดล)
    provider = { name: 'OpenRouter (Free)', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free', key: k, type: 'openai' };
  } else if (k.startsWith('AIzaSy')) {
    // 3. Google Gemini API (แจกฟรี)
    provider = { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-1.5-flash', key: k, type: 'openai' };
  } else if (k.startsWith('sk-ant-')) {
    // 4. Anthropic Claude API (รูปแบบ Request/Response ไม่เหมือน OpenAI จึงต้องแยกจัดการ)
    provider = { name: 'Anthropic Claude', url: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-haiku-20241022', key: k, type: 'anthropic' };
  } else if (k.startsWith('sk-')) {
    // 5. OpenAI
    provider = { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', key: k, type: 'openai' };
  } else if (k) {
    // 6. ค่ายอื่นๆที่ไม่รู้จัก Prefix (สันนิษฐานว่า Compatible กับ OpenAI)
    provider = { name: 'OpenAI Compatible', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-3.5-turbo', key: k, type: 'openai' };
  } else {
    provider = { name: 'ไม่ระบุ', url: '', model: '', key: '', type: 'openai' };
  }

  // ถ้าผู้ใช้กำหนด Base URL / Model เองในแผงควบคุม ให้ทับค่าที่ตรวจจับได้อัตโนมัติ
  if (customUrl && customUrl.trim()) {
    provider.url = customUrl.trim();
    provider.name = `Custom Endpoint (${provider.name})`;
    if (provider.type === 'anthropic' && !customUrl.includes('anthropic.com')) provider.type = 'openai';
  }
  if (customModel && customModel.trim()) {
    provider.model = customModel.trim();
  }
  return provider;
}

const FALLBACK_ANSWERS = [
  'อืมมม... ว่าไงต่อนะ?',
  'พิมพ์มาแค่นี้ AI งงเลยนะเนี่ย 😅',
  'รับทราบ! มีอะไรให้รับใช้อีกไหม?',
  'ตอนนี้เซิร์ฟเวอร์ AI ฝั่งผมกำลังหน่วงๆ ขออภัยด้วยนะเจ้านาย 🥲',
  'ระบบ AI ทุกค่ายไม่ตอบสนองตอนนี้ ลองใหม่อีกครั้งสักครู่นะ 🙏',
];

function isValidAiResponse(reply) {
  if (typeof reply !== 'string') return false;
  const text = reply.trim().toLowerCase();
  if (!text) return false;
  if (text.includes('<!doctype html') || text.includes('<html')) return false;
  if (text === 'timed out' || text.includes('time out') || text === 'timeout') return false;
  if (text.includes('rate limit') || text.includes('too many requests')) return false;
  if (text.includes('502 bad gateway') || text.includes('503 service unavailable') || text.includes('error 500')) return false;
  if (text.includes('{"error":') || text.includes('internal server error')) return false;
  return true;
}

function trimReply(reply) {
  return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
}

// เรียก Provider จริง โดยแยก Logic ระหว่าง Anthropic (รูปแบบ /v1/messages) กับค่ายสไตล์ OpenAI (/v1/chat/completions)
async function callProvider(cfg, provider, systemPrompt, historyMessages, userText) {
  if (!provider.key || !provider.url) throw new Error('ไม่มี API Key หรือ URL');

  if (provider.type === 'anthropic') {
    const res = await axios.post(provider.url, {
      model: provider.model || 'claude-3-5-haiku-20241022',
      max_tokens: cfg.maxTokens || 1024,
      system: systemPrompt,
      messages: [...historyMessages, { role: 'user', content: userText }],
    }, {
      headers: {
        'x-api-key': provider.key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 15000,
    });
    const blocks = res.data?.content || [];
    const textBlock = blocks.find((b) => b.type === 'text');
    return textBlock ? textBlock.text : undefined;
  }

  const res = await axios.post(provider.url, {
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: userText },
    ],
    max_tokens: cfg.maxTokens || 1000,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.8,
  }, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.key}`,
    },
    timeout: 15000,
  });
  return res.data?.choices?.[0]?.message?.content;
}

// ฟังก์ชันหลักในการขอคำตอบจาก AI พร้อมระบบสำรองหลายชั้น:
//  ชั้น 1: Custom API Key ของผู้ใช้ (รองรับหลาย Key คั่นด้วย , หรือขึ้นบรรทัดใหม่ ลองทีละตัวจนกว่าจะสำเร็จ)
//  ชั้น 2: Pollinations (ฟรี ไม่ต้องมี Key) - ส่งบทสนทนาก่อนหน้าไปด้วยเพื่อความต่อเนื่อง
//  ชั้น 3: Hercai AI (ฟรีสำรอง)
//  ชั้น 4: Popcat Chatbot (ฟรีสำรอง)
//  ชั้น 5: ข้อความสำรองฉุกเฉิน (กันบอทเงียบไปเลย)
// คืนค่าเป็น { text, provider, latencyMs, usedFallback }
async function getAiResponse(cfg, historyMessages, text) {
  const systemPrompt = getSystemPrompt(cfg);
  const historyText = historyMessages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const fullPromptGET = `${systemPrompt}\n\n${historyText ? historyText + '\n' : ''}User: ${text}`;

  // 1️⃣ Custom API Key(s) ของผู้ใช้
  const keys = parseApiKeys(cfg.customApiKey);
  for (const rawKey of keys) {
    const provider = detectApiProvider(rawKey, cfg.customApiUrl, cfg.customApiModel);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const start = Date.now();
        const reply = await callProvider(cfg, provider, systemPrompt, historyMessages, text);
        const latencyMs = Date.now() - start;
        if (isValidAiResponse(reply)) {
          return { text: trimReply(reply), provider: provider.name, latencyMs, usedFallback: false };
        }
      } catch (e) {
        console.error(`❌ Custom API (${provider.name}) ครั้งที่ ${attempt + 1} ล้มเหลว:`, e.message);
      }
    }
  }

  // 2️⃣ API ฟรีหลัก (Pollinations POST) - ส่งบริบทบทสนทนาไปด้วย
  try {
    const start = Date.now();
    const res = await axios.post('https://text.pollinations.ai/', {
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: text },
      ],
      model: 'openai',
      seed: Math.floor(Math.random() * 1000000),
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });
    let reply = res.data;
    if (typeof reply === 'object' && reply && reply.content) reply = reply.content;
    const latencyMs = Date.now() - start;
    if (isValidAiResponse(reply)) {
      return { text: trimReply(reply), provider: 'Pollinations (ฟรี)', latencyMs, usedFallback: true };
    }
  } catch (e) {
    console.error('❌ Pollinations API Error:', e.message);
  }

  // 3️⃣ API ฟรีสำรองตัวที่ 2 (Hercai AI)
  try {
    const start = Date.now();
    const res = await axios.get(`https://hercai.onrender.com/v3/hercai?question=${encodeURIComponent(fullPromptGET)}`, { timeout: 15000 });
    const latencyMs = Date.now() - start;
    if (res.data && res.data.reply && isValidAiResponse(res.data.reply)) {
      return { text: trimReply(res.data.reply), provider: 'Hercai (ฟรี)', latencyMs, usedFallback: true };
    }
  } catch (e) {
    console.error('❌ Hercai API Error:', e.message);
  }

  // 4️⃣ API ฟรีสำรองตัวที่ 3 (Popcat Chatbot)
  try {
    const start = Date.now();
    const res = await axios.get(`https://api.popcat.xyz/chatbot?msg=${encodeURIComponent(text)}&owner=Owner&botname=AI`, { timeout: 10000 });
    const latencyMs = Date.now() - start;
    if (res.data && res.data.response && isValidAiResponse(res.data.response)) {
      return { text: trimReply(res.data.response), provider: 'Popcat (ฟรี)', latencyMs, usedFallback: true };
    }
  } catch (e) {
    console.error('❌ Popcat API Error:', e.message);
  }

  // 5️⃣ ข้อความสำรองฉุกเฉิน
  return {
    text: FALLBACK_ANSWERS[Math.floor(Math.random() * FALLBACK_ANSWERS.length)],
    provider: 'ข้อความสำรอง (ทุกค่ายล้มเหลว)',
    latencyMs: 0,
    usedFallback: true,
    isEmergencyFallback: true,
  };
}

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

// สร้างภาพจากคำบรรยาย แล้วคืนค่าเป็น Buffer ของรูป PNG พร้อมแนบใน Discord ได้ทันที
async function generateImage(prompt) {
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

function buildImagineEmbed(prompt, authorTag) {
  return new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('🎨 สร้างภาพเสร็จแล้ว')
    .setDescription(`พรอมต์: ${prompt.slice(0, 200)}`)
    .setImage('attachment://imagine.png')
    .setFooter({ text: `ขอโดย ${authorTag} • Pollinations AI (ฟรี ไม่ต้องมี API Key)` });
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

// ให้ 2 บุคลิกผลัดกันพูดตามหัวข้อที่กำหนด คนละ `rounds` รอบ แต่ละฝ่ายเห็นแค่บทพูดล่าสุดของอีกฝ่ายเท่านั้น (เหมือนโต้วาทีจริง)
async function runCouncilDebate(cfg, topic, modeA, modeB, rounds) {
  const transcript = [];
  const historyA = [];
  const historyB = [];
  let lastA = '';
  let lastB = '';

  for (let i = 0; i < rounds; i++) {
    const promptA = i === 0
      ? `หัวข้อโต้วาที: "${topic}"\nจงแสดงความเห็นแรกของคุณต่อหัวข้อนี้ สั้นกระชับไม่เกิน 3 ประโยค`
      : `หัวข้อโต้วาที: "${topic}"\nอีกฝ่ายเพิ่งพูดว่า: "${lastB}"\nจงโต้ตอบหรือเสริมความเห็นของคุณ สั้นกระชับไม่เกิน 3 ประโยค`;
    const cfgA = { ...cfg, mode: modeA, customPrompt: '' };
    const resA = await getAiResponse(cfgA, historyA, promptA);
    lastA = resA.text;
    transcript.push({ mode: modeA, text: lastA });
    historyA.push({ role: 'user', content: promptA }, { role: 'assistant', content: lastA });

    const promptB = `หัวข้อโต้วาที: "${topic}"\nอีกฝ่ายเพิ่งพูดว่า: "${lastA}"\nจงโต้ตอบหรือเสริมความเห็นของคุณ สั้นกระชับไม่เกิน 3 ประโยค`;
    const cfgB = { ...cfg, mode: modeB, customPrompt: '' };
    const resB = await getAiResponse(cfgB, historyB, promptB);
    lastB = resB.text;
    transcript.push({ mode: modeB, text: lastB });
    historyB.push({ role: 'user', content: promptB }, { role: 'assistant', content: lastB });
  }

  return transcript;
}

// กรรมการ AI (บุคลิก "จริงจัง" เสมอ ไม่ว่าเซิร์ฟเวอร์จะตั้งโหมดอะไรไว้ก็ตาม เพื่อความเป็นกลาง) อ่านบทสนทนาทั้งหมดแล้วตัดสิน
async function runCouncilVerdict(cfg, topic, transcript) {
  const summary = transcript.map((t) => `${MODE_LABELS[t.mode] || t.mode}: ${t.text}`).join('\n');
  const judgeCfg = {
    ...cfg,
    mode: 'serious',
    customPrompt: 'คุณคือกรรมการตัดสินการโต้วาทีที่เป็นกลาง อ่านบทสนทนาแล้วตัดสินว่าฝ่ายไหนโต้แย้งได้ดีกว่า พร้อมให้เหตุผลสั้นๆ ไม่เกิน 3 ประโยค ตอบเป็นภาษาไทยเท่านั้น',
  };
  const res = await getAiResponse(judgeCfg, [], `หัวข้อ: "${topic}"\n\nบทสนทนา:\n${summary}\n\nใครโต้แย้งได้ดีกว่ากัน เพราะอะไร?`);
  return res.text;
}

// ==========================================
// 🔮 4.7 ระบบคำทำนาย AI (Prophecy) — ให้เหตุผลด้านความปลอดภัย: บังคับให้ AI พูดแนวสนุกสนานเกี่ยวกับ
// "บรรยากาศ/กิจกรรมในเซิร์ฟเวอร์" เท่านั้น ห้ามทำนายเรื่องจริงจัง (ภัยพิบัติ/การเมือง/ความรุนแรง/เรื่องส่วนตัว)
// เพื่อไม่ให้ใครเข้าใจผิดว่าเป็นการทำนายจริงจัง — เป็นฟีเจอร์เพื่อความบันเทิงล้วนๆ
// ==========================================
const PROPHECY_SAFETY_RULE =
  'นี่คือฟีเจอร์เพื่อความบันเทิงในดิสคอร์ดเท่านั้น ห้ามทำนายเรื่องจริงจังหรือละเอียดอ่อนเด็ดขาด เช่น ภัยพิบัติ อุบัติเหตุ ความรุนแรง การเมือง สุขภาพ หรือเรื่องส่วนตัวของใครคนใดคนหนึ่ง ' +
  'ให้เน้นทำนายแนวสนุกสนาน เพ้อฝัน เกี่ยวกับบรรยากาศ กิจกรรม หรือเรื่องขำๆ ที่อาจเกิดขึ้นในเซิร์ฟเวอร์ Discord นี้เท่านั้น ตอบสั้นกระชับไม่เกิน 3 ประโยค';

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

async function generateProphecyText(cfg, topic) {
  const prophetCfg = {
    ...cfg,
    customPrompt: `คุณคือหมอดูทำนายดวงชะตาประจำเซิร์ฟเวอร์ Discord พูดจาลึกลับน่าค้นหาแบบขำๆ ${PROPHECY_SAFETY_RULE}`,
  };
  const userText = topic
    ? `จงทำนายเรื่อง "${topic}" ในเซิร์ฟเวอร์นี้`
    : 'จงทำนายเรื่องสนุกๆ ที่อาจเกิดขึ้นในเซิร์ฟเวอร์นี้';
  const res = await getAiResponse(prophetCfg, [], userText);
  return res.text;
}

async function generateProphecyEpilogue(cfg, prediction) {
  const prophetCfg = {
    ...cfg,
    customPrompt: `คุณคือหมอดูประจำเซิร์ฟเวอร์ Discord ที่กำลังเปิดผนึกคำทำนายเก่าของตัวเอง พูดแบบขำๆ ถ่อมตัวว่าทายไม่ได้จริงจัง ${PROPHECY_SAFETY_RULE}`,
  };
  const res = await getAiResponse(
    prophetCfg,
    [],
    `คำทำนายเดิมของคุณคือ: "${prediction}"\nตอนนี้ครบเวลาแล้ว จงพูดแบบขำๆ ปิดท้ายคำทำนายนี้ (ไม่ต้องฟันธงว่าทายถูกหรือผิดจริง เพราะคุณไม่มีทางรู้ข้อมูลจริง แค่พูดแบบหมอดูขำๆ ปิดฉาก)`
  );
  return res.text;
}

function buildProphecyEmbed(topic, prediction, revealTime, revealed, epilogue) {
  const embed = new EmbedBuilder()
    .setColor(revealed ? 0x95A5A6 : 0x6C5CE7)
    .setTitle(revealed ? '🔮 คำทำนายเปิดผนึกแล้ว!' : '🔮 คำทำนายถูกผนึกไว้...')
    .setDescription(
      `${topic ? `🎯 เรื่อง: **${topic}**\n\n` : ''}` +
      `📜 คำทำนาย: *${prediction}*\n\n` +
      (revealed
        ? `✨ **บทปิดท้ายจากหมอดู**\n${epilogue}`
        : `⏰ จะเปิดผนึกอัตโนมัติ: <t:${Math.floor(revealTime / 1000)}:R>`)
    )
    .setFooter({ text: revealed ? 'ฟีเจอร์เพื่อความบันเทิงเท่านั้น ไม่ใช่การทำนายจริงจัง' : 'อดใจรอ... โชคชะตาจะเปิดเผยเมื่อถึงเวลา 🌙' });
  return embed;
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

// เช็คทุก 30 วินาทีว่ามีคำทำนายไหนครบเวลาผนึกแล้วบ้าง (แบบเดียวกับระบบ Giveaway เพื่อทนต่อการรีสตาร์ทบอท)
setInterval(() => {
  const now = Date.now();
  for (const [guildId, prophecies] of propheciesCache.entries()) {
    for (const [messageId, p] of Object.entries(prophecies)) {
      if (!p.revealed && p.revealTime <= now) {
        revealProphecy(guildId, messageId).catch(() => {});
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

function formatUptime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (days) parts.push(`${days}วัน`);
  if (hours) parts.push(`${hours}ชม.`);
  if (minutes) parts.push(`${minutes}นาที`);
  parts.push(`${seconds}วิ`);
  return parts.join(' ');
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
const fmtChannels = (ids) => (ids.length ? ids.map((id) => `<#${id}>`).join(' ') : 'ทุกห้อง');
const fmtRoles = (ids) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : 'ทุกคน');
function fmtUsers(ids, emptyLabel) {
  if (!ids.length) return emptyLabel;
  const shown = ids.slice(0, 15).map((id) => `<@${id}>`).join(' ');
  return ids.length > 15 ? `${shown} และอีก ${ids.length - 15} คน` : shown;
}

function parseColor(hex) {
  if (!hex) return 0x2ECA53;
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return Number.isNaN(n) ? 0x2ECA53 : n;
}

function apiStatusLine(cfg) {
  const keys = parseApiKeys(cfg.customApiKey);
  if (!keys.length) return '🔴 ใช้ระบบฟรีอัตโนมัติ (Pollinations/Hercai/Popcat)';
  const names = keys.map((k) => detectApiProvider(k, cfg.customApiUrl, cfg.customApiModel).name);
  const unique = [...new Set(names)];
  return `🟢 ใช้ ${keys.length} คีย์: **${unique.join(', ')}**`;
}

function buildMainPanel(cfg, guild) {
  const promptLine = cfg.customPrompt && cfg.customPrompt.trim()
    ? `📝 Prompt กำหนดเอง: ${cfg.customPrompt.trim().slice(0, 60)}${cfg.customPrompt.trim().length > 60 ? '...' : ''}`
    : `🎭 โหมด: ${MODE_LABELS[cfg.mode] || cfg.mode}`;

  const embed = new EmbedBuilder()
    .setTitle(`🎛️ แผงควบคุมบอท AI — ${guild ? guild.name : ''}`)
    .setColor(cfg.isActive ? 0x2ECA53 : 0xE74C3C)
    .setDescription(
      `สถานะ: **${cfg.isActive ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n` +
      `🌐 ระบบ AI: ${apiStatusLine(cfg)}\n` +
      `${promptLine}\n` +
      `📌 ห้องที่ตอบ: ${fmtChannels(cfg.targetChannelIds)}\n` +
      `🎖️ ยศที่ตอบ: ${fmtRoles(cfg.targetRoleIds)}\n` +
      `⏱️ กันสแปม: ${cfg.cooldownSeconds} วินาที | 💬 ความจำบทสนทนา: ${cfg.memoryEnabled ? `เปิด (${cfg.memoryTurns} รอบ)` : 'ปิด'}\n` +
      `🈂️ ภาษาที่ตอบ: ${cfg.replyLanguage === 'en' ? 'English' : 'ไทย'} | 🧾 รูปแบบคำตอบ: ${cfg.responseFormat === 'embed' ? 'Embed' : 'ข้อความปกติ'}`
    )
    .setFooter({ text: 'หน้าหลัก • ใช้ปุ่มด้านล่างเพื่อไปหน้าตั้งค่าขั้นสูง / สถิติ / สิทธิ์การใช้งาน' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle').setLabel(cfg.isActive ? '🟢 ทำงานอยู่' : '🔴 ปิดอยู่').setStyle(cfg.isActive ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_refresh').setLabel('🔄 รีเฟรช').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_avatar').setLabel('🖼️ สุ่มรูป').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nav_advanced').setLabel('⚙️ ขั้นสูง').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_stats').setLabel('📊 สถิติ').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_set_prompt').setLabel('📝 ตั้ง Prompt').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_clear_prompt').setLabel('🗑️ ล้าง Prompt').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_set_api').setLabel('🔑 ใส่ API Key').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_clear_api').setLabel('🔌 ล้าง API Key').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('nav_access').setLabel('🚫 สิทธิ์การใช้').setStyle(ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('select_mode').setPlaceholder('🎭 เปลี่ยนโหมดนิสัยบอท')
      .addOptions(Object.entries(MODE_LABELS).map(([value, label]) => ({ label, value, default: cfg.mode === value })))
  );

  const row4 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('select_roles').setPlaceholder('🎖️ เลือกยศที่ให้บอทตอบ (ไม่เลือก = ทุกคน)')
      .setMinValues(0).setMaxValues(5)
  );

  const row5 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_channels').setPlaceholder('📌 เลือกห้องที่ให้บอทตอบ (ไม่เลือก = ทุกห้อง)')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0).setMaxValues(5)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

function buildAdvancedPanel(cfg, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ตั้งค่าขั้นสูง — ${guild ? guild.name : ''}`)
    .setColor(0x5865F2)
    .setDescription(
      `⏱️ กันสแปม (Cooldown): ${cfg.cooldownSeconds} วินาที\n` +
      `🖼️ สุ่มรูปโปรไฟล์อัตโนมัติ (ทั้งบอท): ${globalConfig.avatarAutoRotate ? `เปิด ทุก ${globalConfig.avatarRotateMinutes} นาที` : 'ปิด'}\n` +
      `🏷️ ข้อความสถานะบอท (ทั้งบอท): ${globalConfig.statusText}\n` +
      `🈂️ ภาษาที่ตอบ: ${cfg.replyLanguage === 'en' ? 'English' : 'ไทย'}\n` +
      `🧠 Max Tokens: ${cfg.maxTokens} | 🌡️ Temperature: ${cfg.temperature}\n` +
      `🧾 รูปแบบคำตอบ: ${cfg.responseFormat === 'embed' ? `Embed (สี ${cfg.embedColor})` : 'ข้อความปกติ'}\n` +
      `💬 ความจำบทสนทนา: ${cfg.memoryEnabled ? `เปิด (${cfg.memoryTurns} รอบ, ลืมอัตโนมัติหลังไม่คุย 30 นาที)` : 'ปิด'}\n` +
      `👮 อนุญาตแอดมินเซิร์ฟเวอร์ใช้แผงควบคุม: ${cfg.allowAdminAccess ? 'เปิด' : 'ปิด'}\n` +
      `📜 ห้อง Log: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'ไม่ได้ตั้งค่า'}\n` +
      `🎨 สร้างภาพด้วย AI (/imagine): ${cfg.imageGenEnabled ? `เปิด (กันสแปม ${IMAGE_GEN_COOLDOWN_SECONDS} วิ)` : 'ปิด'}`
    )
    .setFooter({ text: '🖼️/🏷️ เป็นค่าระดับ "ทั้งบอท" เพราะ Discord จำกัดรูปโปรไฟล์บอทได้ค่าเดียว ส่วนอื่นๆ เป็นค่าเฉพาะเซิร์ฟเวอร์นี้' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_set_cooldown').setLabel('⏱️ ตั้ง Cooldown').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_avatar_rotate').setLabel(globalConfig.avatarAutoRotate ? '🖼️ สุ่มรูปอัตโนมัติ: เปิด' : '🖼️ สุ่มรูปอัตโนมัติ: ปิด').setStyle(globalConfig.avatarAutoRotate ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_avatar_interval').setLabel('⏲️ ตั้งรอบสุ่มรูป').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_status_text').setLabel('🏷️ ตั้งข้อความสถานะ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_language').setLabel(cfg.replyLanguage === 'en' ? '🈂️ ภาษา: English' : '🈂️ ภาษา: ไทย').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_set_ai_params').setLabel('🧠 ตั้ง Token/Temp').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_response_format').setLabel(cfg.responseFormat === 'embed' ? '🧾 รูปแบบ: Embed' : '🧾 รูปแบบ: ข้อความ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_embed_color').setLabel('🎨 ตั้งสี Embed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_memory').setLabel(cfg.memoryEnabled ? '💬 ความจำ: เปิด' : '💬 ความจำ: ปิด').setStyle(cfg.memoryEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_memory_turns').setLabel('🔢 ตั้งจำนวนความจำ').setStyle(ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_export_config').setLabel('📤 Export Config').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_import_config').setLabel('📥 Import Config').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_reset_config').setLabel('♻️ รีเซ็ตทั้งหมด').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_toggle_admin_access').setLabel(cfg.allowAdminAccess ? '👮 แอดมินใช้ได้: เปิด' : '👮 แอดมินใช้ได้: ปิด').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ กลับหน้าหลัก').setStyle(ButtonStyle.Secondary)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_log_channel').setPlaceholder('📜 เลือกห้องสำหรับส่ง Log (ไม่เลือก = ปิด)')
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)
  );

  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_access').setLabel('🚫 หน้าสิทธิ์การใช้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_stats').setLabel('📊 หน้าสถิติ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_leveling').setLabel('🏆 หน้าเลเวล').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_imagegen').setLabel(cfg.imageGenEnabled ? '🎨 สร้างภาพ: เปิด' : '🎨 สร้างภาพ: ปิด').setStyle(cfg.imageGenEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_close_panel').setLabel('❌ ปิดแผง').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

function buildAccessPanel(cfg, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`🚫 สิทธิ์การใช้งาน (Blacklist / Whitelist) — ${guild ? guild.name : ''}`)
    .setColor(0xE67E22)
    .setDescription(
      `โหมดปัจจุบัน: **${cfg.filterMode === 'whitelist' ? '✅ Whitelist (อนุญาตเฉพาะที่เลือก)' : '🚫 Blacklist (แบนเฉพาะที่เลือก)'}**\n\n` +
      `🚫 Blacklist (${cfg.blacklistUserIds.length} คน): ${fmtUsers(cfg.blacklistUserIds, 'ไม่มี')}\n\n` +
      `✅ Whitelist (${cfg.whitelistUserIds.length} คน): ${fmtUsers(cfg.whitelistUserIds, 'ไม่มี')}`
    )
    .setFooter({ text: cfg.filterMode === 'whitelist' ? 'โหมด Whitelist: บอทจะตอบเฉพาะคนในลิสต์นี้เท่านั้น' : 'โหมด Blacklist: บอทจะไม่ตอบคนในลิสต์นี้' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle_filter_mode').setLabel(cfg.filterMode === 'whitelist' ? '🔁 สลับเป็น Blacklist' : '🔁 สลับเป็น Whitelist').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_clear_blacklist').setLabel('🗑️ ล้าง Blacklist').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_clear_whitelist').setLabel('🗑️ ล้าง Whitelist').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('nav_welcome').setLabel('👋 หน้าต้อนรับ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ กลับหน้าหลัก').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('select_blacklist_users').setPlaceholder('🚫 เลือกผู้ใช้ที่จะแบน (Blacklist)')
      .setMinValues(0).setMaxValues(25)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('select_whitelist_users').setPlaceholder('✅ เลือกผู้ใช้ที่อนุญาต (Whitelist)')
      .setMinValues(0).setMaxValues(25)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_advanced').setLabel('⚙️ หน้าขั้นสูง').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_stats').setLabel('📊 หน้าสถิติ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_leveling').setLabel('🏆 หน้าเลเวล').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_close_panel').setLabel('❌ ปิดแผง').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4] };
}

// ==========================================
// 🏆 11.5 หน้าแผงควบคุมระบบเลเวล/XP
// ==========================================
function buildLevelingPanel(cfg, guild) {
  const rewards = parseRoleRewards(cfg.levelingRoleRewards);
  const rewardEntries = Object.entries(rewards).sort((a, b) => Number(a[0]) - Number(b[0]));
  const rewardLines = rewardEntries.length
    ? rewardEntries.map(([lvl, roleId]) => `• เลเวล ${lvl} → <@&${roleId}>`).join('\n')
    : 'ไม่มี';

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ระบบเลเวล/XP — ${guild ? guild.name : ''}`)
    .setColor(cfg.levelingEnabled ? 0xF1C40F : 0x95A5A6)
    .setDescription(
      `สถานะ: **${cfg.levelingEnabled ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n` +
      `✨ XP ต่อข้อความ: ${cfg.levelingXpMin}-${cfg.levelingXpMax}\n` +
      `⏱️ กันสแปม XP: ${cfg.levelingCooldownSeconds} วินาที\n` +
      `🚫 ห้องที่ไม่นับ XP: ${fmtChannels(cfg.levelingIgnoredChannelIds)}\n` +
      `📢 ห้องประกาศเลเวลอัพ: ${cfg.levelingAnnounceChannelId ? `<#${cfg.levelingAnnounceChannelId}>` : 'ห้องที่คุยอยู่ตอนนั้น'}\n\n` +
      `🎁 ยศรางวัลตามเลเวล:\n${rewardLines}`
    )
    .setFooter({ text: 'ใช้ /rank ดูเลเวลตัวเอง และ /leaderboard ดูอันดับ (หรือ !rank, !leaderboard)' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle_leveling').setLabel(cfg.levelingEnabled ? '🟢 ระบบเลเวล: เปิด' : '🔴 ระบบเลเวล: ปิด').setStyle(cfg.levelingEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_leveling_xp').setLabel('✨ ตั้งช่วง XP').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_leveling_cooldown').setLabel('⏱️ ตั้ง Cooldown XP').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_role_rewards').setLabel('🎁 ตั้งยศรางวัล').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_reset_levels').setLabel('♻️ รีเซ็ต XP ทั้งหมด').setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_leveling_ignored_channels').setPlaceholder('🚫 เลือกห้องที่ไม่นับ XP (ไม่เลือก = นับทุกห้อง)')
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(10)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_leveling_announce_channel').setPlaceholder('📢 เลือกห้องประกาศเลเวลอัพ (ไม่เลือก = ห้องที่คุยอยู่)')
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 หน้าหลัก').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_advanced').setLabel('⚙️ ขั้นสูง').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_access').setLabel('🚫 สิทธิ์การใช้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_stats').setLabel('📊 สถิติ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_close_panel').setLabel('❌ ปิดแผง').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4] };
}

// ==========================================
// 👋 11.6 หน้าแผงควบคุมระบบต้อนรับ/อำลาสมาชิก + ยศอัตโนมัติ
// ==========================================
function buildWelcomePanel(cfg, guild) {
  const welcomeMsgPreview = cfg.welcomeMessage.length > 150 ? `${cfg.welcomeMessage.slice(0, 150)}...` : cfg.welcomeMessage;
  const leaveMsgPreview = cfg.leaveMessage.length > 150 ? `${cfg.leaveMessage.slice(0, 150)}...` : cfg.leaveMessage;

  const embed = new EmbedBuilder()
    .setTitle(`👋 ระบบต้อนรับ/อำลาสมาชิก — ${guild ? guild.name : ''}`)
    .setColor(0x2ECA53)
    .setDescription(
      `**🎉 ข้อความต้อนรับ**: ${cfg.welcomeEnabled ? '🟢 เปิด' : '🔴 ปิด'}\n` +
      `📌 ห้อง: ${cfg.welcomeChannelId ? `<#${cfg.welcomeChannelId}>` : 'ยังไม่ได้ตั้ง'}\n` +
      `📝 ข้อความ: ${welcomeMsgPreview}\n\n` +
      `**🚪 ข้อความอำลา**: ${cfg.leaveEnabled ? '🟢 เปิด' : '🔴 ปิด'}\n` +
      `📌 ห้อง: ${cfg.leaveChannelId ? `<#${cfg.leaveChannelId}>` : 'ยังไม่ได้ตั้ง'}\n` +
      `📝 ข้อความ: ${leaveMsgPreview}\n\n` +
      `🎖️ ยศอัตโนมัติเมื่อเข้าเซิร์ฟเวอร์ใหม่: ${cfg.autoRoleId ? `<@&${cfg.autoRoleId}>` : 'ไม่มี'}`
    )
    .setFooter({ text: 'ใช้ {user} {username} {server} {membercount} ในข้อความได้ ระบบจะแทนที่ให้อัตโนมัติ' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle_welcome').setLabel(cfg.welcomeEnabled ? '🎉 ต้อนรับ: เปิด' : '🎉 ต้อนรับ: ปิด').setStyle(cfg.welcomeEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_welcome_message').setLabel('📝 ตั้งข้อความต้อนรับ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_leave').setLabel(cfg.leaveEnabled ? '🚪 อำลา: เปิด' : '🚪 อำลา: ปิด').setStyle(cfg.leaveEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_leave_message').setLabel('📝 ตั้งข้อความอำลา').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 หน้าหลัก').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_welcome_channel').setPlaceholder('📌 เลือกห้องประกาศต้อนรับ (ไม่เลือก = ปิดห้อง)')
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_leave_channel').setPlaceholder('📌 เลือกห้องประกาศอำลา (ไม่เลือก = ปิดห้อง)')
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('select_auto_role').setPlaceholder('🎖️ เลือกยศอัตโนมัติเมื่อเข้าเซิร์ฟเวอร์ (ไม่เลือก = ไม่มี)')
      .setMinValues(0).setMaxValues(1)
  );

  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_advanced').setLabel('⚙️ ขั้นสูง').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_access').setLabel('🚫 สิทธิ์การใช้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_stats').setLabel('📊 สถิติ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_leveling').setLabel('🏆 เลเวล').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_close_panel').setLabel('❌ ปิดแผง').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

function buildStatsPanel(stats, guild) {
  const uptime = formatUptime(Date.now() - stats.startTime);
  const providerLines = Object.entries(stats.providerUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `• ${name}: ${count} ครั้ง`)
    .join('\n') || 'ยังไม่มีข้อมูล';

  const topUsers = Object.entries(stats.userCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count], i) => `${i + 1}. <@${id}> — ${count} ข้อความ`)
    .join('\n') || 'ยังไม่มีข้อมูล';

  const embed = new EmbedBuilder()
    .setTitle(`📊 สถิติการใช้งานแบบเรียลไทม์ — ${guild ? guild.name : ''}`)
    .setColor(0x3498DB)
    .addFields(
      { name: '⏳ Uptime', value: uptime, inline: true },
      { name: '💬 ตอบไปทั้งหมด', value: `${stats.totalMessages} ข้อความ`, inline: true },
      { name: '📅 วันนี้', value: `${stats.dailyCount} ข้อความ`, inline: true },
      { name: '❌ ข้อผิดพลาด', value: `${stats.totalErrors} ครั้ง`, inline: true },
      { name: '🕐 ตอบล่าสุด', value: stats.lastLatencyMs !== null ? `${stats.lastLatencyMs} ms (${stats.lastProvider})` : 'ยังไม่มีข้อมูล', inline: true },
      { name: '🌐 การใช้งานแต่ละค่าย (Top 5)', value: providerLines },
      { name: '🏆 ผู้ใช้งานสูงสุด (Top 5)', value: topUsers }
    )
    .setFooter({ text: '🔄 อัปเดตอัตโนมัติทุก 5 วินาที (นาน 5 นาทีหลังเปิดหน้านี้)' })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_refresh_stats').setLabel('🔄 รีเฟรชตอนนี้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_reset_stats').setLabel('♻️ รีเซ็ตสถิติ').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ กลับหน้าหลัก').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_leveling').setLabel('🏆 หน้าเลเวล').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_close_panel').setLabel('❌ ปิดแผง').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1] };
}

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

function buildAiReplyPayload(cfg, authorId, text) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`del_${authorId}`).setLabel('🗑️ ลบข้อความนี้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`regen_${authorId}`).setLabel('🔄 ตอบใหม่').setStyle(ButtonStyle.Primary)
  );
  if (cfg.responseFormat === 'embed') {
    const embed = new EmbedBuilder().setDescription(text.slice(0, 4000)).setColor(parseColor(cfg.embedColor));
    return { embeds: [embed], components: [row] };
  }
  return { content: text, components: [row] };
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('📖 วิธีใช้งานบอท')
    .setColor(0x9B59B6)
    .setDescription(
      `**คำสั่งทั่วไป**\n` +
      `• พิมพ์คุยกับบอทได้เลยในห้องที่กำหนด (บอทจะจำบทสนทนาไว้คุยต่อเนื่อง)\n` +
      `• \`/ask\` — ถาม AI โดยตรง\n` +
      `• \`/reset-memory\` — ล้างความจำบทสนทนาของคุณ\n` +
      `• \`/rank\` หรือ \`!rank\` — ดูเลเวล/XP ของคุณ\n` +
      `• \`/leaderboard\` หรือ \`!leaderboard\` — ดูอันดับ XP สูงสุด\n` +
      `• \`/imagine\` หรือ \`!imagine <คำบรรยาย>\` — สร้างภาพด้วย AI (ฟรี)\n` +
      `• \`/giveaway start\` — เริ่มกิจกรรมแจกของรางวัล (แอดมิน)\n` +
      `• \`/council <หัวข้อ>\` — 🏛️ เปิดสภา AI ให้บุคลิกบอท 2 โหมดโต้วาทีกันสดๆ (ฟีเจอร์พิเศษ)\n` +
      `• \`/prophecy <ระยะเวลา>\` — 🔮 ให้บอททำนายอนาคตเซิร์ฟเวอร์แบบผนึกเวลา (ฟีเจอร์พิเศษ เพื่อความบันเทิง)\n` +
      `• \`/stats\` — ดูสถิติการใช้งานแบบเรียลไทม์\n` +
      `• \`/help\` — แสดงข้อความนี้\n\n` +
      `**คำสั่งสำหรับเจ้าของบอท/แอดมิน**\n` +
      `• \`${PANEL_COMMAND}\` หรือ \`/panel\` — เปิดแผงควบคุมบอท (มีหน้าตั้งค่าระบบเลเวลด้วย)\n` +
      `• \`!avatar\` หรือ \`/avatar\` — สุ่มเปลี่ยนรูปโปรไฟล์บอท\n\n` +
      `**ฟีเจอร์เด่น**\n` +
      `🧠 จำบทสนทนาต่อเนื่องแบบเรียลไทม์ • 🌐 รองรับหลายค่าย AI พร้อมสำรองอัตโนมัติ (แม้ Key หมดโควต้าก็สลับให้เอง) • ` +
      `📊 หน้าสถิติอัปเดตสด • 🏆 ระบบเลเวล/XP พร้อมยศรางวัลอัตโนมัติ • 🎨 สร้างภาพด้วย AI ฟรี • 👋 ต้อนรับ/อำลาสมาชิก + ยศอัตโนมัติ • 🎉 จัดกิจกรรมแจกของรางวัล • 🏛️ สภา AI โต้วาทีสด • 🔮 ผนึกคำทำนาย AI เปิดเผยเอง • 🚫 ระบบ Blacklist/Whitelist • ` +
      `🧾 ปรับรูปแบบคำตอบ (ข้อความ/Embed) • 🔄 ปุ่มตอบใหม่ (Regenerate)`
    );
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
function buildGiveawayEmbed(prize, winnerCount, endTime, ended, winners) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x95A5A6 : 0x9B59B6)
    .setTitle(ended ? '🎉 กิจกรรมสิ้นสุดแล้ว!' : '🎉 กิจกรรมแจกของรางวัล!')
    .setDescription(
      `🎁 รางวัล: **${prize}**\n` +
      `🏆 จำนวนผู้ชนะ: **${winnerCount}** คน\n` +
      (ended
        ? (winners && winners.length ? `👑 ผู้ชนะ: ${winners.map((id) => `<@${id}>`).join(', ')}` : '😢 ไม่มีผู้เข้าร่วมกิจกรรมนี้')
        : `⏰ สิ้นสุด: <t:${Math.floor(endTime / 1000)}:R>`)
    )
    .setFooter({ text: ended ? 'กิจกรรมนี้จบแล้ว' : 'กดปุ่มด้านล่างเพื่อเข้าร่วม! กดอีกครั้งเพื่อยกเลิกการเข้าร่วม' });
  return embed;
}

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

// เช็คทุก 20 วินาทีว่ามีกิจกรรมไหนครบเวลาแล้วบ้าง (ทนต่อการรีสตาร์ทบอท ดีกว่าใช้ setTimeout เดี่ยวๆ ที่จะหายไปเมื่อบอทรีสตาร์ท)
setInterval(() => {
  const now = Date.now();
  for (const [guildId, giveaways] of giveawayCache.entries()) {
    for (const [messageId, g] of Object.entries(giveaways)) {
      if (!g.ended && g.endTime <= now) {
        endGiveaway(guildId, messageId).catch(() => {});
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

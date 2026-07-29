// ==========================================
// 📦 lib/storage.js
// ชั้นข้อมูล (Data Layer) ของบอททั้งหมด: อ่าน/เขียนไฟล์ Config, ข้อมูลเลเวล, Giveaway, คำทำนาย
// ไม่พึ่งพา discord.js เลย เป็น Node.js/fs ล้วนๆ เพื่อให้ทดสอบและนำไปใช้ซ้ำได้ง่าย
// ==========================================
const fs = require('fs');
const path = require('path');

// __dirname ที่นี่คือ lib/ ดังนั้นต้องขึ้นไปอีก 1 ระดับเพื่อให้ data/ อยู่ที่รากโปรเจกต์ (เหมือนก่อน Refactor)
const DATA_DIR = path.join(__dirname, '..', 'data');
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

module.exports = {
  DATA_DIR,
  DEFAULT_GLOBAL_CONFIG,
  globalConfig,
  saveGlobalConfig,
  DEFAULT_GUILD_CONFIG,
  getGuildConfig,
  saveGuildConfig,
  resetGuildConfig,
  safeMergeGuildConfig,
  getLevelData,
  saveLevelData,
  resetLevelData,
  xpForLevel,
  calculateLevel,
  makeProgressBar,
  parseRoleRewards,
  getGiveaways,
  saveGiveaways,
  parseDuration,
  getProphecies,
  saveProphecies,
  MODE_LABELS,
  MODE_PROMPTS,
  getSystemPrompt,
};

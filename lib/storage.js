// ==========================================
// 📦 lib/storage.js (MongoDB Version)
// ชั้นข้อมูล (Data Layer) ของบอททั้งหมด: เชื่อมต่อ MongoDB ผ่าน Mongoose
// ==========================================
const mongoose = require('mongoose');

// 1. เชื่อมต่อ MongoDB (ดึง URI จาก Environment Variable MONGODB_URI)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/discord-bot';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('📦 เชื่อมต่อ MongoDB สำเร็จ');
}).catch(err => {
  console.error('❌ เชื่อมต่อ MongoDBไม่สำเร็จ:', err);
});

// ==========================================
// Mongoose Schemas & Models
// ==========================================

// Global Config Schema
const globalConfigSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  statusText: { type: String, default: 'รอรับคำสั่งเจ้านาย 💬' },
  avatarAutoRotate: { type: Boolean, default: false },
  avatarRotateMinutes: { type: Number, default: 60 },
});
const GlobalConfigModel = mongoose.model('GlobalConfig', globalConfigSchema);

// Guild Config Schema
const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  mode: { type: String, default: 'normal' },
  customPrompt: { type: String, default: '' },
  customApiKey: { type: String, default: '' },
  customApiUrl: { type: String, default: '' },
  customApiModel: { type: String, default: '' },
  targetChannelIds: { type: [String], default: [] },
  targetRoleIds: { type: [String], default: [] },
  filterMode: { type: String, default: 'blacklist' },
  blacklistUserIds: { type: [String], default: [] },
  whitelistUserIds: { type: [String], default: [] },
  cooldownSeconds: { type: Number, default: 3 },
  responseFormat: { type: String, default: 'text' },
  embedColor: { type: String, default: '#2ECA53' },
  replyLanguage: { type: String, default: 'th' },
  maxTokens: { type: Number, default: 1000 },
  temperature: { type: Number, default: 0.8 },
  memoryEnabled: { type: Boolean, default: true },
  memoryTurns: { type: Number, default: 6 },
  allowAdminAccess: { type: Boolean, default: true },
  logChannelId: { type: String, default: '' },

  // ระบบเลเวล/XP
  levelingEnabled: { type: Boolean, default: false },
  levelingXpMin: { type: Number, default: 15 },
  levelingXpMax: { type: Number, default: 25 },
  levelingCooldownSeconds: { type: Number, default: 60 },
  levelingIgnoredChannelIds: { type: [String], default: [] },
  levelingAnnounceChannelId: { type: String, default: '' },
  levelingRoleRewards: { type: String, default: '' },

  // ระบบสร้างภาพด้วย AI
  imageGenEnabled: { type: Boolean, default: true },

  // ระบบต้อนรับ/อำลาสมาชิก
  welcomeEnabled: { type: Boolean, default: false },
  welcomeChannelId: { type: String, default: '' },
  welcomeMessage: { type: String, default: 'ยินดีต้อนรับ {user} เข้าสู่ {server}! ตอนนี้เรามีสมาชิกทั้งหมด {membercount} คนแล้ว 🎉' },
  leaveEnabled: { type: Boolean, default: false },
  leaveChannelId: { type: String, default: '' },
  leaveMessage: '{user} ออกจากเซิร์ฟเวอร์ไปแล้ว 👋',
  autoRoleId: { type: String, default: '' },
});
const GuildConfigModel = mongoose.model('GuildConfig', guildConfigSchema);

// Level Data Schema (เก็บ XP แยกตาม Guild และ User)
const levelDataSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  xp: { type: Number, default: 0 },
  lastMessageAt: { type: Number, default: 0 },
});
levelDataSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const LevelDataModel = mongoose.model('LevelData', levelDataSchema);

// Giveaway Schema
const giveawaySchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  messageId: { type: String, required: true, unique: true },
  prize: String,
  winnerCount: Number,
  entries: [String],
  endTime: Number,
  channelId: String,
  ended: { type: Boolean, default: false },
  winners: [String],
});
const GiveawayModel = mongoose.model('Giveaway', giveawaySchema);

// Prophecy Schema
const prophecySchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  messageId: { type: String, required: true, unique: true },
  topic: String,
  prediction: String,
  mode: String,
  revealTime: Number,
  channelId: String,
  authorId: String,
  revealed: { type: Boolean, default: false },
  epilogue: String,
});
const ProphecyModel = mongoose.model('Prophecy', prophecySchema);


// ==========================================
// Global Config Management (Async/Sync Cache Wrapper)
// ==========================================
const DEFAULT_GLOBAL_CONFIG = {
  statusText: 'รอรับคำสั่งเจ้านาย 💬',
  avatarAutoRotate: false,
  avatarRotateMinutes: 60,
};

let globalConfig = { ...DEFAULT_GLOBAL_CONFIG };

// โหลดค่าเริ่มต้นเข้าตัวแปร globalConfig ทันทีที่รัน
(async () => {
  try {
    let doc = await GlobalConfigModel.findById('global');
    if (!doc) {
      doc = await GlobalConfigModel.create({ _id: 'global', ...DEFAULT_GLOBAL_CONFIG });
    }
    globalConfig = {
      statusText: doc.statusText,
      avatarAutoRotate: doc.avatarAutoRotate,
      avatarRotateMinutes: doc.avatarRotateMinutes,
    };
  } catch (e) {
    console.error('⚠️ โหลด globalConfig ไม่สำเร็จ:', e.message);
  }
})();

async function saveGlobalConfig() {
  try {
    await GlobalConfigModel.findByIdAndUpdate(
      'global',
      { ...globalConfig },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error('⚠️ ไม่สามารถบันทึก global-config ได้:', e.message);
  }
}


// ==========================================
// Guild Config Management (Memory Cache + MongoDB)
// ==========================================
const DEFAULT_GUILD_CONFIG = {
  isActive: true,
  mode: 'normal',
  customPrompt: '',
  customApiKey: '',
  customApiUrl: '',
  customApiModel: '',
  targetChannelIds: [],
  targetRoleIds: [],
  filterMode: 'blacklist',
  blacklistUserIds: [],
  whitelistUserIds: [],
  cooldownSeconds: 3,
  responseFormat: 'text',
  embedColor: '#2ECA53',
  replyLanguage: 'th',
  maxTokens: 1000,
  temperature: 0.8,
  memoryEnabled: true,
  memoryTurns: 6,
  allowAdminAccess: true,
  logChannelId: '',
  levelingEnabled: false,
  levelingXpMin: 15,
  levelingXpMax: 25,
  levelingCooldownSeconds: 60,
  levelingIgnoredChannelIds: [],
  levelingAnnounceChannelId: '',
  levelingRoleRewards: '',
  imageGenEnabled: true,
  welcomeEnabled: false,
  welcomeChannelId: '',
  welcomeMessage: 'ยินดีต้อนรับ {user} เข้าสู่ {server}! ตอนนี้เรามีสมาชิกทั้งหมด {membercount} คนแล้ว 🎉',
  leaveEnabled: false,
  leaveChannelId: '',
  leaveMessage: '{user} ออกจากเซิร์ฟเวอร์ไปแล้ว 👋',
  autoRoleId: '',
};

const guildConfigCache = new Map();

function getGuildConfig(guildId) {
  if (guildConfigCache.has(guildId)) return guildConfigCache.get(guildId);

  // สร้างค่าเริ่มต้นใน Cache ไปก่อนเพื่อไม่ให้ติด Async ขัดจังหวะการทำงานของ Discord Bot
  const cfg = { ...DEFAULT_GUILD_CONFIG };
  guildConfigCache.set(guildId, cfg);

  // ดึงข้อมูลจริงจาก MongoDB มาทับเบื้องหลัง
  GuildConfigModel.findOne({ guildId }).then(doc => {
    if (doc) {
      const merged = { ...DEFAULT_GUILD_CONFIG, ...doc.toObject() };
      guildConfigCache.set(guildId, merged);
    } else {
      GuildConfigModel.create({ guildId, ...DEFAULT_GUILD_CONFIG }).catch(() => {});
    }
  }).catch(e => {
    console.error(`⚠️ อ่าน config ของกิลด์ ${guildId} จาก DB ไม่สำเร็จ:`, e.message);
  });

  return cfg;
}

function saveGuildConfig(guildId) {
  const cfg = guildConfigCache.get(guildId);
  if (!cfg) return;
  GuildConfigModel.findOneAndUpdate(
    { guildId },
    { ...cfg },
    { upsert: true, new: true }
  ).catch(e => {
    console.error(`⚠️ ไม่สามารถบันทึก config ของกิลด์ ${guildId} ลง DB ได้:`, e.message);
  });
}

function resetGuildConfig(guildId) {
  const fresh = { ...DEFAULT_GUILD_CONFIG };
  guildConfigCache.set(guildId, fresh);
  saveGuildConfig(guildId);
  return fresh;
}

function safeMergeGuildConfig(guildId, incomingObj) {
  const cfg = getGuildConfig(guildId);
  const allowedKeys = Object.keys(DEFAULT_GUILD_CONFIG);
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(incomingObj, key)) {
      const defaultVal = DEFAULT_GUILD_CONFIG[key];
      const incomingVal = incomingObj[key];
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
// 🏆 ระบบเลเวล/XP (MongoDB)
// ==========================================
const levelDataCache = new Map(); // guildId -> { [userId]: { xp, lastMessageAt } }

function getLevelData(guildId) {
  if (levelDataCache.has(guildId)) return levelDataCache.get(guildId);

  const data = {};
  levelDataCache.set(guildId, data);

  LevelDataModel.find({ guildId }).then(docs => {
    docs.forEach(doc => {
      data[doc.userId] = { xp: doc.xp, lastMessageAt: doc.lastMessageAt };
    });
  }).catch(e => {
    console.error(`⚠️ อ่านข้อมูลเลเวลของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
  });

  return data;
}

function saveLevelData(guildId) {
  const data = levelDataCache.get(guildId);
  if (!data) return;

  // ทำการ Bulk Write หรืออัปเดตลง MongoDB
  for (const [userId, info] of Object.entries(data)) {
    LevelDataModel.findOneAndUpdate(
      { guildId, userId },
      { xp: info.xp, lastMessageAt: info.lastMessageAt },
      { upsert: true }
    ).catch(e => {
      console.error(`⚠️ ไม่สามารถบันทึก XP ของผู้ใช้ ${userId} ในกิลด์ ${guildId} ได้:`, e.message);
    });
  }
}

function resetLevelData(guildId) {
  levelDataCache.set(guildId, {});
  LevelDataModel.deleteMany({ guildId }).catch(e => {
    console.error(`⚠️ ลบข้อมูลเลเวลของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
  });
}

function xpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function calculateLevel(totalXp) {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: xpForLevel(level) };
}

function makeProgressBar(current, max, size = 12) {
  const ratio = max > 0 ? Math.min(1, current / max) : 0;
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  return '🟩'.repeat(filled) + '⬜'.repeat(Math.max(0, size - filled));
}

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
// 🎉 ระบบ Giveaway (MongoDB)
// ==========================================
const giveawayCache = new Map(); // guildId -> { [messageId]: giveawayObj }

function getGiveaways(guildId) {
  if (giveawayCache.has(guildId)) return giveawayCache.get(guildId);

  const data = {};
  giveawayCache.set(guildId, data);

  GiveawayModel.find({ guildId }).then(docs => {
    docs.forEach(doc => {
      data[doc.messageId] = {
        prize: doc.prize,
        winnerCount: doc.winnerCount,
        entries: doc.entries,
        endTime: doc.endTime,
        channelId: doc.channelId,
        ended: doc.ended,
        winners: doc.winners,
      };
    });
  }).catch(e => {
    console.error(`⚠️ อ่านข้อมูล Giveaway ของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
  });

  return data;
}

function saveGiveaways(guildId) {
  const data = giveawayCache.get(guildId);
  if (!data) return;

  for (const [messageId, g] of Object.entries(data)) {
    GiveawayModel.findOneAndUpdate(
      { messageId },
      { guildId, ...g },
      { upsert: true }
    ).catch(e => {
      console.error(`⚠️ ไม่สามารถบันทึก Giveaway ${messageId} ได้:`, e.message);
    });
  }
}

// โหลด Giveaway ทั้งหมดเข้ามาใน Cache ตอนเริ่มบอท
(async () => {
  try {
    const docs = await GiveawayModel.find({});
    docs.forEach(doc => {
      if (!giveawayCache.has(doc.guildId)) giveawayCache.set(doc.guildId, {});
      giveawayCache.get(doc.guildId)[doc.messageId] = {
        prize: doc.prize,
        winnerCount: doc.winnerCount,
        entries: doc.entries,
        endTime: doc.endTime,
        channelId: doc.channelId,
        ended: doc.ended,
        winners: doc.winners,
      };
    });
  } catch (e) {
    console.error('⚠️ โหลด Giveaway จาก DB ไม่สำเร็จ:', e.message);
  }
})();

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
// 🔮 ระบบคำทำนาย AI (MongoDB)
// ==========================================
const propheciesCache = new Map(); // guildId -> { [messageId]: prophecyObj }

function getProphecies(guildId) {
  if (propheciesCache.has(guildId)) return propheciesCache.get(guildId);

  const data = {};
  propheciesCache.set(guildId, data);

  ProphecyModel.find({ guildId }).then(docs => {
    docs.forEach(doc => {
      data[doc.messageId] = {
        topic: doc.topic,
        prediction: doc.prediction,
        mode: doc.mode,
        revealTime: doc.revealTime,
        channelId: doc.channelId,
        authorId: doc.authorId,
        revealed: doc.revealed,
,        epilogue: doc.epilogue,
      };
    });
  }).catch(e => {
    console.error(`⚠️ อ่านข้อมูลคำทำนายของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
  });

  return data;
}

function saveProphecies(guildId) {
  const data = propheciesCache.get(guildId);
  if (!data) return;

  for (const [messageId, p] of Object.entries(data)) {
    ProphecyModel.findOneAndUpdate(
      { messageId },
      { guildId, ...p },
      { upsert: true }
    ).catch(e => {
      console.error(`⚠️ ไม่สามารถบันทึกคำทำนาย ${messageId} ได้:`, e.message);
    });
  }
}

(async () => {
  try {
    const docs = await ProphecyModel.find({});
    docs.forEach(doc => {
      if (!propheciesCache.has(doc.guildId)) propheciesCache.set(doc.guildId, {});
      propheciesCache.get(doc.guildId)[doc.messageId] = {
        topic: doc.topic,
        prediction: doc.prediction,
        mode: doc.mode,
        revealTime: doc.revealTime,
        channelId: doc.channelId,
        authorId: doc.authorId,
        revealed: doc.revealed,
        epilogue: doc.epilogue,
      };
    });
  } catch (e) {
    console.error('⚠️ โหลดคำทำนายจาก DB ไม่สำเร็จ:', e.message);
  }
})();


// ==========================================
// 🎭 โหมดบอท
// ==========================================
const MODE_LABELS = {
  normal: '😊 ปกติ (น่ารัก)',
  troll: '😜 กวนโอ๊ย',
  serious: '🧐 จริงจัง',
  polite: '🙏 สุภาพ',
  teacher: '📚 ครูใจดี',
  friend: '🧑‍🤝‍🧑 เพื่อนสนิท',
  hacker: '💻 นักพัฒนา/สายเทค',
  pundits: '💅 ปันคนสวยขา (ปากแซ่บ)',
  flirt: 'คุณคือคนคลั่งรักสายอ้อน ขี้ง้อ ขี้อ้อนสุดๆ ใช้คำพูดน่ารักน่าเอ็นดู ออดอ้อนเก่ง ใช้อิโมจิวิบวับเยอะๆ ห้ามด่าเด็ดขาด ตอบสั้น 1-2 ประโยค ฟีลใจบางเวอร์',
  dramatic: 'คุณคือตัวแม่สายดราม่า อินใหญ่กว่าเรื่องจริงตลอดเวลา ชอบทำเรื่องเล็กให้เป็นเรื่องใหญ่ ฟีลนางเอกละครหลังข่าวใส่อารมณ์ฉ่ำๆ ตอบสั้น 1-2 ประโยค',
  delulu: '💫 สายมโน/มั่นหน้า (ตัวแม่มาละ)',
};

const MODE_PROMPTS = {
  normal: 'คุณคือผู้ช่วยสุดน่ารัก ตอบเป็นภาษาไทย สั้นๆ กระชับ เป็นมิตร',
  troll: 'คุณคือเพื่อนซี้ปากแจ๋ว ตอบเป็นภาษาไทยแบบกวนโอ๊ยขำๆแต่ไม่หยาบคาย สั้นๆ',
  serious: 'คุณคือผู้เชี่ยวชาญ ตอบเป็นภาษาไทย มีสาระ ตรงไปตรงมา กระชับ',
  polite: 'คุณคือผู้ช่วยสุภาพเรียบร้อย ตอบเป็นภาษาไทย ใช้คำสุภาพลงท้ายด้วยครับ/ค่ะเสมอ',
  teacher: 'คุณคือครูใจดีที่อธิบายเรื่องยากๆให้เข้าใจง่ายด้วยตัวอย่างสั้นๆ ตอบเป็นภาษาไทย',
  friend: 'คุณคือเพื่อนสนิทที่คุยเป็นกันเอง ใช้ภาษาพูดปกติแบบเพื่อนแชทกัน ตอบเป็นภาษาไทย สั้นกระชับ',
  hacker: 'คุณคือผู้เชี่ยวชาญด้านโปรแกรมมิ่งและเทคโนโลยี ตอบเป็นภาษาไทยแบบกระชับตรงประเด็น ใส่โค้ดตัวอย่างเมื่อจำเป็น',
  pundits: 'คุณคือปัน สาววัยรุ่นหน้านิ่งลุคคูล พิมพ์แชทกวนตีน ปากแซ่บ ใช้ศัพท์ Gen Z ห้ามใช้คำสุภาพเด็ดขาด ตอบสั้น 1-2 ประโยค ฟีลเพื่อนกวนๆ พิมพ์ผิดบ้างย่อคำบ้าง',
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
                    

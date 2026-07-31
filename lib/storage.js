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
  leaveMessage: { type: String, default: '{user} ออกจากเซิร์ฟเวอร์ไปแล้ว 👋' },
  autoRoleId: { type: String, default: '' },

  // ระบบ Auto-Moderation (กรองคำต้องห้าม/ลิงก์/สแปมเมนชันอัตโนมัติ)
  automodEnabled: { type: Boolean, default: false },
  automodBadWords: { type: String, default: '' }, // คั่นด้วยคอมมา เช่น "คำหยาบ1,คำหยาบ2"
  automodBlockInvites: { type: Boolean, default: false },
  automodBlockLinks: { type: Boolean, default: false },
  automodMaxMentions: { type: Number, default: 5 }, // 0 = ปิดการตรวจสอบ
  automodAction: { type: String, default: 'delete' }, // delete | warn | timeout
  automodTimeoutSeconds: { type: Number, default: 60 },
  automodIgnoredChannelIds: { type: [String], default: [] },

  // ระบบ Ticket (ช่องติดต่อแอดมินส่วนตัว เปิดผ่านปุ่ม ไม่ต้องพิมพ์คำสั่ง)
  ticketCategoryId: { type: String, default: '' },
  ticketStaffRoleId: { type: String, default: '' },
  ticketCounter: { type: Number, default: 0 },

  // ระบบ Anti-Raid (ตรวจจับคนเข้าร่วมเซิร์ฟเวอร์ผิดปกติ กันบอทสแปม/การโจมตี Raid)
  antiRaidEnabled: { type: Boolean, default: false },
  antiRaidJoinThreshold: { type: Number, default: 10 }, // จำนวนคนเข้าร่วมที่ถือว่าผิดปกติ
  antiRaidWindowSeconds: { type: Number, default: 30 }, // ภายในกี่วินาที
  antiRaidAction: { type: String, default: 'alert' }, // alert | kick_new_accounts | raise_verification
  antiRaidMinAccountAgeDays: { type: Number, default: 7 }, // อายุบัญชีขั้นต่ำ (วัน) ใช้กับโหมด kick_new_accounts

  // ระบบ "ความฝันของบอท" (Dream Journal) — ทุกวันบอทจะแปลงเหตุการณ์ในเซิร์ฟเวอร์เป็นความฝันเชิงสัญลักษณ์
  dreamEnabled: { type: Boolean, default: false },
  dreamChannelId: { type: String, default: '' },
  lastDreamAt: { type: Number, default: 0 },

  // ระบบ "ธรรมนูญเซิร์ฟเวอร์" (Living Law Book) — ทุกเหตุการณ์ mod จุดประกาย AI ร่างกฎหมายสมมติขำๆ ใหม่ 1 มาตรา
  lawsEnabled: { type: Boolean, default: false },
  lawsChannelId: { type: String, default: '' },
  lawCounter: { type: Number, default: 0 },
  lastLawAt: { type: Number, default: 0 },

  // ระบบเกม "ล่าของวิเศษจากฝัน" (Dream Relic Hunt) — ต่อยอดจากระบบความฝัน ทุกวันจะมีของวิเศษหลุดจากฝันให้แย่งคว้า
  relicsEnabled: { type: Boolean, default: false },
  relicCounter: { type: Number, default: 0 },
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
giveawaySchema.index({ guildId: 1 });
prophecySchema.index({ guildId: 1 });

// Warning Schema (ระบบเตือนสมาชิก สำหรับคำสั่ง /warn /warnings /clearwarnings)
const warningSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  moderatorId: { type: String, required: true },
  reason: { type: String, default: 'ไม่ระบุเหตุผล' },
  createdAt: { type: Number, default: () => Date.now() },
});
warningSchema.index({ guildId: 1, userId: 1 });
const WarningModel = mongoose.model('Warning', warningSchema);

// Ticket Schema (ระบบเปิด/ปิด Ticket ติดต่อแอดมิน ผ่านปุ่ม ไม่ต้องพิมพ์คำสั่ง)
const ticketSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  userId: { type: String, required: true },
  createdAt: { type: Number, default: () => Date.now() },
  closed: { type: Boolean, default: false },
});
ticketSchema.index({ guildId: 1, userId: 1, closed: 1 });
const TicketModel = mongoose.model('Ticket', ticketSchema);

// Dream Schema (ระบบ "ความฝันของบอท" — บันทึกความฝันเชิงสัญลักษณ์ที่ AI แต่งขึ้นจากเหตุการณ์ในเซิร์ฟเวอร์แต่ละวัน)
const dreamSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  content: { type: String, required: true },
  createdAt: { type: Number, default: () => Date.now() },
});
dreamSchema.index({ guildId: 1, createdAt: -1 });
const DreamModel = mongoose.model('Dream', dreamSchema);

// ServerLaw Schema (ระบบ "ธรรมนูญเซิร์ฟเวอร์" — ทุกเหตุการณ์ mod จุดประกาย AI ร่างกฎหมายสมมติขำๆ ใหม่ 1 มาตรา สะสมเป็นธรรมนูญประจำเซิร์ฟเวอร์)
const serverLawSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  article: { type: Number, required: true }, // เลข "มาตราที่ N"
  content: { type: String, required: true },
  category: { type: String, default: '' }, // หมวดหมู่เหตุการณ์ที่จุดประกาย (ใช้อ้างอิงภายในเท่านั้น ไม่โชว์ผู้ใช้)
  createdAt: { type: Number, default: () => Date.now() },
});
serverLawSchema.index({ guildId: 1, article: 1 });
const ServerLawModel = mongoose.model('ServerLaw', serverLawSchema);

// RelicDrop Schema (ระบบเกม "ล่าของวิเศษจากฝัน" — ทุกครั้งที่บอทฝัน จะมีของวิเศษหลุดออกมาให้แย่งคว้า)
const relicDropSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  article: { type: Number, required: true }, // เลขไอเทมประจำกิลด์ (ใช้อ้างอิงตอนโอนของ/ดูรายละเอียด)
  name: { type: String, required: true },
  description: { type: String, default: '' },
  rarity: { type: String, default: 'common' }, // common | rare | epic | legendary
  claimedBy: { type: String, default: null },
  claimedAt: { type: Number, default: null },
  createdAt: { type: Number, default: () => Date.now() },
});
relicDropSchema.index({ guildId: 1, article: 1 });
relicDropSchema.index({ guildId: 1, claimedBy: 1 });
const RelicDropModel = mongoose.model('RelicDrop', relicDropSchema);


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
  automodEnabled: false,
  automodBadWords: '',
  automodBlockInvites: false,
  automodBlockLinks: false,
  automodMaxMentions: 5,
  automodAction: 'delete',
  automodTimeoutSeconds: 60,
  automodIgnoredChannelIds: [],
  ticketCategoryId: '',
  ticketStaffRoleId: '',
  ticketCounter: 0,
  antiRaidEnabled: false,
  antiRaidJoinThreshold: 10,
  antiRaidWindowSeconds: 30,
  antiRaidAction: 'alert',
  antiRaidMinAccountAgeDays: 7,
  dreamEnabled: false,
  dreamChannelId: '',
  lastDreamAt: 0,
  lawsEnabled: false,
  lawsChannelId: '',
  lawCounter: 0,
  lastLawAt: 0,
  relicsEnabled: false,
  relicCounter: 0,
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

// แปลงรายการคำต้องห้าม (คั่นด้วยคอมมา) ให้เป็น array ตัวพิมพ์เล็กสำหรับเทียบกับข้อความ (ใช้ในระบบ Automod)
function parseWordList(raw) {
  if (!raw) return [];
  return raw.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
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
        epilogue: doc.epilogue,
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
// ⚠️ ระบบเตือนสมาชิก (Warnings) — เก็บลง MongoDB โดยตรง ไม่ใช้ Cache เพราะเรียกใช้ไม่บ่อยเท่าระบบอื่น
// ==========================================
async function addWarning(guildId, userId, moderatorId, reason) {
  try {
    const doc = await WarningModel.create({ guildId, userId, moderatorId, reason: reason || 'ไม่ระบุเหตุผล', createdAt: Date.now() });
    return doc.toObject();
  } catch (e) {
    console.error(`⚠️ บันทึกคำเตือนของ ${userId} ในกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    return null;
  }
}

async function getWarnings(guildId, userId) {
  try {
    return await WarningModel.find({ guildId, userId }).sort({ createdAt: 1 }).lean();
  } catch (e) {
    console.error(`⚠️ อ่านคำเตือนของ ${userId} ในกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    return [];
  }
}

async function countWarnings(guildId, userId) {
  try {
    return await WarningModel.countDocuments({ guildId, userId });
  } catch (e) {
    return 0;
  }
}

async function clearWarnings(guildId, userId) {
  try {
    await WarningModel.deleteMany({ guildId, userId });
    return true;
  } catch (e) {
    console.error(`⚠️ ล้างคำเตือนของ ${userId} ในกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    return false;
  }
}

// ==========================================
// 🎫 ระบบ Ticket
// ==========================================
async function createTicketRecord(guildId, channelId, userId) {
  try {
    const doc = await TicketModel.create({ guildId, channelId, userId, createdAt: Date.now(), closed: false });
    return doc.toObject();
  } catch (e) {
    console.error(`⚠️ สร้างข้อมูล Ticket ไม่สำเร็จ:`, e.message);
    return null;
  }
}

// หา Ticket ที่ยังเปิดอยู่ของผู้ใช้คนนี้ในกิลด์นี้ (กันเปิดซ้ำหลายอัน)
async function getOpenTicketForUser(guildId, userId) {
  try {
    return await TicketModel.findOne({ guildId, userId, closed: false }).lean();
  } catch (e) {
    return null;
  }
}

async function getTicketByChannel(guildId, channelId) {
  try {
    return await TicketModel.findOne({ guildId, channelId }).lean();
  } catch (e) {
    return null;
  }
}

async function closeTicketRecord(guildId, channelId) {
  try {
    await TicketModel.updateOne({ guildId, channelId }, { $set: { closed: true } });
    return true;
  } catch (e) {
    console.error(`⚠️ ปิดข้อมูล Ticket ไม่สำเร็จ:`, e.message);
    return false;
  }
}

// ==========================================
// 🌙 ระบบ "ความฝันของบอท" (Dream Journal)
// ==========================================
async function saveDream(guildId, content) {
  try {
    const doc = await DreamModel.create({ guildId, content, createdAt: Date.now() });
    return doc.toObject();
  } catch (e) {
    console.error(`⚠️ บันทึกความฝันของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    return null;
  }
}

async function getLatestDream(guildId) {
  try {
    return await DreamModel.findOne({ guildId }).sort({ createdAt: -1 }).lean();
  } catch (e) {
    return null;
  }
}

async function getDreamArchive(guildId, limit = 10) {
  try {
    return await DreamModel.find({ guildId }).sort({ createdAt: -1 }).limit(limit).lean();
  } catch (e) {
    return [];
  }
}

// ==========================================
// 📜 ระบบ "ธรรมนูญเซิร์ฟเวอร์" (Living Law Book)
// ==========================================
async function saveLaw(guildId, article, content, category) {
  try {
    const doc = await ServerLawModel.create({ guildId, article, content, category: category || '', createdAt: Date.now() });
    return doc.toObject();
  } catch (e) {
    console.error(`⚠️ บันทึกมาตรากฎหมายของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    return null;
  }
}

async function getLawByArticle(guildId, article) {
  try {
    return await ServerLawModel.findOne({ guildId, article }).lean();
  } catch (e) {
    return null;
  }
}

async function getLawArchive(guildId, limit = 15) {
  try {
    return await ServerLawModel.find({ guildId }).sort({ article: -1 }).limit(limit).lean();
  } catch (e) {
    return [];
  }
}

// ==========================================
// 🏺 ระบบเกม "ล่าของวิเศษจากฝัน" (Dream Relic Hunt)
// ==========================================
async function createRelicDrop(guildId, article, name, description, rarity) {
  try {
    const doc = await RelicDropModel.create({ guildId, article, name, description, rarity, claimedBy: null, claimedAt: null, createdAt: Date.now() });
    return doc.toObject();
  } catch (e) {
    console.error(`⚠️ สร้างของวิเศษของกิลด์ ${guildId} ไม่สำเร็จ:`, e.message);
    return null;
  }
}

// อ้างสิทธิ์แบบอะตอมมิก — สำเร็จก็ต่อเมื่อยังไม่มีใครคว้าไปก่อน กันปัญหาหลายคนกดพร้อมกัน (race condition)
async function claimRelicDrop(relicId, userId) {
  try {
    return await RelicDropModel.findOneAndUpdate(
      { _id: relicId, claimedBy: null },
      { $set: { claimedBy: userId, claimedAt: Date.now() } },
      { new: true },
    ).lean();
  } catch (e) {
    return null;
  }
}

async function getRelicById(relicId) {
  try {
    return await RelicDropModel.findById(relicId).lean();
  } catch (e) {
    return null;
  }
}

async function getRelicByArticle(guildId, article) {
  try {
    return await RelicDropModel.findOne({ guildId, article }).lean();
  } catch (e) {
    return null;
  }
}

async function getUserRelics(guildId, userId) {
  try {
    return await RelicDropModel.find({ guildId, claimedBy: userId }).sort({ claimedAt: -1 }).lean();
  } catch (e) {
    return [];
  }
}

async function getRelicLeaderboard(guildId, limit = 10) {
  try {
    return await RelicDropModel.aggregate([
      { $match: { guildId, claimedBy: { $ne: null } } },
      { $group: {
        _id: '$claimedBy',
        count: { $sum: 1 },
        legendaryCount: { $sum: { $cond: [{ $eq: ['$rarity', 'legendary'] }, 1, 0] } },
        epicCount: { $sum: { $cond: [{ $eq: ['$rarity', 'epic'] }, 1, 0] } },
      } },
      { $sort: { legendaryCount: -1, epicCount: -1, count: -1 } },
      { $limit: limit },
    ]);
  } catch (e) {
    return [];
  }
}

// โอนความเป็นเจ้าของของวิเศษ (ใช้กับคำสั่งมอบของขวัญ) — ต้องเป็นเจ้าของเดิมจริงเท่านั้นถึงจะโอนสำเร็จ
async function transferRelic(guildId, article, fromUserId, toUserId) {
  try {
    return await RelicDropModel.findOneAndUpdate(
      { guildId, article, claimedBy: fromUserId },
      { $set: { claimedBy: toUserId, claimedAt: Date.now() } },
      { new: true },
    ).lean();
  } catch (e) {
    return null;
  }
}

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
  flirt: '🥺 สายอ้อน/สายง้อ (ละลายใจ)',
  dramatic: '👑 ตัวแม่สายดราม่า (อินเนอร์ละครไทย)',
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
  flirt: 'คุณคือคนคลั่งรักสายอ้อน ขี้ง้อ ขี้อ้อนสุดๆ ใช้คำพูดน่ารักน่าเอ็นดู ออดอ้อนเก่ง ใช้อิโมจิวิบวับเยอะๆ ห้ามด่าเด็ดขาด ตอบสั้น 1-2 ประโยค ฟีลใจบางเวอร์',
  dramatic: 'คุณคือตัวแม่สายดราม่า อินใหญ่กว่าเรื่องจริงตลอดเวลา ชอบทำเรื่องเล็กให้เป็นเรื่องใหญ่ ฟีลนางเอกละครหลังข่าวใส่อารมณ์ฉ่ำๆ ตอบสั้น 1-2 ประโยค',
  delulu: 'คุณคือคนมั่นหน้า มโนเก่ง คิดว่าตัวเองสวยและป๊อปที่สุดในจักรวาล ตอบด้วยความมั่นใจเกินร้อย ฟีลตัวแม่ สั้นๆ 1-2 ประโยค',
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
  parseWordList,
  getGiveaways,
  saveGiveaways,
  parseDuration,
  getProphecies,
  saveProphecies,
  addWarning,
  getWarnings,
  countWarnings,
  clearWarnings,
  createTicketRecord,
  getOpenTicketForUser,
  getTicketByChannel,
  closeTicketRecord,
  saveDream,
  getLatestDream,
  getDreamArchive,
  saveLaw,
  getLawByArticle,
  getLawArchive,
  createRelicDrop,
  claimRelicDrop,
  getRelicById,
  getRelicByArticle,
  getUserRelics,
  getRelicLeaderboard,
  transferRelic,
  MODE_LABELS,
  MODE_PROMPTS,
  getSystemPrompt,
};
      

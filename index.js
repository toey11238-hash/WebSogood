const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActivityType, EmbedBuilder, ChannelType } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express'); 
require('dotenv').config();

// ==========================================
// 🌐 0. Web Server สำหรับ Render (กันบอทหลับ)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Discord AI Bot is running and awake! 🤖');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🌐 Web server is running on port ${port}`);
});

// ==========================================
// ⚙️ 1. อ่านค่า Environment Variables
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID_RAW = process.env.OWNER_ID ? process.env.OWNER_ID.trim() : 'ALL';
const OWNER_IDS = OWNER_ID_RAW.split(',').map(id => id.trim()).filter(Boolean);
const PANEL_COMMAND = process.env.PANEL_CMD ? process.env.PANEL_CMD.trim() : '!panel';

if (!TOKEN) {
  console.error('❌ ไม่พบ DISCORD_TOKEN ใน Environment Variables ของ Render!');
  process.exit(1);
}

function checkHasPermission(userId) {
  if (OWNER_IDS.includes('ALL') || OWNER_IDS.length === 0) return true;
  return OWNER_IDS.includes(userId);
}

// ==========================================
// 📁 2. ระบบ Config (อัปเกรดระบบฟีเจอร์เสริม & Auto-Repair)
// ==========================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  isActive: true,
  featureImage: true,  // เปิดปิดระบบวาดรูป
  featureHoro: true,   // เปิดปิดระบบดูดวง
  featureRPG: true,    // เปิดปิดระบบเกมตีมอน/กาชา
  mode: 'normal',
  customPrompt: '',
  customApiKey: '',
  targetChannelIds: [],
  targetRoleIds: [],
  blacklistUserIds: [],
  cooldownSeconds: 3,
  statusText: 'รอรับคำสั่งเจ้านาย 💬',
  avatarAutoRotate: false,
  avatarRotateMinutes: 60,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (!raw || !raw.trim()) throw new Error('File is completely empty'); 
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    console.error('⚠️ ไฟล์ config.json เสียหาย ระบบกำลังซ่อมแซมตัวเอง...');
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2)); } catch(err){}
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('⚠️ ไม่สามารถบันทึก config.json ได้:', e.message);
  }
}
let cfg = loadConfig();

// ==========================================
// 🎭 3. โหมดบอท
// ==========================================
const MODE_LABELS = {
  normal: '😊 ปกติ (น่ารัก)',
  troll: '😜 กวนโอ๊ย',
  serious: '🧐 จริงจัง',
  polite: '🙏 สุภาพ',
  teacher: '📚 ครูใจดี',
};
const MODE_PROMPTS = {
  normal: 'คุณคือผู้ช่วยสุดน่ารัก ตอบเป็นภาษาไทย สั้นๆ กระชับ เป็นมิตร',
  troll: 'คุณคือเพื่อนซี้ปากแจ๋ว ตอบเป็นภาษาไทยแบบกวนโอ๊ยขำๆแต่ไม่หยาบคาย สั้นๆ',
  serious: 'คุณคือผู้เชี่ยวชาญ ตอบเป็นภาษาไทย มีสาระ ตรงไปตรงมา กระชับ',
  polite: 'คุณคือผู้ช่วยสุภาพเรียบร้อย ตอบเป็นภาษาไทย ใช้คำสุภาพลงท้ายด้วยครับ/ค่ะเสมอ',
  teacher: 'คุณคือครูใจดีที่อธิบายเรื่องยากๆให้เข้าใจง่ายด้วยตัวอย่างสั้นๆ ตอบเป็นภาษาไทย',
};

function getSystemPrompt() {
  return cfg.customPrompt && cfg.customPrompt.trim()
    ? cfg.customPrompt.trim()
    : (MODE_PROMPTS[cfg.mode] || MODE_PROMPTS.normal);
}
// ==========================================
// 🧠 4. ฟังก์ชันเครื่องยนต์ AI และตัวกรองอัจฉริยะ
// ==========================================
function detectApiProvider(key) {
  const k = key.trim();
  if (k.startsWith('gsk_')) {
    return { name: 'Groq (Llama 3.3)', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', key: k };
  }
  if (k.startsWith('sk-or-v1-')) {
    return { name: 'OpenRouter (Free)', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free', key: k };
  }
  if (k.startsWith('AIzaSy')) {
    return { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-1.5-flash', key: k };
  }
  return { name: 'OpenAI / Compatible', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-3.5-turbo', key: k };
}

const FALLBACK_ANSWERS = [
  'อืมมม... ว่าไงต่อนะ?',
  'พิมพ์มาแค่นี้ AI งงเลยนะเนี่ย 😅',
  'รับทราบ! มีอะไรให้รับใช้อีกไหม?',
];

function isValidAiResponse(reply) {
  if (!reply || typeof reply !== 'string') return false;
  const text = reply.trim().toLowerCase();
  if (text.length === 0) return false;
  if (text.includes('<!doctype html') || text.includes('<html') || text.includes('<body')) return false;
  if (text === 'timed out' || text.includes('time out') || text === 'timeout') return false;
  if (text.includes('rate limit') || text.includes('too many requests')) return false;
  if (text.includes('502 bad gateway') || text.includes('503 service unavailable') || text.includes('error 500')) return false;
  if (text.includes('{"error":') || text.includes('internal server error') || text.includes('cloudflare')) return false; 
  return true;
}

// อัปเกรดรับค่า customSysPrompt เพื่อสวมบทบาทแม่หมอตอนดูดวง
async function getAiResponse(text, userName, customSysPrompt = null) {
  const basePrompt = customSysPrompt || getSystemPrompt();
  const systemPrompt = `${basePrompt}\n(หมายเหตุ: ตอนนี้คุณกำลังคุยกับผู้ใช้ชื่อ "${userName || 'User'}")`;
  
  const safeText = text.length > 500 ? text.slice(0, 500) + '...' : text;
  const fullPromptGET = `${systemPrompt}\n\nข้อความจากผู้ใช้: ${safeText}`;

  // 1️⃣ Custom API
  if (cfg.customApiKey && cfg.customApiKey.trim() !== '') {
    const provider = detectApiProvider(cfg.customApiKey);
    try {
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}` };
      const res = await axios.post(provider.url, {
        model: provider.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }]
      }, { headers, timeout: 15000 });
      const reply = res.data?.choices?.[0]?.message?.content;
      if (isValidAiResponse(reply)) return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
    } catch (e) { console.error(`❌ Custom API (${provider.name}) Failed:`, e.message); }
  }

  // 2️⃣ Pollinations
  try {
    const res = await axios.post('https://text.pollinations.ai/', {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
      model: 'openai',
      seed: Math.floor(Math.random() * 1000000)
    }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    let reply = res.data;
    if (typeof reply === 'object' && reply.content) reply = reply.content;
    if (isValidAiResponse(reply)) return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
  } catch (e) {}

  // 3️⃣ Hercai
  try {
    const res = await axios.get(`https://hercai.onrender.com/v3/hercai?question=${encodeURIComponent(fullPromptGET)}`, { timeout: 15000 });
    if (res.data && res.data.reply && isValidAiResponse(res.data.reply)) return res.data.reply.length > 1900 ? res.data.reply.slice(0, 1900) + '...' : res.data.reply;
  } catch (e) {}

  // 4️⃣ Popcat
  try {
    const res = await axios.get(`https://api.popcat.xyz/chatbot?msg=${encodeURIComponent(safeText)}&owner=Owner&botname=AI`, { timeout: 10000 });
    if (res.data && res.data.response && isValidAiResponse(res.data.response)) return res.data.response.length > 1900 ? res.data.response.slice(0, 1900) + '...' : res.data.response;
  } catch (e) {}

  return FALLBACK_ANSWERS[Math.floor(Math.random() * FALLBACK_ANSWERS.length)];
}

// ==========================================
// 🖼️ 5. สุ่มรูปโปรไฟล์
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
    } catch (e) { continue; }
  }
  return { success: false, source: null };
}

let avatarRotateInterval = null;
function startAvatarAutoRotate() {
  if (avatarRotateInterval) clearInterval(avatarRotateInterval);
  if (!cfg.avatarAutoRotate) return;
  avatarRotateInterval = setInterval(() => changeAvatarFromApi(), Math.max(5, cfg.avatarRotateMinutes) * 60 * 1000);
}
  // ==========================================
// ⚔️ 6. ระบบ Memory RPG ป้องกันเซิร์ฟเวอร์ค้าง
// ==========================================
const activeMonsters = new Map(); // เก็บสถานะมอนสเตอร์ชั่วคราว
const cooldownMap = new Map();

function isOnCooldown(userId) {
  if (cooldownMap.size > 1000) cooldownMap.clear(); 
  const last = cooldownMap.get(userId) || 0;
  const now = Date.now();
  if (now - last < cfg.cooldownSeconds * 1000) return true;
  cooldownMap.set(userId, now);
  return false;
}

// ล้างขยะ RPG ที่ค้างเกิน 1 ชั่วโมงเพื่อป้องกัน Memory Leak
function sweepDeadMonsters() {
  if (activeMonsters.size > 100) {
    const now = Date.now();
    for (const [key, val] of activeMonsters.entries()) {
      if (now - val.timestamp > 3600000) activeMonsters.delete(key); 
    }
  }
}

// ==========================================
// 🤖 7. Client Setup
// ==========================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once(Events.ClientReady, () => {
  console.log('==========================================');
  console.log(`✅ ล็อกอินสำเร็จ: ${client.user.tag}`);
  console.log(`🔑 คำสั่งเปิดแผงควบคุมคือ: ${PANEL_COMMAND}`);
  console.log(`🎮 ฟีเจอร์เสริม: !วาดรูป, !ดูดวง, !ตีมอน, !กาชา`);
  console.log('==========================================');
  client.user.setActivity(cfg.statusText, { type: ActivityType.Playing });
  startAvatarAutoRotate();
});

// ==========================================
// 🎛️ 8. แผงควบคุม (อัปเกรดปุ่มฟีเจอร์ 5x5 Limit)
// ==========================================
const fmtChannels = (ids) => (ids && ids.length ? ids.slice(0, 5).map((id) => `<#${id}>`).join(' ') + (ids.length > 5 ? '...' : '') : 'ทุกห้อง');
const fmtRoles = (ids) => (ids && ids.length ? ids.slice(0, 5).map((id) => `<@&${id}>`).join(' ') + (ids.length > 5 ? '...' : '') : 'ทุกคน');

function buildPanelPayload() {
  const customLen = cfg.customPrompt ? cfg.customPrompt.length : 0;
  const promptLine = cfg.customPrompt 
    ? `📝 Prompt: ${customLen > 50 ? cfg.customPrompt.trim().slice(0, 50) + '...' : cfg.customPrompt.trim()}`
    : `🎭 โหมด: ${MODE_LABELS[cfg.mode] || cfg.mode}`;
    
  let apiStatus = '🔴 ใช้ระบบฟรีอัตโนมัติ';
  if (cfg.customApiKey && cfg.customApiKey.trim() !== '') {
    const provider = detectApiProvider(cfg.customApiKey);
    apiStatus = `🟢 ใช้ค่าย: **${provider.name}**`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎛️ แผงควบคุมบอท AI (เวอร์ชันเต็มรูปแบบ)')
    .setColor(cfg.isActive ? 0x2ECA53 : 0xE74C3C)
    .setDescription(
      `🌐 ระบบ AI: ${apiStatus}\n` +
      `${promptLine}\n` +
      `📌 ห้องที่ตอบ: ${fmtChannels(cfg.targetChannelIds)}\n` +
      `🎖️ ยศที่ตอบ: ${fmtRoles(cfg.targetRoleIds)}\n` +
      `⏱️ กันสแปม: ${cfg.cooldownSeconds} วิ | 🖼️ สุ่มรูป: ${cfg.avatarAutoRotate ? 'เปิด' : 'ปิด'}`
    );

  // แถวที่ 1: จัดการสวิตช์ฟีเจอร์ทั้งหมด (5 ปุ่มเต็มขีดจำกัด Discord)
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle').setLabel(cfg.isActive ? '🟢 AI แชท' : '🔴 AI แชท').setStyle(cfg.isActive ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_toggle_img').setLabel(cfg.featureImage ? '🎨 วาดรูป: On' : '🎨 วาดรูป: Off').setStyle(cfg.featureImage ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_horo').setLabel(cfg.featureHoro ? '🔮 ดูดวง: On' : '🔮 ดูดวง: Off').setStyle(cfg.featureHoro ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_rpg').setLabel(cfg.featureRPG ? '⚔️ RPG: On' : '⚔️ RPG: Off').setStyle(cfg.featureRPG ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_refresh').setLabel('🔄').setStyle(ButtonStyle.Secondary)
  );

  // แถวที่ 2: จัดการระบบ API และ Prompt (5 ปุ่มเต็มขีดจำกัด Discord)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_set_prompt').setLabel('📝 Set Prompt').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_clear_prompt').setLabel('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_set_api').setLabel('🔑 Set API').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_clear_api').setLabel('🔌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_avatar').setLabel('🖼️ Avatar').setStyle(ButtonStyle.Secondary)
  );

  // แถวที่ 3-5: เมนูจัดการยศและห้อง
  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('select_mode').setPlaceholder('🎭 เปลี่ยนโหมดนิสัยบอท')
      .addOptions(Object.entries(MODE_LABELS).map(([value, label]) => ({ label, value, default: cfg.mode === value })))
  );

  const roleMenu = new RoleSelectMenuBuilder().setCustomId('select_roles').setPlaceholder('🎖️ เลือกยศที่ให้บอทตอบ (ไม่เลือก = ทุกคน)').setMinValues(0).setMaxValues(5);
  if (cfg.targetRoleIds && cfg.targetRoleIds.length > 0) roleMenu.addDefaultRoles(...cfg.targetRoleIds.slice(0, 5));
  const row4 = new ActionRowBuilder().addComponents(roleMenu);

  const channelMenu = new ChannelSelectMenuBuilder().setCustomId('select_channels').setPlaceholder('📌 เลือกห้องที่ให้บอทตอบ (ไม่เลือก = ทุกห้อง)').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(5);
  if (cfg.targetChannelIds && cfg.targetChannelIds.length > 0) channelMenu.addDefaultChannels(...cfg.targetChannelIds.slice(0, 5));
  const row5 = new ActionRowBuilder().addComponents(channelMenu);

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}
// ==========================================
// ✉️ 9. Message Handling (ระบบแชทหลักและมินิเกม)
// ==========================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const hasPerm = checkHasPermission(message.author.id);
  const userName = message.member?.displayName || message.author.globalName || message.author.username || 'User';

  if (message.content === '!help') {
    return message.reply({ 
      content: `**คำสั่งบอทสุดล้ำ:**\n1. พิมพ์แชทปกติ บอทจะตอบอัตโนมัติ\n2. \`!share [ลิงก์]\` - แชร์เพลง/ลิงก์ให้ AI รีวิว\n3. \`!วาดรูป [คำอธิบาย]\` - สั่ง AI วาดรูป (ภาษาอังกฤษจะสวยกว่า)\n4. \`!ดูดวง [คำถาม]\` หรือ \`!สุ่มไพ่ทาโรต์\` - ให้แม่หมอทำนายดวง\n5. \`!ตีมอน\` - ซัมมอนมอนสเตอร์มาตีเล่น\n6. \`!กาชา\` - สุ่มกาชาขำๆ\n*(เปิด-ปิดระบบเหล่านี้ได้ที่แผงควบคุมแอดมิน)*`,
      allowedMentions: { repliedUser: false }
    }).catch(() => {});
  }

  // ระบบเปิดแผงควบคุม
  if (message.content === PANEL_COMMAND) {
    if (!hasPerm) return;
    try { return await message.reply(buildPanelPayload()); } catch (err) { return; }
  }

  // ฟีเจอร์: แชร์เพลง
  if (message.content.startsWith('!share') || message.content.startsWith('!แชร์เพลง')) {
    const musicUrl = message.content.split(' ').slice(1).join(' ').trim();
    if (!musicUrl) return;
    await message.channel.sendTyping().catch(() => {});
    const aiReview = await getAiResponse(`มีคนแชร์สิ่งนี้: "${musicUrl}" ช่วยเขียนแซวหรือรีวิวสั้นๆ 1-2 บรรทัดหน่อย`, userName);
    const embed = new EmbedBuilder().setColor(0x1DB954).setAuthor({ name: `${userName} แชร์ลิงก์! 🎧`, iconURL: message.author.displayAvatarURL() })
      .setDescription(`**ลิงก์/ข้อความ:**\n${musicUrl}\n\n**🤖 ความเห็น AI:**\n${aiReview}`);
    message.delete().catch(() => {}); 
    return message.channel.send({ content: musicUrl, embeds: [embed] }).catch(() => {});
  }

  // 🎨 ฟีเจอร์: AI วาดรูป (ต้องเปิดสวิตช์)
  if (message.content.startsWith('!วาดรูป') && cfg.featureImage) {
    const prompt = message.content.replace('!วาดรูป', '').trim();
    if (!prompt) return message.reply({ content: '❌ ใส่คำอธิบายรูปด้วยสิ! เช่น `!วาดรูป cyberpunk cat`', allowedMentions: { repliedUser: false }});
    const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle(`🎨 ผลงานศิลปะของคุณ ${userName}`)
      .setDescription(`**คำสั่ง:** ${prompt}`)
      .setImage(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random()*10000)}`);
    return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  // 🔮 ฟีเจอร์: ดูดวง (ต้องเปิดสวิตช์)
  if ((message.content.startsWith('!ดูดวง') || message.content.startsWith('!สุ่มไพ่')) && cfg.featureHoro) {
    await message.channel.sendTyping().catch(() => {});
    const question = message.content.replace('!ดูดวง', '').replace('!สุ่มไพ่ทาโรต์', '').replace('!สุ่มไพ่', '').trim();
    const horoPrompt = `คุณคือแม่หมอ AI สุดขลัง ลึกลับและแม่นยำมาก หากผู้ใช้มีคำถามจงตอบคำถามนั้น แต่หากไม่มีคำถาม จงสุ่มไพ่ทาโรต์ 1 ใบพร้อมทำนายชะตาสั้นๆ`;
    const userText = question ? `คำถามของฉันคือ: ${question}` : `ขอสุ่มไพ่ทาโรต์ 1 ใบครับ/ค่ะ`;
    const reply = await getAiResponse(userText, userName, horoPrompt);
    const embed = new EmbedBuilder().setColor(0x8A2BE2).setTitle('🔮 ตำหนักแม่หมอ AI').setDescription(reply);
    return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  // ⚔️ ฟีเจอร์: RPG ตีมอนสเตอร์ (ต้องเปิดสวิตช์)
  if (message.content === '!ตีมอน' && cfg.featureRPG) {
    sweepDeadMonsters(); // ล้างขยะมอนสเตอร์เก่าๆ ทิ้ง
    const monsters = ['มังกรพุงพลุ้ย 🐉', 'สไลม์ชาเขียว 🟢', 'ก็อบลินถือตะหลิว 👺', 'อัศวินเกราะสนิม 🛡️', 'หมาป่าตาเหล่ 🐺', 'บอส: แมวอ้วน 🐈'];
    const mName = monsters[Math.floor(Math.random() * monsters.length)];
    const hp = Math.floor(Math.random() * 60) + 40; // เลือด 40-100
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle(`⚠️ พบมอนสเตอร์ป่า: ${mName}!`)
      .setDescription(`💖 พลังชีวิต: **${hp}/${hp} HP**\nรีบกดปุ่มโจมตีเพื่อกำจัดมันเร็ว!`);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('atk_monster').setLabel('⚔️ โจมตี!').setStyle(ButtonStyle.Danger));
    const msg = await message.reply({ embeds: [embed], components: [row], allowedMentions: { repliedUser: false } }).catch(() => {});
    if (msg) activeMonsters.set(msg.id, { hp, maxHp: hp, name: mName, timestamp: Date.now() });
    return;
  }

  // ⚔️ ฟีเจอร์: กาชา (ต้องเปิดสวิตช์)
  if (message.content === '!กาชา' && cfg.featureRPG) {
    const drops = ['🧂 เกลือล้วนๆ 100%', '🍜 มาม่า 1 ลัง', '🗡️ ดาบเอ็กซ์คาลิเบอร์ (หักๆ)', '💎 เพชร 1 เม็ด', '💩 ขยะอวกาศ', '👑 มงกุฎราชา', '💸 หนี้สิน 1 ล้านบาท'];
    const drop = drops[Math.floor(Math.random() * drops.length)];
    return message.reply({ content: `🎰 **${userName}** เปิดกาชาได้...\n🎉 **[ ${drop} ]**!`, allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  // ==========================================
  // ระบบตอบแชทอัตโนมัติ AI (ฐานข้อมูลหลัก)
  // ==========================================
  if (!cfg.isActive || message.content.startsWith('!') || !message.content.trim()) return;
  if (cfg.blacklistUserIds.includes(message.author.id)) return;
  if (cfg.targetChannelIds && cfg.targetChannelIds.length > 0 && !cfg.targetChannelIds.includes(message.channel.id)) return;
  if (cfg.targetRoleIds && cfg.targetRoleIds.length > 0) {
    const hasRole = message.member?.roles?.cache?.some((r) => cfg.targetRoleIds.includes(r.id));
    if (!hasRole) return;
  }

  if (isOnCooldown(message.author.id)) return message.react('⏳').catch(() => {});
  await message.channel.sendTyping().catch(() => {});
  
  const aiText = await getAiResponse(message.content, userName);
  await message.reply({ content: aiText, allowedMentions: { repliedUser: false } }).catch(() => {});
});
      // ==========================================
// 🕹️ 10. Interaction Handling (ตรรกะ RPG และ UI แผงควบคุม)
// ==========================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const userName = interaction.member?.displayName || interaction.user.username;

    // ⚔️ ตรรกะปุ่ม: โจมตีมอนสเตอร์ (RPG)
    if (interaction.isButton() && interaction.customId === 'atk_monster') {
      const msgId = interaction.message.id;
      const monster = activeMonsters.get(msgId);
      
      // ถ้าไม่มีในระบบ แสดงว่าตายไปแล้วหรือหนีไปแล้ว
      if (!monster) {
        return interaction.reply({ content: '❌ มอนสเตอร์ตัวนี้ถูกกำจัดไปแล้ว หรือหนีไปแล้ว!', ephemeral: true }).catch(() => {});
      }

      // คำนวณความเสียหาย (ดาเมจ 5-20) และคริติคอล (20% chance)
      const baseDmg = Math.floor(Math.random() * 16) + 5; 
      const isCrit = Math.random() < 0.2; 
      const finalDmg = isCrit ? baseDmg * 2 : baseDmg;
      monster.hp -= finalDmg;

      if (monster.hp <= 0) {
        // มอนสเตอร์ตาย: ลบออกจากหน่วยความจำและประกาศผล
        activeMonsters.delete(msgId);
        const embed = new EmbedBuilder(interaction.message.embeds[0])
          .setColor(0x00FF00)
          .setDescription(`💀 **${monster.name}** ถูกกำจัดแล้ว!\nผู้ปิดฉาก: **${userName}** (ดาเมจ: ${finalDmg}) ${isCrit ? '💥' : ''}`);
        return interaction.update({ embeds: [embed], components: [] }).catch(() => {});
      } else {
        // มอนสเตอร์ยังรอด: อัปเดตเลือดและโชว์ความเสียหาย
        const embed = new EmbedBuilder(interaction.message.embeds[0])
          .setDescription(`💖 พลังชีวิต: **${monster.hp}/${monster.maxHp} HP**\n**${userName}** โจมตีโดนไป **${finalDmg}** ดาเมจ! ${isCrit ? '(💥 คริติคอล!)' : ''}`);
        return interaction.update({ embeds: [embed] }).catch(() => {});
      }
    }

    // กรองเฉพาะปุ่มและเมนูของแผงควบคุม (กันไปทับกับบอทอื่น)
    const panelCustomIds = [
      'btn_toggle', 'btn_toggle_img', 'btn_toggle_horo', 'btn_toggle_rpg', 'btn_refresh',
      'btn_avatar', 'btn_set_prompt', 'btn_clear_prompt', 'btn_set_api', 'btn_clear_api',
      'select_mode', 'select_roles', 'select_channels', 'modal_set_prompt', 'modal_set_api'
    ];
    
    if (!interaction.customId || !panelCustomIds.includes(interaction.customId)) return;
    if (!checkHasPermission(interaction.user.id)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์กดแผงควบคุมนี้!', ephemeral: true }).catch(() => {});
    }

    // 🔘 หมวดการกดปุ่มบนแผงควบคุม
    if (interaction.isButton()) {
      if (interaction.customId === 'btn_set_prompt') {
        const modal = new ModalBuilder().setCustomId('modal_set_prompt').setTitle('📝 ตั้ง Prompt นิสัยบอท');
        const input = new TextInputBuilder().setCustomId('prompt_input').setLabel('ใส่บทบาท/นิสัยบอท (จำกัด 1000 อักษร)')
          .setStyle(TextInputStyle.Paragraph).setValue(cfg.customPrompt || '').setMaxLength(1000).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal).catch(() => {});
      }

      if (interaction.customId === 'btn_set_api') {
        const modal = new ModalBuilder().setCustomId('modal_set_api').setTitle('🔑 ใส่ API Key ฟรี (Groq/Gemini/ฯลฯ)');
        const keyInput = new TextInputBuilder().setCustomId('api_key').setLabel('วาง API Key ที่นี่')
          .setStyle(TextInputStyle.Short).setValue(cfg.customApiKey || '').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        return interaction.showModal(modal).catch(() => {});
      }

      // สวิตช์เปิด-ปิดระบบต่างๆ
      if (interaction.customId === 'btn_toggle') cfg.isActive = !cfg.isActive;
      else if (interaction.customId === 'btn_toggle_img') cfg.featureImage = !cfg.featureImage;
      else if (interaction.customId === 'btn_toggle_horo') cfg.featureHoro = !cfg.featureHoro;
      else if (interaction.customId === 'btn_toggle_rpg') cfg.featureRPG = !cfg.featureRPG;
      else if (interaction.customId === 'btn_avatar') {
        await interaction.update(buildPanelPayload()).catch(() => {});
        const r = await changeAvatarFromApi();
        return interaction.followUp({ content: r.success ? `✅ เปลี่ยนรูปแล้ว (${r.source})` : '❌ เปลี่ยนรูปไม่สำเร็จ', ephemeral: true }).catch(() => {});
      } 
      else if (interaction.customId === 'btn_clear_prompt') cfg.customPrompt = '';
      else if (interaction.customId === 'btn_clear_api') cfg.customApiKey = '';
    }

    // 📋 หมวดเมนูตัวเลือก
    if (interaction.isAnySelectMenu()) {
      if (interaction.customId === 'select_mode') {
        cfg.mode = interaction.values[0] || 'normal';
        cfg.customPrompt = ''; 
      } else if (interaction.customId === 'select_roles') {
        cfg.targetRoleIds = interaction.values || [];
      } else if (interaction.customId === 'select_channels') {
        cfg.targetChannelIds = interaction.values || [];
      }
    }

    // 📝 หมวดรับค่าฟอร์ม
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_set_prompt') cfg.customPrompt = interaction.fields.getTextInputValue('prompt_input').trim();
      else if (interaction.customId === 'modal_set_api') cfg.customApiKey = interaction.fields.getTextInputValue('api_key').trim();
    }

    saveConfig(); 
    
    // อัปเดตแผงควบคุม
    if (interaction.customId !== 'btn_avatar' && !interaction.customId.startsWith('btn_set_')) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.update(buildPanelPayload()).catch(() => {});
      }
    }

  } catch (err) {
    console.error('❌ Interaction Error ถูกดักจับอย่างปลอดภัย:', err.message);
  }
});

// รันบอท!
client.login(TOKEN);
        

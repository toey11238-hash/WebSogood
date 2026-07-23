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
// 📁 2. ระบบ Config
// ==========================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  isActive: true,
  mode: 'normal',
  customPrompt: '',
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
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {}
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
// 🧠 4. ระบบ API ฟรีครอบจักรวาล (ใส่ของตัวเองได้ที่นี่!)
// ==========================================

// 👉 จุดที่ 1: ถ้าคุณหา API ฟรีแบบ GET มาได้ (เช่น เว็บที่พิมพ์ข้อความต่อท้ายลิงก์แล้วได้คำตอบเลย) เอาลิงก์มาใส่ตรงนี้
const MY_CUSTOM_GET_APIS = [
  // ตัวอย่างการใส่ (ลบ // ออกเพื่อใช้งาน):
  // "https://api.somefreeapi.com/chat?text=",
  // "https://another-free-api.net/ask?q="
];

// 👉 จุดที่ 2: ถ้าคุณได้ API ฟรีที่จำลองโครงสร้างเหมือน OpenAI (POST JSON) เอามาใส่ตรงนี้
const MY_CUSTOM_POST_APIS = [
  // ตัวอย่าง (ลบ // ออกเพื่อใช้งาน และเปลี่ยน URL/KEY ถ้ามี):
  // { url: "https://free-openai-proxy.com/v1/chat/completions", key: "ถ้ามีให้ใส่ ไม่มีปล่อยว่าง", model: "gpt-3.5-turbo" }
];

// 👉 จุดที่ 3: API ฟรีสำรองที่โค้ดมีให้แต่แรก (ฟรี 100% ไม่ต้องตั้งค่า)
const DEFAULT_FREE_MODELS = ['openai', 'mistral', 'llama', 'searchgpt']; 
const FALLBACK_ANSWERS = [
  'อืมมม... ว่าไงต่อนะ?',
  'พิมพ์มาแค่นี้ AI งงเลยนะเนี่ย 😅',
  'รับทราบ! มีอะไรให้รับใช้อีกไหม?',
];

async function getAiResponse(text) {
  const systemPrompt = getSystemPrompt();

  // 1️⃣ ลองเรียกใช้ Custom POST API ที่คุณใส่เองก่อน (ถ้ามี)
  for (const api of MY_CUSTOM_POST_APIS) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (api.key) headers['Authorization'] = `Bearer ${api.key}`;
      
      const res = await axios.post(api.url, {
        model: api.model || 'default',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      }, { headers, timeout: 10000 });
      
      const reply = res.data?.choices?.[0]?.message?.content;
      if (reply) return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
    } catch (e) { console.log("Custom POST API Failed, trying next..."); }
  }

  // 2️⃣ ลองเรียกใช้ Custom GET API ที่คุณใส่เอง (ถ้ามี)
  for (const url of MY_CUSTOM_GET_APIS) {
    try {
      const res = await axios.get(`${url}${encodeURIComponent(text)}`, { timeout: 8000 });
      const reply = typeof res.data === 'string' ? res.data : (res.data.reply || res.data.response || res.data.message || JSON.stringify(res.data));
      if (reply && !reply.toLowerCase().includes('<!doctype html')) {
        return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
      }
    } catch (e) { console.log("Custom GET API Failed, trying next..."); }
  }

  // 3️⃣ ถ้าคุณไม่ได้ใส่ API เอง หรือตัวบนๆ พังหมด จะไหลมาใช้ของฟรีที่ผมเตรียมไว้ให้ (Pollinations)
  for (const model of DEFAULT_FREE_MODELS) {
    try {
      const res = await axios.post('https://text.pollinations.ai/', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        model: model,
        seed: Math.floor(Math.random() * 100000)
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      let reply = res.data;
      if (typeof reply === 'object' && reply.content) reply = reply.content;
      if (typeof reply === 'string' && reply.trim() && !reply.toLowerCase().includes('<!doctype html') && !reply.toLowerCase().includes('<html')) {
        return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
      }
    } catch (e) {
      // ระบบสำรองชั้นสุดท้าย
      try {
        const resGet = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(text)}`, {
          params: { system: systemPrompt, model },
          headers: { Accept: 'text/plain', 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000
        });
        const replyGet = resGet.data;
        if (typeof replyGet === 'string' && replyGet.trim() && !replyGet.toLowerCase().includes('<!doctype html')) {
          return replyGet.length > 1900 ? replyGet.slice(0, 1900) + '...' : replyGet;
        }
      } catch (e2) { continue; }
    }
  }

  // 4️⃣ ถ้า API ทุกตัวในโลกพังหมด (เน็ตขาด) จะใช้คำพูดสำรอง
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
    } catch (e) {
      continue;
    }
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
// ⏱️ 6. Cooldown
// ==========================================
const cooldownMap = new Map();
function isOnCooldown(userId) {
  const last = cooldownMap.get(userId) || 0;
  const now = Date.now();
  if (now - last < cfg.cooldownSeconds * 1000) return true;
  cooldownMap.set(userId, now);
  return false;
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
  console.log(`👑 เจ้าของบอทที่อนุญาต: ${OWNER_IDS.join(', ')}`);
  console.log('==========================================');
  client.user.setActivity(cfg.statusText, { type: ActivityType.Playing });
  startAvatarAutoRotate();
});

// ==========================================
// 🎛️ 8. แผงควบคุม (เต็มรูปแบบ 5 แถว)
// ==========================================
const fmtChannels = (ids) => (ids.length ? ids.map((id) => `<#${id}>`).join(' ') : 'ทุกห้อง');
const fmtRoles = (ids) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : 'ทุกคน');

function buildPanelPayload() {
  const promptLine = cfg.customPrompt && cfg.customPrompt.trim()
    ? `📝 Prompt: ${cfg.customPrompt.trim().slice(0, 100)}...`
    : `🎭 โหมด: ${MODE_LABELS[cfg.mode] || cfg.mode}`;

  const embed = new EmbedBuilder()
    .setTitle('🎛️ แผงควบคุมบอท AI')
    .setColor(cfg.isActive ? 0x2ECA53 : 0xE74C3C)
    .setDescription(
      `สถานะ: **${cfg.isActive ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n` +
      `${promptLine}\n` +
      `📌 ห้องที่ตอบ: ${fmtChannels(cfg.targetChannelIds)}\n` +
      `🎖️ ยศที่ตอบ: ${fmtRoles(cfg.targetRoleIds)}\n` +
      `⏱️ กันสแปม: ${cfg.cooldownSeconds} วินาที/คน | 🖼️ สุ่มรูป: ${cfg.avatarAutoRotate ? `ทุก ${cfg.avatarRotateMinutes} นาที` : 'ปิด'}`
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle').setLabel(cfg.isActive ? '🟢 ทำงานอยู่' : '🔴 ปิดอยู่').setStyle(cfg.isActive ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_refresh').setLabel('🔄 รีเฟรช').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_avatar').setLabel('🖼️ สุ่มรูป').setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_set_prompt').setLabel('📝 ตั้ง Prompt').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_clear_prompt').setLabel('🗑️ ล้าง Prompt').setStyle(ButtonStyle.Danger)
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

// ==========================================
// ✉️ 9. Message Handling
// ==========================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const hasPerm = checkHasPermission(message.author.id);

  if (message.content === '!help') {
    return message.reply(`**วิธีใช้งาน:** พิมพ์ข้อความคุยกับบอทได้เลย\n*(สำหรับเจ้าของบอท ใช้คำสั่งเปิดแผงควบคุม)*`);
  }

  if (message.content === PANEL_COMMAND) {
    if (!hasPerm) {
      return message.reply(`❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้! (ID ของคุณ: \`${message.author.id}\`)`);
    }
    try {
      return await message.reply(buildPanelPayload());
    } catch (err) {
      return message.reply('เกิดข้อผิดพลาดในการสร้างแผงควบคุม');
    }
  }

  if (message.content === '!avatar' && hasPerm) {
    const msg = await message.reply('⏳ กำลังเปลี่ยนรูปโปรไฟล์...');
    const r = await changeAvatarFromApi();
    return msg.edit(r.success ? `✅ สำเร็จ! (${r.source})` : '❌ ไม่สำเร็จ');
  }

  // ระบบตอบอัตโนมัติ AI
  if (!cfg.isActive) return;
  if (message.content.startsWith('!')) return;
  if (!message.content.trim()) return; 
  if (cfg.blacklistUserIds.includes(message.author.id)) return;
  
  if (cfg.targetChannelIds.length && !cfg.targetChannelIds.includes(message.channel.id)) return;
  
  if (cfg.targetRoleIds.length) {
    const hasRole = message.member?.roles.cache.some((r) => cfg.targetRoleIds.includes(r.id));
    if (!hasRole) return;
  }

  if (isOnCooldown(message.author.id)) return message.react('⏳').catch(() => {});

  await message.channel.sendTyping().catch(() => {});
  const aiText = await getAiResponse(message.content);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`del_${message.author.id}`).setLabel('🗑️ ลบข้อความนี้').setStyle(ButtonStyle.Secondary)
  );

  await message.reply({ content: aiText, components: [row] }).catch(() => {});
});

// ==========================================
// 🕹️ 10. Interaction Handling
// ==========================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('del_')) {
    const ownerId = interaction.customId.split('_')[1];
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: '❌ คุณไม่ใช่คนถาม ลบไม่ได้!', flags: 64 });
    }
    await interaction.deferUpdate().catch(() => {});
    return interaction.message.delete().catch(() => {});
  }

  const panelCustomIds = ['btn_toggle', 'btn_refresh', 'btn_avatar', 'btn_set_prompt', 'btn_clear_prompt', 'select_mode', 'select_roles', 'select_channels', 'modal_set_prompt'];
  if (!interaction.customId || !panelCustomIds.includes(interaction.customId)) return;

  if (!checkHasPermission(interaction.user.id)) {
    return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์กดแผงควบคุมนี้!', flags: 64 });
  }

  if (interaction.isButton() && interaction.customId === 'btn_set_prompt') {
    const modal = new ModalBuilder().setCustomId('modal_set_prompt').setTitle('ตั้ง Prompt นิสัยบอทเอง');
    const input = new TextInputBuilder()
      .setCustomId('prompt_input')
      .setLabel('ใส่บทบาท/นิสัยบอท')
      .setStyle(TextInputStyle.Paragraph)
      .setValue(cfg.customPrompt || '')
      .setMaxLength(1000)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  try {
    if (interaction.isButton() && interaction.customId === 'btn_toggle') {
      cfg.isActive = !cfg.isActive;
    } else if (interaction.isButton() && interaction.customId === 'btn_avatar') {
      changeAvatarFromApi().then((r) => {
        interaction.followUp({ content: r.success ? `✅ เปลี่ยนรูปแล้ว (${r.source})` : '❌ เปลี่ยนรูปไม่สำเร็จ', flags: 64 }).catch(() => {});
      });
    } else if (interaction.isButton() && interaction.customId === 'btn_clear_prompt') {
      cfg.customPrompt = '';
    } else if (interaction.isStringSelectMenu() && interaction.customId === 'select_mode') {
      cfg.mode = interaction.values[0];
      cfg.customPrompt = ''; 
    } else if (interaction.isRoleSelectMenu() && interaction.customId === 'select_roles') {
      cfg.targetRoleIds = interaction.values;
    } else if (interaction.isChannelSelectMenu() && interaction.customId === 'select_channels') {
      cfg.targetChannelIds = interaction.values;
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_prompt') {
      cfg.customPrompt = interaction.fields.getTextInputValue('prompt_input').trim();
    }

    saveConfig(); 
    await interaction.update(buildPanelPayload()).catch(() => {});
  } catch (err) {}
});

client.login(TOKEN);

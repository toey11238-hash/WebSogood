const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, EmbedBuilder } = require('discord.js');
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
// ⚙️ 1. อ่านค่า Environment Variables (รองรับหลาย ID + คำสั่งลับ)
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;

// รองรับหลาย ID คั่นด้วยเครื่องหมายจุลภาค (,) หรือใส่ ALL เพื่อเปิดให้ทุกคนใช้ได้
const OWNER_ID_RAW = process.env.OWNER_ID ? process.env.OWNER_ID.trim() : 'ALL';
const OWNER_IDS = OWNER_ID_RAW.split(',').map(id => id.trim()).filter(Boolean);

// ตั้งชื่อคำสั่งเปิดแผงควบคุมลับเองได้ (ถ้าไม่ตั้ง จะใช้ !panel เป็นค่าเริ่มต้น)
const PANEL_COMMAND = process.env.PANEL_CMD ? process.env.PANEL_CMD.trim() : '!panel';

if (!TOKEN) {
  console.error('❌ ไม่พบ DISCORD_TOKEN ใน Environment Variables ของ Render!');
  process.exit(1);
}

// ฟังก์ชันเช็คสิทธิ์ใช้งาน
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
// 🧠 4. AI Response (Pollinations ฟรี)
// ==========================================
const AI_MODEL_CHAIN = ['mistral', 'llama', 'searchgpt']; 
const FALLBACK_ANSWERS = [
  'อืมมม... ว่าไงต่อนะ?',
  'พิมพ์มาแค่นี้ AI งงเลยนะเนี่ย 😅',
  'รับทราบ! มีอะไรให้รับใช้อีกไหม?',
];

async function getAiResponse(text) {
  const systemPrompt = getSystemPrompt();
  for (const model of AI_MODEL_CHAIN) {
    try {
      const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(text)}`, {
        params: { system: systemPrompt, model },
        headers: { Accept: 'text/plain', 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000,
      });
      const reply = res.data;
      if (typeof reply !== 'string' || !reply.trim() || reply.toLowerCase().includes('<!doctype html') || reply.toLowerCase().includes('<html')) {
        throw new Error('Invalid response');
      }
      return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
    } catch (e) {
      continue; 
    }
  }
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
// 🎛️ 8. แผงควบคุม (Standard Discord UI)
// ==========================================
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
      `⏱️ กันสแปม: ${cfg.cooldownSeconds} วินาที/คน\n` +
      `🖼️ สุ่มรูป: ${cfg.avatarAutoRotate ? `ทุก ${cfg.avatarRotateMinutes} นาที` : 'ปิด'}`
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

  return { embeds: [embed], components: [row1, row2, row3] };
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

  // เรียกแผงควบคุมตามคำสั่งที่ตั้งไว้ (เช่น !panel หรือ คำสั่งลับ)
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
  if (message.content.startsWith('!')) return; // ไม่ตอบคำสั่งที่ขึ้นต้นด้วย !
  if (!message.content.trim()) return; // ข้ามข้อความว่าง (ส่งรูปสติกเกอร์อย่างเดียว)
  if (cfg.blacklistUserIds.includes(message.author.id)) return;
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

  const panelCustomIds = ['btn_toggle', 'btn_refresh', 'btn_avatar', 'btn_set_prompt', 'btn_clear_prompt', 'select_mode', 'modal_set_prompt'];
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
    } else if (interaction.isModalSubmit() && interaction.customId === 'modal_set_prompt') {
      cfg.customPrompt = interaction.fields.getTextInputValue('prompt_input').trim();
    }

    saveConfig(); 
    await interaction.update(buildPanelPayload()).catch(() => {});
  } catch (err) {}
});

client.login(TOKEN);
        

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
// 📁 2. ระบบ Config (พร้อมระบบซ่อมแซมตัวเอง)
// ==========================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  isActive: true,
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
    if (!raw.trim()) throw new Error('File is empty'); 
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    console.error('⚠️ ไฟล์ config.json มีปัญหา สร้างใหม่ด้วยค่าเริ่มต้น...');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
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
// 🧠 4. ระบบ API ฟรี และ Auto-Detect ค่าย
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
  'ตอนนี้เซิร์ฟเวอร์ AI ฝั่งผมกำลังหน่วงๆ ขออภัยด้วยนะเจ้านาย 🥲',
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

async function getAiResponse(text) {
  const systemPrompt = getSystemPrompt();
  const safeText = text.length > 500 ? text.slice(0, 500) + '...' : text;
  const fullPromptGET = `${systemPrompt}\n\nข้อความจากผู้ใช้: ${safeText}`;

  // 1️⃣ Custom API
  if (cfg.customApiKey && cfg.customApiKey.trim() !== '') {
    const provider = detectApiProvider(cfg.customApiKey);
    try {
      const headers = { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`
      };
      const res = await axios.post(provider.url, {
        model: provider.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }]
      }, { headers, timeout: 15000 });
      const reply = res.data?.choices?.[0]?.message?.content;
      if (isValidAiResponse(reply)) return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
    } catch (e) {
      console.error(`❌ Custom API (${provider.name}) Failed:`, e.message);
    }
  }

  // 2️⃣ Pollinations
  try {
    const res = await axios.post('https://text.pollinations.ai/', {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
      model: 'openai',
      seed: Math.floor(Math.random() * 1000000)
    }, {
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });
    let reply = res.data;
    if (typeof reply === 'object' && reply.content) reply = reply.content;
    if (isValidAiResponse(reply)) return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
  } catch (e) {
    console.error("❌ Pollinations API Error:", e.message);
  }

  // 3️⃣ Hercai
  try {
    const res = await axios.get(`https://hercai.onrender.com/v3/hercai?question=${encodeURIComponent(fullPromptGET)}`, { timeout: 15000 });
    if (res.data && res.data.reply && isValidAiResponse(res.data.reply)) {
      return res.data.reply.length > 1900 ? res.data.reply.slice(0, 1900) + '...' : res.data.reply;
    }
  } catch (e) {
    console.error("❌ Hercai API Error:", e.message);
  }

  // 4️⃣ Popcat
  try {
    const res = await axios.get(`https://api.popcat.xyz/chatbot?msg=${encodeURIComponent(safeText)}&owner=Owner&botname=AI`, { timeout: 10000 });
    if (res.data && res.data.response && isValidAiResponse(res.data.response)) {
      return res.data.response.length > 1900 ? res.data.response.slice(0, 1900) + '...' : res.data.response;
    }
  } catch (e) {
    console.error("❌ Popcat API Error:", e.message);
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
// 🎛️ 8. แผงควบคุม (อุดรอยรั่วความยาวข้อความและเมนู)
// ==========================================
const fmtChannels = (ids) => (ids.length ? ids.map((id) => `<#${id}>`).join(' ') : 'ทุกห้อง');
const fmtRoles = (ids) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : 'ทุกคน');

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
    .setTitle('🎛️ แผงควบคุมบอท AI')
    .setColor(cfg.isActive ? 0x2ECA53 : 0xE74C3C)
    .setDescription(
      `สถานะ: **${cfg.isActive ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n` +
      `🌐 ระบบ AI: ${apiStatus}\n` +
      `${promptLine}\n` +
      `📌 ห้องที่ตอบ: ${fmtChannels(cfg.targetChannelIds)}\n` +
      `🎖️ ยศที่ตอบ: ${fmtRoles(cfg.targetRoleIds)}\n` +
      `⏱️ กันสแปม: ${cfg.cooldownSeconds} วินาที | 🖼️ สุ่มรูป: ${cfg.avatarAutoRotate ? 'เปิด' : 'ปิด'}`
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle').setLabel(cfg.isActive ? '🟢 ทำงานอยู่' : '🔴 ปิดอยู่').setStyle(cfg.isActive ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_refresh').setLabel('🔄 รีเฟรช').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_avatar').setLabel('🖼️ สุ่มรูป').setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_set_prompt').setLabel('📝 ตั้ง Prompt').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_clear_prompt').setLabel('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_set_api').setLabel('🔑 ใส่ API Key ฟรี').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_clear_api').setLabel('🔌 ล้าง API Key').setStyle(ButtonStyle.Danger)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('select_mode').setPlaceholder('🎭 เปลี่ยนโหมดนิสัยบอท')
      .addOptions(Object.entries(MODE_LABELS).map(([value, label]) => ({ label, value, default: cfg.mode === value })))
  );

  const roleMenu = new RoleSelectMenuBuilder().setCustomId('select_roles').setPlaceholder('🎖️ เลือกยศที่ให้บอทตอบ (ไม่เลือก = ทุกคน)').setMinValues(0).setMaxValues(5);
  // ป้องกันบัค API Limit ถ้าเผลอยัดยศมาเกิน 5 ยศ ให้บังคับตัดเหลือ 5
  if (cfg.targetRoleIds && cfg.targetRoleIds.length > 0) roleMenu.addDefaultRoles(...cfg.targetRoleIds.slice(0, 5));
  const row4 = new ActionRowBuilder().addComponents(roleMenu);

  const channelMenu = new ChannelSelectMenuBuilder().setCustomId('select_channels').setPlaceholder('📌 เลือกห้องที่ให้บอทตอบ (ไม่เลือก = ทุกห้อง)').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(5);
  if (cfg.targetChannelIds && cfg.targetChannelIds.length > 0) channelMenu.addDefaultChannels(...cfg.targetChannelIds.slice(0, 5));
  const row5 = new ActionRowBuilder().addComponents(channelMenu);

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// ==========================================
// ✉️ 9. Message Handling
// ==========================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const hasPerm = checkHasPermission(message.author.id);

  if (message.content === '!help') {
    return message.reply(`**วิธีใช้งาน:** พิมพ์ข้อความคุยกับบอทได้เลย\n*(สำหรับเจ้าของบอท ใช้คำสั่งเปิดแผงควบคุม)*`).catch(() => {});
  }

  if (message.content === PANEL_COMMAND) {
    if (!hasPerm) {
      return message.reply({ content: `❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้! (ID ของคุณ: \`${message.author.id}\`)` }).catch(() => {});
    }
    try {
      return await message.reply(buildPanelPayload());
    } catch (err) {
      console.error('❌ Build Panel Error:', err.message);
      return message.reply('เกิดข้อผิดพลาดในการสร้างแผงควบคุม').catch(() => {});
    }
  }

  if (message.content === '!avatar' && hasPerm) {
    const msg = await message.reply('⏳ กำลังเปลี่ยนรูปโปรไฟล์...').catch(() => {});
    if (!msg) return;
    const r = await changeAvatarFromApi();
    return msg.edit(r.success ? `✅ สำเร็จ! (${r.source})` : '❌ ไม่สำเร็จ').catch(() => {});
  }

  // ระบบตอบอัตโนมัติ AI
  if (!cfg.isActive) return;
  if (message.content.startsWith('!')) return;
  if (!message.content.trim()) return; 
  if (cfg.blacklistUserIds.includes(message.author.id)) return;
  
  if (cfg.targetChannelIds.length > 0 && !cfg.targetChannelIds.includes(message.channel.id)) return;
  
  if (cfg.targetRoleIds.length > 0) {
    const hasRole = message.member?.roles?.cache?.some((r) => cfg.targetRoleIds.includes(r.id));
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
// 🕹️ 10. Interaction Handling (การันตีความปลอดภัยสูงสุด Type Guards)
// ==========================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // กรองเฉพาะ Custom IDs ของแผงควบคุม
    const panelCustomIds = [
      'btn_toggle', 'btn_refresh', 'btn_avatar', 'btn_set_prompt', 'btn_clear_prompt',
      'btn_set_api', 'btn_clear_api', 'select_mode', 'select_roles', 'select_channels', 
      'modal_set_prompt', 'modal_set_api'
    ];
    
    if (interaction.isButton() && interaction.customId.startsWith('del_')) {
      const ownerId = interaction.customId.split('_')[1];
      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ คุณไม่ใช่คนถาม ลบไม่ได้!', ephemeral: true }).catch(() => {});
      }
      await interaction.deferUpdate().catch(() => {});
      return interaction.message.delete().catch(() => {}); 
    }

    if (!panelCustomIds.includes(interaction.customId)) return;

    if (!checkHasPermission(interaction.user.id)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์กดแผงควบคุมนี้!', ephemeral: true }).catch(() => {});
    }

    // 🔥 ตรวจสอบปุ่มกด (Button)
    if (interaction.isButton()) {
      if (interaction.customId === 'btn_set_prompt') {
        const modal = new ModalBuilder().setCustomId('modal_set_prompt').setTitle('ตั้ง Prompt นิสัยบอทเอง');
        const input = new TextInputBuilder()
          .setCustomId('prompt_input')
          .setLabel('ใส่บทบาท/นิสัยบอท')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(cfg.customPrompt || '')
          .setMaxLength(1000)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal).catch(() => {});
      }

      if (interaction.customId === 'btn_set_api') {
        const modal = new ModalBuilder().setCustomId('modal_set_api').setTitle('🔑 ใส่ API Key ฟรี (Groq/Gemini/ฯลฯ)');
        const keyInput = new TextInputBuilder()
          .setCustomId('api_key')
          .setLabel('วาง API Key (Groq gsk_ / Gemini AIzaSy / ฯลฯ)')
          .setStyle(TextInputStyle.Short)
          .setValue(cfg.customApiKey || '')
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        return interaction.showModal(modal).catch(() => {});
      }

      if (interaction.customId === 'btn_toggle') {
        cfg.isActive = !cfg.isActive;
      } else if (interaction.customId === 'btn_avatar') {
        await interaction.update(buildPanelPayload()).catch(() => {});
        const r = await changeAvatarFromApi();
        return interaction.followUp({ content: r.success ? `✅ เปลี่ยนรูปแล้ว (${r.source})` : '❌ เปลี่ยนรูปไม่สำเร็จ', ephemeral: true }).catch(() => {});
      } else if (interaction.customId === 'btn_clear_prompt') {
        cfg.customPrompt = '';
      } else if (interaction.customId === 'btn_clear_api') {
        cfg.customApiKey = '';
      }
    }

    // 🔥 ตรวจสอบเมนูตัวเลือก (Select Menu)
    if (interaction.isAnySelectMenu()) {
      if (interaction.customId === 'select_mode') {
        cfg.mode = interaction.values[0];
        cfg.customPrompt = ''; 
      } else if (interaction.customId === 'select_roles') {
        cfg.targetRoleIds = interaction.values;
      } else if (interaction.customId === 'select_channels') {
        cfg.targetChannelIds = interaction.values;
      }
    }

    // 🔥 ตรวจสอบหน้าต่างกรอกข้อมูล (Modal Submit)
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_set_prompt') {
        cfg.customPrompt = interaction.fields.getTextInputValue('prompt_input').trim();
      } else if (interaction.customId === 'modal_set_api') {
        cfg.customApiKey = interaction.fields.getTextInputValue('api_key').trim();
      }
    }

    saveConfig(); 
    
      // อัปเดตแผงควบคุม (ยกเว้นปุ่ม avatar เพราะอัปเดตไปแล้ว และถ้าเป็นปุ่มปกติให้แสดงผลลัพธ์)
    if (interaction.customId !== 'btn_avatar' && !interaction.customId.startsWith('btn_set_')) {
      await interaction.update(buildPanelPayload()).catch(() => {});
    }

  } catch (err) {
    console.error('❌ Interaction Error:', err.message);
  }
});

client.login(TOKEN);

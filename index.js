const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express'); 
require('dotenv').config();

// ==========================================
// 🌐 0. สร้าง Web Server เล็กๆ ป้องกัน Render ปิดบอท
// ==========================================
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Discord AI Bot is running and awake! 🤖 (100% Free AI)');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🌐 Web server is running on port ${port} (พร้อมสำหรับ Render & UptimeRobot)`);
});

// ==========================================
// ⚙️ 1. ตั้งค่าพื้นฐาน (อ่านจากไฟล์ .env หรือ Variables ใน Render)
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN || !OWNER_ID) {
  console.error('❌ ไม่พบ DISCORD_TOKEN หรือ OWNER_ID');
  console.error('👉 กรุณาตั้งค่า Environment Variables ให้เรียบร้อย');
  process.exit(1);
}

// ==========================================
// 📁 2. ระบบคอนฟิก
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
    console.error('⚠️ อ่าน config.json ไม่ได้ ใช้ค่าเริ่มต้น:', e.message);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('⚠️ ไม่สามารถบันทึก config ได้:', e.message);
  }
}
let cfg = loadConfig();

// ==========================================
// 🎭 3. โหมดนิสัยบอทสำเร็จรูป
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
// 🧠 4. ระบบ AI ตอบข้อความ (ฟรี 100% ไม่พึ่ง OpenAI)
// ==========================================
const AI_MODEL_CHAIN = ['mistral', 'llama', 'searchgpt']; 
const FALLBACK_ANSWERS = [
  'อืมมม... ว่าไงต่อนะ?',
  'พิมพ์มาแค่นี้ AI งงเลยนะเนี่ย 😅',
  'รับทราบ! มีอะไรให้รับใช้อีกไหม?',
  'อ่าว สัญญาณเน็ตฝั่งบอทกระตุก ขอตอบแบบคนธรรมดาไปก่อนนะ!',
  'เข้าใจแล้ว (ถึงจะแอบงงๆ นิดหน่อยก็เถอะ 🤣)',
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
      
      if (typeof reply !== 'string' || !reply.trim() || reply.includes('<!DOCTYPE html>') || reply.includes('<html')) {
        throw new Error('Invalid response from API');
      }
      return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
    } catch (e) {
      console.log(`[AI Fallback] โมเดล ${model} มีปัญหา ข้ามไปตัวถัดไป...`);
      continue; 
    }
  }
  return FALLBACK_ANSWERS[Math.floor(Math.random() * FALLBACK_ANSWERS.length)];
}

// ==========================================
// 🖼️ 5. ระบบเปลี่ยนรูปโปรไฟล์ (API ฟรี)
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
// ⏱️ 6. ระบบกันสแปม (Cooldown ต่อคน)
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

client.once('ready', () => {
  console.log('==========================================');
  console.log(`✅ ล็อกอินสำเร็จ: ${client.user.tag}`);
  console.log('- พิมพ์ !panel  : เรียกแผงควบคุม (ปรับทุกอย่างแบบเรียลไทม์)');
  console.log('- พิมพ์ !help   : ดูคำสั่งทั้งหมด');
  console.log('==========================================');
  client.user.setActivity(cfg.statusText, { type: ActivityType.Playing });
  startAvatarAutoRotate();
});

// ==========================================
// 🎛️ 8. สร้างแผงควบคุม (แก้ไขใหม่ ใช้ API มาตรฐานของ Discord)
// ==========================================
const fmtChannels = (ids) => (ids.length ? ids.map((id) => `<#${id}>`).join(' ') : 'ทุกห้อง');
const fmtRoles = (ids) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : 'ทุกคน');

function buildPanelPayload() {
  const promptLine = cfg.customPrompt && cfg.customPrompt.trim()
    ? `📝 Prompt กำหนดเอง: ${cfg.customPrompt.trim().slice(0, 120)}${cfg.customPrompt.length > 120 ? '...' : ''}`
    : `🎭 โหมด: ${MODE_LABELS[cfg.mode] || cfg.mode}`;

  const embed = new EmbedBuilder()
    .setTitle('🎛️ แผงควบคุมบอทระดับเทพ')
    .setColor(cfg.isActive ? 0x2ECA53 : 0xE74C3C)
    .setDescription(
      `สถานะ: **${cfg.isActive ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n` +
      `${promptLine}\n\n` +
      `📌 ห้องที่ตอบ: ${fmtChannels(cfg.targetChannelIds)}\n` +
      `🎖️ ยศที่ตอบ: ${fmtRoles(cfg.targetRoleIds)}\n` +
      `⏱️ กันสแปม: ${cfg.cooldownSeconds} วินาที/คน\n` +
      `🖼️ สุ่มรูป: ${cfg.avatarAutoRotate ? `ทุก ${cfg.avatarRotateMinutes} นาที` : 'ปิด'}`
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle').setLabel(cfg.isActive ? '🟢 บอททำงานอยู่' : '🔴 บอทปิดอยู่').setStyle(cfg.isActive ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_refresh').setLabel('🔄 รีเฟรช').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_avatar').setLabel('🖼️ สุ่มรูปโปรไฟล์').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_set_prompt').setLabel('📝 ตั้ง Prompt').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_clear_prompt').setLabel('🗑️ ล้าง Prompt').setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('select_mode').setPlaceholder(`🎭 โหมดปัจจุบัน: ${MODE_LABELS[cfg.mode] || cfg.mode}`)
      .addOptions(Object.entries(MODE_LABELS).map(([value, label]) => ({ label, value, default: cfg.mode === value })))
  );

  const row3 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('select_roles').setPlaceholder('🎖️ เลือกยศที่ให้บอทตอบ (เว้นว่าง = ทุกคน)')
      .setMinValues(0).setMaxValues(5)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_channels').setPlaceholder('📌 เลือกห้องที่ให้บอทตอบ (เว้นว่าง = ทุกห้อง)')
      .setChannelTypes(0, 5).setMinValues(0).setMaxValues(5)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4] };
}

// ==========================================
// ✉️ 9. คำสั่งทั้งหมด + ระบบตอบแชทอัตโนมัติ
// ==========================================
const HELP_TEXT =
  '**📖 คำสั่งทั้งหมด (เฉพาะเจ้าของบอท ยกเว้น `!help`)**\n' +
  '`!panel` — เปิดแผงควบคุม ปรับทุกอย่างแบบเรียลไทม์\n' +
  '`!avatar` — สุ่มเปลี่ยนรูปโปรไฟล์ทันที\n' +
  '`!autoavatar on [นาที] | off` — เปิด/ปิดสุ่มรูปอัตโนมัติตามรอบเวลา\n' +
  '`!setprompt <ข้อความ>` — ตั้ง Prompt นิสัยบอทเอง\n' +
  '`!clearprompt` — ล้าง Prompt ที่ตั้งเอง กลับไปใช้โหมดสำเร็จรูป\n' +
  '`!cooldown <วินาที>` — ตั้งเวลากันสแปมต่อคน\n' +
  '`!setstatus <ข้อความ>` — เปลี่ยนสถานะใต้ชื่อบอท\n' +
  '`!blacklist add|remove @user` — ห้าม/อนุญาตให้บอทตอบคนนี้\n' +
  '`!status` — ดูค่าคอนฟิกปัจจุบันทั้งหมด\n' +
  '`!help` — ดูคำสั่งทั้งหมด (ใช้ได้ทุกคน)';

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const isOwner = message.author.id === OWNER_ID;

  // -- ระบบคำสั่ง (Commands) --
  if (message.content === '!help') return message.reply(HELP_TEXT);
  if (!isOwner && message.content.startsWith('!')) return;

  if (message.content === '!avatar') {
    const msg = await message.reply('⏳ กำลังไล่หา API รูปภาพฟรีมาเปลี่ยนให้อัตโนมัติ...');
    const r = await changeAvatarFromApi();
    return msg.edit(r.success ? `✅ เปลี่ยนโปรไฟล์สำเร็จ! (แหล่งรูป: ${r.source})` : '❌ ทุก API ที่มีตอบกลับไม่สำเร็จ ลองใหม่อีกครั้งสักครู่นะ');
  }

  if (message.content.startsWith('!autoavatar')) {
    const args = message.content.split(' ').slice(1);
    if (args[0] === 'on') {
      cfg.avatarAutoRotate = true;
      if (args[1] && !isNaN(Number(args[1]))) cfg.avatarRotateMinutes = Math.max(5, Number(args[1]));
      saveConfig(); startAvatarAutoRotate();
      return message.reply(`✅ เปิดสุ่มรูปอัตโนมัติทุก ${cfg.avatarRotateMinutes} นาที`);
    } else if (args[0] === 'off') {
      cfg.avatarAutoRotate = false; saveConfig(); startAvatarAutoRotate();
      return message.reply('✅ ปิดสุ่มรูปอัตโนมัติแล้ว');
    }
    return message.reply('ใช้แบบนี้: `!autoavatar on [นาที]` หรือ `!autoavatar off`');
  }

  if (message.content.startsWith('!setprompt ')) {
    cfg.customPrompt = message.content.slice('!setprompt '.length).trim();
    saveConfig();
    return message.reply('✅ ตั้ง Prompt นิสัยบอทใหม่เรียบร้อย!');
  }

  if (message.content === '!clearprompt') {
    cfg.customPrompt = ''; saveConfig();
    return message.reply('✅ ล้าง Prompt ที่ตั้งเองแล้ว กลับไปใช้โหมดสำเร็จรูป');
  }

  if (message.content.startsWith('!cooldown ')) {
    const sec = Number(message.content.split(' ')[1]);
    if (isNaN(sec) || sec < 0) return message.reply('ใส่ตัวเลขวินาทีให้ถูกต้อง เช่น `!cooldown 5`');
    cfg.cooldownSeconds = sec; saveConfig();
    return message.reply(`✅ ตั้งเวลากันสแปมเป็น ${sec} วินาที/คน`);
  }

  if (message.content.startsWith('!setstatus ')) {
    cfg.statusText = message.content.slice('!setstatus '.length).trim();
    saveConfig();
    client.user.setActivity(cfg.statusText, { type: ActivityType.Playing });
    return message.reply('✅ เปลี่ยนสถานะบอทแล้ว');
  }

  if (message.content.startsWith('!blacklist')) {
    const args = message.content.split(' ').slice(1);
    const targetId = message.mentions.users.first()?.id || args[1];
    if (args[0] === 'add' && targetId) {
      if (!cfg.blacklistUserIds.includes(targetId)) cfg.blacklistUserIds.push(targetId);
      saveConfig();
      return message.reply(`✅ เพิ่ม <@${targetId}> เข้าบัญชีดำแล้ว (บอทจะไม่ตอบคนนี้)`);
    } else if (args[0] === 'remove' && targetId) {
      cfg.blacklistUserIds = cfg.blacklistUserIds.filter((id) => id !== targetId);
      saveConfig();
      return message.reply(`✅ เอา <@${targetId}> ออกจากบัญชีดำแล้ว`);
    }
    return message.reply('ใช้แบบนี้: `!blacklist add @user` หรือ `!blacklist remove @user`');
  }

  if (message.content === '!status') {
    return message.reply(
      `**⚙️ ค่าคอนฟิกปัจจุบัน**\n` +
      `สถานะ: ${cfg.isActive ? '🟢 เปิด' : '🔴 ปิด'}\n` +
      `โหมด: ${MODE_LABELS[cfg.mode]}\n` +
      `Prompt กำหนดเอง: ${cfg.customPrompt ? cfg.customPrompt : '(ไม่ได้ตั้ง)'}\n` +
      `ห้องที่ตอบ: ${fmtChannels(cfg.targetChannelIds)}\n` +
      `ยศที่ตอบ: ${fmtRoles(cfg.targetRoleIds)}\n` +
      `กันสแปม: ${cfg.cooldownSeconds} วินาที\n` +
      `บัญชีดำ: ${cfg.blacklistUserIds.length} คน\n` +
      `สุ่มรูปอัตโนมัติ: ${cfg.avatarAutoRotate ? `เปิด (ทุก ${cfg.avatarRotateMinutes} นาที)` : 'ปิด'}`
    );
  }

  if (message.content === '!panel') {
    try {
      const payload = buildPanelPayload();
      return await message.reply(payload);
    } catch (err) {
      console.error('❌ สร้าง Panel ไม่สำเร็จ:', err.message);
      return message.reply('เกิดข้อผิดพลาดในการสร้างแผงควบคุม');
    }
  }

  // -- ระบบตอบแชทอัตโนมัติ (AI Auto Reply) --
  if (!cfg.isActive) return;
  if (message.content.startsWith('!')) return;
  
  if (cfg.blacklistUserIds.includes(message.author.id)) return;
  
  if (cfg.targetChannelIds.length && !cfg.targetChannelIds.includes(message.channel.id)) return;
  
  if (cfg.targetRoleIds.length) {
    const hasRole = message.member?.roles.cache.some((r) => cfg.targetRoleIds.includes(r.id));
    if (!hasRole) return;
  }
  
  if (isOnCooldown(message.author.id)) return message.react('⏳').catch(() => {});

  await message.channel.sendTyping();
  const aiText = await getAiResponse(message.content);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`del_${message.author.id}`).setLabel('🗑️ ลบข้อความนี้').setStyle(ButtonStyle.Secondary)
  );

  try {
    await message.reply({ content: aiText, components: [row] });
  } catch (error) {
    console.error('❌ ส่งข้อความตอบกลับไม่สำเร็จ:', error.message);
  }
});

// ==========================================
// 🕹️ 10. ระบบปุ่มกด / เมนู / โมดัล ในแผงควบคุม
// ==========================================
client.on('interactionCreate', async (interaction) => {
  // 1. ปุ่มลบข้อความ (คนที่ให้บอทตอบเท่านั้นถึงลบได้)
  if (interaction.isButton() && interaction.customId.startsWith('del_')) {
    const ownerId = interaction.customId.split('_')[1];
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: '❌ คุณไม่ได้เป็นคนถาม จะมาเนียนลบไม่ได้!', flags: 64 });
    }
    await interaction.deferUpdate().catch(() => {});
    return interaction.message.delete().catch(() => {});
  }

  // ป้องกันคนอื่นที่ไม่ใช่แอดมิน (Owner) มากดแผงควบคุม
  const panelCustomIds = ['btn_toggle', 'btn_refresh', 'btn_avatar', 'btn_set_prompt', 'btn_clear_prompt', 'select_mode', 'select_roles', 'select_channels', 'modal_set_prompt'];
  if (!interaction.customId || !panelCustomIds.includes(interaction.customId)) return;

  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '❌ คุณไม่ใช่เจ้านายผม กดไม่ได้หรอกนะ!', flags: 64 });
  }

  // 2. ถ้ากดปุ่มตั้ง Prompt ให้เปิดหน้าต่าง Modal
  if (interaction.isButton() && interaction.customId === 'btn_set_prompt') {
    const modal = new ModalBuilder().setCustomId('modal_set_prompt').setTitle('ตั้ง Prompt นิสัยบอทเอง');
    const input = new TextInputBuilder().setCustomId('prompt_input').setLabel('อยากให้บอทมีนิสัย/บทบาทแบบไหน').setStyle(TextInputStyle.Paragraph).setValue(cfg.customPrompt || '').setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // 3. จัดการปุ่มกด/เมนูในแผงควบคุมทั้งหมด
  try {
    if (interaction.isButton() && interaction.customId === 'btn_toggle') {
      cfg.isActive = !cfg.isActive;
    } else if (interaction.isButton() && interaction.customId === 'btn_avatar') {
      changeAvatarFromApi().then((r) => {
        interaction.followUp({ content: r.success ? `✅ เปลี่ยนรูปโปรไฟล์แล้ว (แหล่ง: ${r.source})` : '❌ เปลี่ยนรูปไม่สำเร็จ', flags: 64 }).catch(() => {});
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

    // โหลด UI ใหม่ แล้วอัปเดตข้อความเดิม
    const newPayload = buildPanelPayload();
    if (interaction.isModalSubmit()) {
      await interaction.deferUpdate().catch(() => {});
      await interaction.message.edit(newPayload).catch(console.error);
    } else {
      await interaction.update(newPayload).catch(console.error);
    }
  } catch (err) {
    console.error('❌ อัปเดตแผงควบคุมไม่สำเร็จ:', err?.message || err);
  }
});

client.login(TOKEN);
  

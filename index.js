const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, EmbedBuilder, ChannelType,
  PermissionFlagsBits, SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
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
  calculateLevel, 
  makeProgressBar, 
  parseRoleRewards,
  parseWordList,
  getGiveaways, 
  saveGiveaways, 
  parseDuration, 
  giveawayCache,
  getProphecies, 
  saveProphecies, 
  propheciesCache,
  MODE_LABELS,
} = storage;

const {
  getAiResponse, generateImage, IMAGE_GEN_COOLDOWN_SECONDS,
  runCouncilDebate, runCouncilVerdict,
  generateProphecyText, generateProphecyEpilogue,
  estimateTokens, estimateMessagesTokens,
} = ai;

const {
  buildMainPanel, buildAdvancedPanel, buildAccessPanel, buildLevelingPanel, buildWelcomePanel, buildStatsPanel,
  buildAiReplyPayload, buildHelpEmbed, buildImagineEmbed, buildGiveawayEmbed, buildProphecyEmbed,
  buildAdminHubPanel, buildModerationPanel, buildAutomodPanel, buildTicketPanel, buildAntiraidPanel, buildCommunityAdminPanel,
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
// 🛡️ ระบบดูแลเซิร์ฟเวอร์ (Moderation): ตรวจสิทธิ์ + กันดำเนินการผิดคน
// ==========================================
// อนุญาตถ้าเป็นเจ้าของบอท/แอดมิน (ตาม checkHasPermission เดิม) หรือมีสิทธิ์ Discord ที่ต้องใช้จริงๆ สำหรับคำสั่งนั้น
function checkModPermission(interaction, permFlag) {
  if (checkHasPermission(interaction.user.id, interaction.member, interaction.guildId)) return true;
  try {
    return Boolean(interaction.member?.permissions?.has(permFlag));
  } catch (e) {
    return false;
  }
}

// เช็คว่าดำเนินการ (เตะ/แบน/timeout/เตือน) กับ target ได้จริงไหม กันพลาดเจ้าของเซิร์ฟ/ตัวเอง/บอท/ยศสูงกว่า
async function canModerateTarget(interaction, targetMember) {
  if (!targetMember) return { ok: true }; // ผู้ใช้ไม่ได้อยู่ในเซิร์ฟแล้ว (เช่นใช้กับ unban) ปล่อยผ่านให้ Discord API เช็คเอง
  if (targetMember.id === interaction.user.id) return { ok: false, reason: '❌ ใช้คำสั่งนี้กับตัวเองไม่ได้' };
  if (targetMember.id === client.user.id) return { ok: false, reason: '❌ ใช้คำสั่งนี้กับบอทเองไม่ได้' };
  if (targetMember.id === interaction.guild.ownerId) return { ok: false, reason: '❌ ดำเนินการกับเจ้าของเซิร์ฟเวอร์ไม่ได้' };

  if (interaction.user.id !== interaction.guild.ownerId) {
    const executorTop = interaction.member.roles.highest.position;
    const targetTop = targetMember.roles.highest.position;
    if (targetTop >= executorTop) {
      return { ok: false, reason: '❌ ดำเนินการกับผู้ใช้ที่มียศเท่ากับหรือสูงกว่าคุณไม่ได้' };
    }
  }

  const botMember = interaction.guild.members.me;
  if (botMember && targetMember.roles.highest.position >= botMember.roles.highest.position) {
    return { ok: false, reason: '❌ บอทมียศต่ำกว่าหรือเท่ากับผู้ใช้นี้ ต้องปรับตำแหน่งยศของบอทให้สูงกว่าก่อน' };
  }
  return { ok: true };
}

// ==========================================
// 🛡️ ฟังก์ชันดำเนินการ Moderation จริง (ใช้ร่วมกันทั้งจาก Slash Command และเมนูคลิกขวา/Context Menu)
// interaction ในที่นี้อาจเป็น ChatInputCommandInteraction, UserContextMenuCommandInteraction, หรือ ModalSubmitInteraction ก็ได้
// เพราะทั้งสามแบบมี .guild, .user, .reply() ให้ใช้งานเหมือนกัน
// ==========================================
async function doKickAction(interaction, cfg, targetUserId, reason) {
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  if (!targetMember) {
    return interaction.reply({ content: '❌ ไม่พบผู้ใช้นี้ในเซิร์ฟเวอร์ (อาจออกไปแล้ว)', ephemeral: true }).catch(() => {});
  }
  const check = await canModerateTarget(interaction, targetMember);
  if (!check.ok) {
    return interaction.reply({ content: check.reason, ephemeral: true }).catch(() => {});
  }
  if (!targetMember.kickable) {
    return interaction.reply({ content: '❌ บอทไม่มีสิทธิ์เตะผู้ใช้นี้ (ตรวจสอบยศบอท)', ephemeral: true }).catch(() => {});
  }
  await targetMember.send(`คุณถูกเตะออกจากเซิร์ฟเวอร์ **${interaction.guild.name}**\nเหตุผล: ${reason}`).catch(() => {});
  await targetMember.kick(reason).catch((e) => console.error('❌ kick ล้มเหลว:', e.message));
  bumpActivity(interaction.guild.id, 'kicks');
  const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('👢 เตะสมาชิก')
    .addFields(
      { name: 'ผู้ถูกเตะ', value: `${targetMember.user.tag} (${targetMember.id})`, inline: true },
      { name: 'ผู้ดำเนินการ', value: `${interaction.user.tag}`, inline: true },
      { name: 'เหตุผล', value: reason },
    ).setTimestamp();
  await interaction.reply({ embeds: [embed] }).catch(() => {});
  sendGuildLog(interaction.guild, cfg, { embeds: [embed] });
  maybeGenerateLaw(interaction.guild, cfg, 'การเตะสมาชิกออกจากเซิร์ฟเวอร์').catch(() => {});
}

async function doBanAction(interaction, cfg, targetUserId, reason, deleteDays = 0) {
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  const check = await canModerateTarget(interaction, targetMember);
  if (!check.ok) {
    return interaction.reply({ content: check.reason, ephemeral: true }).catch(() => {});
  }
  if (targetMember && !targetMember.bannable) {
    return interaction.reply({ content: '❌ บอทไม่มีสิทธิ์แบนผู้ใช้นี้ (ตรวจสอบยศบอท)', ephemeral: true }).catch(() => {});
  }
  const targetUser = targetMember ? targetMember.user : await client.users.fetch(targetUserId).catch(() => null);
  if (!targetUser) {
    return interaction.reply({ content: '❌ ไม่พบผู้ใช้นี้', ephemeral: true }).catch(() => {});
  }
  if (targetMember) await targetMember.send(`คุณถูกแบนจากเซิร์ฟเวอร์ **${interaction.guild.name}**\nเหตุผล: ${reason}`).catch(() => {});
  try {
    await interaction.guild.members.ban(targetUserId, { reason, deleteMessageSeconds: deleteDays * 86400 });
    bumpActivity(interaction.guild.id, 'bans');
  } catch (e) {
    return interaction.reply({ content: '❌ แบนไม่สำเร็จ ลองใหม่อีกครั้ง', ephemeral: true }).catch(() => {});
  }
  const embed = new EmbedBuilder().setColor(0xE74C3C).setTitle('🔨 แบนสมาชิก')
    .addFields(
      { name: 'ผู้ถูกแบน', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
      { name: 'ผู้ดำเนินการ', value: `${interaction.user.tag}`, inline: true },
      { name: 'เหตุผล', value: reason },
    ).setTimestamp();
  await interaction.reply({ embeds: [embed] }).catch(() => {});
  sendGuildLog(interaction.guild, cfg, { embeds: [embed] });
  maybeGenerateLaw(interaction.guild, cfg, 'การแบนสมาชิกออกจากเซิร์ฟเวอร์อย่างถาวร').catch(() => {});
}

async function doTimeoutAction(interaction, cfg, targetUserId, durationMs, durationLabel, reason) {
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  if (!targetMember) {
    return interaction.reply({ content: '❌ ไม่พบผู้ใช้นี้ในเซิร์ฟเวอร์', ephemeral: true }).catch(() => {});
  }
  const check = await canModerateTarget(interaction, targetMember);
  if (!check.ok) {
    return interaction.reply({ content: check.reason, ephemeral: true }).catch(() => {});
  }
  if (!targetMember.moderatable) {
    return interaction.reply({ content: '❌ บอทไม่มีสิทธิ์ Timeout ผู้ใช้นี้ (ตรวจสอบยศบอท)', ephemeral: true }).catch(() => {});
  }
  await targetMember.timeout(durationMs, reason).catch((e) => console.error('❌ timeout ล้มเหลว:', e.message));
  bumpActivity(interaction.guild.id, 'timeouts');
  const embed = new EmbedBuilder().setColor(0xF39C12).setTitle('🔇 Timeout สมาชิก')
    .addFields(
      { name: 'ผู้ถูก Timeout', value: `${targetMember.user.tag} (${targetMember.id})`, inline: true },
      { name: 'ระยะเวลา', value: durationLabel, inline: true },
      { name: 'ผู้ดำเนินการ', value: `${interaction.user.tag}`, inline: true },
      { name: 'เหตุผล', value: reason },
    ).setTimestamp();
  await interaction.reply({ embeds: [embed] }).catch(() => {});
  sendGuildLog(interaction.guild, cfg, { embeds: [embed] });
  maybeGenerateLaw(interaction.guild, cfg, 'การปิดปากชั่วคราว (timeout) สมาชิก').catch(() => {});
}

async function doWarnAction(interaction, cfg, targetUserId, reason) {
  if (targetUserId === interaction.user.id) {
    return interaction.reply({ content: '❌ เตือนตัวเองไม่ได้', ephemeral: true }).catch(() => {});
  }
  await storage.addWarning(interaction.guild.id, targetUserId, interaction.user.id, reason);
  bumpActivity(interaction.guild.id, 'warnings');
  const count = await storage.countWarnings(interaction.guild.id, targetUserId);
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  const targetUser = targetMember ? targetMember.user : await client.users.fetch(targetUserId).catch(() => null);
  if (targetMember) {
    await targetMember.send(`คุณได้รับการเตือนในเซิร์ฟเวอร์ **${interaction.guild.name}**\nเหตุผล: ${reason}\nจำนวนครั้งที่ถูกเตือนทั้งหมด: ${count}`).catch(() => {});
  }
  const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('⚠️ เตือนสมาชิก')
    .addFields(
      { name: 'ผู้ถูกเตือน', value: targetUser ? `${targetUser.tag} (${targetUser.id})` : targetUserId, inline: true },
      { name: 'ผู้ดำเนินการ', value: `${interaction.user.tag}`, inline: true },
      { name: 'จำนวนครั้งสะสม', value: `${count}`, inline: true },
      { name: 'เหตุผล', value: reason },
    ).setTimestamp();
  await interaction.reply({ embeds: [embed] }).catch(() => {});
  sendGuildLog(interaction.guild, cfg, { embeds: [embed] });
  maybeGenerateLaw(interaction.guild, cfg, 'การเตือนสมาชิกด้วยวาจา').catch(() => {});
}

async function doWarningsView(interaction, targetUserId) {
  const list = await storage.getWarnings(interaction.guild.id, targetUserId);
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  const targetUser = targetMember ? targetMember.user : await client.users.fetch(targetUserId).catch(() => null);
  const label = targetUser ? targetUser.tag : targetUserId;
  if (!list.length) {
    return interaction.reply({ content: `✅ ${label} ไม่มีประวัติการเตือนเลย`, ephemeral: true }).catch(() => {});
  }
  const lines = list.slice(-15).map((w, i) => `**${i + 1}.** ${w.reason} — โดย <@${w.moderatorId}> (<t:${Math.floor(w.createdAt / 1000)}:R>)`).join('\n');
  const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle(`⚠️ ประวัติการเตือนของ ${label}`)
    .setDescription(lines).setFooter({ text: `รวมทั้งหมด ${list.length} ครั้ง` });
  return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
}

// ==========================================
// 🎫 ปิด Ticket — ใช้ร่วมกันทั้งจากปุ่ม 🔒 ในช่อง Ticket และคำสั่ง /server ticket close
// อนุญาตให้ปิดได้ 3 กลุ่ม: เจ้าของ Ticket เอง, ยศทีมงานที่ตั้งค่าไว้, หรือใครก็ตามที่มีสิทธิ์ Manage Channels
// ==========================================
async function closeTicketChannel(interaction, cfg, channelId) {
  const guildId = interaction.guild.id;
  const ticketDoc = await storage.getTicketByChannel(guildId, channelId);
  const isOwner = ticketDoc && ticketDoc.userId === interaction.user.id;
  const isStaff = cfg.ticketStaffRoleId && interaction.member.roles.cache.has(cfg.ticketStaffRoleId);
  const isManager = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
  if (!isOwner && !isStaff && !isManager) {
    return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ปิด Ticket นี้', ephemeral: true }).catch(() => {});
  }
  await interaction.reply({ content: '🔒 กำลังปิด Ticket นี้ใน 5 วินาที...' }).catch(() => {});
  await storage.closeTicketRecord(guildId, channelId);
  sendGuildLog(interaction.guild, cfg, `🔒 ปิด Ticket: ${interaction.channel.name} (ดำเนินการโดย ${interaction.user.tag})`);
  const channelToDelete = interaction.channel;
  setTimeout(() => { channelToDelete.delete().catch(() => {}); }, 5000);
}

// ==========================================
// 📦 หมายเหตุ: ระบบ Config (Global/Guild), ข้อมูลเลเวล, Giveaway, คำทำนาย, และตรรกะเรียก AI ทั้งหมด
// ถูกย้ายไปอยู่ใน lib/storage.js และ lib/ai.js แล้ว (ดูรายละเอียดที่ต้นไฟล์นั้นๆ)
// ไฟล์นี้ (index.js) เหลือแค่ส่วนที่ต้อง "เชื่อมกับ Discord จริง" เท่านั้น
// ==========================================

// ==========================================
// 🎨 4.5 ระบบสร้างภาพด้วย AI (ฟรี 100% ไม่ต้องมี API Key ใช้ Pollinations Image API)
// ==========================================
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

// คูลดาวน์การยื่นฟ้องของระบบศาลเซิร์ฟเวอร์ (กันสแปมฟ้องรัวๆ ใส่คนเดิม)
const COURT_COOLDOWN_SECONDS = 10 * 60;
const courtCooldownMap = new Map();
function isOnCourtCooldown(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const last = courtCooldownMap.get(key) || 0;
  const now = Date.now();
  if (now - last < COURT_COOLDOWN_SECONDS * 1000) return true;
  courtCooldownMap.set(key, now);
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

  // ตัดความจำเก่าออกทั้งจากจำนวนข้อความ (soft cap ตามที่ตั้งไว้) และจำนวนโทเคนจริง (hard cap)
  // กันส่ง context ยาวเกินไปจนโดน provider ปฏิเสธ หรือกินโควต้าโทเคนเกินจำเป็น
  const maxMessages = Math.max(2, (cfg.memoryTurns || 6) * 2);
  while (entry.messages.length > maxMessages) entry.messages.shift();
  const maxTokens = cfg.memoryMaxTokens || 3000;
  while (entry.messages.length > 2 && estimateMessagesTokens(entry.messages) > maxTokens) {
    entry.messages.shift();
    entry.messages.shift(); // ตัดทีละคู่ (user+assistant) กันบทสนทนาขาดครึ่งๆ กลางๆ
  }

  entry.lastActive = Date.now();
  conversationMemory.set(key, entry);
}

// ==========================================
// 📊 6.5 ระบบนับ + จำกัดโทเคน AI จริงต่อวัน (แยกตามเซิร์ฟเวอร์) — ใช้ตัวเลขประมาณการจาก estimateTokens/estimateMessagesTokens
// ==========================================
const tokenUsageTracker = new Map(); // guildId -> { tokensUsed, resetAt }

function getTokenUsage(guildId) {
  let usage = tokenUsageTracker.get(guildId);
  const now = Date.now();
  if (!usage || now >= usage.resetAt) {
    usage = { tokensUsed: 0, resetAt: now + 24 * 60 * 60 * 1000 };
    tokenUsageTracker.set(guildId, usage);
  }
  return usage;
}

// เช็คว่าเกินโควต้าโทเคนวันนี้หรือยัง คืนข้อความแจ้งเตือนถ้าเกิน (null ถ้ายังไม่เกิน/ไม่ได้ตั้งโควต้าไว้)
function checkTokenBudget(guildId, cfg) {
  if (!cfg.dailyTokenLimit || cfg.dailyTokenLimit <= 0) return null;
  const usage = getTokenUsage(guildId);
  if (usage.tokensUsed >= cfg.dailyTokenLimit) {
    const hoursLeft = Math.max(1, Math.ceil((usage.resetAt - Date.now()) / (60 * 60 * 1000)));
    return `📊 วันนี้ใช้โควต้า AI ครบ ${cfg.dailyTokenLimit.toLocaleString()} โทเคนแล้ว จะรีเซ็ตในอีกประมาณ ${hoursLeft} ชม.`;
  }
  return null;
}

// บันทึกจำนวนโทเคนที่ใช้ไปจริงในการเรียก AI ครั้งนี้ (history ที่ส่งไป + คำถาม + คำตอบ) ลงตัวนับของวันนี้
function recordTokenUsage(guildId, history, userText, aiText) {
  const tokens = estimateMessagesTokens(history) + estimateTokens(userText) + estimateTokens(aiText);
  const usage = getTokenUsage(guildId);
  usage.tokensUsed += tokens;
  return tokens;
}

// ==========================================
// 🧠 6.6 ระบบจำ "ความสัมพันธ์" กับผู้ใช้แต่ละคน (Per-user Relationship Memory)
// ทุกๆ 2-3 รอบสนทนา ให้ AI สรุปนิสัย/ความสนใจ/อารมณ์ที่มีต่อบอทของผู้ใช้คนนั้นเก็บไว้ แล้วดึงกลับมาใช้
// เป็นบริบทให้บอท "จำได้" ว่าเคยคุยกับใครมาแบบไหน โดยไม่ต้องเรียก AI วิเคราะห์ทุกข้อความ (แพงเกินไป)
// ==========================================
const RELATIONSHIP_UPDATE_INTERVAL = 4; // อัปเดตโน้ตความสัมพันธ์ทุกๆ 4 รอบสนทนา กันเรียก AI บ่อยเกินไป

// เติมโน้ตความสัมพันธ์เข้าไปใน system prompt ของ cfg ชุดที่จะใช้เรียก AI รอบนี้ (ไม่แก้ cfg เดิม สร้างสำเนาใหม่)
function buildCfgWithRelationship(cfg, relationshipNote) {
  if (!relationshipNote) return cfg;
  const basePrompt = storage.getSystemPrompt(cfg); // มีคำสั่งภาษา/โหมดที่ตั้งไว้รวมอยู่แล้ว
  return {
    ...cfg,
    customPrompt: `${basePrompt}\n\n[ความทรงจำเกี่ยวกับผู้ใช้คนนี้จากบทสนทนาก่อนหน้า]: ${relationshipNote}\n(ใช้ข้อมูลนี้อย่างเป็นธรรมชาติเมื่อเกี่ยวข้องเท่านั้น ไม่ต้องพูดถึงตรงๆ ว่าเป็นข้อมูลที่ระบบจำไว้)`,
    replyLanguage: 'th', // กันเติมคำสั่งภาษาอังกฤษซ้ำอีกรอบ เพราะรวมไว้ใน basePrompt ข้างบนแล้ว (ถ้าตั้ง en ไว้ basePrompt ก็มีคำสั่งนั้นอยู่แล้ว)
  };
}

// เรียกหลังตอบเสร็จแล้วแบบ fire-and-forget ไม่บล็อกการตอบผู้ใช้ — อัปเดตโน้ตความสัมพันธ์เป็นระยะๆ ไม่ใช่ทุกข้อความ
async function maybeUpdateRelationship(guildId, userId, cfg) {
  if (!cfg.memoryEnabled) return; // ปิดความจำบทสนทนาไว้ ก็ไม่เก็บความสัมพันธ์เช่นกัน (สอดคล้องกับสวิตช์ privacy เดิม)
  const existing = await storage.getUserMemory(guildId, userId);
  const newCount = (existing?.interactionCount || 0) + 1;

  if (newCount % RELATIONSHIP_UPDATE_INTERVAL !== 0) {
    await storage.bumpUserMemoryCount(guildId, userId, newCount); // ขยับตัวนับเฉยๆ ยังไม่ถึงรอบเรียก AI
    return;
  }

  const recentMessages = getConversationHistory(guildId, userId, cfg).slice(-12);
  if (!recentMessages.length) return;
  try {
    const update = await ai.generateRelationshipUpdate(cfg, existing?.note || '', recentMessages);
    await storage.upsertUserMemory(guildId, userId, update.note, update.sentiment, newCount);
  } catch (e) {
    console.error(`❌ อัปเดตความสัมพันธ์กับผู้ใช้ ${userId} ล้มเหลว:`, e.message);
  }
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
  // ==========================================
  // 🎛️ /แผงแอดมิน — จุดเข้าเดียวสำหรับทุกฟีเจอร์ฝั่งแอดมิน/ดูแลเซิร์ฟเวอร์ (แทนที่ /bot /server /community เดิม)
  // ไม่มี option เลย เพราะทุกอย่างทำผ่านปุ่ม/เมนู/Modal ในแผงแทน — ดูรายละเอียดการเช็คสิทธิ์แต่ละหมวดได้ใน handleAdminPanelCommand()
  // ==========================================
  new SlashCommandBuilder()
    .setName('แผงแอดมิน')
    .setDescription('🎛️ เปิดแผงควบคุมแอดมิน (AI / เซิร์ฟเวอร์ / Automod / Ticket / Anti-Raid / ชุมชน / เลเวล ฯลฯ)'),

  // ==========================================
  // 🧑‍🤝‍🧑 /เมนู — จุดเข้าเดียวสำหรับทุกฟีเจอร์ฝั่งผู้เล่น (แทนที่ /ai /community level ฯลฯ เดิม) — ใช้ได้ทุกคน ไม่ต้องมีสิทธิ์พิเศษ
  // ==========================================
  new SlashCommandBuilder()
    .setName('เมนู')
    .setDescription('🧑‍🤝‍🧑 เปิดแผงเมนูของคุณ (ถาม AI / สร้างภาพ / เลเวล / ความฝัน / ธรรมนูญ / ของวิเศษ / ศาล ฯลฯ)'),
].map((cmd) => cmd.toJSON());

// ==========================================
// 🖱️ 10.5 Context Menu Commands (คลิกขวาที่ชื่อสมาชิก -> Apps) — ทำ mod action ได้โดยไม่ต้องพิมพ์คำสั่งเลย
// ==========================================
const contextMenuCommandDefs = [
  new ContextMenuCommandBuilder().setName('เตะสมาชิก').setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder().setName('แบนสมาชิก').setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder().setName('Timeout 10 นาที').setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder().setName('Timeout 1 ชั่วโมง').setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder().setName('เตือนสมาชิก').setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder().setName('ดูประวัติเตือน').setType(ApplicationCommandType.User),
].map((cmd) => cmd.toJSON());

async function registerSlashCommandsForGuild(guild) {
  try {
    await guild.commands.set([...slashCommandDefs, ...contextMenuCommandDefs]);
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
    // 🧹 ล้าง Global Commands ทั้งหมดทิ้ง (ครั้งเดียวตอนสตาร์ท) — ป้องกันปัญหาคำสั่งซ้ำ/คำสั่งผีค้างอยู่ในเมนู
    // สาเหตุเดิม: บอทเคยลงทะเบียนคำสั่งแบบ Global ควบคู่กับแบบเฉพาะเซิร์ฟเวอร์ ถ้าคำสั่งใดคำสั่งหนึ่งมีปัญหาตอนอัปเดต Global
    // จะทำให้รายการ Global เก่าค้างอยู่ (เช่น /8ball ที่ไม่มีในโค้ดแล้ว) และไปซ้อนทับกับคำสั่งเฉพาะเซิร์ฟเวอร์จนเห็นเป็นคำสั่งซ้ำ
    // ตอนนี้บอทลงทะเบียนคำสั่งแบบเฉพาะเซิร์ฟเวอร์เท่านั้น (ครอบคลุมทั้งเซิร์ฟเวอร์เดิมและเซิร์ฟเวอร์ใหม่อยู่แล้ว ดูด้านล่าง) จึงไม่จำเป็นต้องใช้ Global เลย
    await client.application.commands.set([]);
    console.log('🧹 ล้าง Global Slash Commands เก่าทิ้งเรียบร้อย (กันคำสั่งซ้ำ/คำสั่งผีค้างเมนู)');
  } catch (e) {
    console.error('⚠️ ล้าง Global Slash Commands ล้มเหลว:', e.message);
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
          `พิมพ์ \`${PANEL_COMMAND}\` หรือใช้คำสั่ง \`/แผงแอดมิน\` เพื่อเปิดแผงควบคุมและตั้งค่าบอท (สำหรับแอดมิน/ผู้ดูแลเซิร์ฟเวอร์เท่านั้น)\n` +
          `หรือใช้คำสั่ง \`/เมนู\` เพื่อเปิดเมนูของสมาชิกทั่วไป (ถาม AI, เลเวล, ของวิเศษ, ศาล ฯลฯ)`,
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

    // Anti-Raid ทำงานก่อนเสมอ ถ้าสมาชิกถูกเตะไปแล้วเพราะเข้าข่าย raid ให้หยุดทันที ไม่ต้องให้ auto-role/welcome ต่อ
    const kicked = await checkAntiRaid(member, cfg).catch(() => false);
    bumpActivity(member.guild.id, 'membersJoined');
    if (kicked) return;

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
  if (winners.length) bumpActivity(guildId, 'giveawaysWon', winners.length);

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
// ==========================================
// 📖 13.3 ตัวเก็บ "วัตถุดิบ" เหตุการณ์ประจำวัน (ใช้เป็นแรงบันดาลใจให้ระบบความฝันของบอทด้านล่าง)
// เก็บใน memory เท่านั้น ไม่ต้องคงอยู่ข้ามการรีสตาร์ท เพราะรีเซ็ตทุกครั้งที่ฝันใหม่อยู่แล้ว
// ==========================================
const dailyActivity = new Map(); // guildId -> { kicks, bans, timeouts, warnings, automodDeletes, ticketsOpened, giveawaysWon, raidDetected, membersJoined }
function bumpActivity(guildId, field, amount = 1) {
  if (!guildId) return;
  if (!dailyActivity.has(guildId)) {
    dailyActivity.set(guildId, {
      kicks: 0, bans: 0, timeouts: 0, warnings: 0, automodDeletes: 0,
      ticketsOpened: 0, giveawaysWon: 0, raidDetected: 0, membersJoined: 0,
    });
  }
  const a = dailyActivity.get(guildId);
  a[field] = (a[field] || 0) + amount;
}

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
// 🛡️ 13.4 ระบบ Auto-Moderation (กรองคำต้องห้าม/ลิงก์/สแปมเมนชันอัตโนมัติ)
// ==========================================
const INVITE_LINK_REGEX = /(discord\.gg|discord(?:app)?\.com\/invite)\/[a-zA-Z0-9-]+/i;
const GENERIC_LINK_REGEX = /https?:\/\/\S+/i;

// ตรวจข้อความและลงโทษถ้าผิดกฎ คืนค่า true ถ้ามีการดำเนินการ (ลบข้อความ) ไปแล้ว เพื่อให้ผู้เรียกหยุดประมวลผลต่อ
async function runAutomod(message, cfg) {
  if (!cfg.automodEnabled) return false;
  if (cfg.automodIgnoredChannelIds.includes(message.channel.id)) return false;
  if (message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return false; // มอดไม่โดนกรองตัวเอง

  const content = message.content || '';
  let violation = null;

  if (cfg.automodBlockInvites && INVITE_LINK_REGEX.test(content)) {
    violation = 'ส่งลิงก์เชิญ Discord';
  }
  if (!violation && cfg.automodBlockLinks && GENERIC_LINK_REGEX.test(content)) {
    violation = 'ส่งลิงก์ภายนอก';
  }
  if (!violation && cfg.automodMaxMentions > 0 && (message.mentions.users.size + message.mentions.roles.size) > cfg.automodMaxMentions) {
    violation = 'แท็กเมนชันจำนวนมากเกินไป (สแปม)';
  }
  if (!violation && cfg.automodBadWords) {
    const words = parseWordList(cfg.automodBadWords);
    const lower = content.toLowerCase();
    if (words.some((w) => w && lower.includes(w))) violation = 'ใช้คำต้องห้าม';
  }

  if (!violation) return false;

  await message.delete().catch(() => {});
  bumpActivity(message.guild.id, 'automodDeletes');

  if (cfg.automodAction === 'timeout' && message.member?.moderatable) {
    await message.member.timeout((cfg.automodTimeoutSeconds || 60) * 1000, `Automod: ${violation}`).catch(() => {});
  } else if (cfg.automodAction === 'warn') {
    await storage.addWarning(message.guild.id, message.author.id, client.user.id, `Automod: ${violation}`).catch(() => {});
  }

  message.author.send(`⚠️ ข้อความของคุณถูกลบในเซิร์ฟเวอร์ **${message.guild.name}** เนื่องจาก: ${violation}`).catch(() => {});

  const embed = new EmbedBuilder().setColor(0xE74C3C).setTitle('🛡️ Automod ลบข้อความอัตโนมัติ')
    .addFields(
      { name: 'ผู้ใช้', value: `${message.author.tag} (${message.author.id})`, inline: true },
      { name: 'สาเหตุ', value: violation, inline: true },
      { name: 'ห้อง', value: `<#${message.channel.id}>`, inline: true },
      { name: 'ข้อความเดิม', value: content.slice(0, 500) || '(ไม่มีข้อความ/เป็นไฟล์แนบ)' },
    ).setTimestamp();
  sendGuildLog(message.guild, cfg, { embeds: [embed] });
  maybeGenerateLaw(message.guild, cfg, 'ระบบกรองข้อความอัตโนมัติทำงาน').catch(() => {});

  return true;
}

// ==========================================
// 🚨 13.5 ระบบ Anti-Raid (ตรวจจับคนเข้าร่วมเซิร์ฟเวอร์ผิดปกติ กันบอทสแปม/การโจมตี Raid)
// เก็บ timestamp การเข้าร่วมไว้ใน memory เท่านั้น (ไม่ต้องคงอยู่ข้ามการรีสตาร์ท ก็เพียงพอสำหรับตรวจจับ burst สั้นๆ)
// ==========================================
const raidJoinTimestamps = new Map(); // guildId -> array ของเวลาที่คนเข้าร่วม (ms)
const raidAlertedGuilds = new Set(); // guildId ที่เพิ่งแจ้งเตือน raid ไปแล้ว (กันสแปมแจ้งเตือนซ้ำ)
const raidOriginalVerificationLevel = new Map(); // guildId -> ระดับ verification เดิมก่อนถูกยกระดับชั่วคราว

// ตรวจสอบว่าการเข้าร่วมครั้งนี้เข้าข่าย raid ไหม และดำเนินการตาม action ที่ตั้งไว้
// คืนค่า true ถ้าสมาชิกถูกเตะไปแล้ว (เพื่อให้ผู้เรียกข้ามการทำ auto-role/welcome message ต่อ)
async function checkAntiRaid(member, cfg) {
  if (!cfg.antiRaidEnabled) return false;
  const guildId = member.guild.id;
  const now = Date.now();
  const windowMs = (cfg.antiRaidWindowSeconds || 30) * 1000;

  let timestamps = (raidJoinTimestamps.get(guildId) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  raidJoinTimestamps.set(guildId, timestamps);

  const isRaid = timestamps.length >= (cfg.antiRaidJoinThreshold || 10);
  if (!isRaid) return false;

  // แจ้งเตือนครั้งแรกที่พบ raid เท่านั้น กันสแปม log รัวๆ ตอนคนเข้าร่วมต่อเนื่อง
  if (!raidAlertedGuilds.has(guildId)) {
    raidAlertedGuilds.add(guildId);
    setTimeout(() => raidAlertedGuilds.delete(guildId), windowMs);
    bumpActivity(guildId, 'raidDetected');
    const alertEmbed = new EmbedBuilder().setColor(0xE74C3C).setTitle('🚨 ตรวจพบความเสี่ยง Raid!')
      .setDescription(`มีสมาชิกเข้าร่วม **${timestamps.length} คน** ภายใน ${cfg.antiRaidWindowSeconds} วินาที (เกินเกณฑ์ที่ตั้งไว้)\nโหมดที่ตั้งไว้: **${{ alert: 'แจ้งเตือนอย่างเดียว', kick_new_accounts: 'เตะบัญชีใหม่อัตโนมัติ', raise_verification: 'ยกระดับ Verification ชั่วคราว' }[cfg.antiRaidAction] || cfg.antiRaidAction}**`)
      .setTimestamp();
    sendGuildLog(member.guild, cfg, { embeds: [alertEmbed] });
  }

  if (cfg.antiRaidAction === 'kick_new_accounts') {
    const accountAgeDays = (now - member.user.createdTimestamp) / 86400000;
    if (accountAgeDays < (cfg.antiRaidMinAccountAgeDays || 7)) {
      await member.kick('Anti-Raid: บัญชีใหม่เข้าร่วมช่วงตรวจพบ raid').catch(() => {});
      sendGuildLog(member.guild, cfg, `🚫 Anti-Raid เตะ ${member.user.tag} อัตโนมัติ (บัญชีอายุ ${accountAgeDays.toFixed(1)} วัน)`);
      return true;
    }
  }

  if (cfg.antiRaidAction === 'raise_verification' && !raidOriginalVerificationLevel.has(guildId)) {
    raidOriginalVerificationLevel.set(guildId, member.guild.verificationLevel);
    await member.guild.setVerificationLevel(3, 'Anti-Raid: ยกระดับชั่วคราวเนื่องจากตรวจพบความเสี่ยง raid').catch(() => {});
    sendGuildLog(member.guild, cfg, '🔒 ยกระดับ Verification Level ของเซิร์ฟเวอร์ชั่วคราว (High) เนื่องจากตรวจพบ raid — ใช้ `/server antiraid unlock` เพื่อปรับกลับด้วยตนเอง หรือระบบจะปรับกลับให้อัตโนมัติเมื่อไม่มีคนเข้าร่วมใหม่สัก 10 นาที');
    setTimeout(async () => {
      const stillTimestamps = (raidJoinTimestamps.get(guildId) || []).filter((t) => Date.now() - t < windowMs);
      if (stillTimestamps.length < (cfg.antiRaidJoinThreshold || 10) && raidOriginalVerificationLevel.has(guildId)) {
        const original = raidOriginalVerificationLevel.get(guildId);
        raidOriginalVerificationLevel.delete(guildId);
        await member.guild.setVerificationLevel(original, 'Anti-Raid: ปรับ Verification Level กลับเป็นค่าเดิมอัตโนมัติ').catch(() => {});
        sendGuildLog(member.guild, cfg, '🔓 ปรับ Verification Level กลับเป็นค่าเดิมอัตโนมัติแล้ว (ไม่มีคนเข้าร่วมใหม่ผิดปกติแล้ว)');
      }
    }, 10 * 60 * 1000);
  }

  return false;
}

// ==========================================
// 🌙 13.6 ระบบ "ความฝันของบอท" (Dream Journal)
// ทุกวันบอทจะนำเหตุการณ์ที่เกิดขึ้นในเซิร์ฟเวอร์ (เก็บสะสมไว้ใน dailyActivity ด้านบน) มาให้ AI แต่งเป็นความฝัน
// เชิงสัญลักษณ์แบบวรรณกรรม สร้างเป็นบันทึก/ตำนานเหนือจริงประจำเซิร์ฟเวอร์ที่ไม่ซ้ำใคร แล้วเก็บเป็นคลังให้ย้อนอ่านได้
// ==========================================
function buildDailyActivitySummary(guildId) {
  const a = dailyActivity.get(guildId);
  if (!a) return 'วันนี้เซิร์ฟเวอร์เงียบสงบ ไม่มีเหตุการณ์พิเศษอะไรเกิดขึ้นเลย';
  const parts = [];
  if (a.membersJoined) parts.push(`มีสมาชิกใหม่เข้าร่วม ${a.membersJoined} คน`);
  if (a.warnings) parts.push(`มีการเตือนสมาชิกทั้งหมด ${a.warnings} ครั้ง`);
  if (a.kicks) parts.push(`มีการเตะสมาชิกออกจากเซิร์ฟเวอร์ ${a.kicks} ครั้ง`);
  if (a.bans) parts.push(`มีการแบนสมาชิก ${a.bans} ครั้ง`);
  if (a.timeouts) parts.push(`มีการ Timeout (ปิดปากชั่วคราว) สมาชิก ${a.timeouts} ครั้ง`);
  if (a.automodDeletes) parts.push(`ระบบกรองข้อความอัตโนมัติทำงาน ${a.automodDeletes} ครั้ง`);
  if (a.ticketsOpened) parts.push(`มีคนเปิดช่องขอความช่วยเหลือส่วนตัว (Ticket) ${a.ticketsOpened} ครั้ง`);
  if (a.giveawaysWon) parts.push(`มีการแจกของรางวัลสำเร็จให้ผู้โชคดี ${a.giveawaysWon} คน`);
  if (a.raidDetected) parts.push('ระบบตรวจพบความเสี่ยงการโจมตี (raid) จากคนเข้าร่วมจำนวนมากผิดปกติ');
  return parts.length ? parts.join(', ') : 'วันนี้เซิร์ฟเวอร์เงียบสงบ ไม่มีเหตุการณ์พิเศษอะไรเกิดขึ้นเลย';
}

async function generateAndPostDream(guild) {
  const guildId = guild.id;
  const cfg = getGuildConfig(guildId);
  if (!cfg.dreamEnabled) return;

  const summary = buildDailyActivitySummary(guildId);
  let dreamText;
  try {
    dreamText = await ai.generateDreamText(cfg, summary);
  } catch (e) {
    console.error(`❌ สร้างความฝันของกิลด์ ${guildId} ล้มเหลว:`, e.message);
    return;
  }
  if (!dreamText) return;

  await storage.saveDream(guildId, dreamText);
  cfg.lastDreamAt = Date.now();
  saveGuildConfig(guildId);
  dailyActivity.delete(guildId); // เริ่มเก็บวัตถุดิบของวันถัดไปใหม่

  if (cfg.dreamChannelId) {
    const channel = await guild.channels.fetch(cfg.dreamChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const dreamEmbed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🌙 ความฝันของบอทเมื่อคืนนี้')
        .setDescription(dreamText)
        .setFooter({ text: 'เกิดจากการนำเหตุการณ์ในเซิร์ฟเวอร์มาแต่งเป็นภาพฝัน — ไม่ใช่คำทำนายหรือเรื่องจริง' })
        .setTimestamp();
      await channel.send({ embeds: [dreamEmbed] }).catch(() => {});
    }
  }

  generateDreamRelics(guild, cfg, dreamText).catch((e) => console.error('❌ generateDreamRelics ล้มเหลว:', e.message));
}

// ==========================================
// 🏺 13.66 ระบบเกม "ล่าของวิเศษจากฝัน" (Dream Relic Hunt)
// ต่อยอดจากระบบความฝันด้านบน (ระบบที่ไม่มีบอทไหนมี เพราะไม่มีบอทไหนมีระบบความฝันให้ต่อยอด!)
// ทุกครั้งที่บอทฝัน จะมีของวิเศษ 2-3 ชิ้นหลุดออกมาจากภวังค์ความฝันคืนนั้น ให้สมาชิกกดปุ่มแย่งคว้า
// ใครกดก่อนได้ก่อน (อะตอมมิกกันชนกันตอนกดพร้อมกัน) เก็บสะสมเป็นคอลเลกชันส่วนตัว โชว์ในไพ่ leaderboard ได้
// ของหายากยังมีผลตอบแทนจริงในเกม: บูสต์ XP ชั่วคราวให้ระบบเลเวลที่มีอยู่แล้ว — ทำให้การล่าของมีความหมายจริงจัง
// ไม่ใช่แค่ของสะสมเฉยๆ นี่คือเหตุผลที่สมาชิกจะกลับมาเช็คเซิร์ฟเวอร์ทุกวัน ไม่ปล่อยให้เซิร์ฟร้าง
// ==========================================
const RELIC_RARITY_INFO = {
  common: { label: 'ธรรมดา', emoji: '⚪', color: 0x95A5A6, weight: 60 },
  rare: { label: 'หายาก', emoji: '🔵', color: 0x3498DB, weight: 30 },
  epic: { label: 'เอปิก', emoji: '🟣', color: 0x9B59B6, weight: 8 },
  legendary: { label: 'ตำนาน', emoji: '🟡', color: 0xF1C40F, weight: 2 },
};

function pickRelicRarity() {
  const total = Object.values(RELIC_RARITY_INFO).reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * total;
  for (const [key, info] of Object.entries(RELIC_RARITY_INFO)) {
    if (roll < info.weight) return key;
    roll -= info.weight;
  }
  return 'common';
}

// userId -> timestamp ที่บูสต์ XP (x2) จะหมดอายุ — ได้จากการคว้าของวิเศษระดับเอปิก/ตำนาน
const relicXpBoostUntil = new Map();

async function generateDreamRelics(guild, cfg, dreamText) {
  if (!cfg.relicsEnabled || !cfg.dreamChannelId) return;
  const channel = await guild.channels.fetch(cfg.dreamChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const relicCount = Math.random() < 0.5 ? 2 : 3;
  for (let i = 0; i < relicCount; i += 1) {
    const rarity = pickRelicRarity();
    let relicInfo;
    try {
      relicInfo = await ai.generateRelicText(cfg, dreamText, rarity);
    } catch (e) {
      console.error(`❌ สร้างของวิเศษของกิลด์ ${guild.id} ล้มเหลว:`, e.message);
      continue;
    }
    if (!relicInfo) continue;

    cfg.relicCounter = (cfg.relicCounter || 0) + 1;
    saveGuildConfig(guild.id);
    const saved = await storage.createRelicDrop(guild.id, cfg.relicCounter, relicInfo.name, relicInfo.description, rarity);
    if (!saved) continue;

    const info = RELIC_RARITY_INFO[rarity];
    const relicEmbed = new EmbedBuilder().setColor(info.color)
      .setTitle(`${info.emoji} มีของวิเศษหลุดออกมาจากความฝัน!`)
      .setDescription(`**${relicInfo.name}**\n${relicInfo.description}`)
      .addFields(
        { name: 'ระดับความหายาก', value: info.label, inline: true },
        { name: 'เลขไอเทม', value: `#${cfg.relicCounter}`, inline: true },
      )
      .setFooter({ text: 'กดปุ่มด้านล่างเพื่อคว้าไว้ — ใครกดก่อนได้ก่อน!' });
    const claimBtn = new ButtonBuilder().setCustomId(`relic_claim_${saved._id}`).setLabel('🫳 คว้าไว้!').setStyle(ButtonStyle.Success);
    await channel.send({ embeds: [relicEmbed], components: [new ActionRowBuilder().addComponents(claimBtn)] }).catch(() => {});
  }
}

// เช็คทุก 15 นาทีว่าเซิร์ฟเวอร์ไหนเปิดระบบความฝันไว้ และห่างจากความฝันครั้งล่าสุดเกิน ~20 ชั่วโมงหรือยัง (ประมาณวันละครั้ง)
setInterval(() => {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const cfg = getGuildConfig(guild.id);
    if (cfg.dreamEnabled && now - (cfg.lastDreamAt || 0) > 20 * 60 * 60 * 1000) {
      generateAndPostDream(guild).catch(() => {});
    }
  }
}, 15 * 60 * 1000);

// ==========================================
// 📜 13.65 ระบบ "ธรรมนูญเซิร์ฟเวอร์" (Living Law Book)
// ทุกครั้งที่มีเหตุการณ์ดูแลเซิร์ฟเวอร์เกิดขึ้น (เตือน/เตะ/แบน/Timeout/Automod) มีโอกาสจุดประกายให้ AI ร่างกฎหมาย
// สมมติขำๆ ใหม่ 1 มาตรา สะสมกลายเป็นธรรมนูญเฉพาะของเซิร์ฟเวอร์นั้น — เรียกแบบ fire-and-forget ไม่บล็อกการตอบของผู้ใช้
// มี cooldown กันสแปม เพื่อให้แต่ละมาตราดูมีค่าเหมือนคำพยากรณ์ที่นานๆ จะมาที ไม่ใช่ทุกครั้งที่มีการลงโทษ
// ==========================================
const LAW_COOLDOWN_MS = 30 * 60 * 1000; // อย่างน้อย 30 นาทีต่อมาตราใหม่ 1 มาตรา
async function maybeGenerateLaw(guild, cfg, category) {
  if (!cfg.lawsEnabled) return;
  const now = Date.now();
  if (now - (cfg.lastLawAt || 0) < LAW_COOLDOWN_MS) return;

  let lawText;
  try {
    lawText = await ai.generateLawText(cfg, category);
  } catch (e) {
    console.error(`❌ ร่างมาตรากฎหมายใหม่ของกิลด์ ${guild.id} ล้มเหลว:`, e.message);
    return;
  }
  if (!lawText) return;

  cfg.lawCounter = (cfg.lawCounter || 0) + 1;
  cfg.lastLawAt = now;
  saveGuildConfig(guild.id);
  await storage.saveLaw(guild.id, cfg.lawCounter, lawText, category);

  if (cfg.lawsChannelId) {
    const channel = await guild.channels.fetch(cfg.lawsChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const lawEmbed = new EmbedBuilder().setColor(0xD4AC0D).setTitle(`📜 ธรรมนูญเซิร์ฟเวอร์ — มาตราที่ ${cfg.lawCounter}`)
        .setDescription(lawText)
        .setTimestamp();
      await channel.send({ embeds: [lawEmbed] }).catch(() => {});
    }
  }
}

// ==========================================
// 🏆 13.7 ระบบให้ XP + ประกาศเลเวลอัพ + แจกยศรางวัล
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
  const boostUntil = relicXpBoostUntil.get(message.author.id) || 0;
  const finalGained = Date.now() < boostUntil ? gained * 2 : gained;

  const before = calculateLevel(prevEntry.xp || 0);
  const newXp = (prevEntry.xp || 0) + finalGained;
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

  // Automod ทำงานก่อนเสมอ ถ้าลบข้อความไปแล้วให้หยุดทันที ไม่ต้องให้ XP หรือประมวลผลคำสั่งต่อ
  const automodTriggered = await runAutomod(message, cfg).catch(() => false);
  if (automodTriggered) return;

  // ให้ XP ระบบเลเวลก่อนเสมอ (ทำงานเป็นระบบแยกอิสระจากระบบแชท AI ไม่ขึ้นกับ cfg.isActive)
  awardLevelXp(message, cfg).catch(() => {});

  if (message.content === '!help') {
    return message.reply({ embeds: [buildHelpEmbed(PANEL_COMMAND)] }).catch(() => {});
  }

  if (message.content === '!ping') {
    const sent = await message.reply('🏓 กำลังวัดความหน่วง...');
    const ping = sent.createdTimestamp - message.createdTimestamp;
    return sent.edit(`🏓 Pong! ความหน่วงข้อความ: ${ping}ms | WebSocket: ${Math.round(client.ws.ping)}ms`).catch(() => {});
  }

  if (message.content === '!reset' || message.content === '!ลืม') {
    clearConversationHistory(guildId, message.author.id);
    storage.clearUserMemory(guildId, message.author.id).catch(() => {});
    return message.reply('🧹 ล้างความจำบทสนทนา + ความทรงจำเกี่ยวกับคุณที่ AI จำไว้ทั้งหมดแล้ว! เริ่มคุยใหม่ได้เลย').catch(() => {});
  }

  if (message.content === PANEL_COMMAND) {
    const fakeInteraction = { user: message.author, member: message.member, guildId };
    if (!hasAnyModPermission(fakeInteraction)) {
      return message.reply({ content: `❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้! (ID ของคุณ: \`${message.author.id}\`)` }).catch(() => {});
    }
    try {
      return await message.reply(buildAdminHubPanel(cfg, message.guild));
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
    const embed = buildRankEmbed(guildId, message.author);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  if (message.content === '!leaderboard') {
    const embed = buildLeaderboardEmbed(guildId);
    if (!embed) {
      return message.reply('📉 ยังไม่มีใครมี XP ในเซิร์ฟเวอร์นี้เลย').catch(() => {});
    }
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
  if (checkTokenBudget(guildId, cfg)) {
    return message.react('📊').catch(() => {});
  }

  const stopTyping = startTypingLoop(message.channel);
  try {
    const history = getConversationHistory(guildId, message.author.id, cfg);
    const userMemory = await storage.getUserMemory(guildId, message.author.id).catch(() => null);
    const cfgForReply = buildCfgWithRelationship(cfg, userMemory?.note);
    const result = await getAiResponse(cfgForReply, history, message.content);
    stopTyping();

    pushConversationTurn(guildId, message.author.id, cfg, message.content, result.text);
    recordTokenUsage(guildId, history, message.content, result.text);
    maybeUpdateRelationship(guildId, message.author.id, cfg).catch(() => {});
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
  else if (page === 'hub') payload = buildAdminHubPanel(cfg, interaction.guild);
  else if (page === 'moderation') payload = buildModerationPanel(cfg, interaction.guild);
  else if (page === 'automod') payload = buildAutomodPanel(cfg, interaction.guild);
  else if (page === 'ticket') payload = buildTicketPanel(cfg, interaction.guild);
  else if (page === 'antiraid') {
    const windowMs = (cfg.antiRaidWindowSeconds || 30) * 1000;
    const recentJoins = (raidJoinTimestamps.get(guildId) || []).filter((t) => Date.now() - t < windowMs).length;
    const isLockedVerification = raidOriginalVerificationLevel.has(guildId);
    payload = buildAntiraidPanel(cfg, interaction.guild, recentJoins, isLockedVerification);
  }
  else if (page === 'community') payload = buildCommunityAdminPanel(cfg, interaction.guild);
  else payload = buildMainPanel(cfg, interaction.guild); // page === 'main' (หน้าตั้งค่า AI) คือ default

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
// 📊 15.5 ฟังก์ชันสร้าง Embed ที่ใช้ร่วมกัน (เรียกได้ทั้งจาก Slash Command และปุ่มบนแผง Dashboard)
// แยกออกมาเป็นฟังก์ชันกลางเพื่อไม่ให้โค้ดซ้ำกันระหว่างคำสั่ง /community dream /community laws /community relic /community court /community level กับปุ่มบนแผง
// ทุกฟังก์ชันคืนค่า null ถ้ายังไม่มีข้อมูล ให้ผู้เรียกจัดการข้อความแจ้งเตือนเอง
// ==========================================
async function buildDreamViewEmbed(guildId) {
  const latest = await storage.getLatestDream(guildId);
  if (!latest) return null;
  return new EmbedBuilder().setColor(0x9B59B6).setTitle('🌙 ความฝันล่าสุดของเซิร์ฟเวอร์นี้')
    .setDescription(latest.content)
    .setFooter({ text: new Date(latest.createdAt).toLocaleString('th-TH') });
}

async function buildLawsBookEmbed(guildId, guildName, cfg) {
  const laws = await storage.getLawArchive(guildId, 15);
  if (!laws.length) return null;
  return new EmbedBuilder().setColor(0xD4AC0D).setTitle(`📜 ธรรมนูญเซิร์ฟเวอร์ ${guildName}`)
    .setDescription(laws.map((l) => `**มาตราที่ ${l.article}** — ${l.content}`).join('\n\n'))
    .setFooter({ text: `${laws.length} มาตราล่าสุด จากทั้งหมด ${cfg.lawCounter} มาตรา` });
}

async function buildRelicInventoryEmbed(guildId, targetUser) {
  const relics = await storage.getUserRelics(guildId, targetUser.id);
  if (!relics.length) return null;
  const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
  relics.forEach((r) => { counts[r.rarity] = (counts[r.rarity] || 0) + 1; });
  const summary = Object.entries(counts).filter(([, n]) => n > 0)
    .map(([rarity, n]) => `${RELIC_RARITY_INFO[rarity]?.emoji || '⚪'} ${RELIC_RARITY_INFO[rarity]?.label || rarity} x${n}`).join(' • ');
  const list = relics.slice(0, 15).map((r) => `${RELIC_RARITY_INFO[r.rarity]?.emoji || '⚪'} **#${r.article}** ${r.name}`).join('\n');
  return new EmbedBuilder().setColor(0x9B59B6).setTitle(`🏺 คลังของวิเศษของ ${targetUser.username}`)
    .setDescription(`${summary}\n\n${list}${relics.length > 15 ? `\n...และอีก ${relics.length - 15} ชิ้น` : ''}`)
    .setFooter({ text: `รวมทั้งหมด ${relics.length} ชิ้น` });
}

async function buildRelicLeaderboardEmbed(guildId, guildName) {
  const rows = await storage.getRelicLeaderboard(guildId, 10);
  if (!rows.length) return null;
  const medals = ['🥇', '🥈', '🥉'];
  const lines = await Promise.all(rows.map(async (row, i) => {
    const user = await client.users.fetch(row._id).catch(() => null);
    const name = user ? user.tag : `ผู้ใช้ (${row._id})`;
    const rank = medals[i] || `${i + 1}.`;
    return `${rank} **${name}** — ${row.count} ชิ้น (🟡x${row.legendaryCount} 🟣x${row.epicCount})`;
  }));
  return new EmbedBuilder().setColor(0xF1C40F).setTitle(`🏆 อันดับนักล่าของวิเศษ — ${guildName}`)
    .setDescription(lines.join('\n'));
}

async function buildUserMemoryEmbed(guildId, targetUser) {
  const memory = await storage.getUserMemory(guildId, targetUser.id);
  if (!memory || !memory.note) return null;
  const sentimentLabel = ai.SENTIMENT_LABELS_TH[memory.sentiment] || memory.sentiment;
  return new EmbedBuilder().setColor(0x1ABC9C).setTitle('🧠 สิ่งที่ AI จำเกี่ยวกับคุณ')
    .addFields(
      { name: 'บันทึกความสัมพันธ์', value: memory.note },
      { name: 'ความรู้สึกที่มีต่อคุณตอนนี้', value: sentimentLabel, inline: true },
      { name: 'จำนวนบทสนทนาที่วิเคราะห์', value: `${memory.interactionCount}`, inline: true },
    )
    .setFooter({ text: 'ใช้ /ai reset เพื่อล้างความทรงจำนี้ได้ตลอดเวลา' });
}

async function buildCourtRecordEmbed(guildId, targetUser) {
  const record = await storage.getCourtRecord(guildId, targetUser.id);
  if (!record.totalCases) return null;
  return new EmbedBuilder().setColor(0x8B4513).setTitle(`⚖️ สถิติศาลของ ${targetUser.username}`)
    .addFields(
      { name: 'คดีทั้งหมด', value: `${record.totalCases}`, inline: true },
      { name: 'ชนะ', value: `${record.totalWins}`, inline: true },
      { name: 'แพ้', value: `${record.totalLosses}`, inline: true },
      { name: 'เป็นโจทก์', value: `${record.asPlaintiff} คดี (ชนะ ${record.plaintiffWins})`, inline: true },
      { name: 'เป็นจำเลย', value: `${record.asDefendant} คดี (ชนะ ${record.defendantWins})`, inline: true },
    );
}

async function buildCourtCasesEmbed(guildId, guildName, cfg) {
  const cases = await storage.getCourtCaseArchive(guildId, 10);
  if (!cases.length) return null;
  const lines = await Promise.all(cases.map(async (c) => {
    const [plaintiff, defendant] = await Promise.all([
      client.users.fetch(c.plaintiffId).catch(() => null),
      client.users.fetch(c.defendantId).catch(() => null),
    ]);
    const winnerTag = c.winner === 'plaintiff' ? (plaintiff?.tag || 'โจทก์') : (defendant?.tag || 'จำเลย');
    return `**คดีที่ #${c.caseNumber}** — ${plaintiff?.tag || '?'} vs ${defendant?.tag || '?'}\n📋 ${c.accusation}\n🏆 ผู้ชนะ: ${winnerTag}`;
  }));
  return new EmbedBuilder().setColor(0x8B4513).setTitle(`⚖️ ประวัติคดีของเซิร์ฟเวอร์ ${guildName}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `${cases.length} คดีล่าสุด จากทั้งหมด ${cfg.courtCaseCounter} คดี` });
}

function buildRankEmbed(guildId, targetUser) {
  const data = getLevelData(guildId);
  const entry = data[targetUser.id] || { xp: 0 };
  const { level, xpIntoLevel, xpForNext } = calculateLevel(entry.xp || 0);
  const bar = makeProgressBar(xpIntoLevel, xpForNext);
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL() })
    .setDescription(`🏆 เลเวล **${level}**\n✨ XP รวม: **${entry.xp || 0}**\n${bar}\n${xpIntoLevel} / ${xpForNext} XP ไปเลเวลถัดไป`);
}

function buildLeaderboardEmbed(guildId) {
  const data = getLevelData(guildId);
  const sorted = Object.entries(data).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).slice(0, 10);
  if (!sorted.length) return null;
  const lines = sorted.map(([userId, d], i) => {
    const { level } = calculateLevel(d.xp || 0);
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return `${medal} <@${userId}> — เลเวล ${level} (${d.xp} XP)`;
  }).join('\n');
  return new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 อันดับ XP สูงสุด').setDescription(lines);
}

// ==========================================
// 🎛️ 15.6 แผง Dashboard สาธารณะ — ข้อความถาวรในห้องที่สมาชิกกดปุ่มดูข้อมูลได้เอง ไม่ต้องพิมพ์คำสั่งเยอะๆ
// ปุ่มที่โชว์จะปรับตามระบบที่เซิร์ฟเวอร์เปิดใช้งานอยู่จริง (เช็คจาก cfg โดยตรง ไม่ต้องมีหน้าตั้งค่าซ้ำซ้อน)
// ==========================================
function buildDashboardPayload(guild, cfg) {
  const buttonDefs = [];
  const categories = []; // { name, items: [label, ...] } — ใช้จัดกลุ่มปุ่มเป็นหมวดในตัว embed กันหน้าแผงดูโล่งๆ

  function addCategory(name) {
    const cat = { name, items: [] };
    categories.push(cat);
    return cat;
  }
  function addBtn(cat, customId, label, style = ButtonStyle.Secondary) {
    buttonDefs.push({ customId, label, style });
    cat.items.push(`${label}`);
  }

  if (cfg.isActive) {
    const aiCat = addCategory('🧠 ผู้ช่วย AI');
    addBtn(aiCat, 'dash_ai_ask', '🧠 ถาม AI', ButtonStyle.Primary);
    if (cfg.imageGenEnabled) addBtn(aiCat, 'dash_ai_imagine', '🎨 สร้างภาพ');
    addBtn(aiCat, 'dash_ai_reset', '🧹 ล้างความจำ AI');
    addBtn(aiCat, 'dash_ai_memory', '🧠 AI จำอะไรเกี่ยวกับฉัน');
    addBtn(aiCat, 'dash_ai_council', '🏛️ เปิดสภา AI');
    addBtn(aiCat, 'dash_ai_prophecy', '🔮 ขอคำทำนาย');
  }

  const levelCat = addCategory('🏅 เลเวล & กิจกรรม');
  addBtn(levelCat, 'dash_rank', '🏅 เลเวลของฉัน');
  addBtn(levelCat, 'dash_leaderboard', '📊 กระดานผู้นำ XP');
  if (cfg.dreamEnabled) addBtn(levelCat, 'dash_dream', '🌙 ความฝันล่าสุด');

  if (cfg.lawsEnabled) {
    const lawCat = addCategory('📜 ธรรมนูญเซิร์ฟเวอร์');
    addBtn(lawCat, 'dash_laws', '📜 ดูธรรมนูญทั้งหมด');
    addBtn(lawCat, 'dash_laws_article', '📖 ดูมาตรา');
  }

  if (cfg.relicsEnabled) {
    const relicCat = addCategory('🏺 ของวิเศษ');
    addBtn(relicCat, 'dash_relic_inv', '🏺 คลังของฉัน');
    addBtn(relicCat, 'dash_relic_top', '🏆 อันดับนักล่า');
    addBtn(relicCat, 'dash_relic_gift', '🎁 มอบของวิเศษ');
  }

  if (cfg.courtEnabled) {
    const courtCat = addCategory('⚖️ ศาลชุมชน');
    addBtn(courtCat, 'dash_court_record', '⚖️ สถิติศาลของฉัน');
    addBtn(courtCat, 'dash_court_cases', '📖 ประวัติคดี');
    addBtn(courtCat, 'dash_court_file', '🧑\u200d⚖️ ยื่นฟ้องศาล');
  }

  const otherCat = addCategory('🔧 อื่นๆ');
  if (cfg.ticketCategoryId) addBtn(otherCat, 'ticket_open', '🎫 เปิด Ticket', ButtonStyle.Primary);
  addBtn(otherCat, 'dash_help', '❓ วิธีใช้งาน');

  const rows = [];
  for (let i = 0; i < buttonDefs.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      buttonDefs.slice(i, i + 5).map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(b.style)),
    ));
  }

  // แถวสถานะด่วน ให้เห็นภาพรวมเซิร์ฟเวอร์ทันทีโดยไม่ต้องกดอะไรเลย
  const statusFields = [
    { name: '👥 สมาชิก', value: `${guild.memberCount} คน`, inline: true },
    { name: '🤖 สถานะ AI', value: cfg.isActive ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน', inline: true },
    { name: '🏅 ระบบเลเวล', value: cfg.levelingEnabled ? '🟢 เปิดใช้งาน' : '⚪ ปิดใช้งาน', inline: true },
  ];
  const categoryFields = categories
    .filter((c) => c.items.length)
    .map((c) => ({ name: c.name, value: c.items.join('\n'), inline: true }));

  const iconUrl = guild.iconURL({ size: 256 });

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({ name: guild.name, iconURL: iconUrl || undefined })
    .setTitle('🎛️ แผงเมนูสมาชิก')
    .setDescription(
      '**ยินดีต้อนรับ!** ✨ กดปุ่มด้านล่างเพื่อใช้งานฟีเจอร์ต่างๆ ได้เลย ไม่ต้องพิมพ์คำสั่งให้ยุ่งยาก\n' +
      '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
    )
    .addFields(...statusFields, ...categoryFields)
    .setThumbnail(iconUrl || null)
    .setFooter({ text: '👥 ทุกคนเห็นแผงนี้ได้ • กดปุ่มของใคร ก็เห็น/ทำเฉพาะของคนนั้นคนเดียว' })
    .setTimestamp();

  return { embed, rows };
}

// ==========================================
// 🕹️ 16. Handler สำหรับ Slash Commands (เหลือแค่ 2 คำสั่ง: /แผงแอดมิน กับ /เมนู — ทุกฟีเจอร์เข้าถึงผ่านปุ่ม/Modal/Select บนแผงแทน)
// ตรรกะจริงของแต่ละฟีเจอร์ (ถาม AI, สภา AI, ยื่นฟ้อง, เริ่มกิจกรรม ฯลฯ) ถูกย้ายไปเป็นฟังก์ชัน perform*/do* ด้านล่าง
// เพื่อให้ปุ่ม/Modal/Select ในแผงเรียกใช้ตรรกะเดียวกันได้โดยไม่ต้องเขียนซ้ำ — ดูการเรียกใช้จริงได้ในส่วน 18 (Interaction Handling)
// ==========================================

// อนุญาตเปิด "แผงแอดมิน" ถ้ามีสิทธิ์ดูแลเซิร์ฟเวอร์ "อย่างน้อยหนึ่งอย่าง" (ไม่จำเป็นต้องเป็นแอดมินเต็มขั้น)
// เพื่อให้มอดที่มีแค่สิทธิ์ Kick/Ban/Moderate/ManageMessages อย่างเดียว ยังเปิดแผงไปใช้หน้า "ดูแลเซิร์ฟเวอร์" ได้เหมือนเดิม
// ส่วนหน้าที่ละเอียดอ่อนกว่า (ตั้งค่า AI/automod/antiraid/ระบบชุมชน ฯลฯ) จะเช็คสิทธิ์เฉพาะทางอีกชั้นตอนกดปุ่มในหน้านั้นๆ
function hasAnyModPermission(interaction) {
  return checkModPermission(interaction, PermissionFlagsBits.KickMembers)
    || checkModPermission(interaction, PermissionFlagsBits.BanMembers)
    || checkModPermission(interaction, PermissionFlagsBits.ModerateMembers)
    || checkModPermission(interaction, PermissionFlagsBits.ManageMessages)
    || checkModPermission(interaction, PermissionFlagsBits.ManageGuild);
}

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({ content: '❌ คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์เท่านั้น', ephemeral: true }).catch(() => {});
  }
  const cfg = getGuildConfig(guildId);

  if (commandName === 'เมนู') {
    const { embed, rows } = buildDashboardPayload(interaction.guild, cfg);
    return interaction.reply({ embeds: [embed], components: rows }).catch(() => {});
  }

  if (commandName === 'แผงแอดมิน') {
    if (!hasAnyModPermission(interaction)) {
      return interaction.reply({ content: `❌ คุณไม่มีสิทธิ์เปิดแผงแอดมิน (ต้องมีสิทธิ์ดูแลเซิร์ฟเวอร์อย่างน้อยหนึ่งอย่าง เช่น Manage Server / Kick Members / Ban Members / Moderate Members / Manage Messages — ID ของคุณ: \`${interaction.user.id}\`)`, ephemeral: true }).catch(() => {});
    }
    return interaction.reply(buildAdminHubPanel(cfg, interaction.guild)).catch(() => {});
  }
}

// ==========================================
// 🧠 16.1 ฟังก์ชัน perform* ฝั่ง AI (ย้ายมาจาก /ai ask /ai imagine /ai council /ai prophecy เดิม — เรียกจาก Modal ที่เด้งจากปุ่มบน /เมนู)
// ==========================================
async function performAiAsk(interaction, cfg, guildId, question) {
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
  const quotaMsg = checkTokenBudget(guildId, cfg);
  if (quotaMsg) {
    return interaction.reply({ content: quotaMsg, ephemeral: true }).catch(() => {});
  }

  await interaction.deferReply();
  const stopTyping = startTypingLoop(interaction.channel);
  try {
    const history = getConversationHistory(guildId, interaction.user.id, cfg);
    const userMemory = await storage.getUserMemory(guildId, interaction.user.id).catch(() => null);
    const cfgForReply = buildCfgWithRelationship(cfg, userMemory?.note);
    const result = await getAiResponse(cfgForReply, history, question);
    stopTyping();
    pushConversationTurn(guildId, interaction.user.id, cfg, question, result.text);
    recordTokenUsage(guildId, history, question, result.text);
    maybeUpdateRelationship(guildId, interaction.user.id, cfg).catch(() => {});
    recordStat(guildId, { userId: interaction.user.id, provider: result.provider, latencyMs: result.latencyMs, error: false });
    const payload = buildAiReplyPayload(cfg, interaction.user.id, result.text);
    await interaction.editReply(payload).catch(() => {});
    if (cfg.logChannelId) {
      const logEmbed = new EmbedBuilder()
        .setColor(result.usedFallback ? 0xF1C40F : 0x2ECA53)
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .addFields(
          { name: '❓ คำถาม (เมนู → ถาม AI)', value: question.slice(0, 1000) || '(ว่าง)' },
          { name: '💬 คำตอบ', value: (result.text || '').slice(0, 1000) || '(ว่าง)' },
          { name: '🌐 ค่าย', value: `${result.provider} (${result.latencyMs}ms)`, inline: true },
          { name: '📌 ห้อง', value: `<#${interaction.channelId}>`, inline: true }
        )
        .setTimestamp();
      sendGuildLog(interaction.guild, cfg, { embeds: [logEmbed] });
    }
  } catch (err) {
    stopTyping();
    recordStat(guildId, { error: true });
    console.error('❌ ถาม AI (เมนู) เกิดข้อผิดพลาด:', err.message);
    await interaction.editReply('เกิดข้อผิดพลาดบางอย่าง ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
  }
}

async function performAiImagine(interaction, cfg, guildId, prompt) {
  if (!cfg.imageGenEnabled) {
    return interaction.reply({ content: '🔴 ระบบสร้างภาพถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
  }
  if (isOnImageGenCooldown(guildId, interaction.user.id)) {
    return interaction.reply({ content: `⏳ ใจเย็นๆ นะ กันสแปมอยู่ (${IMAGE_GEN_COOLDOWN_SECONDS} วินาทีต่อครั้ง) ลองใหม่อีกสักครู่`, ephemeral: true }).catch(() => {});
  }
  await interaction.deferReply();
  try {
    const buffer = await generateImage(prompt);
    const embed = buildImagineEmbed(prompt, interaction.user.tag);
    return interaction.editReply({ embeds: [embed], files: [{ attachment: buffer, name: 'imagine.png' }] }).catch(() => {});
  } catch (e) {
    console.error('❌ สร้างภาพ (เมนู) เกิดข้อผิดพลาด:', e.message);
    return interaction.editReply('❌ สร้างภาพไม่สำเร็จ เซิร์ฟเวอร์ภาพอาจกำลังหน่วง ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
  }
}

async function performAiCouncil(interaction, cfg, guildId, topic) {
  if (!cfg.isActive) {
    return interaction.reply({ content: '🔴 ระบบ AI ถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
  }
  if (isOnCouncilCooldown(guildId, interaction.user.id)) {
    return interaction.reply({ content: `⏳ สภา AI ใช้เวลาประมวลผลนานหน่อย กันสแปมไว้ ${COUNCIL_COOLDOWN_SECONDS} วินาที/ครั้ง ลองใหม่อีกสักครู่นะครับ`, ephemeral: true }).catch(() => {});
  }
  const allModes = Object.keys(MODE_LABELS);
  const modeA = allModes[Math.floor(Math.random() * allModes.length)];
  const remaining = allModes.filter((m) => m !== modeA);
  const modeB = remaining[Math.floor(Math.random() * remaining.length)];

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
    console.error('❌ สภา AI (เมนู) เกิดข้อผิดพลาด:', e.message);
    return interaction.editReply('❌ เปิดสภาไม่สำเร็จ ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
  }
}

async function performAiProphecy(interaction, cfg, guildId, durationText, topic) {
  if (!cfg.isActive) {
    return interaction.reply({ content: '🔴 ระบบ AI ถูกปิดใช้งานอยู่ในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
  }
  if (isOnProphecyCooldown(guildId, interaction.user.id)) {
    return interaction.reply({ content: `⏳ ใจเย็นๆ นะ กันสแปมไว้ ${PROPHECY_COOLDOWN_SECONDS} วินาที/ครั้ง ลองใหม่อีกสักครู่`, ephemeral: true }).catch(() => {});
  }
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
  } catch (e) {
    console.error('❌ คำทำนาย (เมนู) เกิดข้อผิดพลาด:', e.message);
    await interaction.editReply('❌ ทำนายไม่สำเร็จ ลูกแก้วอาจขุ่นมัวชั่วคราว ลองใหม่อีกครั้งนะครับ 🥲').catch(() => {});
  }
}

// ==========================================
// ⚖️ 16.2 ฟังก์ชัน perform* ฝั่งศาล/ของวิเศษ/กิจกรรมแจกของ (ย้ายมาจาก /community เดิม — เรียกจาก Modal/ปุ่มบนแผง)
// ==========================================
async function performCourtFile(interaction, cfg, guildId, defendant, accusation, articleRef) {
  if (!cfg.courtEnabled) {
    return interaction.reply({ content: '❌ เซิร์ฟเวอร์นี้ยังไม่ได้เปิดระบบศาล (แอดมินต้องเปิดจากแผงแอดมิน → ระบบชุมชน ก่อน)', ephemeral: true }).catch(() => {});
  }
  if (defendant.id === interaction.user.id) {
    return interaction.reply({ content: '❌ ฟ้องตัวเองไม่ได้นะ', ephemeral: true }).catch(() => {});
  }
  if (defendant.bot) {
    return interaction.reply({ content: '❌ ฟ้องบอทไม่ได้ (บอทมีสิทธิคุ้มกันทางการทูต)', ephemeral: true }).catch(() => {});
  }
  if (isOnCourtCooldown(guildId, interaction.user.id)) {
    return interaction.reply({ content: `⏳ คุณเพิ่งยื่นฟ้องไปไม่นาน รอสักครู่ก่อนยื่นฟ้องคดีต่อไปนะ (คูลดาวน์ ${Math.floor(COURT_COOLDOWN_SECONDS / 60)} นาที)`, ephemeral: true }).catch(() => {});
  }

  await interaction.deferReply();

  let articleText = null;
  if (articleRef) {
    const law = await storage.getLawByArticle(guildId, articleRef);
    if (law) articleText = `มาตราที่ ${law.article}: ${law.content}`;
  }

  let verdict;
  try {
    verdict = await ai.generateCourtVerdict(cfg, accusation, articleText);
  } catch (e) {
    console.error(`❌ ตัดสินคดีของกิลด์ ${guildId} ล้มเหลว:`, e.message);
    return interaction.editReply('⚖️ ศาลขัดข้องทางเทคนิค เลื่อนการพิจารณาคดีออกไปก่อน ลองใหม่อีกครั้งนะครับ').catch(() => {});
  }

  cfg.courtCaseCounter = (cfg.courtCaseCounter || 0) + 1;
  saveGuildConfig(guildId);
  await storage.createCourtCase(guildId, cfg.courtCaseCounter, interaction.user.id, defendant.id, accusation, articleRef, verdict.verdictText, verdict.winner);

  const winnerLabel = verdict.winner === 'plaintiff' ? `🏆 โจทก์ (${interaction.user.tag})` : `🏆 จำเลย (${defendant.tag})`;
  const caseEmbed = new EmbedBuilder().setColor(0x8B4513).setTitle(`⚖️ คดีที่ #${cfg.courtCaseCounter}`)
    .addFields(
      { name: '👤 โจทก์', value: `${interaction.user}`, inline: true },
      { name: '👤 จำเลย', value: `${defendant}`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '📋 ข้อกล่าวหา', value: accusation },
      { name: '🧑‍⚖️ คำตัดสิน', value: verdict.verdictText },
      { name: 'ผลการตัดสิน', value: winnerLabel },
    )
    .setFooter({ text: 'เกมสมมติเพื่อความบันเทิงล้วนๆ ไม่ใช่การกล่าวหาจริง ไม่มีผลใดๆ นอกเกม' })
    .setTimestamp();
  return interaction.editReply({ embeds: [caseEmbed] }).catch(() => {});
}

async function performRelicGift(interaction, guildId, recipient, article) {
  if (recipient.id === interaction.user.id) {
    return interaction.reply({ content: '❌ มอบของวิเศษให้ตัวเองไม่ได้นะ', ephemeral: true }).catch(() => {});
  }
  if (recipient.bot) {
    return interaction.reply({ content: '❌ มอบของวิเศษให้บอทไม่ได้', ephemeral: true }).catch(() => {});
  }
  const transferred = await storage.transferRelic(guildId, article, interaction.user.id, recipient.id);
  if (!transferred) {
    return interaction.reply({ content: `❌ ไม่พบของวิเศษเลข #${article} ในครอบครองของคุณ (เช็คเลขไอเทมจากปุ่ม "คลังของฉัน")`, ephemeral: true }).catch(() => {});
  }
  return interaction.reply({ content: `🎁 มอบ **${transferred.name}** (#${article}) ให้ ${recipient} เรียบร้อยแล้ว!` }).catch(() => {});
}

async function performGiveawayStart(interaction, cfg, guildId, durationText, prize, winnerCount) {
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
}

async function performGiveawayEnd(interaction, guildId, messageId) {
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

async function performGiveawayReroll(interaction, guildId, messageId) {
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
  if (winners.length) bumpActivity(guildId, 'giveawaysWon', winners.length);
  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (channel) {
    await channel.send({ content: `🔄 สุ่มใหม่! ผู้ชนะคนใหม่ของ **${g.prize}** คือ ${winners.map((id) => `<@${id}>`).join(', ')}` }).catch(() => {});
  }
  return interaction.reply({ content: '✅ สุ่มผู้ชนะใหม่เรียบร้อยแล้ว', ephemeral: true }).catch(() => {});
}

async function performDreamNow(interaction, cfg, guildId) {
  await interaction.deferReply({ ephemeral: true });
  const wasEnabled = cfg.dreamEnabled;
  cfg.dreamEnabled = true; // เปิดชั่วคราวเผื่อยังไม่เคยตั้งค่าไว้ ให้ generateAndPostDream ทำงานได้
  await generateAndPostDream(interaction.guild);
  if (!wasEnabled) cfg.dreamEnabled = false; // ถ้าเดิมปิดอยู่ ให้กลับไปปิดเหมือนเดิม (แค่ทดสอบครั้งนี้ครั้งเดียว)
  saveGuildConfig(guildId);
  return interaction.editReply(cfg.dreamChannelId ? `🌙 บอทฝันแล้ว ไปดูได้ที่ <#${cfg.dreamChannelId}> (หรือกด "ความฝันล่าสุด" จาก /เมนู)` : '🌙 บอทฝันแล้ว กด "ความฝันล่าสุด" จาก /เมนู เพื่ออ่าน (ยังไม่ได้ตั้งช่องโพสต์ — ตั้งได้ที่แผงแอดมิน → ระบบชุมชน)').catch(() => {});
}

// ==========================================
// 🛡️ 16.3 ฟังก์ชัน do* ที่เหลือของฝั่งดูแลเซิร์ฟเวอร์ (ย้ายมาจาก /server mod เดิม)
// kick/ban/timeout/warn/warnings ใช้ doKickAction/doBanAction/doTimeoutAction/doWarnAction/doWarningsView ที่มีอยู่แล้วโดยตรง (นิยามไว้ด้านบนของไฟล์)
// ==========================================
async function doUnbanAction(interaction, userId) {
  try {
    await interaction.guild.members.unban(userId);
    return interaction.reply({ content: `✅ ปลดแบน <@${userId}> เรียบร้อยแล้ว` }).catch(() => {});
  } catch (e) {
    return interaction.reply({ content: '❌ ไม่พบผู้ใช้ที่ถูกแบนด้วย ID นี้ หรือเกิดข้อผิดพลาด', ephemeral: true }).catch(() => {});
  }
}

async function doUntimeoutAction(interaction, targetUserId) {
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  if (!targetMember) {
    return interaction.reply({ content: '❌ ไม่พบผู้ใช้นี้ในเซิร์ฟเวอร์', ephemeral: true }).catch(() => {});
  }
  await targetMember.timeout(null).catch(() => {});
  return interaction.reply({ content: `✅ ยกเลิก Timeout ของ <@${targetUserId}> แล้ว` }).catch(() => {});
}

async function doClearWarningsAction(interaction, guildId, targetUserId) {
  await storage.clearWarnings(guildId, targetUserId);
  return interaction.reply({ content: `🧹 ล้างประวัติการเตือนของ <@${targetUserId}> แล้ว` }).catch(() => {});
}

async function doPurgeAction(interaction, amount) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const deleted = await interaction.channel.bulkDelete(amount, true);
    return interaction.editReply(`🧹 ลบข้อความไปแล้ว ${deleted.size} ข้อความ`).catch(() => {});
  } catch (e) {
    return interaction.editReply('❌ ลบข้อความไม่สำเร็จ (ข้อความอาจเก่าเกิน 14 วัน หรือบอทไม่มีสิทธิ์ Manage Messages)').catch(() => {});
  }
}

// ==========================================
// 🖱️ 16.5 Handler สำหรับ Context Menu Commands (คลิกขวาที่ชื่อสมาชิก -> Apps)
// วิธีนี้ทำ mod action ได้เร็วกว่า Slash Command เพราะไม่ต้องพิมพ์หรือเลือกผู้ใช้เอง (คลิกขวาปุ๊บได้ผู้ใช้เป้าหมายทันที)
// ==========================================
async function handleContextMenuCommand(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({ content: '❌ ใช้ได้เฉพาะในเซิร์ฟเวอร์เท่านั้น', ephemeral: true }).catch(() => {});
  }
  const cfg = getGuildConfig(guildId);
  const targetUser = interaction.targetUser;

  if (interaction.commandName === 'เตะสมาชิก') {
    if (!checkModPermission(interaction, PermissionFlagsBits.KickMembers)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์เตะสมาชิก (ต้องมีสิทธิ์ Kick Members)', ephemeral: true }).catch(() => {});
    }
    const modal = new ModalBuilder().setCustomId(`ctxreason_kick_${targetUser.id}`).setTitle(`👢 เตะ ${targetUser.username}`.slice(0, 45));
    const input = new TextInputBuilder().setCustomId('reason_input').setLabel('เหตุผล (ไม่บังคับ)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal).catch(() => {});
  }

  if (interaction.commandName === 'แบนสมาชิก') {
    if (!checkModPermission(interaction, PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์แบนสมาชิก (ต้องมีสิทธิ์ Ban Members)', ephemeral: true }).catch(() => {});
    }
    const modal = new ModalBuilder().setCustomId(`ctxreason_ban_${targetUser.id}`).setTitle(`🔨 แบน ${targetUser.username}`.slice(0, 45));
    const input = new TextInputBuilder().setCustomId('reason_input').setLabel('เหตุผล (ไม่บังคับ)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal).catch(() => {});
  }

  if (interaction.commandName === 'เตือนสมาชิก') {
    if (!checkModPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์เตือนสมาชิก (ต้องมีสิทธิ์ Moderate Members)', ephemeral: true }).catch(() => {});
    }
    if (targetUser.id === interaction.user.id) {
      return interaction.reply({ content: '❌ เตือนตัวเองไม่ได้', ephemeral: true }).catch(() => {});
    }
    const modal = new ModalBuilder().setCustomId(`ctxreason_warn_${targetUser.id}`).setTitle(`⚠️ เตือน ${targetUser.username}`.slice(0, 45));
    const input = new TextInputBuilder().setCustomId('reason_input').setLabel('เหตุผลในการเตือน').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal).catch(() => {});
  }

  if (interaction.commandName === 'Timeout 10 นาที' || interaction.commandName === 'Timeout 1 ชั่วโมง') {
    if (!checkModPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ Timeout สมาชิก (ต้องมีสิทธิ์ Moderate Members)', ephemeral: true }).catch(() => {});
    }
    const is10Min = interaction.commandName === 'Timeout 10 นาที';
    const durationMs = is10Min ? 10 * 60 * 1000 : 60 * 60 * 1000;
    const durationLabel = is10Min ? '10 นาที' : '1 ชั่วโมง';
    return doTimeoutAction(interaction, cfg, targetUser.id, durationMs, durationLabel, 'Timeout ด่วนจากเมนูคลิกขวา');
  }

  if (interaction.commandName === 'ดูประวัติเตือน') {
    if (!checkModPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ดูประวัติการเตือน (ต้องมีสิทธิ์ Moderate Members)', ephemeral: true }).catch(() => {});
    }
    return doWarningsView(interaction, targetUser.id);
  }
}

// ==========================================
// 🖱️ 16.6 Handler สำหรับ Modal ใส่เหตุผลที่เปิดจาก Context Menu (เตะ/แบน/เตือน)
// ==========================================
async function handleContextReasonModal(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const cfg = getGuildConfig(guildId);
  // customId รูปแบบ: ctxreason_<action>_<userId>  เช่น ctxreason_kick_123456789012345678
  const parts = interaction.customId.split('_');
  const action = parts[1];
  const targetUserId = parts[2];
  const rawReason = interaction.fields.getTextInputValue('reason_input').trim();
  const reason = rawReason || 'ไม่ระบุเหตุผล';

  if (action === 'kick') return doKickAction(interaction, cfg, targetUserId, reason);
  if (action === 'ban') return doBanAction(interaction, cfg, targetUserId, reason, 0);
  if (action === 'warn') return doWarnAction(interaction, cfg, targetUserId, reason);
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
  const quotaMsg = checkTokenBudget(guildId, cfg);
  if (quotaMsg) {
    return interaction.reply({ content: quotaMsg, ephemeral: true }).catch(() => {});
  }

  await interaction.deferUpdate().catch(() => {});
  const stopTyping = startTypingLoop(interaction.channel);
  try {
    popLastConversationTurn(guildId, ownerId); // เอาคู่สนทนารอบล่าสุดออกก่อน กันซ้ำซ้อนตอนขอคำตอบใหม่
    const history = getConversationHistory(guildId, ownerId, cfg);
    const userMemory = await storage.getUserMemory(guildId, ownerId).catch(() => null);
    const cfgForReply = buildCfgWithRelationship(cfg, userMemory?.note);
    const result = await getAiResponse(cfgForReply, history, originalMsg.content);
    stopTyping();
    pushConversationTurn(guildId, ownerId, cfg, originalMsg.content, result.text);
    recordTokenUsage(guildId, history, originalMsg.content, result.text);
    maybeUpdateRelationship(guildId, ownerId, cfg).catch(() => {});
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

    // ---------- Context Menu Commands (คลิกขวาที่ชื่อสมาชิก -> Apps) ----------
    if (interaction.isUserContextMenuCommand()) {
      return handleContextMenuCommand(interaction);
    }

    // ---------- Modal ใส่เหตุผลที่เปิดจาก Context Menu (เตะ/แบน/เตือน) ----------
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ctxreason_')) {
      return handleContextReasonModal(interaction);
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

    // ---------- ปุ่ม 🎫 เปิด Ticket (ใครก็กดได้ ไม่ต้องมีสิทธิ์แอดมิน) ----------
    if (interaction.isButton() && interaction.customId === 'ticket_open') {
      const tGuildId = interaction.guildId;
      if (!tGuildId) return;
      const tCfg = getGuildConfig(tGuildId);
      if (!tCfg.ticketCategoryId) {
        return interaction.reply({ content: '❌ ระบบ Ticket ยังไม่ได้ตั้งค่า (แอดมินต้องรัน `/server ticket setup` ก่อน)', ephemeral: true }).catch(() => {});
      }
      const existing = await storage.getOpenTicketForUser(tGuildId, interaction.user.id);
      if (existing) {
        return interaction.reply({ content: `❌ คุณมี Ticket ที่ยังเปิดอยู่แล้วที่ <#${existing.channelId}>`, ephemeral: true }).catch(() => {});
      }
      await interaction.deferReply({ ephemeral: true });
      const category = await interaction.guild.channels.fetch(tCfg.ticketCategoryId).catch(() => null);
      if (!category) {
        return interaction.editReply('❌ ไม่พบหมวดหมู่ Ticket ที่ตั้งค่าไว้ (อาจถูกลบไปแล้ว) แจ้งแอดมินให้ตั้งค่าใหม่ด้วย `/server ticket setup`').catch(() => {});
      }
      tCfg.ticketCounter = (tCfg.ticketCounter || 0) + 1;
      saveGuildConfig(tGuildId);
      const channelName = `ticket-${String(tCfg.ticketCounter).padStart(4, '0')}`;
      const overwrites = [
        { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ];
      if (tCfg.ticketStaffRoleId) {
        overwrites.push({ id: tCfg.ticketStaffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }
      let ticketChannel;
      try {
        ticketChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: overwrites,
          topic: `Ticket ของ ${interaction.user.tag} (${interaction.user.id})`,
        });
      } catch (e) {
        return interaction.editReply('❌ สร้างช่อง Ticket ไม่สำเร็จ (เช็คสิทธิ์ Manage Channels ของบอท)').catch(() => {});
      }
      await storage.createTicketRecord(tGuildId, ticketChannel.id, interaction.user.id);
      bumpActivity(tGuildId, 'ticketsOpened');
      const welcomeEmbed = new EmbedBuilder().setColor(0x2ECC71).setTitle('🎫 Ticket ใหม่')
        .setDescription(`สวัสดี ${interaction.user} ทีมงานจะเข้ามาช่วยเหลือเร็วๆ นี้ กดปุ่มด้านล่างเพื่อปิด Ticket เมื่อเรื่องจบแล้ว`)
        .setTimestamp();
      const closeBtn = new ButtonBuilder().setCustomId(`ticket_close_${ticketChannel.id}`).setLabel('🔒 ปิด Ticket').setStyle(ButtonStyle.Danger);
      await ticketChannel.send({
        content: tCfg.ticketStaffRoleId ? `<@&${tCfg.ticketStaffRoleId}>` : undefined,
        embeds: [welcomeEmbed],
        components: [new ActionRowBuilder().addComponents(closeBtn)],
      }).catch(() => {});
      sendGuildLog(interaction.guild, tCfg, `🎫 เปิด Ticket ใหม่: ${ticketChannel} โดย ${interaction.user.tag}`);
      return interaction.editReply(`✅ เปิด Ticket แล้วที่ ${ticketChannel}`).catch(() => {});
    }

    // ---------- ปุ่ม 🔒 ปิด Ticket ----------
    if (interaction.isButton() && interaction.customId.startsWith('ticket_close_')) {
      const tGuildId = interaction.guildId;
      if (!tGuildId) return;
      const tCfg = getGuildConfig(tGuildId);
      const channelId = interaction.customId.replace('ticket_close_', '');
      return closeTicketChannel(interaction, tCfg, channelId);
    }

    // ---------- ปุ่ม 🫳 คว้าของวิเศษจากฝัน (ใครก็กดได้ ใครกดก่อนได้ก่อน) ----------
    if (interaction.isButton() && interaction.customId.startsWith('relic_claim_')) {
      const relicId = interaction.customId.replace('relic_claim_', '');
      const claimed = await storage.claimRelicDrop(relicId, interaction.user.id);
      if (!claimed) {
        return interaction.reply({ content: '😅 สายไปแล้ว มีคนคว้าไปก่อนคุณแล้ว!', ephemeral: true }).catch(() => {});
      }
      const info = RELIC_RARITY_INFO[claimed.rarity] || RELIC_RARITY_INFO.common;

      // บูสต์ XP x2 ชั่วคราวถ้าคว้าของหายากระดับเอปิกหรือตำนานได้ (ทำให้การล่าของมีผลตอบแทนจริงในเกม)
      if (claimed.rarity === 'legendary') relicXpBoostUntil.set(interaction.user.id, Date.now() + 60 * 60 * 1000);
      else if (claimed.rarity === 'epic') relicXpBoostUntil.set(interaction.user.id, Date.now() + 30 * 60 * 1000);

      const originalEmbed = interaction.message.embeds[0];
      const claimedEmbed = originalEmbed
        ? EmbedBuilder.from(originalEmbed).setColor(0x2ECC71).setFooter({ text: `✅ ${interaction.user.tag} คว้าไปแล้ว!` })
        : new EmbedBuilder().setColor(0x2ECC71).setDescription(`**${claimed.name}**\n${claimed.description}`).setFooter({ text: `✅ ${interaction.user.tag} คว้าไปแล้ว!` });
      await interaction.update({ embeds: [claimedEmbed], components: [] }).catch(() => {});

      if (claimed.rarity === 'legendary' || claimed.rarity === 'epic') {
        await interaction.followUp({
          content: `${info.emoji} ยินดีด้วย! คุณได้รับบูสต์ XP x2 ชั่วคราวจากพลังของ **${claimed.name}**`,
          ephemeral: true,
        }).catch(() => {});
      }
      return;
    }

    // ---------- ปุ่มยืนยัน/ยกเลิกการเผยแพร่แผง Dashboard (มาจาก /bot dashboard setup) ----------
    if (interaction.isButton() && interaction.customId.startsWith('dash_publish_')) {
      const dGuildId = interaction.guildId;
      if (!dGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์เผยแพร่แผงนี้', ephemeral: true }).catch(() => {});
      }
      const dCfg = getGuildConfig(dGuildId);
      const channelId = interaction.customId.replace('dash_publish_', '');
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return interaction.update({ content: '❌ ไม่พบห้องที่เลือกไว้ (อาจถูกลบไปแล้ว) ลองตั้งค่าใหม่ด้วย `/bot dashboard setup`', embeds: [], components: [] }).catch(() => {});
      }
      const { embed, rows } = buildDashboardPayload(interaction.guild, dCfg);
      const sentMsg = await channel.send({ embeds: [embed], components: rows }).catch(() => null);
      dCfg.dashboardChannelId = channel.id;
      dCfg.dashboardMessageId = sentMsg ? sentMsg.id : '';
      saveGuildConfig(dGuildId);
      return interaction.update({ content: `✅ เผยแพร่แผง Dashboard ลงที่ ${channel} เรียบร้อยแล้ว! (ถาวร ไม่ต้องทำซ้ำอีก — ถ้าเปิดระบบเพิ่มทีหลัง ใช้ \`/bot dashboard refresh\` เพื่ออัปเดตปุ่มได้)`, embeds: [], components: [] }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_cancel') {
      return interaction.update({ content: '❌ ยกเลิกแล้ว ไม่มีการเผยแพร่แผงใดๆ', embeds: [], components: [] }).catch(() => {});
    }

    // ---------- ปุ่มต่างๆ บนแผง Dashboard สาธารณะ (ใครก็กดได้ ตอบกลับแบบเห็นคนเดียว) ----------
    if (interaction.isButton() && interaction.customId === 'dash_rank') {
      const embed = buildRankEmbed(interaction.guildId, interaction.user);
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_leaderboard') {
      const embed = buildLeaderboardEmbed(interaction.guildId);
      if (!embed) return interaction.reply({ content: '📉 ยังไม่มีใครมี XP ในเซิร์ฟเวอร์นี้เลย', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_ai_memory') {
      const embed = await buildUserMemoryEmbed(interaction.guildId, interaction.user);
      if (!embed) return interaction.reply({ content: '🧠 AI ยังไม่มีความทรงจำเกี่ยวกับคุณเลย ลองคุยกันสักพักก่อนนะ', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_dream') {
      const embed = await buildDreamViewEmbed(interaction.guildId);
      if (!embed) return interaction.reply({ content: '🌙 ยังไม่มีความฝันเลย รอคืนนี้ได้เลย', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_laws') {
      const dCfg = getGuildConfig(interaction.guildId);
      const embed = await buildLawsBookEmbed(interaction.guildId, interaction.guild.name, dCfg);
      if (!embed) return interaction.reply({ content: '📜 เซิร์ฟเวอร์นี้ยังไม่มีธรรมนูญเลย', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_relic_inv') {
      const embed = await buildRelicInventoryEmbed(interaction.guildId, interaction.user);
      if (!embed) return interaction.reply({ content: '📦 คุณยังไม่มีของวิเศษสะสมเลย รอลุ้นตอนบอทฝันคืนต่อไปได้เลย!', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_relic_top') {
      const embed = await buildRelicLeaderboardEmbed(interaction.guildId, interaction.guild.name);
      if (!embed) return interaction.reply({ content: '🏺 ยังไม่มีใครคว้าของวิเศษได้เลยในเซิร์ฟเวอร์นี้', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_court_record') {
      const embed = await buildCourtRecordEmbed(interaction.guildId, interaction.user);
      if (!embed) return interaction.reply({ content: '⚖️ คุณยังไม่เคยขึ้นศาลเลย', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_court_cases') {
      const dCfg = getGuildConfig(interaction.guildId);
      const embed = await buildCourtCasesEmbed(interaction.guildId, interaction.guild.name, dCfg);
      if (!embed) return interaction.reply({ content: '⚖️ เซิร์ฟเวอร์นี้ยังไม่เคยมีคดีขึ้นศาลเลย', ephemeral: true }).catch(() => {});
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    // ==========================================
    // 🧑‍🤝‍🧑 18.x ปุ่มฝั่งผู้เล่นบนแผง /เมนู (ถาม AI / สร้างภาพ / ล้างความจำ / สภา AI / คำทำนาย / ดูมาตรา / มอบของวิเศษ / ยื่นฟ้อง / วิธีใช้งาน)
    // ทุกปุ่มที่นี่ "ใครก็กดได้" (ไม่ต้องมีสิทธิ์แอดมิน) เพราะเป็นฟีเจอร์สำหรับผู้เล่นทั่วไป — ตรรกะจริงถูกเรียกผ่านฟังก์ชัน perform* ที่นิยามไว้ใน 16.1-16.2
    // ==========================================
    if (interaction.isButton() && interaction.customId === 'dash_ai_ask') {
      const modal = new ModalBuilder().setCustomId('modal_dash_ai_ask').setTitle('🧠 ถาม AI');
      const input = new TextInputBuilder().setCustomId('question_input').setLabel('คำถามของคุณ').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_ai_imagine') {
      const modal = new ModalBuilder().setCustomId('modal_dash_ai_imagine').setTitle('🎨 สร้างภาพด้วย AI');
      const input = new TextInputBuilder().setCustomId('prompt_input').setLabel('บรรยายภาพที่อยากได้').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_ai_reset') {
      const rGuildId = interaction.guildId;
      if (!rGuildId) return;
      clearConversationHistory(rGuildId, interaction.user.id);
      await storage.clearUserMemory(rGuildId, interaction.user.id).catch(() => {});
      return interaction.reply({ content: '🧹 ล้างความจำบทสนทนา + ความทรงจำเกี่ยวกับคุณที่ AI จำไว้ทั้งหมดแล้ว! เริ่มคุยใหม่ได้เลย', ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_ai_council') {
      const modal = new ModalBuilder().setCustomId('modal_dash_ai_council').setTitle('🏛️ เปิดสภา AI');
      const input = new TextInputBuilder().setCustomId('topic_input').setLabel('หัวข้อที่ต้องการให้ AI โต้วาทีกัน').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_ai_prophecy') {
      const modal = new ModalBuilder().setCustomId('modal_dash_ai_prophecy').setTitle('🔮 ขอคำทำนาย');
      const durationInput = new TextInputBuilder().setCustomId('duration_input').setLabel('ระยะเวลาเปิดผนึก เช่น 1h, 1d (5นาที-7วัน)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
      const topicInput = new TextInputBuilder().setCustomId('topic_input').setLabel('อยากให้ทำนายเรื่องอะไร (ไม่ใส่ = สุ่มเอง)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200);
      modal.addComponents(new ActionRowBuilder().addComponents(durationInput), new ActionRowBuilder().addComponents(topicInput));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_laws_article') {
      const modal = new ModalBuilder().setCustomId('modal_dash_laws_article').setTitle('📖 ดูมาตรากฎหมาย');
      const input = new TextInputBuilder().setCustomId('article_input').setLabel('เลขมาตราที่ต้องการดู').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_relic_gift') {
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('select_dash_relic_gift_target').setPlaceholder('🎁 เลือกเพื่อนที่จะมอบของวิเศษให้').setMinValues(1).setMaxValues(1)
      );
      return interaction.reply({ content: 'เลือกเพื่อนที่จะมอบของวิเศษให้:', components: [row], ephemeral: true }).catch(() => {});
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'select_dash_relic_gift_target') {
      const recipientId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`modal_dash_relic_gift_${recipientId}`).setTitle('🎁 มอบของวิเศษ');
      const input = new TextInputBuilder().setCustomId('article_input').setLabel('เลขไอเทม (#) ของวิเศษที่คุณครอบครองอยู่').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_court_file') {
      const jGuildId = interaction.guildId;
      if (!jGuildId) return;
      const jCfg = getGuildConfig(jGuildId);
      if (!jCfg.courtEnabled) {
        return interaction.reply({ content: '❌ เซิร์ฟเวอร์นี้ยังไม่ได้เปิดระบบศาล', ephemeral: true }).catch(() => {});
      }
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('select_dash_court_defendant').setPlaceholder('🧑‍⚖️ เลือกจำเลยที่จะฟ้อง').setMinValues(1).setMaxValues(1)
      );
      return interaction.reply({ content: 'เลือกสมาชิกที่จะฟ้อง:', components: [row], ephemeral: true }).catch(() => {});
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'select_dash_court_defendant') {
      const defendantId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`modal_dash_court_file_${defendantId}`).setTitle('🧑‍⚖️ ยื่นฟ้องศาล');
      const accusationInput = new TextInputBuilder().setCustomId('accusation_input').setLabel('ข้อกล่าวหา (ขำๆ ไม่ใช่เรื่องจริง)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
      const articleInput = new TextInputBuilder().setCustomId('article_input').setLabel('เลขมาตราที่อ้างอิง (ไม่บังคับ)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(6);
      modal.addComponents(new ActionRowBuilder().addComponents(accusationInput), new ActionRowBuilder().addComponents(articleInput));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'dash_help') {
      return interaction.reply({ embeds: [buildHelpEmbed(PANEL_COMMAND)], ephemeral: true }).catch(() => {});
    }

    // ---------- Modal submit ของฝั่งผู้เล่น (dash_*) ----------
    if (interaction.isModalSubmit() && interaction.customId === 'modal_dash_ai_ask') {
      const mGuildId = interaction.guildId;
      if (!mGuildId) return;
      const question = interaction.fields.getTextInputValue('question_input').trim();
      return performAiAsk(interaction, getGuildConfig(mGuildId), mGuildId, question);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_dash_ai_imagine') {
      const mGuildId = interaction.guildId;
      if (!mGuildId) return;
      const prompt = interaction.fields.getTextInputValue('prompt_input').trim();
      return performAiImagine(interaction, getGuildConfig(mGuildId), mGuildId, prompt);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_dash_ai_council') {
      const mGuildId = interaction.guildId;
      if (!mGuildId) return;
      const topic = interaction.fields.getTextInputValue('topic_input').trim();
      return performAiCouncil(interaction, getGuildConfig(mGuildId), mGuildId, topic);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_dash_ai_prophecy') {
      const mGuildId = interaction.guildId;
      if (!mGuildId) return;
      const durationText = interaction.fields.getTextInputValue('duration_input').trim();
      const topic = interaction.fields.getTextInputValue('topic_input').trim();
      return performAiProphecy(interaction, getGuildConfig(mGuildId), mGuildId, durationText, topic);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_dash_laws_article') {
      const mGuildId = interaction.guildId;
      if (!mGuildId) return;
      const mCfg = getGuildConfig(mGuildId);
      const articleNum = parseInt(interaction.fields.getTextInputValue('article_input').trim(), 10);
      if (!Number.isFinite(articleNum) || articleNum < 1) {
        return interaction.reply({ content: '❌ กรุณาใส่หมายเลขมาตราที่ถูกต้อง', ephemeral: true }).catch(() => {});
      }
      const law = await storage.getLawByArticle(mGuildId, articleNum);
      if (!law) {
        return interaction.reply({ content: `❌ ไม่พบมาตราที่ ${articleNum} (ตอนนี้มีทั้งหมด ${mCfg.lawCounter || 0} มาตรา)`, ephemeral: true }).catch(() => {});
      }
      const embed = new EmbedBuilder().setColor(0xD4AC0D).setTitle(`📜 มาตราที่ ${law.article}`)
        .setDescription(law.content)
        .setFooter({ text: new Date(law.createdAt).toLocaleString('th-TH') });
      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_dash_relic_gift_')) {
      const mGuildId = interaction.guildId;
      if (!mGuildId) return;
      const recipientId = interaction.customId.replace('modal_dash_relic_gift_', '');
      const article = parseInt(interaction.fields.getTextInputValue('article_input').trim(), 10);
      if (!Number.isFinite(article) || article < 1) {
        return interaction.reply({ content: '❌ กรุณาใส่เลขไอเทมที่ถูกต้อง', ephemeral: true }).catch(() => {});
      }
      const recipient = await client.users.fetch(recipientId).catch(() => null);
      if (!recipient) {
        return interaction.reply({ content: '❌ ไม่พบผู้ใช้ที่เลือกไว้ ลองใหม่อีกครั้ง', ephemeral: true }).catch(() => {});
      }
      return performRelicGift(interaction, mGuildId, recipient, article);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_dash_court_file_')) {
      const mGuildId = interaction.guildId;
      if (!mGuildId) return;
      const defendantId = interaction.customId.replace('modal_dash_court_file_', '');
      const accusation = interaction.fields.getTextInputValue('accusation_input').trim();
      const articleRaw = interaction.fields.getTextInputValue('article_input').trim();
      const articleRef = articleRaw ? parseInt(articleRaw, 10) : null;
      const defendant = await client.users.fetch(defendantId).catch(() => null);
      if (!defendant) {
        return interaction.reply({ content: '❌ ไม่พบผู้ใช้ที่เลือกไว้ ลองใหม่อีกครั้ง', ephemeral: true }).catch(() => {});
      }
      return performCourtFile(interaction, getGuildConfig(mGuildId), mGuildId, defendant, accusation, articleRef && Number.isFinite(articleRef) ? articleRef : null);
    }

    // ==========================================
    // 🛡️ 18.y ปุ่มดูแลเซิร์ฟเวอร์บนแผงแอดมิน (kick/ban/unban/timeout/untimeout/warn/warnings/clearwarnings/purge)
    // แต่ละปุ่มเช็คสิทธิ์ Discord เฉพาะทางของตัวเอง (ไม่ใช้ checkHasPermission ทั่วไป) เพื่อให้มอดที่มีแค่สิทธิ์นั้นๆ ใช้งานได้เหมือน /server mod เดิม
    // ==========================================
    const modSelectMap = { kick: 'modsel_kick', ban: 'modsel_ban', timeout: 'modsel_timeout', warn: 'modsel_warn', warnings: 'modsel_warnings', clearwarnings: 'modsel_clearwarnings', untimeout: 'modsel_untimeout' };
    if (interaction.isButton() && interaction.customId.startsWith('btn_mod_') && interaction.customId !== 'btn_mod_unban' && interaction.customId !== 'btn_mod_purge') {
      const action = interaction.customId.replace('btn_mod_', '');
      const permMap = {
        kick: PermissionFlagsBits.KickMembers, ban: PermissionFlagsBits.BanMembers,
        timeout: PermissionFlagsBits.ModerateMembers, untimeout: PermissionFlagsBits.ModerateMembers,
        warn: PermissionFlagsBits.ModerateMembers, warnings: PermissionFlagsBits.ModerateMembers, clearwarnings: PermissionFlagsBits.ModerateMembers,
      };
      if (!checkModPermission(interaction, permMap[action])) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ทำรายการนี้', ephemeral: true }).catch(() => {});
      }
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(modSelectMap[action]).setPlaceholder('เลือกสมาชิกเป้าหมาย').setMinValues(1).setMaxValues(1)
      );
      return interaction.reply({ content: 'เลือกสมาชิกเป้าหมาย:', components: [row], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_mod_unban') {
      if (!checkModPermission(interaction, PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ปลดแบนสมาชิก (ต้องมีสิทธิ์ Ban Members)', ephemeral: true }).catch(() => {});
      }
      const modal = new ModalBuilder().setCustomId('modal_mod_unban').setTitle('🔓 ปลดแบนสมาชิก');
      const input = new TextInputBuilder().setCustomId('user_id_input').setLabel('User ID ของผู้ที่ถูกแบน').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_mod_purge') {
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ลบข้อความ (ต้องมีสิทธิ์ Manage Messages)', ephemeral: true }).catch(() => {});
      }
      const modal = new ModalBuilder().setCustomId('modal_mod_purge').setTitle('🧹 ลบข้อความจำนวนมาก');
      const input = new TextInputBuilder().setCustomId('amount_input').setLabel('จำนวนข้อความที่จะลบ (1-100)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'modsel_kick') {
      const targetId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`panelmodreason_kick_${targetId}`).setTitle('👢 เตะสมาชิก');
      const input = new TextInputBuilder().setCustomId('reason_input').setLabel('เหตุผล (ไม่บังคับ)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'modsel_ban') {
      const targetId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`panelmodreason_ban_${targetId}`).setTitle('🔨 แบนสมาชิก');
      const reasonInput = new TextInputBuilder().setCustomId('reason_input').setLabel('เหตุผล (ไม่บังคับ)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300);
      const daysInput = new TextInputBuilder().setCustomId('deletedays_input').setLabel('ลบข้อความย้อนหลังกี่วัน (0-7)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(1).setValue('0');
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput), new ActionRowBuilder().addComponents(daysInput));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'modsel_timeout') {
      const targetId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`panelmodreason_timeout_${targetId}`).setTitle('🔇 Timeout สมาชิก');
      const durationInput = new TextInputBuilder().setCustomId('duration_input').setLabel('ระยะเวลา เช่น 10m, 1h, 1d (สูงสุด 28วัน)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
      const reasonInput = new TextInputBuilder().setCustomId('reason_input').setLabel('เหตุผล (ไม่บังคับ)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300);
      modal.addComponents(new ActionRowBuilder().addComponents(durationInput), new ActionRowBuilder().addComponents(reasonInput));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'modsel_warn') {
      const targetId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`panelmodreason_warn_${targetId}`).setTitle('⚠️ เตือนสมาชิก');
      const input = new TextInputBuilder().setCustomId('reason_input').setLabel('เหตุผลในการเตือน').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'modsel_warnings') {
      return doWarningsView(interaction, interaction.values[0]);
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'modsel_clearwarnings') {
      return doClearWarningsAction(interaction, interaction.guildId, interaction.values[0]);
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId === 'modsel_untimeout') {
      return doUntimeoutAction(interaction, interaction.values[0]);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('panelmodreason_')) {
      const modGuildId = interaction.guildId;
      if (!modGuildId) return;
      const modCfg = getGuildConfig(modGuildId);
      const parts = interaction.customId.split('_'); // panelmodreason, action, targetId
      const action = parts[1];
      const targetUserId = parts[2];
      if (action === 'kick') {
        const reason = interaction.fields.getTextInputValue('reason_input').trim() || 'ไม่ระบุเหตุผล';
        return doKickAction(interaction, modCfg, targetUserId, reason);
      }
      if (action === 'ban') {
        const reason = interaction.fields.getTextInputValue('reason_input').trim() || 'ไม่ระบุเหตุผล';
        const deleteDaysRaw = parseInt(interaction.fields.getTextInputValue('deletedays_input').trim(), 10);
        const deleteDays = Number.isFinite(deleteDaysRaw) ? Math.min(7, Math.max(0, deleteDaysRaw)) : 0;
        return doBanAction(interaction, modCfg, targetUserId, reason, deleteDays);
      }
      if (action === 'timeout') {
        const durationText = interaction.fields.getTextInputValue('duration_input').trim();
        const reason = interaction.fields.getTextInputValue('reason_input').trim() || 'ไม่ระบุเหตุผล';
        const durationMs = parseDuration(durationText);
        const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
        if (!durationMs || durationMs < 5000 || durationMs > MAX_TIMEOUT_MS) {
          return interaction.reply({ content: '❌ ระยะเวลาไม่ถูกต้อง ใช้รูปแบบเช่น `10m` `1h` `1d` (สูงสุด 28 วัน)', ephemeral: true }).catch(() => {});
        }
        return doTimeoutAction(interaction, modCfg, targetUserId, durationMs, durationText, reason);
      }
      if (action === 'warn') {
        const reason = interaction.fields.getTextInputValue('reason_input').trim();
        return doWarnAction(interaction, modCfg, targetUserId, reason);
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_mod_unban') {
      if (!checkModPermission(interaction, PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ปลดแบนสมาชิก', ephemeral: true }).catch(() => {});
      }
      const userId = interaction.fields.getTextInputValue('user_id_input').trim();
      return doUnbanAction(interaction, userId);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_mod_purge') {
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ลบข้อความ', ephemeral: true }).catch(() => {});
      }
      const amount = parseInt(interaction.fields.getTextInputValue('amount_input').trim(), 10);
      if (!Number.isFinite(amount) || amount < 1 || amount > 100) {
        return interaction.reply({ content: '❌ จำนวนต้องอยู่ระหว่าง 1-100', ephemeral: true }).catch(() => {});
      }
      return doPurgeAction(interaction, amount);
    }

    // ==========================================
    // 🧭 18.z ปุ่มนำทางหน้าใหม่บนแผงแอดมิน (moderation/automod/ticket/antiraid/community) — เช็คสิทธิ์เฉพาะทางก่อนเข้าหน้า
    // ==========================================
    if (interaction.isButton() && interaction.customId === 'nav_moderation') {
      const nGuildId = interaction.guildId;
      if (!nGuildId) return;
      if (!hasAnyModPermission(interaction)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์เปิดหน้านี้', ephemeral: true }).catch(() => {});
      }
      return renderPanel(interaction, 'moderation', nGuildId, getGuildConfig(nGuildId));
    }
    if (interaction.isButton() && ['nav_automod', 'nav_ticket', 'nav_antiraid', 'nav_community'].includes(interaction.customId)) {
      const nGuildId = interaction.guildId;
      if (!nGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์เปิดหน้านี้ (ต้องมีสิทธิ์ Manage Server)', ephemeral: true }).catch(() => {});
      }
      const pageMap = { nav_automod: 'automod', nav_ticket: 'ticket', nav_antiraid: 'antiraid', nav_community: 'community' };
      return renderPanel(interaction, pageMap[interaction.customId], nGuildId, getGuildConfig(nGuildId));
    }

    // ==========================================
    // 🧹 18.a หน้า Automod บนแผงแอดมิน (ทุกปุ่ม/Modal ต้องมีสิทธิ์ Manage Server เหมือน /server automod เดิม)
    // ==========================================
    if ((interaction.isButton() && ['btn_toggle_automod', 'btn_toggle_automod_links', 'btn_toggle_automod_invites', 'btn_set_automod_config', 'btn_set_automod_words'].includes(interaction.customId))
      || (interaction.isModalSubmit() && ['modal_automod_config', 'modal_automod_words'].includes(interaction.customId))) {
      const aGuildId = interaction.guildId;
      if (!aGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ตั้งค่า Automod (ต้องมีสิทธิ์ Manage Server)', ephemeral: true }).catch(() => {});
      }
      const aCfg = getGuildConfig(aGuildId);

      if (interaction.customId === 'btn_toggle_automod') {
        aCfg.automodEnabled = !aCfg.automodEnabled;
        return renderPanel(interaction, 'automod', aGuildId, aCfg);
      }
      if (interaction.customId === 'btn_toggle_automod_links') {
        aCfg.automodBlockLinks = !aCfg.automodBlockLinks;
        return renderPanel(interaction, 'automod', aGuildId, aCfg);
      }
      if (interaction.customId === 'btn_toggle_automod_invites') {
        aCfg.automodBlockInvites = !aCfg.automodBlockInvites;
        return renderPanel(interaction, 'automod', aGuildId, aCfg);
      }
      if (interaction.customId === 'btn_set_automod_config') {
        const modal = new ModalBuilder().setCustomId('modal_automod_config').setTitle('⚙️ ตั้งค่า Automod เพิ่มเติม');
        const mentionsInput = new TextInputBuilder().setCustomId('mentions_input').setLabel('เมนชันสูงสุด/ข้อความ (0 = ปิด)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(aCfg.automodMaxMentions ?? 0)).setMaxLength(3);
        const actionInput = new TextInputBuilder().setCustomId('action_input').setLabel('การลงโทษ: delete / warn / timeout').setStyle(TextInputStyle.Short).setRequired(false).setValue(aCfg.automodAction || 'delete').setMaxLength(10);
        const timeoutInput = new TextInputBuilder().setCustomId('timeout_input').setLabel('วินาที Timeout (ถ้าเลือกลงโทษเป็น timeout)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(aCfg.automodTimeoutSeconds || 300)).setMaxLength(7);
        modal.addComponents(
          new ActionRowBuilder().addComponents(mentionsInput),
          new ActionRowBuilder().addComponents(actionInput),
          new ActionRowBuilder().addComponents(timeoutInput),
        );
        return interaction.showModal(modal).catch(() => {});
      }
      if (interaction.customId === 'btn_set_automod_words') {
        const modal = new ModalBuilder().setCustomId('modal_automod_words').setTitle('📋 แก้ไขคำต้องห้าม');
        const input = new TextInputBuilder().setCustomId('words_input').setLabel('คำต้องห้ามทั้งหมด (คั่นด้วย , )').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(aCfg.automodBadWords || '').setMaxLength(3000);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal).catch(() => {});
      }
      if (interaction.customId === 'modal_automod_config') {
        const mentions = parseInt(interaction.fields.getTextInputValue('mentions_input').trim(), 10);
        const action = interaction.fields.getTextInputValue('action_input').trim().toLowerCase();
        const timeoutSeconds = parseInt(interaction.fields.getTextInputValue('timeout_input').trim(), 10);
        if (Number.isFinite(mentions) && mentions >= 0) aCfg.automodMaxMentions = mentions;
        if (['delete', 'warn', 'timeout'].includes(action)) aCfg.automodAction = action;
        if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 5) aCfg.automodTimeoutSeconds = timeoutSeconds;
        return renderPanel(interaction, 'automod', aGuildId, aCfg);
      }
      if (interaction.customId === 'modal_automod_words') {
        const raw = interaction.fields.getTextInputValue('words_input').trim();
        aCfg.automodBadWords = parseWordList(raw).join(',');
        return renderPanel(interaction, 'automod', aGuildId, aCfg);
      }
    }

    // ==========================================
    // 🎫 18.b หน้า Ticket บนแผงแอดมิน (ต้องมีสิทธิ์ Manage Server เหมือน /server ticket setup เดิม)
    // ==========================================
    if ((interaction.isChannelSelectMenu?.() && interaction.customId === 'select_ticket_category')
      || (interaction.isRoleSelectMenu?.() && interaction.customId === 'select_ticket_staff_role')
      || (interaction.isButton() && interaction.customId === 'btn_ticket_post')) {
      const tGuildId = interaction.guildId;
      if (!tGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ตั้งค่า Ticket (ต้องมีสิทธิ์ Manage Server)', ephemeral: true }).catch(() => {});
      }
      const tCfg = getGuildConfig(tGuildId);

      if (interaction.customId === 'select_ticket_category') {
        tCfg.ticketCategoryId = interaction.values[0] || '';
        return renderPanel(interaction, 'ticket', tGuildId, tCfg);
      }
      if (interaction.customId === 'select_ticket_staff_role') {
        tCfg.ticketStaffRoleId = interaction.values[0] || '';
        return renderPanel(interaction, 'ticket', tGuildId, tCfg);
      }
      if (interaction.customId === 'btn_ticket_post') {
        if (!tCfg.ticketCategoryId || !tCfg.ticketStaffRoleId) {
          return interaction.reply({ content: '❌ ต้องเลือกหมวดหมู่และยศทีมงานให้ครบก่อน', ephemeral: true }).catch(() => {});
        }
        const setupEmbed = new EmbedBuilder().setColor(0x3498DB).setTitle('🎫 ติดต่อทีมงาน')
          .setDescription('กดปุ่มด้านล่างเพื่อเปิดช่องแชทส่วนตัวกับทีมงาน — ไม่ต้องพิมพ์คำสั่งใดๆ');
        const openBtn = new ButtonBuilder().setCustomId('ticket_open').setLabel('🎫 เปิด Ticket').setStyle(ButtonStyle.Primary);
        await interaction.channel.send({ embeds: [setupEmbed], components: [new ActionRowBuilder().addComponents(openBtn)] }).catch(() => {});
        return interaction.reply({ content: '✅ โพสต์ปุ่มเปิด Ticket ในห้องนี้แล้ว', ephemeral: true }).catch(() => {});
      }
    }

    // ==========================================
    // 🚨 18.c หน้า Anti-Raid บนแผงแอดมิน (ต้องมีสิทธิ์ Manage Server เหมือน /server antiraid เดิม)
    // ==========================================
    if ((interaction.isButton() && ['btn_toggle_antiraid', 'btn_set_antiraid_config', 'btn_antiraid_unlock'].includes(interaction.customId))
      || (interaction.isStringSelectMenu?.() && interaction.customId === 'select_antiraid_action')
      || (interaction.isModalSubmit() && interaction.customId === 'modal_antiraid_config')) {
      const rGuildId = interaction.guildId;
      if (!rGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ตั้งค่า Anti-Raid (ต้องมีสิทธิ์ Manage Server)', ephemeral: true }).catch(() => {});
      }
      const rCfg = getGuildConfig(rGuildId);

      if (interaction.customId === 'btn_toggle_antiraid') {
        rCfg.antiRaidEnabled = !rCfg.antiRaidEnabled;
        return renderPanel(interaction, 'antiraid', rGuildId, rCfg);
      }
      if (interaction.customId === 'select_antiraid_action') {
        rCfg.antiRaidAction = interaction.values[0];
        return renderPanel(interaction, 'antiraid', rGuildId, rCfg);
      }
      if (interaction.customId === 'btn_antiraid_unlock') {
        if (!raidOriginalVerificationLevel.has(rGuildId)) {
          return interaction.reply({ content: 'ℹ️ ตอนนี้ Verification Level อยู่ในสถานะปกติอยู่แล้ว', ephemeral: true }).catch(() => {});
        }
        const original = raidOriginalVerificationLevel.get(rGuildId);
        raidOriginalVerificationLevel.delete(rGuildId);
        await interaction.guild.setVerificationLevel(original, `Anti-Raid: ปลดล็อกด้วยตนเองโดย ${interaction.user.tag}`).catch(() => {});
        return renderPanel(interaction, 'antiraid', rGuildId, rCfg);
      }
      if (interaction.customId === 'btn_set_antiraid_config') {
        const modal = new ModalBuilder().setCustomId('modal_antiraid_config').setTitle('⚙️ ตั้งค่าเกณฑ์ Anti-Raid');
        const thresholdInput = new TextInputBuilder().setCustomId('threshold_input').setLabel('จำนวนคนขั้นต่ำที่ถือว่าผิดปกติ').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(rCfg.antiRaidJoinThreshold || 10)).setMaxLength(4);
        const windowInput = new TextInputBuilder().setCustomId('window_input').setLabel('นับภายในกี่วินาที').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(rCfg.antiRaidWindowSeconds || 30)).setMaxLength(4);
        const minAgeInput = new TextInputBuilder().setCustomId('minage_input').setLabel('อายุบัญชีขั้นต่ำ (วัน)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(rCfg.antiRaidMinAccountAgeDays || 0)).setMaxLength(4);
        modal.addComponents(
          new ActionRowBuilder().addComponents(thresholdInput),
          new ActionRowBuilder().addComponents(windowInput),
          new ActionRowBuilder().addComponents(minAgeInput),
        );
        return interaction.showModal(modal).catch(() => {});
      }
      if (interaction.customId === 'modal_antiraid_config') {
        const threshold = parseInt(interaction.fields.getTextInputValue('threshold_input').trim(), 10);
        const windowSeconds = parseInt(interaction.fields.getTextInputValue('window_input').trim(), 10);
        const minAge = parseInt(interaction.fields.getTextInputValue('minage_input').trim(), 10);
        if (Number.isFinite(threshold) && threshold >= 3) rCfg.antiRaidJoinThreshold = threshold;
        if (Number.isFinite(windowSeconds) && windowSeconds >= 5) rCfg.antiRaidWindowSeconds = windowSeconds;
        if (Number.isFinite(minAge) && minAge >= 0) rCfg.antiRaidMinAccountAgeDays = minAge;
        return renderPanel(interaction, 'antiraid', rGuildId, rCfg);
      }
    }

    // ==========================================
    // 🌙 18.d หน้าระบบชุมชนบนแผงแอดมิน (ต้องมีสิทธิ์ Manage Server เหมือน /community dream|laws|relic|court setup/on/off เดิม)
    // ปุ่มเริ่ม/จบ/สุ่มกิจกรรมแจกของยังใช้สิทธิ์ checkHasPermission ตามพฤติกรรมเดิมของ /community giveaway
    // ==========================================
    if ((interaction.isButton() && ['btn_toggle_dream', 'btn_toggle_laws', 'btn_toggle_relic', 'btn_toggle_court', 'btn_dream_now'].includes(interaction.customId))
      || (interaction.isChannelSelectMenu?.() && ['select_dream_channel', 'select_laws_channel'].includes(interaction.customId))) {
      const cGuildId = interaction.guildId;
      if (!cGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ตั้งค่าระบบนี้ (ต้องมีสิทธิ์ Manage Server)', ephemeral: true }).catch(() => {});
      }
      const cCfg = getGuildConfig(cGuildId);

      if (interaction.customId === 'btn_toggle_dream') {
        if (!cCfg.dreamEnabled && !cCfg.dreamChannelId) {
          return interaction.reply({ content: '❌ ต้องเลือกห้องความฝันก่อนเปิดใช้งาน', ephemeral: true }).catch(() => {});
        }
        cCfg.dreamEnabled = !cCfg.dreamEnabled;
        return renderPanel(interaction, 'community', cGuildId, cCfg);
      }
      if (interaction.customId === 'btn_toggle_laws') {
        cCfg.lawsEnabled = !cCfg.lawsEnabled;
        return renderPanel(interaction, 'community', cGuildId, cCfg);
      }
      if (interaction.customId === 'btn_toggle_relic') {
        if (!cCfg.relicsEnabled && !cCfg.dreamChannelId) {
          return interaction.reply({ content: '❌ ต้องเลือกห้องความฝันก่อน เพราะของวิเศษหลุดออกมาในห้องเดียวกับความฝัน', ephemeral: true }).catch(() => {});
        }
        cCfg.relicsEnabled = !cCfg.relicsEnabled;
        return renderPanel(interaction, 'community', cGuildId, cCfg);
      }
      if (interaction.customId === 'btn_toggle_court') {
        cCfg.courtEnabled = !cCfg.courtEnabled;
        return renderPanel(interaction, 'community', cGuildId, cCfg);
      }
      if (interaction.customId === 'btn_dream_now') {
        return performDreamNow(interaction, cCfg, cGuildId);
      }
      if (interaction.customId === 'select_dream_channel') {
        cCfg.dreamChannelId = interaction.values[0] || '';
        return renderPanel(interaction, 'community', cGuildId, cCfg);
      }
      if (interaction.customId === 'select_laws_channel') {
        cCfg.lawsChannelId = interaction.values[0] || '';
        return renderPanel(interaction, 'community', cGuildId, cCfg);
      }
    }

    if (interaction.isButton() && ['btn_giveaway_start', 'btn_giveaway_end', 'btn_giveaway_reroll'].includes(interaction.customId)) {
      if (!checkHasPermission(interaction.user.id, interaction.member, interaction.guildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์จัดการกิจกรรมนี้', ephemeral: true }).catch(() => {});
      }
      if (interaction.customId === 'btn_giveaway_start') {
        const modal = new ModalBuilder().setCustomId('modal_giveaway_start').setTitle('🎉 เริ่มกิจกรรมแจกของ');
        const durationInput = new TextInputBuilder().setCustomId('duration_input').setLabel('ระยะเวลา เช่น 30s, 10m, 2h, 1d').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
        const prizeInput = new TextInputBuilder().setCustomId('prize_input').setLabel('ของรางวัล').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
        const winnersInput = new TextInputBuilder().setCustomId('winners_input').setLabel('จำนวนผู้ชนะ (ค่าเริ่มต้น 1)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3);
        modal.addComponents(
          new ActionRowBuilder().addComponents(durationInput),
          new ActionRowBuilder().addComponents(prizeInput),
          new ActionRowBuilder().addComponents(winnersInput),
        );
        return interaction.showModal(modal).catch(() => {});
      }
      if (interaction.customId === 'btn_giveaway_end') {
        const modal = new ModalBuilder().setCustomId('modal_giveaway_end').setTitle('🏁 จบกิจกรรม');
        const input = new TextInputBuilder().setCustomId('message_id_input').setLabel('ID ของข้อความกิจกรรม').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal).catch(() => {});
      }
      if (interaction.customId === 'btn_giveaway_reroll') {
        const modal = new ModalBuilder().setCustomId('modal_giveaway_reroll').setTitle('🔄 สุ่มผู้ชนะใหม่');
        const input = new TextInputBuilder().setCustomId('message_id_input').setLabel('ID ของข้อความกิจกรรม').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal).catch(() => {});
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_giveaway_start') {
      const gGuildId = interaction.guildId;
      if (!gGuildId) return;
      if (!checkHasPermission(interaction.user.id, interaction.member, gGuildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์เริ่มกิจกรรมนี้', ephemeral: true }).catch(() => {});
      }
      const durationText = interaction.fields.getTextInputValue('duration_input').trim();
      const prize = interaction.fields.getTextInputValue('prize_input').trim();
      const winnersRaw = parseInt(interaction.fields.getTextInputValue('winners_input').trim(), 10);
      const winnerCount = Number.isFinite(winnersRaw) && winnersRaw > 0 ? Math.min(20, winnersRaw) : 1;
      return performGiveawayStart(interaction, getGuildConfig(gGuildId), gGuildId, durationText, prize, winnerCount);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_giveaway_end') {
      const gGuildId = interaction.guildId;
      if (!gGuildId) return;
      if (!checkHasPermission(interaction.user.id, interaction.member, gGuildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์จบกิจกรรมนี้', ephemeral: true }).catch(() => {});
      }
      const messageId = interaction.fields.getTextInputValue('message_id_input').trim();
      return performGiveawayEnd(interaction, gGuildId, messageId);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_giveaway_reroll') {
      const gGuildId = interaction.guildId;
      if (!gGuildId) return;
      if (!checkHasPermission(interaction.user.id, interaction.member, gGuildId)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์สุ่มผู้ชนะใหม่', ephemeral: true }).catch(() => {});
      }
      const messageId = interaction.fields.getTextInputValue('message_id_input').trim();
      return performGiveawayReroll(interaction, gGuildId, messageId);
    }

    // ==========================================
    // 📌 18.e ปุ่มปักหมุด/อัปเดตแผงสมาชิก (ย้ายมาจาก /bot dashboard setup|refresh เดิม — ใช้ปุ่ม dash_publish_/dash_cancel เดิมที่มีอยู่แล้วด้านล่าง)
    // ==========================================
    if (interaction.isButton() && interaction.customId === 'btn_dashboard_setup') {
      const dGuildId = interaction.guildId;
      if (!dGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ตั้งค่าแผง Dashboard (ต้องมีสิทธิ์ Manage Server)', ephemeral: true }).catch(() => {});
      }
      const dCfg = getGuildConfig(dGuildId);
      const targetChannel = interaction.channel;
      const { embed, rows } = buildDashboardPayload(interaction.guild, dCfg);
      const previewEmbed = EmbedBuilder.from(embed)
        .setFooter({ text: `👀 นี่คือตัวอย่างเท่านั้น (เห็นแค่คุณคนเดียว) — จะโพสต์ลงห้อง #${targetChannel.name} ก็ต่อเมื่อกดยืนยันด้านล่าง` });
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash_publish_${targetChannel.id}`).setLabel('✅ เผยแพร่ถาวรลงห้องนี้').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('dash_cancel').setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Danger),
      );
      return interaction.reply({ embeds: [previewEmbed], components: [...rows, confirmRow], ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'btn_dashboard_refresh') {
      const dGuildId = interaction.guildId;
      if (!dGuildId) return;
      if (!checkModPermission(interaction, PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์อัปเดตแผง Dashboard (ต้องมีสิทธิ์ Manage Server)', ephemeral: true }).catch(() => {});
      }
      const dCfg = getGuildConfig(dGuildId);
      if (!dCfg.dashboardChannelId || !dCfg.dashboardMessageId) {
        return interaction.reply({ content: '❌ ยังไม่เคยปักหมุดแผงสมาชิกเลย กดปุ่ม "📌 ปักหมุดแผงสมาชิกในห้องนี้" ก่อน', ephemeral: true }).catch(() => {});
      }
      const channel = await interaction.guild.channels.fetch(dCfg.dashboardChannelId).catch(() => null);
      const message = channel ? await channel.messages.fetch(dCfg.dashboardMessageId).catch(() => null) : null;
      if (!channel || !message) {
        return interaction.reply({ content: '❌ หาข้อความแผงเดิมไม่เจอ (อาจถูกลบไปแล้ว) กดปักหมุดใหม่อีกครั้ง', ephemeral: true }).catch(() => {});
      }
      const { embed, rows } = buildDashboardPayload(interaction.guild, dCfg);
      await message.edit({ embeds: [embed], components: rows }).catch(() => {});
      return interaction.reply({ content: `✅ อัปเดตปุ่มบนแผงที่ ${channel} เรียบร้อยแล้ว`, ephemeral: true }).catch(() => {});
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
    // ปิดแผง (dismiss) — ใครก็กดได้เสมอไม่ต้องมีสิทธิ์ เพราะแค่ปิดข้อความที่ตัวเองเห็นอยู่ ไม่ใช่การตั้งค่าอะไร
    if (interaction.isButton() && interaction.customId === 'btn_close_panel') {
      stopStatsAutoRefresh(interaction.message.id);
      await interaction.deferUpdate().catch(() => {});
      return interaction.message.delete().catch(() => {});
    }

    const panelButtonIds = [
      'nav_main', 'nav_ai', 'nav_advanced', 'nav_access', 'nav_stats', 'nav_leveling', 'nav_welcome',
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
      renderPage = 'hub';
    } else if (interaction.isButton() && interaction.customId === 'nav_ai') {
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

// ==========================================
// 🎛️ lib/panels.js
// ชั้นสร้างหน้าตา UI ทั้งหมด (Embed/Button/Select ของแผงควบคุมทุกหน้า + Embed ของฟีเจอร์ต่างๆ)
// เป็นฟังก์ชัน "บริสุทธิ์" ล้วนๆ: รับ cfg/ข้อมูล เข้ามา คืนค่า payload ออกไป ไม่มีการเรียก Discord API เอง
// ==========================================
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelType,
} = require('discord.js');
const { MODE_LABELS, calculateLevel, parseRoleRewards, parseWordList, globalConfig } = require('./storage');
const { parseApiKeys, detectApiProvider, IMAGE_GEN_COOLDOWN_SECONDS } = require('./ai');

// ป้ายชื่อภาษาไทยของตัวเลือก "การดำเนินการ" ของระบบ Anti-Raid (ใช้ทั้งใน embed สถานะ และ StringSelectMenu)
const ANTIRAID_ACTION_LABELS = {
  alert: 'แจ้งเตือนอย่างเดียว',
  kick_new_accounts: 'เตะบัญชีใหม่อัตโนมัติ',
  raise_verification: 'ยกระดับ Verification ชั่วคราว',
};

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

function buildImagineEmbed(prompt, authorTag) {
  return new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('🎨 สร้างภาพเสร็จแล้ว')
    .setDescription(`พรอมต์: ${prompt.slice(0, 200)}`)
    .setImage('attachment://imagine.png')
    .setFooter({ text: `ขอโดย ${authorTag} • Pollinations AI (ฟรี ไม่ต้องมี API Key)` });
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
      `🎨 สร้างภาพด้วย AI (/ai imagine): ${cfg.imageGenEnabled ? `เปิด (กันสแปม ${IMAGE_GEN_COOLDOWN_SECONDS} วิ)` : 'ปิด'}`
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
    .setFooter({ text: 'ใช้ /community level rank ดูเลเวลตัวเอง และ /community level leaderboard ดูอันดับ (หรือ !rank, !leaderboard)' });

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

function buildHelpEmbed(panelCommand) {
  return new EmbedBuilder()
    .setTitle('📖 วิธีใช้งานบอท')
    .setColor(0x9B59B6)
    .setDescription(
      `**ตอนนี้บอทเหลือแค่ 2 คำสั่งเท่านั้น ที่เหลือทำผ่านปุ่ม/เมนู/ช่องกรอกบนแผงทั้งหมด**\n\n` +
      `**🧑‍🤝‍🧑 \`/เมนู\` — สำหรับสมาชิกทุกคน**\n` +
      `เปิดแผงส่วนตัว (เห็นเฉพาะคุณ) รวมทุกอย่าง: 🧠 ถาม AI • 🎨 สร้างภาพ • 🧹 ล้างความจำ • 🏛️ เปิดสภา AI • 🔮 ขอคำทำนาย • 🏅 เลเวล/อันดับ XP • 🌙 ความฝัน • 📜 ธรรมนูญ/ดูมาตรา • 🏺 คลังของวิเศษ/มอบให้เพื่อน • ⚖️ ยื่นฟ้องศาล/ดูสถิติ • 🎫 เปิด Ticket — กดปุ่มไหนก็จะเด้งเมนูเลือกหรือช่องกรอกให้เอง (ปุ่มจะโชว์เฉพาะระบบที่แอดมินเปิดใช้งานอยู่)\n` +
      `พิมพ์คุยกับบอทตรงๆ ในห้องที่กำหนดก็ได้เหมือนเดิม (บอทจำบทสนทนาต่อเนื่อง + จดจำนิสัย/ความรู้สึกที่มีต่อคุณ)\n\n` +
      `**🎛️ \`/แผงแอดมิน\` หรือ \`${panelCommand}\` — สำหรับแอดมิน/ผู้ดูแลเซิร์ฟเวอร์**\n` +
      `เปิดแผงศูนย์กลาง แล้วเลือกหมวดจากปุ่ม:\n` +
      `• 🧠 ตั้งค่า AI — prompt, API key, cooldown, รูปแบบคำตอบ, สี Embed ฯลฯ\n` +
      `• 🛡️ ดูแลเซิร์ฟเวอร์ — เตะ/แบน/ปลดแบน/timeout/เตือน/ล้างประวัติเตือน/ลบข้อความจำนวนมาก (เลือกสมาชิกจากเมนู)\n` +
      `• 🧹 Automod — กรองคำต้องห้าม/ลิงก์/สแปมเมนชันอัตโนมัติ\n` +
      `• 🚨 Anti-Raid — ตรวจจับ+ป้องกันการโจมตีเซิร์ฟเวอร์อัตโนมัติ\n` +
      `• 🎫 Ticket — ตั้งค่า+โพสต์ปุ่มเปิด Ticket ติดต่อทีมงาน\n` +
      `• 🌙 ระบบชุมชน — เปิด/ปิดความฝัน/ธรรมนูญ/ของวิเศษ/ศาล + เริ่ม/จบ/สุ่มผู้ชนะกิจกรรมแจกของ\n` +
      `• 🏆 เลเวล • 👋 ต้อนรับ/อำลา • 🚫 สิทธิ์การใช้ • ⚙️ ขั้นสูง • 📊 สถิติ — เหมือนเดิมทุกอย่าง\n` +
      `• 📌 ปักหมุดแผงสมาชิกถาวรในห้องนี้ (ให้สมาชิกกดได้โดยไม่ต้องพิมพ์ \`/เมนู\` เอง)\n\n` +
      `**⚡ ทางลัด: คลิกขวาแทนการพิมพ์คำสั่ง!**\n` +
      `คลิกขวา (หรือแตะค้าง) ที่ชื่อสมาชิกในแชท → เลือก **Apps** → จะเจอเมนู เตะสมาชิก / แบนสมาชิก / Timeout 10 นาที / Timeout 1 ชั่วโมง / เตือนสมาชิก / ดูประวัติเตือน ได้เลยโดยไม่ต้องพิมพ์คำสั่งหรือแท็กใครเอง (บางเมนูจะเด้งช่องกรอกเหตุผลสั้นๆ ให้กรอกก่อนยืนยัน)\n\n` +
      `**คำสั่งพิมพ์แบบย่อ (ยังใช้ได้เหมือนเดิม)**\n` +
      `\`!help\` \`!ping\` \`!reset\`/\`!ลืม\` \`!stats\` \`!avatar\` \`!rank\` \`!leaderboard\` \`!imagine <พรอมต์>\` \`${panelCommand}\`\n\n` +
      `**ฟีเจอร์เด่น**\n` +
      `🧠 จำบทสนทนาต่อเนื่องแบบเรียลไทม์ + จำนิสัย/ความรู้สึกที่มีต่อแต่ละคนแยกกัน • 🌐 รองรับหลายค่าย AI พร้อมสำรองอัตโนมัติ (แม้ Key หมดโควต้าก็สลับให้เอง) • 📊 นับ+จำกัดโควต้าโทเคน AI ต่อวันได้จริง • ` +
      `📈 หน้าสถิติอัปเดตสด • 🏆 ระบบเลเวล/XP พร้อมยศรางวัลอัตโนมัติ • 🎨 สร้างภาพด้วย AI ฟรี • 👋 ต้อนรับ/อำลาสมาชิก + ยศอัตโนมัติ • 🎉 จัดกิจกรรมแจกของรางวัล • 🏛️ สภา AI โต้วาทีสด • 🔮 ผนึกคำทำนาย AI เปิดเผยเอง • 🚫 ระบบ Blacklist/Whitelist • ` +
      `🧾 ปรับรูปแบบคำตอบ (ข้อความ/Embed) • 🔄 ปุ่มตอบใหม่ (Regenerate) • 🛡️ ระบบดูแลเซิร์ฟเวอร์ครบชุด • 🎫 ระบบ Ticket ติดต่อทีมงานส่วนตัว • 🚨 Anti-Raid ตรวจจับการโจมตีเซิร์ฟเวอร์อัตโนมัติ • 🌙 ความฝันของบอท (Dream Journal) แต่งตำนานเซิร์ฟเวอร์จากเหตุการณ์จริงทุกวัน • 📜 ธรรมนูญเซิร์ฟเวอร์ (Living Law Book) • 🏺 เกมล่าของวิเศษจากฝัน (Dream Relic Hunt) • ⚖️ ศาลเซิร์ฟเวอร์ (Server Court) • 🎛️ แผงข้อมูลสมาชิกถาวรแบบกดปุ่ม (Dashboard) ไม่ต้องพิมพ์คำสั่ง`
    );
}

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

// ==========================================
// 🏠 11.7 หน้า "ศูนย์กลาง" ของแผงแอดมิน — จุดเข้าแรกสุดของ /แผงแอดมิน รวมทางลัดไปทุกหมวดในที่เดียว
// (แทนที่การมี 4 คำสั่งหลักแยกกัน — ตอนนี้ทุกอย่างเข้าถึงได้จากปุ่มในหน้านี้หน้าเดียว)
// ==========================================
function buildAdminHubPanel(cfg, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`🎛️ แผงแอดมิน — ${guild ? guild.name : ''}`)
    .setColor(0x5865F2)
    .setDescription(
      `สถานะบอท AI: **${cfg.isActive ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n\n` +
      'เลือกหมวดที่ต้องการตั้งค่าจากปุ่มด้านล่าง — ทุกฟีเจอร์ของบอทนี้รวมอยู่ในแผงเดียวนี้แล้ว ไม่ต้องพิมพ์คำสั่งแยก'
    )
    .setFooter({ text: 'สมาชิกทั่วไปใช้คำสั่ง /เมนู เพื่อเปิดแผงของตัวเอง (ถาม AI, เลเวล, ของวิเศษ, ศาล ฯลฯ)' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_ai').setLabel('🧠 ตั้งค่า AI').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nav_moderation').setLabel('🛡️ ดูแลเซิร์ฟเวอร์').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_automod').setLabel('🧹 Automod').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_antiraid').setLabel('🚨 Anti-Raid').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_ticket').setLabel('🎫 Ticket').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_community').setLabel('🌙 ระบบชุมชน').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_leveling').setLabel('🏆 เลเวล').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_welcome').setLabel('👋 ต้อนรับ/อำลา').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_access').setLabel('🚫 สิทธิ์การใช้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_advanced').setLabel('⚙️ ขั้นสูง').setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_stats').setLabel('📊 สถิติ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_dashboard_setup').setLabel('📌 ปักหมุดแผงสมาชิกในห้องนี้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_dashboard_refresh').setLabel('🔄 อัปเดตแผงสมาชิกที่ปักไว้').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_close_panel').setLabel('❌ ปิดแผง').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

// ==========================================
// 🛡️ 11.8 หน้าดูแลเซิร์ฟเวอร์ (แทนที่ /server mod ทั้งหมด)
// กดปุ่มแล้วจะเด้งเมนูเลือกสมาชิกเป้าหมาย (UserSelectMenu) จากนั้นบางรายการจะเด้ง Modal ให้กรอกเหตุผล/รายละเอียดต่อ
// ==========================================
function buildModerationPanel(cfg, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`🛡️ ดูแลเซิร์ฟเวอร์ — ${guild ? guild.name : ''}`)
    .setColor(0xE74C3C)
    .setDescription(
      'กดปุ่มการกระทำที่ต้องการ แล้วเลือกสมาชิกเป้าหมายจากเมนูที่จะปรากฏขึ้น (บางรายการจะมีช่องกรอกเหตุผล/รายละเอียดต่อ)\n\n' +
      '👢 เตะ • 🔨 แบน • 🔇 Timeout • ⚠️ เตือน • 🔊 ยกเลิก Timeout • 📜 ดูประวัติเตือน • 🧹 ล้างประวัติเตือน\n\n' +
      '🔓 ปลดแบน และ 🧹 ลบข้อความจำนวนมาก ใช้ปุ่มเปิดช่องกรอกได้เลย (ไม่ต้องเลือกจากรายชื่อในเซิร์ฟเวอร์ เพราะบางคนออกไปแล้วหรือไม่เกี่ยวกับสมาชิก)'
    )
    .setFooter({ text: 'แต่ละปุ่มต้องมีสิทธิ์ Discord ที่เกี่ยวข้องกับการกระทำนั้นๆ (เช่น Kick Members, Ban Members, Moderate Members, Manage Messages)' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_mod_kick').setLabel('👢 เตะ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_mod_ban').setLabel('🔨 แบน').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_mod_timeout').setLabel('🔇 Timeout').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_mod_warn').setLabel('⚠️ เตือน').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_mod_untimeout').setLabel('🔊 ยกเลิก Timeout').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_mod_warnings').setLabel('📜 ดูประวัติเตือน').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_mod_clearwarnings').setLabel('🧹 ล้างประวัติเตือน').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_mod_unban').setLabel('🔓 ปลดแบน (ใส่ ID)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_mod_purge').setLabel('🧹 ลบข้อความจำนวนมาก').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 เมนูหลัก').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ==========================================
// 🧹 11.9 หน้า Automod (แทนที่ /server automod ทั้งหมด)
// ==========================================
function buildAutomodPanel(cfg, guild) {
  const words = parseWordList(cfg.automodBadWords);
  const actionLabels = { delete: 'ลบข้อความอย่างเดียว', warn: 'ลบ + บันทึกคำเตือน', timeout: `ลบ + Timeout (${cfg.automodTimeoutSeconds}s)` };
  const embed = new EmbedBuilder()
    .setTitle(`🧹 Automod กรองข้อความอัตโนมัติ — ${guild ? guild.name : ''}`)
    .setColor(cfg.automodEnabled ? 0x2ECA53 : 0x95A5A6)
    .setDescription(
      `สถานะ: **${cfg.automodEnabled ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n` +
      `🔗 บล็อกลิงก์ทั่วไป: ${cfg.automodBlockLinks ? '✅ เปิด' : '❌ ปิด'}\n` +
      `📨 บล็อกลิงก์เชิญ Discord: ${cfg.automodBlockInvites ? '✅ เปิด' : '❌ ปิด'}\n` +
      `📢 เมนชันสูงสุด/ข้อความ: ${cfg.automodMaxMentions > 0 ? cfg.automodMaxMentions : 'ปิดการตรวจสอบ'}\n` +
      `⚖️ การลงโทษ: ${actionLabels[cfg.automodAction] || cfg.automodAction}\n\n` +
      `📋 คำต้องห้าม (${words.length}): ${words.length ? words.slice(0, 25).join(', ') + (words.length > 25 ? ' ...' : '') : '(ยังไม่มี)'}`
    )
    .setFooter({ text: 'กด "แก้ไขคำต้องห้าม" เพื่อเปิดช่องแก้ทั้งรายการทีเดียว (คั่นแต่ละคำด้วย , )' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle_automod').setLabel(cfg.automodEnabled ? '🟢 Automod: เปิด' : '🔴 Automod: ปิด').setStyle(cfg.automodEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_automod_links').setLabel(cfg.automodBlockLinks ? '🔗 บล็อกลิงก์: เปิด' : '🔗 บล็อกลิงก์: ปิด').setStyle(cfg.automodBlockLinks ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_automod_invites').setLabel(cfg.automodBlockInvites ? '📨 บล็อกเชิญ: เปิด' : '📨 บล็อกเชิญ: ปิด').setStyle(cfg.automodBlockInvites ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_automod_config').setLabel('⚙️ ตั้งค่าเพิ่มเติม').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_automod_words').setLabel('📋 แก้ไขคำต้องห้าม').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 เมนูหลัก').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ==========================================
// 🎫 11.10 หน้า Ticket (แทนที่ /server ticket setup)
// ใช้ ChannelSelectMenu/RoleSelectMenu แทน option ของ slash command — เลือกแล้วบันทึกทันทีเหมือนหน้าอื่นๆ
// ==========================================
function buildTicketPanel(cfg, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`🎫 ระบบ Ticket ติดต่อทีมงาน — ${guild ? guild.name : ''}`)
    .setColor(0x3498DB)
    .setDescription(
      `📁 หมวดหมู่ Ticket: ${cfg.ticketCategoryId ? `<#${cfg.ticketCategoryId}>` : 'ยังไม่ได้ตั้งค่า'}\n` +
      `👮 ยศทีมงาน: ${cfg.ticketStaffRoleId ? `<@&${cfg.ticketStaffRoleId}>` : 'ยังไม่ได้ตั้งค่า'}\n` +
      `🔢 จำนวน Ticket ที่เปิดไปแล้วทั้งหมด: ${cfg.ticketCounter || 0}`
    )
    .setFooter({ text: 'เลือกหมวดหมู่ + ยศทีมงานด้านล่างก่อน (บันทึกทันทีที่เลือก) แล้วกดปุ่มโพสต์ปุ่มเปิด Ticket ลงห้องนี้' });

  const row1 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_ticket_category').setPlaceholder('📁 เลือกหมวดหมู่ (Category) สำหรับ Ticket')
      .setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('select_ticket_staff_role').setPlaceholder('👮 เลือกยศทีมงานที่จะเห็น Ticket ทุกอัน')
      .setMinValues(1).setMaxValues(1)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_ticket_post').setLabel('📢 โพสต์ปุ่มเปิด Ticket ในห้องนี้').setStyle(ButtonStyle.Primary)
      .setDisabled(!cfg.ticketCategoryId || !cfg.ticketStaffRoleId),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 เมนูหลัก').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

// ==========================================
// 🚨 11.11 หน้า Anti-Raid (แทนที่ /server antiraid ทั้งหมด)
// recentJoins/isLockedVerification คำนวณจาก Map ที่อยู่ใน index.js จึงต้องส่งเข้ามาเป็นพารามิเตอร์
// ==========================================
function buildAntiraidPanel(cfg, guild, recentJoins, isLockedVerification) {
  const embed = new EmbedBuilder()
    .setTitle(`🚨 Anti-Raid ป้องกันการโจมตีเซิร์ฟเวอร์ — ${guild ? guild.name : ''}`)
    .setColor(cfg.antiRaidEnabled ? 0x2ECA53 : 0x95A5A6)
    .setDescription(
      `สถานะ: **${cfg.antiRaidEnabled ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน'}**\n` +
      `เกณฑ์: ${cfg.antiRaidJoinThreshold} คน / ${cfg.antiRaidWindowSeconds} วินาที\n` +
      `การดำเนินการ: ${ANTIRAID_ACTION_LABELS[cfg.antiRaidAction] || cfg.antiRaidAction}\n` +
      `อายุบัญชีขั้นต่ำ: ${cfg.antiRaidMinAccountAgeDays} วัน\n` +
      `คนเข้าร่วมในช่วงเวลาปัจจุบัน: ${recentJoins ?? 0} คน\n` +
      `Verification Level: ${isLockedVerification ? '🔒 ถูกยกระดับชั่วคราวอยู่' : '🔓 ปกติ'}`
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle_antiraid').setLabel(cfg.antiRaidEnabled ? '🟢 Anti-Raid: เปิด' : '🔴 Anti-Raid: ปิด').setStyle(cfg.antiRaidEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_set_antiraid_config').setLabel('⚙️ ตั้งค่าเกณฑ์').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_antiraid_unlock').setLabel('🔓 ปลดล็อก Verification').setStyle(ButtonStyle.Secondary).setDisabled(!isLockedVerification),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 เมนูหลัก').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('select_antiraid_action').setPlaceholder('⚖️ เลือกการดำเนินการเมื่อตรวจพบ Raid')
      .addOptions(Object.entries(ANTIRAID_ACTION_LABELS).map(([value, label]) => ({ label, value, default: cfg.antiRaidAction === value })))
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ==========================================
// 🌙 11.12 หน้าระบบชุมชน (แทนที่ /community dream|laws|relic|court on/off/setup + /community giveaway ทั้งหมด)
// ==========================================
function buildCommunityAdminPanel(cfg, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`🌙 ระบบชุมชนพิเศษ — ${guild ? guild.name : ''}`)
    .setColor(0x9B59B6)
    .setDescription(
      `**🌙 ความฝัน**: ${cfg.dreamEnabled ? '🟢 เปิด' : '🔴 ปิด'} — ห้อง: ${cfg.dreamChannelId ? `<#${cfg.dreamChannelId}>` : 'ยังไม่ได้ตั้ง'}\n` +
      `**📜 ธรรมนูญ**: ${cfg.lawsEnabled ? '🟢 เปิด' : '🔴 ปิด'} (มาตราทั้งหมด ${cfg.lawCounter || 0}) — ห้องประกาศ: ${cfg.lawsChannelId ? `<#${cfg.lawsChannelId}>` : 'ไม่ประกาศอัตโนมัติ'}\n` +
      `**🏺 ล่าของวิเศษ**: ${cfg.relicsEnabled ? '🟢 เปิด' : '🔴 ปิด'} (ต้องเปิดความฝัน + ตั้งห้องความฝันก่อน)\n` +
      `**⚖️ ศาลเซิร์ฟเวอร์**: ${cfg.courtEnabled ? '🟢 เปิด' : '🔴 ปิด'} (คดีทั้งหมด ${cfg.courtCaseCounter || 0})`
    )
    .setFooter({ text: 'เลือกห้องความฝัน/ธรรมนูญด้านล่าง (บันทึกทันที) แล้วกดปุ่มเปิด/ปิดแต่ละระบบได้เลย' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_toggle_dream').setLabel(cfg.dreamEnabled ? '🌙 ความฝัน: เปิด' : '🌙 ความฝัน: ปิด').setStyle(cfg.dreamEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_laws').setLabel(cfg.lawsEnabled ? '📜 ธรรมนูญ: เปิด' : '📜 ธรรมนูญ: ปิด').setStyle(cfg.lawsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_relic').setLabel(cfg.relicsEnabled ? '🏺 ของวิเศษ: เปิด' : '🏺 ของวิเศษ: ปิด').setStyle(cfg.relicsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle_court').setLabel(cfg.courtEnabled ? '⚖️ ศาล: เปิด' : '⚖️ ศาล: ปิด').setStyle(cfg.courtEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_dream_now').setLabel('✨ ให้บอทฝันตอนนี้').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_dream_channel').setPlaceholder('🌙 เลือกห้องความฝัน (จำเป็นสำหรับความฝัน + ของวิเศษ)')
      .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('select_laws_channel').setPlaceholder('📜 เลือกห้องประกาศธรรมนูญ (ไม่เลือก = ไม่ประกาศอัตโนมัติ)')
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_giveaway_start').setLabel('🎉 เริ่มกิจกรรมแจกของ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_giveaway_end').setLabel('🏁 จบกิจกรรม').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_giveaway_reroll').setLabel('🔄 สุ่มผู้ชนะใหม่').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 เมนูหลัก').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4] };
}

module.exports = {
  fmtChannels,
  fmtRoles,
  fmtUsers,
  parseColor,
  apiStatusLine,
  formatUptime,
  buildMainPanel,
  buildAdvancedPanel,
  buildAccessPanel,
  buildLevelingPanel,
  buildWelcomePanel,
  buildStatsPanel,
  buildAiReplyPayload,
  buildHelpEmbed,
  buildImagineEmbed,
  buildGiveawayEmbed,
  buildProphecyEmbed,
  buildAdminHubPanel,
  buildModerationPanel,
  buildAutomodPanel,
  buildTicketPanel,
  buildAntiraidPanel,
  buildCommunityAdminPanel,
  ANTIRAID_ACTION_LABELS,
};

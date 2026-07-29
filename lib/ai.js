// ==========================================
// 🧠 lib/ai.js
// ตรรกะการเรียก AI ทั้งหมดของบอท (ตรวจจับค่าย, เรียก API, สร้างภาพ, สภา AI, คำทำนาย)
// พึ่งพาแค่ axios + ./storage (สำหรับ getSystemPrompt/MODE_LABELS) ไม่พึ่ง discord.js เลย
// เพื่อให้เรียกใช้/ทดสอบ logic การตอบของ AI แยกจากส่วนแสดงผลบน Discord ได้
// ==========================================
const axios = require('axios');
const { getSystemPrompt, MODE_LABELS } = require('./storage');

// 🧠 4. ระบบ AI หลายค่าย (ตรวจจับอัตโนมัติ + รองรับหลาย Key สำรอง + Custom Endpoint)
// ==========================================
function parseApiKeys(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function detectApiProvider(key, customUrl, customModel) {
  const k = (key || '').trim();
  let provider;

  if (k.startsWith('gsk_')) {
    // 1. Groq API (แจกฟรี 100% ตอบไวมาก)
    provider = { name: 'Groq (Llama 3.3)', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', key: k, type: 'openai' };
  } else if (k.startsWith('sk-or-v1-')) {
    // 2. OpenRouter API (แจกฟรีหลายโมเดล)
    provider = { name: 'OpenRouter (Free)', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free', key: k, type: 'openai' };
  } else if (k.startsWith('AIzaSy')) {
    // 3. Google Gemini API (แจกฟรี)
    provider = { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-1.5-flash', key: k, type: 'openai' };
  } else if (k.startsWith('sk-ant-')) {
    // 4. Anthropic Claude API (รูปแบบ Request/Response ไม่เหมือน OpenAI จึงต้องแยกจัดการ)
    provider = { name: 'Anthropic Claude', url: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-haiku-20241022', key: k, type: 'anthropic' };
  } else if (k.startsWith('sk-')) {
    // 5. OpenAI
    provider = { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', key: k, type: 'openai' };
  } else if (k) {
    // 6. ค่ายอื่นๆที่ไม่รู้จัก Prefix (สันนิษฐานว่า Compatible กับ OpenAI)
    provider = { name: 'OpenAI Compatible', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-3.5-turbo', key: k, type: 'openai' };
  } else {
    provider = { name: 'ไม่ระบุ', url: '', model: '', key: '', type: 'openai' };
  }

  // ถ้าผู้ใช้กำหนด Base URL / Model เองในแผงควบคุม ให้ทับค่าที่ตรวจจับได้อัตโนมัติ
  if (customUrl && customUrl.trim()) {
    provider.url = customUrl.trim();
    provider.name = `Custom Endpoint (${provider.name})`;
    if (provider.type === 'anthropic' && !customUrl.includes('anthropic.com')) provider.type = 'openai';
  }
  if (customModel && customModel.trim()) {
    provider.model = customModel.trim();
  }
  return provider;
}

const FALLBACK_ANSWERS = [
  'อืมมม... ว่าไงต่อนะ?',
  'พิมพ์มาแค่นี้ AI งงเลยนะเนี่ย 😅',
  'รับทราบ! มีอะไรให้รับใช้อีกไหม?',
  'ตอนนี้เซิร์ฟเวอร์ AI ฝั่งผมกำลังหน่วงๆ ขออภัยด้วยนะเจ้านาย 🥲',
  'ระบบ AI ทุกค่ายไม่ตอบสนองตอนนี้ ลองใหม่อีกครั้งสักครู่นะ 🙏',
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

function trimReply(reply) {
  return reply.length > 1900 ? reply.slice(0, 1900) + '...' : reply;
}

// เรียก Provider จริง โดยแยก Logic ระหว่าง Anthropic (รูปแบบ /v1/messages) กับค่ายสไตล์ OpenAI (/v1/chat/completions)
async function callProvider(cfg, provider, systemPrompt, historyMessages, userText) {
  if (!provider.key || !provider.url) throw new Error('ไม่มี API Key หรือ URL');

  if (provider.type === 'anthropic') {
    const res = await axios.post(provider.url, {
      model: provider.model || 'claude-3-5-haiku-20241022',
      max_tokens: cfg.maxTokens || 1024,
      system: systemPrompt,
      messages: [...historyMessages, { role: 'user', content: userText }],
    }, {
      headers: {
        'x-api-key': provider.key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 15000,
    });
    const blocks = res.data?.content || [];
    const textBlock = blocks.find((b) => b.type === 'text');
    return textBlock ? textBlock.text : undefined;
  }

  const res = await axios.post(provider.url, {
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: userText },
    ],
    max_tokens: cfg.maxTokens || 1000,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.8,
  }, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.key}`,
    },
    timeout: 15000,
  });
  return res.data?.choices?.[0]?.message?.content;
}

// ฟังก์ชันหลักในการขอคำตอบจาก AI พร้อมระบบสำรองหลายชั้น:
//  ชั้น 1: Custom API Key ของผู้ใช้ (รองรับหลาย Key คั่นด้วย , หรือขึ้นบรรทัดใหม่ ลองทีละตัวจนกว่าจะสำเร็จ)
//  ชั้น 2: Pollinations (ฟรี ไม่ต้องมี Key) - ส่งบทสนทนาก่อนหน้าไปด้วยเพื่อความต่อเนื่อง
//  ชั้น 3: Hercai AI (ฟรีสำรอง)
//  ชั้น 4: Popcat Chatbot (ฟรีสำรอง)
//  ชั้น 5: ข้อความสำรองฉุกเฉิน (กันบอทเงียบไปเลย)
// คืนค่าเป็น { text, provider, latencyMs, usedFallback }
async function getAiResponse(cfg, historyMessages, text) {
  const systemPrompt = getSystemPrompt(cfg);
  const historyText = historyMessages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const fullPromptGET = `${systemPrompt}\n\n${historyText ? historyText + '\n' : ''}User: ${text}`;

  // 1️⃣ Custom API Key(s) ของผู้ใช้
  const keys = parseApiKeys(cfg.customApiKey);
  for (const rawKey of keys) {
    const provider = detectApiProvider(rawKey, cfg.customApiUrl, cfg.customApiModel);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const start = Date.now();
        const reply = await callProvider(cfg, provider, systemPrompt, historyMessages, text);
        const latencyMs = Date.now() - start;
        if (isValidAiResponse(reply)) {
          return { text: trimReply(reply), provider: provider.name, latencyMs, usedFallback: false };
        }
      } catch (e) {
        console.error(`❌ Custom API (${provider.name}) ครั้งที่ ${attempt + 1} ล้มเหลว:`, e.message);
      }
    }
  }

  // 2️⃣ API ฟรีหลัก (Pollinations POST) - ส่งบริบทบทสนทนาไปด้วย
  try {
    const start = Date.now();
    const res = await axios.post('https://text.pollinations.ai/', {
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: text },
      ],
      model: 'openai',
      seed: Math.floor(Math.random() * 1000000),
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });
    let reply = res.data;
    if (typeof reply === 'object' && reply && reply.content) reply = reply.content;
    const latencyMs = Date.now() - start;
    if (isValidAiResponse(reply)) {
      return { text: trimReply(reply), provider: 'Pollinations (ฟรี)', latencyMs, usedFallback: true };
    }
  } catch (e) {
    console.error('❌ Pollinations API Error:', e.message);
  }

  // 3️⃣ API ฟรีสำรองตัวที่ 2 (Hercai AI)
  try {
    const start = Date.now();
    const res = await axios.get(`https://hercai.onrender.com/v3/hercai?question=${encodeURIComponent(fullPromptGET)}`, { timeout: 15000 });
    const latencyMs = Date.now() - start;
    if (res.data && res.data.reply && isValidAiResponse(res.data.reply)) {
      return { text: trimReply(res.data.reply), provider: 'Hercai (ฟรี)', latencyMs, usedFallback: true };
    }
  } catch (e) {
    console.error('❌ Hercai API Error:', e.message);
  }

  // 4️⃣ API ฟรีสำรองตัวที่ 3 (Popcat Chatbot)
  try {
    const start = Date.now();
    const res = await axios.get(`https://api.popcat.xyz/chatbot?msg=${encodeURIComponent(text)}&owner=Owner&botname=AI`, { timeout: 10000 });
    const latencyMs = Date.now() - start;
    if (res.data && res.data.response && isValidAiResponse(res.data.response)) {
      return { text: trimReply(res.data.response), provider: 'Popcat (ฟรี)', latencyMs, usedFallback: true };
    }
  } catch (e) {
    console.error('❌ Popcat API Error:', e.message);
  }

  // 5️⃣ ข้อความสำรองฉุกเฉิน
  return {
    text: FALLBACK_ANSWERS[Math.floor(Math.random() * FALLBACK_ANSWERS.length)],
    provider: 'ข้อความสำรอง (ทุกค่ายล้มเหลว)',
    latencyMs: 0,
    usedFallback: true,
    isEmergencyFallback: true,
  };
}

// ==========================================
// 🎨 ระบบสร้างภาพด้วย AI (ฟรี 100% ไม่ต้องมี API Key ใช้ Pollinations Image API)
// ==========================================
// สร้างภาพจากคำบรรยาย แล้วคืนค่าเป็น Buffer ของรูป PNG พร้อมแนบใน Discord ได้ทันที
async function generateImage(prompt) {
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

// ==========================================
// 🏛️ ระบบ "สภา AI" (AI Council) — เอาบุคลิกของบอทเอง 2 โหมด มาโต้วาทีกันสดๆ แล้วมีกรรมการ AI ตัดสิน
// ==========================================
// ให้ 2 บุคลิกผลัดกันพูดตามหัวข้อที่กำหนด คนละ `rounds` รอบ แต่ละฝ่ายเห็นแค่บทพูดล่าสุดของอีกฝ่ายเท่านั้น (เหมือนโต้วาทีจริง)
async function runCouncilDebate(cfg, topic, modeA, modeB, rounds) {
  const transcript = [];
  const historyA = [];
  const historyB = [];
  let lastA = '';
  let lastB = '';

  for (let i = 0; i < rounds; i++) {
    const promptA = i === 0
      ? `หัวข้อโต้วาที: "${topic}"\nจงแสดงความเห็นแรกของคุณต่อหัวข้อนี้ สั้นกระชับไม่เกิน 3 ประโยค`
      : `หัวข้อโต้วาที: "${topic}"\nอีกฝ่ายเพิ่งพูดว่า: "${lastB}"\nจงโต้ตอบหรือเสริมความเห็นของคุณ สั้นกระชับไม่เกิน 3 ประโยค`;
    const cfgA = { ...cfg, mode: modeA, customPrompt: '' };
    const resA = await getAiResponse(cfgA, historyA, promptA);
    lastA = resA.text;
    transcript.push({ mode: modeA, text: lastA });
    historyA.push({ role: 'user', content: promptA }, { role: 'assistant', content: lastA });

    const promptB = `หัวข้อโต้วาที: "${topic}"\nอีกฝ่ายเพิ่งพูดว่า: "${lastA}"\nจงโต้ตอบหรือเสริมความเห็นของคุณ สั้นกระชับไม่เกิน 3 ประโยค`;
    const cfgB = { ...cfg, mode: modeB, customPrompt: '' };
    const resB = await getAiResponse(cfgB, historyB, promptB);
    lastB = resB.text;
    transcript.push({ mode: modeB, text: lastB });
    historyB.push({ role: 'user', content: promptB }, { role: 'assistant', content: lastB });
  }

  return transcript;
}

// กรรมการ AI (บุคลิก "จริงจัง" เสมอ ไม่ว่าเซิร์ฟเวอร์จะตั้งโหมดอะไรไว้ก็ตาม เพื่อความเป็นกลาง) อ่านบทสนทนาทั้งหมดแล้วตัดสิน
async function runCouncilVerdict(cfg, topic, transcript) {
  const summary = transcript.map((t) => `${MODE_LABELS[t.mode] || t.mode}: ${t.text}`).join('\n');
  const judgeCfg = {
    ...cfg,
    mode: 'serious',
    customPrompt: 'คุณคือกรรมการตัดสินการโต้วาทีที่เป็นกลาง อ่านบทสนทนาแล้วตัดสินว่าฝ่ายไหนโต้แย้งได้ดีกว่า พร้อมให้เหตุผลสั้นๆ ไม่เกิน 3 ประโยค ตอบเป็นภาษาไทยเท่านั้น',
  };
  const res = await getAiResponse(judgeCfg, [], `หัวข้อ: "${topic}"\n\nบทสนทนา:\n${summary}\n\nใครโต้แย้งได้ดีกว่ากัน เพราะอะไร?`);
  return res.text;
}

// ==========================================
// 🔮 ระบบคำทำนาย AI (Prophecy) — บังคับให้ AI พูดแนวสนุกสนานเท่านั้น ห้ามทำนายเรื่องจริงจัง (ดูเหตุผลเต็มใน README)
// ==========================================
const PROPHECY_SAFETY_RULE =
  'นี่คือฟีเจอร์เพื่อความบันเทิงในดิสคอร์ดเท่านั้น ห้ามทำนายเรื่องจริงจังหรือละเอียดอ่อนเด็ดขาด เช่น ภัยพิบัติ อุบัติเหตุ ความรุนแรง การเมือง สุขภาพ หรือเรื่องส่วนตัวของใครคนใดคนหนึ่ง ' +
  'ให้เน้นทำนายแนวสนุกสนาน เพ้อฝัน เกี่ยวกับบรรยากาศ กิจกรรม หรือเรื่องขำๆ ที่อาจเกิดขึ้นในเซิร์ฟเวอร์ Discord นี้เท่านั้น ตอบสั้นกระชับไม่เกิน 3 ประโยค';


async function generateProphecyText(cfg, topic) {
  const prophetCfg = {
    ...cfg,
    customPrompt: `คุณคือหมอดูทำนายดวงชะตาประจำเซิร์ฟเวอร์ Discord พูดจาลึกลับน่าค้นหาแบบขำๆ ${PROPHECY_SAFETY_RULE}`,
  };
  const userText = topic
    ? `จงทำนายเรื่อง "${topic}" ในเซิร์ฟเวอร์นี้`
    : 'จงทำนายเรื่องสนุกๆ ที่อาจเกิดขึ้นในเซิร์ฟเวอร์นี้';
  const res = await getAiResponse(prophetCfg, [], userText);
  return res.text;
}

async function generateProphecyEpilogue(cfg, prediction) {
  const prophetCfg = {
    ...cfg,
    customPrompt: `คุณคือหมอดูประจำเซิร์ฟเวอร์ Discord ที่กำลังเปิดผนึกคำทำนายเก่าของตัวเอง พูดแบบขำๆ ถ่อมตัวว่าทายไม่ได้จริงจัง ${PROPHECY_SAFETY_RULE}`,
  };
  const res = await getAiResponse(
    prophetCfg,
    [],
    `คำทำนายเดิมของคุณคือ: "${prediction}"\nตอนนี้ครบเวลาแล้ว จงพูดแบบขำๆ ปิดท้ายคำทำนายนี้ (ไม่ต้องฟันธงว่าทายถูกหรือผิดจริง เพราะคุณไม่มีทางรู้ข้อมูลจริง แค่พูดแบบหมอดูขำๆ ปิดฉาก)`
  );
  return res.text;
}

module.exports = {
  parseApiKeys,
  detectApiProvider,
  isValidAiResponse,
  trimReply,
  FALLBACK_ANSWERS,
  callProvider,
  getAiResponse,
  generateImage,
  PROPHECY_SAFETY_RULE,
  runCouncilDebate,
  runCouncilVerdict,
  generateProphecyText,
  generateProphecyEpilogue,
};
        

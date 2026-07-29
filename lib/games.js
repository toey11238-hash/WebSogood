// ==========================================
// 🎮 lib/games.js
// ตรรกะมินิเกม/ความบันเทิงทั้งหมด เป็นฟังก์ชันบริสุทธิ์ล้วนๆ (รับ input คืนค่าผลลัพธ์)
// พึ่งพาแค่ axios (สำหรับดึงคำถาม Trivia จาก Open Trivia DB ซึ่งฟรี ไม่ต้องมี API Key)
// ไม่พึ่ง discord.js เลย เพื่อให้ทดสอบ logic เกมแยกจากส่วนแสดงผลบน Discord ได้ (บทเรียนจากการ Refactor ที่แล้ว)
// ==========================================
const axios = require('axios');

// ==========================================
// ✊✋✌️ Rock Paper Scissors (เป่ายิ้งฉุบ)
// ==========================================
const RPS_CHOICES = ['rock', 'paper', 'scissors'];
const RPS_EMOJI = { rock: '🪨', paper: '📄', scissors: '✂️' };
const RPS_LABEL_TH = { rock: 'ค้อน', paper: 'กระดาษ', scissors: 'กรรไกร' };
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' }; // key ชนะ value

function rpsRandomChoice() {
  return RPS_CHOICES[Math.floor(Math.random() * RPS_CHOICES.length)];
}

// คืนค่า 'win' | 'lose' | 'draw' จากมุมมองของ userChoice
function rpsDetermineOutcome(userChoice, botChoice) {
  if (!RPS_CHOICES.includes(userChoice) || !RPS_CHOICES.includes(botChoice)) return null;
  if (userChoice === botChoice) return 'draw';
  return RPS_BEATS[userChoice] === botChoice ? 'win' : 'lose';
}

// ==========================================
// 🎲 ทอยลูกเต๋า (รองรับสัญกรณ์ NdM เช่น d20, 2d6, 4d10)
// ==========================================
function parseDiceNotation(input) {
  if (!input || !String(input).trim()) return { count: 1, sides: 6 };
  const match = /^(\d*)d(\d+)$/i.exec(String(input).trim());
  if (!match) return null;
  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides = parseInt(match[2], 10);
  if (Number.isNaN(count) || Number.isNaN(sides)) return null;
  if (count < 1 || count > 100) return null;
  if (sides < 2 || sides > 1000) return null;
  return { count, sides };
}

function rollDice(count, sides) {
  const rolls = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0);
  return { rolls, total };
}

// ==========================================
// 🎱 Magic 8-Ball
// ==========================================
const EIGHT_BALL_RESPONSES = [
  // เชิงบวก
  'แน่นอนอยู่แล้ว', 'ใช่เลย ไม่ต้องสงสัย', 'มั่นใจได้เลย', 'สัญญาณทุกอย่างบอกว่าใช่', 'เป็นไปได้สูงมาก', 'เชื่อเถอะ ใช่แน่นอน',
  // เป็นกลาง/ไม่แน่ใจ
  'ถามอีกทีนะ', 'ตอนนี้ยังบอกไม่ได้ ลองใหม่ทีหลัง', 'โฟกัสให้ดีแล้วค่อยถามใหม่', 'คำตอบยังพร่ามัวอยู่',
  // เชิงลบ
  'ไม่น่าจะใช่นะ', 'สัญญาณบอกว่าไม่', 'อย่าหวังเลยดีกว่า', 'แหล่งข่าวที่เชื่อถือได้บอกว่าไม่', 'ไม่ค่อยสดใสเท่าไหร่',
];

function pickEightBallResponse() {
  return EIGHT_BALL_RESPONSES[Math.floor(Math.random() * EIGHT_BALL_RESPONSES.length)];
}

// ==========================================
// 🎰 สล็อตแมชชีน
// ==========================================
const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣'];

function spinSlots() {
  const reels = [0, 0, 0].map(() => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]);
  const isJackpot = reels[0] === reels[1] && reels[1] === reels[2];
  const isPair = !isJackpot && (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]);
  return { reels, isJackpot, isPair };
}

// ==========================================
// 🧠 Trivia (ใช้ Open Trivia Database - ฟรี ไม่ต้องมี API Key: https://opentdb.com)
// ==========================================
const HTML_ENTITY_MAP = {
  '&quot;': '"', '&#039;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&ldquo;': '"', '&rdquo;': '"', '&rsquo;': '\u2019', '&lsquo;': '\u2018',
  '&hellip;': '…', '&ndash;': '–', '&mdash;': '—', '&eacute;': 'é', '&Eacute;': 'É',
  '&uacute;': 'ú', '&oacute;': 'ó', '&iacute;': 'í', '&ouml;': 'ö', '&auml;': 'ä',
  '&uuml;': 'ü', '&ntilde;': 'ñ', '&ccedil;': 'ç', '&aacute;': 'á',
};

function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&[a-zA-Z#0-9]+;/g, (m) => (Object.prototype.hasOwnProperty.call(HTML_ENTITY_MAP, m) ? HTML_ENTITY_MAP[m] : m));
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TRIVIA_DIFFICULTY_XP = { easy: 15, medium: 25, hard: 40 };

// แปลงข้อมูลดิบจาก Open Trivia DB ให้เป็นรูปแบบที่ใช้งานง่าย (แยกจากการยิง Network เพื่อให้ทดสอบ logic ส่วนนี้ได้โดยไม่ต้องต่อเน็ตจริง)
function normalizeTriviaItem(item) {
  if (!item) return null;
  const question = decodeHtmlEntities(item.question);
  const correctAnswer = decodeHtmlEntities(item.correct_answer);
  const incorrectAnswers = (item.incorrect_answers || []).map(decodeHtmlEntities);
  const allAnswers = shuffleArray([correctAnswer, ...incorrectAnswers]);
  const difficulty = item.difficulty || 'medium';
  return {
    question,
    correctAnswer,
    allAnswers,
    category: decodeHtmlEntities(item.category || ''),
    difficulty,
    xpReward: TRIVIA_DIFFICULTY_XP[difficulty] || TRIVIA_DIFFICULTY_XP.medium,
  };
}

async function fetchTriviaQuestion(difficulty) {
  const diffParam = ['easy', 'medium', 'hard'].includes(difficulty) ? `&difficulty=${difficulty}` : '';
  const res = await axios.get(`https://opentdb.com/api.php?amount=1&type=multiple${diffParam}`, { timeout: 10000 });
  const item = res.data?.results?.[0];
  return normalizeTriviaItem(item);
}

module.exports = {
  RPS_CHOICES,
  RPS_EMOJI,
  RPS_LABEL_TH,
  rpsRandomChoice,
  rpsDetermineOutcome,
  parseDiceNotation,
  rollDice,
  EIGHT_BALL_RESPONSES,
  pickEightBallResponse,
  SLOT_SYMBOLS,
  spinSlots,
  decodeHtmlEntities,
  shuffleArray,
  normalizeTriviaItem,
  fetchTriviaQuestion,
  TRIVIA_DIFFICULTY_XP,
};

// ==========================================
// 🧪 test/test-games.js
// ทดสอบ lib/games.js: เฉพาะ logic บริสุทธิ์ (ไม่ทดสอบ fetchTriviaQuestion จริงเพราะ Sandbox นี้ไม่มีเน็ต
// แต่ทดสอบ normalizeTriviaItem ซึ่งเป็น logic แปลงข้อมูลล้วนๆ แยกออกมาต่างหากเพื่อทดสอบได้โดยไม่ต้องต่อเน็ต)
// axios ถูก stub ไว้เฉยๆ เพื่อให้ require() สำเร็จ
// รันด้วย: node test/test-games.js
// ==========================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SANDBOX_DIR = path.join(__dirname, '.tmp-sandbox-games');
if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX_DIR, 'node_modules', 'axios'), { recursive: true });
fs.writeFileSync(
  path.join(SANDBOX_DIR, 'node_modules', 'axios', 'index.js'),
  'module.exports = { get: async () => { throw new Error("stub: no network in test"); } };'
);
fs.writeFileSync(
  path.join(SANDBOX_DIR, 'node_modules', 'axios', 'package.json'),
  JSON.stringify({ name: 'axios', version: '0.0.0-stub', main: 'index.js' })
);
fs.copyFileSync(path.join(__dirname, '..', 'lib', 'games.js'), path.join(SANDBOX_DIR, 'games.js'));

const games = require(path.join(SANDBOX_DIR, 'games.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}`);
    console.log(`   ${e.message}`);
    failed++;
  }
}

// ---------- Rock Paper Scissors ----------
test('rpsRandomChoice คืนค่าที่อยู่ใน RPS_CHOICES เสมอ (สุ่ม 200 ครั้ง)', () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(games.RPS_CHOICES.includes(games.rpsRandomChoice()));
  }
});

test('rpsDetermineOutcome: ค้อนชนะกรรไกร', () => {
  assert.strictEqual(games.rpsDetermineOutcome('rock', 'scissors'), 'win');
});
test('rpsDetermineOutcome: กรรไกรชนะกระดาษ', () => {
  assert.strictEqual(games.rpsDetermineOutcome('scissors', 'paper'), 'win');
});
test('rpsDetermineOutcome: กระดาษชนะค้อน', () => {
  assert.strictEqual(games.rpsDetermineOutcome('paper', 'rock'), 'win');
});
test('rpsDetermineOutcome: เลือกเหมือนกันเสมอเป็นเสมอ', () => {
  assert.strictEqual(games.rpsDetermineOutcome('rock', 'rock'), 'draw');
  assert.strictEqual(games.rpsDetermineOutcome('paper', 'paper'), 'draw');
  assert.strictEqual(games.rpsDetermineOutcome('scissors', 'scissors'), 'draw');
});
test('rpsDetermineOutcome: แพ้ถูกต้องตามกติกา (กลับด้าน win)', () => {
  assert.strictEqual(games.rpsDetermineOutcome('scissors', 'rock'), 'lose');
  assert.strictEqual(games.rpsDetermineOutcome('paper', 'scissors'), 'lose');
  assert.strictEqual(games.rpsDetermineOutcome('rock', 'paper'), 'lose');
});
test('rpsDetermineOutcome คืนค่า null ถ้า input ไม่ถูกต้อง', () => {
  assert.strictEqual(games.rpsDetermineOutcome('lizard', 'rock'), null);
  assert.strictEqual(games.rpsDetermineOutcome('', ''), null);
});
test('RPS_EMOJI และ RPS_LABEL_TH มีครบทุก choice', () => {
  for (const choice of games.RPS_CHOICES) {
    assert.ok(games.RPS_EMOJI[choice]);
    assert.ok(games.RPS_LABEL_TH[choice]);
  }
});

// ---------- Dice ----------
test('parseDiceNotation: ไม่มี input ให้ค่าเริ่มต้น 1d6', () => {
  assert.deepStrictEqual(games.parseDiceNotation(''), { count: 1, sides: 6 });
  assert.deepStrictEqual(games.parseDiceNotation(null), { count: 1, sides: 6 });
});
test('parseDiceNotation: "d20" แปลว่าทอย 1 ลูก 20 หน้า', () => {
  assert.deepStrictEqual(games.parseDiceNotation('d20'), { count: 1, sides: 20 });
});
test('parseDiceNotation: "2d6" แปลว่าทอย 2 ลูก 6 หน้า', () => {
  assert.deepStrictEqual(games.parseDiceNotation('2d6'), { count: 2, sides: 6 });
});
test('parseDiceNotation: ตัวพิมพ์ใหญ่ก็ใช้ได้ (D20)', () => {
  assert.deepStrictEqual(games.parseDiceNotation('D20'), { count: 1, sides: 20 });
});
test('parseDiceNotation: ปฏิเสธจำนวนลูกเกิน 100', () => {
  assert.strictEqual(games.parseDiceNotation('101d6'), null);
});
test('parseDiceNotation: ปฏิเสธจำนวนหน้าเกิน 1000', () => {
  assert.strictEqual(games.parseDiceNotation('1d1001'), null);
});
test('parseDiceNotation: ปฏิเสธจำนวนหน้าน้อยกว่า 2', () => {
  assert.strictEqual(games.parseDiceNotation('1d1'), null);
});
test('parseDiceNotation: ปฏิเสธรูปแบบที่ไม่ถูกต้อง', () => {
  assert.strictEqual(games.parseDiceNotation('abc'), null);
  assert.strictEqual(games.parseDiceNotation('6d'), null);
  assert.strictEqual(games.parseDiceNotation('d'), null);
});
test('rollDice: จำนวนผลทอยตรงกับ count ที่ระบุ และแต่ละค่าอยู่ในช่วง 1-sides', () => {
  const { rolls, total } = games.rollDice(5, 6);
  assert.strictEqual(rolls.length, 5);
  for (const r of rolls) {
    assert.ok(r >= 1 && r <= 6);
  }
  assert.strictEqual(total, rolls.reduce((a, b) => a + b, 0));
});
test('rollDice: ทอย 1 ลูก 1 หน้า ต้องได้ 1 เสมอ (ขอบเขตต่ำสุด)', () => {
  const { rolls } = games.rollDice(1, 1);
  assert.deepStrictEqual(rolls, [1]);
});

// ---------- 8-Ball ----------
test('pickEightBallResponse คืนค่าที่อยู่ใน EIGHT_BALL_RESPONSES เสมอ', () => {
  for (let i = 0; i < 100; i++) {
    assert.ok(games.EIGHT_BALL_RESPONSES.includes(games.pickEightBallResponse()));
  }
});
test('EIGHT_BALL_RESPONSES มีคำตอบหลากหลายพอสมควร (ไม่ใช่แค่ 1-2 แบบ)', () => {
  assert.ok(games.EIGHT_BALL_RESPONSES.length >= 10);
});

// ---------- Slots ----------
test('spinSlots คืนค่า reels 3 ช่องเสมอ และสัญลักษณ์ต้องอยู่ใน SLOT_SYMBOLS', () => {
  for (let i = 0; i < 100; i++) {
    const { reels } = games.spinSlots();
    assert.strictEqual(reels.length, 3);
    for (const r of reels) assert.ok(games.SLOT_SYMBOLS.includes(r));
  }
});
test('spinSlots: isJackpot ถูกต้องเมื่อทั้ง 3 ช่องเหมือนกัน', () => {
  // รันหลายรอบจนกว่าจะเจอ jackpot หรือ pair อย่างน้อย 1 ครั้ง เพื่อตรวจ logic จริง (สุ่ม 6 สัญลักษณ์ ควรเจอใน ~1000 รอบ)
  let sawJackpot = false;
  let sawPair = false;
  let sawNeither = false;
  for (let i = 0; i < 2000; i++) {
    const { reels, isJackpot, isPair } = games.spinSlots();
    const allSame = reels[0] === reels[1] && reels[1] === reels[2];
    const anyPair = !allSame && (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]);
    assert.strictEqual(isJackpot, allSame, `isJackpot ไม่ตรงกับ reels จริง: ${reels}`);
    assert.strictEqual(isPair, anyPair, `isPair ไม่ตรงกับ reels จริง: ${reels}`);
    if (isJackpot) sawJackpot = true;
    if (isPair) sawPair = true;
    if (!isJackpot && !isPair) sawNeither = true;
  }
  assert.ok(sawJackpot, 'ควรเจอ Jackpot อย่างน้อย 1 ครั้งใน 2000 รอบ');
  assert.ok(sawPair, 'ควรเจอ Pair อย่างน้อย 1 ครั้งใน 2000 รอบ');
  assert.ok(sawNeither, 'ควรเจอกรณีไม่ถูกอะไรเลยอย่างน้อย 1 ครั้งใน 2000 รอบ');
});

// ---------- Trivia (เฉพาะส่วนที่ไม่ต้องต่อเน็ต) ----------
test('decodeHtmlEntities แปลง HTML entity ที่พบบ่อยได้ถูกต้อง', () => {
  assert.strictEqual(games.decodeHtmlEntities('What&#039;s the capital of France?'), "What's the capital of France?");
  assert.strictEqual(games.decodeHtmlEntities('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.strictEqual(games.decodeHtmlEntities('&quot;Hello&quot;'), '"Hello"');
});
test('decodeHtmlEntities ไม่แตะข้อความที่ไม่มี entity', () => {
  assert.strictEqual(games.decodeHtmlEntities('สวัสดีครับ'), 'สวัสดีครับ');
});
test('decodeHtmlEntities รับ non-string โดยไม่ throw', () => {
  assert.strictEqual(games.decodeHtmlEntities(null), null);
  assert.strictEqual(games.decodeHtmlEntities(123), 123);
});

test('shuffleArray คืนค่าที่มีสมาชิกครบเหมือนเดิม แค่สลับลำดับ', () => {
  const original = [1, 2, 3, 4, 5];
  const shuffled = games.shuffleArray(original);
  assert.strictEqual(shuffled.length, original.length);
  assert.deepStrictEqual([...shuffled].sort(), [...original].sort());
  // ต้นฉบับต้องไม่ถูกแก้ไข (pure function)
  assert.deepStrictEqual(original, [1, 2, 3, 4, 5]);
});

test('normalizeTriviaItem แปลงข้อมูลดิบจาก Open Trivia DB ได้ถูกต้อง', () => {
  const rawItem = {
    category: 'Entertainment: Video Games',
    difficulty: 'easy',
    question: 'What&#039;s the best game?',
    correct_answer: 'Tetris',
    incorrect_answers: ['Pac-Man', 'Chess', 'Checkers'],
  };
  const result = games.normalizeTriviaItem(rawItem);
  assert.strictEqual(result.question, "What's the best game?");
  assert.strictEqual(result.correctAnswer, 'Tetris');
  assert.strictEqual(result.allAnswers.length, 4);
  assert.ok(result.allAnswers.includes('Tetris'));
  assert.ok(result.allAnswers.includes('Pac-Man'));
  assert.strictEqual(result.category, 'Entertainment: Video Games');
  assert.strictEqual(result.xpReward, games.TRIVIA_DIFFICULTY_XP.easy);
});

test('normalizeTriviaItem คืนค่า null ถ้าไม่มี item', () => {
  assert.strictEqual(games.normalizeTriviaItem(null), null);
  assert.strictEqual(games.normalizeTriviaItem(undefined), null);
});

test('normalizeTriviaItem ใช้ xpReward ระดับ medium เป็นค่า fallback ถ้าไม่มี difficulty', () => {
  const result = games.normalizeTriviaItem({
    category: 'Test', question: 'Q', correct_answer: 'A', incorrect_answers: ['B', 'C', 'D'],
  });
  assert.strictEqual(result.xpReward, games.TRIVIA_DIFFICULTY_XP.medium);
});

// ---------- Cleanup ----------
fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });

console.log('');
console.log(`📊 ผลทดสอบ games.js: ผ่าน ${passed} / ล้มเหลว ${failed} (รวม ${passed + failed} เคส)`);
if (failed > 0) process.exit(1);

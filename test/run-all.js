// ==========================================
// 🧪 test/run-all.js
// รันชุดทดสอบทั้งหมดเรียงกัน แล้วสรุปผลรวม (Exit code 1 ถ้ามีชุดไหนล้มเหลว เพื่อใช้กับ CI ได้)
// รันด้วย: node test/run-all.js  (หรือ npm test)
// ==========================================
const { execFileSync } = require('child_process');
const path = require('path');

const testFiles = ['test-storage.js', 'test-ai-pure.js', 'test-panels.js'];

console.log('🧪 กำลังรันชุดทดสอบทั้งหมด...\n');

let anyFailed = false;
for (const file of testFiles) {
  console.log(`\n=========== ${file} ===========`);
  try {
    const output = execFileSync('node', [path.join(__dirname, file)], { encoding: 'utf8' });
    process.stdout.write(output);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    anyFailed = true;
  }
}

console.log('\n=========================================');
if (anyFailed) {
  console.log('❌ มีชุดทดสอบที่ล้มเหลว ดูรายละเอียดด้านบน');
  process.exit(1);
} else {
  console.log('✅ ทุกชุดทดสอบผ่านหมด (หมายเหตุ: นี่คือ Unit Test ของ logic ล้วนๆ ยังไม่ได้ทดสอบกับ Discord จริง ดู TESTING_NOTES.md ประกอบ)');
}

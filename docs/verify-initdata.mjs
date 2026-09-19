// Проверяет initData, скопированный из зонда, локально — публичный бэкенд не нужен.
// Запуск: PROBE_TOKEN=<токен> node verify-initdata.mjs '<initData>'
import { createHmac, timingSafeEqual } from 'node:crypto';

const raw = process.argv[2];
const token = process.env.PROBE_TOKEN;
if (!raw || !token) {
  console.error('нужны PROBE_TOKEN и строка initData аргументом');
  process.exit(1);
}

const pairs = raw.split('&').map((p) => {
  const i = p.indexOf('=');
  return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
});
const hashes = pairs.filter(([k]) => k === 'hash');
if (hashes.length !== 1) {
  console.error('ожидался ровно один hash, найдено:', hashes.length);
  process.exit(1);
}
const received = hashes[0][1];
const signed = pairs
  .filter(([k]) => k !== 'hash')
  .map(([k, v]) => [k, decodeURIComponent(v)])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const launchParams = signed.map(([k, v]) => `${k}=${v}`).join('\n');
const secret = createHmac('sha256', token).update('WebAppData').digest();
const expected = createHmac('sha256', secret).update(launchParams).digest('hex');

console.log('--- launch_params ---');
console.log(launchParams);
console.log('\n--- подпись ---');
console.log('ожидали :', expected);
console.log('пришло  :', received);
const ok =
  expected.length === received.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(received));
console.log(ok ? '\n✅ ПОДПИСЬ СОШЛАСЬ' : '\n❌ подпись не сошлась');

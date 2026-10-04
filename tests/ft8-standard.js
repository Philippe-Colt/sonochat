// FT8 radioamateur (messages standard WSJT-X) décodé en texte : vecteurs officiels produits par
// `ft8code` (WSJT-X 2.x) — message saisi, texte décodé par WSJT-X, 77 bits — puis chaîne
// complète modulation → FT8Modem → frame.ham, et indicatifs hachés. Usage : node tests/ft8-standard.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console: { log() {}, error: console.error, warn() {} }, performance, setTimeout, clearTimeout, Math, Float32Array, Float64Array,
  Uint32Array, Uint8Array, Int32Array, Int8Array, Uint16Array, Int16Array, Array, Set, Map, Object, String, Number, Promise, Date, Infinity, NaN, isNaN, parseInt, BigInt };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ft8-modem.js'), 'utf8') + ';this.FT8=FT8;this.FT8Modem=FT8Modem;', ctx);
const { FT8Modem } = ctx;

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

// [message saisi, texte décodé par WSJT-X, 77 bits]
const VECTORS = [
  ['CQ F4MTX JN18', 'CQ F4MTX JN18', '00000000000000000000000000100000010001101111001001010111100100010001101110001'],
  ['CQ DX F4MTX JN18', 'CQ DX F4MTX JN18', '00000000000000000100011011110000010001101111001001010111100100010001101110001'],
  ['CQ POTA F4MTX JN18', 'CQ POTA F4MTX JN18', '00000000010011111110111011110000010001101111001001010111100100010001101110001'],
  ['CQ 290 F4MTX JN18', 'CQ 290 F4MTX JN18', '00000000000000000001001001010000010001101111001001010111100100010001101110001'],
  ['F4MTX K1ABC FN42', 'F4MTX K1ABC FN42', '00001000110111100100101011110000010011011110111100011010100010100001100110001'],
  ['K1ABC F4MTX -12', 'K1ABC F4MTX -12', '00001001101111011110001101010000010001101111001001010111100111111010100111001'],
  ['F4MTX K1ABC R-08', 'F4MTX K1ABC R-08', '00001000110111100100101011110000010011011110111100011010101111111010101011001'],
  ['K1ABC F4MTX RRR', 'K1ABC F4MTX RRR', '00001001101111011110001101010000010001101111001001010111100111111010010010001'],
  ['F4MTX K1ABC RR73', 'F4MTX K1ABC RR73', '00001000110111100100101011110000010011011110111100011010100111111001110101001'],
  ['K1ABC F4MTX 73', 'K1ABC F4MTX 73', '00001001101111011110001101010000010001101111001001010111100111111010010100001'],
  ['F4MTX/P K1ABC JN18', 'F4MTX/P K1ABC JN18', '00001000110111100100101011111000010011011110111100011010100100010001101110010'],
  ['F4MTX K1ABC/R R+05', 'F4MTX K1ABC/R R+05', '00001000110111100100101011110000010011011110111100011010111111111010111000001'],
  ['QRZ F4MTX JN18', 'QRZ F4MTX JN18', '00000000000000000000000000010000010001101111001001010111100100010001101110001'],
  ['DE F4MTX JN18', 'DE F4MTX JN18', '00000000000000000000000000000000010001101111001001010111100100010001101110001'],
  ['CQ PJ4/K1ABC', 'CQ PJ4/K1ABC', '01010110101100000000000110100011101000110001000111001010101000000000010001100'],
  ['PJ4/K1ABC F4MTX', 'K1ABC F4MTX', '00001001101111011110001101010000010001101111001001010111100111111010010001001'],
  ['F4MTX PJ4/K1ABC RR73', 'F4MTX K1ABC RR73', '00001000110111100100101011110000010011011110111100011010100111111001110101001'],
  ['<PJ4/K1ABC> F4MTX -10', '<PJ4/K1ABC> F4MTX -10', '00000011010100101011000010100000010001101111001001010111100111111010101001001'],
  ['K1ABC RR73; W9XYZ <KH1/KH7Z> -08', 'K1ABC RR73; W9XYZ <KH1/KH7Z> -08', '00001001101111011110001101010000110000101001001110111000001100100101011001000'],
  ['TNX BOB 73 GL', 'TNX BOB 73 GL', '01100011111011011100111011100010101001001010111000000111111101010000000000000'],
  ['3DA0XYZ F4MTX JN18', '3DA0XYZ F4MTX', '00001110001011010000100000110111011101001111110100000110011000000010010000000'],
  ['K1ABC W9XYZ 6A WI', 'K1ABC W9XYZ 6A WI', '00001001101111011110001101010000110000101001001110111000001010001001100011000'],
  ['K1ABC W9XYZ 579 WI', 'K1ABC W9XYZ 579 WI', '00000100110111101111000110101000011000010100100111011100001011111101110001011'],
  ['F4MTX K1ABC', 'F4MTX K1ABC', '00001000110111100100101011110000010011011110111100011010100111111010010001001'],
  ['CQ TEST F4MTX JN18', 'CQ TEST F4MTX JN18', '00000000011000010101111110010000010001101111001001010111100100010001101110001'],
  ['F5ABC/P F4MTX/P R JN18', 'F5ABC/P F4MTX/P R JN18', '00001000111000001101011010111000010001101111001001010111111100010001101110010'],
];
// Formats de concours américains : section ARRL / État non décodés (marqués [FD] / [RU])
const PARTIAL = { 'K1ABC W9XYZ 6A WI': 'K1ABC W9XYZ 6A [FD]', 'K1ABC W9XYZ 579 WI': 'K1ABC W9XYZ 579 [RU]' };

console.log('Vecteurs ft8code (WSJT-X)');
FT8Modem.rememberCall('PJ4/K1ABC'); // déjà entendus en clair : leurs hachages se résolvent
FT8Modem.rememberCall('KH1/KH7Z');
for (const [msg, exp, b] of VECTORS) {
  const bits = [...b].map(Number);
  const std = FT8Modem.decodeStandard(bits);
  const got = std !== null ? std : FT8Modem.decodeText(bits);
  check(`« ${msg} » → « ${PARTIAL[exp] || exp} »`, got === (PARTIAL[exp] || exp), got);
}

console.log('Indicatifs hachés');
{
  FT8Modem._hashes = null; // rien d'entendu
  const v = VECTORS.find((x) => x[0].startsWith('<PJ4/K1ABC>'));
  const bits = [...v[2]].map(Number);
  check('inconnu : « <...> F4MTX -10 »', FT8Modem.decodeStandard(bits) === '<...> F4MTX -10', FT8Modem.decodeStandard(bits));
  FT8Modem.decodeStandard([...VECTORS.find((x) => x[0] === 'CQ PJ4/K1ABC')[2]].map(Number)); // « CQ PJ4/K1ABC » entendu
  check('après « CQ PJ4/K1ABC » : « <PJ4/K1ABC> F4MTX -10 »', FT8Modem.decodeStandard(bits) === '<PJ4/K1ABC> F4MTX -10', FT8Modem.decodeStandard(bits));
}

console.log('Chaîne complète : modulation → FT8Modem → frame.ham');
(async () => {
  const SR = 12000, nsps = 1920, L = SR * 40;
  const buf = new Float32Array(L);
  for (let i = 0; i < L; i++) buf[i] = 0.05 * (Math.random() - 0.5);
  const sent = [['CQ F4MTX JN18', 1200], ['F4MTX K1ABC R-08', 1500], ['TNX BOB 73 GL', 1800]];
  for (const [m, f] of sent) {
    const b = [...VECTORS.find((x) => x[0] === m)[2]].map(Number);
    const w = new FT8Modem({ baseFreq: f }).generateWaveform(FT8Modem.payloadToSymbols(b), SR);
    for (let i = 0; i < w.length; i++) buf[L - w.length - SR + i] += 0.3 * w[i];
  }
  const rx = new FT8Modem({ baseFreq: 1000 });
  Object.assign(rx, { _sampleRate: SR, _nsps: nsps, _ringBuffer: buf, _ringBufferLen: L, _ringWritePos: 0, listening: true });
  rx._resetRxState(); rx._absWritten = L; rx._toneWindow = new Float32Array(nsps).fill(1);
  const got = [];
  rx.onFrame = (fr) => got.push({ ham: fr.ham, text: fr.text, freq: Math.round(fr.freq) });
  await rx._attemptDecode();
  const ham = got.filter((g) => g.ham).map((g) => g.ham + ' @' + g.freq).sort();
  check('deux messages standard en frame.ham, avec leur fréquence', JSON.stringify(ham) === JSON.stringify(['CQ F4MTX JN18 @1200', 'F4MTX K1ABC R-08 @1500']), got);
  check('texte libre toujours en frame.text (chemin ChatMTX)', got.some((g) => g.text === 'TNX BOB 73 GL' && !g.ham), got);
  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
  process.exit(failures ? 1 : 0);
})();

// Word frequencies: the text is one big string that every thread reads. Each
// thread counts the words in its slice into its own Map and returns the Map
// itself, which the main thread merges: no serializing, no copying.
const WORDS = 1_500_000;

// made-up text: words of 2-7 letters, a few much more common than the rest
const makeText = () => {
  let seed = 42;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const vocab = [];
  for (let i = 0; i < 5000; i++) {
    let w = '';
    const len = 2 + Math.floor(random() * 6);
    for (let k = 0; k < len; k++) w += 'etaoinshrdlucmfwypvbgkqjxz'[Math.floor(random() * random() * 26)];
    vocab.push(w);
  }
  const words = [];
  for (let i = 0; i < WORDS; i++) words.push(vocab[Math.floor(random() * random() * vocab.length)]);
  return words.join(' ');
};

const countWords = (text, lo0, hi0) => {
  let lo = +lo0, hi = +hi0;
  // move both ends to the start of a word, so no word is split between two threads
  while (lo > 0 && text[lo - 1] !== ' ') lo++;
  while (hi < text.length && text[hi - 1] !== ' ') hi++;
  const counts = new Map();
  let start = lo;
  for (let i = lo; i <= hi; i++) {
    if (i === hi || text[i] === ' ') {
      if (i > start) {
        const w = text.slice(start, i);
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
      start = i + 1;
    }
  }
  return counts;
};

// count with some threads, each taking a slice of the text, and merge what they return
const count = (text, threads) => {
  const ts = [];
  for (let t = 0; t < threads; t++) {
    const lo = Math.floor(text.length * t / threads), hi = Math.floor(text.length * (t + 1) / threads);
    ts.push(new Thread(() => countWords(text, lo, hi)));
  }
  const total = new Map();
  for (const t of ts) for (const [ w, n ] of t.join()) total.set(w, (total.get(w) ?? 0) + n);
  return total;
};

const text = makeText();
count(text, 1); // a first run also grows the heap: leave it out of the timings
let base = 0, total;
for (const threads of [ 1, 2, 4, 8 ]) {
  const t0 = performance.now();
  total = count(text, threads);
  const ms = performance.now() - t0;
  if (threads === 1) base = ms;
  let sum = 0;
  for (const n of total.values()) sum += n;
  console.log(`threads ${threads}  ${ms.toFixed(0).padStart(5)} ms  ${(base / ms).toFixed(2)}x  ${sum} words, ${total.size} different`);
}
const top = [ ...total ].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('most common:', top.map(([ w, n ]) => `${w} ${n}`).join(', '));
// these threads allocate a lot (a string per word), and a collection stops every
// thread, so this one scales less than the number crunching ones

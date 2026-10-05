const m = new Map();
for (let i = 0; i < 1000; i++) m.set(i, i);
let s = 0;
for (let r = 0; r < 3000; r++) for (let i = 0; i < 1000; i++) { m.set(i, m.get(i) + 1); }
console.log(m.get(5));

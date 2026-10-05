const a = [];
for (let i = 0; i < 1000; i++) a.push(i);
let s = 0;
for (let r = 0; r < 20000; r++) {
  for (let i = 0; i < 1000; i++) a[i] = a[i] + r;
  s += a[r % 1000];
}
console.log(s);

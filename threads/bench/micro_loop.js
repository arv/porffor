let s = 0;
for (let i = 0; i < 300000000; i++) s = (s + i) | 0;
console.log(s);

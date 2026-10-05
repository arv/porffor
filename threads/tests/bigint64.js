// BigInt64Array elements written by another thread
const b = new BigInt64Array(4);
const t = new Thread(() => { b[1] = 5n; b[3] = -7n; return b[1] === 5n && b[3] === -7n; });
console.log(t.join(), b[1] === 5n);

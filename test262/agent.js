// $262.agent over threads, for the tests that use it (index.js adds this to them and rewrites
// each $262.agent.start(`source`) to $262.agent.start(__agent => { source }), as porffor
// compiles ahead of time and cannot run a source string). each agent is a thread running its
// source as a closure, with __agent as its own $262.agent; agents share globals with the main
// agent, unlike separate agents would, but talk only through shared memory and reports anyway
var __porfAgentState = new Int32Array(new SharedArrayBuffer(8)); // [0] broadcast sent, [1] agents that took it
var __porfAgentBox = { sab: null, id: 0 };
var __porfAgentReports = [];
var __porfAgentCount = 0;
var __porfAgentSleep = ms => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
var __porfAgentNow = () => performance.now();
// atomicsHelper.js installs this same fallback through this.setTimeout, which does not make
// a global binding here
var setTimeout = (callback, delay) => {
  const end = Date.now() + delay;
  const check = () => {
    if (end - Date.now() > 0) Promise.resolve().then(check);
      else callback();
  };
  Promise.resolve().then(check);
};
var __porfAgent = {
  start(fn) {
    __porfAgentCount++;
    const self = {
      // waits for the broadcast, then calls back with it
      receiveBroadcast(cb) {
        while (Atomics.load(__porfAgentState, 0) === 0) Atomics.wait(__porfAgentState, 0, 0);
        const sab = __porfAgentBox.sab, id = __porfAgentBox.id;
        Atomics.add(__porfAgentState, 1, 1);
        Atomics.notify(__porfAgentState, 1);
        cb(sab, id);
      },
      report(value) {
        __porfAgentReports.push(String(value));
      },
      leaving() {},
      sleep: __porfAgentSleep,
      monotonicNow: __porfAgentNow
    };
    new Thread(() => fn(self));
  },
  // returns once every agent has taken it
  broadcast(sab, id) {
    __porfAgentBox.sab = sab;
    __porfAgentBox.id = id;
    Atomics.store(__porfAgentState, 0, 1);
    Atomics.notify(__porfAgentState, 0);
    let took;
    while ((took = Atomics.load(__porfAgentState, 1)) < __porfAgentCount) Atomics.wait(__porfAgentState, 1, took, 10);
  },
  getReport() {
    return __porfAgentReports.length > 0 ? __porfAgentReports.shift() : null;
  },
  sleep: __porfAgentSleep,
  monotonicNow: __porfAgentNow
};

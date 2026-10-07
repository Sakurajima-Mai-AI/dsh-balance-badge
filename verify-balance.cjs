/**
 * Offline verification for dsh-plugin-balance's browser bundle.
 *
 * Two failure modes are guarded here:
 *  1. a synchronous throw inside `apply()`. The client web-boot audit treats any
 *     plugin whose fiber is not `active` as a boot failure ("web boot: N entry did
 *     not activate"), so an `apply()` that throws takes the whole GUI down rather
 *     than degrading. The live client has no `timer` service, so this harness
 *     mirrors that: `ctx.interval` is absent and `addEventListener` is withheld.
 *  2. silently wrong balance bookkeeping - the amount shown, the decimals rule,
 *     and the running charge derived from consecutive readings.
 *
 *
 * Runtime constraints learned the hard way on this client:
 *  - there is no `timer` service (no shipped client plugin injects one), so `ctx.interval`
 *    is undefined and calling it makes the fiber fail and web boot refuse to start the app;
 *  - timer globals must be called BARE (`setInterval(...)`), never as `globalThis.setInterval`,
 *    or the poll can silently stop scheduling;
 *  - `ctx.remote.$on` may be absent, so event subscriptions must be guarded;
 *  - `apply()` must return without throwing: the boot audit treats a non-active plugin as a
 *    fatal startup failure, which takes the whole GUI down rather than degrading;
 *  - the platform reports a charge seconds after work stops, so a poll delay alone does not
 *    explain a slow hint - check whether the balance moved at all before tuning the cadence.
 *
 * Usage: node verify-balance.cjs <plugin-dir>
 */
const fs = require("fs");
const path = require("path");

// Real timers are captured before the bundle's globals are stubbed, so the test
// can await the async reads it triggers.
const realSetTimeout = globalThis.setTimeout;

const base = process.argv[2];
if (!base) {
  console.error("usage: node verify-balance.cjs <plugin-dir>");
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail === undefined ? "" : " -> " + detail}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------- environment
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
};

const registry = new Map();
const timers = new Map();
let timerSeq = 0;
const intervals = [];
const cleared = [];

// Proxy-backed window: unknown properties resolve to the real global, so a
// bundle reaching for `window.setTimeout` sees what a browser would.
globalThis.window = new Proxy(
  { __ModuleLoader__: { load: (mod) => registry.set(mod.id, mod) } },
  {
    get: (target, prop) => (prop in target ? target[prop] : globalThis[prop]),
    has: (target, prop) => prop in target || prop in globalThis,
  },
);
globalThis.document = {
  visibilityState: "visible",
  head: { appendChild() {} },
  createElement: () => ({ dataset: {}, style: {} }),
  querySelector: () => null,
};

// The bundle polls through the BARE browser globals; the interval is recorded so
// the test can fire one tick by hand. Detached retries stay parked.
globalThis.setInterval = (fn, ms) => {
  const id = ++timerSeq;
  intervals.push({ id, ms });
  timers.set(id, fn);
  return id;
};
globalThis.clearInterval = (id) => {
  cleared.push(id);
  timers.delete(id);
};
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

// -------------------------------------------------------------- load bundle
const manifest = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
const pluginName = manifest.name;
const bundlePath = path.join(base, "lib", "client.js");
const source = fs.readFileSync(bundlePath, "utf8");
new Function("window", "document", "console", source)(globalThis.window, globalThis.document, console);

const loaded = registry.get(pluginName);
check("bundle registers as " + pluginName, loaded !== undefined);
if (!loaded) process.exit(1);

const mod = loaded.factory((spec) => {
  if (spec === "react" || spec === "react/jsx-runtime") return react;
  throw new Error(`unexpected require: ${spec}`);
});

check("exports.apply is a function", typeof mod.apply === "function");
check("exports.inject is an array", Array.isArray(mod.inject), JSON.stringify(mod.inject));
// The client has no `timer` service (no shipped client plugin injects it), so
// depending on it would leave the fiber pending and fail web boot.
check("inject does NOT depend on the absent timer service", Array.isArray(mod.inject) && !mod.inject.includes("timer"));
check("inject declares slots/locale/remote", ["slots", "locale", "remote"].every((s) => mod.inject.includes(s)));

// ------------------------------------------------------------------- context
let answer = {
  ok: true,
  value: {
    status: "ready",
    // deliberately over-precise: the display must shorten it to three decimals
    value: [{ currency: "CNY", balance: "12.34560" }],
    bonusWallets: [{ currency: "CNY", balance: "5.00" }],
  },
};
const meta = [];
const remoteHandlers = new Map();
const registrations = [];
const effects = [];
let dict = null;

const ctx = {
  effect: (fn, label) => {
    const dispose = fn();
    effects.push({ label, dispose });
    return dispose;
  },
  interval: undefined, // deliberately absent: the client only mixes this in when timer is injected
  locale: {
    getSnapshot: () => ({ active: "zh" }),
    register: (ns, d) => {
      dict = d;
      return () => {};
    },
    bind: () => (key, params) => {
      let out = (dict && dict.zh[key]) || key;
      for (const [k, v] of Object.entries(params || {})) out = out.replace("{" + k + "}", String(v));
      return out;
    },
  },
  remote: {
    account: {
      getBalance: async (m) => {
        meta.push(m);
        return answer;
      },
    },
    $on: (event, listener) => {
      remoteHandlers.set(event, listener);
      return () => remoteHandlers.delete(event);
    },
  },
  slots: {
    inject: (slot, cb) => {
      effects.push({ label: "slots.inject:" + slot, dispose: cb() });
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

let applyError = null;
try {
  mod.apply(ctx);
} catch (error) {
  applyError = error;
}
check("apply() does not throw (the real boot-failure mode)", applyError === null, applyError && applyError.message);

check(
  "registers the sidebar badge",
  registrations.some((r) => r.options.name === "sidebar.footer.action" && r.options.id === "balance"),
  JSON.stringify(registrations.map((r) => r.options.name + "#" + r.options.id)),
);
check("installs one polling interval", intervals.length === 1 && intervals[0].ms > 0 && intervals[0].ms <= 15000, JSON.stringify(intervals));
check("registers dictionaries", dict !== null && Object.keys(dict.zh).length > 0);

const find = (name) => registrations.find((r) => r.options.name === name);
const tick = () => {
  for (const fn of timers.values()) {
    fn();
    return;
  }
};
const wait = () => new Promise((resolve) => realSetTimeout(resolve, 5));
const nodes = (n) => [n, ...(((n && n.children) || []).flatMap(nodes))];
const classes = (n) => [n && n.props && n.props.className, ...(((n && n.children) || []).flatMap(classes))];

// ------------------------------------------------------------- data plumbing
(async () => {
  await wait();

  const badgeReg = find("sidebar.footer.action");
  const store = badgeReg.options.inject().hooks.balance;
  const renderBadge = (wide) => badgeReg.component({ useBalance: (sel) => sel(store.getSnapshot()), wide });
  // The charge is inlined in the sidebar badge now, immediately right of the amount.
  const renderCharge = () => renderBadge(true);
  const chargeClasses = () => classes(renderCharge());
  const snap = () => store.getSnapshot();

  check("inject exposes hooks.balance store", typeof store.getSnapshot === "function");
  check("first read settled to ready", snap().status === "ready", snap().status);
  check("main balance shortened to three decimals", snap().wallets[0] !== undefined && snap().wallets[0].text === "\u00a512.345", JSON.stringify(snap().wallets[0]));
  check("bonus wallet parsed", snap().wallets[1] !== undefined && snap().wallets[1].text === "\u00a55.00", JSON.stringify(snap().wallets[1]));
  check(
    "account metadata carries version/locale/tz",
    meta.length > 0 && typeof meta[0].version === "string" && meta[0].locale === "zh" && typeof meta[0].timezoneOffsetSeconds === "number",
    JSON.stringify(meta[0]),
  );

  const badge = renderBadge(true);
  check("badge renders a button", badge.type === "button");
  check("badge tooltip is localized", typeof badge.props.title === "string" && badge.props.title.includes("\u4f59\u989d"), JSON.stringify(badge.props.title));
  check("badge does not render the literal label text", !classes(badge).includes("dsh-balance-label"));
  check("badge renders a coin icon", nodes(badge).some((x) => x && x.type === "svg"));
  check("collapsed rail renders a dot instead of bonus text", classes(renderBadge(false)).includes("dsh-balance-dot"));

  // A spent-out or absent granted credit must not occupy the row.
  const spentView = badgeReg.component({
    useBalance: (sel) => sel({ status: "ready", currency: "CNY", raw: ["12.34500", "0.00000"], wallets: [{ currency: "CNY", text: "\u00a512.345" }, { currency: "CNY", text: "\u00a50.000" }], deduct: null, updatedAt: Date.now() }),
    wide: true,
  });
  check("a zero granted credit is hidden", !classes(spentView).includes("dsh-balance-bonus"), JSON.stringify(classes(spentView)));
  check("its tooltip line is hidden too", !spentView.props.title.includes("\u8d60\u9001\u989d\u5ea6"), JSON.stringify(spentView.props.title));

  const noBonusView = badgeReg.component({
    useBalance: (sel) => sel({ status: "ready", currency: "CNY", raw: ["12.34500"], wallets: [{ currency: "CNY", text: "\u00a512.345" }], deduct: null, updatedAt: Date.now() }),
    wide: true,
  });
  check("an absent granted credit stays hidden", !classes(noBonusView).includes("dsh-balance-bonus"), JSON.stringify(classes(noBonusView)));

  // ...while a funded one still renders.
  check("a funded granted credit still renders", classes(renderBadge(true)).includes("dsh-balance-bonus"));

  // --- charge hint -----------------------------------------------------------
  check("no separate composer charge seat remains", find("conversation.input.right") === undefined);
  check("no charge shown before any drop", !chargeClasses().includes("dsh-balance-deduct"));

  // a 0.0105 drop is a charge: minus sign, three decimals, error colour
  answer = { ok: true, value: { status: "ready", value: [{ currency: "CNY", balance: "12.34535" }], bonusWallets: [{ currency: "CNY", balance: "5.00" }] } };
  tick();
  await wait();
  const hint = renderCharge();
  check("charge appears after a drop", chargeClasses().includes("dsh-balance-deduct"), JSON.stringify(snap().deduct));
  check("charge hint catches a sub-milliyuan drop at 4 decimals", /\u00a50\.000\d/.test(JSON.stringify(hint)), JSON.stringify(hint));
  check("charge hint uses the red charge style", JSON.stringify(hint).includes("dsh-balance-deduct"));
  check("charge hint is announced accessibly", JSON.stringify(hint).includes("\u6263\u8d39"));

  // a second charge inside the window accumulates into one running total
  answer = { ok: true, value: { status: "ready", value: [{ currency: "CNY", balance: "12.34510" }], bonusWallets: [{ currency: "CNY", balance: "5.00" }] } };
  tick();
  await wait();
  check("a second charge accumulates into a running total", JSON.stringify(snap().deduct).includes("0.0005"), JSON.stringify(snap().deduct));

  // --- failure handling ------------------------------------------------------
  answer = { ok: false, error: { code: "disconnected" } };
  tick();
  await wait();
  check("transient failure is annotated", snap().status === "failed", snap().status);
  check("transient failure keeps the last reading", snap().wallets[0] !== undefined && snap().wallets[0].text === "\u00a512.345", JSON.stringify(snap().wallets[0]));
  check("transient failure keeps the running total", snap().deduct !== null && Math.abs(snap().deduct.amount - 0.0005) < 1e-9, JSON.stringify(snap().deduct));
  const stale = renderBadge(true);
  check("stale badge still renders the amount", classes(stale).includes("dsh-balance-value"));
  check("stale badge is marked with a dot", classes(stale).includes("dsh-balance-dot"));
  check("stale tooltip explains the failure", typeof stale.props.title === "string" && stale.props.title.includes("\u5931\u8d25"), JSON.stringify(stale.props.title));

  // a rising balance is a top-up, not a charge
  answer = { ok: true, value: { status: "ready", value: [{ currency: "CNY", balance: "20.00000" }], bonusWallets: [{ currency: "CNY", balance: "5.00" }] } };
  tick();
  await wait();
  check("a top-up clears the charge", !chargeClasses().includes("dsh-balance-deduct"), JSON.stringify(snap().deduct));
  check("top-up shows the new balance with three decimals", snap().wallets[0].text === "\u00a520.000", snap().wallets[0].text);

  // A charge drawn from the BONUS wallet must count too: that is the wallet a
  // new account actually spends from, and watching only the top-up wallet is
  // exactly the bug that made the hint never appear.
  answer = { ok: true, value: { status: "ready", value: [{ currency: "CNY", balance: "20.00000" }], bonusWallets: [{ currency: "CNY", balance: "5.00000" }] } };
  tick();
  await wait();
  answer = { ok: true, value: { status: "ready", value: [{ currency: "CNY", balance: "20.00000" }], bonusWallets: [{ currency: "CNY", balance: "4.90000" }] } };
  tick();
  await wait();
  const bonusSnap = snap();
  check(
    "a bonus-wallet drop is detected even when the top-up wallet is unchanged",
    bonusSnap.deduct !== null && Math.abs(bonusSnap.deduct.amount - 0.1) < 1e-9,
    JSON.stringify(bonusSnap.deduct),
  );
  check("the bonus charge is drawn too", chargeClasses().includes("dsh-balance-deduct"));
  check("the charge records which wallet paid", bonusSnap.deduct.source === "bonus", JSON.stringify(bonusSnap.deduct));

  // A session status transition must read at once rather than wait for the poll:
  // that is what makes a charge show up promptly.
  check("subscribes to the session status event", typeof remoteHandlers.get("api-session/status") === "function");
  const readsBefore = meta.length;
  answer = { ok: true, value: { status: "ready", value: [{ currency: "CNY", balance: "19.99000" }], bonusWallets: [{ currency: "CNY", balance: "4.90000" }] } };
  remoteHandlers.get("api-session/status")({});
  await wait();
  check("a session status change reads the balance immediately", meta.length > readsBefore, `reads ${readsBefore} -> ${meta.length}`);
  // 0.1 from the bonus case above plus this 0.01: an unexpired hint accumulates.
  check("the eager read picks up the charge", snap().deduct !== null && Math.abs(snap().deduct.amount - 0.11) < 1e-9, JSON.stringify(snap().deduct));

  // signing out clears everything
  answer = { ok: true, value: null };
  tick();
  await wait();
  check("signed-out is reported", snap().status === "signed-out", snap().status);
  check("signed-out clears the wallets", snap().wallets.length === 0, JSON.stringify(snap().wallets));
  check("signed-out clears the charge hint", snap().deduct === null, JSON.stringify(snap().deduct));

  const intervalEffect = effects.find((e) => e.label === "plugin-balance: polling");
  if (intervalEffect) intervalEffect.dispose();
  check("polling interval is cleared on teardown", cleared.length > 0, JSON.stringify(cleared));

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();

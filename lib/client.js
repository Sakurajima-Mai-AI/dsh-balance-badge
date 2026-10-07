window.__ModuleLoader__.load({
	id: "dsh-balance-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Platform baseline modules; no dsh.client.external request is needed. */
		const react = require("react");

		/**
		 * Browser build identity carried on every account Remote call.
		 * accountController requires { version, locale, timezoneOffsetSeconds }
		 * and answers null when the account grant is absent or changed.
		 */
		const CLIENT_VERSION = "0.2.0-rc.2";
		/** Background refresh cadence in milliseconds. The platform reports a charge
		 * seconds after work stops, so the read following it is what surfaces it. */
		const REFRESH_MS = 2000;
		/** A drop below this many units is noise, not a charge. */
		const MIN_DEDUCT = 0.00005;
		/** How long the charge hint stays on screen after a charge. */
		const DEDUCT_MS = 300000;
		/** First-paint retry delay when the opening read has not answered yet. */
		const FIRST_RETRY_MS = 2000;

		const NS = "balance";

		const DICT = {
			en: {
				"label.balance": "Balance",
				"label.bonus": "Credit",
				"state.loading": "Reading balance...",
				"state.signedOut": "Not signed in",
				"state.failed": "Balance unavailable",
				"state.failedHint": "Balance read failed",
				"tooltip.balance": "Balance: {value}",
				"tooltip.bonus": "Granted credit: {value}",
				"tooltip.updated": "Updated {time}",
				"tooltip.refresh": "Click to refresh now",
				"a11y": "Account balance",
				"deduct": "-{amount}",
				"deductA11y": "Recent charge: {amount}",
				"deductA11yBonus": "Recent charge: {amount} (from granted credit)",
			},
			zh: {
				"label.balance": "余额",
				"label.bonus": "赠送",
				"state.loading": "读取余额中...",
				"state.signedOut": "未登录",
				"state.failed": "余额读取失败",
				"state.failedHint": "余额读取失败",
				"tooltip.balance": "余额：{value}",
				"tooltip.bonus": "赠送额度：{value}",
				"tooltip.updated": "更新于 {time}",
				"tooltip.refresh": "点击立即刷新",
				"a11y": "账户余额",
				"deduct": "-{amount}",
				"deductA11y": "最近一次扣费：{amount}",
				"deductA11yBonus": "最近一次扣费：{amount}（来自赠送额度）",
			},
		};

		/** Services this plugin reads; registration and locale are hard requirements. */
		const inject = ["slots", "locale", "remote", "remote.account"];

		const CSS = ".dsh-balance-badge{display:flex;align-items:center;gap:4px;box-sizing:border-box;width:100%;min-width:0;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;text-align:left}.dsh-balance-badge:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsh-balance-badge:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.dsh-balance-badge[data-state=\"loading\"],.dsh-balance-badge[data-state=\"signed-out\"],.dsh-balance-badge[data-state=\"failed\"]{color:var(--dsw-alias-label-caption);cursor:default}.dsh-balance-badge[data-wide=\"false\"]{flex:none;justify-content:center;width:auto;padding:0 4px}.dsh-balance-value{flex:none;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}.dsh-balance-bonus{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}.dsh-balance-sep{flex:none;opacity:.4}.dsh-balance-dot{flex:none;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,currentColor);opacity:.8}.dsh-balance-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}.dsh-balance-deduct{flex:none;margin-left:auto;display:inline-flex;align-items:center;height:18px;padding:0 4px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;animation:dsh-balance-deduct-in .16s var(--ds-ease-in-out) both}@keyframes dsh-balance-deduct-in{0%{opacity:0;transform:translateY(2px)}}.dsh-balance-root .dsh-balance-actions{display:flex;flex-direction:column;align-items:stretch;gap:2px;width:100%}";

		const CSS_TAG_ID = "dsh-balance-badge/balance-badge.css";
		/** One stylesheet per page, not per plugin instance. */
		const styleTag = document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]");
		if (typeof document !== "undefined" && styleTag === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-badge";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const CURRENCY_SYMBOL = { CNY: "\u00A5", USD: "$" };

		/**
		 * The badge marker: a coin. It carries the "this is money" signal that a text
		 * label would, without any text a narrow column could squeeze into a vertical
		 * stack. Decorative only - the button owns the accessible name.
		 */
		const COIN_ICON = react.createElement(
			"svg",
			{ width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
			[
				react.createElement("circle", { key: "c", cx: "8", cy: "8", r: "6.25", stroke: "currentColor", strokeWidth: "1.3" }),
				react.createElement("path", { key: "s", d: "M8 4.6v6.8M10.1 6.2c0-.9-.94-1.5-2.1-1.5s-2.1.6-2.1 1.5.94 1.35 2.1 1.6 2.1.71 2.1 1.6-.94 1.5-2.1 1.5-2.1-.6-2.1-1.5", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
			],
		);

		/**
		 * Shorten a Platform balance to a display amount: at most two decimals, and
		 * never more digits than the wallet actually reports. The wire value is a
		 * string, so a non-numeric one is passed through untouched.
		 * @param amount - raw wallet balance.
		 * @returns display amount.
		 */
		function formatAmount(amount) {
			const raw = String(amount);
			if (raw === "") return raw;
			if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw;
			const dot = raw.indexOf(".");
			const decimals = dot === -1 ? 0 : raw.length - dot - 1;
			if (decimals <= 3) return raw;
			return raw.slice(0, dot + 4);
		}

		/**
		 * Shorten a charge for display, keeping one significant digit: a charge below
		 * a tenth of a cent would otherwise read as a meaningless zero.
		 * @param amount - charge in currency units.
		 * @returns the amount string.
		 */
		function formatCharge(amount) {
			if (amount >= 0.001) return amount.toFixed(3);
			if (amount >= 0.0001) return amount.toFixed(4);
			if (amount >= 0.00001) return amount.toFixed(5);
			return amount.toFixed(6);
		}

		/** Narrow one currency balance into a display-ready wallet row. */
		function formatWallet(currency, amount) {
			if (amount === undefined || amount === null) return undefined;
			const value = formatAmount(amount);
			if (value === "") return undefined;
			return {
				currency,
				text: (CURRENCY_SYMBOL[currency] ?? currency + " ") + value,
			};
		}

		/** @returns whether two wallet rows hold the very same amount. */
		function sameWallet(a, b) {
			if (a === undefined || b === undefined) return a === b;
			return a.currency === b.currency && a.text === b.text;
		}

		/**
		 * @param raw - a raw wallet balance straight off the wire.
		 * @returns its numeric amount, or null when it is not numeric.
		 */
		function rawAmount(raw) {
			if (raw === undefined || raw === null) return null;
			const parsed = Number.parseFloat(String(raw));
			return Number.isFinite(parsed) ? parsed : null;
		}

		/** Read the account holder's active UI language, defaulting to Chinese. */
		function readLocale(ctx) {
			try {
				const active = ctx.locale.getSnapshot().active;
				if (typeof active === "string" && active !== "") return active;
			} catch (error) {
				void error;
			}
			return "zh";
		}

		/** Build the per-call Platform client identity, read at call time. */
		function accountClientMetadata(locale) {
			return {
				version: CLIENT_VERSION,
				locale,
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
			};
		}

		/** Format one update stamp for the tooltip. */
		function formatUpdated(ms) {
			try {
				return new Date(ms).toLocaleTimeString();
			} catch (error) {
				void error;
				return "";
			}
		}

		/** Register the browser half: one snapshot store plus one sidebar foot entry. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, DICT), "plugin-balance: dictionaries");
			const t = ctx.locale.bind(NS);

			/** One store per plugin instance; the renderer binds its own selector hooks. */
			const store = {
				state: { status: "loading", wallets: [], raw: null, currency: null, deduct: null, updatedAt: null },
				listeners: new Set(),
				getSnapshot() {
					return this.state;
				},
				subscribe(listener) {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				},
				publish(next) {
					this.state = next;
					for (const listener of [...this.listeners]) listener();
				},
				/**
				 * Derive the charge two consecutive readings prove. The account Remote is
				 * the only authority on what a task cost, so the charge is the drop between
				 * the caller's pre-publish snapshot and the fresh reading. A charge landing
				 * while one is still on screen accumulates, so a long task reads as one
				 * running total instead of a flicker of deltas.
				 * @param previousWallets - wallet rows from the previous reading.
				 * @param wallets - wallet rows just read.
				 */
				noteBalance(previousRaw, rawValue) {
					const current = this.state;
					const currency = current.currency;
					const now = Date.now();
					// An unexpired hint keeps accumulating, so a long task reads as one total.
					let deduct = current.deduct !== null && current.deduct !== undefined && now - current.deduct.at < DEDUCT_MS ? current.deduct : null;
					const before = Array.isArray(previousRaw) ? previousRaw : [];
					const after = Array.isArray(rawValue) ? rawValue : [];
					let spentDelta = 0;
					let risen = 0;
					let paidFromBonus = false;
					for (let i = 0; i < after.length; i += 1) {
						const prevVal = rawAmount(before[i]);
						const nextVal = rawAmount(after[i]);
						if (prevVal === null || nextVal === null) continue;
						if (nextVal < prevVal - MIN_DEDUCT) {
							spentDelta += prevVal - nextVal;
							if (i > 0) paidFromBonus = true;
						} else if (nextVal > prevVal + MIN_DEDUCT) risen += nextVal - prevVal;
					}
					if (spentDelta > 0) {
						const delta = Math.round(spentDelta * 1000000) / 1000000;
						const total = deduct !== null && deduct.currency === currency ? Math.round((deduct.amount + delta) * 1000000) / 1000000 : delta;
						deduct = { amount: total, currency, at: now, source: paidFromBonus ? "bonus" : "balance" };
						console.info("[dsh-balance-badge] charge detected:", currency, delta, "running total:", total);
					} else if (risen > 0) {
						// A rising balance is a top-up, not spending: retire the hint.
						deduct = null;
					}
					const previousAmount = current.deduct === null || current.deduct === undefined ? null : current.deduct.amount;
					const deductAmount = deduct === null ? null : deduct.amount;
					if (JSON.stringify(previousRaw) === JSON.stringify(rawValue) && deductAmount === previousAmount) return;
					this.publish({ ...current, raw: rawValue, deduct, updatedAt: now });
				},
			};

			let inFlight = false;
			let disposed = false;
			let firstSettled = false;
			const timers = new Set();

			/** Schedule one detached retry; the ownership set is drained on teardown. */
			function later(fn, delay) {
				if (typeof setTimeout !== "function") return;
				const timer = setTimeout(() => {
					timers.delete(timer);
					fn();
				}, delay);
				timers.add(timer);
			}

			/**
			 * Read the wallet balance once. A null payload means the account grant is
			 * absent or changed (signed out); a failed status or transport error keeps
			 * the last known value and only annotates it, so a transient network error
			 * never blanks the display.
			 */
			async function refresh() {
				if (disposed || inFlight) return;
				inFlight = true;
				const previous = store.getSnapshot();
				if (previous.status === "loading" || previous.status === "idle") store.publish({ ...previous, status: "loading" });
				try {
					const answer = await ctx.remote.account.getBalance(accountClientMetadata(readLocale(ctx)));
					if (disposed) return;
					if (!answer.ok) {
						console.warn("[dsh-balance-badge] balance read refused:", answer.error);
						// Keep the last good wallets: a refused poll must not blank a known balance.
						store.publish({ ...store.getSnapshot(), status: "failed" });
						return;
					}
					const payload = answer.value;
					if (payload === null) {
						store.publish({ status: "signed-out", wallets: [], raw: null, currency: null, deduct: null, updatedAt: null });
						return;
					}
					if (payload.status !== "ready") {
						store.publish({ ...store.getSnapshot(), status: "failed" });
						return;
					}
					const wallets = [];
					const rawBalances = [];
					const head = payload.value[0];
					const currency = head === undefined ? undefined : head.currency;
					const main = head === undefined ? undefined : formatWallet(head.currency, head.balance);
					if (main !== undefined) {
						wallets.push(main);
						rawBalances.push(head.balance);
					}
					const bonus = payload.bonusWallets.find((wallet) => wallet.currency === currency) ?? payload.bonusWallets[0];
					if (bonus !== undefined) {
						const narrowed = formatWallet(bonus.currency, bonus.balance);
						if (narrowed !== undefined) {
							wallets.push(narrowed);
							rawBalances.push(bonus.balance);
						}
					}
					store.publish({ status: "ready", wallets, raw: rawBalances, currency, deduct: previous.deduct ?? null, updatedAt: Date.now() });
					store.noteBalance(previous.raw, rawBalances);
				} catch (error) {
					if (disposed) return;
					console.warn("[dsh-balance-badge] balance read failed:", error);
					// Same rule on a transport error: annotate, never wipe.
					store.publish({ ...store.getSnapshot(), status: "failed" });
				} finally {
					inFlight = false;
					firstSettled = true;
				}
			}

			refresh();

			/**
			 * Poll on the shared timer service, through the BARE browser globals: this
			 * client withholds some timer forms, and the bare interval is the one proven
			 * to work here. Guarded so a runtime without it still loads.
			 */
			ctx.effect(() => {
				if (typeof setInterval !== "function") return undefined;
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					refresh();
				}, REFRESH_MS);
				return () => clearInterval(timer);
			}, "plugin-balance: polling");
			console.info("[dsh-balance-badge] mounted; polling every", REFRESH_MS, "ms");

			/**
			 * A session changing state is the moment a charge lands, so read at once
			 * instead of waiting for the next poll. Throttled because one task emits
			 * several status transitions.
			 */
			let statusReadAt = 0;
			ctx.effect(() => {
				// The Remote event face is optional: a client without it must still load
				// this plugin, so degrade to plain polling instead of throwing.
				if (typeof ctx.remote.$on !== "function") return undefined;
				return ctx.remote.$on("api-session/status", () => {
					const now = Date.now();
					if (now - statusReadAt < 1000) return;
					statusReadAt = now;
					refresh();
				});
			}, "plugin-balance: eager read on session status");

			/**
			 * The opening read can race the Remote connection. Retry briefly until one
			 * read settles, then let the normal cadence own the schedule.
			 */
			ctx.effect(() => {
				let tries = 0;
				const tick = () => {
					if (disposed || firstSettled || tries >= 5) return;
					tries += 1;
					refresh();
					later(tick, FIRST_RETRY_MS);
				};
				later(tick, FIRST_RETRY_MS);
				return () => {
					for (const timer of timers) clearTimeout(timer);
					timers.clear();
				};
			}, "plugin-balance: first read");

			/** A window the user just returned to is the moment a top-up became visible. */
			ctx.effect(() => {
				const onFocus = () => {
					refresh();
				};
				globalThis.addEventListener?.("focus", onFocus);
				return () => {
					globalThis.removeEventListener?.("focus", onFocus);
				};
			}, "plugin-balance: refresh on focus");

			ctx.effect(() => () => {
				disposed = true;
			}, "plugin-balance: teardown");

			/**
			 * The sidebar-foot badge. Wide renders a descriptive pill; the collapsed
			 * rail keeps only the amount, which is the part a glance needs.
			 */
			/**
			 * The red running charge, shown beside the composer while a task burns
			 * credit. Silent until the account Remote reports an actual drop.
			 */
			/**
			 * The red running charge, rendered immediately right of the amount. It
			 * stays silent until the account Remote reports an actual drop.
			 * @param deduct - current charge record, or null.
			 * @param t - locale translator.
			 * @returns the charge element, or null when there is nothing to show.
			 */
			function chargeNode(deduct, t) {
				if (deduct === null || deduct === undefined) return null;
				const symbol = CURRENCY_SYMBOL[deduct.currency] ?? deduct.currency + " ";
				const amount = symbol + formatCharge(deduct.amount);
				const label = deduct.source === "bonus" ? t("deductA11yBonus", { amount }) : t("deductA11y", { amount });
				return react.createElement(
					"span",
					{ className: "dsh-balance-deduct", title: label, "aria-label": label },
					[t("deduct", { amount })],
				);
			}

			function BalanceBadge({ useBalance, wide }) {
				const state = useBalance((snapshot) => snapshot);
				const wallets = state.wallets;
				const main = wallets[0];
				const bonus = wallets[1];
				// A spent-out or absent granted credit is noise, so it appears only when it
				// actually holds something. Judged on the raw amount, not the rendered text.
				const bonusRaw = Array.isArray(state.raw) ? state.raw[1] : undefined;
				const bonusValue = rawAmount(bonusRaw);
				const showBonus = bonus !== undefined && bonusValue !== null && bonusValue > 0;

				const lines = [];
				if (main !== undefined) {
					lines.push(t("tooltip.balance", { value: main.text }));
					if (showBonus) lines.push(t("tooltip.bonus", { value: bonus.text }));
					if (state.deduct !== null && state.deduct !== undefined) {
						const chargeAmount = (CURRENCY_SYMBOL[state.deduct.currency] ?? state.deduct.currency + " ") + formatCharge(state.deduct.amount);
						lines.push(t(state.deduct.source === "bonus" ? "deductA11yBonus" : "deductA11y", { amount: chargeAmount }));
					}
					if (state.status !== "ready") lines.push(t("state.failedHint"));
				} else {
					lines.push(t("state." + state.status));
				}
				if (state.updatedAt !== null) lines.push(t("tooltip.updated", { time: formatUpdated(state.updatedAt) }));
				lines.push(t("tooltip.refresh"));

				const base = {
					type: "button",
					className: "dsh-balance-badge",
					"data-state": state.status,
					"data-wide": wide ? "true" : "false",
					title: lines.join("\n"),
					"aria-label": t("a11y"),
					onClick: () => {
						refresh();
					},
				};

				if (main === undefined) {
					const text = state.status === "loading" || state.status === "idle" ? "\u2026" : state.status === "signed-out" ? t("state.signedOut") : "\u26A0";
					return react.createElement("button", { ...base, disabled: state.status === "signed-out" }, [
						react.createElement("span", { key: "value", className: "dsh-balance-value" }, text),
					]);
				}

				const children = [
					react.createElement("span", { key: "icon", className: "dsh-balance-icon" }, COIN_ICON),
					react.createElement("span", { key: "value", className: "dsh-balance-value" }, main.text),
				];
				if (state.status !== "ready") children.push(react.createElement("span", { key: "stale", className: "dsh-balance-dot", "aria-hidden": "true" }));
				if (showBonus) {
					if (wide) {
						children.push(react.createElement("span", { key: "sep", className: "dsh-balance-sep" }, "\u00B7"));
						children.push(react.createElement("span", { key: "bonus", className: "dsh-balance-bonus" }, t("label.bonus") + " " + bonus.text));
					} else {
						children.push(react.createElement("span", { key: "bonusdot", className: "dsh-balance-dot", "aria-hidden": "true" }));
					}
				}
				// The charge owns the far right of the row, pushed there by its own margin.
				const charge = chargeNode(state.deduct, t);
				if (charge !== null && wide) children.push(charge);
				return react.createElement("button", base, children);
			}

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "balance",
				order: 0,
				locale: NS,
				inject: () => ({ hooks: { balance: store } }),
			}, BalanceBadge));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
						}
					});

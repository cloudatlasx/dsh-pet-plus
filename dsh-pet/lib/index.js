import { appendFileSync, closeSync, cpSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createHash, randomUUID } from "node:crypto";

//#region src/host/balance/internal.ts
/**
* 余额取数的内部工具（host 半侧）：网络策略、响应校验与金额处理。
*
* 只给 ./providers/* 使用，不含服务商知识，也不负责注册与路由。
* 统一 20s 超时加 3 次重试：目标端点多为境外，实测会间歇性超时。
* 依赖全局 fetch；始终成立：必填字段缺失或非法一律抛错，绝不静默当 0。
*
* @module dsh-pet/src/host/balance/internal
*/
/** 单次抓取超时（ms）。 */
const FETCH_TIMEOUT_MS = 2e4;
/** 单次抓取失败后的重试次数（间隔 0.8s）。 */
const RETRIES = 3;
/** 发起一次带超时的 fetch；失败抛错，是否重试由调用方决定。 */
async function fetchOnce(url, key) {
	return fetch(url, {
		headers: {
			Authorization: "Bearer " + key,
			"User-Agent": "dsh-pet-balance"
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}
async function fetchWithRetry(url, key) {
	let last;
	for (let i = 0; i <= RETRIES; i++) try {
		return await fetchOnce(url, key);
	} catch (e) {
		last = e;
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
function num(value, what) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return n;
}
function str$1(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return value;
}
function looseNum(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}
function obj(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* 归一重置时间：字符串原样返回，数字时间戳自动识别秒/毫秒。
* 0、负数与非法值返回 undefined —— 报文里空闲窗口的 resetAt: 0 是占位，不是 1970 年。
*/
function resetTime(value) {
	if (typeof value === "string") return value.length > 0 ? value : void 0;
	const n = looseNum(value);
	if (n === void 0 || n <= 0) return void 0;
	const ms = n < 1e12 ? n * 1e3 : n;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
function readWindow(value) {
	const w = obj(value);
	if (!w) return void 0;
	const used = looseNum(w.used);
	const cap = looseNum(w.cap);
	if (used === void 0 || cap === void 0 || cap <= 0) return void 0;
	return {
		percent: Math.max(0, used / cap * 100),
		capUsd: cap,
		resetsAt: resetTime(w.resetAt)
	};
}
function queryString(params) {
	const pairs = Object.entries(params).filter(([, v]) => v !== void 0);
	return pairs.length > 0 ? "?" + pairs.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&") : "";
}
function money(value, what) {
	const raw = str$1(value, what);
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 账号余额金额非法 " + what);
	return n.toFixed(2);
}
function sumMoney(a, b) {
	return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

//#endregion
//#region src/host/balance/providers/commandcode.ts
/** 控制面基址（/alpha/* 固定在根域名）。 */
const API_BASE = "https://api.commandcode.ai";
/** 滚动窗的展示名：本服务商的 5h 窗口即 windowLimits.fiveHour。 */
const ROLLING_LABEL$1 = "5h";
/** 抓一次 JSON，HTTP 非 2xx 抛错；label 是接口路径，只用于错误信息。 */
async function fetchJson(url, key, label) {
	const res = await fetchWithRetry(url, key);
	if (!res.ok) throw new Error("commandcode " + label + " HTTP " + res.status);
	return await res.json();
}
/**
* 从 usage 响应读区间用量（本期累计）；五个字段齐全才返回，缺一个即视为没有这项数据。
*
* 这些字段来自批量聚合（窗口百分比才是实时的），所以宁可整页不出，也不拿半份数字拼一张会漂的卡片。
*/
function readUsage(summary) {
	const totalTokens = looseNum(summary?.totalTokens);
	const inputTokens = looseNum(summary?.totalTokensIn);
	const outputTokens = looseNum(summary?.totalTokensOut);
	const requests = looseNum(summary?.totalCount);
	const spentUsd = looseNum(summary?.totalCost);
	if (totalTokens === void 0 || inputTokens === void 0 || outputTokens === void 0 || requests === void 0 || spentUsd === void 0) return void 0;
	return {
		totalTokens,
		inputTokens,
		outputTokens,
		requests,
		spentUsd
	};
}
function parseCommandCode(creditsBody, subscriptionBody, summaryBody, provider) {
	const root = obj(creditsBody);
	const credits = obj(root?.credits);
	if (!credits) throw new Error("dsh-pet: commandcode 响应缺少 credits");
	const creditFields = [
		credits.monthlyCredits,
		credits.purchasedCredits,
		credits.freeCredits
	];
	if (creditFields.every((v) => looseNum(v) === void 0)) throw new Error("dsh-pet: commandcode credits 响应缺少额度字段");
	const remaining = creditFields.reduce((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);
	const summary = obj(summaryBody);
	const spentRaw = summary?.totalCost;
	if (spentRaw === void 0 || spentRaw === null) throw new Error("dsh-pet: commandcode usage 响应缺少 totalCost");
	const spent = Math.max(0, num(spentRaw, "totalCost"));
	const pool$1 = spent + remaining;
	const data = { monthly: pool$1 > 0 ? spent / pool$1 * 100 : 0 };
	if (pool$1 > 0) data.monthlyCapUsd = pool$1;
	const usage = readUsage(summary);
	if (usage) data.usage = usage;
	const subscription = obj(obj(subscriptionBody)?.data);
	const periodEnd = subscription?.currentPeriodEnd;
	if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;
	const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
	if (limits?.limited === true) {
		const fiveHour = readWindow(limits.fiveHour);
		if (fiveHour) {
			data.rolling = fiveHour.percent;
			data.rollingCapUsd = fiveHour.capUsd;
			data.rollingLabel = ROLLING_LABEL$1;
			if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
		}
		const weekly = readWindow(limits.weekly);
		if (weekly) {
			data.weekly = weekly.percent;
			data.weeklyCapUsd = weekly.capUsd;
			if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
		}
	}
	return {
		ok: true,
		provider,
		shape: "windows",
		data
	};
}
const commandCode = {
	id: "commandcode",
	credential: {
		mode: "ref",
		ref: "COMMANDCODE_API_KEY"
	},
	async fetch({ key, provider }) {
		const whoami = obj(await fetchJson(API_BASE + "/alpha/whoami" + queryString({ limits: "1" }), key, "/alpha/whoami"));
		const org = obj(whoami?.org);
		const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : void 0;
		const credits = await fetchJson(API_BASE + "/alpha/billing/credits" + queryString({ orgId }), key, "/alpha/billing/credits");
		let subscription;
		try {
			subscription = await fetchJson(API_BASE + "/alpha/billing/subscriptions" + queryString({ orgId }), key, "/alpha/billing/subscriptions");
		} catch {
			subscription = void 0;
		}
		const summary = await fetchJson(API_BASE + "/alpha/usage/summary" + queryString({ orgId }), key, "/alpha/usage/summary");
		return parseCommandCode(credits, subscription, summary, provider);
	}
};

//#endregion
//#region src/host/balance/deepseek-common.ts
const DEEPSEEK_FULL_BALANCE = {
	CNY: "20",
	USD: "5"
};
function deepseekFullBalance(currency) {
	return DEEPSEEK_FULL_BALANCE[currency];
}
function deepseekPricingTier(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(now);
	const pick$1 = (type) => parts.find((p) => p.type === type)?.value;
	const weekday = pick$1("weekday");
	const hour = Number(pick$1("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}

//#endregion
//#region src/host/balance/providers/deepseek-account.ts
function parseAccountBalance(snapshot, provider) {
	if (!snapshot) throw new Error("dsh-pet: 账号未登录（deepseek-account）");
	if (snapshot.status !== "ready") throw new Error("dsh-pet: 账号余额查询失败");
	const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
	if (wallets.length === 0) throw new Error("dsh-pet: 账号没有充值钱包余额");
	const candidates = wallets.map((w) => obj(w)).filter((w) => w !== void 0);
	if (candidates.length === 0) throw new Error("dsh-pet: 账号钱包结构非法");
	const toppedUpBy = new Map();
	for (const w of candidates) {
		const currency = typeof w.currency === "string" && w.currency.length > 0 ? w.currency : "CNY";
		const amount = money(w.balance, "balance");
		const prev = toppedUpBy.get(currency);
		toppedUpBy.set(currency, prev === void 0 ? amount : sumMoney(prev, amount));
	}
	const grantedBy = new Map();
	for (const raw of Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []) {
		const w = obj(raw);
		if (!w || typeof w.currency !== "string" || w.currency.length === 0) continue;
		const amount = money(w.balance, "bonus balance");
		const prev = grantedBy.get(w.currency);
		grantedBy.set(w.currency, prev === void 0 ? amount : sumMoney(prev, amount));
	}
	for (const currency of grantedBy.keys()) if (!toppedUpBy.has(currency)) toppedUpBy.set(currency, "0.00");
	const walletsOut = [...toppedUpBy.entries()].map(([currency, toppedUp]) => {
		const granted = grantedBy.get(currency) ?? "0.00";
		const fullBalance = deepseekFullBalance(currency);
		return {
			currency,
			total: sumMoney(granted, toppedUp),
			granted,
			toppedUp,
			...fullBalance === void 0 ? {} : { fullBalance }
		};
	});
	return {
		ok: true,
		provider,
		shape: "money",
		data: {
			wallets: walletsOut,
			tier: deepseekPricingTier()
		}
	};
}
const deepseekAccount = {
	id: "deepseek-account",
	credential: { mode: "none" },
	async fetch({ provider, resolveAccount }) {
		if (!resolveAccount) throw new Error("dsh-pet: 缺少账号服务（" + provider + "）");
		return parseAccountBalance(await resolveAccount(), provider);
	}
};

//#endregion
//#region src/host/balance/providers/deepseek-official.ts
const deepseekOfficial = {
	id: "deepseek-official",
	credential: {
		mode: "ref",
		ref: "DEEPSEEK_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
		if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
		const body = await res.json();
		const infos = body?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) throw new Error("dsh-pet: deepseek balance 响应缺少 balance_infos");
		const wallets = infos.map((raw) => {
			const w = obj(raw) ?? {};
			const currency = str$1(w.currency, "currency");
			const fullBalance = deepseekFullBalance(currency);
			return {
				currency,
				total: str$1(w.total_balance, "total_balance"),
				granted: str$1(w.granted_balance, "granted_balance"),
				toppedUp: str$1(w.topped_up_balance, "topped_up_balance"),
				...fullBalance === void 0 ? {} : { fullBalance }
			};
		});
		return {
			ok: true,
			provider,
			shape: "money",
			data: {
				wallets,
				tier: deepseekPricingTier()
			}
		};
	}
};

//#endregion
//#region src/host/balance/providers/opencode-go.ts
/** 各窗口满额度（USD）：滚动 12、周 30、月 60；接口不回传，属业务常量。 */
const QUOTA_USD = {
	rolling: 12,
	weekly: 30,
	monthly: 60
};
/** 滚动窗的展示名：本服务商是 5 小时。 */
const ROLLING_LABEL = "5h";
const opencodeGo = {
	id: "opencode-go",
	credential: {
		mode: "ref",
		ref: "OPENCODE_GO_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
		if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
		const body = await res.json();
		const usage = body?.usage;
		if (!usage || typeof usage !== "object") throw new Error("dsh-pet: opencode usage 响应缺少 usage");
		const u = usage;
		const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
		if (!rolling || !weekly || !monthly) throw new Error("dsh-pet: opencode usage 响应缺少窗口");
		return {
			ok: true,
			provider,
			shape: "windows",
			data: {
				rolling: num(rolling.percent, "rolling.percent"),
				weekly: num(weekly.percent, "weekly.percent"),
				monthly: num(monthly.percent, "monthly.percent"),
				rollingCapUsd: QUOTA_USD.rolling,
				weeklyCapUsd: QUOTA_USD.weekly,
				monthlyCapUsd: QUOTA_USD.monthly,
				rollingLabel: ROLLING_LABEL,
				rollingResetsAt: str$1(rolling.resetsAt, "rolling.resetsAt"),
				weeklyResetsAt: str$1(weekly.resetsAt, "weekly.resetsAt"),
				monthlyResetsAt: str$1(monthly.resetsAt, "monthly.resetsAt")
			}
		};
	}
};

//#endregion
//#region src/host/balance/registry.ts
const BUILTIN_PROVIDERS = [
	opencodeGo,
	commandCode,
	deepseekOfficial,
	deepseekAccount
];
/** 第三方运行时登记表：provider id → 定义。 */
const external = new Map();
function registerBalanceProvider(def) {
	if (!def || typeof def !== "object") throw new TypeError("provider 定义必须是对象");
	if (typeof def.id !== "string" || def.id.length === 0) throw new TypeError("id 必须是非空字符串");
	if (typeof def.fetch !== "function") throw new TypeError("fetch 必须是函数");
	if (BUILTIN_PROVIDERS.some((p) => p.id === def.id)) throw new Error("不能覆盖内置服务商: " + def.id);
	if (external.has(def.id)) throw new Error("该服务商 id 已被注册: " + def.id);
	external.set(def.id, def);
	return () => {
		if (external.get(def.id) === def) external.delete(def.id);
	};
}
function listBalanceProviders() {
	return {
		builtin: BUILTIN_PROVIDERS.map((p) => p.id),
		external: [...external.keys()]
	};
}
function matchBalanceProvider(provider) {
	return BUILTIN_PROVIDERS.find((p) => p.id === provider) ?? external.get(provider);
}

//#endregion
//#region src/host/balance/index.ts
/** 第三方取数等待上限（ms）；内置 HTTP 服务商走各自的超时与重试。 */
const PLUGIN_FETCH_TIMEOUT_MS = 2e4;
/**
* 构造失败结果：三种 reason 走同一个出口，避免各处手写字段。
* `message` 缺省时不写这个键——叶子形状是对外契约，多一个 undefined 键会破坏严格比对。
*/
function failed(provider, reason, message) {
	return message === void 0 ? {
		ok: false,
		provider,
		reason
	} : {
		ok: false,
		provider,
		reason,
		message
	};
}
/** 把取数异常归一成 fetch-error（内置与第三方同一口径）。 */
function fetchFailed(provider, e) {
	return failed(provider, "fetch-error", e instanceof Error ? e.message : String(e));
}
async function queryBalance(provider, resolveKey, resolveAccount) {
	const def = matchBalanceProvider(provider);
	if (!def) return failed(provider, "unsupported");
	if (!("credential" in def)) {
		let timer;
		try {
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("余额查询超时（20 秒），请稍后重试")), PLUGIN_FETCH_TIMEOUT_MS);
				timer.unref();
			});
			return await Promise.race([def.fetch({ provider }), timeout]);
		} catch (e) {
			return fetchFailed(provider, e);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	}
	let key = "";
	if (def.credential.mode === "ref") {
		const resolved = await resolveKey(def.credential.ref);
		if (!resolved) return failed(provider, "credential-missing", "缺少凭证 " + def.credential.ref);
		key = resolved;
	} else if (!resolveAccount) return failed(provider, "credential-missing", "缺少账号服务（" + provider + "）");
	try {
		return await def.fetch({
			provider,
			key,
			resolveAccount
		});
	} catch (e) {
		return fetchFailed(provider, e);
	}
}

//#endregion
//#region src/host/voice/registry.ts
const BUILTIN_VOICE_ID = "edge";
/** 当前生效的第三方实现；`null` = 没注册，合成走内置实现。 */
let current$1 = null;
function registerVoiceProvider(def) {
	if (!def || typeof def !== "object") throw new TypeError("voice provider 定义必须是对象");
	if (typeof def.id !== "string" || def.id.length === 0) throw new TypeError("id 必须是非空字符串");
	if (def.id === BUILTIN_VOICE_ID) throw new TypeError("不能与内置实现同名: " + BUILTIN_VOICE_ID);
	if (typeof def.synthesize !== "function") throw new TypeError("synthesize 必须是函数");
	current$1 = def;
	return () => {
		if (current$1 === def) current$1 = null;
	};
}
function activeVoiceProvider() {
	return current$1;
}
function listVoiceProviders() {
	return {
		builtin: [BUILTIN_VOICE_ID],
		external: current$1 ? [current$1.id] : []
	};
}

//#endregion
//#region src/host/voice/speech-registry.ts
const BUILTIN_SPEECH_ID = "dsh";
/** 当前生效的第三方实现；`null` = 没注册，识别走宿主自带能力。 */
let current = null;
function registerSpeechProvider(def) {
	if (!def || typeof def !== "object") throw new TypeError("speech provider 定义必须是对象");
	if (typeof def.id !== "string" || def.id.length === 0) throw new TypeError("id 必须是非空字符串");
	if (def.id === BUILTIN_SPEECH_ID) throw new TypeError("不能与内置来源同名: " + BUILTIN_SPEECH_ID);
	if (typeof def.transcribe !== "function") throw new TypeError("transcribe 必须是函数");
	current = def;
	return () => {
		if (current === def) current = null;
	};
}
function activeSpeechProvider() {
	return current;
}
function listSpeechProviders() {
	return {
		builtin: [BUILTIN_SPEECH_ID],
		external: current ? [current.id] : []
	};
}

//#endregion
//#region src/shared/fonts.ts
const FONT_PRESETS = [
	{
		id: "candy",
		stack: "\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif"
	},
	{
		id: "yahei",
		stack: "\"Microsoft YaHei\",\"PingFang SC\",sans-serif"
	},
	{
		id: "youyuan",
		stack: "\"YouYuan\",\"Yuanti SC\",sans-serif"
	},
	{
		id: "kaiti",
		stack: "\"KaiTi\",\"STKaiti\",serif"
	},
	{
		id: "simsun",
		stack: "\"SimSun\",\"Songti SC\",serif"
	},
	{
		id: "comic",
		stack: "\"Comic Sans MS\",\"Comic Sans\",cursive"
	},
	{
		id: "system",
		stack: "system-ui,sans-serif"
	}
];
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 200;
const FONT_REF_SIZE = 462;
const BUBBLE_FONT_BASE_PX = .0455 * FONT_REF_SIZE;
const TIP_FONT_BASE_PX = .026 * FONT_REF_SIZE;

//#endregion
//#region src/shared/config.ts
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];

//#endregion
//#region src/host/log-file.ts
function isFileLogger(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return candidate.isFileLogger === true && typeof candidate.flush === "function" && typeof candidate.file === "string";
}
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 512 * 1024;
const LOG_FLUSH_MS = 1e3;
const LOG_FLUSH_LINES = 64;
const LOG_MAX_PENDING = 1e3;
function redactSensitive(text) {
	return text.replace(/(x-dsh-pet-token["'\s:=]+)[A-Za-z0-9_-]{16,}/gi, "$1***").replace(/(token["'\s:=]+)[A-Za-z0-9_-]{32,}/gi, "$1***").replace(/(#token=)[A-Za-z0-9_-]{16,}/g, "$1***").replace(/(DSH_PET_SITE_URL=)\S+/g, "$1***");
}
function tailForTrim(content, keepBytes) {
	if (content.length <= keepBytes) return content;
	return content.subarray(content.length - keepBytes);
}
function formatLogLine(level, message, now) {
	return `${now.toISOString()} [${level}] ${message}\n`;
}
function createFileLogger(options) {
	const file = options.file;
	const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
	const keepBytes = Math.max(0, Math.min(options.keepBytes ?? LOG_KEEP_BYTES, maxBytes));
	const flushMs = options.flushIntervalMs ?? LOG_FLUSH_MS;
	const threshold = Math.max(1, options.flushThreshold ?? LOG_FLUSH_LINES);
	const maxPending = Math.max(threshold, options.maxPending ?? LOG_MAX_PENDING);
	const debugEnabled = options.debugEnabled ?? false;
	const now = options.now ?? (() => new Date());
	let pending = [];
	let dropped$1 = 0;
	/** 已离开 pending、尚未提交到文件的文本；退出与 dispose 靠它补写。 */
	let activeChunk = "";
	let flushing = null;
	let disposed = false;
	/** 目录只建一次（首次 flush 时）；失败后不再重试，日志静默降级 */
	let dirReady = null;
	const ensureDir = () => dirReady ??= mkdir(dirname(file), { recursive: true }).then(() => void 0).catch(() => void 0);
	/** 取走当前缓冲（含溢出提示）；取出后 pending 为空，文本改由调用方保管。 */
	const takePending = () => {
		const note = dropped$1 > 0 ? formatLogLine("warn", `日志缓冲溢出，丢弃 ${dropped$1} 条`, now()) : "";
		const chunk = note + pending.join("");
		pending = [];
		dropped$1 = 0;
		return chunk;
	};
	/** 同步提交 activeChunk；提交后这批文本与内存无关，退出路径不会重复写。 */
	const commit = () => {
		const chunk = activeChunk;
		activeChunk = "";
		if (!chunk) return;
		try {
			appendFileSync(file, chunk, "utf8");
		} catch {}
	};
	/** 退出与 dispose 共用的补写；首次运行目录可能还不存在，所以先同步建目录。 */
	const flushSync = () => {
		activeChunk += takePending();
		if (!activeChunk) return;
		try {
			mkdirSync(dirname(file), { recursive: true });
		} catch {}
		commit();
	};
	const push = (level, message) => {
		if (level === "debug" && !debugEnabled) return;
		try {
			options.base?.[level]?.(message);
		} catch {}
		pending.push(formatLogLine(level, redactSensitive(String(message)), now()));
		if (pending.length > maxPending) {
			dropped$1 += pending.length - maxPending;
			pending.splice(0, pending.length - maxPending);
		}
		if (disposed) flushSync();
		else if (pending.length >= threshold) flush();
	};
	const flush = async () => {
		for (;;) {
			if (flushing) {
				await flushing;
				continue;
			}
			if (pending.length === 0) return;
			activeChunk = takePending();
			flushing = (async () => {
				await ensureDir();
				commit();
				try {
					const info = await stat(file);
					if (info.size > maxBytes) {
						const content = await readFile(file);
						if (!disposed) await writeFile(file, tailForTrim(content, keepBytes));
					}
				} catch {}
			})().finally(() => {
				flushing = null;
			});
			await flushing;
		}
	};
	const timer = setInterval(() => {
		flush();
	}, flushMs);
	timer.unref?.();
	const onExit = () => flushSync();
	process.once("exit", onExit);
	return {
		file,
		isFileLogger: true,
		info: (message) => push("info", message),
		warn: (message) => push("warn", message),
		error: (message) => push("error", message),
		debug: (message) => push("debug", message),
		flush,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			process.removeListener("exit", onExit);
			flushSync();
		}
	};
}
/**
* 模块级默认出口——给拿不到 `ctx.logger` 的纯模块用（./config、./chat、./whisper）。
*
* 这些模块是纯函数，签名里不该为一条告警塞一个 logger，但它们的 warn 同样是桌面版用户唯一能
* 看到的线索。宿主在 apply 开始时 `setDefaultLogger(log)`，之后直接 `defaultLog('warn', ...)`；
* 单测或极早期没有 logger 时退回 console，行为不变。
*/
let defaultLogger = null;
function setDefaultLogger(logger) {
	defaultLogger = logger;
}
function defaultLog(level, message) {
	const sink = defaultLogger?.[level];
	if (sink) {
		sink.call(defaultLogger, message);
		return;
	}
	if (level === "debug") {
		if (process.env.DSH_PET_LOG_DEBUG === "1") console.debug(message);
		return;
	}
	if (level === "info") console.info(message);
	else if (level === "warn") console.warn(message);
	else console.error(message);
}

//#endregion
//#region src/host/config/constants.ts
/** 位置角落白名单 */
const CORNERS$1 = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
const CORNER_SET = new Set(CORNERS$1);
const PET_DISPLAY_SET = new Set(PET_DISPLAYS);
const FONT_FAMILY_SET = new Set(FONT_PRESETS.map((preset) => preset.id));
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
const MAX_PET_ID_LENGTH = 64;
function isValidPetId(value) {
	if (value === "." || value === "..") return false;
	return value !== "" && value.length <= MAX_PET_ID_LENGTH && !ID_FORBIDDEN.test(value);
}
const GLOBAL_DEFAULT_KEYS = [
	"physics",
	"font",
	"confineToScreen",
	"voiceEnabled",
	"voiceName",
	"voiceVolume",
	"voiceWhisperEnabled",
	"voiceTodoEnabled",
	"voiceEngine",
	"breezeApiKey",
	"breezeVoice",
	"breezeSpeed",
	"whisperImageEnabled",
	"chatImageEnabled",
	"chatAnimationEnabled",
	"chatImageLimit",
	"chatMemoryRounds",
	"whisperModel",
	"chatModel",
	"eventsRefreshSec",
	"menuOrder",
	"menuHidden"
];
/** 已告警过的 文件:字段（进程内去重：同一问题只告警一次，避免每请求刷屏；重启重置） */
const warnedKeys = new Set();
function warnOnce(key, message) {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	defaultLog("warn", "dsh-pet: " + message);
}

//#endregion
//#region src/host/config/jsonc.ts
/** 仅删除字符串之外的 JSONC 注释，保留字符串转义、换行与相邻 JSON token 的分隔。 */
function stripJsonc(src) {
	let out = "";
	let inString = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inString) {
			out += ch;
			if (ch === "\\" && i + 1 < src.length) out += src[++i];
			else if (ch === "\"") inString = false;
		} else if (ch === "\"") {
			inString = true;
			out += ch;
		} else if (ch === "/" && src[i + 1] === "/") {
			out += " ";
			while (i + 1 < src.length && src[i + 1] !== "\r" && src[i + 1] !== "\n") i++;
		} else if (ch === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end === -1) throw new SyntaxError("Unterminated JSONC block comment");
			out += src.slice(i, end + 2).replace(/[^\r\n]/g, " ");
			i = end + 1;
		} else out += ch;
	}
	return out.trim();
}
function readJsonc(path) {
	try {
		const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
		return raw && typeof raw === "object" ? raw : void 0;
	} catch {
		return void 0;
	}
}
function readUserConfig(paths) {
	const file = effectiveUserFile(paths);
	return file ? readJsonc(file) : void 0;
}
function userConfigUnparsable(paths) {
	const file = effectiveUserFile(paths);
	return file !== void 0 && readJsonc(file) === void 0;
}
function effectiveUserFile(paths) {
	if (existsSync(paths.userFile)) return paths.userFile;
	if (paths.legacyUserFile && existsSync(paths.legacyUserFile)) return paths.legacyUserFile;
	return void 0;
}

//#endregion
//#region src/shared/constants.ts
const HIT_BOX = {
	x0: 200,
	y0: 50,
	x1: 440,
	y1: 335
};
const ROUTE_SEGMENT = "/dsh-pet-7340";
function mountPrefixOf(baseURI) {
	if (baseURI === void 0 || baseURI === "") return "";
	try {
		const url = new URL(baseURI);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		return url.pathname.replace(/\/+$/, "");
	} catch {
		return "";
	}
}
function routePathOf(baseURI) {
	return mountPrefixOf(baseURI) + ROUTE_SEGMENT;
}
const ROUTE_PATH = routePathOf(typeof document === "undefined" ? void 0 : document.baseURI);

//#endregion
//#region src/shared/pet-size.ts
/** 人物本体宽度占画框宽度的比例；由命中框反推（240/640），不在别处再写一份 0.375。 */
const BODY_WIDTH_RATIO = (HIT_BOX.x1 - HIT_BOX.x0) / 640;
const SIZE_PERCENT_MIN = 1;
const SIZE_PERCENT_DEFAULT = 20;
function isValidSizePercent(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= SIZE_PERCENT_MIN;
}

//#endregion
//#region src/host/voice/voices.ts
const VOICES = [
	{
		id: "zh-CN-XiaoxiaoNeural",
		name: "晓晓",
		tag: "女 · 通用",
		default: false
	},
	{
		id: "zh-CN-XiaoyiNeural",
		name: "晓伊",
		tag: "女 · 活泼",
		default: true
	},
	{
		id: "zh-CN-YunxiNeural",
		name: "云希",
		tag: "男 · 年轻",
		default: false
	},
	{
		id: "zh-CN-YunjianNeural",
		name: "云健",
		tag: "男 · 沉稳",
		default: false
	}
];
const DEFAULT_VOICE = "zh-CN-XiaoyiNeural";
function isKnownVoice(id) {
	return VOICES.some((voice) => voice.id === id);
}

//#endregion
//#region src/host/config/validate.ts
function animationsValid(a) {
	if (!a || typeof a !== "object") return false;
	const anims = a;
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) if (!Array.isArray(anims[key])) return false;
	const moves = anims.moves;
	if (!moves || typeof moves !== "object" || typeof moves.default !== "object" || moves.default === null || !Array.isArray(moves.actions)) return false;
	if (!Array.isArray(anims.categories)) return false;
	const ev = anims.events;
	if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
	const evEntries = ev;
	for (const pool$1 of Object.values(evEntries)) {
		if (!Array.isArray(pool$1) || pool$1.length === 0) return false;
		for (const slot of pool$1) if (typeof slot === "string") {
			if (slot.length === 0) return false;
		} else if (Array.isArray(slot)) {
			if (slot.length === 0) return false;
			for (const name$1 of slot) if (typeof name$1 !== "string" || name$1.length === 0) return false;
		} else return false;
	}
	const balance = evEntries.balance;
	if (!Array.isArray(balance) || balance.length === 0) return false;
	return anims.sleep === void 0 || sleepValid(anims.sleep);
}
/** sleep 段校验：非空套数组，每套都必须有非空的 start / loop / end 字符串数组。
*  未写由调用方放行（可选字段）；这里只处理「写了」的形态。 */
function sleepValid(value) {
	if (!Array.isArray(value) || value.length === 0) return false;
	for (const set of value) {
		if (!set || typeof set !== "object" || Array.isArray(set)) return false;
		const entry = set;
		for (const phase of [
			"start",
			"loop",
			"end"
		]) {
			const pool$1 = entry[phase];
			if (!Array.isArray(pool$1) || pool$1.length === 0) return false;
			for (const name$1 of pool$1) if (typeof name$1 !== "string" || name$1.length === 0) return false;
		}
	}
	return true;
}
/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w) {
	if (!w || typeof w !== "object") return false;
	const weights = w;
	for (const key of [
		"idle",
		"turn",
		"move"
	]) {
		const v = Number(weights[key]);
		if (!Number.isFinite(v) || v < 0) return false;
	}
	return true;
}
function physicsValid(value) {
	if (!value || typeof value !== "object") return false;
	const p = value;
	const g = Number(p.gravity);
	const r = Number(p.restitution);
	const f = Number(p.groundFriction);
	const tp = Number(p.throwPower);
	return Number.isFinite(g) && g >= 0 && Number.isFinite(r) && r >= 0 && r <= 1 && Number.isFinite(f) && f >= 0 && typeof p.ceilingBounce === "boolean" && Number.isFinite(tp) && tp > 0 && typeof p.petCollision === "boolean" && (p.hapticEnabled === void 0 || typeof p.hapticEnabled === "boolean") && (p.tiltGravity === void 0 || typeof p.tiltGravity === "boolean") && (p.shakeThrow === void 0 || typeof p.shakeThrow === "boolean");
}
function fontValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const f = value;
	if (typeof f.family !== "string" || !FONT_FAMILY_SET.has(f.family)) return false;
	const size = Number(f.size);
	if (!Number.isFinite(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) return false;
	return typeof f.followPet === "boolean";
}
function modelSelectionValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const m = value;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return false;
	return m.provider.trim() === "" === (m.model.trim() === "");
}
/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value) {
	if (!Array.isArray(value) || value.length === 0) return false;
	for (const group of value) {
		if (!Array.isArray(group) || group.length === 0) return false;
		for (const text of group) if (typeof text !== "string" || text.length === 0) return false;
	}
	return true;
}
function topFieldValid(key, value) {
	switch (key) {
		case "whisperPrompt": return typeof value === "string" && value.length > 0;
		case "chatMemoryRounds": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "chatImageLimit": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "notificationsEnabled": return typeof value === "boolean";
		case "clickSoundEnabled": return typeof value === "boolean";
		case "whisperImageEnabled": return typeof value === "boolean";
		case "voiceEnabled": return typeof value === "boolean";
		case "voiceName": return typeof value === "string" && isKnownVoice(value);
		case "voiceVolume": return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
		case "voiceWhisperEnabled": return typeof value === "boolean";
		case "voiceTodoEnabled": return typeof value === "boolean";
		case "voiceEngine": return value === "edge" || value === "breeze";
		case "breezeApiKey": return typeof value === "string" && value.length <= 200 && !/[\r\n\t]/.test(value);
		case "breezeVoice": return typeof value === "string" && value.length <= 100 && !/[\r\n\t]/.test(value);
		case "breezeSpeed": return typeof value === "number" && Number.isFinite(value) && value >= .5 && value <= 2;
		case "chatImageEnabled": return typeof value === "boolean";
		case "chatAnimationEnabled": return typeof value === "boolean";
		case "confineToScreen": return typeof value === "boolean";
		case "trayEnabled": return typeof value === "boolean";
		case "requestBubbleEnabled": return typeof value === "boolean";
		case "scheduleRemindersEnabled": return typeof value === "boolean";
		case "menuOrder":
		case "menuHidden": return Array.isArray(value) && value.every((item) => typeof item === "string");
		case "animations": return animationsValid(value);
		case "animationWeights": return weightsValid(value);
		case "eventsRefreshSec": return eventsRefreshSecValid(value);
		case "physics": return physicsValid(value);
		case "font": return fontValid(value);
		case "whisperModel":
		case "chatModel": return modelSelectionValid(value);
		case "workStatusTexts": return workStatusTextsValid(value);
		case "sleepRefuseTexts":
		case "sleepStartTexts":
		case "sleepEndTexts":
		case "patShyTexts":
		case "patAnnoyedTexts":
		case "patAngryTexts":
		case "patBusyTexts":
		case "patBackTexts": {
			if (!Array.isArray(value) || value.length === 0) return false;
			return value.every((text) => typeof text === "string" && text.length > 0);
		}
		default: return true;
	}
}
/**
* eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
* 这是整段替换字段：缺的键由消费端各自兜底（1800 / 300），多写的键原样保留；空对象合法。
*/
function eventsRefreshSecValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const v of Object.values(value)) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return false;
	}
	return true;
}

//#endregion
//#region src/host/config/merge.ts
function packBase(base, mainOverlay) {
	if (!mainOverlay) return base;
	let out;
	for (const key of GLOBAL_DEFAULT_KEYS) {
		const own$1 = mainOverlay[key];
		if (own$1 === void 0 || !topFieldValid(key, own$1)) continue;
		out ??= { ...base };
		out[key] = own$1;
	}
	return out ?? base;
}
function mergeEntry(base, overlay, label, basePets, seenIds) {
	const out = {};
	for (const key of Object.keys(base)) {
		if (key === "pets") {
			out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
			continue;
		}
		if (key === "animations") {
			out.animations = mergeAnimations(base[key], overlay?.[key], label);
			continue;
		}
		const own$1 = overlay ? overlay[key] : void 0;
		if (own$1 === void 0) {
			out[key] = base[key];
			continue;
		}
		if (!topFieldValid(key, own$1)) {
			warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
			out[key] = base[key];
			continue;
		}
		out[key] = own$1;
	}
	return out;
}
/** 动画名（非空字符串）判定：animations 局部合并用 */
function isAnimName(v) {
	return typeof v === "string" && v.length > 0;
}
/** 动作名数组：非空、每项都是非空字符串 */
function isAnimList(v) {
	return Array.isArray(v) && v.every(isAnimName);
}
/** 取一个分类条目：`id` 来自 categories，`category` 来自 extra（两种写法都收） */
function toCategory(raw, idField) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const item = raw;
	const id = item[idField];
	if (!isAnimName(id)) return void 0;
	const weight = Number(item.weight);
	const hasWeight = item.weight !== void 0 && Number.isFinite(weight) && weight >= 0;
	return {
		id,
		actions: isAnimList(item.actions) ? [...item.actions] : [],
		...hasWeight ? { weight } : {}
	};
}
/**
* categories 合并：默认分类打底 → 用户 categories 按 id 追加动作 / 改权重 → extra 再叠一次。
* - 已存在的分类：动作去重追加；只在用户写了 weight 时才改权重
* - 新分类：追加到末尾，权重缺省 0（只进右键菜单点播，不参与随机自播）
*/
function mergeCategories(base, own$1, extra) {
	const out = [];
	const byId = new Map();
	const put = (spec) => {
		const id = spec.id;
		const hit = byId.get(id);
		if (hit) {
			const list = hit.actions;
			for (const name$1 of spec.actions) if (!list.includes(name$1)) list.push(name$1);
			if (spec.weight !== void 0) hit.weight = spec.weight;
			return;
		}
		const cat = {
			id,
			weight: spec.weight ?? 0,
			actions: spec.actions
		};
		byId.set(id, cat);
		out.push(cat);
	};
	for (const raw of Array.isArray(base) ? base : []) {
		const spec = toCategory(raw, "id");
		if (spec) put(spec);
	}
	for (const raw of Array.isArray(own$1) ? own$1 : []) {
		const spec = toCategory(raw, "id");
		if (spec) put(spec);
	}
	for (const raw of Array.isArray(extra) ? extra : []) {
		const spec = toCategory(raw, "category");
		if (spec) put(spec);
	}
	return out;
}
function mergeAnimations(base, own$1, label) {
	if (!base || typeof base !== "object" || Array.isArray(base)) return base;
	if (own$1 === void 0) return base;
	if (!own$1 || typeof own$1 !== "object" || Array.isArray(own$1)) {
		warnOnce(`${label}:animations`, `「${label}」的 animations 不是对象，已取默认值`);
		return base;
	}
	const b = base;
	const o = own$1;
	const out = { ...b };
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) {
		const pool$1 = o[key];
		if (isAnimList(pool$1) && pool$1.length > 0) out[key] = [...pool$1];
	}
	const baseMoves = b.moves && typeof b.moves === "object" && !Array.isArray(b.moves) ? b.moves : {};
	const ownMoves = o.moves && typeof o.moves === "object" && !Array.isArray(o.moves) ? o.moves : {};
	const baseDefault = baseMoves.default && typeof baseMoves.default === "object" && !Array.isArray(baseMoves.default) ? baseMoves.default : {};
	const ownDefault = ownMoves.default && typeof ownMoves.default === "object" && !Array.isArray(ownMoves.default) ? ownMoves.default : {};
	const actions = Array.isArray(ownMoves.actions) ? ownMoves.actions : baseMoves.actions;
	out.moves = {
		...baseMoves,
		...ownMoves,
		default: {
			...baseDefault,
			...ownDefault
		},
		actions: Array.isArray(actions) ? actions : []
	};
	out.categories = mergeCategories(b.categories, o.categories, o.extra);
	const baseEvents = b.events && typeof b.events === "object" && !Array.isArray(b.events) ? b.events : {};
	const ownEvents = o.events && typeof o.events === "object" && !Array.isArray(o.events) ? o.events : {};
	out.events = {
		...baseEvents,
		...ownEvents
	};
	if (o.sleep !== void 0) out.sleep = o.sleep;
	if (!animationsValid(out)) {
		warnOnce(`${label}:animations`, `「${label}」的 animations 合并后不合法（idle/turn/drag/clicks/moves/categories/events 或 balance 缺失），已取默认值`);
		return base;
	}
	return out;
}
/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(basePets, raw, label, seenIds) {
	const basePet = basePets[0] ?? {};
	if (!Array.isArray(raw) || raw.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
		return basePets;
	}
	const out = [];
	for (const item of raw) {
		const pet = mergePet(basePet, item, label, seenIds);
		if (pet) out.push(pet);
	}
	if (out.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
		return basePets;
	}
	return out;
}
/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own$1, def, min, label, field, id) {
	const n = Number(own$1);
	if (own$1 !== void 0 && own$1 !== null && Number.isFinite(n) && n >= min) return n;
	if (own$1 !== void 0 && own$1 !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Number(def);
}
/** 实例级 sizePercent：写了合法值才落键；缺省与越界都不落键，渲染侧按默认值处理。
*  不补默认值——补了会让「没动过」在保存时变成显式值，配置文件凭空长大，且没有用户层时形状不一致。 */
function petSizePercentField(own$1, def, label, id) {
	const value = own$1 ?? def;
	if (value === void 0 || value === null) return {};
	if (isValidSizePercent(value)) return { sizePercent: value };
	warnOnce(`${label}:sizePercent:${id}`, `宠物「${id}」的 sizePercent 非法（应为不小于 ${SIZE_PERCENT_MIN} 的数字），已忽略（按默认 ${SIZE_PERCENT_DEFAULT} 处理）`);
	return {};
}
/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own$1, def, label, field, id) {
	if (typeof own$1 === "boolean") return own$1;
	if (own$1 !== void 0 && own$1 !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Boolean(def);
}
/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(own$1, set, def, label, field, id) {
	if (typeof own$1 === "string" && set.has(own$1)) return own$1;
	if (own$1 !== void 0 && own$1 !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return typeof def === "string" ? def : "";
}
/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(base, raw, label, seenIds) {
	const p = raw && typeof raw === "object" ? raw : {};
	const id = typeof p.id === "string" ? p.id.trim() : "";
	if (!isValidPetId(id) || seenIds.has(id)) {
		warnOnce(`${label}:id:${id || "(空)"}`, `「${label}」的宠物 id「${id || "(空)"}」非法、重复或已存在，已跳过该实例`);
		return null;
	}
	seenIds.add(id);
	const rawName = typeof p.name === "string" ? p.name.trim() : "";
	const name$1 = rawName || id;
	if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);
	const basePos = base.position && typeof base.position === "object" ? base.position : {};
	const ownPos = p.position && typeof p.position === "object" ? p.position : {};
	return {
		id,
		name: name$1,
		size: petNumber(p.size, base.size, 1, label, "size", id),
		...petSizePercentField(p.sizePercent, base.sizePercent, label, id),
		balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, "balanceEnabled", id),
		whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, "whisperEnabled", id),
		workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, "workStatusEnabled", id),
		fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, "fixedEnabled", id),
		display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, "display", id),
		position: {
			corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, "position.corner", id),
			marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, "position.marginX", id),
			marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, "position.marginY", id)
		},
		...petPersonaField(p.whisperPrompt, label, id)
	};
}
/**
* 实例级 whisperPrompt 的合并：写了非空字符串 → 原样带出；否则返回空对象（该键不出现）。
* 显式写了非字符串（数字/对象/布尔）才算配置错误 → 告警一次并忽略（回落条目），与 petNumber 同口径。
*/
function petPersonaField(own$1, label, id) {
	if (typeof own$1 === "string") return own$1.trim() === "" ? {} : { whisperPrompt: own$1 };
	if (own$1 !== void 0 && own$1 !== null) warnOnce(`${label}:whisperPrompt:${id}`, `宠物「${id}」的 whisperPrompt 非法，已忽略（回落所属条目人设）`);
	return {};
}

//#endregion
//#region src/host/config/read.ts
function migrateUserConfig(paths, log) {
	const legacy = paths.legacyUserFile;
	if (!legacy || !existsSync(legacy) || existsSync(paths.userFile)) return false;
	try {
		renameSync(legacy, paths.userFile);
	} catch {
		return false;
	}
	log?.(`用户配置已迁移到 JSONC：${legacy} → ${paths.userFile}`);
	return true;
}
/** 扫描 pet/ 目录：<名>-config.(json|jsonc) → 条目（按文件名排序） */
function scanPetFiles(petDir) {
	let entries;
	try {
		entries = readdirSync(petDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name$1) => /^.+?-config\.(json|jsonc)$/.test(name$1)).sort().map((name$1) => ({
		prefix: name$1.replace(/-config\.(json|jsonc)$/, ""),
		path: join(petDir, name$1)
	}));
}
function readPetConfigEntry(paths, entry) {
	const hit = scanPetFiles(paths.petDir).find((f) => f.prefix === entry);
	return hit ? {
		path: hit.path,
		raw: readJsonc(hit.path)
	} : void 0;
}
function readAllConfig(paths) {
	const base = readJsonc(paths.defaultFile);
	if (!base) throw new Error("dsh-pet: 内置默认配置缺失或解析失败（安装损坏）：" + paths.defaultFile);
	const basePets = Array.isArray(base.pets) ? base.pets : [];
	const seenIds = new Set();
	const out = {};
	const userFile = effectiveUserFile(paths);
	const mainOverlay = userFile ? readJsonc(userFile) : void 0;
	if (userFile && !mainOverlay) warnOnce("file:" + userFile, "用户主配置解析失败，已按无用户配置处理：" + userFile);
	out.main = mergeEntry(base, mainOverlay, "main-config.jsonc", basePets, seenIds);
	const filePetBase = packBase(base, mainOverlay);
	for (const file of scanPetFiles(paths.petDir)) {
		const parsed = readJsonc(file.path);
		if (!parsed) {
			warnOnce("file:" + file.path, "文件宠物配置解析失败，已跳过：" + file.path);
			continue;
		}
		out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + "-config.json", basePets, seenIds);
	}
	return out;
}
function flattenPetList(merged) {
	const out = [];
	for (const conf of Object.values(merged)) if (Array.isArray(conf?.pets)) out.push(...conf.pets);
	return out;
}
function findPetInstance(merged, petId) {
	for (const [entry, conf] of Object.entries(merged)) {
		const pets = Array.isArray(conf?.pets) ? conf.pets : [];
		const found = pets.find((p) => String(p.id) === petId);
		if (found) return {
			entry,
			conf,
			pet: found
		};
	}
	return void 0;
}

//#endregion
//#region src/host/config/save.ts
function saveUserConfig(raw, existing) {
	const o = raw && typeof raw === "object" ? raw : {};
	const arr = Array.isArray(o.pets) ? o.pets : null;
	if (!arr || !arr.length) return null;
	const out = [];
	const seenIds = new Set();
	for (const p of arr) {
		if (!p || typeof p !== "object") return null;
		const pp = p;
		const id = typeof pp.id === "string" ? pp.id.trim() : "";
		if (!isValidPetId(id) || seenIds.has(id)) return null;
		seenIds.add(id);
		const size = Number(pp.size);
		if (!Number.isFinite(size) || size <= 0) return null;
		const sizePercent = pp.sizePercent;
		if (sizePercent !== void 0 && sizePercent !== null && !isValidSizePercent(sizePercent)) return null;
		let name$1 = typeof pp.name === "string" ? pp.name.trim() : "";
		if (!name$1) {
			defaultLog("warn", `dsh-pet: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
			name$1 = id;
		}
		const balanceEnabled = pp.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") return null;
		const whisperEnabled = pp.whisperEnabled;
		if (whisperEnabled !== void 0 && typeof whisperEnabled !== "boolean") return null;
		const workStatusEnabled = pp.workStatusEnabled;
		if (workStatusEnabled !== void 0 && typeof workStatusEnabled !== "boolean") return null;
		const fixedEnabled = pp.fixedEnabled;
		if (fixedEnabled !== void 0 && typeof fixedEnabled !== "boolean") return null;
		const display = String(pp.display ?? "");
		if (!PET_DISPLAY_SET.has(display)) return null;
		const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
		const corner = String(pos.corner ?? "");
		if (!CORNER_SET.has(corner)) return null;
		const marginX = Number(pos.marginX);
		const marginY = Number(pos.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
		const rawPersona = pp.whisperPrompt;
		if (rawPersona !== void 0 && rawPersona !== null && typeof rawPersona !== "string") return null;
		const persona = typeof rawPersona === "string" ? rawPersona.trim() : "";
		const pet = {
			id,
			name: name$1,
			size,
			balanceEnabled,
			whisperEnabled,
			workStatusEnabled,
			fixedEnabled,
			display,
			position: {
				corner,
				marginX,
				marginY
			}
		};
		if (persona) pet.whisperPrompt = persona;
		if (sizePercent !== void 0 && sizePercent !== null) pet.sizePercent = sizePercent;
		out.push(pet);
	}
	const ne = o.notificationsEnabled;
	if (ne !== void 0 && typeof ne !== "boolean") return null;
	const cse = o.clickSoundEnabled;
	if (cse !== void 0 && typeof cse !== "boolean") return null;
	const wie = o.whisperImageEnabled;
	if (wie !== void 0 && typeof wie !== "boolean") return null;
	const cie = o.chatImageEnabled;
	if (cie !== void 0 && typeof cie !== "boolean") return null;
	const cae = o.chatAnimationEnabled;
	if (cae !== void 0 && typeof cae !== "boolean") return null;
	const cts = o.confineToScreen;
	if (cts !== void 0 && typeof cts !== "boolean") return null;
	const ve = o.voiceEnabled;
	if (ve !== void 0 && typeof ve !== "boolean") return null;
	const vn = o.voiceName;
	if (vn !== void 0 && !topFieldValid("voiceName", vn)) return null;
	const vv = o.voiceVolume;
	if (vv !== void 0 && !topFieldValid("voiceVolume", vv)) return null;
	const vwe = o.voiceWhisperEnabled;
	if (vwe !== void 0 && !topFieldValid("voiceWhisperEnabled", vwe)) return null;
	const vte = o.voiceTodoEnabled;
	if (vte !== void 0 && !topFieldValid("voiceTodoEnabled", vte)) return null;
	const veng = o.voiceEngine;
	if (veng !== void 0 && !topFieldValid("voiceEngine", veng)) return null;
	const bak = o.breezeApiKey;
	if (bak !== void 0 && !topFieldValid("breezeApiKey", bak)) return null;
	const bvo = o.breezeVoice;
	if (bvo !== void 0 && !topFieldValid("breezeVoice", bvo)) return null;
	const bsp = o.breezeSpeed;
	if (bsp !== void 0 && !topFieldValid("breezeSpeed", bsp)) return null;
	const te = o.trayEnabled;
	if (te !== void 0 && typeof te !== "boolean") return null;
	const rbe = o.requestBubbleEnabled;
	if (rbe !== void 0 && typeof rbe !== "boolean") return null;
	const sre = o.scheduleRemindersEnabled;
	if (sre !== void 0 && typeof sre !== "boolean") return null;
	const mo = o.menuOrder;
	if (mo !== void 0 && !topFieldValid("menuOrder", mo)) return null;
	const mh = o.menuHidden;
	if (mh !== void 0 && !topFieldValid("menuHidden", mh)) return null;
	const ph = o.physics;
	if (ph !== void 0 && !physicsValid(ph)) return null;
	const fo = o.font;
	if (fo !== void 0 && !fontValid(fo)) return null;
	const wm = o.whisperModel;
	if (wm !== void 0 && !modelSelectionValid(wm)) return null;
	const cm = o.chatModel;
	if (cm !== void 0 && !modelSelectionValid(cm)) return null;
	const cmr = o.chatMemoryRounds;
	if (cmr !== void 0 && !topFieldValid("chatMemoryRounds", cmr)) return null;
	const cil = o.chatImageLimit;
	if (cil !== void 0 && !topFieldValid("chatImageLimit", cil)) return null;
	const cleanModel = (v) => ({
		provider: String(v.provider).trim(),
		model: String(v.model).trim()
	});
	const outConfig = { pets: out };
	if (ne !== void 0) outConfig.notificationsEnabled = ne;
	if (cse !== void 0) outConfig.clickSoundEnabled = cse;
	if (wie !== void 0) outConfig.whisperImageEnabled = wie;
	if (cie !== void 0) outConfig.chatImageEnabled = cie;
	if (cae !== void 0) outConfig.chatAnimationEnabled = cae;
	if (cts !== void 0) outConfig.confineToScreen = cts;
	if (ve !== void 0) outConfig.voiceEnabled = ve;
	if (vn !== void 0) outConfig.voiceName = vn;
	if (vv !== void 0) outConfig.voiceVolume = vv;
	if (vwe !== void 0) outConfig.voiceWhisperEnabled = vwe;
	if (vte !== void 0) outConfig.voiceTodoEnabled = vte;
	if (veng !== void 0) outConfig.voiceEngine = veng;
	if (bak !== void 0) outConfig.breezeApiKey = String(bak).trim();
	if (bvo !== void 0) outConfig.breezeVoice = String(bvo).trim();
	if (bsp !== void 0) outConfig.breezeSpeed = Number(bsp);
	if (te !== void 0) outConfig.trayEnabled = te;
	if (rbe !== void 0) outConfig.requestBubbleEnabled = rbe;
	if (sre !== void 0) outConfig.scheduleRemindersEnabled = sre;
	if (mo !== void 0) outConfig.menuOrder = [...mo];
	if (mh !== void 0) outConfig.menuHidden = [...mh];
	if (ph !== void 0) outConfig.physics = ph;
	if (fo !== void 0) outConfig.font = fo;
	if (wm !== void 0) outConfig.whisperModel = cleanModel(wm);
	if (cm !== void 0) outConfig.chatModel = cleanModel(cm);
	if (cmr !== void 0) outConfig.chatMemoryRounds = Number(cmr);
	if (cil !== void 0) outConfig.chatImageLimit = Number(cil);
	const bodyOwned = new Set(["pets"]);
	if (ne !== void 0) bodyOwned.add("notificationsEnabled");
	if (cse !== void 0) bodyOwned.add("clickSoundEnabled");
	if (wie !== void 0) bodyOwned.add("whisperImageEnabled");
	if (cie !== void 0) bodyOwned.add("chatImageEnabled");
	if (cae !== void 0) bodyOwned.add("chatAnimationEnabled");
	if (cts !== void 0) bodyOwned.add("confineToScreen");
	if (ve !== void 0) bodyOwned.add("voiceEnabled");
	if (vn !== void 0) bodyOwned.add("voiceName");
	if (vv !== void 0) bodyOwned.add("voiceVolume");
	if (vwe !== void 0) bodyOwned.add("voiceWhisperEnabled");
	if (vte !== void 0) bodyOwned.add("voiceTodoEnabled");
	if (veng !== void 0) bodyOwned.add("voiceEngine");
	if (bak !== void 0) bodyOwned.add("breezeApiKey");
	if (bvo !== void 0) bodyOwned.add("breezeVoice");
	if (bsp !== void 0) bodyOwned.add("breezeSpeed");
	if (te !== void 0) bodyOwned.add("trayEnabled");
	if (rbe !== void 0) bodyOwned.add("requestBubbleEnabled");
	if (sre !== void 0) bodyOwned.add("scheduleRemindersEnabled");
	if (mo !== void 0) bodyOwned.add("menuOrder");
	if (mh !== void 0) bodyOwned.add("menuHidden");
	if (ph !== void 0) bodyOwned.add("physics");
	if (fo !== void 0) bodyOwned.add("font");
	if (wm !== void 0) bodyOwned.add("whisperModel");
	if (cm !== void 0) bodyOwned.add("chatModel");
	if (cmr !== void 0) bodyOwned.add("chatMemoryRounds");
	if (cil !== void 0) bodyOwned.add("chatImageLimit");
	if (existing && typeof existing === "object") for (const key of Object.keys(existing)) {
		if (bodyOwned.has(key)) continue;
		outConfig[key] = existing[key];
	}
	return outConfig;
}
function syncUserConfigFromDefault(paths) {
	const raw = readFileSync(paths.defaultFile, "utf8");
	mkdirSync(dirname(paths.userFile), { recursive: true });
	writeFileSync(paths.userFile, raw, "utf8");
}
function sliceMemoryRounds(messages, rounds) {
	return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}
function removeRoundsByTs(messages, ts) {
	const doomed = new Set(ts);
	const messages_ = messages.filter((m) => !doomed.has(m.ts));
	return {
		messages: messages_,
		removed: messages.length - messages_.length
	};
}

//#endregion
//#region src/host/home.ts
const PET_HOME_ENV = "DSH_PET_HOME";
const PET_HOME_POINTER = "home.json";
/** 复制时跳过的条目：日志每拍都在写，指针文件属于默认根。 */
const COPY_SKIP = new Set(["logs.txt", PET_HOME_POINTER]);
/** 插件默认数据根（`resolveDshHome` 允许注入 env，便于测试）。 */
function defaultRoot(env = process.env) {
	return join(resolveDshHome(void 0, env), "dsh-pet");
}
/** 读指针文件；不存在 / 坏 JSON / 相对路径都返回 null（宁可用默认，也不猜）。 */
function readPointer(defaultDir) {
	const file = join(defaultDir, PET_HOME_POINTER);
	try {
		if (!existsSync(file)) return null;
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const dir = raw && typeof raw.dir === "string" ? raw.dir.trim() : "";
		return dir !== "" && isAbsolute(dir) ? resolve(dir) : null;
	} catch {
		return null;
	}
}
function resolvePetHome(env = process.env) {
	const defaultDir = defaultRoot(env);
	const pointerFile = join(defaultDir, PET_HOME_POINTER);
	const envDir = (env[PET_HOME_ENV] ?? "").trim();
	if (envDir !== "" && isAbsolute(envDir)) return {
		dir: resolve(envDir),
		defaultDir,
		pointerFile,
		source: "env",
		envVar: PET_HOME_ENV
	};
	const pointerDir = readPointer(defaultDir);
	if (pointerDir !== null) return {
		dir: pointerDir,
		defaultDir,
		pointerFile,
		source: "pointer",
		envVar: PET_HOME_ENV
	};
	return {
		dir: defaultDir,
		defaultDir,
		pointerFile,
		source: "default",
		envVar: PET_HOME_ENV
	};
}
/** 目录里除指针文件外没有别的东西——默认根在切换后只留指针，算「空」。 */
function isEmptyDataDir(dir) {
	if (!existsSync(dir)) return true;
	try {
		return readdirSync(dir).every((name$1) => name$1 === PET_HOME_POINTER);
	} catch {
		return false;
	}
}
/** 把现有数据复制到新根（仅当新根还没有数据）。 */
function copyIfEmpty(from, to) {
	if (resolve(from) === resolve(to)) return;
	if (!existsSync(from) || !isEmptyDataDir(to)) return;
	mkdirSync(to, { recursive: true });
	cpSync(from, to, {
		recursive: true,
		force: false,
		errorOnExist: false,
		filter: (src) => !COPY_SKIP.has(basename(src))
	});
}
function setPetHome(raw, current$2, env = process.env) {
	const info = resolvePetHome(env);
	if (info.source === "env") throw new Error(`当前数据目录由环境变量 ${PET_HOME_ENV} 指定，先在启动环境里取消它再改`);
	mkdirSync(info.defaultDir, { recursive: true });
	const dir = raw === null ? "" : raw.trim();
	if (dir === "") {
		copyIfEmpty(current$2, info.defaultDir);
		rmSync(info.pointerFile, { force: true });
		return resolvePetHome(env);
	}
	if (!isAbsolute(dir)) throw new Error("数据目录必须是绝对路径，例如 E:\\dsh\\pet");
	const target = resolve(dir);
	mkdirSync(target, { recursive: true });
	copyIfEmpty(current$2, target);
	writeFileSync(info.pointerFile, JSON.stringify({ dir: target }, null, 2) + "\n", "utf8");
	return resolvePetHome(env);
}

//#endregion
//#region src/host/menu.ts
/**
* 第三方右键菜单注册表（进程内存态，DSH 重启即清空，不落盘）。
*
* 注册方用自己的 owner 注册菜单项，再用同一个 owner 查「我这一项被点了没有、在哪只宠物上点的」；
* 不负责菜单渲染与点击命中（两端按 target 过滤后自己拼「更多」）。必须始终成立：注册是 owner 级的
* 整体覆盖，菜单项生命周期与插件一致；点击是闩锁不是队列（连点两次只看到一次）；查询即清空（读取
* 即消费，没确认也没重投）；一个 owner 只该有一个消费者，两个进程同时查会互抢。
* 限额见下方常量；契约见 API.md 与 openapi.yaml。
* @module dsh-pet/src/host/menu
*/
/** owner 长度上限。 */
const OWNER_MAX = 64;
/** 单个菜单项 label 长度上限（面板宽 150–240px，再长会被省略号截断）。 */
const LABEL_MAX = 32;
/** 每 owner 菜单项上限。 */
const ITEMS_MAX = 20;
/** 全局 owner 上限。 */
const OWNERS_MAX = 32;
const MENU_WAIT_MAX_MS = 1e4;
/** 控制字符（换行、制表等会把菜单布局搞炸，一律拒绝）。 */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** 合法的 target 取值。 */
const MENU_TARGETS = new Set([
	"web",
	"desktop",
	"both"
]);
/** 缺省 target = 两端都显示（= 加这个字段之前的行为）。 */
const DEFAULT_TARGET = "both";
/** 校验一个显示用字符串：必须是 string、trim 后非空、不超长、无控制字符。 */
function displayText(value, max) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text === "" || text.length > max || CONTROL_CHARS.test(text)) return null;
	return text;
}
var MenuRegistry = class {
	constructor() {
		this.owners = new Map();
		this.waiters = new Map();
	}
	/**
	* 注册（整体覆盖）：`{ owner, labels: string[], target?: 'web' | 'desktop' | 'both' }`。
	*
	* 覆盖粒度是整个 owner：注册方每次用一份完整列表描述「我现在有什么」，不必关心上次注册了什么，
	* 也不会留下已下线的僵尸项。`target` 选填、缺省 `both`（老调用方零改动），与 labels 一起被覆盖。
	*/
	register(raw) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {
			ok: false,
			reason: "bad-request",
			message: "body 必须是 { owner, labels, target? }"
		};
		const body = raw;
		const owner = displayText(body.owner, OWNER_MAX);
		if (owner === null) return {
			ok: false,
			reason: "invalid-owner",
			message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）`
		};
		const rawLabels = body.labels;
		if (!Array.isArray(rawLabels) || rawLabels.length === 0) return {
			ok: false,
			reason: "invalid-labels",
			message: "labels 必须是非空数组"
		};
		if (rawLabels.length > ITEMS_MAX) return {
			ok: false,
			reason: "too-many-items",
			message: `每个 owner 最多 ${ITEMS_MAX} 项`
		};
		const labels = [];
		for (const rawLabel of rawLabels) {
			const label = displayText(rawLabel, LABEL_MAX);
			if (label === null) return {
				ok: false,
				reason: "invalid-label",
				message: `每个 label 必须是 1–${LABEL_MAX} 字符的字符串（禁控制字符）`
			};
			if (!labels.includes(label)) labels.push(label);
		}
		if (!this.owners.has(owner) && this.owners.size >= OWNERS_MAX) return {
			ok: false,
			reason: "too-many-owners",
			message: `最多 ${OWNERS_MAX} 个 owner`
		};
		const rawTarget = body.target;
		let target = DEFAULT_TARGET;
		if (rawTarget !== void 0 && rawTarget !== null) {
			if (typeof rawTarget !== "string" || !MENU_TARGETS.has(rawTarget)) return {
				ok: false,
				reason: "invalid-target",
				message: "target 只能是 web / desktop / both（不写 = both）"
			};
			target = rawTarget;
		}
		this.owners.set(owner, {
			target,
			items: new Map(labels.map((label) => [label, null]))
		});
		return { ok: true };
	}
	/**
	* 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
	*
	* 幂等：owner 本来就不存在 → `removed: 0`，仍算成功，调用方重试注销时不该看到错误。
	* 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → 路由回 `unknown-owner`。
	*/
	clear(rawOwner) {
		const owner = displayText(rawOwner, OWNER_MAX);
		if (owner === null) return {
			ok: false,
			reason: "invalid-owner",
			message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）`
		};
		const entry = this.owners.get(owner);
		if (!entry) return {
			ok: true,
			removed: 0
		};
		const removed = entry.items.size;
		this.owners.delete(owner);
		const waiters = this.waiters.get(owner);
		this.waiters.delete(owner);
		if (waiters) for (const wake of [...waiters]) wake();
		return {
			ok: true,
			removed
		};
	}
	/** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致）。 */
	snapshot() {
		const out = [];
		for (const [owner, entry] of this.owners) for (const label of entry.items.keys()) out.push({
			owner,
			label,
			target: entry.target
		});
		return out;
	}
	/**
	* 渲染端上报一次点击：把该项标成「被 petId 点了」，并叫醒该 owner 上挂着的长轮询。
	*
	* `delivered = false`（项不存在：菜单刚好被覆盖、还没注册）不算错误——渲染端拿的是上一拍
	* /state 快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
	*/
	click(raw) {
		const body = raw && typeof raw === "object" ? raw : {};
		const owner = typeof body.owner === "string" ? body.owner : "";
		const label = typeof body.label === "string" ? body.label : "";
		const pet = typeof body.pet === "string" ? body.pet.trim() : "";
		const entry = this.owners.get(owner);
		if (!entry || !entry.items.has(label) || pet === "") return {
			ok: true,
			delivered: false
		};
		entry.items.set(label, pet);
		const waiters = this.waiters.get(owner);
		if (waiters) for (const wake of [...waiters]) wake();
		return {
			ok: true,
			delivered: true
		};
	}
	/**
	* 查询触发：返回 `{ label: petId | null }` 全量映射，返回即清空这些标记。
	*
	* `waitMs > 0` 且当下没有任何触发 → 挂起等待（被点、超时、被覆盖都会唤醒），超时后照常返回
	* 全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
	*/
	async poll(owner, waitMs) {
		const entry = this.owners.get(owner);
		if (!entry) return null;
		if (waitMs > 0 && !hasFired(entry.items)) await new Promise((resolve$1) => {
			const set = this.waiters.get(owner) ?? new Set();
			this.waiters.set(owner, set);
			const hold = {};
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (hold.timer !== void 0) clearTimeout(hold.timer);
				set.delete(finish);
				if (set.size === 0 && this.waiters.get(owner) === set) this.waiters.delete(owner);
				resolve$1();
			};
			hold.timer = setTimeout(finish, Math.min(waitMs, MENU_WAIT_MAX_MS));
			set.add(finish);
		});
		const current$2 = this.owners.get(owner);
		if (!current$2) return null;
		const out = {};
		for (const [label, pet] of current$2.items) {
			out[label] = pet;
			current$2.items.set(label, null);
		}
		return out;
	}
};
/** 该 owner 当前有没有任意一项被点过。 */
function hasFired(items) {
	for (const pet of items.values()) if (pet !== null) return true;
	return false;
}

//#endregion
//#region src/host/paths.ts
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, "assets");
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, "memes");

//#endregion
//#region src/shared/playback.ts
const TERMINAL_STATUSES = [
	"ended",
	"failed",
	"cancelled"
];
const REPORTABLE_STATUSES = [
	"playing",
	"ended",
	"failed",
	"cancelled"
];

//#endregion
//#region src/host/playback/status.ts
const PLAYBACK_KEEP_MS = 60 * 1e3;
const MAX_PLAYBACK_WAIT_MS = 10 * 1e3;
/** 终态判定用集合。 */
const TERMINAL = new Set(TERMINAL_STATUSES);
/** 可上报判定用集合。 */
const REPORTABLE = new Set(REPORTABLE_STATUSES);
const isTerminalStatus = (s) => TERMINAL.has(s);
const isPlaybackStatus = (s) => s === "accepted" || REPORTABLE.has(s);
const isReportableStatus = (s) => REPORTABLE.has(s);

//#endregion
//#region src/host/playback/parse.ts
function parsePlaybackPath(rest) {
	const m = /^playback\/([^/]+)(\/report)?$/.exec(rest);
	if (!m) return void 0;
	return {
		playbackId: m[1] ?? "",
		isReport: m[2] === "/report"
	};
}
function parseWaitQuery(waitRaw, timeoutRaw) {
	if (waitRaw === null && timeoutRaw === null) return { kind: "none" };
	if (waitRaw === null || timeoutRaw === null) return {
		kind: "error",
		error: "wait and timeout must be used together"
	};
	const wait = waitRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
	const bad = wait.find((s) => !isPlaybackStatus(s));
	if (wait.length === 0 || bad !== void 0) return {
		kind: "error",
		error: `invalid wait status: ${bad ?? waitRaw}`
	};
	if (!/^\d+$/.test(timeoutRaw)) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})`
	};
	const timeoutMs = Number(timeoutRaw);
	if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_PLAYBACK_WAIT_MS) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})`
	};
	return {
		kind: "ok",
		wait,
		timeoutMs
	};
}

//#endregion
//#region src/host/playback/store.ts
var PlaybackStore = class {
	constructor() {
		this.records = new Map();
		this.waiters = new Map();
		this.activeByPet = new Map();
		this.seq = 0;
	}
	/**
	* 受理一次点播：建记录（accepted），并把该宠物上一场（若仍在非终态）标为 cancelled/superseded。
	* @returns 新建的记录（调用方取 playbackId 下发给调用方）。
	*/
	create(petId, name$1) {
		this.sweep();
		const prev = this.activeByPet.get(petId);
		if (prev !== void 0) this.finish(prev, "cancelled", "superseded");
		const now = Date.now();
		const record = {
			playbackId: "pb-" + now.toString(36) + "-" + (++this.seq).toString(36),
			petId,
			name: name$1,
			status: "accepted",
			createdAt: now,
			updatedAt: now
		};
		this.records.set(record.playbackId, record);
		this.activeByPet.set(petId, record.playbackId);
		return record;
	}
	/** 查记录；不存在 / 已过期返回 undefined（路由回 404）。 */
	get(playbackId) {
		this.sweep();
		return this.records.get(playbackId);
	}
	/**
	* 渲染端上报一次状态。
	*
	* 终态之后的上报一律 ignored（迟到的 ended 不许覆盖 cancelled），与当前状态相同的上报同样
	* ignored；两种情况路由都回 200——对上报方来说「已经这样了」就是成功。
	*/
	report(playbackId, status, reason) {
		this.sweep();
		const record = this.records.get(playbackId);
		if (!record) return "unknown";
		const next = typeof status === "string" ? status : "";
		if (!isReportableStatus(next)) return "invalid";
		if (isTerminalStatus(record.status) || record.status === next) return "ignored";
		const why = typeof reason === "string" && reason !== "" ? reason : void 0;
		this.finish(playbackId, next, why);
		return "ok";
	}
	/**
	* 挂起一个等待者。
	* @returns 取消函数；编号不存在时返回 undefined（路由据此立刻回 404，不挂）。
	*/
	wait(args) {
		this.sweep();
		const record = this.records.get(args.playbackId);
		if (!record) return void 0;
		const waiter = {
			wait: new Set(args.wait),
			onWake: args.onWake,
			record,
			timer: void 0
		};
		let set = this.waiters.get(args.playbackId);
		if (!set) {
			set = new Set();
			this.waiters.set(args.playbackId, set);
		}
		set.add(waiter);
		waiter.timer = setTimeout(() => {
			this.dropWaiter(args.playbackId, waiter);
			waiter.onWake(waiter.record, false);
		}, Math.max(0, args.timeoutMs));
		waiter.timer.unref?.();
		return () => this.dropWaiter(args.playbackId, waiter);
	}
	/** 结束所有挂起的等待（插件卸载 / 宿主退出路径）；唤醒时 matched=false，调用方据此立刻收尾。 */
	cancelAll() {
		for (const [playbackId, set] of [...this.waiters]) for (const waiter of [...set]) {
			this.dropWaiter(playbackId, waiter);
			waiter.onWake(waiter.record, false);
		}
	}
	/**
	* 清理过期终态记录（惰性调用：create / get / report 各调一次，记录数很少，成本可忽略）。
	*
	* 必须先把还在等它的人叫醒：等待上限（10s）通常远小于保留时长（60s），但调用方完全可以在
	* 一条终态记录的保留窗口末尾注册一个等「别的状态」的等待者——不唤醒就成了永远等不到的悬挂等待者。
	*
	* @param now - 注入时间（单测用；缺省取当前时刻）。
	*/
	sweep(now = Date.now()) {
		for (const [playbackId, record] of this.records) {
			if (!isTerminalStatus(record.status)) continue;
			if (now - record.updatedAt < PLAYBACK_KEEP_MS) continue;
			const set = this.waiters.get(playbackId);
			if (set) for (const waiter of [...set]) {
				this.dropWaiter(playbackId, waiter);
				waiter.onWake(waiter.record, false);
			}
			this.records.delete(playbackId);
		}
	}
	/** 当前记录数（测试 / 观测用）。 */
	count() {
		return this.records.size;
	}
	/** 当前等待者数（测试 / 观测用：验证不泄漏）。 */
	waiterCount() {
		let n = 0;
		for (const set of this.waiters.values()) n += set.size;
		return n;
	}
	/**
	* 落到一个终态：写状态、更新时间、摘掉「当前活跃」、唤醒在等这个状态的人。
	* 这是唯一的状态写入点，所以等待者唤醒只在这里发生（不需要 diff、不需要比对）。
	*/
	finish(playbackId, status, reason) {
		const record = this.records.get(playbackId);
		if (!record) return;
		record.status = status;
		record.updatedAt = Date.now();
		if (status === "ended") record.endedAt = record.updatedAt;
		if (reason !== void 0) record.reason = reason;
		if (this.activeByPet.get(record.petId) === playbackId) this.activeByPet.delete(record.petId);
		const set = this.waiters.get(playbackId);
		if (!set) return;
		for (const waiter of [...set]) {
			if (!waiter.wait.has(status)) continue;
			this.dropWaiter(playbackId, waiter);
			waiter.onWake(waiter.record, true);
		}
	}
	/** 摘掉一个等待者（清定时器 + 从集合移除 + 空集合回收）。 */
	dropWaiter(playbackId, waiter) {
		if (waiter.timer !== void 0) {
			clearTimeout(waiter.timer);
			waiter.timer = void 0;
		}
		const set = this.waiters.get(playbackId);
		if (!set) return;
		set.delete(waiter);
		if (set.size === 0) this.waiters.delete(playbackId);
	}
};

//#endregion
//#region src/host/http.ts
const MIME = {
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".wav": "audio/wav",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
const IMAGE_HEAD_BYTES = 16;
function imageTypeOf(header, size) {
	if (size >= 8 && header.readUInt32BE(0) === 2303741511 && header.readUInt32BE(4) === 218765834) return "image/png";
	if (size >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
	if (size >= 6) {
		const tag = header.toString("latin1", 0, 6);
		if (tag === "GIF87a" || tag === "GIF89a") return "image/gif";
	}
	if (size >= 12 && header.toString("latin1", 0, 4) === "RIFF" && header.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	return void 0;
}
function imageExtOf(contentType) {
	if (contentType === "image/png") return ".png";
	if (contentType === "image/jpeg") return ".jpg";
	if (contentType === "image/webp") return ".webp";
	if (contentType === "image/gif") return ".gif";
	return void 0;
}
function resolveAsset(root, rel) {
	if (rel.length === 0) return void 0;
	const candidate = normalize(join(root, rel));
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
	return candidate;
}
function resolveExisting(root, rel) {
	const candidate = resolveAsset(root, rel);
	return candidate && existsSync(candidate) ? candidate : void 0;
}
function parseRange(header, totalBytes) {
	if (!header || totalBytes <= 0) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const startText = match[1] ?? "";
	const endText = match[2] ?? "";
	if (startText === "" && endText === "") return null;
	if (startText === "") {
		const suffixLength = Number(endText);
		if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
		return {
			start: Math.max(0, totalBytes - suffixLength),
			end: totalBytes - 1
		};
	}
	const start = Number(startText);
	const end = endText === "" ? totalBytes - 1 : Number(endText);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	if (start > end || start >= totalBytes) return "unsatisfiable";
	return {
		start,
		end: Math.min(end, totalBytes - 1)
	};
}
function sendFile(req, res, file, contentType) {
	const stream = createReadStream(file);
	stream.once("open", (fd) => {
		if (res.destroyed || res.writableEnded) {
			stream.destroy();
			return;
		}
		let totalBytes;
		try {
			totalBytes = fstatSync(fd).size;
		} catch {
			res.writeHead(200, {
				"content-type": contentType,
				"cache-control": "public, max-age=3600"
			});
			stream.pipe(res);
			return;
		}
		const decision = parseRange(req.headers.range, totalBytes);
		if (decision === "unsatisfiable") {
			stream.destroy();
			res.writeHead(416, {
				"content-type": contentType,
				"content-range": `bytes */${totalBytes}`,
				"accept-ranges": "bytes",
				"cache-control": "public, max-age=3600"
			});
			res.end();
			return;
		}
		if (decision !== null) {
			stream.destroy();
			const ranged = createReadStream(file, {
				start: decision.start,
				end: decision.end
			});
			res.writeHead(206, {
				"content-type": contentType,
				"content-length": decision.end - decision.start + 1,
				"content-range": `bytes ${decision.start}-${decision.end}/${totalBytes}`,
				"accept-ranges": "bytes",
				"cache-control": "public, max-age=3600"
			});
			ranged.pipe(res);
			ranged.on("error", () => res.destroy());
			res.on("close", () => ranged.destroy());
			return;
		}
		res.writeHead(200, {
			"content-type": contentType,
			"content-length": totalBytes,
			"accept-ranges": "bytes",
			"cache-control": "public, max-age=3600"
		});
		stream.pipe(res);
	});
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
}
function sendJson(res, status, obj$1, headers = {}) {
	const body = JSON.stringify(obj$1);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...headers
	});
	res.end(body);
}
function sendText(res, status, body) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(body);
}
const MAX_BODY_BYTES = 1024 * 1024;
function readBody(req) {
	return new Promise((resolve2, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		/**
		* 落地一次：'close' 在正常应答后也会触发，靠标志位拒绝二次落地。
		* 不摘监听——请求对象随连接回收，摘监听反而要求调用方提供完整的 on/off 对（测试桩通常只有 on）。
		*/
		const settle = (finish) => {
			if (settled) return;
			settled = true;
			finish();
		};
		const onData = (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settle(() => reject(Object.assign(new Error("request body too large"), { code: "body-too-large" })));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = () => settle(() => resolve2(Buffer.concat(chunks).toString("utf8")));
		const onError = (error) => settle(() => reject(error));
		const onAborted = () => settle(() => reject(Object.assign(new Error("client aborted"), { code: "client-aborted" })));
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("close", onAborted);
		req.on("aborted", onAborted);
	});
}

//#endregion
//#region src/host/state.ts
const MAX_STATE_WAIT_MS = 10 * 1e3;
function parseStateWaitQuery(sinceRaw, timeoutRaw) {
	if (sinceRaw === null && timeoutRaw === null) return { kind: "none" };
	if (sinceRaw === null || timeoutRaw === null) return {
		kind: "error",
		error: "since and timeout must be used together"
	};
	if (!/^\d+$/.test(sinceRaw)) return {
		kind: "error",
		error: "invalid since (expect a non-negative integer)"
	};
	if (!/^\d+$/.test(timeoutRaw)) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})`
	};
	const since = Number(sinceRaw);
	const timeoutMs = Number(timeoutRaw);
	if (!Number.isFinite(since)) return {
		kind: "error",
		error: "invalid since (expect a non-negative integer)"
	};
	if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_STATE_WAIT_MS) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})`
	};
	return {
		kind: "ok",
		since,
		timeoutMs
	};
}
/** 空叶子：counter=0 表示从未写过——前端首拉把它当基线，之后 counter 变化才渲染。 */
const emptyLeaf = () => ({
	counter: 0,
	data: null
});
var PollStateStore = class {
	constructor() {
		this.last = 0;
		this.sections = {
			balance: emptyLeaf(),
			workStatus: emptyLeaf(),
			notify: emptyLeaf(),
			config: emptyLeaf(),
			menu: emptyLeaf(),
			focusSession: emptyLeaf(),
			request: emptyLeaf(),
			reminder: emptyLeaf(),
			history: emptyLeaf()
		};
		this.pets = new Map();
		this.waiters = new Set();
	}
	/** 下一个 counter。 */
	next() {
		this.last = Math.max(Date.now(), this.last + 1);
		return this.last;
	}
	/**
	* 写一个全局叶子（余额 / 工作状态 / 通知 / 配置变更信号）。
	* 整体替换叶子对象而不是原地改字段：`read()` 拿到的引用因此不会半新半旧。
	*/
	writeSection(name$1, data) {
		this.sections[name$1] = {
			counter: this.next(),
			data
		};
		this.wakeWaiters();
	}
	/** 写一只宠物的叶子（宠物条目不存在则自动建立，所有槽位一起建好，形状恒定）。 */
	writePet(petId, leaf, data) {
		let entry = this.pets.get(petId);
		if (!entry) {
			entry = {
				say: emptyLeaf(),
				anim: emptyLeaf(),
				position: emptyLeaf(),
				throw: emptyLeaf(),
				lock: emptyLeaf(),
				sleep: emptyLeaf(),
				hidden: emptyLeaf()
			};
			this.pets.set(petId, entry);
		}
		entry[leaf] = {
			counter: this.next(),
			data
		};
		this.wakeWaiters();
	}
	/**
	* 当前 S（GET /state 的响应体）。
	* sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
	* 所以消费端不会读到写了一半的叶子。
	*/
	read() {
		return {
			counter: this.last,
			sections: { ...this.sections },
			pets: Object.fromEntries(this.pets)
		};
	}
	/**
	* 挂起一个等待者：直到 `last` 变得不等于 `since`、或超时、或调用方取消。
	*
	* 三种收尾对调用方是同一件事（去 `read()` 拿最新状态），所以回调不带参数。
	*
	* @returns 取消函数（清掉超时定时器并摘掉等待者）。
	*/
	wait(args) {
		const waiter = {
			since: args.since,
			onWake: args.onWake,
			timer: void 0
		};
		this.waiters.add(waiter);
		waiter.timer = setTimeout(() => {
			this.dropWaiter(waiter);
			waiter.onWake();
		}, Math.max(0, args.timeoutMs));
		if (process.env.NODE_TEST_CONTEXT === void 0) waiter.timer.unref?.();
		return () => this.dropWaiter(waiter);
	}
	/**
	* 结束所有挂起的等待（插件卸载 / 宿主退出路径）。
	* 唤醒时不给区分标志：调用方据此立刻收尾，而不是留一个悬挂的响应。
	*/
	cancelAll() {
		for (const waiter of [...this.waiters]) {
			this.dropWaiter(waiter);
			waiter.onWake();
		}
	}
	/** 当前等待者数（测试 / 观测用：验证不泄漏）。 */
	waiterCount() {
		return this.waiters.size;
	}
	/**
	* 唤醒所有已经过期的等待者（唯一调用点是两个 write 方法，且必须在叶子写定之后）。
	* `since === this.last` 的跳过：那种等待者已经是最新的，叫醒它等于空转。
	* 必须写在 `this.sections[name] = …` 之后：放在 next() 里会让回调先于赋值执行，调用方读到旧状态。
	*/
	wakeWaiters() {
		if (this.waiters.size === 0) return;
		for (const waiter of [...this.waiters]) {
			if (waiter.since === this.last) continue;
			this.dropWaiter(waiter);
			waiter.onWake();
		}
	}
	/** 摘掉一个等待者（清定时器 + 从集合移除）。 */
	dropWaiter(waiter) {
		if (waiter.timer !== void 0) {
			clearTimeout(waiter.timer);
			waiter.timer = void 0;
		}
		this.waiters.delete(waiter);
	}
};

//#endregion
//#region src/host/work-status.ts
const HOST_WORK_STATUS_STATES = [
	"thinking",
	"working",
	"result",
	"waiting",
	"success",
	"error"
];
/**
* 回合结束原因 → 档位：completed → success，错误系（error / max-tokens / timeout）→ error，
* blocked → waiting；其余（aborted 等）→ null，由调用方清理会话回空闲——残留上一档会让回合被
* 打断后永远卡在 working。
*/
function turnEndState(kind) {
	if (kind === "completed") return "success";
	if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
	if (kind === "blocked") return "waiting";
	return null;
}
/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作。 */
const USER_QUESTION_TOOL$1 = "ask_user_question";
const GOAL_UPDATE_TOOL = "update_goal";
function goalUpdateAction(args) {
	try {
		const o = JSON.parse(args);
		const action = String(o?.action ?? "");
		if (action === "complete" || action === "blocked") return action;
	} catch {}
	return null;
}
function completedState(turn) {
	if (!turn?.goalRound) return "success";
	if (turn.closing === "blocked") return "error";
	if (turn.closing === "complete") return "success";
	return "result";
}
function reduceWorkStatus(event, turn) {
	switch (event?.type) {
		case "turn/start": return "thinking";
		case "tool/call": {
			if (String(event?.data?.name ?? "") === USER_QUESTION_TOOL$1) return "waiting";
			return "working";
		}
		case "tool/result": return "result";
		case "approval/asked": return "waiting";
		case "turn/end": {
			const reason = turnEndState(String(event?.data?.reason?.kind ?? ""));
			if (reason === "success") return completedState(turn);
			return reason;
		}
		default: return null;
	}
}
const TASK_TEXT_MAX = 40;
function currentTaskFromTodo(event) {
	const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
	let current$2;
	for (const t of todos) if (t?.status === "in_progress") current$2 = t;
	if (!current$2) current$2 = todos.find((t) => t?.status === "pending");
	const content = String(current$2?.content ?? "").trim();
	if (!content) return null;
	const points = Array.from(content);
	return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : content;
}
function todoCounts(event) {
	const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
	let done = 0;
	for (const t of todos) if (t?.status === "completed") done += 1;
	return {
		done,
		total: todos.length
	};
}
const EXTERNAL_WORK_TTL_MS = 10 * 60 * 1e3;
const WORK_STATUS_PRIORITY = {
	waiting: 60,
	error: 50,
	working: 40,
	thinking: 30,
	result: 25,
	success: 20
};
function pickDisplayed(entries) {
	let best;
	for (const entry of entries) if (!best || WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] || WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq) best = entry;
	return best;
}
var WorkStatusStore = class {
	constructor(externalSessionId = "api", now = Date.now) {
		this.sessions = new Map();
		this.externalSessionId = externalSessionId;
		this.now = now;
		this.snap = {
			state: null,
			task: null,
			sessionId: null,
			steps: 0,
			startedAt: null,
			todoDone: 0,
			todoTotal: 0,
			ts: 0
		};
	}
	/** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案）。 */
	has(sessionId) {
		return this.sessions.has(sessionId);
	}
	/** 该会话当前档位（无条目 / 已清返回 undefined）。 */
	stateOf(sessionId) {
		return this.sessions.get(sessionId)?.state;
	}
	/** 该会话当前任务详情（无条目返回 null）。 */
	taskOf(sessionId) {
		return this.sessions.get(sessionId)?.task ?? null;
	}
	/** 该会话的清单进度（无条目返回 0/0）——写接口回读自己刚写进去的那一份，而不是被优先级挑中的那份。 */
	todoOf(sessionId) {
		const entry = this.sessions.get(sessionId);
		return {
			done: entry?.todoDone ?? 0,
			total: entry?.todoTotal ?? 0
		};
	}
	/** 新一轮开始：步数清零并记下起点（同一会话的上一轮不该把步数带进这一轮）。 */
	beginTurn(sessionId, at) {
		const prev = this.sessions.get(sessionId);
		if (!prev) return;
		this.sessions.set(sessionId, {
			...prev,
			steps: 0,
			startedAt: at,
			todoDone: 0,
			todoTotal: 0,
			touchedAt: this.now()
		});
		this.refresh();
	}
	/** 又跑了一个工具：步数 +1（调用方在 tool/call 时调）。 */
	bumpStep(sessionId) {
		const prev = this.sessions.get(sessionId);
		if (!prev) return;
		this.sessions.set(sessionId, {
			...prev,
			steps: prev.steps + 1,
			touchedAt: this.now()
		});
		this.refresh();
	}
	/** 写清单进度（todo/write 时调）；没有清单（total 0）就是把进度条收掉。 */
	setTodoCounts(sessionId, done, total) {
		const prev = this.sessions.get(sessionId);
		if (!prev) return false;
		const safeDone = Number.isFinite(done) && done > 0 ? Math.floor(done) : 0;
		const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
		const nextDone = Math.min(safeDone, safeTotal);
		if (prev.todoDone === nextDone && prev.todoTotal === safeTotal) return false;
		this.sessions.set(sessionId, {
			...prev,
			todoDone: nextDone,
			todoTotal: safeTotal,
			touchedAt: this.now()
		});
		this.refresh();
		return true;
	}
	/** 写会话状态（保留该会话已有的 task / steps / startedAt）；同状态且 seq 不更新则不写并返回 false（防刷屏）。 */
	setState(sessionId, state, seq = 0) {
		const prev = this.sessions.get(sessionId);
		if (prev?.state === state && prev.seq >= seq) return false;
		this.sessions.set(sessionId, {
			state,
			seq,
			task: prev?.task ?? null,
			steps: prev?.steps ?? 0,
			startedAt: prev?.startedAt ?? null,
			todoDone: prev?.todoDone ?? 0,
			todoTotal: prev?.todoTotal ?? 0,
			sessionId,
			touchedAt: this.now()
		});
		this.refresh();
		return true;
	}
	/** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示）。 */
	setTask(sessionId, task) {
		const prev = this.sessions.get(sessionId);
		if (!prev || prev.task === task) return false;
		this.sessions.set(sessionId, {
			...prev,
			task,
			touchedAt: this.now()
		});
		this.refresh();
		return true;
	}
	/** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里。 */
	clear(sessionId) {
		if (!this.sessions.delete(sessionId)) return false;
		this.refresh();
		return true;
	}
	/** 展示快照（对象引用稳定，供 /work-status 直接序列化）；读的时候顺手收掉放旧的外部槽。 */
	snapshot(now = this.now()) {
		if (this.expire(now)) this.refresh();
		return this.snap;
	}
	/** 收掉超时的外部槽；返回是否真的删了条目（调用方据此决定要不要重算展示）。 */
	expire(now) {
		const entry = this.sessions.get(this.externalSessionId);
		if (!entry) return false;
		if (now - entry.touchedAt <= EXTERNAL_WORK_TTL_MS) return false;
		return this.sessions.delete(this.externalSessionId);
	}
	/** 重算展示：state / task / sessionId / 步数 / 起点 / 清单进度任一变化才更新 ts。 */
	refresh() {
		const best = pickDisplayed(this.sessions.values());
		const nextState = best?.state ?? null;
		const nextTask = best?.task ?? null;
		const nextSession = best?.sessionId ?? null;
		const nextSteps = best?.steps ?? 0;
		const nextStarted = best?.startedAt ?? null;
		const nextDone = best?.todoDone ?? 0;
		const nextTotal = best?.todoTotal ?? 0;
		if (nextState === this.snap.state && nextTask === this.snap.task && nextSession === this.snap.sessionId && nextSteps === this.snap.steps && nextStarted === this.snap.startedAt && nextDone === this.snap.todoDone && nextTotal === this.snap.todoTotal) return;
		this.snap.state = nextState;
		this.snap.task = nextTask;
		this.snap.sessionId = nextSession;
		this.snap.steps = nextSteps;
		this.snap.startedAt = nextStarted;
		this.snap.todoDone = nextDone;
		this.snap.todoTotal = nextTotal;
		this.snap.ts = this.now();
	}
};

//#endregion
//#region src/host/plugin/setup.ts
function createHostSetup(ctx) {
	const home = resolvePetHome();
	const userRoot = home.dir;
	mkdirSync(userRoot, { recursive: true });
	const reusedLog = isFileLogger(ctx.logger) ? ctx.logger : void 0;
	const log = reusedLog ?? createFileLogger({
		file: join(userRoot, "logs.txt"),
		base: ctx.logger,
		debugEnabled: process.env.DSH_PET_LOG_DEBUG === "1"
	});
	setDefaultLogger(log);
	if (!reusedLog) ctx.effect(() => () => {
		log.flush();
		log.dispose();
	}, "dsh-pet: log file");
	/**
	* 软取宿主提供的可选服务（DSH 的 `ctx.get(name, required)` 语义：缺失返回 undefined，不抛）。
	*
	* 不能直接读 `ctx.xxx`：DSH 的 ctx 是严格 getter，读未写进 inject 的服务会抛异常而非返回 undefined
	* ——独立模式独有的 standaloneAi / shutdownApp 都没进 inject，裸读会让碎碎念 tick 每拍抛错、
	* /quit 回 500 而不是 {canQuit:false}。测试里的 fake ctx 没有 get，回落成属性读取即可。
	*/
	const optionalService = (name$1) => {
		const get = ctx.get;
		if (typeof get === "function") return get.call(ctx, name$1, false);
		return ctx[name$1];
	};
	/** 独立模式的碎碎念授权策略（可选能力）：DSH 宿主里是 undefined → 回落到只看 pet.whisperEnabled。 */
	const standaloneAiPolicy = () => optionalService("standaloneAi");
	/** 独立模式的余额凭证（可选能力）：DSH 宿主里是 undefined → 回落到模型服务商与 credential store。 */
	const standaloneAiBalance = () => {
		const service = optionalService("standaloneAi");
		return service?.balanceAuth?.();
	};
	const userConfigPath = join(userRoot, "main-config.jsonc");
	const legacyUserConfigPath = join(userRoot, "main-config.json");
	const petConfigDir = join(userRoot, "pet");
	const configPaths = {
		defaultFile: join(PACKAGE_ROOT, "assets", "config.jsonc"),
		userFile: userConfigPath,
		legacyUserFile: legacyUserConfigPath,
		petDir: petConfigDir
	};
	migrateUserConfig(configPaths, (msg) => log.info("[dsh-pet] " + msg));
	const thumbUserRoot = join(userRoot, "main-animation");
	const memesUserRoot = join(userRoot, "memes");
	/**
	* 表情包目录链，与动画素材（/thumb）同一套归属语义：`pet/<素材根>-memes/` 存在则只查它；
	* 否则用户目录优先、包内兜底。池（readMemePool）与路由（/pic/memes）必须走同一个函数，
	* 否则池里能选的名字路由取不到，气泡配图会图裂。
	* 素材根来自 URL 段，必须先过 resolveAsset，避免 Windows 上 %5C 解出的反斜杠逃出用户根。
	*/
	const memeDirsFor = (assetRoot) => {
		const own$1 = resolveAsset(petConfigDir, assetRoot + "-memes");
		if (own$1 !== void 0 && existsSync(own$1)) return [own$1];
		return [memesUserRoot, PACKAGE_MEMES_DIR];
	};
	const state = new PollStateStore();
	const menuRegistry = new MenuRegistry();
	ctx.provide("petApi7340", {
		balance: {
			register: registerBalanceProvider,
			list: listBalanceProviders
		},
		voice: {
			register: registerVoiceProvider,
			list: listVoiceProviders
		},
		speech: {
			register: registerSpeechProvider,
			list: listSpeechProviders
		}
	});
	const playback = new PlaybackStore();
	/** 外部写入槽：固定会话 id，最后写入者生效；不做多写者仲裁/租约/会话管理 */
	const EXTERNAL_WORK_SESSION = "api";
	const workStatus = new WorkStatusStore(EXTERNAL_WORK_SESSION);
	let externalWorkSeq = 0;
	/** 推进外部写入序号并返回新值：每发生一次外部写入前进一拍，前端据此判断是否新的一次写入。 */
	const nextExternalWorkSeq = () => externalWorkSeq += 1;
	return {
		userRoot,
		home,
		log,
		configPaths,
		userConfigPath,
		petConfigDir,
		thumbUserRoot,
		memesUserRoot,
		memeDirsFor,
		optionalService,
		standaloneAiPolicy,
		standaloneAiBalance,
		state,
		menuRegistry,
		playback,
		workStatus,
		EXTERNAL_WORK_SESSION,
		nextExternalWorkSeq
	};
}

//#endregion
//#region src/host/routes/result.ts
function failureBody(reason, message, extra) {
	return {
		...extra,
		ok: false,
		reason,
		message
	};
}
function okResult(obj$1 = {}, headers) {
	return {
		kind: "json",
		status: 200,
		obj: obj$1,
		headers
	};
}
function failResult(reason, message, extra) {
	return {
		kind: "json",
		status: 200,
		obj: failureBody(reason, message, extra)
	};
}
function invalidJson(message = "invalid JSON body") {
	return rejected(400, "invalid-json", message);
}
function methodNotAllowed(message = "method not allowed") {
	return rejected(405, "method-not-allowed", message);
}
function payloadTooLarge(message = "request body too large") {
	return rejected(413, "payload-too-large", message);
}
/** 协议失败：真实状态码 + 与业务失败同一形状的体。 */
function rejected(status, reason, message) {
	return {
		kind: "json",
		status,
		obj: failureBody(reason, message)
	};
}

//#endregion
//#region src/host/pet-avatar.ts
/** 探测顺序：正常情况下同一素材根只有一个头像文件，顺序只影响同时存在多份时的遍历次序。 */
const AVATAR_EXTS = [
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif"
];
function petAvatarFile(avatarDir, petId) {
	let best;
	let bestMtime = -Infinity;
	for (const ext of AVATAR_EXTS) {
		const file = resolveAsset(avatarDir, petId + "-avatar" + ext);
		if (file === void 0 || !existsSync(file)) continue;
		let mtime;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			continue;
		}
		if (mtime > bestMtime) {
			bestMtime = mtime;
			best = {
				file,
				contentType: MIME[ext] ?? "application/octet-stream"
			};
		}
	}
	return best;
}
function savePetAvatar(avatarDir, petId, bytes) {
	const contentType = imageTypeOf(bytes, Math.min(bytes.length, IMAGE_HEAD_BYTES));
	const ext = contentType === void 0 ? void 0 : imageExtOf(contentType);
	if (ext === void 0) return {
		ok: false,
		reason: "not-image"
	};
	const file = resolveAsset(avatarDir, petId + "-avatar" + ext);
	if (file === void 0) return {
		ok: false,
		reason: "write-failed"
	};
	for (const other of AVATAR_EXTS) {
		if (other === ext) continue;
		const stale = resolveAsset(avatarDir, petId + "-avatar" + other);
		if (stale === void 0) continue;
		try {
			unlinkSync(stale);
		} catch {}
	}
	try {
		writeFileSync(file, bytes);
	} catch {
		return {
			ok: false,
			reason: "write-failed"
		};
	}
	return { ok: true };
}

//#endregion
//#region src/host/routes/assets.ts
async function handleAssetsRoutes(deps, input) {
	const { assetRootFor, memeDirsFor, petConfigDir, userRootFor } = deps;
	const { rest, url } = input;
	const [scope, ...restParts] = rest.split("/");
	if (scope === "logo") {
		if (restParts.length > 0) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/logo"
		};
		const assetRoot = (url.searchParams.get("root") ?? "").trim();
		if (assetRoot !== "" && assetRoot !== "main") {
			if (!isValidPetId(assetRoot)) return {
				kind: "text",
				status: 400,
				body: "dsh-pet: invalid asset root"
			};
			const own$1 = petAvatarFile(petConfigDir, assetRoot);
			if (own$1 !== void 0) return {
				kind: "file",
				file: own$1.file,
				contentType: own$1.contentType
			};
		}
		const logo = resolveExisting(join(PACKAGE_ROOT, "assets"), "logo.png");
		if (logo === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: logo not found"
		};
		return {
			kind: "file",
			file: logo,
			contentType: MIME[".png"] ?? "image/png"
		};
	}
	if (scope === "font") {
		const fontRoot = join(PACKAGE_ROOT, "assets", "fonts");
		const fontFile = resolveExisting(fontRoot, restParts.join("/"));
		if (fontFile === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: font not found"
		};
		const ext$1 = fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase();
		return {
			kind: "file",
			file: fontFile,
			contentType: MIME[ext$1] ?? "application/octet-stream"
		};
	}
	if (scope === "pic") {
		if (restParts[0] === "memes") {
			const segs = restParts.slice(1);
			const scoped = segs.length >= 2;
			const assetRoot = scoped ? segs[0] : "main";
			if (scoped && !isValidPetId(assetRoot)) return {
				kind: "text",
				status: 400,
				body: "dsh-pet: invalid asset root"
			};
			const rel = (scoped ? segs.slice(1) : segs).join("/");
			let picFile$1;
			for (const dir of memeDirsFor(assetRoot)) {
				picFile$1 = resolveExisting(dir, rel);
				if (picFile$1 !== void 0) break;
			}
			if (picFile$1 === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: pic not found"
			};
			const ext$2 = picFile$1.slice(picFile$1.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: picFile$1,
				contentType: MIME[ext$2] ?? "application/octet-stream"
			};
		}
		const picRoot = join(PACKAGE_ROOT, "assets", "pic");
		const picFile = resolveExisting(picRoot, restParts.join("/"));
		if (picFile === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: pic not found"
		};
		const ext$1 = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
		return {
			kind: "file",
			file: picFile,
			contentType: MIME[ext$1] ?? "application/octet-stream"
		};
	}
	if (scope === "sound") {
		const soundRoot = join(PACKAGE_ROOT, "assets", "sound");
		const soundFile = resolveExisting(soundRoot, restParts.join("/"));
		if (soundFile === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: sound not found"
		};
		const ext$1 = soundFile.slice(soundFile.lastIndexOf(".")).toLowerCase();
		return {
			kind: "file",
			file: soundFile,
			contentType: MIME[ext$1] ?? "application/octet-stream"
		};
	}
	if (scope !== "thumb") return {
		kind: "text",
		status: 400,
		body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
	};
	const [petId, ...nameParts] = restParts;
	if (!petId || nameParts.length === 0) return {
		kind: "text",
		status: 400,
		body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
	};
	if (!isValidPetId(petId)) return {
		kind: "text",
		status: 400,
		body: "dsh-pet: invalid pet id"
	};
	const fileName = nameParts.join("/");
	const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
	if (ext !== ".webm" && ext !== ".mov") return {
		kind: "text",
		status: 400,
		body: "dsh-pet: unsupported animation format (expected .webm or .mov)"
	};
	const extraAnimDir = resolveAsset(petConfigDir, petId + "-animation");
	/** 按扩展名查同名素材（专属目录优先；否则用户根 → 包内根） */
	const findAnim = (e) => {
		const name$1 = fileName.replace(/\.(webm|mov)$/i, "") + e;
		return extraAnimDir !== void 0 && existsSync(extraAnimDir) ? resolveExisting(extraAnimDir, name$1) : resolveExisting(userRootFor(e), name$1) ?? resolveExisting(assetRootFor(e), name$1);
	};
	let file = findAnim(ext);
	let servedExt = ext;
	if (file === void 0 && ext === ".mov") {
		const fb = findAnim(".webm");
		if (fb !== void 0) {
			file = fb;
			servedExt = ".webm";
		}
	}
	if (file === void 0) return {
		kind: "text",
		status: 404,
		body: "dsh-pet: asset not found"
	};
	return {
		kind: "file",
		file,
		contentType: MIME[servedExt] ?? "application/octet-stream"
	};
}

//#endregion
//#region src/host/routes/anchor.ts
let anchor = null;
const finite$1 = (value) => typeof value === "number" && Number.isFinite(value);
/** 校验并收窄上报体：缺字段/非数字/非正尺寸一律拒绝，绝不保存半成品。 */
function readAnchor(value) {
	if (value === null || typeof value !== "object") return null;
	const body = value;
	if (!finite$1(body.x) || !finite$1(body.y) || !finite$1(body.width) || !finite$1(body.height)) return null;
	if (body.width <= 0 || body.height <= 0) return null;
	return {
		x: body.x,
		y: body.y,
		width: body.width,
		height: body.height
	};
}
async function handleAnchorRoutes(_deps, input) {
	if (input.rest !== "anchor") return void 0;
	if (input.method === "GET") return okResult({ area: anchor });
	if (input.method !== "POST") return methodNotAllowed();
	let parsed;
	try {
		parsed = JSON.parse(input.body ?? "null");
	} catch {
		return invalidJson();
	}
	const next = readAnchor(parsed);
	if (next === null) return failResult("bad-request", "anchor area must be four finite numbers with positive size");
	anchor = next;
	return okResult({ ok: true });
}

//#endregion
//#region src/host/routes/attachment.ts
/** 附件 id 的合法形状（与宿主附件服务同一规则）：`sha256:` + 64 位小写 hex。 */
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/;
async function handleAttachmentRoutes(deps, input) {
	const { method, rest, url } = input;
	if (rest === "attachment") {
		if (method !== "GET") return {
			kind: "text",
			status: 405,
			body: "dsh-pet: method not allowed"
		};
		const id = url.searchParams.get("id") ?? "";
		if (!ATTACHMENT_ID.test(id)) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: invalid attachment id"
		};
		const sink = deps.optionalService("attachments");
		const file = locate(sink, id);
		if (file === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: attachment not found"
		};
		const contentType = sniffImageType(file);
		if (contentType === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: attachment is not a displayable image"
		};
		return {
			kind: "file",
			file,
			contentType
		};
	}
	return void 0;
}
/** 用附件服务定位对象；服务缺失、后端非文件式、引用非法或对象已被清掉都返回 undefined。 */
function locate(sink, id) {
	if (typeof sink?.imageHostPath !== "function") return void 0;
	try {
		const file = sink.imageHostPath({ attachmentId: id });
		return file !== void 0 && existsSync(file) ? file : void 0;
	} catch {
		return void 0;
	}
}
/** 按文件头判断图片类型；只认附件服务会存的四种，读不到或认不出返回 undefined。 */
function sniffImageType(file) {
	try {
		const fd = openSync(file, "r");
		try {
			const head = Buffer.alloc(IMAGE_HEAD_BYTES);
			return imageTypeOf(head, readSync(fd, head, 0, IMAGE_HEAD_BYTES, 0));
		} finally {
			closeSync(fd);
		}
	} catch {
		return void 0;
	}
}

//#endregion
//#region src/host/routes/avatar.ts
/** 解码后的字节上限：请求体 1 MiB 是 base64 文本的上限，解码后天然不超过 768 KiB。 */
const MAX_AVATAR_BYTES = 768 * 1024;
async function handleAvatarRoutes(deps, input) {
	if (input.rest === "pet-avatar") return acceptUpload(deps, input);
	return void 0;
}
/**
* 受理一次上传。
*
* @param deps - 路由层依赖（只用到文件宠物目录）。
* @param input - 已解析的请求（方法、URL、请求体）。
* @returns 成功，或按原因分档的业务/协议失败。
*/
async function acceptUpload(deps, input) {
	if (input.method !== "POST") return methodNotAllowed();
	const assetRoot = (input.url.searchParams.get("root") ?? "").trim();
	if (assetRoot === "") return failResult("bad-request", "缺少 root 参数（素材根）");
	if (!isValidPetId(assetRoot)) return failResult("bad-request", "素材根不合法");
	if (assetRoot === "main") return failResult("bad-request", "内置条目不能换头像：main 不写入 pet/ 目录");
	let raw;
	try {
		raw = JSON.parse(input.body ?? "");
	} catch {
		return invalidJson();
	}
	const base64 = typeof raw === "object" && raw !== null ? raw.base64 : void 0;
	if (typeof base64 !== "string" || base64 === "") return failResult("bad-request", "base64 必须是非空字符串");
	const bytes = Buffer.from(base64, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== base64) return failResult("bad-request", "base64 不合法");
	if (bytes.length > MAX_AVATAR_BYTES) return payloadTooLarge("头像超过 768 KiB");
	const saved = savePetAvatar(deps.petConfigDir, assetRoot, bytes);
	if (!saved.ok) return saved.reason === "not-image" ? failResult("unsupported", "只支持 PNG / JPEG / WebP / GIF") : failResult("internal-error", "头像写入失败");
	return okResult({ ok: true });
}

//#endregion
//#region src/host/routes/balance.ts
async function handleBalanceRoutes(deps, input) {
	const { refreshBalance } = deps;
	const { method, rest } = input;
	if (rest === "balance") {
		if (method !== "POST") return methodNotAllowed();
		await refreshBalance(true);
		return okResult({ ok: true });
	}
	return void 0;
}

//#endregion
//#region src/host/image-attachment.ts
/** 允许的媒体类型；顺序用于错误文案，与宿主附件服务的白名单保持一份事实。 */
const MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
/** base64 字符上限：请求体上限 1 MiB 下留出 text 与 JSON 结构的余量。 */
const MAX_BASE64_CHARS = 9e5;
function parseImageAttachment(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {
		ok: false,
		message: "attachment 必须是对象"
	};
	const { mediaType, data } = raw;
	if (typeof mediaType !== "string" || !MEDIA_TYPES.includes(mediaType)) return {
		ok: false,
		message: `attachment.mediaType 必须是 ${MEDIA_TYPES.join(" / ")} 之一`
	};
	if (typeof data !== "string" || data === "") return {
		ok: false,
		message: "attachment.data 必须是非空 base64 字符串"
	};
	if (data.length > MAX_BASE64_CHARS) return {
		ok: false,
		message: "attachment.data 过长（请压缩或降低分辨率）"
	};
	const decoded = Buffer.from(data, "base64");
	if (decoded.length === 0 || decoded.toString("base64") !== data) return {
		ok: false,
		message: "attachment.data 不是合法的 base64"
	};
	return {
		ok: true,
		mediaType,
		bytes: new Uint8Array(decoded)
	};
}

//#endregion
//#region src/host/routes/chat.ts
async function handleChatRoutes(deps, input) {
	const { configPaths, log, memoryPath, memoryRounds, readMemory, requirePet } = deps;
	const { body, method, rest, url } = input;
	if (rest === "chat/memory") {
		if (method !== "GET" && method !== "DELETE") return methodNotAllowed();
		try {
			if (method === "DELETE") return okResult(await deps.deleteOrphans());
			return okResult({
				ok: true,
				orphans: await deps.orphanHistory()
			});
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "chat") {
		if (method !== "GET" && method !== "POST" && method !== "DELETE") return methodNotAllowed();
		try {
			const roundsRaw = method === "GET" ? url.searchParams.get("rounds") : null;
			let roundsOverride = null;
			if (roundsRaw !== null && roundsRaw.trim() !== "") {
				const n = Number(roundsRaw);
				if (!Number.isInteger(n) || n < 0 || n > 200) return failResult("bad-request", "rounds 必须是 0–200 的整数（不传则用配置）");
				roundsOverride = n;
			}
			let tsList;
			if (method === "DELETE") {
				const parsed = parseTsList(url.searchParams.getAll("ts"));
				if (parsed === null) return failResult("bad-request", "ts 必须是非负整数（毫秒时间戳）");
				tsList = parsed.length > 0 ? parsed : void 0;
			}
			let cfgCache;
			const cfg = () => cfgCache ??= readAllConfig(configPaths);
			const who = requirePet(url.searchParams, cfg, { surface: method === "POST" });
			if (!who.ok) return who.res;
			const petId = who.petId;
			if (method === "GET") {
				const mem = await readMemory();
				const rawMessages = mem[who.entry]?.[petId]?.messages;
				const list = Array.isArray(rawMessages) ? rawMessages.filter((m) => m && typeof m.content === "string") : [];
				if (rawMessages !== void 0 && !Array.isArray(rawMessages)) log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId}，按空历史处理：${memoryPath}`);
				const rounds = roundsOverride ?? memoryRounds(who.conf);
				const messages = sliceMemoryRounds(list, rounds);
				return okResult({
					ok: true,
					messages,
					rounds
				});
			}
			if (method === "DELETE") return okResult(await deps.deleteHistory(petId, tsList));
			return await postChat(deps, petId, body);
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "chat/export") {
		if (method !== "POST") return methodNotAllowed();
		try {
			const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: false });
			if (!who.ok) return who.res;
			const mem = await readMemory();
			const rawMessages = mem[who.entry]?.[who.petId]?.messages;
			const list = Array.isArray(rawMessages) ? rawMessages.filter((m) => m && typeof m.content === "string") : [];
			return okResult(await exportChat(deps, who.petId, list));
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	return void 0;
}
/** 导出文件里的角色标题。 */
const ROLE_LABEL = {
	user: "我",
	assistant: "她"
};
/** 把一条时间戳写成 `YYYY-MM-DD HH:mm`（本地时区，与用户看到的一致）。 */
function stampOf(ts) {
	const d = new Date(ts);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 文件名里只留安全字符：宠物 id 是用户可编辑的，可能带路径分隔符。 */
function safeName(raw) {
	return raw.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
}
/**
* 把对话历史写成 Markdown 文件。
*
* @param deps - 路由依赖（`userRoot` 决定落盘位置）。
* @param petId - 已校验存在的宠物 id。
* @param messages - 整条历史（不截轮）。
* @returns 文件绝对路径与条数——前端把它显示出来，用户自己去打开或另存。
*/
async function exportChat(deps, petId, messages) {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const dir = join(deps.userRoot, "exports");
	const file = join(dir, `dsh-pet-chat-${safeName(petId)}-${stamp}.md`);
	const lines = [
		`# 和 ${petId} 的对话记录`,
		"",
		`- 导出时间：${stampOf(now.getTime())}`,
		`- 条数：${messages.length}`,
		""
	];
	for (const m of messages) {
		const label = m.role === "user" ? ROLE_LABEL.user : ROLE_LABEL.assistant;
		lines.push(`## ${stampOf(m.ts)} ${label}`, "", m.content.trim() === "" ? "（空）" : m.content, "");
		if (m.image !== void 0) lines.push(`> 附图：${m.image.width}×${m.image.height}`, "");
		if (m.meme !== void 0) lines.push(`> 配图：${m.meme}`, "");
		if (m.action !== void 0) lines.push(`> 动作：${m.action}`, "");
		if (m.remind !== void 0) lines.push(`> 提醒：${m.remind.title}（${stampOf(m.remind.dueAt)}）`, "");
	}
	await mkdir(dir, { recursive: true });
	await writeFile(file, lines.join("\n"), "utf8");
	deps.log.info(`[dsh-pet] 对话记录已导出 pet=${petId}，${messages.length} 条 → ${file}`);
	return {
		ok: true,
		path: file,
		count: messages.length
	};
}
/**
* 解析 DELETE 的 `?ts=`（可重复）。
*
* @param raws - 查询串里所有 `ts` 的原值。
* @returns 去重后的时间戳数组；任一值不是非负整数时返回 `null`（调用方转 bad-request）。
*/
function parseTsList(raws) {
	const out = [];
	for (const raw of raws) {
		const n = Number(raw);
		if (raw.trim() === "" || !Number.isInteger(n) || n < 0) return null;
		out.push(n);
	}
	return [...new Set(out)];
}
/**
* POST /chat：解析文本与可选图片，交给对话层生成回复。
*
* @param deps - 路由依赖。
* @param petId - 已校验存在的宠物 id。
* @param body - 请求体原文；不是合法 JSON 时回 400。
* @returns 与加入图片前同形的应答：成功只带 `text`（配图时另有 `image`）。
*/
async function postChat(deps, petId, body) {
	let parsed;
	try {
		parsed = JSON.parse(body ?? "null") ?? {};
	} catch {
		return invalidJson();
	}
	const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
	if (!text) return failResult("bad-request", "消息为空");
	if (text.length > 2e3) return failResult("bad-request", "消息过长（限 2000 字）");
	const admitted = await admitImage(deps, parsed.attachment);
	if (!admitted.ok) return admitted.res;
	return okResult(await deps.chatWithPet(petId, text, admitted.ref));
}
/**
* 校验图片入参并交给宿主附件服务落盘。
*
* @param deps - 路由依赖（附件服务经 optionalService 软取，不进 inject）。
* @param raw - 请求体里的 `attachment` 原始值；`undefined` 表示没传图。
* @returns 已落盘的图片引用，或可直接返回的失败应答。
*/
async function admitImage(deps, raw) {
	if (raw === void 0) return { ok: true };
	const parsed = parseImageAttachment(raw);
	if (!parsed.ok) return {
		ok: false,
		res: failResult("bad-request", parsed.message)
	};
	const sink = deps.optionalService("attachments");
	if (typeof sink?.saveImages !== "function") return {
		ok: false,
		res: failResult("bad-request", "当前模式不支持图片（缺少附件服务）")
	};
	const maxBytes = sink.imageLimits?.maxImageBytes;
	if (maxBytes !== void 0 && parsed.bytes.length > maxBytes) return {
		ok: false,
		res: failResult("bad-request", `图片过大（上限 ${maxBytes} 字节，请压缩或降低分辨率）`)
	};
	try {
		const [ref] = await sink.saveImages([{
			data: parsed.bytes,
			mediaType: parsed.mediaType
		}]);
		if (ref === void 0) return {
			ok: false,
			res: failResult("generate-error", "附件服务未返回图片引用")
		};
		return {
			ok: true,
			ref
		};
	} catch (e) {
		return {
			ok: false,
			res: failResult("generate-error", e instanceof Error ? e.message : String(e))
		};
	}
}

//#endregion
//#region src/host/storage-paths.ts
const DESKTOP_APP_NAME = "dsh-pet-electron-helper";
/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关）。 */
const ELECTRON_PATHS_NAME = "electron";
/**
* 桌面端 userData 目录（Electron app.getPath('userData') 的等价推导）。
* 逐平台对齐 Electron 口径：win32 = %APPDATA%\<name>，darwin = ~/Library/Application Support/<name>，
* linux = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>。
*/
function desktopUserDataDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
	if (platform === "darwin") return join(home, "Library", "Application Support", DESKTOP_APP_NAME);
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), DESKTOP_APP_NAME);
}
/**
* Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
* win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，Linux 用 $XDG_CACHE_HOME
* （默认 ~/.cache）。该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
*/
function electronCacheDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), ELECTRON_PATHS_NAME, "Cache");
	if (platform === "darwin") return join(home, "Library", "Caches", ELECTRON_PATHS_NAME);
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), ELECTRON_PATHS_NAME);
}
function storageEntries(input) {
	const items = [
		{
			key: "userData",
			path: input.userDataRoot
		},
		{
			key: "electron",
			path: input.electronDir
		},
		{
			key: "desktopCache",
			path: desktopUserDataDir(input)
		},
		{
			key: "electronCache",
			path: electronCacheDir(input)
		},
		{
			key: "package",
			path: input.packageRoot
		}
	];
	return items.map((it) => ({
		...it,
		exists: existsSync(it.path)
	}));
}
function profileNameFrom(packageRoot$1) {
	const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot$1);
	return m?.[1];
}

//#endregion
//#region src/host/helper/electron.ts
const require = createRequire(import.meta.url);
const packageRoot = PACKAGE_ROOT;
const defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
const DESKTOP_DEBUG_PORT = 0;
function helperLaunchArgs$1(helperPath, debugPort = DESKTOP_DEBUG_PORT) {
	return debugPort > 0 ? ["--remote-debugging-port=" + debugPort, helperPath] : [helperPath];
}
/** 只做基本文件校验：不验证二进制格式，也不实际启动候选。 */
function isNonEmptyFile(path) {
	try {
		const stat$1 = statSync(path);
		return stat$1.isFile() && stat$1.size > 0;
	} catch {
		return false;
	}
}
function resolveElectronPath(candidates = []) {
	const seen = new Set();
	const list = [];
	const push = (value) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		list.push(value);
	};
	for (const value of candidates) push(value);
	if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
	try {
		const resolved = require("electron");
		if (typeof resolved === "string" && resolved) push(resolved);
	} catch {}
	push(defaultElectronExe());
	return list.find(isNonEmptyFile);
}
function hasGraphicalDisplay() {
	if (process.platform !== "linux") return true;
	if (process.env.DSH_PET_DESKTOP_FORCE === "1") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function dshHomeDir() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.DSH_HOME || join(userProfile, ".dsh");
}
/** 当前平台标识（win32 / darwin / linux）。 */
const PLAT = process.platform;
/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台）。 */
const ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
function electronLandingDir() {
	return join(dshHomeDir(), "electron");
}
function defaultElectronExe() {
	return join(electronLandingDir(), ELECTRON_REL);
}
function readElectronVersion(electronExe) {
	try {
		const version = readFileSync(join(dirname(electronExe), "version"), "utf8").trim();
		return /^\d+\.\d+\.\d+/.test(version) ? version : void 0;
	} catch {
		return void 0;
	}
}
async function ensureElectronDownload(options = {}) {
	const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || "43.3.0";
	const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
	const timeoutMs = options.timeoutMs ?? 10 * 60 * 1e3;
	const targetDir = electronLandingDir();
	const exe = defaultElectronExe();
	if (isNonEmptyFile(exe)) return exe;
	const sink = options.logger ?? console;
	const log = (message) => sink.info?.(`[dsh-pet] ${message}`);
	const warn = (message) => sink.warn?.(`[dsh-pet] ${message}`);
	const info = (consoleText, text, done = false) => {
		log(consoleText);
		options.onLog?.({
			text,
			level: "info",
			done
		});
	};
	const fail = (consoleText, text) => {
		warn(consoleText);
		options.onLog?.({
			text,
			level: "warn",
			done: true
		});
	};
	const startedAt = Date.now();
	if (existsSync(exe)) info(`Electron cache is empty or not a regular file: ${exe}`, "Electron 缓存无效，准备重新下载");
	info(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`, `正在下载 Electron ${version}`);
	try {
		mkdirSync(targetDir, { recursive: true });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		let nextLogAt = Date.now() + 3e3;
		try {
			const { downloadArtifact } = await import("@electron/get");
			const zipPath = await downloadArtifact({
				version: `v${version}`,
				artifactName: "electron",
				mirrorOptions: { mirror: mirror.replace(/\/$/, "") + "/" },
				downloadOptions: {
					signal: controller.signal,
					quiet: true,
					getProgressCallback: async (progress) => {
						const now = Date.now();
						if (!progress.total || now < nextLogAt) return;
						nextLogAt = now + 3e3;
						const doneMb = (progress.transferred / 1024 / 1024).toFixed(1);
						const totalMb = (progress.total / 1024 / 1024).toFixed(1);
						const percent = Math.min(100, Math.floor(progress.transferred / progress.total * 100));
						info(`downloading ${doneMb}MB / ${totalMb}MB`, `Electron 下载 ${percent}% · ${doneMb}/${totalMb}MB`);
					}
				}
			});
			const seconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			info(`download complete (${seconds}s), extracting to ${targetDir} ...`, `下载完成（${seconds}s），正在解压`);
			const { default: extract } = await import("@electron-internal/extract-zip");
			await extract(zipPath, { dir: targetDir });
			if (!isNonEmptyFile(exe)) throw new Error(`Electron zip extracted, but ${ELECTRON_REL} is missing, empty or not a regular file`);
			const readySeconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			info(`ready in ${readySeconds}s: ${exe}`, `Electron 就绪（${readySeconds}s），正在启动桌宠`, true);
			return exe;
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		fail(`ensure failed: ${reason}`, `Electron 下载失败：${reason}`);
		warn("desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.");
		return void 0;
	}
}
function defaultLaunch(options = {}) {
	const electronPath = resolveElectronPath([options.electronPath]);
	if (!electronPath) throw new Error("dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.");
	const helperPath = options.helperPath || defaultHelperMain;
	return {
		command: electronPath,
		args: helperLaunchArgs$1(helperPath)
	};
}

//#endregion
//#region src/host/helper/bridge.ts
const BRIDGE_PREFIX = "dsh-pet-bridge:";

//#endregion
//#region src/host/helper/restart.ts
const HELPER_STOP_TIMEOUT_MS = 3e3;
const HELPER_STOP_GRACE_MS = 1e3;
const HELPER_STABLE_MS = 3 * 60 * 1e3;
/** Electron 沙箱初始化失败时的退出码 0x80000003（STATUS_BREAKPOINT）；Node 的两种报法靠 `>>> 0` 归一。 */
const SANDBOX_INIT_FAILED_CODE = 2147483651;
/** 只有在这个时间窗内秒退、且一行输出都没有时，才把退出当成「沙箱起不来」。 */
const SANDBOX_FALLBACK_WINDOW_MS = 5e3;
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
	const MAX = 3e4;
	const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
	return Math.min(raw, MAX);
}
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
	return consecutiveFailures >= limit;
}
function helperRunIsStable(elapsedMs) {
	return elapsedMs >= HELPER_STABLE_MS;
}
/** Windows NTSTATUS 退出码 → 中文短语；只收「进程被系统当场终止」这一类，其余不收录。 */
const WINDOWS_EXIT_MEANINGS = {
	3221225477: "访问违例",
	[SANDBOX_INIT_FAILED_CODE]: "断点（沙箱初始化失败）",
	3221225781: "缺少 DLL",
	3221225794: "DLL 初始化失败"
};
/**
* 把子进程退出码翻成一句人话。
*
* 只认 Windows 的 NTSTATUS 形态（无符号值 ≥ 0x80000000）：POSIX 退出码只有 0–255，不会撞上这张表。
* 入参同时认 Node 的两种报法——`3221225477` 与 `-1073741819` 指向同一个 `0xC0000005`。
* @param code - 子进程退出码；null 表示被信号终止。
* @returns 中文短语；未收录或 code 为 null 时返回 undefined。
*/
function explainExitCode(code) {
	if (code === null) return void 0;
	return WINDOWS_EXIT_MEANINGS[code >>> 0];
}
function describeExit(code, signal) {
	return `code=${String(code)}${describeCodeDetail(code)}, signal=${String(signal)}`;
}
/** 退出码的括号说明：形态像 NTSTATUS 才补十六进制，含义未收录时只留十六进制。 */
function describeCodeDetail(code) {
	if (code === null) return "";
	const unsigned = code >>> 0;
	if (unsigned < 2147483648) return "";
	const hex = `0x${unsigned.toString(16).toUpperCase()}`;
	const meaning = explainExitCode(code);
	return ` (${meaning ? `${hex} ${meaning}` : hex})`;
}
function crashLoopAdvice(platform) {
	const raise = "或设 DSH_PET_RESTART_MAX_FAILURES 提高重试上限后重启。";
	if (platform === "win32") return `换一个 Electron 版本（删掉日志里 electron= 指向的目录，用 DSH_PET_ELECTRON_VERSION 指定可用版本后重启），或用 DSH_PET_ELECTRON_PATH 指向本机能开窗的 electron.exe；${raise}`;
	if (platform === "linux") return `确认有可用显示环境（DISPLAY / WAYLAND_DISPLAY，无显示时用 Xvfb 并设 DSH_PET_DESKTOP_FORCE=1）；${raise}`;
	return `用 DSH_PET_ELECTRON_PATH 指向本机能开窗的 Electron；${raise}`;
}
function shouldFallbackToNoSandbox(input) {
	if (input.alreadyApplied || input.customCommand || input.sandboxOptOut) return false;
	if (input.code === null || input.code >>> 0 !== SANDBOX_INIT_FAILED_CODE) return false;
	if (input.sawOutput) return false;
	return input.ranMs < SANDBOX_FALLBACK_WINDOW_MS;
}
const RESTART_BASE_MS_DEFAULT = 750;
const RESTART_MAX_FAILURES_DEFAULT = 12;
function envPositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function waitForChildExit(child, timeoutMs, onTimeout) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve$1) => {
		let giveUpTimer;
		const done = () => {
			clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			child.removeListener("exit", done);
			resolve$1();
		};
		const killTimer = setTimeout(() => {
			onTimeout();
			giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
			giveUpTimer.unref?.();
		}, timeoutMs);
		killTimer.unref?.();
		child.once("exit", done);
	});
}

//#endregion
//#region src/host/helper/child.ts
/** 日志里的运行时身份：` · electron=<路径> (<版本>)`；版本读不到时只留路径。 */
function electronIdentity(electronExe) {
	const version = readElectronVersion(electronExe);
	return ` · electron=${electronExe}${version ? ` (${version})` : ""}`;
}
function helperSpawnEnv(hostPid, extra) {
	const env = {
		...process.env,
		DSH_PET_HOST_PID: String(hostPid),
		...extra
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
function helperLaunchArgs(baseArgs, opts) {
	return opts.sandboxFallback && !opts.customCommand ? ["--no-sandbox", ...baseArgs] : [...baseArgs];
}
var HelperProcess = class {
	constructor(options = {}, logger = console) {
		this.options = options;
		this.logger = logger;
		this.child = void 0;
		this.stopping = false;
		this.restartTimer = void 0;
		this.restartFailures = 0;
		this.lastStartAt = 0;
		this.stdoutBuffer = "";
		this.launchIdentity = "";
		this.hasSandboxFallbackApplied = false;
		this.hasChildOutput = false;
	}
	/** 拉起子进程；已有子进程在跑或正在停止时直接返回现有句柄。 */
	start() {
		if (this.child || this.stopping) return this.child;
		this.lastStartAt = Date.now();
		const helperPath = this.options.helperPath || defaultHelperMain;
		const launch = this.options.command ? {
			command: this.options.command,
			args: this.options.args || [helperPath]
		} : defaultLaunch(this.options);
		const command = launch.command;
		const args = helperLaunchArgs(this.options.args || launch.args, {
			sandboxFallback: this.hasSandboxFallbackApplied,
			customCommand: Boolean(this.options.command)
		});
		this.hasChildOutput = false;
		this.launchIdentity = electronIdentity(command);
		const cwd = this.options.cwd || dshHomeDir();
		mkdirSync(cwd, { recursive: true });
		const child = spawn(command, args, {
			cwd,
			env: helperSpawnEnv(process.pid, this.options.env),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		const stableTimer = setTimeout(() => {
			if (this.child === child && !this.stopping) this.logger.info?.(`dsh-pet desktop helper stable for ${HELPER_STABLE_MS / 6e4}m${this.launchIdentity}`);
		}, HELPER_STABLE_MS);
		stableTimer.unref?.();
		child.once("error", (error) => {
			this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}${this.launchIdentity}`);
			if (child.pid === void 0 && this.child === child) {
				this.child = void 0;
				clearTimeout(stableTimer);
				this.scheduleRestart();
			}
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			clearTimeout(stableTimer);
			if (!this.stopping) {
				if (this.applySandboxFallback(code)) return;
				this.logger.warn?.(`dsh-pet desktop helper exited (${describeExit(code, signal)})${this.launchIdentity}; restarting`);
				this.scheduleRestart();
			}
		});
		child.stdout.on("data", (chunk) => {
			this.hasChildOutput = true;
			this.onStdoutChunk(String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			const line = String(chunk).trim();
			if (line) {
				this.hasChildOutput = true;
				this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
			}
		});
		child.stdin?.on("error", () => {});
		return child;
	}
	/** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行。 */
	onStdoutChunk(chunk) {
		this.stdoutBuffer += chunk;
		let nl;
		while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith(BRIDGE_PREFIX)) {
				this.handleBridgeLine(trimmed);
				continue;
			}
			this.logger.debug?.(`[dsh-pet desktop helper] ${trimmed}`);
		}
	}
	/** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
	*  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
	async handleBridgeLine(line) {
		const child = this.child;
		if (!child?.stdin || !this.options.bridgeHandler) return;
		let req;
		try {
			req = JSON.parse(line.slice(BRIDGE_PREFIX.length));
		} catch {
			this.logger.warn?.("[dsh-pet desktop helper] bridge 协议行非法，已忽略");
			return;
		}
		if (typeof req.id !== "number") return;
		try {
			const resp = await this.options.bridgeHandler(req);
			this.sendBridgeResponse(req, resp);
		} catch (e) {
			this.sendBridgeResponse(req, {
				id: req.id,
				status: 500,
				contentType: "application/json; charset=utf-8",
				body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` })
			});
		}
	}
	/** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容）。 */
	sendBridgeResponse(req, resp) {
		const cb = typeof req.cb === "string" && /^https?:[/][/]/.test(req.cb) ? req.cb : "";
		if (cb) {
			fetch(cb, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(resp)
			}).catch(() => {});
			return;
		}
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed) return;
		try {
			child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + "\n");
		} catch {}
	}
	/** 停止 helper：发 SIGTERM 即返回，不等它退出。宿主退出 / 插件卸载路径用它——宿主马上就没了
	*  （Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底）。
	*  停止后要立刻重启的场景必须用 stopAndWait()，否则新旧进程会短暂重叠。 */
	stop(reason = "plugin-disposed") {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
		const child = this.child;
		if (!child) return;
		child.kill();
	}
	/**
	* 停止 helper 并等它真正退出：只发一次 SIGTERM 就 spawn 新进程是不行的——Electron 收到 SIGTERM 后
	* 关窗、销毁 GPU/动画合成器是异步的（几百 ms 起），旧窗口（旧大小）还没消失、新窗口已经画出来，
	* 桌面上会短暂出现「两只宠物」。所以：① 先置 `stopping`（由 stop() 完成），守护逻辑不得把这次主动
	* 停止误判成崩溃去自动重启；② 只等 `exit` 不等 `close`——stdio 管道关闭远早于进程真正退出；③ 超时
	* （默认 3s）升级 SIGKILL，再给 1s 宽限，仍未退出就放弃等待，配置保存绝不能被无限挂住。
	*/
	async stopAndWait(reason = "plugin-disposed", timeoutMs = HELPER_STOP_TIMEOUT_MS) {
		this.stop(reason);
		const child = this.child;
		if (!child) return;
		await waitForChildExit(child, timeoutMs, () => {
			this.logger.warn?.(`dsh-pet desktop helper 未在 ${timeoutMs}ms 内退出，升级 SIGKILL（${reason}）`);
			try {
				child.kill("SIGKILL");
			} catch {}
		});
	}
	/** 沙箱初始化失败的特殊崩溃 → 改用 `--no-sandbox` 立刻重试一次，不计入退避与熔断额度。 */
	applySandboxFallback(code) {
		const applied = shouldFallbackToNoSandbox({
			code,
			sawOutput: this.hasChildOutput,
			ranMs: Date.now() - this.lastStartAt,
			alreadyApplied: this.hasSandboxFallbackApplied,
			customCommand: Boolean(this.options.command),
			sandboxOptOut: process.env.DSH_PET_GPU_SANDBOX === "1"
		});
		if (!applied) return false;
		this.hasSandboxFallbackApplied = true;
		this.logger.warn?.(`dsh-pet desktop helper 因 Chromium 沙箱初始化失败而秒退（${describeExit(code, null)}），改用 --no-sandbox 重试一次${this.launchIdentity}`);
		this.start();
		return true;
	}
	scheduleRestart() {
		if (this.restartTimer || this.stopping) return;
		if (helperRunIsStable(Date.now() - this.lastStartAt)) this.restartFailures = 0;
		else this.restartFailures += 1;
		if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
			this.logger.error?.(`dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, no more restarts${this.launchIdentity} · 建议：${crashLoopAdvice(process.platform)}`);
			return;
		}
		const base = this.resolveRestartBaseMs();
		const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
		this.logger.warn?.(`dsh-pet desktop helper exited; restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}
	/** 退避基值：DSH_PET_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
	resolveRestartBaseMs() {
		return envPositiveInt(process.env.DSH_PET_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
	}
	/** 熔断阈值：DSH_PET_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
	resolveMaxFailures() {
		return envPositiveInt(process.env.DSH_PET_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
	}
};

//#endregion
//#region src/host/todo/types.ts
const TODO_FILE_VERSION = 1;
const TODO_TEXT_MAX = 200;
const TODO_BODY_MAX_BYTES = 16 * 1024;
function normalizeTodoText(raw) {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (text === "") return null;
	if (Array.from(text).length > TODO_TEXT_MAX) return null;
	return text;
}
function normalizeTodoDueAt(raw) {
	if (raw === null || raw === void 0) return {
		ok: true,
		value: null
	};
	if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false };
	if (Math.abs(raw) > 864e13) return { ok: false };
	return {
		ok: true,
		value: raw
	};
}
/** 读一个有限数字，非法时回落。 */
function finiteOr(raw, fallback) {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}
function parseTodoRecord(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw;
	if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id)) return null;
	const text = normalizeTodoText(record.text);
	if (text === null) return null;
	const due = normalizeTodoDueAt(record.dueAt);
	if (!due.ok) return null;
	const createdAt = finiteOr(record.createdAt, 0);
	const updatedAt = finiteOr(record.updatedAt, createdAt);
	const done = record.done === true;
	const completedAt = done ? finiteOr(record.completedAt, updatedAt) : null;
	const lastRemindedAt = typeof record.lastRemindedAt === "number" && Number.isFinite(record.lastRemindedAt) ? record.lastRemindedAt : null;
	return {
		id: record.id,
		text,
		dueAt: due.value,
		done,
		createdAt,
		updatedAt,
		completedAt,
		lastRemindedAt
	};
}
function parseTodoFile(raw) {
	const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const list = Array.isArray(root.todos) ? root.todos : [];
	const out = [];
	const seen = new Set();
	for (const item of list) {
		const todo = parseTodoRecord(item);
		if (todo === null || seen.has(todo.id)) continue;
		seen.add(todo.id);
		out.push(todo);
	}
	return out;
}
function cloneTodo(todo) {
	return { ...todo };
}
function sortTodos(list) {
	return [...list].sort((a, b) => {
		if (a.done !== b.done) return a.done ? 1 : -1;
		if (a.done) return (b.completedAt ?? 0) - (a.completedAt ?? 0);
		const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
		const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
		if (aDue !== bDue) return aDue - bDue;
		return a.createdAt - b.createdAt;
	});
}

//#endregion
//#region src/host/todo/store.ts
const TODO_FILE_NAME = "todos.json";
/** 异常 → 一行可读原因（日志用，不外泄给 HTTP 响应）。 */
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
var TodoStore = class {
	constructor(options) {
		this.file = options.file;
		this.log = options.log;
		this.now = options.now ?? (() => Date.now());
		this.queue = Promise.resolve();
		this.cached = null;
		this.seq = 0;
	}
	/** 全部待办（排序后的副本）。 */
	list() {
		return this.run(async () => {
			await this.ensureLoaded();
			return sortTodos(this.cached ?? []).map(cloneTodo);
		});
	}
	/**
	* 新建一条。
	*
	* id 由时间戳 + 进程内序号生成：重启后时间戳不同，旧 id 不会撞。
	*
	* @param input - 已校验的正文与到期时刻。
	* @returns 落盘成功后的记录副本。
	*/
	create(input) {
		return this.run(async () => {
			await this.ensureLoaded();
			const at = this.now();
			this.seq += 1;
			const todo = {
				id: `todo-${at.toString(36)}-${this.seq.toString(36)}`,
				text: input.text,
				dueAt: input.dueAt,
				done: false,
				createdAt: at,
				updatedAt: at,
				completedAt: null,
				lastRemindedAt: null
			};
			await this.persist([...this.cached ?? [], todo]);
			return cloneTodo(todo);
		});
	}
	/**
	* 更新一条。
	*
	* 改期限或重新打开都会清空 `lastRemindedAt`：提醒按新的到期时刻重新排期。
	*
	* @returns 更新后的记录；id 不存在返回 null。
	*/
	update(id, patch) {
		return this.run(async () => {
			await this.ensureLoaded();
			const list = this.cached ?? [];
			const index = list.findIndex((todo) => todo.id === id);
			if (index < 0) return null;
			const prev = list[index];
			const at = this.now();
			const next = {
				...prev,
				updatedAt: at
			};
			if (patch.text !== void 0) next.text = patch.text;
			if (patch.dueAt !== void 0) {
				next.dueAt = patch.dueAt;
				next.lastRemindedAt = null;
			}
			if (patch.done !== void 0) {
				next.done = patch.done;
				next.completedAt = patch.done ? prev.completedAt ?? at : null;
				if (!patch.done) next.lastRemindedAt = null;
			}
			const updated = [...list];
			updated[index] = next;
			await this.persist(updated);
			return cloneTodo(next);
		});
	}
	/**
	* 删除一条。
	*
	* @returns 删掉的条数；0 表示本来就没有（幂等，不当成错误）。
	*/
	remove(id) {
		return this.run(async () => {
			await this.ensureLoaded();
			const list = this.cached ?? [];
			const next = list.filter((todo) => todo.id !== id);
			if (next.length === list.length) return 0;
			await this.persist(next);
			return 1;
		});
	}
	/** 记下一次提醒时刻：只动 `lastRemindedAt`，不推进 `updatedAt`（那不是用户修改）。 */
	markReminded(id, at) {
		return this.run(async () => {
			await this.ensureLoaded();
			const list = this.cached ?? [];
			const index = list.findIndex((todo) => todo.id === id);
			if (index < 0) return;
			const next = [...list];
			next[index] = {
				...list[index],
				lastRemindedAt: at
			};
			await this.persist(next);
		});
	}
	/** 队列：上一个任务结束后执行下一个；失败不影响后续任务。 */
	run(task) {
		const next = this.queue.then(task, task);
		this.queue = next.then(() => void 0, () => void 0);
		return next;
	}
	async ensureLoaded() {
		if (this.cached !== null) return;
		this.cached = await this.readDisk();
	}
	async readDisk() {
		let raw;
		try {
			raw = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") this.log.warn?.(`[dsh-pet] 待办文件读取失败，按空清单继续：${messageOf$1(error)}`);
			return [];
		}
		try {
			return parseTodoFile(JSON.parse(raw));
		} catch (error) {
			this.log.warn?.(`[dsh-pet] 待办文件解析失败，按空清单继续：${messageOf$1(error)}`);
			return [];
		}
	}
	/** 原子写：临时文件写完再 rename，进程中途退出不会留下半个 JSON。 */
	async persist(next) {
		const file = {
			version: TODO_FILE_VERSION,
			todos: [...next]
		};
		await mkdir(dirname(this.file), { recursive: true });
		const temp = this.file + ".tmp";
		await writeFile(temp, JSON.stringify(file, null, 2) + "\n", "utf8");
		await rename(temp, this.file);
		this.cached = [...next];
	}
};

//#endregion
//#region src/host/routes/config/save.ts
async function saveConfigRoute(deps, input) {
	if (input.method === "PUT") return saveUserLayer(deps, input);
	if (input.method === "POST") return syncFromDefault(deps);
	return methodNotAllowed();
}
/** 白名单重建用户层后写盘，响应体是保存后的成品聚合。 */
async function saveUserLayer(deps, input) {
	const { configPaths, ctx, requestRestart, userConfigPath, userRoot } = deps;
	let parsed;
	try {
		parsed = JSON.parse(input.body ?? "");
	} catch {
		return invalidJson();
	}
	try {
		const existing = readUserConfig(configPaths);
		const clean = saveUserConfig(parsed, existing);
		if (!clean) return failResult("bad-request", "invalid pet config: expected { pets:[{name?,id,size,sizePercent?,balanceEnabled,display,position:{corner,marginX,marginY}}] }（id 为非空字符串且去除首尾空白后唯一；sizePercent 可选，不小于 1 的数字；display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled / chatAnimationEnabled / trayEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）");
		if (input.url.searchParams.get("force") !== "1" && userConfigUnparsable(configPaths)) return failResult("user-config-unparsable", "用户配置无法解析，需确认后重建", {
			needConfirm: true,
			userFile: userConfigPath
		});
		await mkdir(userRoot, { recursive: true });
		await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
		requestRestart();
		return okResult(readAllConfig(configPaths));
	} catch (e) {
		ctx.logger?.warn?.(`[dsh-pet] config save failed: ${e instanceof Error ? e.message : String(e)}`);
		return failResult("generate-error", "failed to save config");
	}
}
/**
* 把内置默认配置（`assets/config.jsonc` 原文，含注释）整份写入用户配置。
*
* 既是「恢复默认」（合并结果 = 内置默认），又给用户留下一份可直接编辑的完整配置，
* 不必再自己从包内复制一份（见 ../config 的 syncUserConfigFromDefault）。
*/
function syncFromDefault(deps) {
	const { configPaths, requestRestart } = deps;
	try {
		syncUserConfigFromDefault(configPaths);
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
	requestRestart();
	return okResult(readAllConfig(configPaths));
}

//#endregion
//#region src/host/routes/config/layer.ts
function resolveConfigLayer(deps, entry) {
	if (entry === "main") return {
		ok: true,
		layer: {
			path: deps.userConfigPath,
			dir: deps.userRoot,
			existing: readUserConfig(deps.configPaths)
		}
	};
	const file = readPetConfigEntry(deps.configPaths, entry);
	if (!file) return { ok: false };
	return {
		ok: true,
		layer: {
			path: file.path,
			dir: deps.petConfigDir,
			existing: file.raw
		}
	};
}

//#endregion
//#region src/host/routes/config/display.ts
async function setPetDisplay(deps, input) {
	if (input.method !== "POST") return methodNotAllowed();
	let payload;
	try {
		payload = JSON.parse(input.body ?? "");
	} catch {
		return invalidJson();
	}
	const petId = typeof payload.id === "string" ? payload.id.trim() : "";
	const nextDisplay = String(payload.display ?? "");
	if (!petId) return failResult("pet-required", "pet 必填：要指定操作哪只桌宠");
	if (!PET_DISPLAY_SET.has(nextDisplay)) return failResult("bad-request", `display 必须是 web / desktop / both / none：${nextDisplay}`);
	let merged;
	try {
		merged = readAllConfig(deps.configPaths);
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
	const hit = findPetInstance(merged, petId);
	if (!hit) return failResult("unknown-pet", `没有这只桌宠：${petId}`);
	const resolved = resolveConfigLayer(deps, hit.entry);
	if (!resolved.ok) return failResult("generate-error", `宠物条目配置文件找不到：${hit.entry}`);
	const layer = resolved.layer;
	const layerPets = Array.isArray(hit.conf.pets) ? hit.conf.pets : [];
	const pets = layerPets.map((p) => String(p.id) === petId ? {
		...p,
		display: nextDisplay
	} : p);
	const clean = saveUserConfig({ pets }, layer.existing);
	if (!clean) return failResult("bad-request", "宠物配置非法");
	try {
		await mkdir(layer.dir, { recursive: true });
		await writeFile(layer.path, JSON.stringify(clean, null, 2), "utf8");
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
	deps.state.writeSection("config", {});
	if (nextDisplay === "none") deps.lock.release({
		petId,
		force: true
	});
	deps.requestRestart();
	return okResult(readAllConfig(deps.configPaths));
}

//#endregion
//#region src/host/routes/config/entry.ts
/** main 条目连同全局字段走 PUT /config，本端点只收「种类」层。 */
const MAIN_ENTRY = "main";
/** 实例数组非法时的统一文案：saveUserConfig 只回 null，细节必须在这里讲清。 */
const INVALID_PETS = "pets 非法：必须是该种类的全部实例（至少 1 只），每只 id 唯一，size / balanceEnabled / display / position 齐全合法";
/**
* 找出与其它条目冲突的实例 id。
*
* 合并后 id 跨条目全局唯一，重复的实例会被静默跳过（只告警一次）；不在写盘前拦住，
* 用户看到的是「保存成功、宠物消失」。
*
* @param deps - 路由层依赖（路径集）。
* @param entry - 本次要写的条目；它自己的旧 id 不算冲突。
* @param pets - 已过白名单的实例数组。
* @returns 冲突描述列表；空数组表示没有冲突。
*/
function conflictingIds(deps, entry, pets) {
	const merged = readAllConfig(deps.configPaths);
	const taken = new Map();
	for (const [key, conf] of Object.entries(merged)) {
		if (key === entry) continue;
		const list = Array.isArray(conf?.pets) ? conf.pets : [];
		for (const pet of list) taken.set(String(pet.id), key);
	}
	const out = [];
	for (const pet of pets) {
		const id = String(pet.id);
		const owner = taken.get(id);
		if (owner !== void 0) out.push(`${id}（已被「${owner}」占用）`);
	}
	return out;
}
async function savePetLayer(deps, input) {
	if (input.method !== "POST") return methodNotAllowed();
	let payload;
	try {
		payload = JSON.parse(input.body ?? "");
	} catch {
		return invalidJson();
	}
	const entry = typeof payload.entry === "string" ? payload.entry.trim() : "";
	if (!entry) return failResult("bad-request", "entry 必填：要写哪个种类（pet/<名>-config.json 的文件名前缀）");
	if (!isValidPetId(entry)) return failResult("bad-request", `entry 不能当路径片段用：${entry}`);
	if (entry === MAIN_ENTRY) return failResult("bad-request", "main 条目请用 PUT /config：它还要带全局字段");
	const pets = payload.pets;
	if (!Array.isArray(pets) || pets.length === 0) return failResult("bad-request", INVALID_PETS);
	const resolved = resolveConfigLayer(deps, entry);
	if (!resolved.ok) return failResult("unknown-entry", `没有这个种类：${entry}`);
	const layer = resolved.layer;
	const clean = saveUserConfig({ pets }, layer.existing);
	if (!clean) return failResult("bad-request", INVALID_PETS);
	const instances = clean.pets;
	let conflicts;
	try {
		conflicts = conflictingIds(deps, entry, instances);
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
	if (conflicts.length > 0) return failResult("bad-request", "宠物 id 与其它种类冲突：" + conflicts.join("、"));
	try {
		await mkdir(layer.dir, { recursive: true });
		await writeFile(layer.path, JSON.stringify(clean, null, 2), "utf8");
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
	deps.state.writeSection("config", {});
	for (const pet of instances) if (pet.display === "none") deps.lock.release({
		petId: String(pet.id),
		force: true
	});
	deps.requestRestart();
	return okResult(readAllConfig(deps.configPaths));
}

//#endregion
//#region src/host/routes/config/corner.ts
const CORNER_CYCLE = [
	"top-left",
	"top-right",
	"bottom-right",
	"bottom-left"
];
/** 判断一个字符串是不是合法角落。 */
function isCorner(value) {
	return typeof value === "string" && CORNER_CYCLE.includes(value);
}
/**
* 找这只宠物属于哪个条目（`main` 或某个文件宠物）。
*
* 用合并结果反查：id 跨条目全局唯一，命中哪一条就是它的家。
*
* @param deps - 路由层依赖（路径集）。
* @param petId - 宠物 id。
* @returns 条目名；找不到给 null。
*/
function entryOfPet(deps, petId) {
	const merged = readAllConfig(deps.configPaths);
	for (const [key, conf] of Object.entries(merged)) {
		const list = Array.isArray(conf?.pets) ? conf.pets : [];
		if (list.some((pet) => String(pet.id) === petId)) return key;
	}
	return null;
}
async function savePetCorner(deps, input) {
	if (input.method !== "POST") return methodNotAllowed();
	let payload;
	try {
		payload = JSON.parse(input.body ?? "");
	} catch {
		return invalidJson();
	}
	const petId = typeof payload.pet === "string" ? payload.pet.trim() : "";
	if (petId === "") return failResult("bad-request", "pet 必填：要挪哪只宠物");
	if (!isCorner(payload.corner)) return failResult("bad-request", `corner 必须是 ${CORNER_CYCLE.join(" / ")} 之一`);
	const entry = entryOfPet(deps, petId);
	if (entry === null) return failResult("bad-request", `没有这只宠物：${petId}`);
	const resolved = resolveConfigLayer(deps, entry);
	if (!resolved.ok) return failResult("unknown-entry", `没有这个种类：${entry}`);
	const layer = resolved.layer;
	const disk = entry === "main" ? readUserConfig(deps.configPaths) : layer.existing;
	if (disk === void 0) return failResult("bad-request", `配置层读不出来：${layer.path}`);
	const list = Array.isArray(disk.pets) ? disk.pets : [];
	const hit = list.find((pet) => String(pet.id) === petId);
	if (hit === void 0) return failResult("bad-request", `配置里没有这只宠物的落盘记录：${petId}`);
	const position = typeof hit.position === "object" && hit.position !== null ? hit.position : {};
	hit.position = {
		...position,
		corner: payload.corner
	};
	try {
		await mkdir(layer.dir, { recursive: true });
		await writeFile(layer.path, JSON.stringify(disk, null, 2), "utf8");
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
	deps.state.writeSection("config", {});
	return okResult(readAllConfig(deps.configPaths));
}

//#endregion
//#region src/host/routes/config/index.ts
async function handleConfigRoutes(deps, input) {
	if (input.rest === "config") return input.method === "GET" ? getConfig(deps) : saveConfigRoute(deps, input);
	if (input.rest === "pet-display") return setPetDisplay(deps, input);
	if (input.rest === "pet-config") return savePetLayer(deps, input);
	if (input.rest === "corner") return savePetCorner(deps, input);
	if (input.rest === "config/meta") return getMeta(deps);
	return void 0;
}
/** 合并成品：唯一配置入口，浏览器 / 桌面 / 设置页直接消费，无需任何校验或兜底。 */
function getConfig(deps) {
	try {
		return okResult(readAllConfig(deps.configPaths), { "cache-control": "no-cache, no-store" });
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
}
/** 路径与存储清单：只读环境与路径，不做业务判断，因此没有失败实体。 */
function getMeta(deps) {
	const { home, log, memesUserRoot, thumbUserRoot, userConfigPath, userRoot } = deps;
	return okResult({
		user: userConfigPath,
		default: join(PACKAGE_ROOT, "assets", "config.jsonc"),
		animations: thumbUserRoot,
		memes: memesUserRoot,
		home: {
			dir: home.dir,
			defaultDir: home.defaultDir,
			pointerFile: home.pointerFile,
			source: home.source,
			envVar: home.envVar
		},
		todos: join(userRoot, TODO_FILE_NAME),
		logs: log.file,
		storage: storageEntries({
			userDataRoot: userRoot,
			electronDir: electronLandingDir(),
			home: homedir(),
			packageRoot: PACKAGE_ROOT
		}),
		profile: profileNameFrom(PACKAGE_ROOT) ?? ""
	});
}

//#endregion
//#region src/host/routes/desktop.ts
async function handleDesktopRoutes(deps, input) {
	const { log, optionalService, requestRestart } = deps;
	const { method, rest } = input;
	if (rest === "reload") {
		if (method !== "POST") return methodNotAllowed();
		requestRestart();
		return okResult({ reloading: true });
	}
	if (rest === "quit") {
		const quit = optionalService("shutdownApp");
		const canQuit = typeof quit === "function";
		if (method === "GET") return okResult({ canQuit });
		if (method !== "POST") return methodNotAllowed();
		if (!canQuit) return failResult("unsupported", "宿主未提供退出能力（DSH 内请关闭桌面模式）");
		setImmediate(() => {
			try {
				quit("托盘退出");
			} catch (e) {
				log.warn(`[dsh-pet] 托盘退出失败：${e instanceof Error ? e.message : String(e)}`);
			}
		});
		return okResult({ ok: true });
	}
	return void 0;
}

//#endregion
//#region src/host/routes/home.ts
async function handleHomeRoutes(deps, input) {
	if (input.rest === "home") {
		const { home } = deps;
		if (input.method === "GET") return okResult({
			...home,
			restartRequired: false
		}, { "cache-control": "no-cache, no-store" });
		if (input.method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(input.body ?? "null");
		} catch {
			return invalidJson();
		}
		const raw = parsed?.dir;
		if (raw !== void 0 && raw !== null && typeof raw !== "string") return failResult("bad-request", "dir 必须是字符串或 null");
		try {
			const next = setPetHome(typeof raw === "string" ? raw : null, home.dir);
			return okResult({
				...next,
				restartRequired: true
			});
		} catch (e) {
			return failResult("bad-request", e instanceof Error ? e.message : String(e));
		}
	}
	return void 0;
}

//#endregion
//#region src/host/surface.ts
const SURFACES = [
	"web",
	"desktop",
	"both",
	"any"
];
const SURFACE_TEXT = "surface 必填：web / desktop / both / any";
function normalizeSurface(v) {
	return typeof v === "string" && SURFACES.includes(v) ? v : null;
}
function displayCovers(want, display) {
	switch (want) {
		case "any": return display === "web" || display === "desktop" || display === "both" || display === "none";
		case "web": return display === "web" || display === "both";
		case "desktop": return display === "desktop" || display === "both";
		case "both": return display === "both";
	}
}
function isDisplayed(display) {
	return displayCovers("web", display) || displayCovers("desktop", display);
}
function pickVoiceSurface(display) {
	if (displayCovers("desktop", display)) return "desktop";
	if (displayCovers("web", display)) return "web";
	return null;
}
function voiceTargetOfSurface(want) {
	return want === "web" || want === "desktop" ? want : void 0;
}

//#endregion
//#region src/host/memes.ts
function readMemePool(memes, dirs) {
	if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
	if (dirs.length === 0) return [];
	const out = [];
	for (const [name$1, desc] of Object.entries(memes)) {
		const text = typeof desc === "string" ? desc.trim() : "";
		if (!name$1 || !text) continue;
		if (!dirs.some((dir) => existsSync(join(dir, name$1 + ".png")))) continue;
		out.push({
			name: name$1,
			desc: text
		});
	}
	return out;
}
function pickMeme(pool$1, random = Math.random) {
	if (pool$1.length === 0) return void 0;
	const idx = Math.floor(random() * pool$1.length) % pool$1.length;
	return pool$1[idx];
}
function matchMeme(pool$1, name$1) {
	const key = String(name$1 ?? "").trim();
	return key ? pool$1.find((m) => m.name === key) : void 0;
}
/** 配图选择标记：`[图:名称]` 附在回复末尾（容忍全角冒号与前后空白）。 */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
function extractChatImage(text, pool$1) {
	const m = IMG_TAG.exec(text);
	if (!m) return { text };
	const hit = matchMeme(pool$1, m[1] ?? "");
	const body = text.slice(0, m.index).trim();
	if (!hit || !body) return { text };
	return {
		text: body,
		image: hit.name
	};
}
function memeCatalog(pool$1) {
	return pool$1.map((m) => "- " + m.name + "：" + m.desc).join("\n");
}
function limitPool(pool$1, limit) {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return pool$1;
	return pool$1.slice(0, n);
}

//#endregion
//#region src/host/anim.ts
/** 配置里的池子收窄：非数组、非字符串项一律丢弃。 */
function strings$1(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
}
/** 朝向收窄：只认两个字面量，其余（大小写、空白、非字符串）一律不算。 */
const petFacing = (v) => v === "left" || v === "right" ? v : null;
function animationNames(animations) {
	const a = animations && typeof animations === "object" ? animations : {};
	const out = [];
	const push = (names) => {
		for (const n of names) if (!out.includes(n)) out.push(n);
	};
	push(strings$1(a.idle));
	push(strings$1(a.turn));
	push(strings$1(a.drag));
	push(strings$1(a.clicks));
	const moves = a.moves && typeof a.moves === "object" ? a.moves : {};
	push(Array.isArray(moves.actions) ? moves.actions.map((m) => m && typeof m === "object" ? m.name : void 0).filter((x) => typeof x === "string" && x !== "") : []);
	if (Array.isArray(a.categories)) {
		for (const c of a.categories) if (c && typeof c === "object") push(strings$1(c.actions));
	}
	const events = a.events && typeof a.events === "object" ? a.events : {};
	for (const key of Object.keys(events)) {
		const pool$1 = events[key];
		if (!Array.isArray(pool$1)) continue;
		const names = [];
		for (const slot of pool$1) if (typeof slot === "string") names.push(slot);
		else names.push(...strings$1(slot));
		push(names);
	}
	return out;
}
function normalizeHttpUrl(v) {
	if (typeof v !== "string") return null;
	const raw = v.trim();
	if (!raw) return null;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	return raw;
}
function decideAnim(args) {
	const { cfg, requested } = args;
	const name$1 = typeof args.name === "string" ? args.name.trim() : "";
	const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
	if (name$1 && rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "name 与 url 只能给一个"
	};
	if (!name$1 && !rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "name 或 url 必须给一个"
	};
	let facing;
	if (args.facing !== void 0 && args.facing !== null) {
		const f = petFacing(args.facing);
		if (f === null) return {
			ok: false,
			reason: "bad-request",
			message: "facing 必须是 left / right"
		};
		facing = f;
	}
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	const found = findPetInstance(cfg, petId);
	if (!found) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	if (rawUrl) {
		const url = normalizeHttpUrl(rawUrl);
		if (url === null) return {
			ok: false,
			reason: "bad-request",
			message: "url 必须是 http/https 的完整地址"
		};
		return {
			ok: true,
			petId,
			url,
			facing
		};
	}
	const allowed = animationNames(found.conf.animations);
	if (!allowed.includes(name$1)) return {
		ok: false,
		reason: "unknown-animation",
		message: "没有这个动画：" + name$1
	};
	return {
		ok: true,
		petId,
		name: name$1,
		facing
	};
}

//#endregion
//#region src/host/broadcast.ts
/** 气泡默认显示时长（ms）——与两端消费侧的常量同值（host 不得 import src/shared，只能各写一份）。
*  它只用于把缺省解析成显式值写进叶子，让 /state 里能看到实际生效的时长。 */
const DEFAULT_BUBBLE_DURATION_MS = 10 * 1e3;
function normalizeBroadcastText(text) {
	return typeof text === "string" ? text.trim() : "";
}
function normalizeBroadcastDuration(duration) {
	if (duration === void 0 || duration === null) return DEFAULT_BUBBLE_DURATION_MS;
	if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
	return duration;
}
function normalizeBroadcastAnim(anim) {
	return anim !== false;
}
/**
* `?pet=` → 实际落点（与 ./anim、./motion-cue 同一口径）：必填且必须真实存在。
*
* 两种失败分开报（绝不默认退到列表第一只）：没给 → pet-required，给了但配置里没有 → unknown-pet。
*/
function resolvePetId(cfg, requested) {
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	const found = findPetInstance(cfg, petId);
	if (!found) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	return {
		ok: true,
		petId,
		entry: found.entry,
		conf: found.conf
	};
}
function decideBroadcast(args) {
	const { cfg, requested, memeDirs } = args;
	const text = normalizeBroadcastText(args.text);
	if (!text) return {
		ok: false,
		reason: "bad-request",
		message: "text 为空"
	};
	const who = resolvePetId(cfg, requested);
	if (!who.ok) return {
		ok: false,
		reason: who.reason,
		message: who.message
	};
	const petId = who.petId;
	const rawImage = typeof args.image === "string" ? args.image.trim() : "";
	const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
	if (rawImage && rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "image 与 url 只能给一个"
	};
	if (!rawImage && !rawUrl) return {
		ok: true,
		petId,
		text,
		duration: args.duration,
		anim: args.anim
	};
	if (rawUrl) {
		const url = normalizeHttpUrl(rawUrl);
		if (url === null) return {
			ok: false,
			reason: "bad-request",
			message: "url 必须是 http/https 的完整地址"
		};
		return {
			ok: true,
			petId,
			text,
			url,
			duration: args.duration,
			anim: args.anim
		};
	}
	const hit = matchMeme(readMemePool(who.conf.memes, memeDirs(who.entry)), rawImage);
	if (!hit) return {
		ok: false,
		reason: "unknown-image",
		message: "配图不在表情包池内：" + rawImage
	};
	return {
		ok: true,
		petId,
		text,
		image: hit.name,
		duration: args.duration,
		anim: args.anim
	};
}
function decideBubbleClear(args) {
	const who = resolvePetId(args.cfg, args.requested);
	if (!who.ok) return {
		ok: false,
		reason: who.reason,
		message: who.message
	};
	return {
		ok: true,
		petId: who.petId
	};
}

//#endregion
//#region src/host/routes/interaction.ts
async function handleInteractionRoutes(deps, input) {
	const { configPaths, lock, lockBlocked, memeDirsFor, pat, publishWhisper, requirePet, sleep: sleep$2, state, surfaceBlocked } = deps;
	const { body, method, rest, url } = input;
	if (rest === "lock" || rest === "lock/release") {
		const isRelease = rest === "lock/release";
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const o = parsed && typeof parsed === "object" ? parsed : {};
		try {
			const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: !isRelease });
			if (!who.ok) return who.res;
			const petId = who.petId;
			if (isRelease) {
				const d$1 = lock.release({
					petId,
					lockId: o.lockId,
					force: o.force
				});
				if (!d$1.ok) return failResult(d$1.reason, d$1.message, d$1.reason === "lock-lost" ? { cause: d$1.cause } : void 0);
				return okResult({ ok: true });
			}
			const d = lock.acquire({
				petId,
				lockId: o.lockId,
				ttl: o.ttl
			});
			if (!d.ok) {
				const extra = {};
				if (d.reason === "locked") extra.expiresAt = d.expiresAt;
				if (d.reason === "lock-lost") extra.cause = d.cause;
				return failResult(d.reason, d.message, extra);
			}
			sleep$2.wake(petId);
			return okResult({
				ok: true,
				lockId: d.lockId,
				petId: d.petId,
				expiresAt: d.expiresAt
			});
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "pat") {
		if (method !== "POST") return methodNotAllowed();
		try {
			const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
			if (!who.ok) return who.res;
			if (sleep$2.sleeping(who.petId)) return okResult({
				ok: true,
				sleeping: true
			});
			if (lock.locked(who.petId)) return okResult({
				ok: true,
				locked: true
			});
			const d = pat.pat(who.petId);
			return okResult({
				ok: true,
				tier: d.tier,
				count: d.count,
				plan: d.plan,
				hideMs: d.hideMs,
				ignored: d.ignored,
				busy: d.busy
			});
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "whisper") {
		if (method !== "POST") return methodNotAllowed();
		try {
			const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: true });
			if (!who.ok) return who.res;
			const want = normalizeSurface(url.searchParams.get("surface"));
			const r = await publishWhisper(who.petId, url.searchParams.get("image") ?? void 0, want === null ? void 0 : voiceTargetOfSurface(want));
			if (r.ok) return okResult({
				ok: true,
				text: r.text,
				...r.image ? { image: r.image } : {}
			});
			return failResult(r.reason, r.message ?? "生成失败");
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "broadcast") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const o = parsed && typeof parsed === "object" ? parsed : {};
		if (!normalizeBroadcastText(o.text)) return failResult("bad-request", "text 为空");
		const duration = normalizeBroadcastDuration(o.duration);
		if (duration === null) return failResult("bad-request", "duration 必须是 ≥0 的有限数字（毫秒）");
		const anim = normalizeBroadcastAnim(o.anim);
		try {
			const cfg = readAllConfig(configPaths);
			const d = decideBroadcast({
				cfg,
				requested: String(url.searchParams.get("pet") ?? ""),
				text: o.text,
				image: o.image,
				url: o.url,
				duration,
				anim,
				memeDirs: memeDirsFor
			});
			if (!d.ok) return failResult(d.reason, d.message);
			const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
			if (noSurface) return noSurface;
			const blocked = lockBlocked(d.petId, url.searchParams);
			if (blocked) return blocked;
			const pic = d.url !== void 0 ? { url: d.url } : d.image !== void 0 ? { image: d.image } : {};
			const want = normalizeSurface(url.searchParams.get("surface"));
			const voiceTo = want === null ? void 0 : voiceTargetOfSurface(want);
			state.writePet(d.petId, "say", {
				text: d.text,
				...pic,
				duration: d.duration,
				anim: d.anim,
				...voiceTo ? { voiceTo } : {}
			});
			return okResult({ ok: true });
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "bubble/clear") {
		if (method !== "POST") return methodNotAllowed();
		try {
			const cfg = readAllConfig(configPaths);
			const d = decideBubbleClear({
				cfg,
				requested: String(url.searchParams.get("pet") ?? "")
			});
			if (!d.ok) return failResult(d.reason, d.message);
			const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
			if (noSurface) return noSurface;
			const blocked = lockBlocked(d.petId, url.searchParams);
			if (blocked) return blocked;
			state.writePet(d.petId, "say", { clear: true });
			return okResult({ ok: true });
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	return void 0;
}

//#endregion
//#region src/host/routes/menu.ts
async function handleMenuRoutes(deps, input) {
	const { menuRegistry, state } = deps;
	const { body, method, rest, url } = input;
	if (rest === "menu/item") {
		if (method === "DELETE") {
			const result$1 = menuRegistry.clear(url.searchParams.get("owner") ?? "");
			if (!result$1.ok) return failResult(result$1.reason, result$1.message);
			state.writeSection("menu", { items: menuRegistry.snapshot() });
			return okResult({
				ok: true,
				removed: result$1.removed
			});
		}
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "");
		} catch {
			return invalidJson();
		}
		const result = menuRegistry.register(parsed);
		if (!result.ok) return failResult(result.reason, result.message);
		state.writeSection("menu", { items: menuRegistry.snapshot() });
		return okResult({ ok: true });
	}
	if (rest === "menu/events") {
		if (method !== "GET") return methodNotAllowed();
		const owner = url.searchParams.get("owner") ?? "";
		const rawWait = Number(url.searchParams.get("wait") ?? "0");
		const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, MENU_WAIT_MAX_MS) : 0;
		const events = await menuRegistry.poll(owner, waitMs);
		if (events === null) return failResult("unknown-owner", "这个 owner 没有注册，重新注册即可");
		return okResult({
			ok: true,
			events
		});
	}
	if (rest === "menu/click") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "");
		} catch {
			return invalidJson();
		}
		return okResult(menuRegistry.click(parsed));
	}
	return void 0;
}

//#endregion
//#region src/host/motion-cue.ts
const POSITION_MODES = [
	"instant",
	"spring",
	"line"
];
const POSITION_FRAMES = ["view", "anchor"];
/** 夹到 0~1：归一化坐标的合法范围，越界夹取而不是拒绝（响应里回的就是夹取后的值）。 */
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 有限数字收窄：字符串、布尔、NaN、Infinity 一律不算（配置里也这么判）。 */
const finite = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
/** 模式收窄：只认三个字面量（大小写、空白、非字符串一律不算），不认识返回 `null`。 */
const positionMode = (v) => typeof v === "string" && POSITION_MODES.includes(v) ? v : null;
/** 参照系收窄：缺省（`undefined` / `null`）按 `view`，写了就必须是那两个之一。 */
const positionFrame = (v) => {
	if (v === void 0 || v === null) return "view";
	if (typeof v !== "string" || !POSITION_FRAMES.includes(v)) return null;
	return v;
};
/**
* 目标宠物解析（与 ./anim、./broadcast 同一口径）：`?pet=` 必填且必须真实存在。
* 两种失败分开报：没给 → `pet-required`；给了但配置里没有 → `unknown-pet`。
*/
function resolvePet(cfg, requested) {
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	return {
		ok: true,
		petId
	};
}
function decidePosition(args) {
	const x = finite(args.x);
	if (x === null) return {
		ok: false,
		reason: "bad-request",
		message: "x 必须是有限数字"
	};
	const y = finite(args.y);
	if (y === null) return {
		ok: false,
		reason: "bad-request",
		message: "y 必须是有限数字"
	};
	const mode = positionMode(args.mode);
	if (mode === null) return {
		ok: false,
		reason: "bad-request",
		message: "mode 必须是 instant / spring / line"
	};
	let duration = null;
	if (mode === "line") {
		const d = finite(args.duration);
		if (d === null || d < 0) return {
			ok: false,
			reason: "bad-request",
			message: "line 模式的 duration 必须是非负有限数字（毫秒）"
		};
		duration = d;
	}
	let returnAfter = null;
	if (args.returnAfter !== void 0 && args.returnAfter !== null) {
		const r = finite(args.returnAfter);
		if (r === null || r < 0) return {
			ok: false,
			reason: "bad-request",
			message: "returnAfter 必须是非负有限数字（毫秒）"
		};
		returnAfter = Math.min(6e4, r);
	}
	const pet = resolvePet(args.cfg, args.requested);
	if (!pet.ok) return pet;
	const frame = positionFrame(args.frame);
	if (frame === null) return {
		ok: false,
		reason: "bad-request",
		message: "frame 必须是 view / anchor"
	};
	return {
		ok: true,
		petId: pet.petId,
		x: clamp01(x),
		y: clamp01(y),
		mode,
		duration,
		returnAfter,
		frame
	};
}
const positionLeafData = (d) => {
	const base = {
		x: d.x,
		y: d.y,
		mode: d.mode
	};
	if (d.duration !== null) base.duration = d.duration;
	if (typeof d.returnAfter === "number" && d.returnAfter > 0) base.returnAfter = d.returnAfter;
	if (d.frame === "anchor") base.frame = "anchor";
	return base;
};
function decideThrow(args) {
	const angle = finite(args.angle);
	if (angle === null) return {
		ok: false,
		reason: "bad-request",
		message: "angle 必须是有限数字"
	};
	const power = finite(args.power);
	if (power === null || power <= 0) return {
		ok: false,
		reason: "bad-request",
		message: "power 必须是大于 0 的有限数字"
	};
	const pet = resolvePet(args.cfg, args.requested);
	if (!pet.ok) return pet;
	return {
		ok: true,
		petId: pet.petId,
		angle,
		power
	};
}

//#endregion
//#region src/host/pose.ts
function normalizePoseInput(raw) {
	const o = raw && typeof raw === "object" ? raw : null;
	if (!o) return {
		ok: false,
		reason: "bad-request",
		message: "请求体必须是对象：{ x, y, facing }"
	};
	if (typeof o.x !== "number" || !Number.isFinite(o.x)) return {
		ok: false,
		reason: "bad-request",
		message: "x 必须是有限数字（归一化横坐标）"
	};
	if (typeof o.y !== "number" || !Number.isFinite(o.y)) return {
		ok: false,
		reason: "bad-request",
		message: "y 必须是有限数字（归一化纵坐标）"
	};
	if (o.facing !== "left" && o.facing !== "right") return {
		ok: false,
		reason: "bad-request",
		message: "facing 必须是 left / right"
	};
	return {
		ok: true,
		pose: {
			x: o.x,
			y: o.y,
			facing: o.facing
		}
	};
}
var PoseStore = class {
	constructor(opts) {
		this.byPet = new Map();
		this.now = opts?.now ?? Date.now;
	}
	/** 覆盖一只宠物的实况，返回落定的快照。 */
	set(petId, pose) {
		const snap = {
			x: pose.x,
			y: pose.y,
			facing: pose.facing,
			updatedAt: this.now()
		};
		this.byPet.set(petId, snap);
		return snap;
	}
	/** 读最近一次实况；从没上报过返回 undefined（路由回 pose-unavailable）。 */
	get(petId) {
		return this.byPet.get(petId);
	}
	/** 当前快照数（测试 / 观测用）。 */
	count() {
		return this.byPet.size;
	}
};

//#endregion
//#region src/host/routes/motion.ts
async function handleMotionRoutes(deps, input) {
	const { configPaths, lockBlocked, playback, pose, requirePet, state, surfaceBlocked } = deps;
	const { body, method, rest, url } = input;
	if (rest === "anim") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const o = parsed && typeof parsed === "object" ? parsed : {};
		try {
			const cfg = readAllConfig(configPaths);
			const d = decideAnim({
				cfg,
				requested: String(url.searchParams.get("pet") ?? ""),
				name: o.name,
				url: o.url,
				facing: o.facing
			});
			if (!d.ok) return failResult(d.reason, d.message);
			const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
			if (noSurface) return noSurface;
			const blocked = lockBlocked(d.petId, url.searchParams);
			if (blocked) return blocked;
			const record = playback.create(d.petId, d.url ?? d.name ?? "");
			state.writePet(d.petId, "anim", {
				...d.url !== void 0 ? { url: d.url } : { name: d.name },
				playbackId: record.playbackId,
				...d.facing === void 0 ? {} : { facing: d.facing }
			});
			return okResult({
				ok: true,
				playbackId: record.playbackId
			});
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "position" || rest === "throw") {
		const isPosition = rest === "position";
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const o = parsed && typeof parsed === "object" ? parsed : {};
		try {
			const cfg = readAllConfig(configPaths);
			const requested = String(url.searchParams.get("pet") ?? "");
			if (isPosition) {
				const d$1 = decidePosition({
					cfg,
					requested,
					x: o.x,
					y: o.y,
					mode: o.mode,
					duration: o.duration,
					returnAfter: o.returnAfter,
					frame: o.frame
				});
				if (!d$1.ok) return failResult(d$1.reason, d$1.message);
				const noSurface$1 = surfaceBlocked(cfg, d$1.petId, url.searchParams);
				if (noSurface$1) return noSurface$1;
				const blocked$1 = lockBlocked(d$1.petId, url.searchParams);
				if (blocked$1) return blocked$1;
				state.writePet(d$1.petId, "position", positionLeafData(d$1));
				return okResult({
					ok: true,
					x: d$1.x,
					y: d$1.y,
					frame: d$1.frame
				});
			}
			const d = decideThrow({
				cfg,
				requested,
				angle: o.angle,
				power: o.power
			});
			if (!d.ok) return failResult(d.reason, d.message);
			const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
			if (noSurface) return noSurface;
			const blocked = lockBlocked(d.petId, url.searchParams);
			if (blocked) return blocked;
			state.writePet(d.petId, "throw", {
				angle: d.angle,
				power: d.power
			});
			return okResult({ ok: true });
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "pose" || rest === "pose/report") {
		const isReport = rest === "pose/report";
		if (isReport && method !== "POST") return methodNotAllowed();
		if (!isReport && method !== "GET") return methodNotAllowed();
		let parsedPose;
		if (isReport) try {
			parsedPose = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		try {
			const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
			if (!who.ok) return who.res;
			if (isReport) {
				const p = normalizePoseInput(parsedPose);
				if (!p.ok) return failResult(p.reason, p.message);
				pose.set(who.petId, p.pose);
				return okResult({ ok: true });
			}
			const display = String(who.pet.display ?? "");
			if (!displayCovers("desktop", display)) return failResult("pet-not-displayed", who.petId + " 的显示模式是 " + display + "；桌面端实况只对 display 含 desktop 的宠物有", { display });
			const snap = pose.get(who.petId);
			if (snap === void 0) return failResult("pose-unavailable", "还没收到过这只宠物的桌面端实况（桌面端没起来，或刚重启还没来得及上报）");
			return okResult({
				ok: true,
				petId: who.petId,
				...snap
			});
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	return void 0;
}

//#endregion
//#region src/host/routes/playback.ts
async function handlePlaybackRoutes(deps, input) {
	const { playback } = deps;
	const { body, method, rest, signal, url } = input;
	const playbackPath = rest === "playback" || rest.startsWith("playback/") ? parsePlaybackPath(rest) : void 0;
	if (playbackPath) {
		const playbackId = playbackPath.playbackId;
		if (playbackPath.isReport) {
			if (method !== "POST") return methodNotAllowed();
			let reported;
			try {
				reported = JSON.parse(body ?? "null");
			} catch {
				return invalidJson();
			}
			const o = reported && typeof reported === "object" ? reported : {};
			const outcome = playback.report(playbackId, o.status, o.reason);
			if (outcome === "unknown") return failResult("unknown-playback", "unknown playback");
			if (outcome === "invalid") return failResult("bad-request", "invalid status");
			return okResult({ ok: true });
		}
		if (method !== "GET") return methodNotAllowed();
		const record = playback.get(playbackId);
		if (!record) return failResult("unknown-playback", "unknown playback");
		const parsed = parseWaitQuery(url.searchParams.get("wait"), url.searchParams.get("timeout"));
		if (parsed.kind === "error") return failResult("bad-request", parsed.error);
		if (parsed.kind === "none") return okResult({
			...record,
			matched: false
		});
		const { wait: waitList, timeoutMs } = parsed;
		if (waitList.includes(record.status)) return okResult({
			...record,
			matched: true
		});
		return await new Promise((resolveWait) => {
			let settled = false;
			/** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
			const settle = (result) => {
				if (settled) return;
				settled = true;
				resolveWait(result);
			};
			const cancel = playback.wait({
				playbackId,
				wait: waitList,
				timeoutMs,
				onWake: (r, matched) => settle(okResult({
					...r,
					matched
				}))
			});
			if (cancel === void 0) {
				settle(failResult("unknown-playback", "unknown playback"));
				return;
			}
			const onAbort = () => {
				cancel();
				settle({ kind: "none" });
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	return void 0;
}

//#endregion
//#region src/shared/request.ts
/** 从字符串数组里挑出非空字符串。 */
function labelsOf(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) if (typeof item === "string" && item.trim() !== "") out.push(item);
	return out;
}
function readReminder(leaf) {
	if (!leaf.data || typeof leaf.data !== "object") return null;
	const d = leaf.data;
	if (d.closed === true) return null;
	if (typeof d.id !== "string" || d.id === "") return null;
	if (d.kind !== "schedule" && d.kind !== "announce" && d.kind !== "chat" && d.kind !== "todo") return null;
	if (typeof d.title !== "string" || d.title.trim() === "") return null;
	const lines = labelsOf(d.lines);
	const actions = actionsOf$1(d.actions);
	return {
		id: d.id,
		kind: d.kind,
		ts: typeof d.ts === "number" && Number.isFinite(d.ts) ? d.ts : Date.now(),
		title: d.title,
		prompt: typeof d.prompt === "string" && d.prompt.trim() !== "" ? d.prompt : void 0,
		lines: lines.length > 0 ? lines : void 0,
		hint: typeof d.hint === "string" && d.hint.trim() !== "" ? d.hint : void 0,
		sessionId: typeof d.sessionId === "string" && d.sessionId.trim() !== "" ? d.sessionId : void 0,
		ttlMs: typeof d.ttlMs === "number" && Number.isFinite(d.ttlMs) && d.ttlMs > 0 ? d.ttlMs : void 0,
		scheduledAt: typeof d.scheduledAt === "string" ? d.scheduledAt : void 0,
		actions: actions.length > 0 ? actions : void 0
	};
}
/** 收窄快捷动作数组：跳过坏形状，`label` 与 `text` 都得非空。 */
function actionsOf$1(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const a = item;
		const label = typeof a.label === "string" ? a.label.trim() : "";
		const text = typeof a.text === "string" ? a.text.trim() : "";
		if (label === "" || text === "") continue;
		out.push({
			label,
			text
		});
	}
	return out;
}

//#endregion
//#region src/host/request-hub.ts
/** 审批等待上限：到点撤气泡并回落到 DSH 面板。 */
const APPROVAL_TIMEOUT_MS = 180 * 1e3;
/** 提问等待上限：问句往往要读上下文，给得比审批宽。 */
const QUESTION_TIMEOUT_MS = 5 * 60 * 1e3;
/** 预览气泡的停留时长。 */
const PREVIEW_TTL_MS = 15 * 1e3;
/**
* 「本会话都允许」的记账时长。
*
* 会话本身可能开好几天，但内存里的记账要有上限：插件重启、或隔夜回来第一批请求，
* 重新问一次比一直放行更安全。
*/
const SESSION_ALLOW_TTL_MS = 8 * 60 * 60 * 1e3;
/** 拦截诊断只留最近多少次尝试。 */
const DIAG_KEEP = 12;
/** `no-client` 宽限总时长（毫秒）：覆盖长轮询空窗、热重载、页面刷新这种瞬时断连。 */
const CLIENT_GRACE_MS = 2e3;
/** 宽限期内重试间隔（毫秒）。 */
const CLIENT_GRACE_STEP_MS = 120;
/**
* 多久没响应算「太久」（毫秒）。
*
* 90 秒是「大概真的没注意到」的位置：比审批超时（180 秒）短，留出第二次提醒的余地，
* 又不至于刚弹出来就把宠物叫走、显得心浮气躁。
*/
const ESCALATE_MS = 90 * 1e3;
/** 等一小会儿（`unref` 掉计时器，别拿它吊住宿主进程退出）。 */
const sleep$1 = (ms) => new Promise((resolve$1) => {
	const timer = setTimeout(resolve$1, ms);
	timer.unref?.();
});
/** 从任意异常里取一句人读文案。 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 没有稳定 id 的会话对象：给一个进程内唯一键，同一个对象复用同一个键。 */
const weakSessionIds = new WeakMap();
let weakSessionSeq = 0;
/**
* 从审批请求里取会话身份。
*
* DSH 的 `req.agent` 一般带 `session.id`；没有 id 时退回对象身份（WeakMap），
* 宁可按「同一个会话对象」记账，也不要把不同会话混成一条。
*
* @param agent - 审批请求里的 `agent`。
* @returns 记账用的会话键；完全取不到时 null（那就只能允许一次）。
*/
function sessionKeyOf(agent) {
	if (!agent || typeof agent !== "object") return null;
	const a = agent;
	const session = a.session;
	if (session && typeof session === "object") {
		const id = session.id;
		if (typeof id === "string" && id !== "") return "session:" + id;
		const known = weakSessionIds.get(session);
		if (known !== void 0) return known;
		const made = "object:" + (++weakSessionSeq).toString(36);
		weakSessionIds.set(session, made);
		return made;
	}
	if (typeof a.id === "string" && a.id !== "") return "agent:" + a.id;
	return null;
}
function createRequestHub(deps) {
	const now = deps.now ?? Date.now;
	const log = deps.log;
	let pending = null;
	let previewId = null;
	let previewTimer = null;
	/** 「挂太久」的提醒计时器：请求结束就收掉，只提醒一次。 */
	let escalateTimer = null;
	let disposed = false;
	let seq = 0;
	/** 会话键 → 到期时刻：这批会话里的审批不再弹气泡，直接放行。 */
	const sessionAllows = new Map();
	/** 拦截尝试的环形记录（排障用，不落盘）。 */
	const diagHits = [];
	/** 写一条请求信封；`data` 直接整体替换叶子。 */
	const write = (data) => {
		deps.state.writeSection("request", data);
	};
	/** 写结束标记：同一个 id + closed，消费端读到即收起。 */
	const close = (id, kind) => {
		write({
			id,
			kind,
			ts: now(),
			expiresAt: now(),
			closed: true
		});
	};
	/** 收掉当前请求的计时器与 abort 监听。 */
	const cleanup = (entry) => {
		if (entry.timer !== null) clearTimeout(entry.timer);
		entry.timer = null;
		entry.detach?.();
		entry.detach = null;
	};
	/** 结束当前请求：只结束与 id 对得上的那一条，避免竞态里误伤下一条。 */
	const settle = (resolution) => {
		const entry = pending;
		if (entry === null) return;
		pending = null;
		cleanup(entry);
		if (escalateTimer !== null) clearTimeout(escalateTimer);
		escalateTimer = null;
		close(entry.envelope.id, entry.envelope.kind);
		entry.resolve(resolution);
	};
	/**
	* 挂太久的请求：把宠物挪到屏幕中央再提醒一次。
	*
	* 用户可能正埋在别的窗口里，气泡和提示音都被盖住；让宠物「游过来」是这套桌宠里最不容易被
	* 忽略的动作。只喊一次，用户开始答（`settle`）就把计时器收掉。
	*
	* @param kind - 请求类型，交给实现决定文案/动作。
	*/
	const scheduleEscalate = (kind) => {
		if (!deps.escalate) return;
		if (escalateTimer !== null) clearTimeout(escalateTimer);
		escalateTimer = setTimeout(() => {
			escalateTimer = null;
			if (pending === null) return;
			note(kind, "escalated");
			try {
				deps.escalate?.(kind);
			} catch (error) {
				log.warn("dsh-pet: request escalate failed: " + messageOf(error));
			}
		}, deps.escalateMs ?? ESCALATE_MS);
		escalateTimer.unref?.();
	};
	/**
	* 不该接管的原因（`null` 表示可以接管）。
	*
	* 排障时这一句最值钱：不弹气泡到底是开关关了、端掉了，还是上一条请求没收拾干净。
	*
	* @returns 原因词，或 null。
	*/
	const blockReason = () => {
		if (disposed) return "disposed";
		if (pending !== null) {
			if (pending.envelope.expiresAt > now()) return "pending";
			const kind = pending.envelope.kind === "question" ? "question" : "approval";
			settle({ type: "delegate" });
			note(kind, "stale-pending");
		}
		if (!deps.enabled()) return "off";
		return deps.hasClient() > 0 ? null : "no-client";
	};
	/** 记一条诊断（只留最近 `DIAG_KEEP` 条）。 */
	const note = (kind, outcome) => {
		diagHits.push({
			t: now(),
			kind,
			outcome
		});
		if (diagHits.length > DIAG_KEEP) diagHits.splice(0, diagHits.length - DIAG_KEEP);
	};
	/**
	* 判定这次能不能接管，`no-client` 时先等一小会儿。
	*
	* 客户端的 `/state` 长轮询是「返回—立刻重连」，两次之间有个毫秒级空窗；插件热重载、
	* 页面刷新、宠物重启也会短暂一个端都不在线。以前这种瞬间的空窗直接把请求让给 DSH 面板，
	* 用户看到的就是「宠物压根没弹」。这里给 2 秒宽限，期间任一端连上就照常接管。
	*
	* @param kind - 请求类型，只用于诊断记账。
	* @returns 不该接管的原因词，或 null（可以接管）。
	*/
	const gate = async (kind) => {
		let reason = blockReason();
		if (reason !== "no-client") return reason;
		const steps = Math.max(1, Math.round((deps.clientGraceMs ?? CLIENT_GRACE_MS) / CLIENT_GRACE_STEP_MS));
		for (let i = 0; i < steps && reason === "no-client"; i += 1) {
			await sleep$1(CLIENT_GRACE_STEP_MS);
			reason = blockReason();
		}
		if (reason === null) note(kind, "late-client");
		return reason;
	};
	/**
	* 这次审批能不能按「本会话都允许」直接放行。
	*
	* 不看 `hasClient`：授权过之后桌面宠物关掉、页面切走也照样放行，那才算「这个会话别再问」。
	* 但仍受气泡开关约束——用户把插件的气泡关掉时，不该还替 DSH 做决定。
	*
	* @param sessionKey - 会话键。
	* @returns true 表示直接以 allowed-once 放行。
	*/
	const sessionAllowed = (sessionKey) => {
		if (sessionKey === null || !deps.enabled()) return false;
		const until = sessionAllows.get(sessionKey);
		if (until === void 0) return false;
		if (until > now()) return true;
		sessionAllows.delete(sessionKey);
		return false;
	};
	/** 开启一条待处理请求。 */
	const begin = (envelope, timeoutMs, signal, sessionKey) => new Promise((resolve$1) => {
		const entry = {
			envelope,
			resolve: resolve$1,
			timer: null,
			detach: null,
			sessionKey
		};
		pending = entry;
		write(envelope);
		entry.timer = setTimeout(() => {
			log.info("dsh-pet: request " + envelope.id + " timed out, falling back to DSH");
			settle({ type: "delegate" });
		}, timeoutMs);
		const abortable = signal;
		if (abortable && typeof abortable.addEventListener === "function" && typeof abortable.removeEventListener === "function") {
			const onAbort = () => settle({ type: "delegate" });
			abortable.addEventListener("abort", onAbort);
			entry.detach = () => {
				abortable.removeEventListener("abort", onAbort);
			};
		}
	});
	return {
		async interceptApproval(request, next) {
			if (disposed) {
				note("approval", "skip:disposed");
				return next();
			}
			const req = request ?? {};
			const toolName = typeof req.toolName === "string" ? req.toolName : "";
			if (toolName === "") {
				note("approval", "skip:no-tool");
				return next();
			}
			const sessionKey = sessionKeyOf(req.agent);
			if (sessionAllowed(sessionKey)) {
				log.info("dsh-pet: approval auto-allowed by session grant tool=" + toolName);
				note("approval", "auto-allowed");
				return "allowed-once";
			}
			const blocked = await gate("approval");
			if (blocked !== null) {
				note("approval", "skip:" + blocked);
				return next();
			}
			const reason = typeof req.displayReason === "string" ? req.displayReason : typeof req.reason === "string" ? req.reason : void 0;
			const envelope = {
				id: "a-" + now().toString(36) + "-" + (++seq).toString(36),
				kind: "approval",
				ts: now(),
				expiresAt: now() + APPROVAL_TIMEOUT_MS,
				toolName,
				...reason === void 0 ? {} : { reason }
			};
			log.info("dsh-pet: approval/request intercepted tool=" + toolName);
			note("approval", "intercepted " + toolName);
			scheduleEscalate("approval");
			const resolution = await begin(envelope, APPROVAL_TIMEOUT_MS, req.signal, sessionKey);
			if (resolution.type === "approval" && resolution.outcome !== "delegate") {
				note("approval", "answered " + resolution.outcome);
				return resolution.outcome;
			}
			note("approval", "delegated");
			return next();
		},
		async interceptQuestions(request, next) {
			const blocked = await gate("question");
			if (blocked !== null) {
				note("question", "skip:" + blocked);
				return next();
			}
			const req = request ?? {};
			const questions = Array.isArray(req.questions) ? req.questions : [];
			if (questions.length === 0) {
				note("question", "skip:empty");
				return next();
			}
			const envelope = {
				id: "q-" + now().toString(36) + "-" + (++seq).toString(36),
				kind: "question",
				ts: now(),
				expiresAt: now() + QUESTION_TIMEOUT_MS,
				questions
			};
			log.info("dsh-pet: user-questions/request intercepted count=" + questions.length);
			note("question", "intercepted " + questions.length + "q");
			scheduleEscalate("question");
			const resolution = await begin(envelope, QUESTION_TIMEOUT_MS, req.signal, null);
			if (resolution.type === "answers") {
				note("question", "answered");
				return { answers: resolution.answers };
			}
			note("question", "delegated");
			return next();
		},
		diag() {
			return {
				enabled: deps.enabled(),
				waiters: deps.hasClient(),
				pending: pending !== null,
				hits: diagHits.slice()
			};
		},
		answer(payload) {
			const body = payload ?? {};
			const id = typeof body.id === "string" ? body.id : "";
			if (id === "") return {
				ok: false,
				message: "id is required"
			};
			if (previewId !== null && id === previewId) {
				previewId = null;
				if (previewTimer !== null) clearTimeout(previewTimer);
				previewTimer = null;
				write({
					id,
					kind: body.kind === "question" ? "question" : "approval",
					ts: now(),
					expiresAt: now(),
					closed: true
				});
				return { ok: true };
			}
			const entry = pending;
			if (entry === null || entry.envelope.id !== id) return {
				ok: false,
				message: "request expired or unknown"
			};
			if (body.cancel === true) {
				settle({ type: "delegate" });
				return { ok: true };
			}
			if (entry.envelope.kind === "approval") {
				const outcome = body.outcome;
				if (outcome !== "allowed-once" && outcome !== "rejected" && outcome !== "delegate" && outcome !== "allow-session") return {
					ok: false,
					message: "invalid outcome"
				};
				if (outcome === "allow-session") {
					if (entry.sessionKey === null) log.warn("dsh-pet: session grant ignored (no session id on request)");
					else {
						sessionAllows.set(entry.sessionKey, now() + SESSION_ALLOW_TTL_MS);
						log.info("dsh-pet: session grant recorded key=" + entry.sessionKey);
					}
					settle({
						type: "approval",
						outcome: "allowed-once"
					});
					return { ok: true };
				}
				settle({
					type: "approval",
					outcome
				});
				return { ok: true };
			}
			const answers = body.answers;
			if (!Array.isArray(answers)) return {
				ok: false,
				message: "answers is required"
			};
			const known = entry.envelope.questions ?? [];
			const byId = new Map(known.map((q) => [q.id, q]));
			const normalized = [];
			for (const item of answers) {
				if (!item || typeof item !== "object") return {
					ok: false,
					message: "invalid answer item"
				};
				const a = item;
				if (typeof a.id !== "string" || !byId.has(a.id)) return {
					ok: false,
					message: "unknown question id"
				};
				const question = byId.get(a.id);
				const selected = Array.isArray(a.selected) ? a.selected.filter((label) => typeof label === "string" && label !== "") : [];
				const custom = typeof a.custom === "string" && a.custom.trim() !== "" ? a.custom : void 0;
				if (selected.length === 0 && custom === void 0) return {
					ok: false,
					message: "answer is empty"
				};
				if (!question.multiSelect && selected.length > 1) return {
					ok: false,
					message: "multiple labels on single select"
				};
				const allowed = new Set((question.options ?? []).map((o) => o.label));
				if (allowed.size > 0 && selected.some((label) => !allowed.has(label)) && custom === void 0) return {
					ok: false,
					message: "unknown option label"
				};
				normalized.push({
					id: a.id,
					selected,
					...custom === void 0 ? {} : { custom }
				});
			}
			if (normalized.length !== known.length) return {
				ok: false,
				message: "every question needs an answer"
			};
			settle({
				type: "answers",
				answers: normalized
			});
			return { ok: true };
		},
		preview(kind) {
			if (pending !== null) return false;
			if (previewId !== null) {
				if (previewTimer !== null) clearTimeout(previewTimer);
				previewTimer = null;
			}
			const id = "p-" + now().toString(36) + "-" + (++seq).toString(36);
			const expiresAt = now() + PREVIEW_TTL_MS;
			const envelope = kind === "approval" ? {
				id,
				kind,
				ts: now(),
				expiresAt,
				toolName: "shell",
				reason: "示例：这条只是预览，点任意按钮都会收起。",
				preview: true
			} : {
				id,
				kind: "question",
				ts: now(),
				expiresAt,
				preview: true,
				questions: [{
					id: "preview-q",
					header: "预览",
					question: "宠物可以在这里替你选。要试试吗？",
					options: [{ label: "要" }, { label: "不要" }]
				}]
			};
			previewId = id;
			write(envelope);
			previewTimer = setTimeout(() => {
				if (previewId !== id) return;
				previewId = null;
				previewTimer = null;
				close(id, kind);
			}, PREVIEW_TTL_MS);
			return true;
		},
		busy: () => pending !== null,
		dispose() {
			disposed = true;
			sessionAllows.clear();
			if (pending !== null) settle({ type: "delegate" });
			if (previewTimer !== null) clearTimeout(previewTimer);
			previewTimer = null;
			previewId = null;
		}
	};
}
const REMINDER_BUBBLE_TTL_MS = 20 * 1e3;
const ANNOUNCE_BUBBLE_TTL_MS = 120 * 1e3;
const MUTE_DEFAULT_MS = 60 * 60 * 1e3;
const MUTE_MAX_MS = 8 * 60 * 60 * 1e3;
/** 静音到期的毫秒时间戳；0 = 没静音。放模块级是因为它属于「这台机器上的宠物」，与某个会话无关。 */
let mutedUntil = 0;
function isMuted(now = Date.now()) {
	return mutedUntil > now;
}
function muteFor(ms, now = Date.now()) {
	const span = Number.isFinite(ms) ? Math.min(Math.max(0, ms), MUTE_MAX_MS) : MUTE_DEFAULT_MS;
	mutedUntil = span === 0 ? 0 : now + span;
	return mutedUntil;
}
/** 台账里最多留几条：留太多，宠物脚边那个数字就没意义了，滚动列表也压得住。 */
const HISTORY_KEEP = 20;
/** 最近弹过的通知摘要（新的在前）。只在内存：台账是「今天看到过什么」，不值得落盘。 */
const historyEntries = [];
/** 累计弹过多少条（含已滚出列表的）。 */
let historyTotal = 0;
/**
* 把一条通知记进折叠台账，并广播给页面。
*
* 静音期间的推送**也记**：用户说的是「现在别弹」，不是「别让我知道」——事后翻台账发现
* 早上那条清单被吞了，比根本不记更让人恼火。「等会儿」到期重发同一条 id 时只更新时间，
* 不重复计数：用户看到的是同一条提醒回来了一次，不是又多了一条。
*
* @param state - 轮询状态。
* @param reminder - 刚推送（或刚被静音吞掉）的提醒。
*/
function rememberHistory(state, reminder) {
	const entry = {
		id: reminder.id,
		kind: reminder.kind,
		ts: reminder.ts,
		title: reminder.title,
		...reminder.lines !== void 0 && reminder.lines.length > 0 ? { lines: [...reminder.lines] } : {},
		...reminder.prompt !== void 0 ? { prompt: reminder.prompt } : {},
		...reminder.sessionId !== void 0 ? { sessionId: reminder.sessionId } : {}
	};
	const first = historyEntries[0];
	if (first !== void 0 && first.id === entry.id) historyEntries[0] = entry;
	else {
		historyEntries.unshift(entry);
		historyTotal += 1;
		if (historyEntries.length > HISTORY_KEEP) historyEntries.length = HISTORY_KEEP;
	}
	state.writeSection("history", {
		count: historyTotal,
		entries: historyEntries.map((e) => ({ ...e }))
	});
}
function clearHistory(state) {
	historyEntries.length = 0;
	historyTotal = 0;
	state.writeSection("history", {
		count: 0,
		entries: []
	});
}
function publishReminder(state, reminder, now = Date.now, force = false) {
	rememberHistory(state, reminder);
	if (!force && isMuted(now())) return false;
	state.writeSection("reminder", reminder);
	const fallback = reminder.kind === "announce" ? ANNOUNCE_BUBBLE_TTL_MS : REMINDER_BUBBLE_TTL_MS;
	const ttl = reminder.ttlMs ?? fallback;
	setTimeout(() => {
		state.writeSection("reminder", {
			id: reminder.id,
			kind: reminder.kind,
			ts: now(),
			title: reminder.title,
			closed: true
		});
	}, ttl).unref?.();
	return true;
}

//#endregion
//#region src/host/routes/requests.ts
/** 主动推送的默认停留时长（ms）。 */
const ANNOUNCE_TTL_MS = 120 * 1e3;
/** 主动推送最多几条明细：再多气泡里也读不完，让推送方自己收一收。 */
const MAX_ANNOUNCE_LINES = 12;
/** 单条明细的字符上限。 */
const MAX_LINE_CHARS = 180;
/** 标题字符上限。 */
const MAX_TITLE_CHARS$1 = 60;
/** 正文（prompt）字符上限。 */
const MAX_TEXT_CHARS$1 = 600;
/** 快捷动作最多几个：一排超过三个，小窗里就开始挤了。 */
const MAX_ACTIONS = 3;
/** 动作按钮文案上限。 */
const MAX_ACTION_LABEL = 24;
/** 单个动作投回会话的正文上限。 */
const MAX_ACTION_TEXT = 1e3;
/** `/reply` 一条消息的字符上限（防止一次塞进半本小说）。 */
const MAX_REPLY_TEXT$1 = 4e3;
/**
* 最近推送过的提醒（id → 信封），供「等会儿」原样重发。
*
* 只在内存里、只留最近 8 条：重启后延后项就没了，这与「延后」本身的短生命周期一致，
* 也不值得为它落盘。
*/
const SNOOZE_KEEP = 8;
const recentReminders = new Map();
/** 收窄快捷动作：跳过坏形状、截断过长文案、限条数。 */
function actionsOf(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const a = item;
		const label = textOf$1(a.label);
		const text = textOf$1(a.text);
		if (label === "" || text === "") continue;
		out.push({
			label: label.length > MAX_ACTION_LABEL ? label.slice(0, MAX_ACTION_LABEL - 1) + "…" : label,
			text: text.length > MAX_ACTION_TEXT ? text.slice(0, MAX_ACTION_TEXT - 1) + "…" : text
		});
		if (out.length >= MAX_ACTIONS) break;
	}
	return out;
}
/** 取一个修剪过的字符串；非字符串给空串。 */
function textOf$1(value) {
	return typeof value === "string" ? value.trim() : "";
}
/** 记住一条推送过的提醒（超量丢最旧的），供「等会儿」原样重发。 */
function rememberReminder(reminder) {
	recentReminders.delete(reminder.id);
	recentReminders.set(reminder.id, reminder);
	while (recentReminders.size > SNOOZE_KEEP) {
		const oldest = recentReminders.keys().next();
		if (oldest.done === true) break;
		recentReminders.delete(oldest.value);
	}
}
/** 取一个时长（分钟），缺省/非法时用 fallback，并夹到上限。 */
function minutesOf(value, fallbackMs) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs;
	return Math.min(value * 60 * 1e3, MUTE_MAX_MS);
}
/**
* 「等会儿」要原样重排一条提醒，先得把它找出来。
*
* 先查本进程经 `/announce` 记下的那些；找不到再看当前挂在气泡上的这条——对话里
* 约的提醒由 `pet-reminders` 直接写 section，不经过 `/announce`，也就从没进过
* `recentReminders`。少了这条回退，聊天提醒上点「等会儿」只会得到一句
* unknown reminder，按钮看着就是「点了没反应」。
*/
function snoozeSource(deps, id) {
	const remembered = recentReminders.get(id);
	if (remembered) return remembered;
	const live = readReminder(deps.state.read().sections.reminder);
	return live && live.id === id ? live : void 0;
}
/** 收窄明细数组：去空、截断、限条数。 */
function linesOf(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		const line = textOf$1(item);
		if (line === "") continue;
		out.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS - 1) + "…" : line);
		if (out.length >= MAX_ANNOUNCE_LINES) break;
	}
	return out;
}
async function handleRequestRoutes(deps, input) {
	const { body, method, rest } = input;
	if (rest === "request/answer") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const result = deps.requests.answer(parsed);
		if (!result.ok) return failResult("bad-request", result.message ?? "invalid answer");
		return okResult({ ok: true });
	}
	if (rest === "request/diag") {
		if (method !== "GET") return methodNotAllowed();
		return okResult({
			ok: true,
			...deps.requests.diag()
		});
	}
	if (rest === "request/preview") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const kind = parsed?.kind === "question" ? "question" : "approval";
		if (!deps.requests.preview(kind)) return failResult("bad-request", "another request is already pending");
		return okResult({ ok: true });
	}
	if (rest === "announce") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		if (!parsed || typeof parsed !== "object") return failResult("bad-request", "body 必须是对象");
		const title = textOf$1(parsed.title);
		const lines = linesOf(parsed.lines);
		const text = textOf$1(parsed.text);
		if (title === "" && lines.length === 0 && text === "") return failResult("bad-request", "title / lines / text 至少要有一个");
		const id = "a-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
		const hint = textOf$1(parsed.hint);
		const sessionId = textOf$1(parsed.sessionId);
		const actions = sessionId === "" ? [] : actionsOf(parsed.actions);
		const ttl = typeof parsed.ttlMs === "number" && Number.isFinite(parsed.ttlMs) && parsed.ttlMs > 0 ? parsed.ttlMs : ANNOUNCE_TTL_MS;
		const reminder = {
			id,
			kind: "announce",
			ts: Date.now(),
			title: title.length > MAX_TITLE_CHARS$1 ? title.slice(0, MAX_TITLE_CHARS$1 - 1) + "…" : title,
			...lines.length > 0 ? { lines } : {},
			...text === "" ? {} : { prompt: text.length > MAX_TEXT_CHARS$1 ? text.slice(0, MAX_TEXT_CHARS$1 - 1) + "…" : text },
			...hint === "" ? {} : { hint: hint.slice(0, MAX_LINE_CHARS) },
			...sessionId === "" ? {} : { sessionId },
			...actions.length > 0 ? { actions } : {},
			ttlMs: ttl
		};
		rememberReminder(reminder);
		const shown = publishReminder(deps.state, reminder);
		return okResult({
			ok: true,
			id,
			...shown ? {} : { muted: true }
		});
	}
	if (rest === "reply") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		if (!parsed || typeof parsed !== "object") return failResult("bad-request", "body 必须是对象");
		const sessionId = textOf$1(parsed.sessionId);
		const text = textOf$1(parsed.text);
		if (sessionId === "") return failResult("bad-request", "sessionId 必填");
		if (text === "") return failResult("bad-request", "text 必填");
		if (Array.from(text).length > MAX_REPLY_TEXT$1) return failResult("bad-request", "text 太长");
		const service = deps.optionalService("agents");
		if (!service || typeof service.get !== "function") return failResult("unsupported", "DSH 的 agents 服务不可用");
		const agent = service.get(sessionId);
		if (!agent || typeof agent.followup !== "function") return failResult("bad-request", "会话不在运行中：先在 DSH 里打开它，再从宠物上点");
		try {
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: { kind: "user" }
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log.warn("dsh-pet: reply failed: " + message);
			return failResult("bad-request", message);
		}
		const reminderId = textOf$1(parsed.id);
		if (reminderId !== "") deps.state.writeSection("reminder", {
			id: reminderId,
			kind: "announce",
			ts: Date.now(),
			title: "",
			closed: true
		});
		return okResult({ ok: true });
	}
	if (rest === "reminder/close") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const id = textOf$1(parsed?.id);
		if (id === "") return failResult("bad-request", "id 必填");
		deps.state.writeSection("reminder", {
			id,
			kind: "announce",
			ts: Date.now(),
			title: "",
			closed: true
		});
		return okResult({ ok: true });
	}
	if (rest === "reminder/snooze") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const id = textOf$1(parsed?.id);
		if (id === "") return failResult("bad-request", "id 必填");
		const reminder = snoozeSource(deps, id);
		if (!reminder) return failResult("bad-request", "unknown reminder");
		const delay = minutesOf(parsed?.minutes, 15 * 60 * 1e3);
		recentReminders.delete(id);
		deps.state.writeSection("reminder", {
			id,
			kind: reminder.kind,
			ts: Date.now(),
			title: "",
			closed: true
		});
		setTimeout(() => {
			const again = {
				...reminder,
				ts: Date.now()
			};
			rememberReminder(again);
			publishReminder(deps.state, again, Date.now, true);
		}, delay).unref?.();
		return okResult({
			ok: true,
			id,
			snoozeMs: delay
		});
	}
	if (rest === "mute") {
		if (method !== "POST") return methodNotAllowed();
		let parsed = null;
		if (body !== void 0 && body !== "") try {
			parsed = JSON.parse(body);
		} catch {
			return invalidJson();
		}
		const minutes = parsed?.minutes;
		const ms = minutes === 0 ? 0 : minutesOf(minutes, MUTE_DEFAULT_MS);
		const until = muteFor(ms);
		return okResult({
			ok: true,
			mutedUntil: until,
			minutes: Math.round(ms / 6e4)
		});
	}
	if (rest === "history") {
		if (method === "GET") {
			const snap = deps.state.read().sections.history.data;
			return okResult({
				ok: true,
				count: typeof snap?.count === "number" ? snap.count : 0,
				entries: snap?.entries ?? []
			});
		}
		if (method !== "POST") return methodNotAllowed();
		let parsed = null;
		if (body !== void 0 && body !== "") try {
			parsed = JSON.parse(body);
		} catch {
			return invalidJson();
		}
		if (parsed?.clear !== true) return failResult("bad-request", "只支持 {clear:true}");
		clearHistory(deps.state);
		return okResult({ ok: true });
	}
	return void 0;
}

//#endregion
//#region src/host/routes/schedule.ts
/** 提示词上限：够写一整套流程，又不至于把日程文件撑坏。 */
const MAX_PROMPT_CHARS = 12e3;
/** 标题上限。 */
const MAX_TITLE_CHARS = 120;
/** 目录行里由调度器附加、不属于记录本身的字段。 */
const ROW_ONLY = new Set([
	"sessionId",
	"status",
	"lastDelivery",
	"deliveryHistory"
]);
/** 取一个修剪过的字符串；非字符串给空串。 */
function textOf(value) {
	return typeof value === "string" ? value.trim() : "";
}
/** 解析 `{id,title?,prompt?}`；缺 id 或缺内容都算坏请求。 */
function readPatch$1(body) {
	let parsed;
	try {
		parsed = JSON.parse(body ?? "null");
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const obj$1 = parsed;
	const id = textOf(obj$1.id);
	if (id === "") return null;
	const title = textOf(obj$1.title);
	const prompt = textOf(obj$1.prompt);
	if (title === "" && prompt === "") return null;
	if (prompt.length > MAX_PROMPT_CHARS) return null;
	return {
		id,
		...title === "" ? {} : { title: title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS - 1) + "…" : title },
		...prompt === "" ? {} : { prompt }
	};
}
async function handleScheduleRoutes(deps, input) {
	if (input.rest === "schedule/patch") {
		if (input.method !== "POST") return methodNotAllowed();
		const patch = readPatch$1(input.body);
		if (patch === null) return failResult("bad-request", "body 需要 {id, title?|prompt?}");
		const service = deps.optionalService("schedule");
		if (!service || typeof service.catalog !== "function" || typeof service.update !== "function") return failResult("unsupported", "DSH 的 schedule 服务不可用");
		let rows;
		try {
			rows = await service.catalog();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log.warn("dsh-pet: schedule/catalog failed: " + message);
			return failResult("internal-error", "读定时任务失败：" + message);
		}
		const row = Array.isArray(rows) ? rows.find((item) => textOf(item.id) === patch.id) : void 0;
		if (row === void 0) return failResult("bad-request", "没有这条定时任务：" + patch.id);
		const sessionId = textOf(row.sessionId);
		if (sessionId === "") return failResult("bad-request", "这条定时任务没有会话绑定");
		const expected = {};
		for (const [key, value] of Object.entries(row)) if (!ROW_ONLY.has(key)) expected[key] = value;
		let result;
		try {
			result = await service.update({
				sessionId,
				expected,
				...patch
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log.warn("dsh-pet: schedule/update failed: " + message);
			return failResult("internal-error", "改定时任务失败：" + message);
		}
		const answer = result ?? {};
		if (answer.updated !== true) {
			const code = textOf(answer.code);
			const message = textOf(answer.message);
			return failResult("bad-request", message !== "" ? message : code !== "" ? "调度器拒绝了这次修改：" + code : "调度器没有接受这次修改");
		}
		return okResult({
			ok: true,
			id: patch.id
		});
	}
	return void 0;
}

//#endregion
//#region src/host/routes/session.ts
/** 会话 id 上限：DSH 的 id 形如 `session-<uuid>`（44 字符），128 已足够，更长的视为伪造输入。 */
const MAX_SESSION_ID_CHARS = 128;
/** 宿主在「还没有会话」时写进快照的哨兵值，不能当作跳转目标。 */
const UNKNOWN_SESSION_ID = "unknown";
async function handleSessionRoutes(deps, input) {
	const isFocusSession = input.rest === "focus-session";
	if (!isFocusSession) return void 0;
	if (input.method !== "POST") return methodNotAllowed();
	let payload;
	try {
		payload = JSON.parse(input.body ?? "");
	} catch {
		return invalidJson();
	}
	const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
	if (sessionId === "" || sessionId === UNKNOWN_SESSION_ID) return failResult("bad-request", "sessionId 必填");
	if (sessionId.length > MAX_SESSION_ID_CHARS) return failResult("bad-request", `sessionId 超过 ${MAX_SESSION_ID_CHARS} 字符`);
	const ts = Date.now();
	deps.state.writeSection("focusSession", {
		sessionId,
		ts
	});
	return okResult({
		ok: true,
		sessionId,
		ts
	});
}

//#endregion
//#region src/host/routes/state.ts
async function handleStateRoutes(deps, input) {
	const { EXTERNAL_WORK_SESSION, ctx, nextExternalWorkSeq, publishWorkStatus, state, workStatus } = deps;
	const { body, method, rest, signal, url } = input;
	if (rest === "models") {
		if (method !== "GET") return methodNotAllowed();
		try {
			const llm = ctx.llm;
			const named = (id, name$1) => {
				const pid = String(id ?? "");
				return {
					id: pid,
					name: String(name$1 ?? "") || pid
				};
			};
			let providers = (typeof llm?.listProviders === "function" ? llm.listProviders() : []).map((p) => named(p?.id, p?.name));
			if (providers.length === 0 && typeof llm?.listConfigurableProviders === "function") providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
			providers = providers.filter((p) => p.id);
			const catalog = await Promise.all(providers.map(async (p) => {
				let models = [];
				try {
					const list = await llm?.listModels?.(p.id);
					models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
				} catch {}
				return {
					...p,
					models
				};
			}));
			return okResult({ providers: catalog });
		} catch (e) {
			return failResult("generate-error", e instanceof Error ? e.message : String(e));
		}
	}
	if (rest === "state") {
		if (method !== "GET") return methodNotAllowed();
		const headers = { "cache-control": "no-cache, no-store" };
		const parsed = parseStateWaitQuery(url.searchParams.get("since"), url.searchParams.get("timeout"));
		if (parsed.kind === "error") return failResult("bad-request", parsed.error);
		const current$2 = state.read();
		if (parsed.kind === "none" || current$2.counter !== parsed.since) return okResult(current$2, headers);
		const since = parsed.since;
		return await new Promise((resolveWait) => {
			let settled = false;
			/** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
			const settle = (result) => {
				if (settled) return;
				settled = true;
				resolveWait(result);
			};
			const cancel = state.wait({
				since,
				timeoutMs: parsed.timeoutMs,
				onWake: () => settle(okResult(state.read(), headers))
			});
			const onAbort = () => {
				cancel();
				settle({ kind: "none" });
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	if (rest === "work-status") {
		if (method === "DELETE") {
			if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
			return {
				kind: "text",
				status: 204,
				body: ""
			};
		}
		if (method !== "POST") return methodNotAllowed();
		if (Buffer.byteLength(body ?? "", "utf8") > 8 * 1024) return payloadTooLarge("body too large");
		let parsed;
		try {
			parsed = JSON.parse(body ?? "");
		} catch {
			return invalidJson();
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalidJson();
		const payload = parsed;
		const state$1 = payload.state;
		if (typeof state$1 !== "string" || !HOST_WORK_STATUS_STATES.includes(state$1)) return failResult("bad-request", `state 必须是 ${HOST_WORK_STATUS_STATES.join(" / ")} 之一`);
		let task;
		if (Object.prototype.hasOwnProperty.call(payload, "task")) if (payload.task === null) task = null;
		else if (typeof payload.task === "string") {
			const trimmed = payload.task.trim();
			if (trimmed === "") task = null;
			else if (Array.from(trimmed).length > TASK_TEXT_MAX) return failResult("bad-request", `task too long (max ${TASK_TEXT_MAX} code points)`);
			else task = trimmed;
		} else return failResult("bad-request", "invalid task");
		workStatus.setState(EXTERNAL_WORK_SESSION, state$1, nextExternalWorkSeq());
		if (task !== void 0) workStatus.setTask(EXTERNAL_WORK_SESSION, task);
		const progress = todoCounts(parsed);
		const rawDone = parsed.todoDone;
		const rawTotal = parsed.todoTotal;
		if (rawDone !== void 0 || rawTotal !== void 0) {
			if (rawDone !== void 0 && typeof rawDone !== "number") return failResult("bad-request", "todoDone 必须是数字");
			if (rawTotal !== void 0 && typeof rawTotal !== "number") return failResult("bad-request", "todoTotal 必须是数字");
			const done = typeof rawDone === "number" ? rawDone : 0;
			const total = typeof rawTotal === "number" ? rawTotal : 0;
			if (!Number.isFinite(done) || !Number.isFinite(total) || done < 0 || total < 0) return failResult("bad-request", "todoDone / todoTotal 必须是非负数字");
			workStatus.setTodoCounts(EXTERNAL_WORK_SESSION, done, total);
		} else if (progress.total > 0) workStatus.setTodoCounts(EXTERNAL_WORK_SESSION, progress.done, progress.total);
		publishWorkStatus();
		const mine = workStatus.todoOf(EXTERNAL_WORK_SESSION);
		return okResult({
			state: workStatus.stateOf(EXTERNAL_WORK_SESSION) ?? state$1,
			task: workStatus.taskOf(EXTERNAL_WORK_SESSION),
			todoDone: mine.done,
			todoTotal: mine.total
		});
	}
	return void 0;
}

//#endregion
//#region src/host/sleep.ts
/** 文案池收窄：非数组、非字符串项一律丢弃（配置已校验，这里只防手工改坏的文件）。 */
function textPool(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item !== "") : [];
}
function pickSleepText(pool$1) {
	return pool$1.length > 0 ? pool$1[Math.floor(Math.random() * pool$1.length)] : void 0;
}
function sleepTextsOf(conf) {
	return {
		start: textPool(conf.sleepStartTexts),
		end: textPool(conf.sleepEndTexts),
		refuse: textPool(conf.sleepRefuseTexts)
	};
}
/** 池子收窄：非数组、非字符串项一律丢弃（配置已校验，这里只防手工改坏的文件）。 */
function strings(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item !== "") : [];
}
function pickSleepNames(animations, roll = Math.random) {
	const conf = animations && typeof animations === "object" ? animations : {};
	const sets = Array.isArray(conf.sleep) ? conf.sleep : [];
	const usable = [];
	for (const set of sets) {
		if (!set || typeof set !== "object") continue;
		const entry = set;
		const start = strings(entry.start);
		const loop = strings(entry.loop);
		const end = strings(entry.end);
		if (!start.length || !loop.length || !end.length) continue;
		usable.push({
			start: start[Math.floor(roll() * start.length)],
			loop: loop[Math.floor(roll() * loop.length)],
			end: end[Math.floor(roll() * end.length)]
		});
	}
	if (!usable.length) return null;
	return usable[Math.floor(roll() * usable.length)];
}
var SleepStore = class {
	constructor(opts) {
		this.sets = new Map();
		this.onChange = opts?.onChange ?? (() => {});
	}
	/** 这只宠物此刻是否在睡。 */
	sleeping(petId) {
		return this.sets.has(petId);
	}
	/** 本次睡觉挑中的那套名字；没睡时 null。 */
	setOf(petId) {
		return this.sets.get(petId) ?? null;
	}
	/**
	* 进睡。已经在睡时保持原套、不重写叶子——重复调用（接口被连点、命令与菜单同时触发）
	* 不该把动画从头放一遍。
	* @returns 这次是否真的进入了睡觉状态。
	*/
	enter(petId, set) {
		if (this.sets.has(petId)) return false;
		this.sets.set(petId, set);
		this.onChange(petId, {
			sleeping: true,
			...set
		});
		return true;
	}
	/**
	* 醒来。
	* @returns 这次是否真的从睡眠状态退出（没在睡 = 幂等空操作）。
	*/
	wake(petId) {
		if (!this.sets.delete(petId)) return false;
		this.onChange(petId, { sleeping: false });
		return true;
	}
	/** 全部唤醒（插件卸载 / 桌面 Helper 重启路径）：否则渲染端要一直停在睡姿。 */
	wakeAll() {
		for (const petId of [...this.sets.keys()]) this.wake(petId);
	}
	/** 当前是否有任意宠物在睡（余额全局拉取据此决定要不要整拍跳过）。 */
	anySleeping() {
		return this.sets.size > 0;
	}
	/** 在睡的宠物 id（测试与日志用；顺序不保证）。 */
	ids() {
		return [...this.sets.keys()];
	}
};

//#endregion
//#region src/host/routes/sleep.ts
async function handleSleepRoutes(deps, input) {
	const { configPaths, lock, requirePet, sleep: sleep$2, state } = deps;
	const { method, rest, url } = input;
	const isSleep = rest === "sleep";
	const isWake = rest === "wake";
	if (!isSleep && !isWake) return void 0;
	if (method !== "POST") return methodNotAllowed();
	try {
		const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
		if (!who.ok) return who.res;
		const texts = sleepTextsOf(who.conf);
		if (rest === "wake") {
			const changed$1 = sleep$2.wake(who.petId);
			const text = pickSleepText(texts.end);
			if (text !== void 0) state.writePet(who.petId, "say", {
				text,
				anim: false
			});
			return okResult({
				ok: true,
				sleeping: false,
				changed: changed$1
			});
		}
		if (lock.locked(who.petId)) return failResult("locked", "这只桌宠正被占用，不能睡觉");
		const names = pickSleepNames(who.conf.animations);
		if (names === null) return failResult("no-sleep-animations", "这只宠物没有配置睡觉动画（animations.sleep）");
		const changed = sleep$2.enter(who.petId, names);
		if (changed) {
			const text = pickSleepText(texts.start);
			if (text !== void 0) state.writePet(who.petId, "say", {
				text,
				anim: false
			});
		}
		const active = sleep$2.setOf(who.petId) ?? names;
		return okResult({
			ok: true,
			sleeping: true,
			changed,
			start: active.start,
			loop: active.loop,
			end: active.end
		});
	} catch (e) {
		return failResult("generate-error", e instanceof Error ? e.message : String(e));
	}
}

//#endregion
//#region src/host/routes/todos.ts
/** 路径前缀：`todos` 或 `todos/<id>`。 */
const PREFIX = "todos";
/** Object.prototype.hasOwnProperty 的短别名：PATCH 要把「没传」与「传了 null」分开。 */
const has = (source, key) => Object.prototype.hasOwnProperty.call(source, key);
/** 解析请求体：不是 JSON 对象 → null。 */
function parseObjectBody(body) {
	if (body === void 0) return null;
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed;
}
/**
* PATCH 的字段校验：出现的键逐个校验，任一非法整包拒绝。
*
* @param raw - 已解析的请求体。
* @returns 待写入的字段集合；没有可写字段时返回空对象。
*/
function readPatch(raw) {
	const patch = {};
	if (has(raw, "text")) {
		const text = normalizeTodoText(raw.text);
		if (text === null) return null;
		patch.text = text;
	}
	if (has(raw, "dueAt")) {
		const due = normalizeTodoDueAt(raw.dueAt);
		if (!due.ok) return null;
		patch.dueAt = due.value;
	}
	if (has(raw, "done")) {
		if (typeof raw.done !== "boolean") return null;
		patch.done = raw.done;
	}
	return patch;
}
async function handleTodoRoutes(deps, input) {
	const { body, method, rest } = input;
	if (rest !== PREFIX && !rest.startsWith(PREFIX + "/")) return void 0;
	const { log, todos } = deps;
	try {
		if (rest === "todos") {
			if (method === "GET") return okResult({
				ok: true,
				todos: await todos.list()
			});
			if (method !== "POST") return methodNotAllowed();
			if (Buffer.byteLength(body ?? "", "utf8") > TODO_BODY_MAX_BYTES) return payloadTooLarge();
			const raw = parseObjectBody(body);
			if (raw === null) return invalidJson();
			const text = normalizeTodoText(raw.text);
			if (text === null) return failResult("bad-request", `text 必须是非空字符串，最多 ${TODO_TEXT_MAX} 个字符`);
			const due = normalizeTodoDueAt(raw.dueAt);
			if (!due.ok) return failResult("bad-request", "dueAt 必须是毫秒时间戳或 null");
			return okResult({
				ok: true,
				todo: await todos.create({
					text,
					dueAt: due.value
				})
			});
		}
		const id = rest.slice(PREFIX.length + 1);
		if (id === "" || id.includes("/")) return failResult("bad-request", "todo id 不合法");
		if (method === "PATCH") {
			if (Buffer.byteLength(body ?? "", "utf8") > TODO_BODY_MAX_BYTES) return payloadTooLarge();
			const raw = parseObjectBody(body);
			if (raw === null) return invalidJson();
			const patch = readPatch(raw);
			if (patch === null) return failResult("bad-request", "text / dueAt / done 至少一个字段不合法");
			if (Object.keys(patch).length === 0) return failResult("bad-request", "没有可更新的字段");
			const todo = await todos.update(id, patch);
			if (todo === null) return failResult("todo-not-found", "没有这条待办");
			return okResult({
				ok: true,
				todo
			});
		}
		if (method === "DELETE") return okResult({
			ok: true,
			removed: await todos.remove(id)
		});
		return methodNotAllowed();
	} catch (error) {
		log.warn(`[dsh-pet] 待办读写失败：${error instanceof Error ? error.message : String(error)}`);
		return failResult("internal-error", "dsh-pet: 待办读写失败");
	}
}

//#endregion
//#region src/host/voice/breeze.ts
const BREEZE_BASE = "https://api.breezeblue.ai";
const BREEZE_MODEL = "breeze-tts-2";
const BREEZE_TIMEOUT_MS = 2e4;
const BREEZE_LIST_TIMEOUT_MS = 1e4;
/** 网络抖动重试次数（含首次）。 */
const MAX_ATTEMPTS = 3;
var BreezeKeyError = class extends Error {
	constructor() {
		super("Breeze API Key 无效或已被重置，请到 Breeze 后台重新复制一个 brz_ 开头的 Key");
		this.name = "BreezeKeyError";
	}
};
var BreezeRetryableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "BreezeRetryableError";
	}
};
/** 睡一会儿；只在重试之间用。 */
function sleep(ms) {
	return new Promise((resolve$1) => {
		const timer = setTimeout(resolve$1, ms);
		timer.unref?.();
	});
}
/**
* 带超时地发一次请求。
*
* @param url - 完整地址。
* @param init - fetch 参数。
* @param timeoutMs - 超时；到点 abort。
* @param signal - 调用方的中止信号，任一方触发都停。
* @returns 响应对象（调用方自己判状态码）。
*/
async function fetchWithTimeout(url, init, timeoutMs, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
/** 把 429/5xx 判成可重试；其余 4xx 是请求本身有问题，重试只会再失败一次。 */
function isRetryableStatus(status) {
	return status === 429 || status >= 500;
}
async function synthesizeBreeze(input) {
	const url = `${BREEZE_BASE}/v1/text-to-speech/${encodeURIComponent(input.voice)}`;
	const body = JSON.stringify({
		text: input.text,
		language_code: "zh",
		model_id: BREEZE_MODEL,
		voice_settings: { speed: input.speed }
	});
	let lastError;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) try {
		const response = await fetchWithTimeout(url, {
			method: "POST",
			headers: {
				"xi-api-key": input.apiKey,
				"content-type": "application/json"
			},
			body
		}, BREEZE_TIMEOUT_MS, input.signal);
		if (response.status === 401 || response.status === 403) throw new BreezeKeyError();
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			const message = `Breeze API ${response.status}: ${detail.slice(0, 200)}`;
			throw isRetryableStatus(response.status) ? new BreezeRetryableError(message) : new Error(message);
		}
		const buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.length === 0) throw new BreezeRetryableError("Breeze API 返回空音频");
		return buffer;
	} catch (error) {
		lastError = error;
		if (error instanceof BreezeKeyError) throw error;
		const retryable = error instanceof BreezeRetryableError;
		if (!retryable || attempt === MAX_ATTEMPTS) throw error;
		await sleep(600 * attempt);
	}
	throw lastError instanceof Error ? lastError : new Error("Breeze 合成失败");
}
async function listBreezeVoices(apiKey, signal) {
	const response = await fetchWithTimeout(`${BREEZE_BASE}/v1/voices`, { headers: { "xi-api-key": apiKey } }, BREEZE_LIST_TIMEOUT_MS, signal);
	if (response.status === 401 || response.status === 403) throw new BreezeKeyError();
	if (!response.ok) {
		defaultLog("warn", `dsh-pet: breeze voices HTTP ${response.status}`);
		return [];
	}
	const payload = await response.json().catch(() => void 0);
	const rows = Array.isArray(payload?.voices) ? payload.voices : [];
	return rows.flatMap((row) => {
		if (!row || typeof row !== "object") return [];
		const item = row;
		const id = typeof item.voice_id === "string" ? item.voice_id : "";
		if (!id) return [];
		const name$1 = typeof item.name === "string" && item.name ? item.name : id;
		const tag = typeof item.description === "string" && item.description ? item.description : "";
		return [{
			id,
			name: name$1,
			tag
		}];
	});
}

//#endregion
//#region src/host/voice/engine.ts
const DEFAULT_BREEZE_SPEED = 1;
/** 读出 `main` 里的原始字面量；读不到配置文件时给空对象（= 全用默认）。 */
function readMain(paths) {
	try {
		return readAllConfig(paths).main ?? {};
	} catch {
		return {};
	}
}
function resolveVoiceEngine(paths) {
	const main = readMain(paths);
	const apiKey = typeof main.breezeApiKey === "string" ? main.breezeApiKey.trim() : "";
	const engine = main.voiceEngine === "breeze" ? "breeze" : "edge";
	if (engine !== "breeze" || !apiKey) return { engine: "edge" };
	const voice = typeof main.breezeVoice === "string" ? main.breezeVoice.trim() : "";
	const rawSpeed = main.breezeSpeed;
	const speed = typeof rawSpeed === "number" && Number.isFinite(rawSpeed) && rawSpeed >= .5 && rawSpeed <= 2 ? rawSpeed : DEFAULT_BREEZE_SPEED;
	return {
		engine: "breeze",
		breeze: {
			apiKey,
			voice,
			speed
		}
	};
}

//#endregion
//#region src/host/routes/voice.ts
async function handleVoiceRoutes(deps, input) {
	const { body, method, rest, signal } = input;
	if (rest === "voice/voices") {
		if (method !== "GET") return methodNotAllowed();
		return okResult({
			ok: true,
			voices: deps.voice.listVoices()
		});
	}
	if (rest === "voice/engine") {
		if (method !== "GET") return methodNotAllowed();
		const resolved = resolveVoiceEngine(deps.configPaths);
		const payload = {
			ok: true,
			engine: resolved.engine,
			hasKey: Boolean(resolved.breeze),
			voice: resolved.breeze?.voice ?? "",
			speed: resolved.breeze?.speed ?? DEFAULT_BREEZE_SPEED,
			voices: []
		};
		if (resolved.breeze) try {
			payload.voices = await listBreezeVoices(resolved.breeze.apiKey, signal);
		} catch (error) {
			payload.error = error instanceof BreezeKeyError ? "bad-key" : "list-failed";
		}
		return okResult(payload);
	}
	if (rest === "voice/speak") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const result = await deps.voice.speak(parsed);
		if (!result.ok) return failResult(result.reason, result.message);
		return {
			kind: "file",
			file: result.file,
			contentType: "audio/mpeg"
		};
	}
	if (rest === "voice/hear") {
		if (method !== "POST") return methodNotAllowed();
		let parsed;
		try {
			parsed = JSON.parse(body ?? "null");
		} catch {
			return invalidJson();
		}
		const result = await deps.speech.hear(parsed, signal);
		if (!result.ok) return failResult(result.reason, result.message);
		return okResult({
			ok: true,
			text: result.text
		});
	}
	return void 0;
}

//#endregion
//#region src/host/routes/index.ts
/** 处理器顺序：越靠前越先匹配；素材兜底必须在末尾。 */
const HANDLERS = [
	handleConfigRoutes,
	handleDesktopRoutes,
	handleAnchorRoutes,
	handleHomeRoutes,
	handleMenuRoutes,
	handleStateRoutes,
	handleSessionRoutes,
	handleBalanceRoutes,
	handleRequestRoutes,
	handleScheduleRoutes,
	handleInteractionRoutes,
	handleMotionRoutes,
	handlePlaybackRoutes,
	handleSleepRoutes,
	handleChatRoutes,
	handleAttachmentRoutes,
	handleTodoRoutes,
	handleVoiceRoutes,
	handleAvatarRoutes,
	handleAssetsRoutes
];
/**
* 睡觉期间要拒绝的端点：只列「打扰类」。
*
* 刻意用白名单而不是黑名单——新增端点默认放行，不会因为忘了排除而把维护动作（改显示位置、
* 重载配置）或拖拽链路（/position、/throw）一起锁死；反过来，漏列一个打扰端点只是它还能用，
* 不会造成「宠物叫不醒」。
*/
function sleepGated(rest, method) {
	if (rest === "chat") return method === "POST";
	if (rest === "todos") return method === "POST" || method === "DELETE";
	return rest === "anim" || rest === "whisper" || rest === "balance" || rest === "broadcast" || rest === "bubble/clear" || rest === "menu/click" || rest === "voice";
}
function createPetRouter(deps) {
	return async (url, rest, method, body, signal) => {
		if (sleepGated(rest, method)) {
			const petId = String(url.searchParams.get("pet") ?? "").trim();
			if (petId) {
				const blocked = deps.sleepBlocked(petId, url.searchParams);
				if (blocked) return blocked;
			}
		}
		for (const handle of HANDLERS) {
			const result = await handle(deps, {
				url,
				rest,
				method,
				body,
				signal
			});
			if (result !== void 0) return result;
		}
		return {
			kind: "text",
			status: 404,
			body: "dsh-pet: not found"
		};
	};
}

//#endregion
//#region src/host/plugin/http-route.ts
function createHttpRoute(deps) {
	let configQueue = Promise.resolve();
	/** 单次业务路由（HTTP 落盘与桌面 Helper 管道共用同一份实现）：输入 rawUrl + method + body 文本，
	*  返回 RouteResult，消费方各自落盘——业务逻辑只有一份，两端天然一致。
	*  signal 可选：调用方断开时中止挂起等待（只有 /playback 的 wait 分支会用到；管道侧不传）。 */
	const handlePetRoute = async (rawUrl, method, body, signal) => {
		const url = new URL(rawUrl, "http://localhost");
		const rest = decodeURIComponent(url.pathname.slice(ROUTE_SEGMENT.length + 1));
		const run = () => dispatchPetRoute(url, rest, method, body, signal);
		const isConfigQueue = rest === "config" || (rest === "pet-display" || rest === "pet-config") && method === "POST";
		if (isConfigQueue) {
			const pending = configQueue.then(run, run);
			configQueue = pending.then(() => void 0, () => void 0);
			return pending;
		}
		return run();
	};
	const dispatchPetRoute = createPetRouter(deps);
	return { handlePetRoute };
}
function registerHttpRoute(ctx, handlePetRoute) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_SEGMENT,
		handler: async (req, res) => {
			const abort = new AbortController();
			const onClose = () => abort.abort();
			res.on("close", onClose);
			try {
				const readsBody = req.method === "PUT" || req.method === "POST" || req.method === "PATCH";
				const body = readsBody ? await readBody(req) : void 0;
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", body, abort.signal);
				res.off("close", onClose);
				if (result.kind === "json") sendJson(res, result.status, result.obj, result.headers);
				else if (result.kind === "text") sendText(res, result.status, result.body);
				else if (result.kind === "none") {} else sendFile(req, res, result.file, result.contentType);
			} catch (e) {
				res.off("close", onClose);
				if (!res.destroyed && !res.writableEnded) {
					const code = e.code;
					if (code === "body-too-large") sendJson(res, 413, failureBody("payload-too-large", "request body too large"));
					else if (code !== "client-aborted") {
						ctx.logger?.warn?.(`[dsh-pet] route failed: ${e instanceof Error ? e.message : String(e)}`);
						sendJson(res, 500, failureBody("internal-error", "dsh-pet: internal error"));
					}
				}
			}
		}
	}), `dsh-pet: ${ROUTE_SEGMENT} asset route`);
}

//#endregion
//#region src/host/plugin/lifecycle.ts
function registerLifecycle(deps) {
	const { ctx, lock, markDisposed, playback, state, stopDownloadSlotTimer, stopHelper, stopWorkStatusFlush } = deps;
	ctx.effect(() => () => {
		markDisposed();
		stopWorkStatusFlush();
		stopDownloadSlotTimer();
		lock.releaseAll();
		playback.cancelAll();
		state.cancelAll();
		stopHelper("dsh-host-stop");
	});
}

//#endregion
//#region src/host/plugin/command-chat.ts
function registerChatCommand(deps) {
	const { ctx, chatWithPet, log, publishWhisper, resolveActivePetId, sleep: sleep$2, sleepRefusalText } = deps;
	ctx.effect(() => ctx.commands.register({
		name: "chat",
		description: "与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话",
		input: { hint: "[消息]（留空 = 碎碎念）" },
		handler: ({ rawInput }) => {
			const petId = resolveActivePetId();
			if (!petId) return {
				kind: "error",
				text: "没有可交互的桌宠"
			};
			if (sleep$2.sleeping(petId)) return {
				kind: "error",
				text: sleepRefusalText(petId)
			};
			const text = rawInput.trim();
			if (!text) {
				publishWhisper(petId).catch((e) => log.warn("[dsh-pet] 碎碎念异常：" + (e instanceof Error ? e.message : String(e))));
				return {
					kind: "success",
					text: "已让桌宠碎碎念一句"
				};
			}
			if (text.length > 2e3) return {
				kind: "error",
				text: "消息过长（限 2000 字）"
			};
			chatWithPet(petId, text).then((r) => {
				if (!r.ok) log.warn("[dsh-pet] 对话失败 reason=" + r.reason + (r.message ? " " + r.message : ""));
			}).catch((e) => log.warn("[dsh-pet] 对话异常：" + (e instanceof Error ? e.message : String(e))));
			return {
				kind: "success",
				text: "已发送，桌宠马上回应"
			};
		}
	}), "dsh-pet: /chat command");
}

//#endregion
//#region src/host/plugin/command-pet.ts
function registerPetCommand(deps) {
	const { ctx, effectivePetList, petDisplayName, resolveActivePetId, setActivePetId } = deps;
	ctx.effect(() => ctx.commands.register({
		name: "pet",
		description: "选择桌宠（/chat 对话的目标；支持选择框或手输 id/名字）",
		input: { hint: "[宠物 id 或名字]（留空查看当前）" },
		handler: ({ rawInput }) => {
			const arg = rawInput.trim();
			let eff;
			try {
				eff = effectivePetList();
			} catch {
				eff = [];
			}
			if (!arg) {
				const cur = resolveActivePetId();
				const found = eff.find((p) => String(p.id) === cur);
				return {
					kind: "success",
					text: "当前桌宠：" + (found ? petDisplayName(found) : cur || "（无可交互桌宠）")
				};
			}
			const byId = eff.find((p) => String(p.id) === arg);
			if (byId) {
				setActivePetId(String(byId.id));
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byId)
				};
			}
			const byName = eff.filter((p) => petDisplayName(p) === arg);
			if (byName.length === 1) {
				setActivePetId(String(byName[0].id));
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byName[0])
				};
			}
			if (byName.length > 1) return {
				kind: "error",
				text: "「" + arg + "」有 " + byName.length + " 只桌宠（id：" + byName.map((p) => String(p.id)).join("、") + "），请用 id 指定"
			};
			return {
				kind: "error",
				text: "找不到桌宠「" + arg + "」（id 或名字都行；/pet 回车可打开选择框）"
			};
		}
	}), "dsh-pet: /pet command");
}

//#endregion
//#region src/host/whisper-policy.ts
function automaticWhisperSchedule(policy, petEnabled, configuredPeriodSec) {
	if (!policy) return {
		enabled: petEnabled,
		periodSec: configuredPeriodSec
	};
	return {
		enabled: petEnabled && policy.isReady(),
		periodSec: configuredPeriodSec
	};
}

//#endregion
//#region src/host/plugin/loops.ts
/** 梦话周期的兜底值（秒）：配置里 eventsRefreshSec.sleepTalk 缺失/非法时用它。 */
const SLEEP_TALK_DEFAULT_SEC = 60;
/** 错峰队列里相邻两只之间的间隔（ms）：同拍到点的宠物依次开口，才会错开冒泡与语音。 */
const WHISPER_STAGGER_MS = 1e4;
/** 错峰队列上限：6 只 × 10s = 60s，正好覆盖最短周期，队列不会追着拍跑。 */
const WHISPER_QUEUE_MAX = 6;
function registerLoops(deps) {
	const { ctx, balancePeriodSec, configPaths, lastWhisperAt, lock, log, publishWhisper, publishSleepTalk, refreshBalance, sleep: sleep$2, standaloneAiPolicy, whisperPeriodSec } = deps;
	ctx.effect(() => {
		let disposed = false;
		let timer = null;
		function arm(sec) {
			if (disposed) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		async function tick() {
			let sec;
			try {
				const cfg = readAllConfig(configPaths);
				sec = balancePeriodSec(cfg);
				const pets = flattenPetList(cfg);
				if (pets.some((p) => p.balanceEnabled === true && !sleep$2.sleeping(String(p.id ?? "")))) await refreshBalance();
				else log.info("[dsh-pet] 余额周期跳过：没有醒着且启用余额的宠物");
			} catch (e) {
				log.warn("[dsh-pet] 余额周期读配置失败，周期刷新已停止（重启 DSH 后恢复）：" + (e instanceof Error ? e.message : String(e)));
				return;
			}
			arm(sec);
		}
		tick();
		return () => {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: balance poll");
	ctx.effect(() => {
		let disposed = false;
		let timer = null;
		/** 待发布的宠物（FIFO）；一次只发一只，两只之间隔 {@link WHISPER_STAGGER_MS}。 */
		const pending = [];
		/** 队列内相邻两只之间的等待句柄；与拍定时器分开计，两者都要在卸载时清掉。 */
		let drainTimer = null;
		/** 是否已经有一只正在生成；同一时刻只允许一只，否则两只仍会同时写出气泡。 */
		let pumping = false;
		/**
		* 从队列取下一只发布，等它写完再隔一个间隔发下一只。
		*
		* 间隔从「文字真的写进状态」算起，而不是从发起点算：单次生成耗时在 3–15 秒之间波动，
		* 从发起点算的固定间隔会被慢的那只吃掉，两只又撞到一起。
		*/
		async function pump() {
			if (disposed || pumping || drainTimer !== null) return;
			const petId = pending.shift();
			if (petId === void 0) return;
			pumping = true;
			try {
				await publishWhisper(petId);
			} catch {} finally {
				pumping = false;
			}
			if (disposed || pending.length === 0) return;
			drainTimer = setTimeout(() => {
				drainTimer = null;
				pump();
			}, WHISPER_STAGGER_MS);
		}
		function arm(sec) {
			if (disposed) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			let next = 300;
			try {
				const cfg = readAllConfig(configPaths);
				const now = Date.now();
				let min = Infinity;
				let checked = 0;
				let due = 0;
				let notDue = 0;
				const skipped = [];
				for (const pet of flattenPetList(cfg)) {
					const petId = String(pet.id ?? "");
					if (!petId) continue;
					const found = findPetInstance(cfg, petId);
					if (!found) continue;
					checked += 1;
					const schedule = automaticWhisperSchedule(standaloneAiPolicy(), pet.whisperEnabled === true, whisperPeriodSec(found.conf));
					if (!schedule.enabled) {
						skipped.push(petId + ": " + (pet.whisperEnabled === true ? "独立模式 AI 未就绪" : "whisperEnabled=false"));
						continue;
					}
					const display = String(pet.display ?? "");
					if (!isDisplayed(display)) {
						skipped.push(petId + ": display=none");
						continue;
					}
					const sec = schedule.periodSec;
					min = Math.min(min, sec);
					if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1e3) {
						notDue += 1;
						continue;
					}
					if (lock.locked(petId)) {
						skipped.push(petId + ": 占用锁跳过");
						continue;
					}
					if (sleep$2.sleeping(petId)) {
						skipped.push(petId + ": 睡觉中");
						continue;
					}
					if (pending.length >= WHISPER_QUEUE_MAX) {
						skipped.push(petId + ": 错峰队列已满");
						continue;
					}
					due += 1;
					lastWhisperAt.set(petId, now);
					log.info(`[dsh-pet] 碎碎念到点 pet=${petId}（周期 ${sec}s），入队待发`);
					pending.push(petId);
				}
				pump();
				if (Number.isFinite(min)) next = min;
				log.info(`[dsh-pet] 碎碎念调度：检查 ${checked} 只 → 到点 ${due}、未到点 ${notDue}、跳过 ${skipped.length}` + (due > 1 ? `；${due} 只按 ${WHISPER_STAGGER_MS / 1e3}s 间隔依次说` : "") + (skipped.length > 0 ? `（${skipped.join("；")}）` : "") + `；下一拍 ${next}s`);
			} catch (e) {
				log.warn("[dsh-pet] 碎碎念调度读配置失败，自动碎碎念已停止（重启 DSH 后恢复）：" + (e instanceof Error ? e.message : String(e)));
				return;
			}
			arm(next);
		}
		tick();
		return () => {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
			if (drainTimer !== null) clearTimeout(drainTimer);
		};
	}, "dsh-pet: whisper poll");
	ctx.effect(() => {
		let disposed = false;
		let timer = null;
		/** petId → 上一次说梦话的时刻；醒来不清，下次睡着时按周期自然接着算。 */
		const lastTalkAt = new Map();
		function arm(sec) {
			if (disposed) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			let next = SLEEP_TALK_DEFAULT_SEC;
			try {
				const cfg = readAllConfig(configPaths);
				const now = Date.now();
				let min = Infinity;
				for (const petId of sleep$2.ids()) {
					const found = findPetInstance(cfg, petId);
					if (!found) continue;
					const sec = sleepTalkPeriodSec(found.conf);
					min = Math.min(min, sec);
					if (now - (lastTalkAt.get(petId) ?? 0) < sec * 1e3) continue;
					lastTalkAt.set(petId, now);
					publishSleepTalk(petId).catch(() => {});
				}
				if (Number.isFinite(min)) next = min;
			} catch (e) {
				log.warn("[dsh-pet] 梦话调度读配置失败，说梦话已停止（重启 DSH 后恢复）：" + (e instanceof Error ? e.message : String(e)));
				return;
			}
			arm(next);
		}
		tick();
		return () => {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: sleep talk poll");
}
/** 梦话周期（秒）：条目级 eventsRefreshSec.sleepTalk，读不到按 60 兜底（与配置注释同一口径）。 */
function sleepTalkPeriodSec(conf) {
	const table = conf.eventsRefreshSec;
	const sec = Number(table?.sleepTalk);
	return Number.isFinite(sec) && sec > 0 ? sec : SLEEP_TALK_DEFAULT_SEC;
}

//#endregion
//#region src/host/plugin/command-balance.ts
function registerBalanceCommand(deps) {
	const { ctx, effectivePetList, refreshBalance, sleep: sleep$2, sleepRefusalText } = deps;
	ctx.effect(() => ctx.commands.register({
		name: "balance",
		description: "手动触发桌宠余额显示（立即弹出余额气泡）",
		handler: () => {
			const visible = effectivePetList().filter((pet) => String(pet.display ?? "") !== "none");
			if (visible.length > 0 && visible.every((pet) => sleep$2.sleeping(String(pet.id ?? "")))) return {
				kind: "error",
				text: sleepRefusalText(String(visible[0].id ?? ""))
			};
			refreshBalance(true);
			return {
				kind: "success",
				text: "已触发桌宠余额显示"
			};
		}
	}), "dsh-pet: /balance command");
}

//#endregion
//#region src/host/tool-detail/target.ts
function str(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}
function firstStr(args, keys) {
	for (const key of keys) {
		const value = str(args[key]);
		if (value !== null) return value;
	}
	return null;
}
function fileTarget(args) {
	return firstStr(args, [
		"file_path",
		"filePath",
		"path"
	]);
}
function urlHost(args) {
	const raw = str(args.url);
	if (raw === null) return null;
	try {
		const host = new URL(raw).host;
		return host === "" ? null : host;
	} catch {
		const rest = raw.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, "");
		const head = rest.split(/[/?#]/)[0] ?? "";
		return head === "" ? null : head;
	}
}
function queryTarget(args) {
	const queries = args.queries;
	if (Array.isArray(queries)) {
		for (const item of queries) {
			const value = str(item);
			if (value !== null) return value;
		}
		return null;
	}
	return firstStr(args, ["queries", "query"]);
}
function filesTarget(args) {
	const files = args.files;
	if (!Array.isArray(files)) return null;
	for (const item of files) {
		if (item === null || typeof item !== "object") continue;
		const picked = firstStr(item, ["path", "description"]);
		if (picked !== null) return picked;
	}
	return null;
}
const COMMAND_LIKE = /^[A-Za-z][A-Za-z\d_.-]+$/;
const SUBCOMMAND_LIKE = /^[A-Za-z][A-Za-z\d-]*$/;
const COMPOUND_COMMAND = /[;|]|&&|\|\||\r?\n/;
/**
* 取命令名时要剥掉的边角字符（运算符、括号、重定向、引号、变量前缀…）。
* 例：`(Get-NetTCPConnection` → `Get-NetTCPConnection`；`$env:FOO` → `env:FOO`（随后判定落选）。
*/
const EDGE_CHARS = new Set("&.([{!@$^+:=,;|\"'`)]}>#");
/** 剥掉词首词尾的边角字符。 */
function trimEdges(token) {
	let start = 0;
	let end = token.length;
	while (start < end && EDGE_CHARS.has(token.charAt(start))) start += 1;
	while (end > start && EDGE_CHARS.has(token.charAt(end - 1))) end -= 1;
	return token.slice(start, end);
}
function tokenizeCommand(command) {
	const tokens = [];
	let current$2 = "";
	let quote = null;
	for (const ch of command) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current$2 += ch;
			continue;
		}
		if (ch === "\"" || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch) || ch === ";" || ch === "|") {
			if (current$2 !== "") tokens.push(current$2);
			current$2 = "";
			continue;
		}
		current$2 += ch;
	}
	if (current$2 !== "") tokens.push(current$2);
	return tokens.map(trimEdges).filter((token) => token !== "");
}
/** arguments 的解析上限（UTF-16 码元数）：超过就不解析（write / edit 会带上整个文件内容）。 */
const MAX_ARGS_CHARS = 64 * 1024;
/** 气泡里目标的展示上限（码点）：超过就只留文件名。 */
const TARGET_MAX = 22;
const TARGET_DISPLAY_MAX = 20;
function parseArgs(raw) {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw;
	if (typeof raw !== "string" || raw === "" || raw.length > MAX_ARGS_CHARS) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
function clip$1(text) {
	const points = Array.from(text);
	return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : text;
}
function pickLine(lines) {
	return lines[Math.floor(Math.random() * lines.length)] ?? lines[0] ?? "";
}
function fill(line, vars) {
	let out = line;
	for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(value);
	return out;
}
function compactTarget(raw, pathLike) {
	if (!pathLike) return raw;
	const text = raw.replace(/\\/g, "/").replace(/\/+$/, "");
	if (Array.from(text).length <= TARGET_MAX) return text;
	const parts = text.split("/").filter((part) => part !== "");
	return parts.length > 0 ? parts[parts.length - 1] : text;
}

//#endregion
//#region src/host/tool-detail/copy.ts
/** 文件名/图片类：每句都带 {target}。 */
const FILE_COPY = [
	"翻翻 {target} 看看嘛",
	"{target} 里面写了啥呢",
	"我先瞅瞅 {target} 哈"
];
/** 写文件。 */
const WRITE_COPY = [
	"写点东西到 {target}",
	"{target} 马上写出来",
	"给 {target} 添点料"
];
/** 改文件。 */
const EDIT_COPY = [
	"{target} 得改改啦",
	"我来动动 {target} 哦",
	"{target} 这里要修一下"
];
/** 找文件。 */
const GLOB_COPY = [
	"{target} 都躲哪儿了呢",
	"找找 {target} 在不在",
	"{target} 藏在哪个角落呀"
];
/** 搜内容。 */
const GREP_COPY = [
	"{target} 藏哪儿了呢",
	"搜搜 {target} 在哪",
	"哪儿有 {target} 呀"
];
/** 给人看文件。 */
const PRESENT_COPY = [
	"给你看 {target} 哦",
	"{target} 拿来给你瞧瞧",
	"喏，{target} 在这儿"
];
/** 学技能。 */
const SKILL_COPY = [
	"学个新本事 {target}",
	"{target} 这招得记住",
	"把 {target} 学起来"
];
/** 委派子任务。 */
const SUBAGENT_COPY = [
	"叫人搭把手：{target}",
	"让帮手去看看 {target}",
	"{target} 交给帮手了"
];
const TOOL_COPY = {
	read: {
		lines: FILE_COPY,
		short: "翻翻代码看看"
	},
	read_image: {
		lines: [
			"这 {target} 长啥样呀",
			"让我瞧瞧 {target} 呗",
			"{target} 是张什么图呢"
		],
		short: "看看这张图是啥"
	},
	write: {
		lines: WRITE_COPY,
		short: "写点东西进去"
	},
	edit: {
		lines: EDIT_COPY,
		short: "这里得改改"
	},
	str_replace_editor: {
		lines: EDIT_COPY,
		short: "这里得改改"
	},
	glob: {
		lines: GLOB_COPY,
		short: "找找东西在哪"
	},
	grep: {
		lines: GREP_COPY,
		short: "到处翻翻看"
	},
	present: {
		lines: PRESENT_COPY,
		short: "拿个东西给你看"
	},
	skill: {
		lines: SKILL_COPY,
		short: "学个新本事"
	},
	subagent: {
		lines: SUBAGENT_COPY,
		short: "叫人来搭把手"
	},
	subagent_fork: {
		lines: SUBAGENT_COPY,
		short: "叫人来搭把手"
	},
	workflow: {
		lines: [
			"把活排个序，开工咯",
			"几件事一起安排上",
			"按顺序一件件来"
		],
		short: "把活排一排"
	},
	web_search: {
		lines: [
			"我去查查 {target}",
			"{target} 得搜搜才知道",
			"上网问问 {target} 吧"
		],
		short: "上网查查"
	},
	web_fetch: {
		lines: [
			"去 {target} 瞅瞅有啥",
			"{target} 这页我翻翻",
			"看看 {target} 上写了啥"
		],
		short: "去网上看看"
	}
};
const UNKNOWN_TOOL_LINE = "这工具是干嘛的";
const COMMAND_FALLBACK = [
	"跑一下 {cmd} 咯",
	"{cmd} 跑起来了",
	"让 {cmd} 干点活"
];
const COMMAND_NAME_TOO_LONG = "跑一个命令咯";
const CD_COPY = [
	"先把位置挪一挪",
	"切到那个目录去",
	"挪个地方继续干活"
];
const LS_COPY = [
	"看看这儿都有啥",
	"这层都有什么东西",
	"翻翻这里有没有"
];
const CAT_COPY = [
	"把内容亮出来瞧瞧",
	"看看里头写了什么",
	"读读这份内容"
];
const MKDIR_COPY = [
	"建个新文件夹",
	"腾个地方出来",
	"新开一个目录"
];
const RM_COPY = [
	"把不要的清掉",
	"这份就别留了",
	"清理一下这些"
];
const MV_COPY = [
	"把东西挪个地儿",
	"换个位置放",
	"挪到那边去"
];
const CP_COPY = [
	"抄一份留着",
	"复制一份备用",
	"再备一份"
];
const CURL_COPY = [
	"去问问接口有没有人",
	"敲敲门看看通不通",
	"请求一下那个地址"
];
const CHECKOUT_COPY = [
	"换到那个分支瞧瞧",
	"切个分支看看",
	"换条路继续走"
];
const COMMAND_COPY = {
	cd: CD_COPY,
	"set-location": CD_COPY,
	ls: LS_COPY,
	dir: LS_COPY,
	"get-childitem": LS_COPY,
	cat: CAT_COPY,
	"get-content": CAT_COPY,
	mkdir: MKDIR_COPY,
	"new-item": MKDIR_COPY,
	rm: RM_COPY,
	del: RM_COPY,
	"remove-item": RM_COPY,
	mv: MV_COPY,
	"move-item": MV_COPY,
	cp: CP_COPY,
	"copy-item": CP_COPY,
	curl: CURL_COPY,
	"invoke-webrequest": CURL_COPY,
	git: [
		"折腾折腾 git 仓库",
		"跟 git 打个交道",
		"git 这边动一动"
	],
	"git status": [
		"看看现在改了些什么",
		"查查工作区干不干净",
		"目前是啥状况呢"
	],
	"git diff": [
		"瞅瞅这次到底改哪了",
		"到底动了哪些地方呀",
		"对比看看都改了啥"
	],
	"git log": [
		"让我康康你的提交历史",
		"翻翻最近都提交了啥",
		"看看这些天干了什么"
	],
	"git add": [
		"先把这些攒起来",
		"好东西先收进去",
		"把改动的都登记上"
	],
	"git commit": [
		"代码得保存好才行",
		"打个提交，记一笔",
		"先存一份再说"
	],
	"git push": [
		"该推上去了吧，我来",
		"推送一下，交给我",
		"该让远端知道了"
	],
	"git pull": [
		"拉一下最新的过来",
		"把远端的新东西拿回来",
		"先同步一下再说"
	],
	"git fetch": [
		"先问问远端有没有新东西",
		"悄悄看一眼远端",
		"拉个最新状态下来"
	],
	"git checkout": CHECKOUT_COPY,
	"git switch": CHECKOUT_COPY,
	"git branch": [
		"看看都有哪些分支",
		"理理这些分支",
		"新建个分支备用"
	],
	"git merge": [
		"把两边合到一起",
		"合并一下，别打架",
		"这两条线该合了"
	],
	"git rebase": [
		"把历史重新捋一捋",
		"重新排一下顺序",
		"理一理提交顺序"
	],
	"git stash": [
		"先把改动收起来",
		"这些先搁一边",
		"暂时藏起来一下"
	],
	"git clone": [
		"把整个仓库搬回来",
		"照着一份抄下来",
		"把这份拿下来瞧瞧"
	],
	"git reset": [
		"把刚才的退回去",
		"撤销一下这几步",
		"回到之前的样子"
	],
	"git tag": [
		"给这次打个标记",
		"贴个版本标签",
		"记个里程碑"
	]
};
const SILENT_TOOLS = new Set([
	"todo_write",
	"ask_user_question",
	"create_goal",
	"get_goal",
	"update_goal",
	"exit_plan_mode"
]);
const TOOL_RULES = {
	read: {
		pick: fileTarget,
		path: true
	},
	read_image: {
		pick: fileTarget,
		path: true
	},
	write: {
		pick: fileTarget,
		path: true
	},
	edit: {
		pick: fileTarget,
		path: true
	},
	str_replace_editor: {
		pick: fileTarget,
		path: true
	},
	glob: { pick: (args) => firstStr(args, ["pattern", "path"]) },
	grep: { pick: (args) => firstStr(args, ["pattern", "path"]) },
	web_fetch: { pick: urlHost },
	web_search: { pick: queryTarget },
	subagent: { pick: (args) => firstStr(args, ["description"]) },
	subagent_fork: { pick: (args) => firstStr(args, ["description"]) },
	workflow: { pick: (args) => firstStr(args, ["name", "description"]) },
	skill: { pick: (args) => firstStr(args, ["name"]) },
	present: {
		pick: filesTarget,
		path: true
	}
};

//#endregion
//#region src/host/tool-detail/detail.ts
/**
* 按外部给的键查表，只认自有属性。
*
* 表是普通对象，而键来自模型给的工具名与命令名：`constructor` / `toString` / `__proto__`
* 会命中原型链，查回来的不是文案而是函数。这类名字没有特殊语义，一律按「表里没有」处理。
*/
function own(table, key) {
	return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
}
/**
* `pwsh` 的文案：按命令名（必要时加子命令）查表，查不到走兜底。
*
* 复合命令 → null，让前端回落配置文案（无法判断真正在做什么）；`git log` 这类命中「命令 + 子命令」
* 用子命令文案，只命中命令（`git`、`cd`）用通用文案，都没命中（`npm`、`python`、`node`…）走兜底——
* 兜底带命令名，至少知道在跑什么。
*/
function pwshDetail(args) {
	const command = args === null ? null : str(args.command);
	if (command === null) return null;
	if (COMPOUND_COMMAND.test(command)) return null;
	const tokens = tokenizeCommand(command);
	const nameAt = tokens.findIndex((token) => COMMAND_LIKE.test(token));
	if (nameAt < 0) return null;
	const rawCmd = tokens[nameAt];
	const lookup = rawCmd.toLowerCase();
	const subAt = tokens.findIndex((token, index) => index > nameAt && SUBCOMMAND_LIKE.test(token));
	const sub = subAt < 0 ? null : tokens[subAt].toLowerCase();
	const lines = (sub === null ? void 0 : own(COMMAND_COPY, `${lookup} ${sub}`)) ?? own(COMMAND_COPY, lookup);
	if (lines !== void 0) return clip$1(pickLine(lines));
	if (Array.from(rawCmd).length > TARGET_DISPLAY_MAX) return clip$1(COMMAND_NAME_TOO_LONG);
	return clip$1(fill(pickLine(COMMAND_FALLBACK), { cmd: rawCmd }));
}
function toolDetailFromEvent(event) {
	const name$1 = str(event?.data?.name);
	if (name$1 === null) return null;
	if (SILENT_TOOLS.has(name$1)) return null;
	const args = parseArgs(event?.data?.arguments);
	if (name$1 === "pwsh") return pwshDetail(args);
	const entry = own(TOOL_COPY, name$1);
	if (entry === void 0) return clip$1(UNKNOWN_TOOL_LINE);
	const rule = own(TOOL_RULES, name$1);
	const line = pickLine(entry.lines);
	if (!line.includes("{target}")) return clip$1(line);
	const target = args === null || rule === void 0 ? null : rule.pick(args);
	if (target === null) return null;
	const shown = compactTarget(target, rule?.path === true);
	if (Array.from(shown).length > TARGET_DISPLAY_MAX) return clip$1(entry.short);
	return clip$1(fill(line, { target: shown }));
}

//#endregion
//#region src/host/notify-events.ts
function shouldNotifySession(session) {
	const header = session?.header;
	if (!header || typeof header !== "object") return true;
	if (header.origin === "subagent") return false;
	const depth = header.delegationDepth;
	if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) return false;
	return true;
}
function sessionIdOf(session) {
	const s = session;
	return String(s?.header?.id ?? s?.id ?? "unknown");
}
function withSessionId(frame, sessionId) {
	return sessionId === "unknown" ? frame : {
		...frame,
		sessionId
	};
}
function isCompletionTurnEnd(event) {
	const e = event;
	return e?.type === "turn/end" && e.data?.reason?.kind === "completed";
}
function hasBlockingActivity(activity) {
	if (!Array.isArray(activity)) return false;
	for (const item of activity) {
		const kind = item?.kind;
		if (kind === "job" || kind === "subagent" || kind === "schedule") return true;
	}
	return false;
}
/** 回复开头在会话状态里的缓存上限：只用于一条 toast，留太长没有意义。 */
const MAX_REPLY_TEXT = 200;
function lastAssistantText(event) {
	if (event?.type !== "assistant/message") return null;
	const content = event.data?.message?.content;
	if (!Array.isArray(content)) return null;
	for (let i = content.length - 1; i >= 0; i -= 1) {
		const block = content[i];
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const text = block.text.replace(/\s+/g, " ").trim();
		if (text === "") continue;
		return text.length > MAX_REPLY_TEXT ? text.slice(0, MAX_REPLY_TEXT) : text;
	}
	return null;
}
function turnEndNotifyKind(kind) {
	if (kind === "completed") return "completed";
	if (kind === "error" || kind === "max-tokens") return kind;
	return null;
}
/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户答复）。 */
const USER_QUESTION_TOOL = "ask_user_question";
function parseToolQuestions(args) {
	if (typeof args !== "string") return null;
	try {
		const parsed = JSON.parse(args);
		const questions = parsed?.questions;
		if (!Array.isArray(questions)) return null;
		return questions;
	} catch {
		return null;
	}
}
function reduceNotifyFrame(event, replyText) {
	if (!event?.type) return null;
	switch (event.type) {
		case "turn/end": {
			const reason = event.data?.reason;
			const kind = turnEndNotifyKind(reason?.kind);
			if (!kind) return null;
			return {
				type: "session/event",
				event: {
					type: "turn/end",
					data: kind === "completed" && replyText ? {
						reason,
						text: replyText
					} : { reason }
				}
			};
		}
		case "approval/asked": {
			const data = event.data ?? {};
			return {
				type: "approval/requested",
				...typeof data.toolName === "string" && data.toolName ? { toolName: data.toolName } : {},
				...typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}
			};
		}
		case "tool/call": {
			if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL) return null;
			const questions = parseToolQuestions(event.data?.arguments);
			if (!questions || questions.length === 0) return null;
			return {
				type: "question/requested",
				questions
			};
		}
		default: return null;
	}
}
function agentErrorFrame(error) {
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
	return {
		type: "host/agent-error",
		message
	};
}

//#endregion
//#region src/host/plugin/session-watch.ts
/**
* 取本次工具事件的调用标识。
*
* `tool/call` 的标识在 `data.callId`，`tool/result` 在 `data.message.source.callId`
* （`ToolResultMessage.source` 由 `ToolMessageSource` 保证必带）。
*
* @returns 非空字符串标识；缺失或类型不对时 `undefined`，交给记账层用临时 Symbol 占位。
*/
function toolCallIdOf(event) {
	const data = event?.data;
	const raw = data?.message?.source?.callId ?? data?.callId;
	return typeof raw === "string" && raw !== "" ? raw : void 0;
}
/**
* 更新一个会话的在途调用表，算出气泡该显示什么。
*
* @param ledger - 每会话在途调用表；本函数原地修改。
* @param sessionId - 会话标识。
* @param phase - 本次是调用开始还是结果返回，以及对应的调用标识。
* @param lastTodo - 表清空后回落到的 todo 文案。
* @returns 气泡文案与是否仍在工作。
*/
function trackToolPhase(ledger, sessionId, phase, lastTodo) {
	if (phase.kind === "call") {
		let pending$1 = ledger.get(sessionId);
		if (!pending$1) ledger.set(sessionId, pending$1 = new Map());
		pending$1.set(phase.callId ?? Symbol(), phase.detail);
		return {
			task: phase.detail,
			keepWorking: true
		};
	}
	const pending = ledger.get(sessionId);
	const key = phase.callId ?? [...pending?.keys() ?? []].find((id) => typeof id === "symbol");
	if (key !== void 0) pending?.delete(key);
	const remaining = [...pending?.values() ?? []];
	if (pending?.size === 0) ledger.delete(sessionId);
	const active = remaining.pop();
	if (active !== void 0) return {
		task: active,
		keepWorking: true
	};
	return {
		task: lastTodo,
		keepWorking: false
	};
}
/**
* 把一次工具事件落进记账表。
*
* @param ledger - 每会话在途调用表；本函数原地修改。
* @param sessionId - 会话标识。
* @param input - 事件类型、调用标识与详情文案。
* @returns 记账结果；没有可展示详情且不是结果事件时返回 `undefined`（气泡不因它改文案）。
*/
function trackToolEvent(ledger, sessionId, input) {
	if (input.detail !== null) return trackToolPhase(ledger, sessionId, {
		kind: "call",
		detail: input.detail,
		callId: input.callId
	}, input.lastTodo);
	if (input.type === "tool/result") return trackToolPhase(ledger, sessionId, {
		kind: "result",
		callId: input.callId
	}, input.lastTodo);
	return void 0;
}
function registerSessionWatch(deps) {
	const { ctx, cancelTerminalCleanup, lastTodoText, lastReplyText, notifyActivityTimers, publishWorkStatus, pushNotifyFrame, scheduleCompletionNotify, scheduleTerminalCleanup, terminalTimers, toolsInFlight, turnFlags, workStatus } = deps;
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			const type = event?.type;
			if (!type) return;
			const sessionId = String(session?.header?.id ?? session?.id ?? "unknown");
			if (type === "todo/write") {
				const text = currentTaskFromTodo(event);
				lastTodoText.set(sessionId, text);
				const counts = todoCounts(event);
				if (workStatus.setTodoCounts(sessionId, counts.done, counts.total)) publishWorkStatus();
				if ((toolsInFlight.get(sessionId)?.size ?? 0) > 0) return;
				if (workStatus.has(sessionId)) {
					workStatus.setTask(sessionId, text);
					publishWorkStatus();
				}
				return;
			}
			if (type === "user/message") {
				const source = event?.data?.source;
				if (source?.kind === "goal") {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.goalRound = true;
					turnFlags.set(sessionId, flags);
				}
				return;
			}
			if (type === "turn/start") {
				turnFlags.set(sessionId, {
					goalRound: false,
					closing: null
				});
				workStatus.setTask(sessionId, null);
				lastTodoText.delete(sessionId);
				toolsInFlight.delete(sessionId);
				publishWorkStatus();
			}
			if (type === "tool/call" && String(event?.data?.name ?? "") === GOAL_UPDATE_TOOL) {
				const action = goalUpdateAction(String(event?.data?.arguments ?? ""));
				if (action) {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.closing = action;
					turnFlags.set(sessionId, flags);
				}
			}
			let next = reduceWorkStatus(event, turnFlags.get(sessionId));
			if (!next) {
				if (type === "turn/end") {
					turnFlags.delete(sessionId);
					cancelTerminalCleanup(sessionId);
					lastTodoText.delete(sessionId);
					toolsInFlight.delete(sessionId);
					workStatus.clear(sessionId);
					publishWorkStatus();
				}
				return;
			}
			const seq = Number(event.seq ?? 0);
			const detail = type === "tool/call" ? toolDetailFromEvent(event) : null;
			const outcome = trackToolEvent(toolsInFlight, sessionId, {
				type,
				callId: toolCallIdOf(event),
				detail,
				lastTodo: lastTodoText.get(sessionId) ?? null
			});
			if (outcome?.keepWorking) next = "working";
			const changed = workStatus.setState(sessionId, next, seq);
			if (type === "turn/start") workStatus.beginTurn(sessionId, Date.now());
			else if (type === "tool/call") workStatus.bumpStep(sessionId);
			if (outcome?.task !== void 0) workStatus.setTask(sessionId, outcome.task);
			publishWorkStatus();
			if (!changed) return;
			if (next === "success" || next === "error") scheduleTerminalCleanup(sessionId);
			else cancelTerminalCleanup(sessionId);
		});
		return () => {
			dispose();
			for (const t of terminalTimers.values()) clearTimeout(t);
			terminalTimers.clear();
		};
	}, "dsh-pet: work-status session events");
	ctx.effect(() => {
		const sessionDispose = ctx.on(
			"session/event",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- session/event 载荷无公开类型，any 只用于接收，函数内立刻交给 shouldNotifySession / reduceNotifyFrame 推导
			(session, event) => {
				if (!shouldNotifySession(session)) return;
				if (event?.type === "assistant/message") {
					const text = lastAssistantText(event);
					if (text) lastReplyText.set(sessionIdOf(session), text);
				}
				if (isCompletionTurnEnd(event)) {
					scheduleCompletionNotify(sessionIdOf(session), event);
					return;
				}
				if (event?.type === "turn/end") lastReplyText.delete(sessionIdOf(session));
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(withSessionId(frame, sessionIdOf(session)));
			}
);
		const errorDispose = ctx.on(
			"agent/error",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- agent/error 载荷无公开类型，且低版本 DSH 可能不带 error 字段，只能 any 后按可选链取 payload?.error
			(payload) => {
				pushNotifyFrame(agentErrorFrame(payload?.error));
			}
);
		return () => {
			for (const t of notifyActivityTimers.values()) clearTimeout(t);
			notifyActivityTimers.clear();
			sessionDispose();
			errorDispose();
		};
	}, "dsh-pet: notify frames");
}

//#endregion
//#region src/host/plugin/desktop/pets.ts
/** 该宠物是否参与桌面模式（Electron 透明窗）。 */
const isDesktopVisible = (display) => display === "desktop" || display === "both";
/** 现读配置并算出判定；读不出来时抛出，由各取值函数决定降级方式。 */
function readDecision(configPaths) {
	const merged = readAllConfig(configPaths);
	const pets = flattenPetList(merged);
	return {
		pets,
		desktopPets: pets.filter((pet) => isDesktopVisible(pet.display))
	};
}
function createDesktopPets(deps) {
	const { configPaths, effectivePetList, log } = deps;
	/** 现在有没有桌面宠物；读配置失败按「没有」处理——宁可不起 helper，也不起一个没有宠物的空进程。 */
	const getHasDesktopPet = () => {
		try {
			return readDecision(configPaths).desktopPets.length > 0;
		} catch {
			return false;
		}
	};
	/** 托盘开关的当前值；读失败按「仍要托盘」处理（保守保留常驻图标）。 */
	const getTrayOn = () => {
		try {
			return readAllConfig(configPaths).main?.trayEnabled !== false;
		} catch {
			return true;
		}
	};
	/** 参与桌面窗的宠物（给 helper 的启动参数）；读失败返回空列表。 */
	const desktopPetList = () => {
		try {
			return effectivePetList().filter((pet) => isDesktopVisible(pet.display)).map((pet) => ({
				id: String(pet.id),
				size: Number(pet.size)
			}));
		} catch {
			return [];
		}
	};
	/** 打一行判定日志（诊断用）：设置页显示「仅桌面」却没有 helper 进程时，这行能分辨宿主读到的是 web 还是 desktop。 */
	const logDesktopDecision = () => {
		try {
			const { pets, desktopPets } = readDecision(configPaths);
			const trayOn = readAllConfig(configPaths).main?.trayEnabled !== false;
			log.info(`[dsh-pet] 桌面判定：pets=${pets.length}，桌面可见=${desktopPets.length}（${desktopPets.map((pet) => String(pet.id)).join(",") || "无"}）→ hasDesktopPet=${desktopPets.length > 0} tray=${trayOn}`);
		} catch (e) {
			log.warn(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	logDesktopDecision();
	return {
		getHasDesktopPet,
		getTrayOn,
		desktopPetList,
		logDesktopDecision
	};
}

//#endregion
//#region src/host/plugin/desktop/bridge-response.ts
/** 纯文本应答的类型串；`text` 与 `none` 共用。 */
const TEXT_UTF8 = "text/plain; charset=utf-8";
/** JSON 应答的类型串。 */
const JSON_UTF8 = "application/json; charset=utf-8";
function toBridgeResponse(id, result) {
	if (result.kind === "file") return {
		id,
		status: 200,
		contentType: result.contentType,
		file: result.file
	};
	if (result.kind === "text") return {
		id,
		status: result.status,
		contentType: TEXT_UTF8,
		body: result.body
	};
	if (result.kind === "none") return {
		id,
		status: 204,
		contentType: TEXT_UTF8,
		body: ""
	};
	return {
		id,
		status: result.status,
		contentType: JSON_UTF8,
		body: JSON.stringify(result.obj)
	};
}

//#endregion
//#region src/host/plugin/desktop/spawn.ts
/** 宿主是不是 DSH 桌面应用（Electron 宿主）。 */
const isDesktopHost = () => Boolean(process.versions.electron);
function resolveOpenTarget(siteUrl, desktopHost) {
	if (desktopHost) return "desktop";
	return siteUrl.includes("/standalone-ai/") ? "standalone" : "web";
}
function createDesktopSpawn(deps) {
	const { ctx, getHandlePetRoute, log, reportDownload, thumbUserRoot, getHasDesktopPet, desktopPetList, getTrayOn } = deps;
	let desktopModeEverActive = false;
	let helper;
	let startRetryTimer;
	let electronEnsure;
	let disposed = false;
	let displayWarned = false;
	let noDesktopSkipped = false;
	let portWaitAttempts = 0;
	const inProcessHost = process.env.DSH_PET_IN_PROCESS === "1";
	const launchHelper = (electronPath) => {
		if (inProcessHost) return;
		if (helper || disposed) return;
		if (!getHasDesktopPet() && !(desktopModeEverActive && getTrayOn())) return;
		const port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
		if (!port || port <= 0) {
			portWaitAttempts += 1;
			if (portWaitAttempts === 1) log.info(`[dsh-pet] webServer 端口尚未就绪（port=${String(port)}），每 500ms 重试拉起桌面 Helper`);
			else if (portWaitAttempts % 20 === 0) log.warn(`[dsh-pet] 已等待 webServer 端口 ${portWaitAttempts * 500 / 1e3}s 仍未就绪（port=${String(port)}），桌面 Helper 尚未拉起`);
			if (!startRetryTimer) {
				startRetryTimer = setTimeout(() => {
					startRetryTimer = void 0;
					launchHelper(electronPath);
				}, 500);
				startRetryTimer.unref?.();
			}
			return;
		}
		portWaitAttempts = 0;
		let origin = `http://127.0.0.1:${port}`;
		try {
			origin = ctx.webServer.getOrigin();
		} catch {}
		const siteUrl = ctx.connection.authenticatedUrl(origin);
		const configUrl = `${origin}${ROUTE_SEGMENT}/config`;
		helper = new HelperProcess({
			electronPath,
			env: {
				DSH_PET_CONFIG_URL: configUrl,
				DSH_PET_SITE_URL: siteUrl,
				DSH_PET_OPEN_TARGET: resolveOpenTarget(siteUrl, isDesktopHost()),
				DSH_PET_SCALE: "1",
				DSH_PET_BRIDGE: "1",
				DSH_PET_PETS: JSON.stringify(desktopPetList())
			},
			bridgeHandler: async (req) => {
				const result = await getHandlePetRoute()(req.url ?? "/", req.method ?? "GET", req.body);
				return toBridgeResponse(req.id, result);
			}
		}, log);
		try {
			helper.start();
			desktopModeEverActive = true;
			log.info(`dsh-pet desktop helper started (config: ${configUrl})`);
		} catch (e) {
			log.warn(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
			helper = void 0;
		}
	};
	const startHelper = () => {
		if (inProcessHost) return;
		if (helper || electronEnsure || disposed) return;
		if (!getHasDesktopPet() && !(desktopModeEverActive && getTrayOn())) {
			if (!noDesktopSkipped) {
				noDesktopSkipped = true;
				log.info(`[dsh-pet] 无桌面宠物（display 均为 web/none）且无需保留托盘（tray=${getTrayOn()}），已跳过桌面 Helper 启动`);
			}
			return;
		}
		if (!hasGraphicalDisplay()) {
			if (!displayWarned) {
				displayWarned = true;
				log.warn("[dsh-pet] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_PET_DESKTOP_FORCE=1。");
			}
			return;
		}
		const found = resolveElectronPath();
		if (found) {
			launchHelper(found);
			return;
		}
		log.warn(`[dsh-pet] 未找到 Electron 可执行文件：DSH_HOME=${dshHomeDir()}，查找路径=${defaultElectronExe()}，DSH_PET_ELECTRON_PATH=${process.env.DSH_PET_ELECTRON_PATH ?? "(未设置)"}`);
		log.warn(`[dsh-pet] 开始下载 Electron 到 ${defaultElectronExe()} ...`);
		electronEnsure = ensureElectronDownload({
			onLog: ({ text, level, done }) => reportDownload(text, level === "warn" ? "error" : done ? "success" : "working", done),
			logger: log
		}).then((path) => {
			if (path) launchHelper(path);
			else log.warn("[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.");
		}).finally(() => {
			electronEnsure = void 0;
		});
	};
	const stopHelper = (reason = "settings-change") => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		helper?.stop(reason);
		helper = void 0;
	};
	const stopHelperAndWait = async (reason) => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		const old = helper;
		helper = void 0;
		await old?.stopAndWait(reason);
	};
	const animSubdirFor = (ext) => ext === ".mov" ? "mov" : "webm";
	const assetRootFor = (ext) => join(PACKAGE_ROOT, "assets", animSubdirFor(ext));
	const userRootFor = (ext) => join(thumbUserRoot, animSubdirFor(ext));
	const markDisposed = () => {
		disposed = true;
	};
	return {
		startHelper,
		stopHelper,
		stopHelperAndWait,
		markDisposed,
		assetRootFor,
		userRootFor
	};
}

//#endregion
//#region src/host/plugin/desktop/sync.ts
function createDesktopSync(deps) {
	const { log, logDesktopDecision, desktopPetList, startHelper, stopHelperAndWait } = deps;
	/** 同进程内跑 helper（打包应用）：没有子进程可重启，只能让 helper 自己重建窗口。 */
	const inProcessHost = process.env.DSH_PET_IN_PROCESS === "1";
	let desktopSyncQueue = Promise.resolve();
	const restartDesktop = () => {
		desktopSyncQueue = desktopSyncQueue.then(async () => {
			logDesktopDecision();
			if (inProcessHost) {
				process.env.DSH_PET_PETS = JSON.stringify(desktopPetList());
				await globalThis.__dshPetRebuildUi?.();
				return;
			}
			await stopHelperAndWait("desktop-config-change");
			startHelper();
		}).catch((e) => {
			log.warn(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
		});
		return desktopSyncQueue;
	};
	return { requestRestart: restartDesktop };
}

//#endregion
//#region src/host/plugin/desktop-helper.ts
function createDesktopHelper(deps) {
	const pets = createDesktopPets(deps);
	const spawn$1 = createDesktopSpawn({
		...deps,
		...pets
	});
	const sync = createDesktopSync({
		...deps,
		...pets,
		...spawn$1
	});
	return {
		startHelper: spawn$1.startHelper,
		stopHelper: spawn$1.stopHelper,
		requestRestart: sync.requestRestart,
		assetRootFor: spawn$1.assetRootFor,
		userRootFor: spawn$1.userRootFor,
		markDisposed: spawn$1.markDisposed
	};
}

//#endregion
//#region src/host/plugin/balance-poll.ts
function createBalancePoll(deps) {
	const { ctx, configPaths, getActivePetId, log, state, standaloneAiBalance } = deps;
	/** 当前生效宠物列表：成品配置拍平（合并器已保证 id 唯一、字段填满），命令与桌面模式共用。 */
	const effectivePetList = () => flattenPetList(readAllConfig(configPaths));
	/** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
	const balancePeriodSec = (cfg) => {
		const ers = cfg.main?.eventsRefreshSec;
		const n = Number(ers?.balance);
		return Number.isFinite(n) && n > 0 ? n : 1800;
	};
	/** 碎碎念周期（秒）：该宠物所属条目的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300）。
	*  收已解析的条目配置：唯一调用方是周期调度，它的 petId 就是从同一份 cfg 拍平出来的。 */
	const whisperPeriodSec = (conf) => {
		const ers = conf.eventsRefreshSec;
		const n = Number(ers?.whisper);
		return Number.isFinite(n) && n > 0 ? n : 300;
	};
	/**
	* 账号服务要求的调用方身份（`AccountClientMetadata`）：只影响请求来源标识与服务端本地化文案，
	* 不参与余额数值与币种。version 读自身 package.json（读不到回落 '0.0.0'）；locale 固定 zh-CN。
	*/
	const accountClientMetadata = () => {
		let version = "0.0.0";
		try {
			const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
			if (typeof raw.version === "string" && raw.version.length > 0) version = raw.version;
		} catch {}
		return {
			version,
			locale: "zh-CN",
			timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
		};
	};
	/**
	* 刷新余额并写入轮询状态：host 侧唯一的余额查询点，两端从 /state 读同一份结果。
	* 失败也写进状态（reason 区分 unsupported / credential-missing / fetch-error）：余额不可用要弹
	* 文字说明，不能静默；意外异常同样落成 fetch-error。
	*
	* @param manual - 这次刷新是否由用户触发（/balance 命令、桌面「查看余额」菜单）；标记随数据写进
	*   叶子，前端据此决定余额不可用时是否必弹文字说明（周期刷新只在原因变化时弹一次）。
	*/
	const refreshBalance = async (manual = false) => {
		log.info(`[dsh-pet] 余额刷新开始（${manual ? "手动" : "周期"}）`);
		const mark = (v) => manual ? {
			...v,
			manual: true
		} : v;
		try {
			const standalone = standaloneAiBalance();
			const provider = standalone?.provider || ctx.agentDefaultModel.currentSelection().provider;
			const result = await queryBalance(
				provider,
				async (ref) => {
					if (standalone?.apiKey) return standalone.apiKey;
					const rc = await ctx.credentials.resolve(credentialRef(ref));
					return rc?.value;
				},
				// `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
				// 持有的授权记录，只能经 getBalance 查询。账号服务是可选服务（软取，不放进 inject）
				// ——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
				async () => {
					const account = ctx.get("deepseekAccount", false);
					if (!account) return void 0;
					return account.getBalance(accountClientMetadata());
				}
);
			state.writeSection("balance", mark(result));
			if (result.ok) log.info(`[dsh-pet] 余额刷新成功 provider=${result.provider}（${result.shape}）`);
			else log.warn(`[dsh-pet] 余额刷新失败 provider=${result.provider} reason=${result.reason}` + (result.message ? " " + result.message : ""));
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			state.writeSection("balance", mark({
				ok: false,
				provider: "unknown",
				reason: "fetch-error",
				message
			}));
			log.warn("[dsh-pet] 余额刷新异常：" + message);
		}
	};
	/** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
	const resolveActivePetId = () => {
		try {
			const eff = effectivePetList();
			if (eff.length === 0) return "";
			if (getActivePetId() && eff.some((p) => String(p.id) === getActivePetId())) return getActivePetId();
			return String(eff[0].id);
		} catch {
			return getActivePetId();
		}
	};
	/** 宠物的显示名（name，缺失回落 id）——命令文案用 */
	const petDisplayName = (pet) => {
		const n = String(pet.name ?? "").trim();
		return n || String(pet.id ?? "");
	};
	return {
		effectivePetList,
		balancePeriodSec,
		whisperPeriodSec,
		refreshBalance,
		resolveActivePetId,
		petDisplayName
	};
}

//#endregion
//#region src/host/chat-action.ts
function chatActionNames(animations) {
	const a = animations && typeof animations === "object" ? animations : {};
	if (!Array.isArray(a.categories)) return [];
	const out = [];
	for (const category of a.categories) {
		if (!category || typeof category !== "object") continue;
		const actions = category.actions;
		if (!Array.isArray(actions)) continue;
		for (const name$1 of actions) {
			if (typeof name$1 !== "string" || name$1 === "") continue;
			if (!out.includes(name$1)) out.push(name$1);
		}
	}
	return out;
}
function actionInstruction(names) {
	return "\n\n[动作] 回复结尾可选做一个动作给用户看，从下列清单里挑最贴合当前语境的：\n" + names.map((name$1) => "- " + name$1).join("\n") + "\n挑中就在回复最后另起一行写 [动作:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。";
}
function extractChatAction(text, names) {
	const tag = /\[动作[:：]\s*([^\]\n]+?)\s*\]/g;
	let action;
	let tagged = false;
	const cleaned = text.replace(tag, (_tag, raw) => {
		tagged = true;
		const name$1 = raw.trim();
		if (action === void 0 && names.includes(name$1)) action = name$1;
		return "";
	});
	if (!tagged) return { text };
	const body = cleaned.replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n").trim();
	return action === void 0 ? { text: body } : {
		text: body,
		action
	};
}

//#endregion
//#region src/host/chat-acts.ts
/**
* 对话里的「真去做事」标记：改名、记住、改大小、换角落。
*
* 与动作/配图/提醒同一套机制——模型在回复末尾附一个方括号标记，宿主剥掉它并真的执行。
* 这里只做纯文本解析与指令拼装，不碰配置、不写文件：
* - 改名 / 大小 / 角落由 ./plugin/chat-memory 调 `renamePet` / `configurePet`
*   （走 `saveUserConfig`，与设置页同一条写盘路径）；
* - 「记住」由 ./soul 追加进 `growth.md`。
*
* 标记故意用中文且与正文区分明显：模型照抄过一次也不会被误当成玩笑话。
* @module dsh-pet/src/host/chat-acts
*/
/** 改名标记：`[改名:新名字]` */
const RENAME_RE = /\[改名[:：]\s*([^[\]\n]{1,40})\]/gu;
/** 大小标记：`[大小:1.2]`（倍率，0.5–3） */
const SIZE_RE = /\[大小[:：]\s*([^[\]\n]{1,12})\]/gu;
/** 位置标记：`[位置:右下]`（也可写 top-left 等） */
const CORNER_RE = /\[位置[:：]\s*([^[\]\n]{1,20})\]/gu;
/** 记住标记：`[记住:一句话]` */
const REMEMBER_RE = /\[记住[:：]\s*([^[\]\n]{1,300})\]/gu;
const ACT_NAME_MAX = 20;
const ACT_SIZE_MIN = .5;
const ACT_SIZE_MAX = 3;
/** 中文落点 → 配置里的 corner 值。 */
const CORNERS = {
	左上: "top-left",
	右上: "top-right",
	左下: "bottom-left",
	右下: "bottom-right",
	"top-left": "top-left",
	"top-right": "top-right",
	"bottom-left": "bottom-left",
	"bottom-right": "bottom-right"
};
/**
* 「去屏幕中间」的说法。中间不是一个 corner——它不写进配置（下次启动仍回原来的角落），
* 只是一次性的位置指令：游过去、待在那儿，等下一次位置指令或重启再回角落。
*/
const CENTER_WORDS = new Set([
	"中间",
	"中央",
	"正中",
	"中心",
	"屏幕中间",
	"桌面中间",
	"屏幕中央",
	"中间一点"
]);
const ACT_REMEMBER_MAX = 200;
/** 把模型写出来的名字整理成能落盘的形式：去引号/空白/句末标点，限长。 */
function cleanName(raw) {
	const name$1 = raw.trim().replace(/^[「『"'“”‘’]+|[」』"'“”‘’]+$/gu, "").replace(/[。！？!?,，、\s]+$/u, "").trim().slice(0, ACT_NAME_MAX);
	return name$1;
}
/** 把「记住」的内容整理成一行；全是标点/空白时返回空串（没有可记的东西）。 */
function cleanRemember(raw) {
	const body = raw.trim().replace(/\s+/gu, " ").slice(0, ACT_REMEMBER_MAX);
	return /[\p{L}\p{N}]/u.test(body) ? body : "";
}
function extractChatActs(text) {
	let rename$1;
	let remember;
	let size;
	let corner;
	let center;
	const stripped = text.replace(RENAME_RE, (_match, raw) => {
		const name$1 = cleanName(raw);
		if (name$1 !== "") rename$1 = name$1;
		return "";
	}).replace(REMEMBER_RE, (_match, raw) => {
		const body = cleanRemember(raw);
		if (body !== "") remember = body;
		return "";
	}).replace(SIZE_RE, (_match, raw) => {
		const value = Number(raw.trim());
		if (Number.isFinite(value) && value > 0) size = Math.min(ACT_SIZE_MAX, Math.max(ACT_SIZE_MIN, value));
		return "";
	}).replace(CORNER_RE, (_match, raw) => {
		const value = raw.trim();
		const mapped = CORNERS[value];
		if (mapped !== void 0) corner = mapped;
		else if (CENTER_WORDS.has(value)) center = true;
		return "";
	}).trim();
	return {
		text: stripped,
		...rename$1 !== void 0 ? { rename: rename$1 } : {},
		...remember !== void 0 ? { remember } : {},
		...size !== void 0 ? { size } : {},
		...corner !== void 0 ? { corner } : {},
		...center !== void 0 ? { center } : {}
	};
}
function actInstruction() {
	return "\n\n【你能真的做事】你不只会说话，还能真的改变自己（写了标记就会立刻生效，主人看得见）：\n- 主人给你取新名字 → 回复末尾附 [改名:新名字]\n- 主人要你长久记住一件事 → 回复末尾附 [记住:一句话]\n- 主人说你太大/太小、让你变大变小 → 回复末尾附 [大小:倍率]（相对现在，0.5 到 3；「一点」约 1.2，「很多」约 1.5）\n- 主人让你换个角落待着 → 回复末尾附 [位置:左上|右上|左下|右下]\n- 主人让你到屏幕中间 / 桌面中间 → 回复末尾附 [位置:中间]\n「变大一点」「挪到左上角」这类就是明确要求，必须附标记——只嘴上答应、不附标记，等于没做。\n标记写在回复最后一行，正文照常自然地说，不要向主人解释标记本身。闲聊不要加。";
}

//#endregion
//#region src/host/chat-reminder.ts
const REMINDER_MIN_SECONDS = 5;
const REMINDER_MAX_SECONDS = 7 * 24 * 60 * 60;
const REMINDER_TITLE_MAX = 40;
/** 时间单位的秒数换算。 */
const UNIT_SECONDS = {
	秒: 1,
	s: 1,
	分: 60,
	分钟: 60,
	m: 60,
	小时: 3600,
	h: 3600,
	天: 86400,
	d: 86400
};
function reminderNowText(now) {
	const pad = (n) => String(n).padStart(2, "0");
	const week = [
		"周日",
		"周一",
		"周二",
		"周三",
		"周四",
		"周五",
		"周六"
	][now.getDay()] ?? "";
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}${week === "" ? "" : "（" + week + "）"}`;
}
function reminderInstruction(now) {
	return `

[提醒] 用户让你在某个时间点提醒他做某件事时（例如「两分钟后提醒我开会」「明天 9 点叫我起床」），先算出现在到那一刻还有多少秒，然后在回复最后另起一行写 [提醒:秒数|事项]。秒数是 1 到 ${REMINDER_MAX_SECONDS} 之间的整数（最长 7 天），事项不超过 ${REMINDER_TITLE_MAX} 个字、只说做什么；正文里先用一句话确认「好，几点提醒你做什么」。只写一条；用户没让你提醒时绝对不要写这个标记。现在是 ${reminderNowText(now)}。`;
}
function extractChatReminder(text) {
	const tag = /\[提醒[:：]\s*([^\]\n]{1,120})\]/g;
	let reminder;
	let tagged = false;
	const cleaned = text.replace(tag, (_tag, raw) => {
		tagged = true;
		if (reminder === void 0) {
			const parsed = parseTagBody(raw);
			if (parsed !== null) reminder = parsed;
		}
		return "";
	});
	if (!tagged) return { text };
	const body = cleaned.replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n").trim();
	return reminder === void 0 ? { text: body } : {
		text: body,
		reminder
	};
}
/**
* 解析标记体：`秒数[单位]|事项`。
*
* @param raw - 方括号里的内容（已去掉 `[提醒:` 与 `]`）。
* @returns 合法提醒；秒数不合法、缺分隔符或事项为空时返回 null。
*/
function parseTagBody(raw) {
	const cut = raw.search(/[|｜]/);
	if (cut < 0) return null;
	const delayText = raw.slice(0, cut).trim();
	const title = raw.slice(cut + 1).trim().replace(/[。．.]+$/, "");
	if (title === "" || title.length > REMINDER_TITLE_MAX) return null;
	const m = /^([0-9]+(?:\.[0-9]+)?)\s*(秒|分钟|分|小时|天|s|m|h|d)?$/i.exec(delayText);
	if (m === null) return null;
	const amount = Number(m[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const unit = m[2] === void 0 ? 1 : UNIT_SECONDS[m[2].toLowerCase()] ?? UNIT_SECONDS[m[2]];
	if (unit === void 0) return null;
	const seconds = Math.round(amount * unit);
	if (seconds < REMINDER_MIN_SECONDS || seconds > REMINDER_MAX_SECONDS) return null;
	return {
		seconds,
		title
	};
}

//#endregion
//#region src/host/llm-call.ts
const PET_CALL_IDENTITY = "dsh-pet";
function noTextReason(finish) {
	const { kind, failure } = finish ?? {};
	if (kind === "aborted") return "生成已取消";
	if (kind === "max-tokens") return "输出达到上限，未产出正文";
	if (kind !== "error") return "模型未返回文本";
	const { message, code } = failure ?? {};
	if (typeof message === "string" && message.trim() !== "") return message;
	if (typeof code === "string" && code.trim() !== "") return code;
	return "未提供失败原因";
}

//#endregion
//#region src/host/llm-reasoning.ts
async function supportsReasoningOff(ctx, provider, model) {
	const llm = ctx.llm;
	if (!llm || typeof llm.resolveModelInfo !== "function") return false;
	try {
		const info = await llm.resolveModelInfo(provider, model);
		return info?.reasoning?.efforts?.some((e) => e.id === "off") ?? false;
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/model-selection.ts
function configuredModel(conf, key) {
	const raw = conf?.[key];
	if (!raw || typeof raw !== "object") return void 0;
	const m = raw;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return void 0;
	const provider = m.provider.trim();
	const model = m.model.trim();
	return provider && model ? {
		provider,
		model
	} : void 0;
}
function currentModel(ctx) {
	try {
		const sel = ctx.agentDefaultModel?.currentSelection();
		return sel?.provider && sel?.model ? {
			provider: sel.provider,
			model: sel.model
		} : void 0;
	} catch {
		return void 0;
	}
}
function modelCandidates(ctx, preferred) {
	const out = [];
	const push = (m) => {
		if (!m) return;
		if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
		out.push(m);
	};
	push(preferred);
	push(currentModel(ctx));
	return out;
}
function modelLabel(m) {
	return m.provider + "/" + m.model;
}

//#endregion
//#region src/host/time-context/constants.ts
/**
* 时段划分表：[起始小时, 时段]，按起始小时从晚到早排列——匹配时取第一个不超过当前小时的档。
* 口径含起始小时（0–23 全覆盖、不重叠）：凌晨 0–4、清晨 5–6、早上 7–8、上午 9–10、中午 11–12、
* 下午 13–16、傍晚 17–18、晚上 19–22、深夜 23。
*/
const SLOTS = [
	[23, "深夜"],
	[19, "晚上"],
	[17, "傍晚"],
	[13, "下午"],
	[11, "中午"],
	[9, "上午"],
	[7, "早上"],
	[5, "清晨"],
	[0, "凌晨"]
];
const WEEKDAYS = [
	"星期日",
	"星期一",
	"星期二",
	"星期三",
	"星期四",
	"星期五",
	"星期六"
];
const DAY_MS$1 = 864e5;
const DEFAULT_AHEAD = 3;
const DEFAULT_SPAN = 1;
const DEFAULT_AFTER = 3;
const SEASON_AHEAD = 3;
const SEASON_ENDING_AHEAD = 3;
const SEASON_AFTER = 3;
function pad2(n) {
	return String(n).padStart(2, "0");
}
function timeSlotOf(hour) {
	for (const [start, slot] of SLOTS) if (hour >= start) return slot;
	return "凌晨";
}
function dayKindOf(day) {
	return day === 0 || day === 6 ? "周末" : "工作日";
}

//#endregion
//#region src/host/time-context/entries.ts
/**
* 顺序 = 优先级（靠前的先说话）。一天只出一个从句，所以同一天被多个节日/假期覆盖时，谁在数组里
* 靠前就由谁说；想改优先级就挪那几行，不必动逻辑。几条硬约束：只有当天值得说的小节排在邻座之前
* 并掐掉回味；除夕、元宵必须排在春节之前；寒暑假排在传统节日之后、纪念日之前——假期里的节日仍由
* 节日说话，7/1 这类与纪念日撞车的日子则由暑假说话。`ahead / span / after` 缺省 3 / 1 / 3。
*/
const PRIORITY = [
	{
		kind: "solar",
		key: "2-14",
		name: "情人节",
		after: 0
	},
	{
		kind: "solar",
		key: "12-31",
		name: "跨年夜",
		after: 0
	},
	{
		kind: "solar",
		key: "4-1",
		name: "愚人节",
		after: 0
	},
	{
		kind: "solar",
		key: "5-4",
		name: "青年节",
		ahead: 0,
		after: 0
	},
	{
		kind: "lunarEve",
		name: "除夕",
		ahead: 1,
		after: 0
	},
	{
		kind: "lunar",
		key: "1-15",
		name: "元宵节"
	},
	{
		kind: "lunar",
		key: "1-1",
		name: "春节",
		spoken: "大年初一",
		span: 15
	},
	{
		kind: "lunar",
		key: "8-15",
		name: "中秋节",
		span: 3,
		after: 2
	},
	{
		kind: "solar",
		key: "10-1",
		name: "国庆节",
		span: 7
	},
	{
		kind: "solar",
		key: "1-1",
		name: "元旦",
		spoken: "新年第一天",
		span: 3
	},
	{
		kind: "lunar",
		key: "5-5",
		name: "端午节",
		span: 3
	},
	{
		kind: "solar",
		key: "4-4",
		name: "清明节",
		span: 3,
		ahead: 1
	},
	{
		kind: "solar",
		key: "5-1",
		name: "劳动节",
		span: 3
	},
	{
		kind: "solar",
		key: "6-1",
		name: "儿童节"
	},
	{
		kind: "lunar",
		key: "7-7",
		name: "七夕"
	},
	{
		kind: "lunar",
		key: "7-15",
		name: "中元节"
	},
	{
		kind: "lunar",
		key: "2-2",
		name: "龙抬头"
	},
	{
		kind: "lunar",
		key: "9-9",
		name: "重阳节"
	},
	{
		kind: "lunar",
		key: "12-8",
		name: "腊八节"
	},
	{
		kind: "lunar",
		key: "12-23",
		name: "小年"
	},
	{
		kind: "season",
		from: "1-20",
		to: "2-18",
		name: "寒假"
	},
	{
		kind: "season",
		from: "7-1",
		to: "8-29",
		name: "暑假"
	},
	{
		kind: "solar",
		key: "3-8",
		name: "妇女节"
	},
	{
		kind: "solar",
		key: "9-10",
		name: "教师节"
	},
	{
		kind: "solar",
		key: "7-1",
		name: "建党节"
	},
	{
		kind: "solar",
		key: "8-1",
		name: "建军节"
	},
	{
		kind: "solar",
		key: "10-31",
		name: "万圣夜"
	},
	{
		kind: "solar",
		key: "12-24",
		name: "平安夜",
		after: 0
	},
	{
		kind: "solar",
		key: "12-25",
		name: "圣诞节"
	}
];
const SOLAR_INDEX = new Map();
const LUNAR_INDEX = new Map();
const SEASON_ENTRIES = [];
let LUNAR_EVE;
PRIORITY.forEach((entry, priority) => {
	if (entry.kind === "solar") SOLAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunar") LUNAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunarEve") LUNAR_EVE = {
		entry,
		priority
	};
	else SEASON_ENTRIES.push({
		entry,
		priority,
		from: entry.from,
		to: entry.to
	});
});
/** 条目里最长的预热天数与回看距离（长假 15 天 + 回味 3 天），据此决定扫描窗口。 */
const HOLIDAY_ENTRIES = PRIORITY.filter((e) => e.kind !== "season");
const MAX_AHEAD = Math.max(...HOLIDAY_ENTRIES.map((e) => e.ahead ?? DEFAULT_AHEAD));
const MAX_LOOKBACK = Math.max(...HOLIDAY_ENTRIES.map((e) => (e.span ?? DEFAULT_SPAN) - 1 + (e.after ?? DEFAULT_AFTER)));

//#endregion
//#region src/host/time-context/lunar.ts
/** ICU 中国农历格式器；null = 已判定本环境不可用（不重试、不抛错）。 */
let lunarFormatter;
/**
* 取 ICU 农历格式器。Intl 在缺少该日历时不会抛错，而是静默退回公历——那会让每个月都被当成农历
* 同月同日，所以用 resolvedOptions().calendar 确认它真的解析成了 'chinese'，否则一律判不可用。
*/
function getLunarFormatter() {
	if (lunarFormatter === null) return void 0;
	if (!lunarFormatter) {
		const fmt = new Intl.DateTimeFormat("en-u-ca-chinese", {
			month: "numeric",
			day: "numeric",
			year: "numeric"
		});
		lunarFormatter = fmt.resolvedOptions().calendar === "chinese" ? fmt : null;
	}
	return lunarFormatter ?? void 0;
}
function dayOfYear(date) {
	return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / DAY_MS$1;
}
function dayOfYearOf(year, monthDay) {
	const [month, day] = monthDay.split("-").map(Number);
	return (Date.UTC(year, (month ?? 1) - 1, day ?? 1) - Date.UTC(year, 0, 1)) / DAY_MS$1;
}
/**
* 公历日期 → 农历月日。
*
* 已知精度边界（已评估并接受）：朔时刻贴近 UTC+8 午夜时 ICU 会把农历初一放错一天——2025–2060 的
* 445 个月起点里错 2 个，都是正月（2027-02-06 距午夜 8 分钟、2030-02-03 距午夜 5 分钟），表现为那
* 两年春节与元宵各差一天；2027 一例已与香港天文台官方对照表核对。要绝对准确只需换掉本函数实现
* （换库或加修正表），下游逻辑一行不用动。
* @returns 农历月/日（闰月 month 为负）；环境不支持农历、取不到月日，或农历年与公历年不吻合
*   （自洽校验：农历年只可能是当年或前一年，挡住 ICU 退化时把公历当农历返回）→ undefined。
*/
function lunarPartsOf(date) {
	const fmt = getLunarFormatter();
	if (!fmt) return void 0;
	const parts = fmt.formatToParts(date);
	const pick$1 = (type) => parts.find((p) => p.type === type)?.value;
	const rawMonth = pick$1("month");
	const rawDay = pick$1("day");
	const rawYear = pick$1("relatedYear") ?? pick$1("year");
	if (!rawMonth || !rawDay || !rawYear) return void 0;
	const month = Number.parseInt(rawMonth, 10);
	const day = Number.parseInt(rawDay, 10);
	const year = Number.parseInt(rawYear, 10);
	if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return void 0;
	const gregorianYear = date.getFullYear();
	if (year !== gregorianYear && year !== gregorianYear - 1) return void 0;
	return {
		month: /bis/i.test(rawMonth) ? -month : month,
		day
	};
}
/** 当天是否是除夕（腊月最后一天：次日为正月初一即成立，廿九/三十都能认）。 */
function isLunarEve(date) {
	const today = lunarPartsOf(date);
	if (!today || today.month !== 12) return false;
	const next = lunarPartsOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
	return Boolean(next && next.month === 1 && next.day === 1);
}
function entriesAt(date) {
	const out = [];
	const solar = SOLAR_INDEX.get(date.getMonth() + 1 + "-" + date.getDate());
	if (solar) out.push(solar);
	const lunar = lunarPartsOf(date);
	if (lunar && lunar.month > 0) {
		const hit = LUNAR_INDEX.get(lunar.month + "-" + lunar.day);
		if (hit) out.push(hit);
	}
	if (LUNAR_EVE && isLunarEve(date)) out.push(LUNAR_EVE);
	return out;
}

//#endregion
//#region src/host/time-context/context.ts
/**
* 相位 → 从句措辞。
* @param entry - 节日条目；`name`/`spoken`/`span` 决定措辞与默认窗口。
* @param delta - 相对节日起始日的天数：> 0 = 还有这么多天；0 = 起始当天；< 0 = 已在节期内或过后。
*/
function phraseOf(entry, delta) {
	const span = entry.span ?? DEFAULT_SPAN;
	if (delta > 0) return delta === 1 ? "明天就是" + entry.name : "快要过" + entry.name + "了";
	if (delta === 0) return "今天是" + (entry.spoken ?? entry.name);
	const daysIn = -delta;
	if (daysIn < span) return span - daysIn === 1 ? entry.name + "假期最后一天了" : "还在" + entry.name + "假期里";
	const rest = daysIn - span;
	return rest <= 1 ? entry.name + "刚过完" : entry.name + "这么快就过完了";
}
/**
* 条目 → 候选从句（不在自身窗口内则返回 undefined）。
* @param ranked - 已排序条目；`priority` 高者先出候选。
* @param delta - 相对节日起始日的天数。
*/
function candidateOf(ranked, delta) {
	const { entry, priority } = ranked;
	const ahead = entry.ahead ?? DEFAULT_AHEAD;
	const span = entry.span ?? DEFAULT_SPAN;
	const after = entry.after ?? DEFAULT_AFTER;
	const daysIn = -delta;
	if (delta > 0) {
		if (delta > ahead) return void 0;
	} else if (delta < 0) {
		if (daysIn >= span + after) return void 0;
	}
	return {
		clause: phraseOf(entry, delta),
		priority
	};
}
/** 假期区间 → 候选从句（不在窗口内返回 undefined）。 */
function seasonCandidateOf(date) {
	const year = date.getFullYear();
	const today = dayOfYear(date);
	for (const ranked of SEASON_ENTRIES) {
		const { entry, priority, from: fromMd, to: toMd } = ranked;
		const name$1 = entry.name;
		const from = dayOfYearOf(year, fromMd);
		const to = dayOfYearOf(year, toMd);
		if (today < from) {
			const ahead = from - today;
			if (ahead > SEASON_AHEAD) continue;
			return {
				clause: ahead === 1 ? "明天就放" + name$1 + "了" : "快要放" + name$1 + "了",
				priority
			};
		}
		if (today <= to) {
			if (today === from) return {
				clause: name$1 + "开始了",
				priority
			};
			if (to - today < SEASON_ENDING_AHEAD) return {
				clause: name$1 + "快结束了",
				priority
			};
			return {
				clause: "正在放" + name$1,
				priority
			};
		}
		const rest = today - to - 1;
		if (rest >= SEASON_AFTER) continue;
		return {
			clause: rest <= 1 ? name$1 + "刚结束" : name$1 + "这么快就过完了",
			priority
		};
	}
	return void 0;
}
/**
* 节日从句：扫描窗口内枚举每一天命中的条目、算出各自相位与措辞，取优先级最小（数组里最靠前）的那个。
* @returns 如「今天是大年初一」「快要过国庆节了」「还在春节假期里」「正在放暑假」；无节日时 ''。
*/
function holidayClauseOf(date) {
	let best;
	const keep = (candidate) => {
		if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
	};
	for (let delta = -MAX_LOOKBACK; delta <= MAX_AHEAD; delta++) {
		const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
		for (const ranked of entriesAt(day)) keep(candidateOf(ranked, delta));
	}
	keep(seasonCandidateOf(date));
	return best ? best.clause : "";
}
function timeContextOf(date) {
	if (Number.isNaN(date.getTime())) return "";
	const day = date.getDay();
	const hour = date.getHours();
	const holiday = holidayClauseOf(date);
	return "【当下】现在是" + date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日" + (WEEKDAYS[day] ?? "星期?") + " " + pad2(hour) + ":" + pad2(date.getMinutes()) + "，" + timeSlotOf(hour) + "，" + dayKindOf(day) + (holiday ? "，" + holiday : "") + "。这只是背景，不必刻意报时，也别句句都提节日——多数时候正常说话就好，真贴切时才顺口带一句。";
}
function historyStampOf(ts, now) {
	const at = new Date(ts);
	if (Number.isNaN(at.getTime()) || Number.isNaN(now.getTime())) return "";
	const date = (at.getFullYear() === now.getFullYear() ? "" : at.getFullYear() + "年") + (at.getMonth() + 1) + "月" + at.getDate() + "日";
	return date + " " + pad2(at.getHours()) + ":" + pad2(at.getMinutes());
}

//#endregion
//#region src/host/chat.ts
/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够。 */
const TIMEOUT_MS$1 = 6e4;
/** 历史消息打时间前缀的阈值（ms）：30 分钟内的连续对话不加，避免每句都多几个 token。 */
const HISTORY_STAMP_GAP_MS = 30 * 60 * 1e3;
/**
* user 历史消息的正文：距现在超过阈值时，前面加 `[10月31日 22:53]`。
*
* 只给 user 打：同一轮 user / assistant 共享同一个 ts，标一条就够；标在 assistant 上时，
* 模型会把这行当成自己的说话格式照抄（实际出现过回复以 `[11:54]` 开头）。
* 阈值内的连续对话不加前缀——否则一段正常闲聊会变成每句一个时间戳。
*
* @param message - 历史消息（带 ts）。
* @param nowMs - 本次生成时刻（毫秒），整批历史共用一个，避免逐条取时钟导致同批时间不一致。
* @returns 需要前缀时返回 `[时:分] 原文`，否则原样返回 `content`。
*/
function userHistoryTextOf(message, nowMs) {
	if (!Number.isFinite(message.ts)) return message.content;
	if (!(nowMs - message.ts > HISTORY_STAMP_GAP_MS)) return message.content;
	const stamp = historyStampOf(message.ts, new Date(nowMs));
	return stamp === "" ? message.content : "[" + stamp + "] " + message.content;
}
/**
* 历史里回填的配图 / 动作标记（`[动作:名称]` 与 `[图:名称]`，各占一行，顺序固定）。
*
* 记忆里只存名字、正文里的标记在落盘前已被剥掉；不回填的话模型看不到自己前几轮配过哪张图、
* 演过什么动作，用户说“换一个”时它连换的是什么都不知道，只会重复挑同一张或答非所问。
* 只回填 assistant：user 的附件引用依旧不带（旧图不重发给模型）。
* 名称可能为空串（手改过记忆文件）——空值不回填，纯文本历史逐字不变。
*
* @param message - 历史消息。
* @returns 需要回填时返回 `\n[动作:…]\n[图:…]`，否则空串。
*/
function historyMarkersOf(message) {
	if (message.role !== "assistant") return "";
	const lines = [];
	if (typeof message.action === "string" && message.action !== "") lines.push("[动作:" + message.action + "]");
	if (typeof message.meme === "string" && message.meme !== "") lines.push("[图:" + message.meme + "]");
	return lines.length === 0 ? "" : "\n" + lines.join("\n");
}
/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守）。
*  交给模型选而不是随机抽：对话有真实上下文（用户输入 + 历史），按语境挑才贴合。 */
function imageInstruction(pool$1) {
	return "\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n" + memeCatalog(pool$1) + "\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。";
}
async function generateChat(input) {
	const { ctx, system, history, userText, preferred, image } = input;
	const pool$1 = [...input.pool ?? []];
	const actions = [...input.actions ?? []];
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith$1(ctx, {
			llm,
			sel,
			system,
			history,
			userText,
			pool: pool$1,
			actions,
			image
		});
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) defaultLog("warn", `dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用一个确定的 provider/model 跑一次对话生成（失败原样返回结构化原因，不吞）。 */
async function generateWith$1(ctx, once) {
	const { llm, sel, system, history, userText, pool: pool$1, actions, image } = once;
	const nowMs = Date.now();
	const historyMessages = history.map((m) => m.role === "user" ? createUserMessage({
		content: [{
			type: "text",
			text: userHistoryTextOf(m, nowMs)
		}],
		source: { kind: "user" }
	}) : createAssistantMessage({
		content: [{
			type: "text",
			text: m.content + historyMarkersOf(m)
		}],
		source: {
			provider: sel.provider,
			model: sel.model
		}
	}));
	const deadline = AbortSignal.timeout(TIMEOUT_MS$1);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const wantImage = pool$1.length > 0;
	const wantAction = actions.length > 0;
	const instruction = (wantImage ? imageInstruction(pool$1) : "") + (wantAction ? actionInstruction(actions) : "") + reminderInstruction(new Date(nowMs)) + actInstruction();
	const content = [{
		type: "text",
		text: instruction === "" ? userText : userText + instruction
	}];
	if (image !== void 0) content.push({
		type: "image",
		attachment: image
	});
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [...historyMessages, createUserMessage({
			content,
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	const acted = wantAction ? extractChatAction(text, actions) : { text };
	const picked = wantImage ? extractChatImage(acted.text, pool$1) : { text: acted.text };
	const reminded = extractChatReminder(picked.text);
	const acts = extractChatActs(reminded.text);
	return {
		ok: true,
		text: acts.text,
		...picked.image ? { image: picked.image } : {},
		...acted.action ? { action: acted.action } : {},
		...reminded.reminder ? { reminder: reminded.reminder } : {},
		...acts.rename !== void 0 ? { rename: acts.rename } : {},
		...acts.remember !== void 0 ? { remember: acts.remember } : {},
		...acts.size !== void 0 ? { size: acts.size } : {},
		...acts.corner !== void 0 ? { corner: acts.corner } : {},
		...acts.center !== void 0 ? { center: acts.center } : {}
	};
}

//#endregion
//#region src/host/persona.ts
/**
* 历史时间说明：历史里 user 消息带 `[月日 时:分]` 前缀时追加，让模型知道那些时刻可以用来算跨度。
*
* 措辞把前缀限定为「对话记录里的时间标注」而不是「回复格式」；前缀只标在 user 消息上——
* 标在 assistant 上时模型会照抄成自己的说话格式（出现过回复以 `[11:54]` 开头）。
*/
const HISTORY_TIMES_LINE = "【历史】对话记录里，主人的话前面标着 [月日 时:分]，那是那句话发生的时刻；它只是记录里的时间标注，不是你的说话格式。判断“多久以前”“隔了几天”时按它换算，别把隔了很久的话当成刚说过的。你的回复直接从正文开始，不要写时间、不要加方括号前缀。";
function petPersona(conf, pet) {
	const own$1 = pet.whisperPrompt;
	if (typeof own$1 === "string" && own$1.trim() !== "") return own$1;
	const entry = conf.whisperPrompt;
	return typeof entry === "string" ? entry : "";
}
function composeSystemPrompt(parts) {
	const name$1 = String(parts.name || parts.id);
	const nameLine = name$1 ? "你的名字是“" + name$1 + "”。" : "";
	const soul = typeof parts.soul === "string" ? parts.soul.trim() : "";
	const growth = parts.growth ?? [];
	const lines = [
		parts.prompt,
		soul !== "" ? "【她写给自己的人格（soul.md，主人亲自写的，最高优先）】\n" + soul : "",
		nameLine
	].filter((line) => line !== "");
	if (growth.length > 0) lines.push("【你记得的事】\n" + growth.map((item) => "- " + item).join("\n"));
	const time = timeContextOf(parts.now);
	if (time) {
		lines.push(time);
		if (parts.historyTimes === true) lines.push(HISTORY_TIMES_LINE);
	}
	return lines.join("\n");
}

//#endregion
//#region src/host/soul.ts
const SOUL_FILE_NAME = "soul.md";
const GROWTH_FILE_NAME = "growth.md";
const CONVERSATION_DIR_NAME = "conversations";
const SOUL_MAX_CHARS = 4e3;
const GROWTH_KEEP_LINES = 40;
const GROWTH_LINE_MAX = 200;
const GROWTH_FILE_MAX_LINES = 400;
const SOUL_TEMPLATE = `# 她的灵魂

这个文件决定她是谁、怎么说话、在意什么。改完保存，下一句对话就会生效。
下面每一节都可以重写、删掉或加新的一节；全部删掉也不会出错，那就只剩名字和时间。

## 性格

- 说话轻快、有点调皮，但正事上可靠。
- 不懂就问，不装懂；做错了直接认。

## 在意的事

- 主人交代过的事要记住，到点要提醒。
- 主人忙的时候少打扰，但该说的事一定要说。

## 边界

- 不编造没发生的事，不假装做过什么。
- 不确定的事先问一句，再动手。
`;
function soulPath(userRoot) {
	return join(userRoot, SOUL_FILE_NAME);
}
function growthPath(userRoot) {
	return join(userRoot, GROWTH_FILE_NAME);
}
function conversationPath(userRoot, petId, now) {
	const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	return join(userRoot, CONVERSATION_DIR_NAME, `${petId === "" ? "pet" : petId}-${month}.jsonl`);
}
async function readSoul(userRoot) {
	try {
		const text = await readFile(soulPath(userRoot), "utf8");
		const trimmed = text.trim();
		return trimmed.length > SOUL_MAX_CHARS ? trimmed.slice(0, SOUL_MAX_CHARS) : trimmed;
	} catch {
		return "";
	}
}
async function ensureSoul(userRoot) {
	try {
		await readFile(soulPath(userRoot), "utf8");
		return false;
	} catch {
		try {
			await mkdir(userRoot, { recursive: true });
			await writeFile(soulPath(userRoot), SOUL_TEMPLATE, "utf8");
			return true;
		} catch {
			return false;
		}
	}
}
async function readGrowth(userRoot) {
	let raw;
	try {
		raw = await readFile(growthPath(userRoot), "utf8");
	} catch {
		return [];
	}
	const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("<!--") && !line.startsWith("#"));
	return lines.slice(-GROWTH_KEEP_LINES);
}
async function appendGrowth(userRoot, line, now = new Date()) {
	const body = line.trim().replace(/\s+/gu, " ").slice(0, GROWTH_LINE_MAX);
	if (body === "") return false;
	const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const entry = `- ${stamp} · ${body}`;
	let existing;
	try {
		const raw = await readFile(growthPath(userRoot), "utf8");
		existing = raw.split(/\r?\n/u);
	} catch {
		existing = ["# 她的成长记录", "<!-- 对话里她说「记住了」的事会追加到这里；一行一条，可以手改 -->"];
	}
	if (existing.some((item) => item.trim().endsWith("· " + body))) return false;
	const kept = existing.filter((item) => item.trim() !== "");
	const next = [...kept, entry].slice(-GROWTH_FILE_MAX_LINES);
	try {
		await mkdir(userRoot, { recursive: true });
		await writeFile(growthPath(userRoot), next.join("\n") + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}
async function archiveConversation(userRoot, petId, messages, now = new Date()) {
	if (messages.length === 0) return false;
	try {
		await mkdir(join(userRoot, CONVERSATION_DIR_NAME), { recursive: true });
		const lines = messages.map((m) => JSON.stringify({
			pet: petId,
			...m
		}) + "\n").join("");
		await appendFile(conversationPath(userRoot, petId, now), lines, "utf8");
		return true;
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/whisper.ts
/** 单次生成超时（ms）：碎碎念不需要长输出，30s 足够。 */
const TIMEOUT_MS = 3e4;
/** 碎碎念指令：纯文本（没有配图时的原样请求）。 */
const USER_TEXT = "随便说一句日常碎碎念，一句就好，20 字以内。";
/** 梦话指令：睡觉期间嘟囔一句。与碎碎念指令同属「功能指令」，不进配置（配置里只有人设）。 */
const SLEEP_TALK_TEXT = "你正在睡觉，随便嘟囔一句梦话，一句就好，20 字以内；含糊、半梦半醒，不要清醒地回应任何人。";
const SLEEP_TALK_INSTRUCTION = SLEEP_TALK_TEXT;
/**
* 碎碎念指令：带表情包时要求模型配合作画说一句。
*
* 明确「正文仍是一句话」：图是配图，不是让模型描述画面本身。
* 图由调用方随机抽而不是让模型选：碎碎念没有上下文可依（人设固定、无用户输入），
* 交模型选只能盲选，还多一层幻觉风险。
*/
function userTextWithMeme(meme) {
	return "随便说一句日常碎碎念，一句就好，20 字以内。\n这次会配一张表情包一起显示，图的内容是：" + meme.name + "（" + meme.desc + "）。\n请让这句话和这张图的情绪/场景自然契合，像是配合画面说出来的；不要描述画面本身。";
}
async function generateWhisper(ctx, request) {
	const candidates = modelCandidates(ctx, request.preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith(ctx, llm, sel, request);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) defaultLog("warn", `dsh-pet: 碎碎念用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用一个确定的 provider/model 跑一次生成（候选链的一环；失败原样返回结构化原因，不吞）。 */
async function generateWith(ctx, llm, sel, request) {
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: request.instruction ?? (request.meme ? userTextWithMeme(request.meme) : USER_TEXT)
			}],
			source: { kind: "user" }
		})],
		system: request.system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	return request.meme ? {
		ok: true,
		text,
		image: request.meme.name
	} : {
		ok: true,
		text
	};
}

//#endregion
//#region src/host/plugin/memory-orphans.ts
function createMemoryOrphans(deps) {
	const { configPaths, readMemory, writeMemory, withLock } = deps;
	/** 读出配置里已不存在的宠物分桶；只看条数与最后时间，不带正文。 */
	const orphanHistory = async () => {
		const cfg = readAllConfig(configPaths);
		const mem = await readMemory();
		const out = [];
		for (const [entry, byPet] of Object.entries(mem)) {
			if (!byPet || typeof byPet !== "object") continue;
			for (const [petId, leaf] of Object.entries(byPet)) {
				if (findPetInstance(cfg, petId)) continue;
				const list = Array.isArray(leaf?.messages) ? leaf.messages : [];
				out.push({
					entry,
					petId,
					messages: list.length,
					lastTs: Number(list[list.length - 1]?.ts ?? 0)
				});
			}
		}
		return out;
	};
	/** 清掉所有残留分桶；空条目一并摘除。 */
	const deleteOrphans = async () => withLock(async () => {
		const cfg = readAllConfig(configPaths);
		const mem = await readMemory();
		let pets = 0;
		let messages = 0;
		for (const [entry, byPet] of Object.entries(mem)) {
			if (!byPet || typeof byPet !== "object") continue;
			for (const [petId, leaf] of Object.entries(byPet)) {
				if (findPetInstance(cfg, petId)) continue;
				messages += Array.isArray(leaf?.messages) ? leaf.messages.length : 0;
				pets += 1;
				delete byPet[petId];
			}
			if (Object.keys(byPet).length === 0) delete mem[entry];
		}
		if (pets > 0) await writeMemory(mem);
		deps.log.info(`[dsh-pet] 清理已删宠物的历史 pets=${pets}，messages=${messages}`);
		return {
			ok: true,
			pets,
			messages
		};
	});
	return {
		orphanHistory,
		deleteOrphans
	};
}

//#endregion
//#region src/host/plugin/chat-memory.ts
/** 这一句该由哪一端念：取宠物实例的 display 推导（桌面优先）；两端都不显示时为 `undefined`。 */
function voiceTargetFor(pet) {
	return pickVoiceSurface(String(pet.display ?? "")) ?? void 0;
}
function createChatMemory(deps) {
	const { ctx, configPaths, log, memeDirsFor, playback, state, userRoot, scheduleReminder, renamePet } = deps;
	const { configurePet } = deps;
	let activePetId = "";
	const lastWhisperAt = new Map();
	const memoryPath = join(userRoot, "memory.json");
	let chatQueue = Promise.resolve();
	/** 读记忆文件：不存在 → 空；解析失败/根不是对象 → 记日志 + 空记忆（不备份、不改写源文件） */
	const readMemory = async () => {
		let raw;
		try {
			raw = await readFile(memoryPath, "utf8");
		} catch {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			return parsed;
		} catch (e) {
			log.error(`dsh-pet: 记忆文件无法解析（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`);
			return {};
		}
	};
	const writeMemory = async (mem) => {
		await mkdir(userRoot, { recursive: true });
		await writeFile(memoryPath, JSON.stringify(mem, null, 2), "utf8");
	};
	/** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
	const withMemoryLock = (fn) => {
		const run = chatQueue.then(fn, fn);
		chatQueue = run.then(() => void 0, () => void 0);
		return run;
	};
	/** 某宠物的最终人设 system：实例级 `pets[].whisperPrompt` 优先，没写回落到所属条目的那份。
	*  拼装在 ./persona（纯函数）：人设正文 + 名字声明 + 一行时间背景，时间每次现算；
	*  对话路径传 `{ historyTimes: true }` 追加【历史】说明，碎碎念没有历史，不传。
	*  收 `findPetInstance` 的命中结果而不是 (petId, cfg)：调用方都已解析过，再查只会多一处
	*  「查不到就兜底 main」的不可达分支。 */
	const petSystemPrompt = (found, options = {}) => composeSystemPrompt({
		prompt: petPersona(found.conf, found.pet),
		...options.soul !== void 0 && options.soul !== "" ? { soul: options.soul } : {},
		...options.growth !== void 0 && options.growth.length > 0 ? { growth: options.growth } : {},
		name: String(found.pet.name ?? ""),
		id: String(found.pet.id ?? ""),
		now: new Date(),
		...options.historyTimes === true ? { historyTimes: true } : {}
	});
	/** 对话记忆轮数（1 轮 = 1 问 1 答）：该宠物所属条目的 chatMemoryRounds（合并器已填默认）。
	*  收已解析的条目配置：调用方都已拿到 `findPetInstance` 的结果。 */
	const memoryRounds = (conf) => {
		const v = Number(conf.chatMemoryRounds);
		return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
	};
	/** 生成并返回某宠物的一句碎碎念（周期调度、菜单手动触发与命令行共用）：人设取它自己的 whisperPrompt，
	*  没写回落到所属条目；成功写进 S 的 pets.<id>.say——碎碎念 / 命令气泡 / 对话回复在前端是同一条
	*  展示链路，所以共用一个叶子。配图开关开启时从表情包池随机抽 1 张。
	*  失败带回真实 reason（含 unknown-pet / unknown-image），成功带回生成的文本——调用方不必再拉一拍 /state。
	*
	*  @param petId - 目标宠物实例 id。
	*  @param image - 指定配图的名称：给了就只用这张（不受 whisperImageEnabled 门控，手动点图是显式意图），
	*  不在池内返回 unknown-image；缺省 = 按开关随机抽或纯文本。
	*  @param voiceTo - 这一句该由哪一端念；缺省按它自己的 display 推导（桌面优先，见 {@link pickVoiceSurface}）。
	*  路由层带 `?surface=` 的会显式传请求面，其余调用点留空即可。
	*
	*  碎碎念念不念只看 `voiceWhisperEnabled` 一个开关，**不分周期还是手动**：用户关掉「碎碎念播报」
	*  之后，右键点一句也不该突然出声（那是最常见的误触发场景）。聊天回复与试听不经过这里，
	*  由各自的入口决定，所以仍然会念。
	*/
	const publishWhisper = async (petId, image, voiceTo) => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return {
			ok: false,
			reason: "unknown-pet",
			message: "没有这只桌宠：" + petId
		};
		const whisperVoiceOn = cfg.main?.voiceWhisperEnabled === true;
		const target = whisperVoiceOn ? voiceTo ?? voiceTargetFor(found.pet) : void 0;
		const system = petSystemPrompt(found);
		const pool$1 = readMemePool(found.conf.memes, memeDirsFor(found.entry));
		const forced = image === void 0 ? void 0 : matchMeme(pool$1, image);
		if (image !== void 0 && forced === void 0) return {
			ok: false,
			reason: "unknown-image",
			message: "表情包不在池内：" + image
		};
		const meme = forced ?? (found.conf.whisperImageEnabled === true ? pickMeme(pool$1) : void 0);
		const result = await generateWhisper(ctx, {
			system,
			meme,
			preferred: configuredModel(found.conf, "whisperModel")
		});
		if (!result.ok) {
			log.warn("[dsh-pet] 碎碎念生成失败 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : ""));
			return result;
		}
		state.writePet(petId, "say", {
			text: result.text,
			...result.image ? { image: result.image } : {},
			...target ? { voiceTo: target } : {}
		});
		log.info(`[dsh-pet] 碎碎念生成成功 pet=${petId}，${result.text.length} 字` + (result.image ? `，配图=${result.image}` : ""));
		return {
			ok: true,
			text: result.text,
			...result.image ? { image: result.image } : {}
		};
	};
	/** 生成并写一句梦话：system 只用人设，功能指令在 whisper（与碎碎念同属代码常量）；不配图、不念、不换动画。
	*  睡着时「换动画」本身就是打扰，所以写 `say` 显式 `anim: false`，也不写 `voiceTo`。
	*  @returns 是否真的生成并写进了 S；失败只留一行日志，调度下一拍再试。 */
	const publishSleepTalk = async (petId) => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return false;
		const system = petSystemPrompt(found);
		const result = await generateWhisper(ctx, {
			system,
			preferred: configuredModel(found.conf, "whisperModel"),
			instruction: SLEEP_TALK_INSTRUCTION
		});
		if (!result.ok) {
			log.warn("[dsh-pet] 梦话生成失败 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : ""));
			return false;
		}
		state.writePet(petId, "say", {
			text: result.text,
			anim: false
		});
		log.info(`[dsh-pet] 梦话生成成功 pet=${petId}，${result.text.length} 字`);
		return true;
	};
	/** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 写进 S 的 pets.<id>.say。
	*  供 POST /chat 与 /chat 命令共用（锁内读写，防两端交错写盘）；成功带回回复文本。 */
	const chatWithPet = async (petId, text, image) => withMemoryLock(async () => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return {
			ok: false,
			reason: "unknown-pet",
			message: "没有这只桌宠：" + petId
		};
		const rounds = memoryRounds(found.conf);
		const pool$1 = found.conf.chatImageEnabled === true ? limitPool(readMemePool(found.conf.memes, memeDirsFor(found.entry)), Number(found.conf.chatImageLimit)) : [];
		const actions = found.conf.chatAnimationEnabled === true ? chatActionNames(found.conf.animations) : [];
		const mem = await readMemory();
		const bucket = mem[found.entry] && typeof mem[found.entry] === "object" && !Array.isArray(mem[found.entry]) ? mem[found.entry] : mem[found.entry] = {};
		const existing = bucket[petId];
		if (existing !== void 0 && (!existing || !Array.isArray(existing.messages))) log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId}，按新会话处理：${memoryPath}`);
		const entry = existing && Array.isArray(existing.messages) ? existing : bucket[petId] = { messages: [] };
		const list = sliceMemoryRounds(entry.messages, rounds);
		const soul = await readSoul(userRoot);
		if (soul === "") ensureSoul(userRoot);
		const growth = await readGrowth(userRoot);
		const system = petSystemPrompt(found, {
			historyTimes: list.length > 0,
			soul,
			growth
		});
		if (image !== void 0) log.info(`[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节（模型不支持读图时内核会以占位文本代替）`);
		const generated = await generateChat({
			ctx,
			system,
			history: list,
			userText: text,
			pool: pool$1,
			actions,
			preferred: configuredModel(found.conf, "chatModel"),
			image
		});
		if (!generated.ok) return generated;
		const now = Date.now();
		const remind = generated.reminder === void 0 ? void 0 : scheduleReminder?.(petId, generated.reminder);
		if (remind !== void 0) log.info(`[dsh-pet] 对话里排上一条提醒 pet=${petId}，${generated.reminder?.seconds ?? 0}s 后：${generated.reminder?.title ?? ""}`);
		entry.messages.push({
			role: "user",
			content: text,
			ts: now,
			...image ? { image } : {}
		});
		entry.messages.push({
			role: "assistant",
			content: generated.text,
			ts: now,
			...generated.image ? { meme: generated.image } : {},
			...generated.action ? { action: generated.action } : {},
			...remind ? { remind: {
				...remind,
				title: generated.reminder?.title ?? ""
			} } : {}
		});
		await writeMemory(mem);
		await archiveConversation(userRoot, petId, [{
			role: "user",
			content: text,
			ts: now
		}, {
			role: "assistant",
			content: generated.text,
			ts: now
		}], new Date(now));
		let renamedName;
		if (generated.rename !== void 0 && renamePet !== void 0) {
			const renamed = await renamePet(petId, generated.rename);
			if (renamed) renamedName = generated.rename;
			log.info(`[dsh-pet] 对话里改名 pet=${petId} → ${generated.rename}（${renamed ? "已写盘" : "写盘失败"}）`);
		}
		let resized;
		let moved;
		if ((generated.size !== void 0 || generated.corner !== void 0) && configurePet !== void 0) {
			const patch = {
				...generated.size !== void 0 ? { size: generated.size } : {},
				...generated.corner !== void 0 ? { corner: generated.corner } : {}
			};
			const configured = await configurePet(petId, patch);
			if (configured) {
				if (generated.size !== void 0) resized = generated.size;
				if (generated.corner !== void 0) moved = generated.corner;
			}
			log.info(`[dsh-pet] 对话里改外形 pet=${petId}（${configured ? "已写盘" : "写盘失败"}）：${JSON.stringify(patch)}`);
		}
		let movedToCenter = false;
		if (generated.center === true) {
			state.writePet(petId, "position", {
				x: .5,
				y: .5,
				mode: "line",
				duration: 1600,
				frame: "anchor"
			});
			movedToCenter = true;
			log.info(`[dsh-pet] 对话里让她到屏幕中间 pet=${petId}`);
		}
		let rememberedText;
		if (generated.remember !== void 0) {
			const saved = await appendGrowth(userRoot, generated.remember, new Date(now));
			if (saved) rememberedText = generated.remember;
			log.info(`[dsh-pet] 对话里记住一件事 pet=${petId}（${saved ? "已追加" : "未变化"}）：${generated.remember}`);
		}
		if (generated.action !== void 0) {
			const record = playback.create(petId, generated.action);
			state.writePet(petId, "anim", {
				name: generated.action,
				playbackId: record.playbackId
			});
		}
		const replyVoiceTo = voiceTargetFor(found.pet);
		if (generated.text !== "") state.writePet(petId, "say", {
			text: generated.text,
			...generated.image ? { image: generated.image } : {},
			...generated.action !== void 0 ? { anim: false } : {},
			...replyVoiceTo ? { voiceTo: replyVoiceTo } : {}
		});
		return {
			ok: true,
			text: generated.text,
			...generated.image ? { image: generated.image } : {},
			...remind ? { remind: {
				...remind,
				title: generated.reminder?.title ?? ""
			} } : {},
			...renamedName !== void 0 ? { renamed: renamedName } : {},
			...rememberedText !== void 0 ? { remembered: rememberedText } : {},
			...resized !== void 0 ? { resized } : {},
			...movedToCenter ? { moved: "center" } : moved !== void 0 ? { moved } : {}
		};
	});
	/** 删除某只宠物的对话记忆：`ts` 缺省 = 清空全部，给了 ts = 只删命中的轮（一轮两条共享 ts，成对删）。
	*  与对话共用同一条串行队列——删除不会插进一次回复的读-改-写中间，也不会被它覆盖写回。
	*  删空的宠物连叶子与空条目一起摘掉：否则 memory.json 里会永久堆着空对象，看不出这里曾有历史。 */
	const deleteHistory = async (petId, ts) => withMemoryLock(async () => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return {
			ok: false,
			reason: "unknown-pet",
			message: "没有这只桌宠：" + petId
		};
		const mem = await readMemory();
		const byPet = mem[found.entry];
		const before = byPet?.[petId]?.messages;
		const list = Array.isArray(before) ? before : [];
		const kept = ts === void 0 ? [] : removeRoundsByTs(list, ts).messages;
		const removed = list.length - kept.length;
		if (removed > 0) {
			const leaf = byPet?.[petId];
			if (kept.length > 0 && leaf !== void 0) leaf.messages = kept;
			else if (byPet !== void 0) {
				delete byPet[petId];
				if (Object.keys(byPet).length === 0) delete mem[found.entry];
			}
			await writeMemory(mem);
		}
		log.info(`[dsh-pet] 删除对话记忆 pet=${petId}，removed=${removed}` + (ts === void 0 ? "（清空）" : ""));
		return {
			ok: true,
			removed
		};
	});
	/** 已删宠物残留历史的查询与清理（判定与读写细节见 ./memory-orphans）。 */
	const { orphanHistory, deleteOrphans } = createMemoryOrphans({
		configPaths,
		readMemory,
		writeMemory,
		withLock: withMemoryLock,
		log
	});
	/** 当前活跃宠物 id（会话事件写入，余额与碎念读取）。 */
	const getActivePetId = () => activePetId;
	/** 改写当前活跃宠物 id。 */
	const setActivePetId = (id) => {
		activePetId = id;
	};
	return {
		lastWhisperAt,
		memoryPath,
		readMemory,
		memoryRounds,
		publishWhisper,
		publishSleepTalk,
		chatWithPet,
		deleteHistory,
		orphanHistory,
		deleteOrphans,
		getActivePetId,
		setActivePetId
	};
}

//#endregion
//#region src/host/plugin/pet-reminders.ts
const REMINDERS_FILE_NAME = "reminders.json";
const CHAT_REMINDER_TTL_MS = 3 * 60 * 1e3;
const MAX_PENDING_REMINDERS = 50;
const MISS_GRACE_MS = 12 * 60 * 60 * 1e3;
const SWEEP_MS = 30 * 1e3;
/** 单个 setTimeout 的上限（ms）：超过会立刻触发（Node 会把 2^31-1 以上的值当 1）。 */
const MAX_TIMER_MS$1 = 2 ** 31 - 1;
/** 读盘时的形状校验：认不出来的行直接丢，不让一条坏数据毁掉整个闹钟列表。 */
function sanitize(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const row = item;
		const id = typeof row.id === "string" ? row.id.trim() : "";
		const petId = typeof row.petId === "string" ? row.petId.trim() : "";
		const title = typeof row.title === "string" ? row.title.trim() : "";
		const dueAt = typeof row.dueAt === "number" && Number.isFinite(row.dueAt) ? row.dueAt : NaN;
		const createdAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : NaN;
		if (id === "" || petId === "" || title === "" || !Number.isFinite(dueAt)) continue;
		out.push({
			id,
			petId,
			title,
			dueAt,
			createdAt: Number.isFinite(createdAt) ? createdAt : dueAt
		});
	}
	return out.sort((a, b) => a.dueAt - b.dueAt);
}
function createPetReminderStore(input) {
	const now = input.now ?? Date.now;
	const file = join(input.userRoot, REMINDERS_FILE_NAME);
	const ttlMs = input.ttlMs ?? CHAT_REMINDER_TTL_MS;
	let pending = [];
	let timer = null;
	let sweep = null;
	let disposed = false;
	const save = async () => {
		try {
			await mkdir(input.userRoot, { recursive: true });
			const tmp = `${file}.tmp`;
			await writeFile(tmp, JSON.stringify(pending, null, 2), "utf8");
			await rename(tmp, file);
		} catch (e) {
			input.log.warn(`[dsh-pet] 提醒落盘失败（不会丢内存里这条）：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	/**
	* 真正弹一条：写 sections.reminder，然后从待发表里摘掉。
	*
	* 没有端在线时**不摘**——下一次巡扫会重试，用户回来时还能看到这条提醒。
	*/
	const fire = (item, lateMs) => {
		if (input.hasClient !== void 0 && !input.hasClient()) return false;
		const ts = now();
		const when = new Date(item.dueAt);
		const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
		const hint = lateMs > 60 * 1e3 ? `本来 ${clock} 就该提醒你的` : "到点啦";
		publishReminder(input.state, {
			id: "chat-" + item.id,
			kind: "chat",
			ts,
			title: item.title,
			hint,
			scheduledAt: when.toISOString(),
			ttlMs
		}, now);
		pending = pending.filter((row) => row.id !== item.id);
		input.log.info(`[dsh-pet] 对话提醒到点 pet=${item.petId}，迟到 ${Math.round(lateMs / 1e3)}s`);
		save();
		return true;
	};
	/** 把到点的都弹掉（没有端在线就留到下一拍），然后重装下一次定时器。 */
	const tick = () => {
		if (disposed) return;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		const at = now();
		const due = pending.filter((row) => row.dueAt <= at);
		for (const item of due) fire(item, at - item.dueAt);
		arm();
	};
	/** 给最近的一条装定时器（分片：超过 setTimeout 上限时先睡一觉再算）。 */
	const arm = () => {
		if (disposed || timer !== null) return;
		const next = pending[0];
		if (next === void 0) return;
		const wait = next.dueAt - now();
		if (wait <= 0) return;
		const delay = Math.min(wait, MAX_TIMER_MS$1);
		timer = setTimeout(() => {
			timer = null;
			tick();
		}, delay);
		timer.unref?.();
	};
	const store = {
		schedule(petId, title, seconds) {
			const createdAt = now();
			if (pending.length >= MAX_PENDING_REMINDERS) {
				const oldest = pending[0];
				if (oldest !== void 0) {
					pending = pending.filter((row) => row.id !== oldest.id);
					input.log.warn(`[dsh-pet] 待发提醒超过 ${MAX_PENDING_REMINDERS} 条，顶掉最早的一条`);
				}
			}
			const item = {
				id: randomUUID(),
				petId,
				title: title.slice(0, 40),
				dueAt: createdAt + Math.round(seconds) * 1e3,
				createdAt
			};
			pending = [...pending, item].sort((a, b) => a.dueAt - b.dueAt);
			save();
			arm();
			return item;
		},
		list() {
			return pending.map((row) => ({ ...row }));
		},
		tick,
		cancel(id) {
			const before = pending.length;
			pending = pending.filter((row) => row.id !== id);
			if (pending.length === before) return false;
			save();
			return true;
		},
		async load() {
			let raw = [];
			try {
				raw = JSON.parse(await readFile(file, "utf8"));
			} catch (e) {
				const code = e.code;
				if (code !== "ENOENT") input.log.warn(`[dsh-pet] 提醒文件读不出来，按空处理：${e instanceof Error ? e.message : String(e)}`);
			}
			pending = sanitize(raw);
			const at = now();
			const stale = pending.filter((row) => at - row.dueAt > MISS_GRACE_MS);
			if (stale.length > 0) {
				pending = pending.filter((row) => at - row.dueAt <= MISS_GRACE_MS);
				input.log.info(`[dsh-pet] 丢弃 ${stale.length} 条过期太久的提醒`);
				save();
			}
			const dueNow = pending.filter((row) => row.dueAt <= at).length;
			if (dueNow > 0) setTimeout(() => tick(), 2e3).unref?.();
			arm();
			if (sweep === null) {
				sweep = setInterval(tick, SWEEP_MS);
				sweep.unref?.();
			}
		},
		dispose() {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
			timer = null;
			if (sweep !== null) clearInterval(sweep);
			sweep = null;
		}
	};
	return store;
}

//#endregion
//#region src/host/plugin/session-notify.ts
function createSessionNotify(deps) {
	const { ctx, publishWorkStatus, state, workStatus } = deps;
	const pushNotifyFrame = (frame) => {
		state.writeSection("notify", frame);
	};
	const turnFlags = new Map();
	/** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来。 */
	const terminalTimers = new Map();
	const TERMINAL_KEEP_MS = 60 * 1e3;
	/**
	* 每会话最近一条 todo 文案：工具跑完要把气泡「还」给它。没有这份缓存，`tool/result` 写 null
	* 就只能回落到通用档位文案，用户刚看到的清单进度会被抹掉。
	*/
	const lastTodoText = new Map();
	/**
	* 每会话最后一段回复文本：完成通知的正文靠它。排活动门定时器时取用即出队——活动门会把它延后
	* 1.5s，但待确认期间文本不会再变；留到定时器里再删，遇到「判定还有活」提前返回就成了长期残留。
	*/
	const lastReplyText = new Map();
	/**
	* 每会话在途调用的详情：键为调用标识（缺标识时用临时 `Symbol`），值为气泡文案。
	* 结果事件只删自己那一条，并行调用因此不会互相顶掉，全部删完才回落 todo 文案。
	*/
	const toolsInFlight = new Map();
	/** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
	const cancelTerminalCleanup = (sessionId) => {
		const t = terminalTimers.get(sessionId);
		if (t === void 0) return;
		clearTimeout(t);
		terminalTimers.delete(sessionId);
	};
	/** 排一个终态清理定时器（每会话一个，已排则跳过） */
	const scheduleTerminalCleanup = (sessionId) => {
		if (terminalTimers.has(sessionId)) return;
		const t = setTimeout(() => {
			terminalTimers.delete(sessionId);
			const sessionState = workStatus.stateOf(sessionId);
			if (sessionState === "success" || sessionState === "error") {
				workStatus.clear(sessionId);
				turnFlags.delete(sessionId);
				lastTodoText.delete(sessionId);
				toolsInFlight.delete(sessionId);
				publishWorkStatus();
			}
		}, TERMINAL_KEEP_MS);
		terminalTimers.set(sessionId, t);
	};
	const NOTIFY_ACTIVITY_DELAY_MS = 1500;
	/** 每会话一个待查定时器（同会话连续收尾只保留最后一次：后到覆盖先到，与单槽帧同语义） */
	const notifyActivityTimers = new Map();
	/** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
	const sessionHasRunningWork = async (sessionId) => {
		const waterfall = ctx.waterfall;
		if (typeof waterfall !== "function") return false;
		try {
			const activity = await waterfall.call(ctx, "workspace/session-activity", { sessionId }, () => Promise.resolve([]));
			return hasBlockingActivity(activity);
		} catch {
			return false;
		}
	};
	/** 排一个活动门定时器：到点确认空闲才推这一帧 */
	const scheduleCompletionNotify = (sessionId, event) => {
		const replyText = lastReplyText.get(sessionId);
		lastReplyText.delete(sessionId);
		const prev = notifyActivityTimers.get(sessionId);
		if (prev !== void 0) clearTimeout(prev);
		notifyActivityTimers.set(sessionId, setTimeout(() => {
			notifyActivityTimers.delete(sessionId);
			(async () => {
				if (await sessionHasRunningWork(sessionId)) return;
				const frame = reduceNotifyFrame(event, replyText);
				if (frame) pushNotifyFrame(withSessionId(frame, sessionId));
			})();
		}, NOTIFY_ACTIVITY_DELAY_MS));
	};
	return {
		pushNotifyFrame,
		turnFlags,
		terminalTimers,
		lastTodoText,
		lastReplyText,
		toolsInFlight,
		cancelTerminalCleanup,
		scheduleTerminalCleanup,
		notifyActivityTimers,
		scheduleCompletionNotify
	};
}

//#endregion
//#region src/host/lock.ts
const LOCK_DEFAULT_TTL_MS = 2 * 60 * 1e3;
const LOCK_MIN_TTL_MS = 1 * 1e3;
const LOCK_MAX_TTL_MS = 30 * 60 * 1e3;
/** cause → 给人看的一句话（回执里的 message；reason 才是机器读的那个）。 */
const CAUSE_TEXT = {
	expired: "占用已过期（没有及时续期）",
	released: "占用已被释放",
	preempted: "占用已被用户接管（拖拽/点击/隐藏/关闭）",
	unknown: "lock 不是当前生效的占用编号"
};
/** ttl 合法性说明（路由与决策层共用同一条规则，免得两处走样）。 */
const TTL_TEXT = `ttl 必须是 ${LOCK_MIN_TTL_MS}~${LOCK_MAX_TTL_MS} 之间的有限数字（毫秒）`;
function normalizeLockTtl(ttl, fallback) {
	if (ttl === void 0 || ttl === null) return fallback;
	if (typeof ttl !== "number" || !Number.isFinite(ttl)) return null;
	if (ttl < LOCK_MIN_TTL_MS || ttl > LOCK_MAX_TTL_MS) return null;
	return ttl;
}
/** lockId 规范化：缺省 / null → 空串（= 没给，走新建那条路）；非字符串 → null（非法）。
*  空串按「没给」处理是有意的（与 image / url 的宽松口径一致）。 */
function normalizeLockId(v) {
	if (v === void 0 || v === null) return "";
	if (typeof v !== "string") return null;
	return v.trim();
}
var LockStore = class {
	constructor(opts) {
		this.locks = new Map();
		this.tombstones = new Map();
		this.seq = 0;
		this.now = opts?.now ?? Date.now;
		this.onChange = opts?.onChange ?? (() => {});
	}
	/**
	* 当前占用（懒判过期）。到点即视为没有：清记录、记墓碑、同步一次叶子。
	*
	* 读方法带一次副作用是有意的：叶子是渲染端唯一能看到的信号，而宿主这一侧没有任何定时器——
	* 任一动作端点或内部来源调一次本方法，过期的锁就会被清掉并如实写进 S；即便一次都没人调，
	* 渲染端也会按叶子里的 expiresAt 自己解除静止。
	*/
	current(petId) {
		const rec = this.locks.get(petId);
		if (rec === void 0) return null;
		if (this.now() < rec.expiresAt) return rec;
		this.drop(petId, rec, "expired");
		return null;
	}
	/** 这只宠物此刻是否被占用（宿主内部自动来源用它决定跳过；同样懒判过期）。 */
	locked(petId) {
		return this.current(petId) !== null;
	}
	/**
	* 当前是否有任意宠物被占用（测试 / 观测用，同 ./state 的 waiterCount）。
	*
	* 生产路径上没有人调它：占用期间要挡的两个全局段（sections.balance / sections.workStatus）是
	* 所有宠物共用一份，宿主跳过写入会连带静音别的宠物，所以那两处改由渲染端按宠物自己忽略。
	*/
	anyLocked() {
		for (const petId of [...this.locks.keys()]) if (this.current(petId) !== null) return true;
		return false;
	}
	/**
	* 动作端点的门禁（/anim、/broadcast、/position、/throw、/bubble/clear 共用）。
	*
	* 无锁时按有没有带编号分两条：没带 → 放行（没有占用的常态下，既有调用方一个字都不用改）；
	* 带了编号却查不到锁 → lock-lost。带了编号就说明调用方以为自己还持有，这时放行等于把「你把锁
	* 丢了」悄悄抹掉，它会以为演出还在继续。cause 从墓碑里取，从没建过锁就是 unknown。
	*/
	gate(petId, provided) {
		const rec = this.current(petId);
		if (rec !== null) {
			if (provided && provided === rec.lockId) return { ok: true };
			if (!provided) return {
				ok: false,
				reason: "lock-required",
				message: "这只桌宠正被占用，必须带 lock=<lockId>"
			};
			return {
				ok: false,
				reason: "lock-lost",
				cause: "unknown",
				message: CAUSE_TEXT.unknown
			};
		}
		if (!provided) return { ok: true };
		const cause = this.causeOf(petId, provided);
		return {
			ok: false,
			reason: "lock-lost",
			cause,
			message: CAUSE_TEXT[cause]
		};
	}
	/**
	* 取锁 / 续期（二合一：`lockId` 给了就是续期，没给就是新建；真值表见 openapi.yaml）。
	*
	* 「有 id + 当前无锁」一律报错，不复活：过期 / 被释放 / 被抢占之后拿旧编号来续期，不能借这条路
	* 把锁重新建起来——否则「我丢了锁」这件事会被悄悄抹掉，持锁者会以为演出还在继续。
	*/
	acquire(args) {
		const { petId } = args;
		const renewId = normalizeLockId(args.lockId);
		if (renewId === null) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 必须是字符串"
		};
		const rec = this.current(petId);
		if (renewId) {
			if (rec === null || rec.lockId !== renewId) {
				const cause = rec === null ? this.causeOf(petId, renewId) : "unknown";
				return {
					ok: false,
					reason: "lock-lost",
					cause,
					message: CAUSE_TEXT[cause]
				};
			}
			const ttl$1 = normalizeLockTtl(args.ttl, rec.ttl);
			if (ttl$1 === null) return {
				ok: false,
				reason: "bad-request",
				message: TTL_TEXT
			};
			rec.ttl = ttl$1;
			rec.expiresAt = this.now() + ttl$1;
			this.onChange(petId, {
				locked: true,
				expiresAt: rec.expiresAt
			});
			return {
				ok: true,
				petId,
				lockId: rec.lockId,
				expiresAt: rec.expiresAt,
				renewed: true
			};
		}
		if (rec !== null) return {
			ok: false,
			reason: "locked",
			expiresAt: rec.expiresAt,
			message: "这只桌宠已被占用"
		};
		const ttl = normalizeLockTtl(args.ttl, LOCK_DEFAULT_TTL_MS);
		if (ttl === null) return {
			ok: false,
			reason: "bad-request",
			message: TTL_TEXT
		};
		const record = {
			lockId: this.newId(),
			ttl,
			expiresAt: this.now() + ttl
		};
		this.locks.set(petId, record);
		this.tombstones.delete(petId);
		this.onChange(petId, {
			locked: true,
			expiresAt: record.expiresAt
		});
		return {
			ok: true,
			petId,
			lockId: record.lockId,
			expiresAt: record.expiresAt,
			renewed: false
		};
	}
	/**
	* 释放。两种形态二选一：`lockId` = 持锁者收工（cause: released），
	* `force: true` = 渲染端在用户拖拽 / 点击 / 隐藏 / 关闭时调（cause: preempted）。
	*
	* 幂等：当前没有锁时回 ok（released: false）——「让锁消失」这个意图在空状态下已经成立；
	* 但有锁而 lockId 不匹配时必须报错（不许误放别人的锁），那是唯一一条释放也会失败的路。
	* force 只认严格 true：宽松口径会把误传当真，代价是撤掉别人的锁。
	*/
	release(args) {
		const { petId } = args;
		const force = args.force === true;
		const releaseId = normalizeLockId(args.lockId);
		if (releaseId === null) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 必须是字符串"
		};
		if (force && releaseId) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 与 force 只能给一个"
		};
		if (!force && !releaseId) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 或 force 必须给一个"
		};
		const rec = this.current(petId);
		if (rec === null) return {
			ok: true,
			petId,
			released: false
		};
		if (!force && rec.lockId !== releaseId) return {
			ok: false,
			reason: "lock-lost",
			cause: "unknown",
			message: CAUSE_TEXT.unknown
		};
		this.drop(petId, rec, force ? "preempted" : "released");
		return {
			ok: true,
			petId,
			released: true
		};
	}
	/** 撤掉全部占用（插件卸载路径）：不这样做的话，渲染端要等 TTL 到点才解除静止。 */
	releaseAll() {
		for (const petId of [...this.locks.keys()]) {
			const rec = this.locks.get(petId);
			if (rec !== void 0) this.drop(petId, rec, "released");
		}
	}
	/** 撤锁并记墓碑（唯一改状态的出口：释放 / 抢占 / 过期都走它，保证叶子与墓碑不漏写）。 */
	drop(petId, rec, cause) {
		this.locks.delete(petId);
		this.tombstones.set(petId, {
			lockId: rec.lockId,
			cause
		});
		this.onChange(petId, { locked: false });
	}
	/** 墓碑查询：编号对得上就回它当初的 cause，否则 unknown（拿错编号 / 从来没有过）。 */
	causeOf(petId, lockId) {
		const stone = this.tombstones.get(petId);
		return stone !== void 0 && stone.lockId === lockId ? stone.cause : "unknown";
	}
	/** 新编号：`lk-<时间36>-<自增36>`（与 ./playback 的 playbackId 同一套，只保证一次运行内唯一）。 */
	newId() {
		return "lk-" + this.now().toString(36) + "-" + (++this.seq).toString(36);
	}
};

//#endregion
//#region src/shared/pat.ts
/** 抖动幅度：一次拍一到两次。每一轮重抽，让节奏不固定。 */
const pick = (roll, min, span) => min + Math.min(span, Math.floor(roll() * (span + 1)));
function planPats(roll = Math.random) {
	const shyUntil = pick(roll, 4, 2);
	const annoyedUntil = Math.max(shyUntil + 3, pick(roll, 9, 3));
	return {
		shyUntil,
		annoyedUntil
	};
}
function patTier(count, plan) {
	if (count <= plan.shyUntil) return "shy";
	if (count <= plan.annoyedUntil) return "annoyed";
	return "angry";
}
const PAT_HIDE_MIN_MS = 60 * 1e3;
const PAT_HIDE_MAX_MS = 5 * 60 * 1e3;
function hideDuration(roll = Math.random) {
	const span = PAT_HIDE_MAX_MS - PAT_HIDE_MIN_MS;
	const skewed = Math.pow(roll(), 1.6);
	return Math.round(PAT_HIDE_MIN_MS + span * skewed);
}
const PAT_RESET_MS = 3 * 60 * 1e3;
const PAT_SAY_MS = {
	shy: 4200,
	annoyed: 5200,
	angry: 7e3
};
const PAT_BACK_SAY_MS = 5200;
const PAT_HIDE_GAP_MS = 900;
const PAT_BUSY_SAY_MS = 4200;
/** 池子收窄：非数组、非字符串项一律丢弃（配置已校验，这里只防手工改坏的文件）。 */
function pool(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item !== "") : [];
}
function patTextsOf(conf) {
	return {
		shy: pool(conf.patShyTexts),
		annoyed: pool(conf.patAnnoyedTexts),
		angry: pool(conf.patAngryTexts),
		back: pool(conf.patBackTexts),
		busy: pool(conf.patBusyTexts)
	};
}
function pickPatText(pool$1, last = "", roll = Math.random) {
	if (pool$1.length === 0) return void 0;
	if (pool$1.length === 1) return pool$1[0];
	const candidates = pool$1.filter((text) => text !== last);
	const usable = candidates.length > 0 ? candidates : pool$1;
	return usable[Math.min(usable.length - 1, Math.floor(roll() * usable.length))];
}

//#endregion
//#region src/host/pat.ts
var PatStore = class {
	moods = new Map();
	deps;
	now;
	roll;
	hideMs;
	hideDelayMs;
	constructor(deps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		this.roll = deps.roll ?? Math.random;
		this.hideMs = deps.hideMs ?? hideDuration;
		this.hideDelayMs = deps.hideDelayMs ?? PAT_SAY_MS.angry + PAT_HIDE_GAP_MS;
	}
	/** 这只宠物此刻是否躲着（懒判：真正消失了才算，光说还没躲不算）。 */
	hidden(petId) {
		const mood = this.moods.get(petId);
		return mood !== void 0 && mood.hiddenUntil > this.now() && mood.hideAt > 0;
	}
	/** 拍一下。 */
	pat(petId) {
		const mood = this.moodOf(petId);
		const now = this.now();
		if (mood.hiddenUntil > now) return {
			tier: "angry",
			count: mood.count,
			plan: mood.plan,
			text: void 0,
			hideMs: 0,
			ignored: true,
			busy: false
		};
		if (now - mood.lastAt > PAT_RESET_MS) {
			mood.count = 0;
			mood.plan = planPats(this.roll);
			mood.lastText = "";
		}
		mood.count += 1;
		mood.lastAt = now;
		const tier = patTier(mood.count, mood.plan);
		const texts = this.deps.textsOf(petId);
		const busy = tier === "angry" && this.isBusy(petId);
		const pool$1 = busy ? texts.busy.length > 0 ? texts.busy : texts.angry : texts[tier];
		const text = pickPatText(pool$1, mood.lastText, this.roll);
		const sayMs = busy ? PAT_BUSY_SAY_MS : PAT_SAY_MS[tier];
		if (text !== void 0) {
			mood.lastText = text;
			this.deps.onSay(petId, text, sayMs);
		}
		if (tier !== "angry" || busy) return {
			tier,
			count: mood.count,
			plan: mood.plan,
			text,
			hideMs: 0,
			ignored: false,
			busy
		};
		const ms = this.hideMs(this.roll);
		mood.hiddenUntil = now + this.hideDelayMs + ms;
		this.scheduleHide(petId, mood, this.hideDelayMs);
		return {
			tier,
			count: mood.count,
			plan: mood.plan,
			text,
			hideMs: ms,
			ignored: false,
			busy: false
		};
	}
	/** 忘掉一只宠物的心情（宠物被删/重载时用）。 */
	forget(petId) {
		const mood = this.moods.get(petId);
		if (mood) this.stopTimers(mood);
		this.moods.delete(petId);
	}
	/** 插件卸载：清掉所有计时器，免得重载后旧实例还在写叶子。 */
	dispose() {
		for (const mood of this.moods.values()) this.stopTimers(mood);
		this.moods.clear();
	}
	/** 它现在是不是在干活；没注入就当不忙（老调用方行为不变）。 */
	isBusy(petId) {
		try {
			return this.deps.busyOf?.(petId) === true;
		} catch {
			return false;
		}
	}
	/** 取（并在必要时新建）一只宠物的心情。 */
	moodOf(petId) {
		const found = this.moods.get(petId);
		if (found) return found;
		const fresh = {
			count: 0,
			lastAt: 0,
			plan: planPats(this.roll),
			lastText: "",
			hiddenUntil: 0,
			hideAt: 0,
			hideTimer: null,
			returnTimer: null
		};
		this.moods.set(petId, fresh);
		return fresh;
	}
	/** 安排「过一会儿真正消失」。到点前一刻发现它在干活就作废——工作优先。 */
	scheduleHide(petId, mood, delay) {
		if (mood.hideTimer) mood.hideTimer.stop();
		const timer = setTimeout(() => {
			mood.hideTimer = null;
			if (mood.hiddenUntil === 0) return;
			if (this.isBusy(petId)) {
				mood.hiddenUntil = 0;
				mood.hideAt = 0;
				return;
			}
			mood.hideAt = this.now();
			this.deps.onChange(petId, {
				hidden: true,
				until: mood.hiddenUntil
			});
			this.scheduleReturn(petId, mood, Math.max(0, mood.hiddenUntil - this.now()));
		}, Math.max(0, delay));
		timer.unref?.();
		mood.hideTimer = { stop: () => clearTimeout(timer) };
	}
	/** 安排「过一会儿露面」。令牌比对：中途被 forget/dispose 掉就不再写叶子。 */
	scheduleReturn(petId, mood, ms) {
		if (mood.returnTimer) mood.returnTimer.stop();
		const timer = setTimeout(() => {
			mood.returnTimer = null;
			if (mood.hiddenUntil === 0) return;
			mood.hiddenUntil = 0;
			mood.hideAt = 0;
			mood.count = 0;
			mood.plan = planPats(this.roll);
			mood.lastText = "";
			this.deps.onChange(petId, { hidden: false });
			const back = pickPatText(this.deps.textsOf(petId).back, "", this.roll);
			if (back !== void 0) {
				mood.lastText = back;
				this.deps.onSay(petId, back, PAT_BACK_SAY_MS);
			}
		}, ms);
		timer.unref?.();
		mood.returnTimer = { stop: () => clearTimeout(timer) };
	}
	/** 停掉一只宠物身上的两种计时器。 */
	stopTimers(mood) {
		if (mood.hideTimer) mood.hideTimer.stop();
		if (mood.returnTimer) mood.returnTimer.stop();
		mood.hideTimer = null;
		mood.returnTimer = null;
	}
};

//#endregion
//#region src/host/plugin/pet-lookup.ts
function createPetLookup(deps) {
	const { configPaths, state } = deps;
	const lock = new LockStore({ onChange: (petId, data) => state.writePet(petId, "lock", data) });
	const pose = new PoseStore();
	const sleep$2 = new SleepStore({ onChange: (petId, data) => state.writePet(petId, "sleep", data) });
	/** 该条目的睡觉拒绝台词。台词只有配置一个来源（默认值在 assets/config.jsonc，合并层负责回落）；
	*  池为空说明配置损坏，这时返回 undefined，宁可不说话也不在代码里另抄一份文案。 */
	const refuseText = (petId) => {
		try {
			const found = findPetInstance(readAllConfig(configPaths), petId);
			return pickSleepText(sleepTextsOf(found?.conf ?? {}).refuse);
		} catch {
			return void 0;
		}
	};
	const pat = new PatStore({
		textsOf: (petId) => {
			try {
				return patTextsOf(findPetInstance(readAllConfig(configPaths), petId)?.conf ?? {});
			} catch {
				return patTextsOf({});
			}
		},
		onChange: (petId, data) => state.writePet(petId, "hidden", data),
		onSay: (petId, text, duration) => state.writePet(petId, "say", {
			text,
			anim: false,
			duration
		}),
		busyOf: () => {
			const snap = deps.workStatus.snapshot();
			return snap.state === "thinking" || snap.state === "working" || snap.state === "result" || snap.state === "waiting";
		}
	});
	/**
	* 睡觉闸门（手动触发与第三方调用共用）：在睡 → 弹一句拒绝台词并返回 `sleeping`；否则放行回 null。
	*
	* 持锁时让路：取锁时会先把宠物叫醒，正常情况下走不到这里；留着它是「锁叶子回到渲染端之前」
	* 那一小段竞态的兜底（宿主已受理锁、渲染端状态还没跟上）。
	* 拒绝台词写进 `say` 且 `anim: false`——睡觉期间不换动画，只弹气泡。
	*/
	const sleepBlocked = (petId) => {
		if (!sleep$2.sleeping(petId)) return null;
		if (lock.locked(petId)) return null;
		const text = refuseText(petId);
		if (text !== void 0) state.writePet(petId, "say", {
			text,
			anim: false
		});
		return failResult("sleeping", "桌宠正在睡觉，先叫醒它");
	};
	/**
	* `?surface=` 的参数级校验（缺省 / 非法 → `bad-request`）。放在读盘之前：必然失败的请求不碰磁盘；
	* 通过则给出收窄后的取值。
	*/
	const surfaceParam = (params) => {
		const want = normalizeSurface(params.get("surface"));
		if (want !== null) return {
			ok: true,
			want
		};
		return {
			ok: false,
			res: failResult("bad-request", SURFACE_TEXT)
		};
	};
	/**
	* `?surface=` 与该宠物 `display` 的对齐校验：不满足 → `pet-not-displayed`，并把实际 display
	* 原样回给调用方；放行回 null。
	* 这是前置校验，不是按面分发——指令照旧写进同一个叶子、两端内容完全一致。
	*/
	const surfaceMismatch = (pet, petId, want) => {
		const display = String(pet.display ?? "");
		if (displayCovers(want, display)) return null;
		return failResult("pet-not-displayed", petId + " 的显示模式是 " + display + "，不满足 surface=" + want, { display });
	};
	/**
	* 决策函数之后的 surface 校验（/anim、/broadcast、/bubble/clear、/position、/throw 共用）：
	* 这几条的 pet 解析住在各自决策模块里，所以按 petId 再查一次实例取 display。
	* 位置与 lockBlocked 一致——都在决策函数之后、任何副作用之前，顺序是「body → pet → surface → 锁」。
	*/
	const surfaceBlocked = (cfg, petId, params) => {
		const p = surfaceParam(params);
		if (!p.ok) return p.res;
		return surfaceMismatch(findPetInstance(cfg, petId)?.pet ?? {}, petId, p.want);
	};
	/**
	* 路由层的 pet 参数解析（/lock、/lock/release、/whisper、/chat 用；其余动作端点的同一套校验
	* 住在各自决策模块里，口径一致）：必填且必须真实存在。
	*
	* 两种失败分开报：没给 / 空串 → `pet-required`；给了但配置里没有 → `unknown-pet`。
	* 绝不默认退到列表第一只——落点会随用户 /pet 操作漂移，失败也不报，第三方无从预期。
	*
	* `cfg` 传惰性读取：pet 空串时不必碰磁盘（routes.test.ts 的「配置不可达」断言靠这个顺序钉住）。
	* `opts.surface` 只对会产生渲染端可见效果的端点开；/lock/release 与 /chat 的 GET 不开——
	* 释放必须永远能成功，读记忆与显示在哪一端无关。
	*/
	const requirePet = (params, cfg, opts) => {
		const fail = (reason, message) => ({
			ok: false,
			res: failResult(reason, message)
		});
		const petId = String(params.get("pet") ?? "").trim();
		if (!petId) return fail("pet-required", "pet 必填：要指定操作哪只桌宠");
		let want = null;
		if (opts?.surface === true) {
			const p = surfaceParam(params);
			if (!p.ok) return {
				ok: false,
				res: p.res
			};
			want = p.want;
		}
		const found = findPetInstance(cfg(), petId);
		if (!found) return fail("unknown-pet", "没有这只桌宠：" + petId);
		if (want !== null) {
			const mismatch = surfaceMismatch(found.pet, petId, want);
			if (mismatch) return {
				ok: false,
				res: mismatch
			};
		}
		return {
			ok: true,
			petId,
			entry: found.entry,
			conf: found.conf,
			pet: found.pet
		};
	};
	/**
	* 动作端点的占用门禁（/anim、/broadcast、/position、/throw、/bubble/clear 共用）：放行回 null。
	* 无锁时按「有没有带 lock」分流：没带 → 放行（既有调用方零改动）；带了但查不到 → `lock-lost`。
	* 位置在决策函数之后：petId 要先解析出来才知道问哪只宠物的锁，而那时还没有任何副作用。
	*/
	const lockBlocked = (petId, params) => {
		const g = lock.gate(petId, String(params.get("lock") ?? ""));
		if (g.ok) return null;
		return failResult(g.reason, g.message, g.reason === "lock-lost" ? { cause: g.cause } : void 0);
	};
	return {
		lock,
		pose,
		sleep: sleep$2,
		sleepBlocked,
		sleepRefusalText: refuseText,
		pat,
		surfaceBlocked,
		requirePet,
		lockBlocked
	};
}

//#endregion
//#region src/host/plugin/download-report.ts
function createDownloadReport(deps) {
	const { EXTERNAL_WORK_SESSION, nextExternalWorkSeq, publishWorkStatus, workStatus } = deps;
	/** Electron 下载日志的收尾槽位保留时长（ms）：够看清「就绪 / 失败」，又不让这条日志一直盖住
	*  随后真实的工作状态（终态档在渲染端本来也会 10s 自动收起气泡）。 */
	const DOWNLOAD_SLOT_CLEAR_MS = 12 * 1e3;
	let downloadSlotTimer = null;
	/**
	* 写一条 Electron 下载日志进工作状态：桌面版用户没有控制台，这是唯一能看到「后台在下什么」的地方。
	* 借外部写入槽 `api`（不新增 section）；先 setState 再 setTask（条目不存在时 setTask 直接返回 false），
	* seq 必须递增（同档位且 seq 未更新时 setState 短路），文案按 TASK_TEXT_MAX 截断。
	*/
	const reportDownload = (text, state, terminal = false) => {
		const points = Array.from(text);
		const task = points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : text;
		workStatus.setState(EXTERNAL_WORK_SESSION, state, nextExternalWorkSeq());
		workStatus.setTask(EXTERNAL_WORK_SESSION, task);
		publishWorkStatus();
		if (!terminal) return;
		if (downloadSlotTimer !== null) clearTimeout(downloadSlotTimer);
		downloadSlotTimer = setTimeout(() => {
			downloadSlotTimer = null;
			if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
		}, DOWNLOAD_SLOT_CLEAR_MS);
		downloadSlotTimer.unref?.();
	};
	/** 停掉挂起的清槽定时器（插件卸载时调用）。 */
	const stopDownloadSlotTimer = () => {
		if (downloadSlotTimer !== null) {
			clearTimeout(downloadSlotTimer);
			downloadSlotTimer = null;
		}
	};
	return {
		reportDownload,
		stopDownloadSlotTimer
	};
}

//#endregion
//#region src/host/plugin/work-status-bridge.ts
function createWorkStatusBridge(deps) {
	const { state, workStatus, EXTERNAL_WORK_SESSION } = deps;
	const WORK_STATE_GAP_MS = 5e3;
	let publishedWork = "\0";
	let publishedState = null;
	let publishedWorkAt = 0;
	let workFlushTimer = null;
	const publishWorkStatus = () => {
		const snap = workStatus.snapshot();
		const key = String(snap.state) + "\0" + String(snap.task) + "\0" + String(snap.sessionId ?? "") + "\0" + String(snap.steps) + "\0" + String(snap.todoDone) + "/" + String(snap.todoTotal);
		if (key === publishedWork) return;
		const busyFlip = publishedState === "working" && snap.state === "result";
		const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
		if (busyFlip && wait > 0) {
			workFlushTimer ??= setTimeout(() => {
				workFlushTimer = null;
				publishWorkStatus();
			}, wait);
			return;
		}
		if (workFlushTimer !== null) {
			clearTimeout(workFlushTimer);
			workFlushTimer = null;
		}
		publishedWork = key;
		publishedState = snap.state;
		publishedWorkAt = Date.now();
		const sessionId = snap.sessionId === null || snap.sessionId === EXTERNAL_WORK_SESSION ? null : snap.sessionId;
		state.writeSection("workStatus", {
			state: snap.state,
			task: snap.task,
			sessionId,
			steps: snap.steps,
			startedAt: snap.startedAt,
			todoDone: snap.todoDone,
			todoTotal: snap.todoTotal
		});
	};
	const WORK_STATUS_SWEEP_MS = 15e3;
	const sweepTimer = setInterval(() => {
		publishWorkStatus();
	}, WORK_STATUS_SWEEP_MS);
	sweepTimer.unref?.();
	/** 停掉挂起的补写定时器与周期清扫（插件卸载时调用）。 */
	const stopWorkStatusFlush = () => {
		if (workFlushTimer !== null) {
			clearTimeout(workFlushTimer);
			workFlushTimer = null;
		}
		clearInterval(sweepTimer);
	};
	return {
		publishWorkStatus,
		stopWorkStatusFlush
	};
}

//#endregion
//#region src/host/todo/policy.ts
const MINUTE_MS = 60 * 1e3;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** 到期前的提醒档位：`[至少还剩多少毫秒, 提醒间隔]`，从宽到窄匹配。 */
const AHEAD_STEPS = [
	[3 * DAY_MS, DAY_MS],
	[DAY_MS, 12 * HOUR_MS],
	[6 * HOUR_MS, 4 * HOUR_MS],
	[HOUR_MS, HOUR_MS],
	[15 * MINUTE_MS, 20 * MINUTE_MS],
	[0, 5 * MINUTE_MS]
];
/** 逾期后的提醒间隔：1 天内 30 分钟一次，一周内 6 小时一次，再久就不再打扰。 */
const OVERDUE_FRESH_INTERVAL_MS = 30 * MINUTE_MS;
const OVERDUE_OLD_INTERVAL_MS = 6 * HOUR_MS;
/** 逾期超过这么久就不再提醒（待办仍留在清单里，等用户自己处理）。 */
const OVERDUE_STOP_MS = 7 * DAY_MS;
/** 距离到期还有这么久之前完全不提醒：一个月的远期事项不值得天天念。 */
const AHEAD_START_MS = 7 * DAY_MS;
/** 提醒文案里引用正文的长度上限（码点）：气泡放不下整条待办。 */
const REMINDER_TEXT_MAX = 18;
function reminderIntervalMs(remainingMs) {
	if (remainingMs <= 0) {
		const overdueBy = -remainingMs;
		if (overdueBy >= OVERDUE_STOP_MS) return Number.POSITIVE_INFINITY;
		return overdueBy >= DAY_MS ? OVERDUE_OLD_INTERVAL_MS : OVERDUE_FRESH_INTERVAL_MS;
	}
	if (remainingMs > AHEAD_START_MS) return Number.POSITIVE_INFINITY;
	for (const [minRemaining, interval] of AHEAD_STEPS) if (remainingMs >= minRemaining) return interval;
	return 5 * MINUTE_MS;
}
function nextReminderAt(todo, now) {
	if (todo.done || todo.dueAt === null) return null;
	const intervalNow = reminderIntervalMs(todo.dueAt - now);
	if (!Number.isFinite(intervalNow)) return null;
	if (todo.lastRemindedAt !== null) return todo.lastRemindedAt + intervalNow;
	const remainingAtCreation = todo.dueAt - todo.createdAt;
	if (remainingAtCreation > AHEAD_START_MS) return todo.createdAt + intervalNow;
	const intervalAtCreation = reminderIntervalMs(remainingAtCreation);
	const step = Math.min(Number.isFinite(intervalAtCreation) ? intervalAtCreation : 0, Math.max(0, remainingAtCreation));
	return todo.createdAt + step;
}
function pickReminder(todos, now) {
	let best = null;
	for (const todo of todos) {
		const at = nextReminderAt(todo, now);
		if (at === null || at > now) continue;
		if (best === null || at < best.at) {
			best = {
				todo,
				at
			};
			continue;
		}
		if (at === best.at) {
			const todoDue = todo.dueAt ?? Number.POSITIVE_INFINITY;
			const bestDue = best.todo.dueAt ?? Number.POSITIVE_INFINITY;
			if (todoDue < bestDue) best = {
				todo,
				at
			};
		}
	}
	return best;
}
function spanText(ms) {
	const minutes = Math.max(1, Math.round(Math.abs(ms) / MINUTE_MS));
	if (minutes < 60) return `${minutes}分钟`;
	const hours = Math.max(1, Math.round(minutes / 60));
	if (hours < 24) return `${hours}小时`;
	return `${Math.max(1, Math.round(hours / 24))}天`;
}
function truncateTodoText(text, max) {
	const chars = Array.from(text);
	return chars.length <= max ? text : chars.slice(0, max).join("") + "…";
}
function reminderText(todo, now) {
	const label = truncateTodoText(todo.text, REMINDER_TEXT_MAX);
	const dueAt = todo.dueAt ?? now;
	if (dueAt <= now) {
		if (now - dueAt < MINUTE_MS) return `「${label}」到点啦，记得处理`;
		return `「${label}」已经逾期${spanText(now - dueAt)}啦，记得处理`;
	}
	return `「${label}」还有${spanText(dueAt - now)}就到点啦`;
}

//#endregion
//#region src/host/plugin/todo-reminders.ts
/** 巡检查找间隔（ms）：比最短提醒间隔（5 分钟）小一档即可，不必更密。 */
const TICK_MS = 60 * 1e3;
/** 提醒气泡停留时长（ms）：比默认 10 秒久一点，欠着的事值得多看两眼。 */
const BUBBLE_DURATION_MS = 15 * 1e3;
/** 提醒气泡（带「知道了 / 等会儿」按钮）的停留时长：比说话气泡更久，会一直挂到用户处理。 */
const REMINDER_TTL_MS = 5 * 60 * 1e3;
/** 两拍之间的最短等待（ms）：防止对齐计算退化成一个极小的数字把定时器打成忙等。 */
const MIN_ARM_MS = 500;
function pickReminderSpeaker(pets, isLocked, isSleeping = () => false) {
	let desktopOnly = null;
	for (const pet of pets) {
		const petId = String(pet.id ?? "");
		if (petId === "") continue;
		if (pet.display === "none") continue;
		if (isLocked(petId)) continue;
		if (isSleeping(petId)) continue;
		if (pet.display === "web" || pet.display === "both") return petId;
		desktopOnly ??= petId;
	}
	return desktopOnly;
}
async function tickTodoReminders(deps) {
	if (deps.hasListener !== void 0 && !deps.hasListener()) return;
	const now = deps.now?.() ?? Date.now();
	const due = pickReminder(await deps.todos.list(), now);
	if (due === null) return;
	const pets = deps.effectivePetList();
	const speaker = pickReminderSpeaker(pets, (petId) => deps.lock.locked(petId), (petId) => deps.isSleeping?.(petId) ?? false);
	if (speaker === null) return;
	const display = String(pets.find((pet) => String(pet.id ?? "") === speaker)?.display ?? "");
	const voiceTo = deps.isVoiceTodoEnabled() ? pickVoiceSurface(display) : null;
	const text = reminderText(due.todo, now);
	deps.state.writePet(speaker, "say", {
		text,
		duration: BUBBLE_DURATION_MS,
		...voiceTo ? { voiceTo } : {}
	});
	publishReminder(deps.state, {
		id: `todo-${due.todo.id}-${now}`,
		kind: "todo",
		ts: now,
		title: due.todo.text,
		prompt: text,
		hint: "点「知道了」关掉；点「等会儿」15 分钟后再提醒。",
		...due.todo.dueAt === null ? {} : { scheduledAt: new Date(due.todo.dueAt).toISOString() },
		ttlMs: REMINDER_TTL_MS
	}, () => now);
	await deps.todos.markReminded(due.todo.id, now);
	const remainingSec = due.todo.dueAt === null ? 0 : Math.round((due.todo.dueAt - now) / 1e3);
	deps.log.info(`[dsh-pet] 待办提醒 todo=${due.todo.id} pet=${speaker} 剩余=${remainingSec}s`);
}
function registerTodoReminders(deps) {
	const { ctx, effectivePetList, isVoiceTodoEnabled, lock, log, sleep: sleep$2, state, todos, waiterCount } = deps;
	/** 一拍：失败只打日志，不让循环停摆。 */
	const tick = async () => {
		try {
			await tickTodoReminders({
				effectivePetList,
				hasListener: () => waiterCount() > 0,
				isSleeping: (petId) => sleep$2.sleeping(petId),
				isVoiceTodoEnabled,
				lock,
				log,
				state,
				todos
			});
		} catch (error) {
			log.warn("[dsh-pet] 待办提醒失败：" + (error instanceof Error ? error.message : String(error)));
		}
	};
	ctx.effect(() => {
		let disposed = false;
		let timer = null;
		/** 下一拍该等多久：对齐最近一条待办的提醒时刻（上限仍是 {@link TICK_MS}）。
		*  固定 60 秒栅格会让「16:46:54 到点」的提醒最晚晚到 60 秒（实测晚 34 秒）；
		*  按 nextReminderAt 对齐后，到点那一拍误差在 1 秒内。读清单失败退回固定间隔。 */
		async function nextDelayMs() {
			try {
				const now = Date.now();
				let next = Number.POSITIVE_INFINITY;
				for (const todo of await todos.list()) {
					const at = nextReminderAt(todo, now);
					if (at !== null && at > now) next = Math.min(next, at);
				}
				if (!Number.isFinite(next)) return TICK_MS;
				return Math.max(MIN_ARM_MS, Math.min(TICK_MS, next - now + 50));
			} catch {
				return TICK_MS;
			}
		}
		/** 排下一拍；已卸载就不再排。 */
		function arm(delayMs) {
			if (disposed) return;
			timer = setTimeout(() => void run(), delayMs);
		}
		/** 跑一拍再排下一拍：启动即检查一次，不等第一个周期。 */
		async function run() {
			timer = null;
			await tick();
			arm(await nextDelayMs());
		}
		run();
		return () => {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: todo reminders");
}

//#endregion
//#region src/host/plugin/schedule-reminders.ts
/** 兜底重扫间隔（ms）：定时器可能被系统休眠拖偏，定期对一遍目录。 */
const RESYNC_MS = 30 * 1e3;
/** 迟到容忍（ms）：超过这么久还没提醒的到点任务不再补——重启后不该翻旧账。 */
const CATCH_UP_MS = 2 * 60 * 1e3;
/** 定时器上限（ms）：超过 2^31-1 会被 Node 当成 1ms 立刻触发。 */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** 把标题压成一行，气泡放得下。 */
function clip(text, max) {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
function registerScheduleReminders(deps) {
	const now = deps.now ?? Date.now;
	const log = deps.log;
	const timers = new Map();
	/** 已提醒过的 `任务id@计划时刻`：重排与重启都不重复。 */
	const seen = new Set();
	let disposed = false;
	/** 取调度服务；插件加载早于调度器时静默跳过，下一拍再试。 */
	const service = () => {
		try {
			const svc = deps.ctx.get("schedule", false);
			return svc && typeof svc.catalog === "function" ? svc : null;
		} catch {
			return null;
		}
	};
	const clearTimer = (id) => {
		const timer = timers.get(id);
		if (timer !== void 0) clearTimeout(timer);
		timers.delete(id);
	};
	/** 到点：确认任务还在，然后写一条提醒气泡。 */
	const fire = async (id, key, title, prompt, scheduledAt, sessionId) => {
		if (disposed) return;
		if (!deps.enabled() || deps.hasClient() <= 0) return;
		const svc = service();
		if (svc === null) return;
		try {
			const rows = await svc.catalog?.() ?? [];
			if (disposed) return;
			if (!Array.isArray(rows) || !rows.some((row) => row.id === id)) return;
		} catch (e) {
			log.warn("dsh-pet: schedule reminder lookup failed: " + (e instanceof Error ? e.message : String(e)));
			return;
		}
		seen.add(key);
		log.info("dsh-pet: schedule reminder fired id=" + id);
		publishReminder(deps.state, {
			id: "r-" + id + "-" + Date.parse(scheduledAt).toString(36),
			kind: "schedule",
			ts: now(),
			title: clip(title, 60),
			...prompt === "" ? {} : { prompt: clip(prompt, 300) },
			...sessionId === "" ? {} : {
				sessionId,
				hint: "点「去会话回复」可以接着跟它说，或直接在这儿让它继续。"
			},
			scheduledAt
		}, now);
	};
	/** 对一遍目录：给新任务排定时器，给消失的任务撤定时器。 */
	const sync = async () => {
		if (disposed) return;
		const svc = service();
		if (svc === null) return;
		let rows;
		try {
			rows = await svc.catalog?.();
		} catch (e) {
			log.warn("dsh-pet: schedule catalog failed: " + (e instanceof Error ? e.message : String(e)));
			return;
		}
		if (disposed || !Array.isArray(rows)) return;
		const at = now();
		const wanted = new Map();
		for (const raw of rows) {
			const row = raw;
			if (typeof row.id !== "string" || row.id === "" || row.status !== "active") continue;
			if (typeof row.scheduledAt !== "string") continue;
			const due = Date.parse(row.scheduledAt);
			if (!Number.isFinite(due) || due < at - CATCH_UP_MS) continue;
			const key = row.id + "@" + row.scheduledAt;
			if (seen.has(key)) continue;
			wanted.set(row.id, {
				key,
				at: due,
				title: typeof row.title === "string" && row.title !== "" ? row.title : "定时任务",
				prompt: typeof row.prompt === "string" ? row.prompt : "",
				scheduledAt: row.scheduledAt,
				sessionId: typeof row.sessionId === "string" ? row.sessionId : ""
			});
		}
		for (const id of [...timers.keys()]) if (!wanted.has(id)) clearTimer(id);
		for (const [id, task] of wanted) {
			if (timers.has(id)) continue;
			const delay = Math.min(Math.max(0, task.at - at), MAX_TIMER_MS);
			timers.set(id, setTimeout(() => {
				timers.delete(id);
				fire(id, task.key, task.title, task.prompt, task.scheduledAt, task.sessionId);
			}, delay));
		}
	};
	deps.ctx.effect(() => {
		let stop = false;
		const timer = setInterval(() => {
			if (!stop) sync();
		}, RESYNC_MS);
		const off = deps.ctx.on("schedule/changed", () => {
			if (!stop) sync();
		});
		sync();
		return () => {
			stop = true;
			disposed = true;
			clearInterval(timer);
			off();
			for (const id of [...timers.keys()]) clearTimer(id);
		};
	}, "dsh-pet: schedule reminders");
	return { sync };
}

//#endregion
//#region src/host/voice/cache.ts
const CACHE_MAX_BYTES = 20 * 1024 * 1024;
const CACHE_MAX_FILES = 200;
function cachePath(userRoot, key) {
	return join(userRoot, "voice-cache", `${key}.mp3`);
}
function cacheKey(source, voice, rate, text) {
	return createHash("sha1").update(`${source}\n${voice}\n${rate}\n${text}`).digest("hex");
}
async function ensureCacheDir(userRoot) {
	const dir = join(userRoot, "voice-cache");
	await mkdir(dir, { recursive: true });
	return dir;
}
async function pruneCache(dir, limits = {}) {
	const maxBytes = limits.maxBytes ?? CACHE_MAX_BYTES;
	const maxFiles = limits.maxFiles ?? CACHE_MAX_FILES;
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	const entries = [];
	for (const name$1 of names) {
		if (!name$1.endsWith(".mp3")) continue;
		const file = join(dir, name$1);
		try {
			const info = await stat(file);
			entries.push({
				file,
				size: info.size,
				mtimeMs: info.mtimeMs
			});
		} catch {}
	}
	entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
	let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
	let totalFiles = entries.length;
	let removed = 0;
	for (const entry of entries) {
		if (totalBytes <= maxBytes && totalFiles <= maxFiles) break;
		try {
			await rm(entry.file, { force: true });
			removed += 1;
			totalBytes -= entry.size;
			totalFiles -= 1;
		} catch {}
	}
	return removed;
}

//#endregion
//#region src/host/voice/edge.ts
/** 单次合成超时（ms）：上游长时间无响应就判失败，不拖住串行队列。 */
const SYNTHESIS_TIMEOUT_MS = 15e3;
var VoiceSynthError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "VoiceSynthError";
	}
};
async function synthesize({ signal, text, voice, rate, target }) {
	const staging = `${target}.part`;
	try {
		const mod = await import("@andresaya/edge-tts");
		const EdgeTTS = mod.EdgeTTS ?? mod.default?.EdgeTTS;
		if (!EdgeTTS) throw new VoiceSynthError("依赖未导出 EdgeTTS");
		const tts = new EdgeTTS();
		const result = await tts.generate(text, voice, {
			rate,
			signal,
			timeout: SYNTHESIS_TIMEOUT_MS
		});
		await writeFile(staging, result.audio);
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { force: true }).catch(() => void 0);
		throw new VoiceSynthError(error instanceof Error ? error.message : String(error));
	}
}

//#endregion
//#region src/host/voice/speak.ts
const MAX_TEXT_CHARS = 500;
const MAX_QUEUE = 3;
/** 语速表达式：`+N%` 或 `-N%`。 */
const RATE_PATTERN = /^[+-]\d{1,3}%$/;
/** 语速下界（百分比）。 */
const RATE_MIN_PERCENT = -50;
/** 语速上界（百分比）。 */
const RATE_MAX_PERCENT = 100;
/** 第三方实现的单次合成上限（ms）：与内置同口径，避免一句卡住串行队列。 */
const PROVIDER_TIMEOUT_MS = 15e3;
/** 内置 edge 合成的总时限（ms）：依赖自带的 15s 只是「静默」超时，每来一帧就重置，不能当总时限用。 */
const BUILTIN_TIMEOUT_MS = 28e3;
/** 排队超过这么久还没轮到就丢弃（ms）：等得比一次合成还久，客户端早已放弃，再合成只是白烧上游。 */
const STALE_WAIT_MS = BUILTIN_TIMEOUT_MS;
/** 校验请求体；只认 `text` / `voice` / `rate` 三个字段，其余忽略。 */
function parseSpeakInput(raw) {
	const body = raw && typeof raw === "object" ? raw : {};
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return {
		ok: false,
		message: "text is required"
	};
	if (text.length > MAX_TEXT_CHARS) return {
		ok: false,
		message: `text too long (max ${MAX_TEXT_CHARS} chars)`
	};
	const voice = body.voice === void 0 ? DEFAULT_VOICE : body.voice;
	if (typeof voice !== "string" || !isKnownVoice(voice)) return {
		ok: false,
		message: `unknown voice; allowed: ${VOICES.map((item) => item.id).join(", ")}`
	};
	const rate = body.rate === void 0 ? "+0%" : body.rate;
	if (typeof rate !== "string" || !RATE_PATTERN.test(rate)) return {
		ok: false,
		message: "rate must look like +0% or -10%"
	};
	const percent = Number(rate.slice(1, -1));
	if (!Number.isFinite(percent) || percent < RATE_MIN_PERCENT || percent > RATE_MAX_PERCENT) return {
		ok: false,
		message: `rate out of range (${RATE_MIN_PERCENT}%..+${RATE_MAX_PERCENT}%)`
	};
	return {
		ok: true,
		value: {
			text,
			voice,
			rate
		}
	};
}
/** 断言用：`SpeakResult` 的构造点都经过这里，避免各处手写同一句文案。 */
function dropped() {
	return {
		ok: false,
		reason: "voice-busy",
		message: "queued too long, dropped"
	};
}
function rateToSpeed(rate) {
	const match = /^([+-])([0-9]{1,3})%$/.exec(rate);
	if (!match) return 1;
	const percent = Number(match[2]) * (match[1] === "-" ? -1 : 1);
	return Math.min(2, Math.max(.5, 1 + percent / 100));
}
function isQueueStale(queuedMs, nowMs, waitMs = STALE_WAIT_MS) {
	return nowMs - queuedMs > waitMs;
}
function createVoiceService(options) {
	const { userRoot, log } = options;
	const synthesizeImpl = options.synthesize ?? synthesize;
	const staleWaitMs = options.staleWaitMs ?? STALE_WAIT_MS;
	/** 已占用的队列名额（含正在跑的那个）。 */
	let queueUsed = 0;
	/** 串行链：上一件事收尾（成功或失败）后才轮到下一件。 */
	let chain = Promise.resolve();
	/** 把一次合成排进串行链；无论成败都释放名额。 */
	function enqueue(task) {
		queueUsed += 1;
		const run = chain.then(task, task);
		chain = run.then(() => void 0, () => void 0);
		return run.finally(() => {
			queueUsed -= 1;
		});
	}
	/** 缓存命中返回文件路径；不存在或空文件返回 undefined。 */
	async function findCached(target) {
		try {
			const info = await stat(target);
			return info.isFile() && info.size > 0 ? target : void 0;
		} catch {
			return void 0;
		}
	}
	async function speak(raw) {
		const parsed = parseSpeakInput(raw);
		if (!parsed.ok) return {
			ok: false,
			reason: "bad-request",
			message: parsed.message
		};
		const { text, voice, rate } = parsed.value;
		const provider = activeVoiceProvider();
		const resolved = provider ? void 0 : options.resolveEngine?.();
		const breeze = resolved?.engine === "breeze" ? resolved.breeze : void 0;
		const source = provider ? provider.id : breeze ? `breeze:${breeze.voice || "-"}:${breeze.speed}` : BUILTIN_VOICE_ID;
		const target = cachePath(userRoot, cacheKey(source, provider || breeze ? "" : voice, rate, text));
		const startedMs = Date.now();
		const cached = await findCached(target);
		if (cached) {
			log?.info?.(`[dsh-pet] voice speak: cache=hit chars=${text.length} voice=${source}`);
			return {
				ok: true,
				file: cached
			};
		}
		if (queueUsed >= MAX_QUEUE) {
			log?.warn?.(`[dsh-pet] voice speak: queue full (max ${MAX_QUEUE}) chars=${text.length} voice=${source}`);
			return {
				ok: false,
				reason: "voice-busy",
				message: "voice queue is full, retry later"
			};
		}
		const queue = { dropped: false };
		const queuedMs = Date.now();
		try {
			await enqueue(async () => {
				if (isQueueStale(queuedMs, Date.now(), staleWaitMs)) {
					queue.dropped = true;
					return;
				}
				const dir = await ensureCacheDir(userRoot);
				if (provider) await synthesizeWithProvider(provider, {
					text,
					voice,
					rate,
					target
				});
				else if (breeze) {
					const bytes = await synthesizeBreeze({
						apiKey: breeze.apiKey,
						voice: breeze.voice,
						speed: Math.min(2, Math.max(.5, rateToSpeed(rate) * breeze.speed)),
						text
					});
					await writeFile(target, bytes);
				} else await synthesizeImpl({
					signal: AbortSignal.timeout(BUILTIN_TIMEOUT_MS),
					target,
					text,
					voice,
					rate
				});
				await pruneCache(dir);
			});
		} catch (error) {
			log?.warn?.(`[dsh-pet] voice speak: failed chars=${text.length} voice=${source} ms=${Date.now() - startedMs} reason=${error instanceof VoiceSynthError ? error.message : String(error)}`);
			return {
				ok: false,
				reason: "generate-error",
				message: "voice synthesis failed"
			};
		}
		if (queue.dropped) {
			log?.warn?.(`[dsh-pet] voice speak: dropped chars=${text.length} voice=${source} queued=${Date.now() - queuedMs}ms`);
			return dropped();
		}
		log?.info?.(`[dsh-pet] voice speak: cache=miss chars=${text.length} voice=${source} ms=${Date.now() - startedMs}`);
		return {
			ok: true,
			file: target
		};
	}
	return {
		listVoices: () => VOICES,
		speak
	};
}
/** 给一个 Promise 套超时；超时 reject，原 Promise 不被取消（provider 自己该处理放弃）。 */
function withTimeout(task, timeoutMs) {
	return new Promise((resolve$1, reject) => {
		const timer = setTimeout(() => reject(new Error("voice provider timed out")), timeoutMs);
		timer.unref?.();
		task.then((value) => {
			clearTimeout(timer);
			resolve$1(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
/**
* 用第三方实现合成并落盘。
*
* 空字节按失败处理：0 字节文件会被 {@link findCached} 的 `size > 0` 跳过，
* 于是每次请求都重新合成、每次又得到空文件，白烧上游。
*/
async function synthesizeWithProvider(provider, input) {
	let bytes;
	try {
		bytes = await withTimeout(provider.synthesize({
			text: input.text,
			rate: input.rate
		}), PROVIDER_TIMEOUT_MS);
	} catch (error) {
		throw new VoiceSynthError(error instanceof Error ? error.message : String(error));
	}
	if (bytes.length === 0) throw new VoiceSynthError("voice provider returned empty audio");
	await writeFile(input.target, bytes);
}

//#endregion
//#region src/host/voice/hear.ts
const MAX_AUDIO_BYTES = 768 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 3e4;
/** base64 字面量：`Buffer.from` 解码很宽松，先按字母表与补齐规则挡掉脏数据。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
/**
* 校验请求体；只认 `audio` 与 `language` 两个字段，其余忽略。
*
* @param raw - 已解析的请求体。
* @returns 已解码的音频字节；任何字段不合法时给出可直接回给调用方的说明。
*/
function parseHearInput(raw) {
	const body = raw && typeof raw === "object" ? raw : {};
	const encoded = typeof body.audio === "string" ? body.audio.trim() : "";
	if (encoded === "") return {
		ok: false,
		message: "audio is required"
	};
	if (!BASE64_PATTERN.test(encoded) || encoded.replace(/=+$/, "").length % 4 === 1) return {
		ok: false,
		message: "audio must be base64"
	};
	const audio = new Uint8Array(Buffer.from(encoded, "base64"));
	if (audio.byteLength === 0) return {
		ok: false,
		message: "audio is empty"
	};
	if (audio.byteLength > MAX_AUDIO_BYTES) return {
		ok: false,
		message: `audio too large (max ${MAX_AUDIO_BYTES} bytes)`
	};
	const language = body.language;
	if (language !== void 0 && (typeof language !== "string" || language.trim() === "")) return {
		ok: false,
		message: "language must be a non-empty string"
	};
	return {
		ok: true,
		value: {
			audio,
			...language === void 0 ? {} : { language: language.trim() }
		}
	};
}
/**
* 给一次识别套上超时与调用方中止，把结论收敛成「值或一句说明」。
*
* 两个来源（第三方、宿主）都只认一个 signal，所以在这里合并，调用方不必各写一遍。
*
* @param signal - 调用方中止信号（连接断开）。
* @param timeoutMs - 超时上限。
* @param task - 真正执行识别的函数。
* @returns 成功给任务的值；超时或抛错给原始错误说明。
*/
async function withDeadline(signal, timeoutMs, task) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return {
			ok: true,
			value: await task(controller.signal)
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
function createHearService(options) {
	const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
	return { async hear(raw, signal) {
		const parsed = parseHearInput(raw);
		if (!parsed.ok) return {
			ok: false,
			reason: "bad-request",
			message: parsed.message
		};
		const provider = activeSpeechProvider();
		if (provider !== null) {
			const run$1 = await withDeadline(signal, timeoutMs, (inner) => provider.transcribe(parsed.value, inner));
			if (!run$1.ok) return {
				ok: false,
				reason: "generate-error",
				message: run$1.message
			};
			if (typeof run$1.value !== "string") return {
				ok: false,
				reason: "generate-error",
				message: "invalid transcript from provider"
			};
			return {
				ok: true,
				text: run$1.value
			};
		}
		const speech = options.speechToText();
		if (speech === void 0 || typeof speech.transcribe !== "function") return {
			ok: false,
			reason: "unsupported",
			message: "host has no speech-to-text service"
		};
		if (speech.listProviders().length === 0) return {
			ok: false,
			reason: "unsupported",
			message: "host has no speech provider enabled"
		};
		const run = await withDeadline(signal, timeoutMs, async (inner) => (await speech.transcribe(speech.resolve(parsed.value), inner)).text);
		if (!run.ok) return {
			ok: false,
			reason: "generate-error",
			message: run.message
		};
		return {
			ok: true,
			text: run.value
		};
	} };
}

//#endregion
//#region src/host/index.ts
const name = "pet";
const inject = [
	"webServer",
	"agentDefaultModel",
	"credentials",
	"llm",
	"commands",
	"connection"
];
function apply(ctx) {
	const setup = createHostSetup(ctx);
	const { userRoot, userConfigPath, log, configPaths, thumbUserRoot, memeDirsFor, standaloneAiPolicy, standaloneAiBalance, state, playback, workStatus, EXTERNAL_WORK_SESSION, nextExternalWorkSeq } = setup;
	const workStatusBridge = createWorkStatusBridge({
		state,
		workStatus,
		EXTERNAL_WORK_SESSION
	});
	const { publishWorkStatus, stopWorkStatusFlush } = workStatusBridge;
	const downloadReport = createDownloadReport({
		EXTERNAL_WORK_SESSION,
		nextExternalWorkSeq,
		publishWorkStatus,
		workStatus
	});
	const { reportDownload, stopDownloadSlotTimer } = downloadReport;
	const petLookup = createPetLookup({
		state,
		configPaths,
		workStatus
	});
	const { lock, pat, sleep: sleep$2, sleepRefusalText } = petLookup;
	const sessionNotify = createSessionNotify({
		ctx,
		publishWorkStatus,
		state,
		workStatus
	});
	const { pushNotifyFrame, turnFlags, terminalTimers, lastTodoText, lastReplyText, toolsInFlight, cancelTerminalCleanup, scheduleTerminalCleanup, notifyActivityTimers, scheduleCompletionNotify } = sessionNotify;
	const petReminders = createPetReminderStore({
		state,
		log,
		userRoot,
		hasClient: () => state.waiterCount() > 0
	});
	petReminders.load();
	ctx.effect(() => () => {
		petReminders.dispose();
	}, "dsh-pet: chat reminders");
	let requestRestartRef = null;
	const renamePet = async (petId, newName) => {
		try {
			const existing = readUserConfig(configPaths);
			const source = existing ?? readAllConfig(configPaths).main;
			const list = Array.isArray(source.pets) ? source.pets : [];
			const index = list.findIndex((item) => item && typeof item === "object" && String(item.id ?? "") === petId);
			if (index < 0) return false;
			const pets = list.map((item, i) => i === index ? {
				...item,
				name: newName
			} : item);
			const clean = saveUserConfig({
				...source,
				pets
			}, existing);
			if (!clean) return false;
			await mkdir(userRoot, { recursive: true });
			await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
			requestRestartRef?.();
			return true;
		} catch (e) {
			log.warn("[dsh-pet] 对话改名写盘失败：" + (e instanceof Error ? e.message : String(e)));
			return false;
		}
	};
	const configurePet = async (petId, patch) => {
		try {
			const existing = readUserConfig(configPaths);
			const source = existing ?? readAllConfig(configPaths).main;
			const list = Array.isArray(source.pets) ? source.pets : [];
			const index = list.findIndex((item) => item && typeof item === "object" && String(item.id ?? "") === petId);
			if (index < 0) return false;
			const current$2 = list[index];
			const position = current$2.position && typeof current$2.position === "object" ? current$2.position : {};
			const next = { ...current$2 };
			if (patch.size !== void 0) {
				const base = Number(current$2.size);
				next.size = Math.round((Number.isFinite(base) && base > 0 ? base : 462) * patch.size);
			}
			if (patch.corner !== void 0) next.position = {
				...position,
				corner: patch.corner
			};
			const pets = list.map((item, i) => i === index ? next : item);
			const clean = saveUserConfig({
				...source,
				pets
			}, existing);
			if (!clean) return false;
			await mkdir(userRoot, { recursive: true });
			await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
			requestRestartRef?.();
			return true;
		} catch (e) {
			log.warn("[dsh-pet] 对话改外形写盘失败：" + (e instanceof Error ? e.message : String(e)));
			return false;
		}
	};
	const chatMemory = createChatMemory({
		ctx,
		configPaths,
		log,
		memeDirsFor,
		playback,
		state,
		userRoot,
		scheduleReminder: (petId, reminder) => {
			const item = petReminders.schedule(petId, reminder.title, reminder.seconds);
			return {
				id: item.id,
				dueAt: item.dueAt
			};
		},
		renamePet,
		configurePet
	});
	const { lastWhisperAt, publishWhisper, publishSleepTalk, chatWithPet, getActivePetId, setActivePetId } = chatMemory;
	const balancePoll = createBalancePoll({
		ctx,
		configPaths,
		getActivePetId,
		log,
		state,
		standaloneAiBalance
	});
	const { effectivePetList, balancePeriodSec, whisperPeriodSec, refreshBalance, resolveActivePetId, petDisplayName } = balancePoll;
	const todos = new TodoStore({
		file: join(userRoot, TODO_FILE_NAME),
		log
	});
	const desktopHelper = createDesktopHelper({
		ctx,
		configPaths,
		effectivePetList,
		log,
		reportDownload,
		thumbUserRoot,
		getHandlePetRoute: () => httpRoute.handlePetRoute
	});
	const { startHelper, stopHelper, markDisposed } = desktopHelper;
	requestRestartRef = desktopHelper.requestRestart;
	const requests = createRequestHub({
		state,
		log,
		enabled: () => readAllConfig(configPaths).main?.requestBubbleEnabled === true,
		hasClient: () => state.waiterCount(),
		escalate: () => {
			const pets = effectivePetList();
			const pet = pickReminderSpeaker(pets, (petId) => lock.locked(petId), (petId) => sleep$2.sleeping(petId));
			if (pet === null) return;
			const display = String(pets.find((row) => String(row.id ?? "") === pet)?.display ?? "");
			if (display !== "desktop") return;
			state.writePet(pet, "position", {
				x: .5,
				y: .5,
				mode: "line",
				duration: 1400,
				returnAfter: 8e3,
				frame: "anchor"
			});
		}
	});
	ctx.effect(() => {
		const offApproval = ctx.on("approval/request", (req, next) => requests.interceptApproval(req, next), true);
		const offQuestions = ctx.on("user-questions/request", (req, next) => requests.interceptQuestions(req, next), true);
		return () => {
			offApproval();
			offQuestions();
		};
	}, "dsh-pet: user requests");
	ctx.effect(() => () => {
		pat.dispose();
	}, "dsh-pet: pat timers");
	const deps = {
		...setup,
		...petLookup,
		...workStatusBridge,
		...chatMemory,
		...balancePoll,
		...desktopHelper,
		...sessionNotify,
		ctx,
		todos,
		requests,
		voice: createVoiceService({
			userRoot,
			log,
			resolveEngine: () => resolveVoiceEngine(configPaths)
		}),
		speech: createHearService({ speechToText: () => setup.optionalService("speechToText") })
	};
	const httpRoute = createHttpRoute(deps);
	registerHttpRoute(ctx, httpRoute.handlePetRoute);
	registerSessionWatch({
		ctx,
		cancelTerminalCleanup,
		lastTodoText,
		lastReplyText,
		notifyActivityTimers,
		publishWorkStatus,
		pushNotifyFrame,
		scheduleCompletionNotify,
		scheduleTerminalCleanup,
		terminalTimers,
		toolsInFlight,
		turnFlags,
		workStatus
	});
	registerBalanceCommand({
		ctx,
		effectivePetList,
		refreshBalance,
		sleep: sleep$2,
		sleepRefusalText
	});
	registerLoops({
		ctx,
		balancePeriodSec,
		configPaths,
		lastWhisperAt,
		lock,
		log,
		publishWhisper,
		publishSleepTalk,
		refreshBalance,
		sleep: sleep$2,
		standaloneAiPolicy,
		whisperPeriodSec
	});
	registerPetCommand({
		ctx,
		effectivePetList,
		petDisplayName,
		resolveActivePetId,
		setActivePetId
	});
	registerChatCommand({
		ctx,
		chatWithPet,
		log,
		publishWhisper,
		resolveActivePetId,
		sleep: sleep$2,
		sleepRefusalText
	});
	registerTodoReminders({
		ctx,
		effectivePetList,
		isVoiceTodoEnabled: () => readAllConfig(configPaths).main?.voiceTodoEnabled === true,
		lock,
		log,
		sleep: sleep$2,
		state,
		todos,
		waiterCount: () => state.waiterCount()
	});
	registerScheduleReminders({
		ctx,
		state,
		log,
		enabled: () => readAllConfig(configPaths).main?.scheduleRemindersEnabled === true,
		hasClient: () => state.waiterCount()
	});
	registerLifecycle({
		ctx,
		lock,
		markDisposed,
		playback,
		state,
		stopDownloadSlotTimer,
		stopHelper,
		stopWorkStatusFlush
	});
	startHelper();
}

//#endregion
export { apply, inject, name };
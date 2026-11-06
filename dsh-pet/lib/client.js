;(()=>{

//#region src/shared/constants.ts
const CANVAS_H = 360;
const FEET_Y = 330;
const HIT_BOX = {
	x0: 200,
	y0: 50,
	x1: 440,
	y1: 335
};
const DRAG_THRESHOLD = 5;
const SLINGSHOT_DOUBLE_MS = 200;
const PET_REF_WIDTH = 462;
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
const ANIMATION_EXT = ".webm";

//#endregion
//#region src/shared/hotkey.ts
function isTypingTarget(target) {
	const el = target;
	if (!el || typeof el.tagName !== "string") return false;
	const tag = el.tagName.toLowerCase();
	if (tag === "input" || tag === "textarea" || tag === "select") return true;
	return el.isContentEditable === true;
}
function isBareKey(e, key) {
	if (e.ctrlKey || e.metaKey || e.altKey) return false;
	if (String(e.key).toLowerCase() !== key) return false;
	return !isTypingTarget(e.target);
}

//#endregion
//#region src/shared/display-hotkey.ts
const DISPLAY_ORDER = [
	"web",
	"desktop",
	"both",
	"none"
];
const DISPLAY_HOTKEY_HINTS = DISPLAY_ORDER.map((_, index) => String(index + 1) + " 键");
function displayOfHotkey(e) {
	for (let index = 0; index < DISPLAY_ORDER.length; index += 1) if (isBareKey(e, String(index + 1))) return DISPLAY_ORDER[index];
	return void 0;
}

//#endregion
//#region src/shared/menu/tree.ts
/** 睡着时仍然放行的菜单动作：维护类、「叫醒它」本身，以及第三方菜单项。
*  第三方要做什么由它自己决定——真去驱动宠物时会带占用锁调接口，宿主闸门在那一层再判
*  （锁优先）。在渲染端先拦掉，等于让「更多」里的第三方入口在睡觉时整体失效。 */
const SLEEP_ALLOWED_ACTIONS = [
	"sleep",
	"wake",
	"home",
	"set-display",
	"reload",
	"third-party"
];
const isSleepAllowedAction = (action) => action !== void 0 && SLEEP_ALLOWED_ACTIONS.includes(action);
/** 四个显示位置的菜单文案；键是 {@link DISPLAY_ORDER} 的元素，顺序以那边为准。 */
const DISPLAY_LABELS = {
	web: "仅网页",
	desktop: "仅桌面",
	both: "两者",
	none: "都不"
};
const displayMenuBranch = () => ({
	label: "显示位置",
	children: DISPLAY_ORDER.map((display, index) => ({
		label: DISPLAY_LABELS[display],
		action: "set-display",
		display,
		hint: DISPLAY_HOTKEY_HINTS[index]
	}))
});
const MORE_MENU_LABEL = "更多";
function readMenuItems(data, surface$1) {
	if (!data || typeof data !== "object") return [];
	const items = data.items;
	if (!Array.isArray(items)) return [];
	const out = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const rec = item;
		const rawTarget = rec.target;
		const target = rawTarget === "web" || rawTarget === "desktop" || rawTarget === "both" ? rawTarget : "both";
		if (target !== "both" && target !== surface$1) continue;
		const owner = rec.owner;
		const label = rec.label;
		if (typeof owner === "string" && owner !== "" && typeof label === "string" && label !== "") out.push({
			owner,
			label
		});
	}
	return out;
}
function buildMoreBranch(items) {
	const groups = new Map();
	for (const item of items) {
		const list = groups.get(item.owner);
		if (list) list.push(item.label);
		else groups.set(item.owner, [item.label]);
	}
	const children = [];
	for (const [owner, labels$1] of groups) if (labels$1.length === 1) children.push({
		label: labels$1[0],
		action: "third-party",
		owner
	});
	else children.push({
		label: owner,
		children: labels$1.map((label) => ({
			label,
			action: "third-party",
			owner
		}))
	});
	return children.length > 0 ? {
		label: MORE_MENU_LABEL,
		children
	} : null;
}
/** 事件名 → 分类标签（无映射时用事件名本身）。 */
const EVENT_LABELS = {
	balance: "余额档位",
	whisper: "碎碎念",
	workStatus: "工作状态"
};
const leaf = (anim) => ({
	label: anim,
	anim
});
function buildMenuTree(animations) {
	const groups = [];
	const pools = [
		["待机", animations.idle],
		["转向", animations.turn],
		["拖拽", animations.drag],
		["点击回应", animations.clicks],
		["移动", animations.moves.actions.map((m) => m.name)]
	];
	for (const [label, pool] of pools) if (pool.length) groups.push({
		label,
		children: pool.map(leaf)
	});
	const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
	for (const c of cats) groups.push({
		label: c.id,
		children: c.actions.map(leaf)
	});
	const events = animations.events ?? {};
	for (const key of Object.keys(events)) {
		const pool = events[key] ?? [];
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...slot);
		if (names.length) groups.push({
			label: EVENT_LABELS[key] ?? key,
			children: names.map(leaf)
		});
	}
	if (!groups.length) return [];
	return [{
		label: "动作",
		children: groups
	}];
}
function isNoMirrorAnimation(categories, anim) {
	return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}

//#endregion
//#region src/shared/menu/memes.ts
/**
* 可用图的名称清单：描述为空的不算。
*
* 与宿主的池判定同口径（`host/memes` 的 readMemePool 要求描述非空）：模型靠描述才认得出这张图，
* 没描述的条目即使文件存在也进不了对话与碎碎念。顺序保留配置里的书写顺序。
*/
function usableNames(memes) {
	if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
	const out = [];
	for (const [name, desc] of Object.entries(memes)) {
		if (!name.trim()) continue;
		if (typeof desc !== "string" || desc.trim() === "") continue;
		out.push(name);
	}
	return out;
}
function groupMemes(source) {
	const names = usableNames(source.memes);
	const limit = Math.floor(Number(source.chatImageLimit));
	const unlimited = !Number.isFinite(limit) || limit <= 0;
	const take = source.chatImageEnabled !== true ? 0 : unlimited ? names.length : Math.min(limit, names.length);
	return {
		chat: names.slice(0, take),
		other: names.slice(take)
	};
}
/** 单张图 → 菜单叶子：点它就是「用这张图说一句」；给了缩略图地址就带上，菜单据此画小图。 */
function memeLeaf(name, thumbOf) {
	const leaf$1 = {
		label: name,
		action: "whisper",
		image: name
	};
	if (thumbOf) leaf$1.thumb = thumbOf(name);
	return leaf$1;
}
function memeThumbUrl(baseUrl, assetRoot, name) {
	const root = assetRoot && assetRoot.trim() !== "" ? assetRoot : "main";
	return baseUrl + "/pic/memes/" + encodeURIComponent(root) + "/" + encodeURIComponent(name) + ".png";
}
function buildMemeBranch(source, thumbOf) {
	const { chat, other } = groupMemes(source);
	const leaf$1 = (name) => memeLeaf(name, thumbOf);
	const groups = [];
	if (chat.length > 0) groups.push({
		label: "纳入对话的配图",
		children: chat.map(leaf$1)
	});
	if (other.length > 0) groups.push({
		label: "其他",
		children: other.map(leaf$1)
	});
	if (groups.length === 0) return null;
	return {
		label: "配图",
		children: groups
	};
}

//#endregion
//#region src/shared/menu/css.ts
const MENU_CSS = [
	".dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;",
	"font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
	".dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}",
	".dsh-pet-menu-column{position:absolute;min-width:150px;max-width:300px;padding:4px;",
	"background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;",
	"box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;",
	"scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}",
	".dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}",
	".dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}",
	".dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;",
	"border:2px solid transparent;background-clip:content-box}",
	".dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);",
	"border:2px solid transparent;background-clip:content-box}",
	".dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}",
	".dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;",
	"gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}",
	".dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}",
	".dsh-pet-menu-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}",
	".dsh-pet-menu-thumb{width:28px;height:28px;border-radius:4px;object-fit:cover;flex:none;",
	"background:rgba(0,0,0,.06)}",
	".dsh-pet-menu-item-pic{gap:8px}",
	".dsh-pet-menu-hint{color:#9aa0a6;font-size:12px;flex:none;white-space:nowrap}",
	".dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}"
].join("");

//#endregion
//#region src/shared/menu/position.ts
/** 面板与边界、面板之间的间距（px）。 */
const PANEL_GAP = 4;
function pickPanelPosition(input) {
	const { panel, item, parent, others, clamp: clamp$1 } = input;
	const minLeft = clamp$1.x + PANEL_GAP;
	const minTop = clamp$1.y + PANEL_GAP;
	const maxLeft = clamp$1.x + clamp$1.w - PANEL_GAP - panel.w;
	const maxTop = clamp$1.y + clamp$1.h - PANEL_GAP - panel.h;
	/** 夹进 clamp；面板比 clamp 还宽/高时贴左上角。 */
	const clampX = (v) => Math.max(minLeft, Math.min(v, Math.max(minLeft, maxLeft)));
	const clampY = (v) => Math.max(minTop, Math.min(v, Math.max(minTop, maxTop)));
	const hitsOther = (left, top) => others.some((b) => left < b.right && left + panel.w > b.left && top < b.bottom && top + panel.h > b.top);
	const fitsClamp = (left, top) => left >= minLeft - .5 && left <= maxLeft + .5 && top >= minTop - .5 && top <= maxTop + .5;
	const topAtItem = clampY(item.top);
	const topAtParent = clampY(parent.top);
	const cands = [
		{
			left: parent.right + PANEL_GAP,
			top: topAtItem
		},
		{
			left: parent.left - PANEL_GAP - panel.w,
			top: topAtItem
		},
		{
			left: parent.right + PANEL_GAP,
			top: topAtParent
		},
		{
			left: parent.left - PANEL_GAP - panel.w,
			top: topAtParent
		}
	];
	const ideal = cands.find((cd) => fitsClamp(cd.left, cd.top) && !hitsOther(cd.left, cd.top));
	if (ideal) return ideal;
	const fitted = cands.map((cd) => ({
		left: clampX(cd.left),
		top: clampY(cd.top)
	})).find((cd) => !hitsOther(cd.left, cd.top));
	if (fitted) return fitted;
	return {
		left: clampX(parent.right + PANEL_GAP),
		top: clampY(topAtItem)
	};
}

//#endregion
//#region src/shared/menu/mount.ts
function isBranchNode(n) {
	return "children" in n && Array.isArray(n.children);
}
function mountContextMenu(opts) {
	const { tree, x, y, onAction, onClose, clamp: clamp$1 } = opts;
	const c = clamp$1 && Number.isFinite(clamp$1.x + clamp$1.y + clamp$1.w + clamp$1.h) ? clamp$1 : {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	};
	const root = document.createElement("div");
	root.className = "dsh-pet-menu";
	root.style.left = "0px";
	root.style.top = "0px";
	root.addEventListener("contextmenu", (e) => e.preventDefault());
	let closed = false;
	/** 每个面板当前展开的子面板（无 = 未展开）；hideChain 会沿链清除 */
	const openChild = new Map();
	/** 指针整体离开菜单树的兜底关闭定时器（root mouseover 重新进入即取消） */
	let leaveTimer = null;
	/** 关闭某面板及其后代面板整条链（display:none + 清 openChild 链） */
	const hideChain = (panel) => {
		panel.style.display = "none";
		const child = openChild.get(panel);
		if (child) {
			openChild.delete(panel);
			hideChain(child);
		}
	};
	/** 把子面板摆到触发项旁边：优先父面板右侧，放不下翻到父面板左侧，
	*  且不与任何已展开面板重叠；贴边时夹进 clamp。 */
	const showPanel = (panel, item) => {
		const rect = item.getBoundingClientRect();
		panel.style.left = "";
		panel.style.top = "";
		panel.style.display = "block";
		const parentEl = item.parentElement;
		const pr = parentEl ? parentEl.getBoundingClientRect() : rect;
		const pick$1 = pickPanelPosition({
			panel: {
				w: panel.offsetWidth,
				h: panel.offsetHeight
			},
			item: {
				left: rect.left,
				right: rect.right,
				top: rect.top
			},
			parent: {
				left: pr.left,
				right: pr.right,
				top: pr.top
			},
			others: Array.from(root.querySelectorAll(".dsh-pet-menu-column")).filter((p) => p !== panel && p.style.display !== "none").map((p) => {
				const b = p.getBoundingClientRect();
				return {
					left: b.left,
					top: b.top,
					right: b.right,
					bottom: b.bottom
				};
			}),
			clamp: {
				x: c.x,
				y: c.y,
				w: c.w,
				h: c.h
			}
		});
		panel.style.left = pick$1.left + "px";
		panel.style.top = pick$1.top + "px";
	};
	/** 构建一层面板；分支项的子面板平级挂到 root 下、不嵌套。
	*  面板先入 DOM、子面板后入，层级越深绘制越靠上（子菜单盖在父菜单上层）。 */
	const buildPanel$1 = (nodes) => {
		const panel = document.createElement("div");
		panel.className = "dsh-pet-menu-column";
		panel.style.display = "none";
		if (clamp$1) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + "px";
		root.appendChild(panel);
		for (const node of nodes) {
			const item = document.createElement("div");
			item.className = "dsh-pet-menu-item";
			if (isBranchNode(node)) {
				item.classList.add("dsh-pet-menu-branch");
				const label = document.createElement("span");
				label.className = "dsh-pet-menu-label";
				label.textContent = node.label;
				const arrow = document.createElement("span");
				arrow.className = "dsh-pet-menu-arrow";
				arrow.textContent = "▸";
				item.appendChild(label);
				item.appendChild(arrow);
				const childPanel = buildPanel$1(node.children);
				item.addEventListener("mouseenter", () => {
					const prev = openChild.get(panel);
					if (prev && prev !== childPanel) hideChain(prev);
					openChild.set(panel, childPanel);
					showPanel(childPanel, item);
				});
			} else {
				if (node.thumb) {
					const thumb = document.createElement("img");
					thumb.className = "dsh-pet-menu-thumb";
					thumb.src = node.thumb;
					thumb.alt = "";
					thumb.draggable = false;
					thumb.loading = "lazy";
					thumb.decoding = "async";
					item.appendChild(thumb);
					item.classList.add("dsh-pet-menu-item-pic");
				}
				const label = document.createElement("span");
				label.className = "dsh-pet-menu-label";
				label.textContent = node.label;
				item.appendChild(label);
				if (node.hint) {
					const hint = document.createElement("span");
					hint.className = "dsh-pet-menu-hint";
					hint.textContent = node.hint;
					item.appendChild(hint);
				}
				item.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					close();
					onAction(node);
				});
			}
			panel.appendChild(item);
		}
		return panel;
	};
	const rootPanel = buildPanel$1(tree);
	rootPanel.style.display = "block";
	document.body.appendChild(root);
	rootPanel.style.left = "";
	rootPanel.style.top = "";
	const rw = rootPanel.offsetWidth;
	const rh = rootPanel.offsetHeight;
	rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + "px";
	rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + "px";
	root.addEventListener("mouseleave", () => {
		if (leaveTimer !== null) window.clearTimeout(leaveTimer);
		leaveTimer = window.setTimeout(() => {
			leaveTimer = null;
			close();
		}, 200);
	});
	root.addEventListener("mouseover", () => {
		if (leaveTimer !== null) {
			window.clearTimeout(leaveTimer);
			leaveTimer = null;
		}
	});
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	const close = () => {
		if (closed) return;
		closed = true;
		if (leaveTimer !== null) window.clearTimeout(leaveTimer);
		leaveTimer = null;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (onClose) onClose();
	};
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/shared/tooltip.ts
const TOOLTIP_CLASS = "pet-tooltip";
const TOOLTIP_GAP_RATIO = .022;
function tooltipPlacement(cursor, tip, bounds, gap) {
	const clamp$1 = (v, lo, hi) => hi < lo ? lo : Math.min(Math.max(v, lo), hi);
	const rightMax = bounds.x + bounds.w;
	const bottomMax = bounds.y + bounds.h;
	let x = cursor.x + gap;
	if (x + tip.w > rightMax) x = cursor.x - gap - tip.w;
	x = clamp$1(x, bounds.x, rightMax - tip.w);
	let y = cursor.y + gap;
	if (y + tip.h > bottomMax) y = cursor.y - gap - tip.h;
	y = clamp$1(y, bounds.y, bottomMax - tip.h);
	return {
		x,
		y
	};
}
const TOOLTIP_CSS = [
	".pet-tooltip{",
	"position:fixed;left:0;top:0;",
	"max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.8);",
	"padding:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.010) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.021);",
	"border-radius:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.016);",
	"background:rgba(255,255,255,.96);color:#1f1f1f;",
	"border:1px solid rgba(0,0,0,.12);",
	"font-family:var(--dsh-pet-font-family,\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif);",
	"font-size:var(--dsh-pet-font-tip,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.026));line-height:1.4;",
	"white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
	"box-shadow:0 calc(var(--dsh-pet-size,var(--pet-size,462px))*0.004) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.013) rgba(0,0,0,.18);",
	"opacity:0;transition:opacity .12s ease;pointer-events:none;z-index:2}",
	".pet-tooltip.is-on{opacity:1}"
].join("");

//#endregion
//#region src/client/pet/css.ts
/** 宠物页面样式表。 */
const PET_CSS = [
	".dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}",
	".dsh-pet-root[data-corner=\"bottom-right\"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}",
	".dsh-pet-root[data-corner=\"bottom-left\"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}",
	".dsh-pet-root[data-corner=\"top-right\"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}",
	".dsh-pet-root[data-corner=\"top-left\"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}",
	".dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}",
	".dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}",
	".dsh-pet-video.is-front{opacity:1}",
	`.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:url("${ROUTE_PATH}/pic/cursor-grab.png") 16 16, grab;z-index:1;touch-action:none;-webkit-user-select:none;-webkit-touch-callout:none}`,
	`.dsh-pet-hit.dragging{cursor:url("${ROUTE_PATH}/pic/cursor-grabbing.png") 16 16, grabbing}`,
	"@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}",
	MENU_CSS,
	TOOLTIP_CSS
].join("\n");
/** 注入去重用的标记值，写在 `<style>` 的 `data-plugin-css` 上。 */
const cssTag = "dsh-pet/style.css";
function injectPetCss() {
	if (typeof document === "undefined") return;
	if (document.querySelector("style[data-plugin-css=\"" + cssTag + "\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = cssTag;
	tag.textContent = PET_CSS;
	document.head.appendChild(tag);
}

//#endregion
//#region src/shared/physics/constants.ts
const SPRING_K = 200;
const SPRING_C = 30;
const TRAIL_KEEP_MS = 200;
const RELEASE_WINDOW_MS = 150;
const RELEASE_STALE_MS = 150;
const MIN_SPAN_MS = 20;
const SEG_MIN_DT_MS = 8;
const DEAD_ZONE_SPEED = 500;
const MAX_THROW_SPEED = 3600;
const PEAK_WEIGHT = .5;
const ACCEL_REF = 8e3;
const ACCEL_GAIN_MAX = .6;
const GRAVITY = 1400;
const RESTITUTION = .78;
const GROUND_FRICTION = 2.5;
const DEFAULT_PHYSICS = {
	gravity: GRAVITY,
	restitution: RESTITUTION,
	groundFriction: GROUND_FRICTION,
	ceilingBounce: true,
	throwPower: 1,
	petCollision: true,
	hapticEnabled: true,
	tiltGravity: true,
	shakeThrow: true
};
const DEFAULT_THROW_POWER = 1;
const REST_NORMAL = 40;
const REST_TANGENT = 15;
const REST_NORMAL_EPS = 1;
const MAX_STEP_DT = .05;
const SQ_SQUASH = .55;
const SQ_DURATION_MS = 220;
const SQ_SOFT_SPEED = 300;
const SQ_HARD_SPEED = 1500;
const SQ_MAX_SQUASH = .55;
const THROW_SPEED_ANCHOR = 1200;
const SLINGSHOT_REF_RATIO = .6;
const SUBSTEP_PX = 8;
const SUBSTEP_MAX = 64;
const PET_BOUNCE_E = .995;

//#endregion
//#region src/shared/physics/squash.ts
const landingSquash = (impactSpeed) => {
	const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1);
	return Math.min(.8, 1 - t * (1 - SQ_MAX_SQUASH));
};
const squashScale = (u, squash = SQ_SQUASH) => {
	if (u < .45) {
		const p$1 = u / .45;
		return 1 - (1 - squash) * p$1 * p$1;
	}
	const p = (u - .45) / .55;
	const c1 = 1.70158;
	const c3 = c1 + 1;
	const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
	return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0));
};

//#endregion
//#region src/shared/displays.ts
const rectRight = (r) => r.x + r.width;
const rectBottom = (r) => r.y + r.height;
const pointInRect = (r, x, y) => x >= r.x && x < rectRight(r) && y >= r.y && y < rectBottom(r);
const rectAtPoint = (rects, x, y) => {
	for (const r of rects) if (pointInRect(r, x, y)) return r;
	return null;
};

//#endregion
//#region src/shared/physics/contact.ts
const CONTACT_NORMALS = {
	left: {
		nx: 1,
		ny: 0
	},
	right: {
		nx: -1,
		ny: 0
	},
	ceiling: {
		nx: 0,
		ny: 1
	},
	floor: {
		nx: 0,
		ny: -1
	}
};
const resolveContact = (speed, edge, physics, dt) => {
	const { nx, ny } = CONTACT_NORMALS[edge];
	const tx = -ny;
	const ty = nx;
	const vn = speed.vx * nx + speed.vy * ny;
	const vt = speed.vx * tx + speed.vy * ty;
	const normalSpeed = Math.abs(vn) < REST_NORMAL ? 0 : Math.abs(vn) * physics.restitution;
	const tangentSpeed = vt * Math.max(0, 1 - physics.groundFriction * dt);
	return {
		vx: normalSpeed * nx + tangentSpeed * tx,
		vy: normalSpeed * ny + tangentSpeed * ty,
		normalSpeed,
		tangentSpeed
	};
};
const isRestingOnContacts = (edges, speed) => {
	if (edges.length === 0) return false;
	return edges.every((edge) => {
		const { nx, ny } = CONTACT_NORMALS[edge];
		const normal = Math.abs(speed.vx * nx + speed.vy * ny);
		const tangent = Math.abs(speed.vx * -ny + speed.vy * nx);
		return normal < REST_NORMAL_EPS && tangent < REST_TANGENT;
	});
};

//#endregion
//#region src/shared/physics/throw.ts
const throwBounds = (o) => {
	const h = o.size * 9 / 16;
	return {
		minX: -o.sideAllow,
		minY: 0,
		maxX: o.W - o.size + o.sideAllow,
		maxY: o.H - h
	};
};
const throwStep = (s, dtRaw, b, physics = DEFAULT_PHYSICS, gravity) => {
	const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
	const g = gravity ?? {
		gx: 0,
		gy: physics.gravity
	};
	let { x, y, vx, vy } = s;
	vx += g.gx * dt;
	vy += g.gy * dt;
	x += vx * dt;
	y += vy * dt;
	let bounced = false;
	let hit = null;
	const contacts = [];
	/** 同一步撞到两条边（角落）时 hit 留更重的那个（手感只按主撞击算），contacts 全量保留。 */
	const record = (edge, speed) => {
		contacts.push(edge);
		if (hit === null || speed > hit.speed) hit = {
			edge,
			speed
		};
	};
	if (x < b.minX) {
		record("left", Math.abs(vx));
		x = b.minX;
		const out = resolveContact({
			vx,
			vy
		}, "left", physics, dt);
		vx = out.vx;
		vy = out.vy;
		bounced = true;
	} else if (x > b.maxX) {
		record("right", Math.abs(vx));
		x = b.maxX;
		const out = resolveContact({
			vx,
			vy
		}, "right", physics, dt);
		vx = out.vx;
		vy = out.vy;
		bounced = true;
	}
	if (y < b.minY) {
		if (physics.ceilingBounce) {
			record("ceiling", Math.abs(vy));
			y = b.minY;
			const out = resolveContact({
				vx,
				vy
			}, "ceiling", physics, dt);
			vx = out.vx;
			vy = out.vy;
			bounced = true;
		}
	} else if (y >= b.maxY) {
		record("floor", Math.abs(vy));
		y = b.maxY;
		const out = resolveContact({
			vx,
			vy
		}, "floor", physics, dt);
		vx = out.vx;
		vy = out.vy;
		bounced = true;
	}
	return {
		x,
		y,
		vx,
		vy,
		bounced,
		atRest: isRestingOnContacts(contacts, {
			vx,
			vy
		}),
		hit,
		contacts
	};
};
const throwSubsteps = (vx, vy, dt) => {
	const travel = Math.hypot(vx, vy) * Math.min(Math.max(dt, 0), MAX_STEP_DT);
	if (!(travel > SUBSTEP_PX)) return 1;
	return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX));
};

//#endregion
//#region src/shared/physics/spring.ts
const springStep = (v, x, target, dt, power = DEFAULT_THROW_POWER) => v + ((target - x) * SPRING_K - v * SPRING_C) * power * dt;
const softClampSpeed = (speed) => {
	if (speed <= 0) return 0;
	return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
};

//#endregion
//#region src/shared/physics/release.ts
const trimTrail = (trail, now) => {
	const cutoff = now - TRAIL_KEEP_MS;
	let i = 0;
	while (i < trail.length && trail[i].t < cutoff) i++;
	return i === 0 ? trail : trail.slice(i);
};
const throwVelocity = (angleDeg, power) => {
	const speed = softClampSpeed(power * THROW_SPEED_ANCHOR);
	const rad = angleDeg * Math.PI / 180;
	return {
		vx: Math.cos(rad) * speed,
		vy: -Math.sin(rad) * speed
	};
};
const slingshotRefDist = (size) => size > 0 ? size * SLINGSHOT_REF_RATIO : 0;
const slingshotPower = (dist, size) => {
	const ref = slingshotRefDist(size);
	if (!(ref > 0) || !(dist > 0) || !Number.isFinite(dist)) return 0;
	return dist / ref;
};
const pullAngle = (pullX, pullY) => Math.atan2(pullY, -pullX) * 180 / Math.PI;
const slingshotVelocity = (angleDeg, power, throwPower = DEFAULT_THROW_POWER) => {
	const speed = THROW_SPEED_ANCHOR * Math.max(0, power) * Math.max(0, throwPower);
	if (speed === 0) return {
		vx: 0,
		vy: 0
	};
	const rad = angleDeg * Math.PI / 180;
	return {
		vx: Math.cos(rad) * speed,
		vy: -Math.sin(rad) * speed
	};
};
const estimateReleaseVelocity = (trail, now, physics = DEFAULT_PHYSICS) => {
	if (trail.length === 0) return null;
	const last = trail[trail.length - 1];
	if (now - last.t > RELEASE_STALE_MS) return null;
	const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS);
	if (win.length < 2) return null;
	const t0 = win[0].t;
	const x0 = win[0].x;
	const y0 = win[0].y;
	const t1 = win[win.length - 1].t;
	const x1 = win[win.length - 1].x;
	const y1 = win[win.length - 1].y;
	const spanMs = t1 - t0;
	if (spanMs < MIN_SPAN_MS) return null;
	const baseVx = (x1 - x0) / spanMs * 1e3;
	const baseVy = (y1 - y0) / spanMs * 1e3;
	const baseSpeed = Math.hypot(baseVx, baseVy);
	if (baseSpeed < 1e-6) return null;
	const segSpeeds = [];
	let px$1 = x0;
	let py = y0;
	let pt$1 = t0;
	for (const s of win.slice(1)) {
		const dt = s.t - pt$1;
		if (dt >= SEG_MIN_DT_MS) {
			segSpeeds.push({
				speed: Math.hypot(s.x - px$1, s.y - py) / dt * 1e3,
				tEnd: s.t
			});
			px$1 = s.x;
			py = s.y;
			pt$1 = s.t;
		}
	}
	const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map((v) => v.speed)) : baseSpeed;
	let accel = 0;
	if (segSpeeds.length >= 2) {
		const lastSeg = segSpeeds[segSpeeds.length - 1];
		const firstSeg = segSpeeds[0];
		accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1e3, MIN_SPAN_MS / 1e3);
	}
	const speedBeforeClamp = ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) * (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
	const speed = softClampSpeed(speedBeforeClamp) * physics.throwPower;
	if (speed < DEAD_ZONE_SPEED) return null;
	return {
		vx: baseVx / baseSpeed * speed,
		vy: baseVy / baseSpeed * speed
	};
};

//#endregion
//#region src/shared/physics/collide.ts
const bodyPixelBox = (o) => {
	const h = o.size * 9 / 16;
	return {
		left: o.x + HIT_BOX.x0 / 640 * o.size,
		top: o.y + o.bottomPad + HIT_BOX.y0 / 360 * h,
		right: o.x + HIT_BOX.x1 / 640 * o.size,
		bottom: o.y + o.bottomPad + HIT_BOX.y1 / 360 * h
	};
};
const rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const collidePet = (fly, hit) => {
	const hf = fly.size * 9 / 16 / 2;
	const hh = hit.size * 9 / 16 / 2;
	const cx = hit.x + hit.size / 2 - (fly.x + fly.size / 2);
	const cy = hit.y + hh - (fly.y + hf);
	const dist = Math.hypot(cx, cy);
	if (dist < 1e-6) return null;
	const nx = cx / dist;
	const ny = cy / dist;
	const vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny;
	if (vrel <= 0) return null;
	const e = PET_BOUNCE_E;
	const m1 = fly.size * fly.size;
	const m2 = hit.size * hit.size;
	const v1n = fly.vx * nx + fly.vy * ny;
	const v2n = hit.vx * nx + hit.vy * ny;
	const v1n2 = ((m1 - e * m2) * v1n + (1 + e) * m2 * v2n) / (m1 + m2);
	const v2n2 = ((m2 - e * m1) * v2n + (1 + e) * m1 * v1n) / (m1 + m2);
	return {
		fvx: fly.vx - v1n * nx + v1n2 * nx,
		fvy: fly.vy - v1n * ny + v1n2 * ny,
		hvx: hit.vx - v2n * nx + v2n2 * nx,
		hvy: hit.vy - v2n * ny + v2n2 * ny,
		impactSpeed: vrel
	};
};
const overlapPush = (a, b) => {
	const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	if (ox <= 0 || oy <= 0) return null;
	const alongX = ox <= oy;
	const sign = alongX ? (a.left + a.right) / 2 >= (b.left + b.right) / 2 ? 1 : -1 : (a.top + a.bottom) / 2 >= (b.top + b.bottom) / 2 ? 1 : -1;
	return alongX ? {
		dx: sign * ox / 2,
		dy: 0
	} : {
		dx: 0,
		dy: sign * oy / 2
	};
};

//#endregion
//#region src/client/pet/motion/geometry.ts
function derivePetMetrics(size) {
	return {
		halfW: size / 2,
		halfH: size * 9 / 16 / 2,
		bottomPad: size * (9 / 16) * (CANVAS_H - FEET_Y) / CANVAS_H,
		sideAllow: HIT_BOX.x0 / 640 * size
	};
}
function centerToBox(center, viewport, half) {
	return {
		x: center.rx * viewport.width - half.w,
		y: center.ry * viewport.height - half.h
	};
}
function boxToRatio(box, viewport, half) {
	return {
		rx: (box.x + half.w) / viewport.width,
		ry: (box.y + half.h) / viewport.height
	};
}
const MIN_REACHABLE_PX = 24;
function clampReachableBox(box, viewport, body) {
	const inset = bodyPixelBox({
		x: 0,
		y: 0,
		size: body.size,
		bottomPad: body.bottomPad
	});
	const minX = MIN_REACHABLE_PX - inset.right;
	const maxX = viewport.width - inset.left - MIN_REACHABLE_PX;
	const minY = MIN_REACHABLE_PX - inset.bottom;
	const maxY = viewport.height - inset.top - MIN_REACHABLE_PX;
	const height = body.size * 9 / 16;
	return {
		x: clampAxis(box.x, minX, maxX, (viewport.width - body.size) / 2),
		y: clampAxis(box.y, minY, maxY, (viewport.height - height) / 2)
	};
}
/**
* 单轴夹取：视口与命中区加起来还容不下两倍下限时区间反向，改为居中，避免夹到错误的一侧。
*
* @param value - 待夹坐标（px）。
* @param lo - 允许下限（px）。
* @param hi - 允许上限（px）。
* @param centered - 区间反向时的居中坐标（px）。
* @returns 夹取后的坐标（px）。
*/
function clampAxis(value, lo, hi, centered) {
	return lo > hi ? centered : Math.min(Math.max(value, lo), hi);
}
function petStageStyle(bottomPad) {
	return { transform: "translateY(" + bottomPad + "px)" };
}
function petRootStyle(customPos, viewport, half) {
	if (!customPos) return {};
	return {
		left: customPos.rx * viewport.width - half.w + "px",
		top: customPos.ry * viewport.height - half.h + "px",
		right: "auto",
		bottom: "auto"
	};
}
const PET_HIT_STYLE = {
	left: HIT_BOX.x0 / 640 * 100 + "%",
	top: HIT_BOX.y0 / 360 * 100 + "%",
	width: (HIT_BOX.x1 - HIT_BOX.x0) / 640 * 100 + "%",
	height: (HIT_BOX.y1 - HIT_BOX.y0) / 360 * 100 + "%"
};

//#endregion
//#region src/client/pet/card/view.ts
/** 两路视频的共同属性：静音、内联播放并自动播放。 */
const VIDEO_PROPS = {
	muted: true,
	playsInline: true,
	autoPlay: true
};
function makeCardView(rt) {
	const { h } = rt;
	return function CardView(props) {
		return h("div", {
			ref: props.rootRef,
			className: "dsh-pet-root",
			"data-corner": props.corner,
			"data-facing": props.facing,
			style: Object.assign({
				"--dsh-pet-size": props.size + "px",
				"--dsh-pet-mx": props.marginX + "px",
				"--dsh-pet-my": props.marginY + "px",
				"--dsh-pet-font-bubble": props.fontBubblePx + "px",
				"--dsh-pet-font-tip": props.fontTipPx + "px"
			}, props.rootStyle),
			children: [
				props.bubble,
				h("div", {
					ref: props.stageRef,
					className: "dsh-pet-stage",
					style: props.stageStyle,
					children: [
						h("video", Object.assign({}, VIDEO_PROPS, {
							ref: props.videoARef,
							className: "dsh-pet-video is-front"
						})),
						h("video", Object.assign({}, VIDEO_PROPS, {
							ref: props.videoBRef,
							className: "dsh-pet-video"
						})),
						h("div", {
							className: "dsh-pet-hit",
							style: PET_HIT_STYLE,
							onClick: props.onClick,
							onPointerDown: props.onPointerDown,
							onPointerMove: props.onPointerMove,
							onPointerUp: props.onPointerUp,
							onPointerCancel: props.onPointerUp,
							onPointerEnter: props.onPointerEnter,
							onPointerLeave: props.onPointerLeave,
							onContextMenu: props.onContextMenu,
							onDoubleClick: props.onDoubleClick,
							"aria-label": props.name
						})
					]
				}),
				h("div", {
					ref: props.tipRef,
					className: TOOLTIP_CLASS + (props.tipOn ? " is-on" : ""),
					"aria-hidden": "true",
					children: props.name
				})
			]
		});
	};
}

//#endregion
//#region src/shared/pickers.ts
const pick = (pool, exclude) => {
	const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
	const src = entries.length ? entries : pool;
	return src[Math.floor(Math.random() * src.length)];
};
const pickSlot = (slot, exclude) => {
	if (typeof slot === "string") return slot;
	const entries = exclude === void 0 ? slot : slot.filter((n) => n !== exclude);
	const src = entries.length ? entries : slot;
	return src[Math.floor(Math.random() * src.length)];
};
const slotIncludes = (slot, anim) => typeof slot === "string" ? slot === anim : slot.includes(anim);
const poolIncludes = (pool, anim) => pool.some((slot) => slotIncludes(slot, anim));
const isEventAnim = (events, anim) => events ? Object.values(events).some((pool) => poolIncludes(pool, anim)) : false;
const nextWorkStatusAnim = (pool, current$1) => {
	const idx = pool.findIndex((slot$1) => slotIncludes(slot$1, current$1));
	if (idx === -1) return null;
	const slot = pool[idx];
	if (!Array.isArray(slot) || slot.length <= 1) return null;
	return pickSlot(slot, current$1);
};
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
const pickWeightedCategory = (categories, facing) => {
	const cats = categories.filter((c) => c.actions.length > 0);
	if (!cats.length) return null;
	const filtered = cats.filter((c) => !(c.noMirror && facing === "right"));
	const eligible = filtered.length ? filtered : cats;
	const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
	let t = Math.random() * totalW;
	for (const c of eligible) {
		t -= c.weight;
		if (t <= 0) return c;
	}
	return eligible[eligible.length - 1];
};
const rollKind = (roll, w, opts) => {
	const turn = opts?.fixed ? 0 : w.turn;
	const move = opts?.fixed || opts?.still ? 0 : w.move;
	const topEnd = (w.idle + turn + move) / 100;
	if (roll < w.idle / 100) return "idle";
	if (roll < (w.idle + turn) / 100) return "turn";
	if (roll < topEnd) return "move";
	return "action";
};
const pickCategoryAction = (categories, idlePool, facing, current$1) => {
	const cat = pickWeightedCategory(categories, facing);
	if (!cat) return {
		id: "FALLBACK",
		name: pick(idlePool, current$1)
	};
	return {
		id: cat.id,
		name: pick(cat.actions, current$1)
	};
};

//#endregion
//#region src/shared/balance/tone.ts
const QUOTA_WARN_PERCENT = 70;
const QUOTA_CRIT_PERCENT = 90;
function quotaTone(percent) {
	if (percent >= QUOTA_CRIT_PERCENT) return "crit";
	if (percent >= QUOTA_WARN_PERCENT) return "warn";
	return "ok";
}

//#endregion
//#region src/shared/balance/parse.ts
const CUSTOM_TAGS = [
	"div",
	"span",
	"i",
	"b",
	"strong",
	"em",
	"img"
];
const CUSTOM_STYLE_KEYS = new Set([
	"display",
	"flex",
	"flexDirection",
	"flexWrap",
	"alignItems",
	"justifyContent",
	"gap",
	"margin",
	"marginTop",
	"marginRight",
	"marginBottom",
	"marginLeft",
	"padding",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
	"width",
	"height",
	"minWidth",
	"maxWidth",
	"minHeight",
	"maxHeight",
	"color",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"lineHeight",
	"letterSpacing",
	"textAlign",
	"textDecoration",
	"whiteSpace",
	"verticalAlign",
	"fontVariantNumeric",
	"background",
	"backgroundColor",
	"border",
	"borderTop",
	"borderBottom",
	"borderLeft",
	"borderRight",
	"borderRadius",
	"overflow",
	"opacity"
]);
/** 样式值里一律禁止的片段：外部资源、表达式、注释截断。要图请用 `img` 节点（地址另有限制）。 */
const BANNED_STYLE_VALUE = /url\(|expression|javascript:|vbscript:|@import|\\|\/\*/i;
const CUSTOM_LIMITS = {
	maxDepth: 6,
	maxNodes: 200,
	maxChildren: 24,
	maxText: 120,
	maxStyleValue: 64,
	maxSrc: 512,
	maxViews: 4
};
/**
* 递归解析并校验一个节点，把外部输入转成视图树。
*
* 任一节点不合法即整树返回 null：部分渲染会得到一棵缺了一块的气泡，比这一拍不显示更误导人；
* 单个样式属性非法只丢那一条，不值得为此整树作废。
*
* @param raw - 外部节点；类型未知，逐层校验后才进入视图树。
* @param depth - 当前深度，根为 0。
* @param budget - 全树节点计数，跨递归共享。
* @returns 合法节点；不合法返回 null，调用方据此跳过这一拍。
*/
function parseCustomNode(raw, depth, budget) {
	if (!raw || typeof raw !== "object") return null;
	if (depth >= CUSTOM_LIMITS.maxDepth) return null;
	budget.nodes += 1;
	if (budget.nodes > CUSTOM_LIMITS.maxNodes) return null;
	const n = raw;
	const tag = typeof n.tag === "string" ? n.tag : "";
	if (!CUSTOM_TAGS.includes(tag)) return null;
	const node = { tag };
	if (typeof n.text === "string" && n.text.length > 0) node.text = n.text.slice(0, CUSTOM_LIMITS.maxText);
	if (tag === "img") {
		const src = typeof n.src === "string" ? n.src.trim() : "";
		if (!/^https?:\/\//i.test(src) || src.length > CUSTOM_LIMITS.maxSrc) return null;
		node.src = src;
	}
	if (n.style && typeof n.style === "object" && !Array.isArray(n.style)) {
		const style = {};
		for (const [k, v] of Object.entries(n.style)) {
			if (!CUSTOM_STYLE_KEYS.has(k)) continue;
			if (typeof v !== "string") continue;
			const value = v.trim();
			if (value === "" || value.length > CUSTOM_LIMITS.maxStyleValue) continue;
			if (BANNED_STYLE_VALUE.test(value)) continue;
			style[k] = value;
		}
		if (Object.keys(style).length > 0) node.style = style;
	}
	if (Array.isArray(n.children)) {
		if (n.children.length > CUSTOM_LIMITS.maxChildren) return null;
		const children = [];
		for (const child of n.children) {
			const parsed = parseCustomNode(child, depth + 1, budget);
			if (parsed === null) return null;
			children.push(parsed);
		}
		if (children.length > 0) node.children = children;
	}
	return node;
}
/** 可选数字：缺省返回 undefined，出现但非法返回 null，调用方据此跳过这一拍而不是把坏数字送进展示层。 */
function optNum(value) {
	if (value === void 0 || value === null) return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}
/**
* 解析区间累计用量：缺省返回 undefined（服务商没有这项数据），出现但不完整或非法返回 null。
*
* 五个数字缺一不可——少一个就拼不出一页可信的用量，宁可这一拍整片不显示，也不拿 0 顶替。
*/
function parseUsage(raw) {
	if (raw === void 0) return void 0;
	if (!raw || typeof raw !== "object") return null;
	const u = raw;
	const fields = [
		u.totalTokens,
		u.inputTokens,
		u.outputTokens,
		u.requests,
		u.spentUsd
	].map(optNum);
	if (fields.some((n) => typeof n !== "number")) return null;
	const [totalTokens, inputTokens, outputTokens, requests, spentUsd] = fields;
	return {
		totalTokens,
		inputTokens,
		outputTokens,
		requests,
		spentUsd
	};
}
function toBalanceState(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	const provider = String(r.provider ?? "unknown");
	if (r.ok !== true) {
		const reason = r.reason === "unsupported" || r.reason === "credential-missing" || r.reason === "fetch-error" ? r.reason : "fetch-error";
		return {
			provider,
			ok: false,
			reason,
			message: typeof r.message === "string" ? r.message : void 0
		};
	}
	const d = r.data;
	if (!d || typeof d !== "object") return null;
	if (r.shape === "windows") {
		const monthly = optNum(d.monthly);
		const rolling = optNum(d.rolling);
		const weekly = optNum(d.weekly);
		const rollingCapUsd = optNum(d.rollingCapUsd);
		const weeklyCapUsd = optNum(d.weeklyCapUsd);
		const monthlyCapUsd = optNum(d.monthlyCapUsd);
		const usage = parseUsage(d.usage);
		if (monthly === void 0 || monthly === null) return null;
		if (rolling === null || weekly === null || rollingCapUsd === null || weeklyCapUsd === null || monthlyCapUsd === null || usage === null) return null;
		return {
			provider,
			shape: "windows",
			ok: true,
			rolling,
			weekly,
			monthly,
			rollingCapUsd,
			weeklyCapUsd,
			monthlyCapUsd,
			...usage ? { usage } : {},
			rollingLabel: typeof d.rollingLabel === "string" && d.rollingLabel.length > 0 ? d.rollingLabel : void 0,
			rollingResetsAt: typeof d.rollingResetsAt === "string" ? d.rollingResetsAt : void 0,
			weeklyResetsAt: typeof d.weeklyResetsAt === "string" ? d.weeklyResetsAt : void 0,
			monthlyResetsAt: typeof d.monthlyResetsAt === "string" ? d.monthlyResetsAt : void 0
		};
	}
	if (r.shape === "money") {
		const raw$1 = Array.isArray(d.wallets) ? d.wallets : [];
		const wallets = [];
		for (const item of raw$1) {
			if (!item || typeof item !== "object") continue;
			const w = item;
			if (typeof w.currency !== "string" || w.currency.length === 0) continue;
			if (typeof w.total !== "string" || w.total.length === 0) continue;
			wallets.push({
				currency: w.currency,
				total: w.total,
				granted: typeof w.granted === "string" && w.granted.length > 0 ? w.granted : "0.00",
				toppedUp: typeof w.toppedUp === "string" && w.toppedUp.length > 0 ? w.toppedUp : "0.00",
				fullBalance: typeof w.fullBalance === "string" && w.fullBalance.length > 0 ? w.fullBalance : void 0
			});
		}
		if (wallets.length === 0) return null;
		return {
			provider,
			shape: "money",
			ok: true,
			wallets,
			tier: d.tier === "peak" || d.tier === "idle" ? d.tier : void 0
		};
	}
	if (r.shape === "points") {
		if (typeof d.unit !== "string" || d.unit.length === 0) return null;
		if (typeof d.total !== "string" || d.total.length === 0) return null;
		return {
			provider,
			shape: "points",
			ok: true,
			points: {
				unit: d.unit,
				total: d.total,
				full: typeof d.full === "string" && d.full.length > 0 ? d.full : void 0
			}
		};
	}
	if (r.shape === "custom") {
		let views = [];
		if (Array.isArray(d.views) && d.views.length > 0) {
			if (d.views.length > CUSTOM_LIMITS.maxViews) return null;
			for (const raw$1 of d.views) {
				const page = parseCustomNode(raw$1, 0, { nodes: 0 });
				if (!page) return null;
				views.push(page);
			}
		} else {
			const rows = parseCustomNode(d.rows, 0, { nodes: 0 });
			if (!rows) return null;
			views = [rows];
			if (d.detailRows !== void 0) {
				const detail = parseCustomNode(d.detailRows, 0, { nodes: 0 });
				if (!detail) return null;
				views.push(detail);
			}
		}
		const pct = typeof d.percent === "number" && Number.isFinite(d.percent) ? Math.max(0, Math.min(100, d.percent)) : void 0;
		return {
			provider,
			shape: "custom",
			ok: true,
			custom: {
				views,
				percent: pct
			}
		};
	}
	return null;
}

//#endregion
//#region src/shared/balance/handlers/custom.ts
const customHandler = {
	percent: (v) => v.custom?.percent,
	rows: () => [],
	detail: () => [],
	views: (v) => v.custom?.views
};

//#endregion
//#region src/shared/balance/handlers/money.ts
/**
* 各币种按自己的基准算剩余比例，相加后折算成已用百分比。
*
* 没有基准的币种跳过，不替它猜一个；一个带基准的币种都没有则返回 undefined，不播档位动画。
*/
function moneyPercent(v) {
	let remaining = 0;
	let based = 0;
	for (const w of v.wallets ?? []) {
		const total = Number(w.total);
		const full = Number(w.fullBalance);
		if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
		remaining += total / full;
		based++;
	}
	if (based === 0) return void 0;
	return Math.max(0, Math.min(100, 100 - remaining * 100));
}
/**
* 一行「余额（峰/谷）¥x.xx」。
*
* 只显示 total 非 0 的币种：负数要显示（透支是真的欠钱），正好 0 的不占地方；CNY 优先，
* 用符号拼接、以「/」分隔；全为 0 时兜底 ¥0.00，否则气泡会空一行。档位装饰只有提供该计价
* 规则的服务商才有，没有就不加括号那一段。
*/
function moneyRows(v) {
	const visible = (v.wallets ?? []).filter((w) => Number(w.total) !== 0).sort((a, b) => (a.currency === "CNY" ? 0 : 1) - (b.currency === "CNY" ? 0 : 1));
	const amount = visible.length > 0 ? visible.map((w) => (w.currency === "USD" ? "$" : "¥") + w.total).join("/") : "¥0.00";
	if (!v.tier) return [{
		role: "label",
		text: "余额 " + amount
	}];
	return [
		{
			role: "label",
			text: "余额（"
		},
		{
			role: "tier",
			tier: v.tier,
			text: v.tier === "peak" ? "峰" : "谷"
		},
		{
			role: "label",
			text: "）" + amount
		}
	];
}
const moneyHandler = {
	percent: moneyPercent,
	rows: moneyRows
};

//#endregion
//#region src/shared/balance/handlers/points.ts
/**
* 与 money 同一套「按基准折算」的数学，数据来自 points 而非 wallets。
*
* 没有基准或基准非法则返回 undefined，不播档位动画，也不替服务商猜一个。
*/
function pointsPercent(v) {
	const total = Number(v.points?.total);
	const full = Number(v.points?.full);
	if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) return void 0;
	return Math.max(0, Math.min(100, 100 - total / full * 100));
}
/**
* 一行「余额 800 积分」。
*
* 单位是数据带出的后缀，绝不套货币符号——$/¥ 那套判断只属于 money；0 也照常显示，0 积分是真实读数。
*/
function pointsRows(v) {
	const p = v.points;
	if (!p) return [{
		role: "label",
		text: "积分数据不可用"
	}];
	return [{
		role: "label",
		text: "余额 " + p.total + " " + p.unit
	}];
}
const pointsHandler = {
	percent: pointsPercent,
	rows: pointsRows
};

//#endregion
//#region src/shared/balance/handlers/windows.ts
const WINDOW_LABELS = {
	weekly: "周",
	monthly: "月"
};
const DEFAULT_ROLLING_LABEL = "5h";
/** 取窗口展示名：滚动窗用服务商自报值，周与月走固定表 */
function windowLabel(v, w) {
	if (w === "rolling") return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
	return WINDOW_LABELS[w];
}
/** 各窗口的满额度，全部来自数据 */
function windowQuotas(v) {
	return {
		rolling: v.rollingCapUsd,
		weekly: v.weeklyCapUsd,
		monthly: v.monthlyCapUsd
	};
}
function urgentWindow(v) {
	if (v.shape !== "windows") return void 0;
	const quotas = windowQuotas(v);
	const resets = {
		rolling: v.rollingResetsAt,
		weekly: v.weeklyResetsAt,
		monthly: v.monthlyResetsAt
	};
	const present = [
		"rolling",
		"weekly",
		"monthly"
	].filter((w) => v[w] !== void 0);
	if (present.length === 0) return void 0;
	const allQuotas = present.every((w) => {
		const quota = quotas[w];
		return quota !== void 0 && quota > 0;
	});
	let best;
	for (const w of present) {
		const percent = v[w] ?? 0;
		const quota = quotas[w];
		const cand = {
			label: windowLabel(v, w),
			percent,
			quotaUsd: quota,
			remainingUsd: allQuotas && quota !== void 0 ? quota * (100 - percent) / 100 : void 0,
			resetsAt: resets[w]
		};
		if (best === void 0) {
			best = cand;
			continue;
		}
		const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
		if (moreUrgent) best = cand;
	}
	return best;
}
function resetInText(iso) {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "";
	const delta = t - Date.now();
	if (delta <= 0) return "已重置";
	const hoursF = delta / 36e5;
	if (hoursF >= 96) return (Math.round(hoursF / 24 * 10) / 10).toFixed(1) + " 天";
	return Math.max(.1, Math.round(hoursF * 10) / 10).toFixed(1) + " 小时";
}
/** 三窗口取最大值，只有月窗口时就是它本身 */
function windowsPercent(v) {
	return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
}
/** 把 resetInText 的三种返回翻成一句提示：空串 = 时间未知，'已重置' = 已经过点，其余 = 倒计时。 */
function resetPhrase(reset) {
	if (reset === "") return "重置时间未知";
	return reset === "已重置" ? reset : reset + "重置";
}
/** 两行：最紧迫窗口的已用百分比与重置倒计时 */
function windowsRows(v) {
	const w = urgentWindow(v);
	if (!w) return [{
		role: "label",
		text: "额度数据不可用"
	}];
	const reset = resetInText(w.resetsAt);
	return [{
		role: "label",
		text: w.label + "额度已用 " + Math.round(w.percent) + "%"
	}, {
		role: "sub",
		text: resetPhrase(reset)
	}];
}
/**
* 展开态每个存在的窗口一行：窗口名、进度条、已用百分比与重置倒计时。
*
* 只列存在的窗口，rolling 与 weekly 缺省表示该服务商没有这个窗口，不补 0、不画空条。
*/
function windowsDetail(v) {
	const resets = {
		rolling: v.rollingResetsAt,
		weekly: v.weeklyResetsAt,
		monthly: v.monthlyResetsAt
	};
	const rows = [];
	for (const w of [
		"rolling",
		"weekly",
		"monthly"
	]) {
		const percent = v[w];
		if (percent === void 0) continue;
		const reset = resetInText(resets[w]);
		const usedText = Math.round(percent) + "%";
		const resetText = resetPhrase(reset);
		rows.push({
			role: "quota",
			text: windowLabel(v, w) + " " + usedText + " " + resetText,
			label: windowLabel(v, w),
			percent,
			tone: quotaTone(percent),
			usedText,
			resetText
		});
	}
	return rows.length > 0 ? rows : windowsRows(v);
}
/** 紧凑计数：1.2B / 96.0M / 478.3K，千以下取整。固定一位小数——同一页三个数字宽度稳定，不随取值跳动。 */
function compactCount(n) {
	if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
	if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
	return String(Math.round(n));
}
/**
* 第三页：本期累计用量。一行 `usage` 承载整张卡，两端摆成三行两列——
* 「Token / 总量」「输入 / 输出」「本期请求数 / 花费」，总量是唯一的大字。
*
* 服务商没给这项数据时返回 undefined，由页数判定决定气泡只有两页；给的一半数字不会被拼进来。
*/
function windowsUsage(v) {
	const u = v.usage;
	if (!u) return void 0;
	const total = compactCount(u.totalTokens);
	const input = compactCount(u.inputTokens) + " 入";
	const output = compactCount(u.outputTokens) + " 出";
	const period = "本期 " + u.requests + " 次";
	const spend = "$" + u.spentUsd.toFixed(2);
	const sum = u.inputTokens + u.outputTokens;
	const inputPercent = sum > 0 ? u.inputTokens / sum * 100 : void 0;
	return [{
		role: "usage",
		text: "Token " + total + " · " + input + " / " + output + " · " + period + " · " + spend,
		title: "Token",
		total,
		input,
		output,
		period,
		spend,
		inputPercent
	}];
}
const windowsHandler = {
	percent: windowsPercent,
	rows: windowsRows,
	detail: windowsDetail,
	usage: windowsUsage
};

//#endregion
//#region src/shared/balance/handlers/index.ts
const HANDLERS = {
	windows: windowsHandler,
	money: moneyHandler,
	points: pointsHandler,
	custom: customHandler
};

//#endregion
//#region src/shared/balance/percent.ts
function balancePercent(v) {
	return HANDLERS[v.shape].percent(v);
}
function balanceEventIndex(p) {
	if (p === 100) return 5;
	const i = Math.floor(p / 20);
	return i < 5 ? i : 4;
}

//#endregion
//#region src/shared/balance/view.ts
/**
* 不可用状态的气泡行：显式给出原因，绝不伪造数字。
*
* 次要行为空的会被剔除——空 div 在气泡里会白占一行高度。
*/
function unavailableRows(state) {
	const rows = state.reason === "unsupported" ? [{
		role: "error",
		text: "当前服务商暂不支持余额查询"
	}, {
		role: "sub",
		text: "当前服务商：" + state.provider
	}] : state.reason === "credential-missing" ? [{
		role: "error",
		text: "缺少余额查询凭证"
	}, {
		role: "sub",
		text: state.message ?? ""
	}] : [{
		role: "error",
		text: "余额查询失败"
	}, {
		role: "sub",
		text: state.message ?? ""
	}];
	return rows.filter((r) => r.role !== "quota" && r.text !== "");
}
function balanceDetailView(state) {
	if (!state.ok) return unavailableRows(state);
	const handler = HANDLERS[state.shape];
	return handler.detail ? handler.detail(state) : handler.rows(state);
}
function balancePageCount$1(state) {
	if (!state.ok) return 1;
	if (state.shape === "custom") return Math.max(1, customViews(state)?.length ?? 1);
	if (state.shape !== "windows") return 1;
	return state.usage ? 3 : 2;
}
function balancePageView(state, page) {
	if (!state.ok) return unavailableRows(state);
	const handler = HANDLERS[state.shape];
	if (state.shape !== "windows" || page <= 0) return handler.rows(state);
	if (page === 1 || !state.usage) return balanceDetailView(state);
	return handler.usage?.(state) ?? balanceDetailView(state);
}
function customViews(state) {
	if (!state.ok || state.shape !== "custom") return void 0;
	const views = HANDLERS[state.shape].views?.(state);
	return views && views.length > 0 ? views : void 0;
}
function customClickable(state) {
	return (customViews(state)?.length ?? 0) > 1;
}

//#endregion
//#region src/shared/balance/notice.ts
function decideBalanceNotice(state, lastKey, explicit) {
	if (state.ok) return {
		show: false,
		key: null
	};
	const key = state.reason + ":" + state.provider;
	return {
		show: explicit || key !== lastKey,
		key
	};
}

//#endregion
//#region src/shared/work-status.ts
const WORK_STATUS_STATES = [
	"thinking",
	"working",
	"result",
	"waiting",
	"success",
	"error"
];
const WORK_STATUS_INDEX = {
	thinking: 0,
	working: 1,
	result: 2,
	waiting: 3,
	success: 4,
	error: 5
};
function toWorkStatus(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	const state = r.state === null || typeof r.state === "string" && WORK_STATUS_STATES.includes(r.state) ? r.state : null;
	const sessionId = typeof r.sessionId === "string" && r.sessionId !== "" && r.sessionId !== "unknown" ? r.sessionId : null;
	const steps = typeof r.steps === "number" && Number.isFinite(r.steps) && r.steps > 0 ? Math.floor(r.steps) : 0;
	const startedAt = typeof r.startedAt === "number" && Number.isFinite(r.startedAt) && r.startedAt > 0 ? r.startedAt : null;
	const todoTotal = typeof r.todoTotal === "number" && Number.isFinite(r.todoTotal) && r.todoTotal > 0 ? Math.floor(r.todoTotal) : 0;
	const rawDone = typeof r.todoDone === "number" && Number.isFinite(r.todoDone) && r.todoDone > 0 ? Math.floor(r.todoDone) : 0;
	const todoDone = todoTotal > 0 ? Math.min(rawDone, todoTotal) : 0;
	return {
		state,
		task: typeof r.task === "string" ? r.task : null,
		sessionId,
		steps,
		startedAt,
		todoDone,
		todoTotal
	};
}
function isWorkingState(state) {
	return state === "thinking" || state === "working" || state === "result" || state === "waiting";
}
function progressLabel(snap, now = Date.now()) {
	if (!snap || snap.state === null) return null;
	const steps = snap.steps ?? 0;
	const startedAt = snap.startedAt ?? null;
	const minutes = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 6e4));
	if (steps <= 0 && minutes <= 0) return null;
	const parts = [];
	if (steps > 0) parts.push(`第 ${steps} 步`);
	if (minutes > 0) parts.push(`已用 ${minutes} 分钟`);
	return parts.join(" · ");
}
function todoPercent(snap) {
	const total = snap?.todoTotal ?? 0;
	if (total <= 0) return null;
	const done = Math.min(Math.max(snap?.todoDone ?? 0, 0), total);
	return Math.round(done / total * 100);
}
function todoProgressLabel(snap) {
	const total = snap?.todoTotal ?? 0;
	if (total <= 0) return null;
	const done = Math.min(Math.max(snap?.todoDone ?? 0, 0), total);
	return `${done}/${total} 项`;
}

//#endregion
//#region src/shared/state.ts
/** 叶子规范化：形状不对（非对象或 counter 非数字）→ null，不让脏数据进渲染层。 */
function normLeaf(value) {
	if (!value || typeof value !== "object") return null;
	const leaf$1 = value;
	if (typeof leaf$1.counter !== "number" || !Number.isFinite(leaf$1.counter)) return null;
	return {
		counter: leaf$1.counter,
		data: leaf$1.data ?? null
	};
}
async function fetchState(baseUrl = ROUTE_PATH + "/state", wait) {
	try {
		const url = wait ? `${baseUrl}?since=${wait.since}&timeout=${wait.timeoutMs}` : baseUrl;
		const res = await fetch(url, { cache: "no-store" });
		if (!res.ok) return null;
		const raw = await res.json().catch(() => null);
		if (!raw || typeof raw !== "object" || raw.ok === false) return null;
		const sections = {};
		const rawSections = raw.sections && typeof raw.sections === "object" ? raw.sections : {};
		for (const [name, value] of Object.entries(rawSections)) {
			const leaf$1 = normLeaf(value);
			if (leaf$1) sections[name] = leaf$1;
		}
		const pets = {};
		const rawPets = raw.pets && typeof raw.pets === "object" ? raw.pets : {};
		for (const [petId, entry] of Object.entries(rawPets)) {
			if (!entry || typeof entry !== "object") continue;
			const leaves = {};
			for (const [name, value] of Object.entries(entry)) {
				const leaf$1 = normLeaf(value);
				if (leaf$1) leaves[name] = leaf$1;
			}
			pets[petId] = leaves;
		}
		return {
			counter: typeof raw.counter === "number" && Number.isFinite(raw.counter) ? raw.counter : void 0,
			sections,
			pets
		};
	} catch {
		return null;
	}
}
/** 遍历 S 的所有叶子（sections 在前、pets 在后）。 */
function* walkLeaves(s) {
	for (const [name, leaf$1] of Object.entries(s.sections ?? {})) yield ["sections." + name, leaf$1];
	for (const [petId, leaves] of Object.entries(s.pets ?? {})) for (const [name, leaf$1] of Object.entries(leaves ?? {})) yield ["pets." + petId + "." + name, leaf$1];
}
function flattenCounters(s) {
	const out = {};
	for (const [path, leaf$1] of walkLeaves(s)) out[path] = leaf$1.counter;
	return out;
}
function takeChanged(s, baseline) {
	const out = [];
	for (const [path, leaf$1] of walkLeaves(s)) {
		if (baseline[path] === leaf$1.counter) continue;
		baseline[path] = leaf$1.counter;
		out.push({
			path,
			leaf: leaf$1
		});
	}
	return out;
}
/** 分段叶子名的全集；新增 section 叶子时与 {@link SectionLeafName} 一起改。 */
const SECTION_LEAF_NAMES = [
	"config",
	"balance",
	"workStatus",
	"notify",
	"menu",
	"focusSession",
	"request",
	"reminder",
	"history"
];
/** 宠物叶子名的全集；新增宠物叶子时与 {@link PetLeafName} 一起改。 */
const PET_LEAF_NAMES = [
	"say",
	"anim",
	"position",
	"throw",
	"lock",
	"sleep",
	"hidden"
];
/** 把字符串收窄成分段叶子名。 */
function isSectionLeafName(name) {
	return SECTION_LEAF_NAMES.includes(name);
}
/** 把字符串收窄成宠物叶子名。 */
function isPetLeafName(name) {
	return PET_LEAF_NAMES.includes(name);
}
function resolveLeafPath(path) {
	if (path.startsWith("sections.")) {
		const name$1 = path.slice(9);
		return isSectionLeafName(name$1) ? {
			where: "section",
			name: name$1
		} : null;
	}
	if (!path.startsWith("pets.")) return null;
	const rest = path.slice(5);
	const dot = rest.lastIndexOf(".");
	if (dot <= 0) return null;
	const name = rest.slice(dot + 1);
	return isPetLeafName(name) ? {
		where: "pet",
		name,
		petId: rest.slice(0, dot)
	} : null;
}
function readBalance(leaf$1) {
	const state = toBalanceState(leaf$1.data);
	if (!state) return null;
	const manual = leaf$1.data.manual === true;
	return {
		state,
		manual
	};
}
function readSay(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.clear === true) return { kind: "clear" };
	if (typeof d.text !== "string" || !d.text) return null;
	return {
		kind: "say",
		text: d.text,
		image: typeof d.image === "string" ? d.image : void 0,
		url: typeof d.url === "string" ? d.url : void 0,
		duration: typeof d.duration === "number" && Number.isFinite(d.duration) && d.duration >= 0 ? d.duration : void 0,
		anim: typeof d.anim === "boolean" ? d.anim : void 0,
		voiceTo: d.voiceTo === "web" || d.voiceTo === "desktop" ? d.voiceTo : void 0
	};
}
function readWorkStatus(leaf$1) {
	return toWorkStatus(leaf$1.data);
}
function readAnim(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	const name = typeof d.name === "string" && d.name ? d.name : void 0;
	const url = typeof d.url === "string" && d.url ? d.url : void 0;
	if (name === void 0 && url === void 0) return null;
	return {
		name,
		url,
		playbackId: typeof d.playbackId === "string" && d.playbackId ? d.playbackId : void 0,
		facing: d.facing === "left" || d.facing === "right" ? d.facing : void 0
	};
}
function readLock(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.locked === false) return { locked: false };
	if (d.locked !== true) return null;
	if (typeof d.expiresAt !== "number" || !Number.isFinite(d.expiresAt)) return null;
	return {
		locked: true,
		expiresAt: d.expiresAt
	};
}
function readSleep(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.sleeping === false) return { sleeping: false };
	if (d.sleeping !== true) return null;
	for (const name of [
		d.start,
		d.loop,
		d.end
	]) if (typeof name !== "string" || name === "") return null;
	return {
		sleeping: true,
		start: d.start,
		loop: d.loop,
		end: d.end
	};
}
function readHidden(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.hidden === false) return {
		hidden: false,
		until: 0
	};
	if (d.hidden !== true) return null;
	if (typeof d.until !== "number" || !Number.isFinite(d.until) || d.until <= 0) return null;
	return {
		hidden: true,
		until: d.until
	};
}
function readPosition(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (typeof d.x !== "number" || !Number.isFinite(d.x)) return null;
	if (typeof d.y !== "number" || !Number.isFinite(d.y)) return null;
	if (d.mode !== "instant" && d.mode !== "spring" && d.mode !== "line") return null;
	const returnAfter = typeof d.returnAfter === "number" && Number.isFinite(d.returnAfter) && d.returnAfter > 0 ? d.returnAfter : 0;
	const frame = d.frame === "anchor" ? "anchor" : "view";
	if (d.mode === "line") {
		if (typeof d.duration !== "number" || !Number.isFinite(d.duration) || d.duration < 0) return null;
		return {
			x: d.x,
			y: d.y,
			mode: "line",
			duration: d.duration,
			returnAfter,
			frame
		};
	}
	return {
		x: d.x,
		y: d.y,
		mode: d.mode,
		duration: 0,
		returnAfter,
		frame
	};
}
function readThrow(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (typeof d.angle !== "number" || !Number.isFinite(d.angle)) return null;
	if (typeof d.power !== "number" || !Number.isFinite(d.power) || d.power <= 0) return null;
	return {
		angle: d.angle,
		power: d.power
	};
}
async function postActionJson(baseUrl, body) {
	try {
		const res = await fetch(baseUrl, {
			method: "POST",
			...body === void 0 ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}
		});
		if (!res.ok) return { ok: false };
		return await res.json().catch(() => null);
	} catch {
		return null;
	}
}
async function postAction(baseUrl, body) {
	try {
		const res = await fetch(baseUrl, {
			method: "POST",
			...body === void 0 ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}
		});
		if (!res.ok) return false;
		const data = await res.json().catch(() => null);
		return data?.ok === true;
	} catch {
		return false;
	}
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
const DEFAULT_FONT = {
	family: "candy",
	size: 21,
	followPet: true
};
function fontStackOf(id) {
	return (FONT_PRESETS.find((p) => p.id === id) ?? FONT_PRESETS[0]).stack;
}
const FONT_REF_SIZE = 462;
const BUBBLE_FONT_BASE_PX = .0455 * FONT_REF_SIZE;
const TIP_FONT_BASE_PX = .026 * FONT_REF_SIZE;
function resolveFontPx(font, size) {
	const own = Number(font?.size);
	const ratio = Number.isFinite(own) && own > 0 ? own / DEFAULT_FONT.size : 1;
	const w = Number(size);
	const follow = font?.followPet !== false;
	const scale = follow && Number.isFinite(w) && w > 0 ? w / FONT_REF_SIZE : 1;
	return {
		bubble: BUBBLE_FONT_BASE_PX * ratio * scale,
		tip: TIP_FONT_BASE_PX * ratio * scale
	};
}

//#endregion
//#region src/shared/pet-size.ts
/** 人物本体宽度占画框宽度的比例；由命中框反推（240/640），不在别处再写一份 0.375。 */
const BODY_WIDTH_RATIO = (HIT_BOX.x1 - HIT_BOX.x0) / 640;
const SIZE_PERCENT_MIN = 1;
const SIZE_PERCENT_DEFAULT = 20;
function isValidSizePercent(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= SIZE_PERCENT_MIN;
}
function resolvePetSizePx(sizePx, sizePercent, viewportWidthPx) {
	const percent = sizePercent ?? SIZE_PERCENT_DEFAULT;
	if (!isValidSizePercent(percent)) return sizePx;
	if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) return sizePx;
	const bodyWidthPx = viewportWidthPx * percent / 100;
	return Math.min(sizePx, bodyWidthPx / BODY_WIDTH_RATIO);
}

//#endregion
//#region src/shared/whisper.ts
function whisperBubbleView(state) {
	if (state.ok) return [{
		role: "label",
		text: state.text
	}];
	const msg = state.reason === "provider-missing" ? "当前对话未配置模型，碎碎念不可用" : "碎碎念生成失败" + (state.message ? "：" + state.message : "");
	return [{
		role: "label",
		text: msg
	}];
}
function memeImageUrl(name, base = ROUTE_PATH, assetRoot = "") {
	const root = String(assetRoot ?? "").trim();
	const prefix = root ? "/pic/memes/" + encodeURIComponent(root) : "/pic/memes";
	return base + prefix + "/" + encodeURIComponent(name) + ".png";
}
const MEME_IMG_CLASS = "pet-bub-img";
const MEME_BUBBLE_CLASS = "has-img";
const MEME_BUBBLE_CSS = [
	".pet-bub-img{--m:var(--f,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.0455));display:block;width:calc(var(--m)*7.4725);max-width:100%;height:auto;border-radius:calc(var(--m)*0.5714);margin:0 auto calc(var(--m)*0.3736);object-fit:cover;pointer-events:none;user-select:none}",
	".pet-bubble.has-img,.dsh-pet-bubble.has-img{min-width:0}",
	".dsh-pet-voice-badge{position:absolute;right:calc(var(--f,21px)*0.25);bottom:calc(var(--f,21px)*0.15);width:calc(var(--f,21px)*0.66);height:calc(var(--f,21px)*0.66);display:flex;align-items:center;justify-content:center;font-size:calc(var(--f,21px)*0.5);line-height:1;opacity:.65;pointer-events:none}",
	".dsh-pet-voice-badge.is-loading::before{content:\"\";width:calc(var(--f,21px)*0.5);height:calc(var(--f,21px)*0.5);border:1.5px solid rgba(43,43,43,.22);border-top-color:rgba(43,43,43,.7);border-radius:50%;animation:dsh-pet-voice-spin .8s linear infinite}",
	"@keyframes dsh-pet-voice-spin{to{transform:rotate(360deg)}}",
	".dsh-pet-voice-badge.is-failed{opacity:.5}"
].join("");
/** 只注入一次（页面已有同一标记则跳过）。 */
let memeCssInjected = false;
function injectMemeBubbleCss() {
	if (memeCssInjected || typeof document === "undefined") return;
	memeCssInjected = true;
	if (document.querySelector("style[data-plugin-css=\"dsh-pet/meme-bubble\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = "dsh-pet/meme-bubble";
	tag.textContent = MEME_BUBBLE_CSS;
	document.head.appendChild(tag);
}

//#endregion
//#region src/client/bubble.ts
/** 气泡内联样式：白色半透明圆泡加底部小尾巴，盒子尺寸锚字号 `--f`，位置锚宠物尺寸。
*  width:max-content 不可省：left:50% 的绝对定位盒可用宽度只有包含块一半，shrink-to-fit
*  会先被卡死；先按内容取宽，再由 max-width 收口。box-sizing 钉死 content-box，避免宿主
*  全局 border-box 把内边距算进宽度；断词用 break-word，数字与单位不会被拆行。
*/
const bubbleCss = [
	`@font-face{font-family:"ShangshouSoftCandy";src:url("${ROUTE_PATH}/font/上首软糖体.ttf") format("truetype");font-display:swap;font-weight:400}`,
	".dsh-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% - var(--dsh-pet-size)*0.108);width:max-content;min-width:calc(var(--f)*2);max-width:min(calc(var(--f)*19),100%);box-sizing:content-box;padding:calc(var(--f)*0.75) calc(var(--f)*0.8);border-radius:calc(var(--f)*0.75);background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.08);--f0:var(--dsh-pet-font-bubble,calc(var(--dsh-pet-size)*0.0455));--f:var(--f0);color:#18181b;font-family:var(--dsh-pet-font-family,\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif);font-size:var(--f);line-height:1.55;font-variant-numeric:tabular-nums;z-index:3;pointer-events:none;box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 24px -8px rgba(0,0,0,.24);opacity:0;transition:opacity .14s ease;white-space:normal;overflow-wrap:break-word}",
	".dsh-pet-bubble::after{content:\"\";position:absolute;left:50%;bottom:calc(var(--f)*-0.3736);transform:translateX(-50%);border:calc(var(--f)*0.3736) solid transparent;border-top-color:rgba(255,255,255,.97);border-bottom:none}",
	"@keyframes dsh-pet-bubble-in{from{opacity:0;transform:translateY(calc(var(--f)*0.5)) scale(.96)}to{opacity:1;transform:none}}",
	".dsh-pet-bubble.is-on{opacity:1;animation:dsh-pet-bubble-in .18s cubic-bezier(.05,.7,.1,1) both}",
	"@keyframes dsh-pet-bub-attn{0%,100%{transform:translateX(-50%) scale(1)}45%{transform:translateX(-50%) scale(1.06)}}",
	".dsh-pet-bubble.is-on.dsh-pet-request{animation:dsh-pet-bub-attn .56s cubic-bezier(.2,.8,.2,1) 2}",
	"@media (prefers-color-scheme:dark){.dsh-pet-bubble{background:rgba(28,28,30,.96);border-color:rgba(255,255,255,.10);color:#f4f4f5;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 10px 24px -8px rgba(0,0,0,.6)}.dsh-pet-bubble::after{border-top-color:rgba(28,28,30,.96)}}",
	"@media (prefers-reduced-motion:reduce){.dsh-pet-bubble.is-on{animation:dsh-pet-bubble-in .12s linear both}.dsh-pet-bubble.is-on.dsh-pet-request{animation:dsh-pet-bubble-in .12s linear both}}",
	".dsh-pet-bubble.dsh-pet-whisper{font-size:calc(var(--f)*0.7473);min-width:calc(var(--f)*1.6);max-width:min(calc(var(--f)*10.989),100%)}",
	".dsh-pet-whisper__meta{display:block;margin-top:calc(var(--f)*0.14);font-size:calc(var(--f)*0.58);line-height:1.3;color:rgba(43,43,43,.55);font-variant-numeric:tabular-nums}",
	".dsh-pet-whisper__progress{display:flex;align-items:center;gap:calc(var(--f)*0.4);margin-top:calc(var(--f)*0.3)}",
	".dsh-pet-whisper__track{flex:1 1 auto;height:calc(var(--f)*0.3);border-radius:calc(var(--f)*0.15);background:rgba(43,43,43,.12);overflow:hidden}",
	".dsh-pet-whisper__fill{display:block;height:100%;border-radius:inherit;background:#2e9e4f;transition:width .3s cubic-bezier(.05,.7,.1,1)}",
	".dsh-pet-whisper__pct{flex:none;font-size:calc(var(--f)*0.56);line-height:1;color:rgba(43,43,43,.5);font-variant-numeric:tabular-nums}",
	".dsh-pet-bubble .pet-bub-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6);margin-bottom:calc(var(--f)*0.1978)}",
	".dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--f)*0.6593);flex-wrap:wrap}",
	".dsh-pet-bubble .pet-bub-row>span{white-space:nowrap}",
	".dsh-pet-bubble .pet-bub-sub{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}",
	".dsh-pet-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}",
	".dsh-pet-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--f)*0.7692)}",
	".dsh-pet-bubble .pet-bub-tag{margin-left:calc(var(--f)*0.2857);font-size:calc(var(--f)*0.4835);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);border-radius:calc(var(--f)*0.2857);padding:0 calc(var(--f)*0.1978);vertical-align:1px}",
	".dsh-pet-bubble .pet-bub-tier{font-weight:700}",
	".dsh-pet-bubble .pet-bub-tier-peak{color:#e53935}",
	".dsh-pet-bubble .pet-bub-tier-idle{color:#2e9e4f}",
	".dsh-pet-bubble.is-clickable{pointer-events:auto;cursor:pointer}",
	".dsh-pet-bubble.is-expanded{--f:calc(var(--f0)*0.6);width:min(calc(var(--f)*21),100%);max-width:100%}",
	".dsh-pet-bubble.is-on.is-fading{opacity:0}",
	".dsh-pet-bubble .pet-bub-quota{display:flex;align-items:center;gap:calc(var(--f)*0.4);margin:calc(var(--f)*0.13) 0}",
	".dsh-pet-bubble .pet-bub-quota-label{flex:none;min-width:calc(var(--f)*1.9);font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}",
	".dsh-pet-bubble .pet-bub-quota-bar{flex:1 1 auto;height:calc(var(--f)*0.5);border-radius:calc(var(--f)*0.25);background:rgba(43,43,43,.12);overflow:hidden}",
	".dsh-pet-bubble .pet-bub-quota-fill{display:block;height:100%;border-radius:inherit;background:#2e9e4f}",
	".dsh-pet-bubble .pet-bub-quota-fill.pet-bub-quota-warn{background:#e8952f}",
	".dsh-pet-bubble .pet-bub-quota-fill.pet-bub-quota-crit{background:#e53935}",
	".dsh-pet-bubble .pet-bub-quota-used{flex:none;min-width:calc(var(--f)*2.2);text-align:right;font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}",
	".dsh-pet-bubble .pet-bub-quota-reset{flex:none;min-width:calc(var(--f)*2.6);text-align:right;font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}",
	".dsh-pet-bubble .pet-bub-usage{display:flex;flex-direction:column;gap:calc(var(--f)*0.22);margin:calc(var(--f)*0.1) 0}",
	".dsh-pet-bubble .pet-bub-usage-line{display:flex;align-items:baseline;justify-content:space-between;gap:calc(var(--f)*0.8);line-height:1.45}",
	".dsh-pet-bubble .pet-bub-usage-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.62)}",
	".dsh-pet-bubble .pet-bub-usage-total{font-size:calc(var(--f)*1.45);line-height:1.2;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:#1f1f1f}",
	".dsh-pet-bubble .pet-bub-usage-in{font-size:calc(var(--f)*0.7692);font-variant-numeric:tabular-nums;color:#3f6ea8}",
	".dsh-pet-bubble .pet-bub-usage-out{font-size:calc(var(--f)*0.7692);font-variant-numeric:tabular-nums;color:#b4703c}",
	".dsh-pet-bubble .pet-bub-usage-period{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.62)}",
	".dsh-pet-bubble .pet-bub-usage-spend{font-size:calc(var(--f)*0.7692);font-weight:650;font-variant-numeric:tabular-nums;color:#1f1f1f}",
	".dsh-pet-bubble .pet-bub-usage-bar{display:flex;height:calc(var(--f)*0.3);border-radius:calc(var(--f)*0.15);overflow:hidden;background:rgba(43,43,43,.1);margin:calc(var(--f)*0.05) 0}",
	".dsh-pet-bubble .pet-bub-usage-bar-in{display:block;height:100%;background:#3f6ea8}",
	".dsh-pet-bubble .pet-bub-usage-bar-out{display:block;height:100%;background:#b4703c}",
	".dsh-pet-bubble.dsh-pet-request{display:flex;flex-direction:column;gap:calc(var(--f)*0.36)}",
	".dsh-pet-bubble.dsh-pet-request.is-question{max-height:min(calc(var(--f)*15),46vh);overflow:hidden;overscroll-behavior:contain}",
	".dsh-pet-request__scroll{display:flex;flex-direction:column;gap:calc(var(--f)*0.36);min-height:0;overflow-y:auto;overscroll-behavior:contain}",
	".dsh-pet-request__head{display:flex;align-items:center;gap:calc(var(--f)*0.35);min-width:0}",
	".dsh-pet-request__badge{flex:none;font-size:calc(var(--f)*0.58);font-weight:700;color:#fff;background:#e8952f;border-radius:calc(var(--f)*0.3);padding:calc(var(--f)*0.06) calc(var(--f)*0.34);letter-spacing:.02em}",
	".dsh-pet-request__badge.is-reminder{background:#3f6ea8}",
	".dsh-pet-request__badge.is-announce{background:#2e9e4f}",
	".dsh-pet-request__badge.is-chat{background:#7c5cd6}",
	".dsh-pet-request__badge.is-todo{background:#c9762a}",
	".dsh-pet-request__tool{font-size:calc(var(--f)*0.64);color:rgba(43,43,43,.62);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
	".dsh-pet-request__body{font-size:calc(var(--f)*0.7);line-height:1.45;color:#2b2b2b;word-break:break-word;max-height:min(calc(var(--f)*5.5),30vh);overflow-y:auto;overscroll-behavior:contain;white-space:pre-wrap}",
	".dsh-pet-reminder__title{font-size:calc(var(--f)*0.82);line-height:1.35;font-weight:700;color:#1f1f1f;word-break:break-word}",
	".dsh-pet-reminder__lines{display:flex;flex-direction:column;gap:calc(var(--f)*0.2);max-height:min(calc(var(--f)*8),40vh);overflow-y:auto;overscroll-behavior:contain}",
	".dsh-pet-reminder__line{font-size:calc(var(--f)*0.68);line-height:1.45;color:#2b2b2b;word-break:break-word;padding-left:calc(var(--f)*0.7);text-indent:calc(var(--f)*-0.7)}",
	".dsh-pet-reminder__line::before{content:\"·\";margin-right:calc(var(--f)*0.3);color:#3f6ea8;font-weight:700}",
	".dsh-pet-reminder__hint{font-size:calc(var(--f)*0.62);line-height:1.4;color:rgba(43,43,43,.55);word-break:break-word}",
	".dsh-pet-reminder__quick{display:flex;gap:calc(var(--f)*0.26);flex-wrap:wrap;align-items:center}",
	".dsh-pet-reminder__chip{appearance:none;font-family:inherit;font-size:calc(var(--f)*0.66);line-height:1.2;padding:calc(var(--f)*0.24) calc(var(--f)*0.52);border-radius:calc(var(--f)*0.9);cursor:pointer;border:1px solid rgba(63,110,168,.42);background:rgba(63,110,168,.08);color:#2f5687;font-weight:600;transition:background .12s ease,border-color .12s ease}",
	".dsh-pet-reminder__chip:hover{background:rgba(63,110,168,.16);border-color:rgba(63,110,168,.62)}",
	".dsh-pet-reminder__chip:disabled{opacity:.55;cursor:default}",
	".dsh-pet-reminder__chip.is-busy{background:rgba(63,110,168,.2);border-color:rgba(63,110,168,.7)}",
	".dsh-pet-reminder__reply{display:flex;gap:calc(var(--f)*0.26);align-items:center}",
	".dsh-pet-reminder__reply>.dsh-pet-request__input{flex:1 1 auto;min-width:0}",
	".dsh-pet-request__actions{display:flex;gap:calc(var(--f)*0.3);flex-wrap:wrap;align-items:center}",
	".dsh-pet-request__btn{appearance:none;font-family:inherit;font-size:calc(var(--f)*0.68);line-height:1.2;min-height:calc(var(--f)*2);padding:0 calc(var(--f)*0.8);border-radius:calc(var(--f)*0.4);cursor:pointer;border:1px solid rgba(0,0,0,.12);background:rgba(0,0,0,.03);color:#18181b;font-weight:500}",
	".dsh-pet-request__btn:hover{background:rgba(0,0,0,.06)}",
	".dsh-pet-request__btn:hover{background:rgba(43,43,43,.05)}",
	".dsh-pet-request__btn.is-primary{background:#2e9e4f;border-color:#2e9e4f;color:#fff;font-weight:650}",
	".dsh-pet-request__btn.is-primary:hover{background:#278a44}",
	".dsh-pet-request__btn.is-primary:disabled{background:rgba(43,43,43,.14);border-color:transparent;color:rgba(43,43,43,.45);cursor:default}",
	".dsh-pet-request__btn.is-ghost{border-color:transparent;background:transparent;color:rgba(43,43,43,.55);font-size:calc(var(--f)*0.6);padding-left:calc(var(--f)*0.24);padding-right:calc(var(--f)*0.24)}",
	".dsh-pet-request__question{display:flex;flex-direction:column;gap:calc(var(--f)*0.24);padding-top:calc(var(--f)*0.22);border-top:1px solid rgba(43,43,43,.1)}",
	".dsh-pet-request__question:first-child{border-top:none;padding-top:0}",
	".dsh-pet-request__title{font-size:calc(var(--f)*0.72);line-height:1.4;font-weight:650;color:#1f1f1f;word-break:break-word}",
	".dsh-pet-request__detail{font-size:calc(var(--f)*0.62);line-height:1.4;color:rgba(43,43,43,.6);max-height:calc(var(--f)*3.2);overflow-y:auto;white-space:pre-wrap;word-break:break-word}",
	".dsh-pet-request__options{display:flex;flex-wrap:wrap;gap:calc(var(--f)*0.24)}",
	".dsh-pet-request__opt{appearance:none;font-family:inherit;font-size:calc(var(--f)*0.66);line-height:1.2;padding:calc(var(--f)*0.18) calc(var(--f)*0.42);border-radius:calc(var(--f)*0.32);cursor:pointer;border:1px solid rgba(43,43,43,.18);background:rgba(43,43,43,.03);color:#2b2b2b;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-pet-request__opt.is-picked{background:#e8f3eb;border-color:#2e9e4f;color:#1d6b36;font-weight:650}",
	".dsh-pet-request__input{flex:1 1 calc(var(--f)*5);min-width:calc(var(--f)*4);font-family:inherit;font-size:calc(var(--f)*0.66);padding:calc(var(--f)*0.16) calc(var(--f)*0.3);border-radius:calc(var(--f)*0.3);border:1px solid rgba(43,43,43,.18);background:#fff;color:#2b2b2b}",
	".dsh-pet-request__input:focus{outline:none;border-color:#2e9e4f}",
	".dsh-pet-request__err{font-size:calc(var(--f)*0.62);line-height:1.45;color:#c0392b;overflow-wrap:break-word}",
	".dsh-pet-bubble.dsh-pet-history{display:flex;flex-direction:column;gap:calc(var(--f)*0.4);max-width:min(calc(var(--f)*21),100%);pointer-events:auto}",
	".dsh-pet-history__head{justify-content:space-between;align-items:center;flex-wrap:nowrap}",
	".dsh-pet-request__badge.is-history{background:#5b6472}",
	".dsh-pet-history__list{display:flex;flex-direction:column;gap:1px;max-height:min(calc(var(--f)*13),46vh);overflow-y:auto;overscroll-behavior:contain;border-top:1px solid rgba(0,0,0,.06);border-bottom:1px solid rgba(0,0,0,.06)}",
	".dsh-pet-history__row{display:flex;gap:calc(var(--f)*0.5);align-items:baseline;min-height:calc(var(--f)*1.9);padding:calc(var(--f)*0.24) calc(var(--f)*0.1);text-align:left}",
	".dsh-pet-history__row.is-clickable{cursor:pointer;border-radius:calc(var(--f)*0.3)}",
	".dsh-pet-history__row.is-clickable:hover{background:rgba(37,99,235,.07)}",
	".dsh-pet-history__time{flex:none;font-size:calc(var(--f)*0.58);color:rgba(0,0,0,.45);font-variant-numeric:tabular-nums}",
	".dsh-pet-history__body{display:flex;flex-direction:column;gap:calc(var(--f)*0.06);min-width:0}",
	".dsh-pet-history__title{font-size:calc(var(--f)*0.72);line-height:1.35;font-weight:550;color:#18181b;overflow-wrap:break-word}",
	".dsh-pet-history__sum{font-size:calc(var(--f)*0.6);line-height:1.35;color:rgba(0,0,0,.5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-pet-history__empty{font-size:calc(var(--f)*0.66);line-height:1.5;color:rgba(0,0,0,.5);padding:calc(var(--f)*0.3) 0}",
	".dsh-pet-history__foot{align-items:center;flex-wrap:nowrap}",
	".dsh-pet-history__note{font-size:calc(var(--f)*0.56);color:rgba(0,0,0,.4);line-height:1.3}",
	"@media (prefers-color-scheme:dark){.dsh-pet-history__list{border-color:rgba(255,255,255,.08)}.dsh-pet-history__title{color:#f4f4f5}.dsh-pet-history__sum,.dsh-pet-history__empty{color:rgba(255,255,255,.55)}.dsh-pet-history__time,.dsh-pet-history__note{color:rgba(255,255,255,.42)}.dsh-pet-history__row.is-clickable:hover{background:rgba(124,176,255,.14)}.dsh-pet-whisper__meta{color:rgba(255,255,255,.55)}.dsh-pet-whisper__track{background:rgba(255,255,255,.16)}.dsh-pet-whisper__fill{background:#4ade80}.dsh-pet-whisper__pct{color:rgba(255,255,255,.55)}.dsh-pet-bubble .pet-bub-title,.dsh-pet-bubble .pet-bub-sub,.dsh-pet-bubble .pet-bub-quota-label,.dsh-pet-bubble .pet-bub-quota-reset,.dsh-pet-bubble .pet-bub-usage-title,.dsh-pet-bubble .pet-bub-usage-period{color:rgba(255,255,255,.6)}.dsh-pet-bubble .pet-bub-val,.dsh-pet-bubble .pet-bub-quota-used,.dsh-pet-bubble .pet-bub-usage-total,.dsh-pet-bubble .pet-bub-usage-spend{color:#f4f4f5}.dsh-pet-bubble .pet-bub-err{color:#ff8b7a}.dsh-pet-bubble .pet-bub-tag{color:rgba(255,255,255,.55);border-color:rgba(255,255,255,.22)}.dsh-pet-bubble .pet-bub-quota-bar,.dsh-pet-bubble .pet-bub-usage-bar{background:rgba(255,255,255,.14)}.dsh-pet-request__tool{color:rgba(255,255,255,.58)}.dsh-pet-request__body,.dsh-pet-reminder__line{color:#e4e4e7}.dsh-pet-reminder__title,.dsh-pet-request__title{color:#f4f4f5}.dsh-pet-reminder__hint{color:rgba(255,255,255,.5)}.dsh-pet-request__detail{color:rgba(255,255,255,.6)}.dsh-pet-request__question{border-top-color:rgba(255,255,255,.1)}.dsh-pet-request__btn{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14);color:#f4f4f5}.dsh-pet-request__btn:hover{background:rgba(255,255,255,.12)}.dsh-pet-request__btn.is-ghost{background:transparent;border-color:transparent;color:rgba(255,255,255,.55)}.dsh-pet-request__input{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16);color:#f4f4f5}.dsh-pet-request__opt{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.18);color:#e4e4e7}.dsh-pet-request__opt.is-picked{background:rgba(46,158,79,.22);border-color:#2e9e4f;color:#9be0b0}}"
].join("\n");
function injectBubbleCss() {
	if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-pet/bubble\"]") === null) {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-pet";
		tag.dataset.pluginCss = "dsh-pet/bubble";
		tag.textContent = bubbleCss;
		document.head.appendChild(tag);
	}
}
/** 把余额行数据映射成 React 节点。 */
function rowsToNodes(h, rows) {
	if (rows.some((r) => r.role === "tier")) return h("div", {
		className: "pet-bub-row",
		children: rows.map((r, i) => {
			if (r.role === "quota") return null;
			if (r.role === "tier") return h("span", {
				key: i,
				className: "pet-bub-tier pet-bub-tier-" + r.tier,
				children: r.text
			});
			return h("span", {
				key: i,
				children: r.text
			});
		})
	});
	return rows.map((r, i) => {
		if (r.role === "quota") return h("div", {
			key: i,
			className: "pet-bub-quota",
			children: [
				h("span", {
					key: "label",
					className: "pet-bub-quota-label",
					children: r.label
				}),
				h("span", {
					key: "bar",
					className: "pet-bub-quota-bar",
					children: h("i", {
						className: "pet-bub-quota-fill pet-bub-quota-" + r.tone,
						style: { width: Math.max(0, Math.min(100, r.percent)) + "%" }
					})
				}),
				h("span", {
					key: "used",
					className: "pet-bub-quota-used",
					children: r.usedText
				}),
				h("span", {
					key: "reset",
					className: "pet-bub-quota-reset",
					children: r.resetText
				})
			]
		});
		if (r.role === "usage") return h("div", {
			key: i,
			className: "pet-bub-usage",
			children: [
				h("div", {
					key: "head",
					className: "pet-bub-usage-line",
					children: [h("span", {
						key: "title",
						className: "pet-bub-usage-title",
						children: r.title
					}), h("span", {
						key: "total",
						className: "pet-bub-usage-total",
						children: r.total
					})]
				}),
				r.inputPercent === void 0 ? null : h("div", {
					key: "bar",
					className: "pet-bub-usage-bar",
					children: [h("i", {
						key: "in",
						className: "pet-bub-usage-bar-in",
						style: { width: r.inputPercent + "%" }
					}), h("i", {
						key: "out",
						className: "pet-bub-usage-bar-out",
						style: { width: 100 - r.inputPercent + "%" }
					})]
				}),
				h("div", {
					key: "io",
					className: "pet-bub-usage-line",
					children: [h("span", {
						key: "in",
						className: "pet-bub-usage-in",
						children: r.input
					}), h("span", {
						key: "out",
						className: "pet-bub-usage-out",
						children: r.output
					})]
				}),
				h("div", {
					key: "foot",
					className: "pet-bub-usage-line",
					children: [h("span", {
						key: "period",
						className: "pet-bub-usage-period",
						children: r.period
					}), h("span", {
						key: "spend",
						className: "pet-bub-usage-spend",
						children: r.spend
					})]
				})
			]
		});
		if (r.role === "error") return h("div", {
			key: i,
			className: "pet-bub-err",
			children: r.text
		});
		if (r.role === "sub") return h("div", {
			key: i,
			className: "pet-bub-row pet-bub-sub",
			children: r.text
		});
		return h("div", {
			key: i,
			className: "pet-bub-row",
			children: r.text
		});
	});
}
/** 把自定义节点树映射成 React 节点，与 rowsToNodes 并列。
*  行数据由插件定排版，这里把第三方定好的 tag、内联样式与文本原样映射。
*  解析层已做白名单裁剪，故不做二次校验；不用 innerHTML，没有注入面。
*  先文本后子节点，与 DOM 的 textContent + appendChild 顺序一致。
*/
function treeToNodes(h, node, key) {
	const props = { key };
	if (node.style) props.style = node.style;
	if (node.tag === "img") {
		props.src = node.src ?? "";
		props.alt = "";
		return h("img", props);
	}
	const children = [];
	if (node.text) children.push(node.text);
	for (let i = 0; i < (node.children?.length ?? 0); i++) children.push(treeToNodes(h, node.children[i], i));
	props.children = children;
	return h(node.tag, props);
}
/** 换内容前的淡出等待（ms），与 opacity 过渡同为 250ms。 */
const BALANCE_FADE_MS = 250;
function makeBalanceBubble(rt) {
	const { h, useState, useEffect } = rt;
	injectBubbleCss();
	return function BalanceBubble({ state, on, index, onCycle }) {
		const [shown, setShown] = useState(0);
		const [fading, setFading] = useState(false);
		useEffect(() => {
			if (index === shown) return;
			setFading(true);
			const timer = window.setTimeout(() => {
				setShown(index);
				setFading(false);
			}, BALANCE_FADE_MS);
			return () => window.clearTimeout(timer);
		}, [index, shown]);
		const isCustom = state.ok && state.shape === "custom";
		const views = isCustom ? customViews(state) : void 0;
		const tree = views ? views[Math.min(shown, views.length - 1)] : void 0;
		const rows = isCustom ? [] : balancePageView(state, shown);
		const clickable = state.ok && (state.shape === "windows" || isCustom && customClickable(state));
		const wrap = state.ok ? "" : " dsh-pet-whisper";
		return h("div", {
			className: "dsh-pet-bubble" + wrap + (on ? " is-on" : "") + (clickable ? " is-clickable" : "") + (!isCustom && shown > 0 ? " is-expanded" : "") + (fading ? " is-fading" : ""),
			onClick: clickable ? (e) => {
				e.stopPropagation();
				onCycle();
			} : void 0,
			children: tree ? treeToNodes(h, tree, "tree") : rowsToNodes(h, rows)
		});
	};
}
function makeWhisperBubble(rt) {
	const { h } = rt;
	injectBubbleCss();
	injectMemeBubbleCss();
	return function WhisperBubble({ text, meta, percent, percentLabel, image, url, assetRoot, on, voiceState: voiceState$1 = "idle", onClick }) {
		const rows = whisperBubbleView({
			ok: true,
			text,
			ts: 0
		});
		const key = String(image ?? "").trim();
		const href = String(url ?? "").trim();
		const src = href || (key ? memeImageUrl(key, ROUTE_PATH, assetRoot) : "");
		const body = src ? [h("img", {
			key: "img",
			className: MEME_IMG_CLASS,
			src,
			alt: key || href
		}), rowsToNodes(h, rows)] : rowsToNodes(h, rows);
		const metaNode = typeof meta === "string" && meta !== "" ? h("span", {
			key: "meta",
			className: "dsh-pet-whisper__meta",
			children: meta
		}) : null;
		const pct = typeof percent === "number" && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
		const barNode = pct === null ? null : h("span", {
			key: "progress",
			className: "dsh-pet-whisper__progress",
			children: [h("span", {
				key: "track",
				className: "dsh-pet-whisper__track",
				children: [h("span", {
					key: "fill",
					className: "dsh-pet-whisper__fill",
					style: { width: pct + "%" }
				})]
			}), typeof percentLabel === "string" && percentLabel !== "" ? h("span", {
				key: "label",
				className: "dsh-pet-whisper__pct",
				children: percentLabel
			}) : null]
		});
		const textNodes = Array.isArray(body) ? body : [body];
		const tailNodes = [...metaNode === null ? [] : [metaNode], ...barNode === null ? [] : [barNode]];
		return h("div", {
			className: "dsh-pet-bubble dsh-pet-whisper" + (src ? " " + MEME_BUBBLE_CLASS : "") + (on ? " is-on" : "") + (onClick ? " is-clickable" : ""),
			onClick: onClick ? (e) => {
				e.stopPropagation();
				onClick(e);
			} : void 0,
			children: voiceState$1 === "idle" ? [...textNodes, ...tailNodes] : [[...textNodes, ...tailNodes], voiceBadgeNode(h, voiceState$1)]
		});
	};
}
/** 语音状态角标：只在手动触发的播报上出现，右下角绝对定位，不参与文字排版。
*  `failed` 用静音喇叭——「本该有声却没响」，不是系统告警，所以不上警告符号。 */
function voiceBadgeNode(h, state) {
	return h("span", {
		key: "voice",
		className: "dsh-pet-voice-badge" + (state === "loading" ? " is-loading" : "") + (state === "failed" ? " is-failed" : ""),
		"aria-hidden": "true",
		children: state === "loading" ? null : state === "failed" ? "🔇" : "🔊"
	});
}

//#endregion
//#region src/shared/todo/types.ts
/** 读一个数字，非法回落。 */
function numberOr(raw, fallback) {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}
function parseTodoItem(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw;
	if (typeof record.id !== "string" || record.id === "") return null;
	if (typeof record.text !== "string") return null;
	const dueAt = record.dueAt === null || record.dueAt === void 0 ? null : typeof record.dueAt === "number" && Number.isFinite(record.dueAt) ? record.dueAt : void 0;
	if (dueAt === void 0) return null;
	return {
		id: record.id,
		text: record.text,
		dueAt,
		done: record.done === true,
		createdAt: numberOr(record.createdAt, 0),
		updatedAt: numberOr(record.updatedAt, 0),
		completedAt: typeof record.completedAt === "number" ? record.completedAt : null
	};
}
function parseTodoList(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const item of raw) {
		const todo = parseTodoItem(item);
		if (todo !== null) out.push(todo);
	}
	return out;
}

//#endregion
//#region src/shared/todo/api.ts
const TODOS_PATH = ROUTE_PATH + "/todos";
/** 发一次请求并收窄最外层：协议失败、业务失败、非 JSON 都归成失败。 */
async function send(url, method, body) {
	try {
		const response = await fetch(url, {
			method,
			cache: "no-store",
			...body === void 0 ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok) return {
			failed: true,
			message: `请求失败（HTTP ${response.status}）`
		};
		if (payload === null) return {
			failed: true,
			message: "响应不是 JSON"
		};
		if (payload.ok === false) {
			const reason = typeof payload.message === "string" ? payload.message : payload.reason;
			return {
				failed: true,
				message: typeof reason === "string" && reason !== "" ? reason : "请求被拒绝"
			};
		}
		return {
			failed: false,
			body: payload
		};
	} catch (error) {
		return {
			failed: true,
			message: "连不上桌宠服务：" + (error instanceof Error ? error.message : String(error))
		};
	}
}
/** 单条响应 → 待办；形状不对时给出可展示的失败。 */
function readTodo(body) {
	const todo = parseTodoItem(body.todo);
	return todo === null ? {
		ok: false,
		message: "响应里没有有效的待办"
	} : {
		ok: true,
		value: todo
	};
}
async function loadTodos(baseUrl = TODOS_PATH) {
	const result = await send(baseUrl, "GET");
	if (result.failed) return {
		ok: false,
		message: result.message
	};
	return {
		ok: true,
		value: parseTodoList(result.body.todos)
	};
}
async function addTodo(text, dueAt, baseUrl = TODOS_PATH) {
	const result = await send(baseUrl, "POST", {
		text,
		dueAt
	});
	if (result.failed) return {
		ok: false,
		message: result.message
	};
	return readTodo(result.body);
}
async function patchTodo(id, patch, baseUrl = TODOS_PATH) {
	const result = await send(baseUrl + "/" + encodeURIComponent(id), "PATCH", patch);
	if (result.failed) return {
		ok: false,
		message: result.message
	};
	return readTodo(result.body);
}
async function removeTodo(id, baseUrl = TODOS_PATH) {
	const result = await send(baseUrl + "/" + encodeURIComponent(id), "DELETE");
	if (result.failed) return {
		ok: false,
		message: result.message
	};
	return {
		ok: true,
		value: typeof result.body.removed === "number" ? result.body.removed : 0
	};
}

//#endregion
//#region src/shared/todo/natural-time.ts
/**
* 把一句话说的时间解析成时间戳：待办的「提醒时间」用它，不用先点日历再挑数字。
*
* 支持的说法（去掉空白后匹配，全角数字与冒号会先归一）：
* - 相对：`5分钟后`、`半个小时之后`、`一个半小时后`、`两小时`、`三天后`、`两周后`、`一个月后`；
* - 日子：`今天`、`明天`、`后天`、`大后天`、`周五`、`星期五`、`下周一`、`周三下午`；
* - 时刻：`9点`、`9点半`、`9点20`、`21:30`、`下午3点`、`晚上八点`、`早上七点一刻`；
* - 组合：`明天早上九点`、`下周一上午10点半`、`今晚8点`、`8月20日 14:00`。
*
* 只给日子不给时刻时，默认当天早上九点（与日历选择器的默认值一致）；只给时刻且今天已经过了，
* 就顺延到明天。解析不出来返回 null——调用方自己决定提示什么，这里不猜。
* @module dsh-pet/src/shared/todo/natural-time
*/
/** 只说了日子、没说时刻时的默认钟点（与日历选择器的 `DEFAULT_HOUR` 一致）。 */
const DEFAULT_DUE_HOUR = 9;
/** 相对时间的单位（毫秒）。`个月` 按 30 天算：只用于「一个月后」这类粗粒度说法。 */
const UNIT_MS = {
	秒: 1e3,
	秒钟: 1e3,
	分: 60 * 1e3,
	分钟: 60 * 1e3,
	小时: 60 * 60 * 1e3,
	钟头: 60 * 60 * 1e3,
	天: 24 * 60 * 60 * 1e3,
	日: 24 * 60 * 60 * 1e3,
	周: 7 * 24 * 60 * 60 * 1e3,
	星期: 7 * 24 * 60 * 60 * 1e3,
	礼拜: 7 * 24 * 60 * 60 * 1e3,
	个月: 30 * 24 * 60 * 60 * 1e3,
	月: 30 * 24 * 60 * 60 * 1e3
};
/** 时刻前的时段词与它带来的偏移（下午 3 点 = 15 点）。 */
const PERIODS = [
	["凌晨", 0],
	["清晨", 0],
	["早上", 0],
	["早晨", 0],
	["上午", 0],
	["中午", 12],
	["下午", 12],
	["傍晚", 12],
	["傍晚", 12],
	["晚上", 12],
	["夜里", 12],
	["夜间", 12]
];
/** 日子词与相对今天的天数；长的写在前面，先匹配「大后天」再匹配「后天」。 */
const DAY_WORDS = [
	["大后天", 3],
	["后天", 2],
	["明天", 1],
	["明日", 1],
	["今天", 0],
	["今日", 0]
];
/** 「今晚 / 明晚 / 昨晚」这类把日子和晚上连在一起的说法。 */
const EVENING_WORDS = [
	["明晚", 1],
	["今晚", 0],
	["今儿晚上", 0]
];
/** 周几：周一为 1，周日为 7。 */
const WEEK_DAYS = {
	一: 1,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	日: 7,
	天: 7
};
/** 中文数字（含「十」「十二」「二十」这类组合），解析不了返回 null。 */
function chineseNumber(raw) {
	if (!raw) return null;
	if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
	if (raw === "半") return .5;
	const half = /^(.+)个半$/.exec(raw);
	if (half) {
		const base = chineseNumber(half[1]);
		return base === null ? null : base + .5;
	}
	const trimmed = raw.endsWith("个") ? raw.slice(0, -1) : raw;
	const digits = {
		零: 0,
		一: 1,
		二: 2,
		两: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9
	};
	const ten = /^([零一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(trimmed);
	if (ten) {
		const high = ten[1] ? digits[ten[1]] : 1;
		const low = ten[2] ? digits[ten[2]] : 0;
		return high * 10 + low;
	}
	if (trimmed.length === 1 && trimmed in digits) return digits[trimmed];
	return null;
}
/** 当天零点。 */
function startOfDay$2(base) {
	return new Date(base.getFullYear(), base.getMonth(), base.getDate());
}
/** 加天数（跨月由 Date 自己处理）。 */
function addDays(base, days) {
	return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}
/** 本周一（周一为一周首日）。 */
function mondayOf(base) {
	const day = base.getDay();
	const offset = day === 0 ? -6 : 1 - day;
	return addDays(startOfDay$2(base), offset);
}
/** 全角转半角 + 去掉空白，让后续正则只面对一种写法。 */
function normalize(input) {
	return input.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248)).replace(/\uFF1A/g, ":").replace(/\s+/g, "");
}
/** 相对时间：`5分钟后`、`一个半小时后`、`两小时`。 */
function matchRelative(text, now) {
	const m = /^(.+?)(?:个)?(秒钟|秒|分钟|分|小时|钟头|天|日|周|星期|礼拜|个月|月)(?:之后|以后|后|内)?$/.exec(text);
	if (!m) return null;
	const unit = UNIT_MS[m[2]];
	if (unit === void 0) return null;
	const amount = chineseNumber(m[1]);
	if (amount === null || amount <= 0) return null;
	return now.getTime() + Math.round(amount * unit);
}
/** 解析「9点」「9点半」「9点20」「21:30」「七点一刻」「八点半」；返回时刻与剩下的文本。 */
function parseClock(text) {
	const colon = /^(\d{1,2}):(\d{2})/.exec(text);
	if (colon) {
		const hour$1 = Number(colon[1]);
		const minute$1 = Number(colon[2]);
		if (hour$1 > 23 || minute$1 > 59) return null;
		return {
			hour: hour$1,
			minute: minute$1,
			rest: text.slice(colon[0].length)
		};
	}
	const m = /^(\d{1,2}|[零一二两三四五六七八九十]{1,3})[点时]/.exec(text);
	if (!m) return null;
	const hour = chineseNumber(m[1]);
	if (hour === null || hour > 24) return null;
	let rest = text.slice(m[0].length);
	let minute = 0;
	if (rest.startsWith("半")) {
		minute = 30;
		rest = rest.slice(1);
	} else if (rest.startsWith("一刻")) {
		minute = 15;
		rest = rest.slice(2);
	} else if (rest.startsWith("三刻")) {
		minute = 45;
		rest = rest.slice(2);
	} else {
		const mm = /^(\d{1,2}|[零一二两三四五六七八九十]{1,3})分?/.exec(rest);
		const parsed = mm ? chineseNumber(mm[1]) : null;
		if (mm && parsed !== null) {
			minute = parsed;
			rest = rest.slice(mm[0].length);
		}
	}
	if (minute > 59) return null;
	return {
		hour,
		minute,
		rest
	};
}
/**
* 把开头的时间短语解析出来，并告诉调用方它吃掉了几个字。
*
* @param text - 已归一化的文本（去空白、全角转半角）。
* @param now - 参照时刻。
* @returns 时刻与消耗的字符数；解析不出来返回 null。
*/
function matchTime(text, now) {
	if (!text) return null;
	const relative = matchRelative(text, now);
	if (relative !== null) return {
		ms: relative,
		consumed: text.length
	};
	let rest = text;
	let day = null;
	let shift = 0;
	for (const [word, offset] of EVENING_WORDS) if (rest.startsWith(word)) {
		day = addDays(startOfDay$2(now), offset);
		shift = 12;
		rest = rest.slice(word.length);
		break;
	}
	if (day === null) {
		for (const [word, offset] of DAY_WORDS) if (rest.startsWith(word)) {
			day = addDays(startOfDay$2(now), offset);
			rest = rest.slice(word.length);
			break;
		}
	}
	if (day === null) {
		const week = /^(下下|下|这|本|上)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(rest);
		if (week) {
			const target = WEEK_DAYS[week[2]];
			const monday = mondayOf(now);
			let offset = target - 1;
			if (week[1] === "下") offset += 7;
			else if (week[1] === "下下") offset += 14;
			else if (week[1] === "上") offset -= 7;
			else if (week[1] === void 0 && offset < now.getDay() - 1) offset += 7;
			day = addDays(monday, offset);
			rest = rest.slice(week[0].length);
		}
	}
	if (day === null) {
		const md = /^(\d{1,2})[月\-/](\d{1,2})日?/.exec(rest);
		if (md) {
			const month = Number(md[1]) - 1;
			const date = Number(md[2]);
			if (month >= 0 && month <= 11 && date >= 1 && date <= 31) {
				const thisYear = new Date(now.getFullYear(), month, date);
				day = thisYear.getTime() < startOfDay$2(now).getTime() ? new Date(now.getFullYear() + 1, month, date) : thisYear;
				rest = rest.slice(md[0].length);
			}
		}
	}
	for (const [word, offset] of PERIODS) if (rest.startsWith(word)) {
		shift = offset;
		rest = rest.slice(word.length);
		break;
	}
	const clock = parseClock(rest);
	if (clock) {
		let { hour } = clock;
		const { minute } = clock;
		if (shift === 12 && hour < 12) hour += 12;
		if (hour === 24) hour = 0;
		if (hour > 23) return null;
		const base = day ?? startOfDay$2(now);
		let ms$1 = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
		if (day === null && ms$1 <= now.getTime()) ms$1 = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hour, minute, 0, 0).getTime();
		return {
			ms: ms$1,
			consumed: text.length - clock.rest.length
		};
	}
	if (day === null) return null;
	const ms = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DEFAULT_DUE_HOUR, 0, 0, 0).getTime();
	return {
		ms,
		consumed: text.length - rest.length
	};
}
/** 一句话里找时间短语时最多扫多少字：`下下周一上午十点半` 也就十来字。 */
const PHRASE_SCAN_MAX = 16;
/** 粗筛：先看有没有像时间的字，再逐个跑完整语法，省得每个子串都解析一遍。 */
const TIME_HINT = /[0-9零一二两三四五六七八九十百半今明后大点时秒分天日周月年下这本上]|星期|礼拜|上午|下午|晚上|早上|中午|傍晚|凌晨|夜/u;
/** 句首常见的口头语，剥掉它们剩下才是「要做什么」。 */
const LEADING_FILLERS = /^(?:记得|提醒我一下|提醒我|提醒一下|提醒下|到时候|到点|帮我记一下|帮我|麻烦你|麻烦|请)/u;
/** 句尾常见的口头语。 */
const TRAILING_FILLERS = /(?:的时候|时|别忘了|记得|提醒我)$/u;
/** 把归一化后的字符数换算回原始字符串里的下标终点。 */
function sourceEnd(source, normalizedCount) {
	let count = 0;
	for (let index = 0; index < source.length; index += 1) {
		if (/\s/.test(source[index])) continue;
		count += 1;
		if (count >= normalizedCount) return index + 1;
	}
	return source.length;
}
/** 剥掉句首句尾的口头语与标点。 */
function trimFillers(raw) {
	let text = raw.replace(/^[\s，,。.、；;：:！!？?]+/u, "").replace(/[\s，,。.、；;：:！!？?]+$/u, "");
	for (let round = 0; round < 3; round += 1) {
		const next = text.replace(LEADING_FILLERS, "").replace(TRAILING_FILLERS, "").trim();
		if (next === text) break;
		text = next;
	}
	return text;
}
function parseNaturalTimeInSentence(input, now = new Date()) {
	const text = input.trim();
	if (!text) return null;
	const whole = normalize(text);
	const wholeMatch = matchTime(whole, now);
	if (wholeMatch !== null && wholeMatch.consumed === whole.length) return {
		dueAt: wholeMatch.ms,
		text: ""
	};
	let best = null;
	for (let start = 0; start < text.length; start += 1) {
		if (!TIME_HINT.test(text[start])) continue;
		const maxSpan = Math.min(PHRASE_SCAN_MAX, text.length - start);
		for (let span = maxSpan; span >= 2; span -= 1) {
			const chunk = text.slice(start, start + span);
			const normalized = normalize(chunk);
			if (!normalized) continue;
			const matched = matchTime(normalized, now);
			if (matched === null || matched.consumed !== normalized.length) continue;
			const end = start + sourceEnd(chunk, matched.consumed);
			if (best === null || end - start > best.end - best.start) best = {
				dueAt: matched.ms,
				start,
				end
			};
			break;
		}
	}
	if (best === null) return null;
	return {
		dueAt: best.dueAt,
		text: trimFillers(text.slice(0, best.start) + " " + text.slice(best.end))
	};
}

//#endregion
//#region src/shared/todo/format.ts
const MINUTE_MS = 60 * 1e3;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS$1 = 24 * HOUR_MS;
/** 星期名，索引与 Date.getDay() 对齐。 */
const WEEKDAYS = [
	"周日",
	"周一",
	"周二",
	"周三",
	"周四",
	"周五",
	"周六"
];
/** 两位补零。 */
function pad2(value) {
	return String(value).padStart(2, "0");
}
/** 当天零点的时间戳：跨日比较用它，避开夏令时造成的 23/25 小时日。 */
function startOfDay$1(date) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
/** 两个时刻相差几个自然日（按本地日历，向前为负）。 */
function dayDiff(target, base) {
	return Math.round((startOfDay$1(target) - startOfDay$1(base)) / DAY_MS$1);
}
function spanText(ms) {
	const minutes = Math.max(1, Math.round(Math.abs(ms) / MINUTE_MS));
	if (minutes < 60) return `${minutes}分钟`;
	const hours = Math.max(1, Math.round(minutes / 60));
	if (hours < 24) return `${hours}小时`;
	return `${Math.max(1, Math.round(hours / 24))}天`;
}
function dueLabel(dueAt, now) {
	if (dueAt === null) return "无期限";
	const due = new Date(dueAt);
	const clock = `${pad2(due.getHours())}:${pad2(due.getMinutes())}`;
	const days = dayDiff(due, new Date(now));
	if (days === 0) return `今天 ${clock}`;
	if (days === 1) return `明天 ${clock}`;
	if (days === 2) return `后天 ${clock}`;
	if (days > 2 && days < 7) return `${WEEKDAYS[due.getDay()]} ${clock}`;
	return `${due.getMonth() + 1}月${due.getDate()}日 ${clock}`;
}
function remainingLabel(dueAt, now) {
	if (dueAt === null) return "";
	if (dueAt <= now) return `已逾期${spanText(now - dueAt)}`;
	return `还剩${spanText(dueAt - now)}`;
}
function todoUrgency(dueAt, now) {
	if (dueAt === null) return "undated";
	const remaining = dueAt - now;
	if (remaining <= 0) return "overdue";
	if (remaining <= 6 * HOUR_MS) return "soon";
	if (remaining <= DAY_MS$1) return "today";
	return "later";
}
function metaLabel(todo, now) {
	if (todo.done) return todo.dueAt === null ? "已完成" : `已完成 · ${dueLabel(todo.dueAt, now)}`;
	if (todo.dueAt === null) return "无期限";
	const relative = remainingLabel(todo.dueAt, now);
	if (todo.dueAt <= now) return relative;
	return `${dueLabel(todo.dueAt, now)} · ${relative}`;
}

//#endregion
//#region src/shared/todo/render.ts
/** 删除按钮的二次确认窗口（ms）：超时自动复原，避免「确认」态一直挂着。 */
const DELETE_ARM_MS = 2500;
/** 空态文案：加载中会临时替换它，重渲染时再写回来。 */
const EMPTY_TEXT = "还没有待办。记一件要做的事，到点我会提醒你～";
const TODO_HINT_TEXT = "一句话说完就行：「五分钟后提醒我拿快递」。离到期越近，我会提醒得越勤快～";
/** 清单最多露出几行，其余靠滚动。 */
const LIST_ROWS = 2;
/** 造一个带 class 的元素，避免每处都写 createElement + className。 */
function element(tag, className, text) {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== void 0) node.textContent = text;
	return node;
}
/** 造一个可折叠区：高度靠 grid-template-rows 在 0fr 与 1fr 之间过渡，内容高度是 auto 也能动画。 */
function fold(className, children) {
	const outer = element("div", "dsh-pet-todo-fold " + className);
	const clip = element("div", "dsh-pet-todo-foldClip");
	clip.append(...children);
	outer.appendChild(clip);
	return outer;
}
function createTodoPanelParts() {
	const root = element("div", "dsh-pet-todo");
	root.setAttribute("role", "dialog");
	root.setAttribute("aria-label", "待办事项");
	const head = element("div", "dsh-pet-todo-head");
	const title = element("span", "dsh-pet-todo-title", "待办事项");
	const count = element("span", "dsh-pet-todo-count", "0 项未完成");
	count.setAttribute("aria-live", "polite");
	const closeButton = element("button", "dsh-pet-todo-close", "✕");
	closeButton.type = "button";
	closeButton.setAttribute("aria-label", "关闭待办面板");
	head.append(title, count, closeButton);
	const form = element("form", "dsh-pet-todo-form");
	const input = element("input", "dsh-pet-todo-input");
	input.type = "text";
	input.maxLength = 200;
	input.placeholder = "五分钟后提醒我拿快递…（回车记下）";
	input.autocomplete = "off";
	input.setAttribute("aria-label", "待办内容，可以一句话写清时间和事");
	form.append(input);
	const error = element("div", "dsh-pet-todo-err");
	error.hidden = true;
	const empty = element("div", "dsh-pet-todo-empty", EMPTY_TEXT);
	empty.hidden = true;
	const list = element("ul", "dsh-pet-todo-list");
	const hint = element("div", "dsh-pet-todo-hint", TODO_HINT_TEXT);
	const lower = element("div", "dsh-pet-todo-lower");
	lower.append(fold("is-list", [
		error,
		empty,
		list,
		hint
	]));
	root.append(head, form, lower);
	return {
		root,
		form,
		input,
		list,
		empty,
		count,
		closeButton,
		error,
		hint
	};
}
/**
* 把清单压到「两行」的高度，多出来的部分靠清单自己滚动。
*
* 行高随正文折行变化，写不成 CSS 常量，所以量一次首行再乘二；量不到（未挂载）就不设上限，
* 免得把清单压成 0 高。
*
* @param list - 清单容器。
*/
function capListHeight(list) {
	const first = list.firstElementChild;
	if (first === null) {
		list.style.maxHeight = "";
		return;
	}
	const rowHeight = first.getBoundingClientRect().height;
	if (rowHeight <= 0) return;
	const pad$1 = parseFloat(getComputedStyle(list).paddingTop) || 0;
	list.style.maxHeight = rowHeight * LIST_ROWS + pad$1 * 2 + "px";
}
function renderTodoList(parts, todos, handlers, now) {
	parts.list.textContent = "";
	const pending = todos.filter((todo) => !todo.done).length;
	parts.count.textContent = `${pending} 项未完成`;
	parts.empty.textContent = EMPTY_TEXT;
	parts.empty.hidden = todos.length > 0;
	for (const todo of todos) parts.list.appendChild(renderItem(todo, handlers, now));
	capListHeight(parts.list);
}
/** 渲染一条；未完成项带紧迫度，已完成项划线。 */
function renderItem(todo, handlers, now) {
	const item = element("li", "dsh-pet-todo-item" + (todo.done ? " is-done" : ""));
	if (!todo.done) item.dataset.urgency = todoUrgency(todo.dueAt, now);
	const check = element("input", "dsh-pet-todo-check");
	check.type = "checkbox";
	check.checked = todo.done;
	check.setAttribute("aria-label", (todo.done ? "标记未完成：" : "标记完成：") + todo.text);
	check.addEventListener("change", () => handlers.onToggle(todo, check.checked));
	const main = element("div", "dsh-pet-todo-main");
	const text = element("div", "dsh-pet-todo-text", todo.text);
	const meta = element("div", "dsh-pet-todo-meta", metaLabel(todo, now));
	main.append(text, meta);
	const remove = element("button", "dsh-pet-todo-del", "✕");
	remove.type = "button";
	remove.setAttribute("aria-label", "删除：" + todo.text);
	remove.addEventListener("click", () => {
		if (remove.dataset.armed !== "1") {
			remove.dataset.armed = "1";
			remove.classList.add("is-armed");
			remove.textContent = "确认";
			window.setTimeout(() => {
				if (!remove.isConnected) return;
				delete remove.dataset.armed;
				remove.classList.remove("is-armed");
				remove.textContent = "✕";
			}, DELETE_ARM_MS);
			return;
		}
		handlers.onDelete(todo);
	});
	item.append(check, main, remove);
	return item;
}
function setTodoError(parts, message) {
	parts.error.hidden = message === null;
	parts.error.textContent = message ?? "";
}
function setTodoBusy(parts, busy) {
	parts.input.disabled = busy;
}

//#endregion
//#region src/shared/todo/styles.ts
const TODO_FONT_SCALE = .618;
const TODO_CSS = [
	".dsh-pet-bubble.dsh-pet-todo-bubble,.pet-bubble.dsh-pet-todo-bubble{padding:0;",
	"width:max(220px,calc(var(--f)*14.65));max-width:calc(100vw - 16px);pointer-events:auto;cursor:default}",
	".dsh-pet-todo{--t:calc(var(--f)*" + TODO_FONT_SCALE + ");display:flex;flex-direction:column;",
	"box-sizing:border-box;border-radius:inherit;overflow:hidden;color:#2b2b2b;font-size:var(--t);",
	"line-height:1.5;user-select:none;",
	"font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
	"}",
	".dsh-pet-todo *{box-sizing:border-box}",
	".dsh-pet-todo-head{display:flex;align-items:center;gap:.615em;padding:.769em .923em .615em}",
	".dsh-pet-todo-title{flex:1;font-size:1.077em;font-weight:600}",
	".dsh-pet-todo-count{color:rgba(43,43,43,.55);font-size:.923em}",
	".dsh-pet-todo-close{border:none;background:transparent;color:rgba(43,43,43,.5);font-family:inherit;",
	"font-size:1em;line-height:1;padding:.308em .385em;border-radius:.462em;cursor:pointer}",
	".dsh-pet-todo-close:hover{background:rgba(0,0,0,.06);color:rgba(43,43,43,.9)}",
	".dsh-pet-todo-form{display:flex;flex-direction:column;gap:.462em;padding:0 .923em .769em;",
	"border-bottom:1px solid rgba(0,0,0,.07)}",
	".dsh-pet-todo-input{width:100%;border:1px solid rgba(0,0,0,.12);border-radius:.615em;",
	"background:rgba(255,255,255,.9);padding:.462em .615em;font-size:1em;line-height:1.4;color:#2b2b2b;",
	"font-family:inherit;outline:none}",
	".dsh-pet-todo-input:focus{border-color:rgba(64,128,255,.55);box-shadow:0 0 0 .154em rgba(64,128,255,.14)}",
	".dsh-pet-todo-input::placeholder{color:rgba(43,43,43,.42)}",
	".dsh-pet-todo-input:disabled{opacity:.55;cursor:default}",
	".dsh-pet-todo-lower{display:flex;flex-direction:column}",
	".dsh-pet-todo-fold{display:grid;grid-template-rows:0fr;visibility:hidden;",
	"transition:grid-template-rows .18s ease,visibility 0s .18s}",
	".dsh-pet-todo-fold>.dsh-pet-todo-foldClip{overflow:hidden;min-height:0}",
	".dsh-pet-todo-fold.is-list{grid-template-rows:1fr;visibility:visible;transition-delay:0s}",
	".dsh-pet-todo-list{list-style:none;margin:0;padding:.462em;overflow-y:auto;overscroll-behavior:contain;",
	"flex:0 1 auto;min-height:0;scrollbar-width:thin}",
	".dsh-pet-todo-item{display:flex;align-items:flex-start;gap:.615em;padding:.538em .462em;border-radius:.615em}",
	".dsh-pet-todo-item:hover{background:rgba(0,0,0,.045)}",
	".dsh-pet-todo-check{margin-top:.231em;width:1.154em;height:1.154em;flex:0 0 auto;cursor:pointer;",
	"accent-color:#4a7dff}",
	".dsh-pet-todo-main{flex:1;min-width:0}",
	".dsh-pet-todo-text{overflow-wrap:anywhere;white-space:pre-wrap}",
	".dsh-pet-todo-meta{margin-top:calc(var(--t)*0.154);font-size:.846em;color:rgba(43,43,43,.5)}",
	".dsh-pet-todo-item[data-urgency=\"overdue\"] .dsh-pet-todo-meta{color:#d94f3d}",
	".dsh-pet-todo-item[data-urgency=\"soon\"] .dsh-pet-todo-meta{color:#c9761b}",
	".dsh-pet-todo-item[data-urgency=\"today\"] .dsh-pet-todo-meta{color:#3f6fd8}",
	".dsh-pet-todo-item.is-done .dsh-pet-todo-text{text-decoration:line-through;color:#2e9e4f}",
	".dsh-pet-todo-del{border:none;background:transparent;color:rgba(43,43,43,.34);font-size:.923em;line-height:1;",
	"padding:calc(var(--t)*0.308) calc(var(--t)*0.385);border-radius:.462em;cursor:pointer;flex:0 0 auto;",
	"min-width:calc(var(--t)*1.692)}",
	".dsh-pet-todo-del:hover{background:rgba(0,0,0,.07);color:rgba(43,43,43,.8)}",
	".dsh-pet-todo-del.is-armed{background:rgba(217,79,61,.12);color:#d94f3d}",
	".dsh-pet-todo-empty{padding:calc(var(--t)*1.538) calc(var(--t)*0.923);text-align:center;",
	"color:rgba(43,43,43,.44);font-size:.923em}",
	".dsh-pet-todo-empty[hidden]{display:none}",
	".dsh-pet-todo-err{flex:0 0 auto;padding:0 calc(var(--t)*0.923) calc(var(--t)*0.615);color:#d94f3d;",
	"font-size:.923em;white-space:pre-wrap;overflow-wrap:anywhere}",
	".dsh-pet-todo-err[hidden]{display:none}",
	".dsh-pet-todo-hint{margin-top:auto;padding:calc(var(--t)*0.462) calc(var(--t)*0.923) calc(var(--t)*0.692);",
	"color:rgba(43,43,43,.4);font-size:.846em;text-align:center}"
].join("");
let todoCssInjected = false;
function injectTodoCss() {
	if (todoCssInjected || typeof document === "undefined") return;
	todoCssInjected = true;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = "dsh-pet/todo";
	tag.textContent = TODO_CSS;
	document.head.appendChild(tag);
}

//#endregion
//#region src/shared/todo/panel.ts
function createTodoPanel(options = {}) {
	injectTodoCss();
	const parts = createTodoPanelParts();
	const baseUrl = options.baseUrl ?? TODOS_PATH;
	let disposed = false;
	let busy = false;
	let todos = [];
	const handlers = {
		onToggle: (todo, done) => void mutate(() => patchTodo(todo.id, { done }, baseUrl)),
		onDelete: (todo) => void mutate(() => removeTodo(todo.id, baseUrl))
	};
	/** 重新拉整张清单：修改一律以宿主返回为准，不在本地猜结果。 */
	async function reload() {
		const result = await loadTodos(baseUrl);
		if (disposed) return;
		if (!result.ok) {
			setTodoError(parts, result.message);
			parts.empty.textContent = "清单加载失败，关掉面板再开一次试试";
			parts.empty.hidden = false;
			return;
		}
		todos = result.value;
		setTodoError(parts, null);
		renderTodoList(parts, todos, handlers, Date.now());
	}
	/** 串行执行一次修改：请求在途时禁止再次提交，成功后统一重拉。 */
	async function mutate(task) {
		if (disposed || busy) return;
		busy = true;
		setTodoBusy(parts, true);
		setTodoError(parts, null);
		const result = await task();
		busy = false;
		if (disposed) return;
		setTodoBusy(parts, false);
		if (!result.ok) {
			setTodoError(parts, result.message);
			return;
		}
		await reload();
	}
	/** 提交新增：一句话里同时读时间和正文；空正文直接回到输入框。 */
	const submitAdd = () => {
		const raw = parts.input.value.trim();
		if (raw === "") {
			parts.input.focus();
			return;
		}
		const parsed = parseNaturalTimeInSentence(raw);
		const dueAt = parsed === null ? null : parsed.dueAt;
		const text = parsed !== null && parsed.text !== "" ? parsed.text : raw;
		if (dueAt !== null && dueAt < Date.now()) {
			setTodoError(parts, "这个时间已经过去了，换一个吧");
			return;
		}
		setTodoError(parts, null);
		parts.hint.textContent = dueAt === null ? "没听出时间，先记成不提醒的待办；写成「五分钟后提醒我拿快递」我就能到点喊你～" : TODO_HINT_TEXT;
		mutate(async () => {
			const result = await addTodo(text, dueAt, baseUrl);
			if (result.ok) parts.input.value = "";
			return result;
		});
	};
	parts.form.addEventListener("submit", (event) => {
		event.preventDefault();
		submitAdd();
	});
	const onDocMouseDown = (event) => {
		if (disposed) return;
		const target = event.target;
		if (target !== null && parts.root.contains(target)) return;
		if (options.keepOpenOn?.(event.target) === true) return;
		options.onClose?.();
	};
	document.addEventListener("mousedown", onDocMouseDown, true);
	parts.closeButton.addEventListener("click", () => options.onClose?.());
	parts.empty.textContent = "加载中…";
	parts.empty.hidden = false;
	reload();
	return {
		el: parts.root,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			document.removeEventListener("mousedown", onDocMouseDown, true);
			parts.root.remove();
		}
	};
}

//#endregion
//#region src/client/todo-bubble.ts
function makeTodoBubble(rt) {
	const { h, useRef, useEffect } = rt;
	return function TodoBubble({ on, onClose }) {
		const hostRef = useRef(null);
		const closeRef = useRef(onClose);
		closeRef.current = onClose;
		useEffect(() => {
			const host = hostRef.current;
			if (host === null) return;
			const panel = createTodoPanel({
				onClose: () => closeRef.current(),
				keepOpenOn: (target) => target instanceof Element && target.closest(".dsh-pet-hit") !== null
			});
			host.appendChild(panel.el);
			return () => panel.dispose();
		}, []);
		return h("div", {
			ref: hostRef,
			className: "dsh-pet-bubble dsh-pet-todo-bubble" + (on ? " is-on" : "")
		});
	};
}

//#endregion
//#region src/client/request-bubble.ts
/** 把毫秒时间戳格式化成 HH:MM（本地时区）。 */
function clockText(ms) {
	const d = new Date(ms);
	return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
/** 「发送」按钮文案：多题时带上进度，一眼看出还差几题。 */
function gapsLabel(questions, picked, custom) {
	const total = questions.length;
	if (total <= 1) return "发送";
	let done = 0;
	for (const q of questions) {
		const selected = picked[q.id] ?? [];
		if (selected.length > 0 || (custom[q.id] ?? "").trim() !== "") done += 1;
	}
	return done >= total ? "发送" : "发送（" + done + "/" + total + "）";
}
/** 把宿主拒绝的原因翻成用户看得懂的一句话：沉默最像坏了。 */
function answerErrorText(message) {
	if (message === "request expired or unknown") return "这条请求已经过期或已在 DSH 里处理过了。";
	if (message === void 0 || message === "") return "没提交成功，再试一次。";
	return "没提交成功：" + message;
}
/** 发一条回答，把宿主的 ok/message 交回来；网络失败也给出可读原因。 */
function postAnswer(body) {
	return postActionJson(ROUTE_PATH + "/request/answer", body).then((json) => ({
		ok: json?.ok === true,
		...typeof json?.message === "string" ? { message: json.message } : {}
	})).catch(() => ({
		ok: false,
		message: ""
	}));
}
function makeApprovalBubble(rt) {
	const { h, useState } = rt;
	injectBubbleCss();
	return function ApprovalBubble({ request, on }) {
		const preview = request.preview === true;
		const [error, setError] = useState("");
		const answer = (outcome) => {
			const body = preview ? {
				id: request.id,
				kind: "approval",
				cancel: true
			} : {
				id: request.id,
				kind: "approval",
				outcome
			};
			setError("");
			postAnswer(body).then((res) => {
				if (!res.ok) setError(answerErrorText(res.message));
			});
		};
		return h("div", {
			className: "dsh-pet-bubble dsh-pet-request" + (on ? " is-on is-clickable" : ""),
			onClick: (e) => e.stopPropagation(),
			children: [
				h("div", {
					key: "head",
					className: "dsh-pet-request__head",
					children: [h("span", {
						key: "kind",
						className: "dsh-pet-request__badge",
						children: "需要确认"
					}), h("span", {
						key: "tool",
						className: "dsh-pet-request__tool",
						children: request.toolName || "工具调用"
					})]
				}),
				h("div", {
					key: "reason",
					className: "dsh-pet-request__body",
					children: request.reason && request.reason.trim() !== "" ? request.reason : "这一步要跑一个需要授权的操作。"
				}),
				error !== "" ? h("div", {
					key: "err",
					className: "dsh-pet-request__err",
					children: error
				}) : null,
				h("div", {
					key: "actions",
					className: "dsh-pet-request__actions",
					children: [
						h("button", {
							key: "allow",
							type: "button",
							className: "dsh-pet-request__btn is-primary",
							onClick: () => answer("allowed-once"),
							children: "允许一次"
						}),
						h("button", {
							key: "session",
							type: "button",
							className: "dsh-pet-request__btn",
							title: "本会话内同类审批不再询问",
							onClick: () => answer("allow-session"),
							children: "本会话都允许"
						}),
						h("button", {
							key: "reject",
							type: "button",
							className: "dsh-pet-request__btn",
							onClick: () => answer("rejected"),
							children: "拒绝"
						}),
						h("button", {
							key: "ds",
							type: "button",
							className: "dsh-pet-request__btn is-ghost",
							onClick: () => answer("delegate"),
							children: "去 DSH"
						})
					]
				})
			]
		});
	};
}
function makeQuestionBubble(rt) {
	const { h, useState, useEffect } = rt;
	injectBubbleCss();
	return function QuestionBubble({ request, on }) {
		const questions = request.questions ?? [];
		const [picked, setPicked] = useState({});
		const [custom, setCustom] = useState({});
		const [error, setError] = useState("");
		useEffect(() => {
			setPicked({});
			setCustom({});
			setError("");
		}, [request.id]);
		const toggle = (qid, label, multi) => {
			setError("");
			setPicked((prev) => {
				const cur = prev[qid] ?? [];
				if (!multi) return {
					...prev,
					[qid]: [label]
				};
				return {
					...prev,
					[qid]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
				};
			});
		};
		const answers = () => questions.map((q) => {
			const selected = picked[q.id] ?? [];
			const text = (custom[q.id] ?? "").trim();
			return {
				id: q.id,
				selected,
				...text !== "" ? { custom: text } : {}
			};
		});
		const missing = () => {
			const out = [];
			questions.forEach((q, index) => {
				const selected = picked[q.id] ?? [];
				if (selected.length > 0) return;
				if ((custom[q.id] ?? "").trim() !== "") return;
				out.push(index + 1);
			});
			return out;
		};
		const submit = () => {
			const gaps = missing();
			if (gaps.length > 0) {
				setError("还有 " + gaps.length + " 道题没答：第 " + gaps.join("、") + " 题");
				return;
			}
			const body = request.preview === true ? {
				id: request.id,
				kind: "question",
				cancel: true
			} : {
				id: request.id,
				kind: "question",
				answers: answers()
			};
			setError("");
			postAnswer(body).then((res) => {
				if (!res.ok) setError(answerErrorText(res.message));
			});
		};
		return h("div", {
			className: "dsh-pet-bubble dsh-pet-request is-question" + (on ? " is-on is-clickable" : ""),
			onClick: (e) => e.stopPropagation(),
			children: [
				h("div", {
					key: "scroll",
					className: "dsh-pet-request__scroll",
					children: questions.map((q, index) => h("div", {
						key: "q" + q.id,
						className: "dsh-pet-request__question",
						children: [
							h("div", {
								key: "title",
								className: "dsh-pet-request__title",
								children: (q.header && q.header.trim() !== "" ? q.header + "：" : "") + (index + 1) + ". " + q.question
							}),
							q.detail && q.detail.trim() !== "" ? h("div", {
								key: "detail",
								className: "dsh-pet-request__detail",
								children: q.detail
							}) : null,
							h("div", {
								key: "opts",
								className: "dsh-pet-request__options",
								children: [...(q.options ?? []).map((opt) => h("button", {
									key: "o" + opt.label,
									type: "button",
									className: "dsh-pet-request__opt" + ((picked[q.id] ?? []).includes(opt.label) ? " is-picked" : ""),
									onClick: () => toggle(q.id, opt.label, q.multiSelect === true),
									children: opt.label
								})), h("input", {
									key: "custom",
									type: "text",
									className: "dsh-pet-request__input",
									placeholder: (q.options ?? []).length > 0 ? "其他（选填）" : "输入回答…",
									value: custom[q.id] ?? "",
									onChange: (e) => {
										setError("");
										setCustom((prev) => ({
											...prev,
											[q.id]: e.target.value
										}));
									}
								})]
							})
						]
					}))
				}),
				error !== "" ? h("div", {
					key: "err",
					className: "dsh-pet-request__err",
					children: error
				}) : null,
				h("div", {
					key: "send",
					className: "dsh-pet-request__actions",
					children: [h("button", {
						key: "go",
						type: "button",
						className: "dsh-pet-request__btn is-primary",
						onClick: submit,
						children: request.preview === true ? "知道了" : gapsLabel(questions, picked, custom)
					})]
				})
			]
		});
	};
}
function makeReminderBubble(rt) {
	const { h } = rt;
	injectBubbleCss();
	return function ReminderBubble({ reminder, on }) {
		const planned = typeof reminder.scheduledAt === "string" ? Date.parse(reminder.scheduledAt) : NaN;
		const lines = reminder.lines ?? [];
		const hint = reminder.hint ?? "";
		const text = reminder.prompt ?? "";
		const announce = reminder.kind === "announce";
		const chat = reminder.kind === "chat";
		const todo = reminder.kind === "todo";
		const badgeText = announce ? "宠物消息" : todo ? "待办提醒" : chat ? "聊天提醒" : "定时任务";
		const actions = reminder.actions ?? [];
		const sessionId = reminder.sessionId;
		const [sending, setSending] = rt.useState("");
		const [draft, setDraft] = rt.useState("");
		const close = () => {
			postAction(ROUTE_PATH + "/reminder/close", { id: reminder.id }).catch(() => void 0);
		};
		const snooze = () => {
			postAction(ROUTE_PATH + "/reminder/snooze", {
				id: reminder.id,
				minutes: 15
			}).catch(() => void 0);
		};
		const muteHour = () => {
			postAction(ROUTE_PATH + "/mute", { minutes: 60 }).catch(() => void 0);
			close();
		};
		const sendAction = (label, body, keepDraft = false) => {
			if (sessionId === void 0 || sending !== "") return;
			setSending(label);
			if (!keepDraft) setDraft("");
			postAction(ROUTE_PATH + "/reply", {
				sessionId,
				text: body,
				id: reminder.id
			}).then(() => setSending("")).catch(() => setSending(""));
		};
		const sendDraft = () => {
			const body = draft.trim();
			if (body === "") return;
			sendAction("draft", body);
		};
		const focusSession = reminder.sessionId;
		const goSession = () => {
			if (focusSession === void 0) return;
			postAction(ROUTE_PATH + "/focus-session", { sessionId: focusSession }).catch(() => void 0);
			close();
		};
		return h("div", {
			className: "dsh-pet-bubble dsh-pet-reminder" + (on ? " is-on is-clickable" : ""),
			onClick: (e) => e.stopPropagation(),
			children: [
				h("div", {
					key: "head",
					className: "dsh-pet-request__head",
					children: [h("span", {
						key: "kind",
						className: "dsh-pet-request__badge is-reminder" + (announce ? " is-announce" : todo ? " is-todo" : chat ? " is-chat" : ""),
						children: badgeText
					}), Number.isFinite(planned) ? h("span", {
						key: "time",
						className: "dsh-pet-request__tool",
						children: clockText(planned)
					}) : null]
				}),
				h("div", {
					key: "title",
					className: "dsh-pet-reminder__title",
					children: reminder.title
				}),
				lines.length > 0 ? h("div", {
					key: "lines",
					className: "dsh-pet-reminder__lines",
					children: lines.map((line, index) => h("div", {
						key: "l" + index,
						className: "dsh-pet-reminder__line",
						children: line
					}))
				}) : null,
				text !== "" && text !== reminder.title ? h("div", {
					key: "prompt",
					className: "dsh-pet-request__body",
					children: text
				}) : null,
				hint !== "" ? h("div", {
					key: "hint",
					className: "dsh-pet-reminder__hint",
					children: hint
				}) : null,
				actions.length > 0 ? h("div", {
					key: "quick",
					className: "dsh-pet-reminder__quick",
					children: actions.map((action, index) => h("button", {
						key: "q" + index,
						type: "button",
						className: "dsh-pet-reminder__chip" + (sending === action.label ? " is-busy" : ""),
						disabled: sending !== "",
						onClick: () => sendAction(action.label, action.text),
						children: sending === action.label ? "发送中…" : action.label
					}))
				}) : null,
				sessionId === void 0 ? null : h("div", {
					key: "draft",
					className: "dsh-pet-reminder__reply",
					children: [h("input", {
						key: "in",
						className: "dsh-pet-request__input",
						type: "text",
						placeholder: "接着说一句，我去干…",
						value: draft,
						maxLength: 400,
						onInput: (e) => setDraft(e.currentTarget.value),
						onKeyDown: (e) => {
							if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
							e.preventDefault();
							sendDraft();
						}
					}), h("button", {
						key: "send",
						type: "button",
						className: "dsh-pet-request__btn",
						disabled: sending !== "" || draft.trim() === "",
						onClick: sendDraft,
						children: sending === "draft" ? "发送中…" : "发送"
					})]
				}),
				h("div", {
					key: "actions",
					className: "dsh-pet-request__actions",
					children: [
						h("button", {
							key: "ok",
							type: "button",
							className: "dsh-pet-request__btn is-primary",
							onClick: close,
							children: "知道了"
						}),
						focusSession === void 0 ? null : h("button", {
							key: "focus",
							type: "button",
							className: "dsh-pet-request__btn",
							onClick: goSession,
							children: "去会话回复"
						}),
						h("button", {
							key: "snooze",
							type: "button",
							className: "dsh-pet-request__btn is-ghost",
							onClick: snooze,
							title: "15 分钟后再提醒我",
							children: "等会儿"
						}),
						h("button", {
							key: "mute",
							type: "button",
							className: "dsh-pet-request__btn is-ghost",
							onClick: muteHour,
							title: "一小时内不再弹提醒",
							children: "静音 1 小时"
						})
					]
				})
			]
		});
	};
}

//#endregion
//#region src/client/history-bubble.ts
/** 把毫秒时间戳格式化成「今天 HH:MM」或「M/D HH:MM」。 */
function stampText(ms) {
	const d = new Date(ms);
	const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
	const now = new Date();
	const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
	return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
/** 一条摘要：优先用第一条明细，其次正文，再次省略号。 */
function summaryOf(entry) {
	const line = entry.lines?.[0];
	if (line !== void 0 && line !== "") return line;
	if (entry.prompt !== void 0 && entry.prompt !== "") return entry.prompt;
	return "";
}
function makeHistoryBubble(rt) {
	const { h } = rt;
	injectBubbleCss();
	return function HistoryBubble({ snapshot, on, onClose }) {
		const entries = snapshot?.entries ?? [];
		const clear = () => {
			postAction(ROUTE_PATH + "/history", { clear: true }).catch(() => void 0);
		};
		const jump = (entry) => {
			if (entry.sessionId === void 0) return;
			postAction(ROUTE_PATH + "/focus-session", { sessionId: entry.sessionId }).catch(() => void 0);
			onClose();
		};
		return h("div", {
			className: "dsh-pet-bubble dsh-pet-request dsh-pet-history" + (on ? " is-on is-clickable" : ""),
			onClick: (e) => e.stopPropagation(),
			children: [
				h("div", {
					key: "head",
					className: "dsh-pet-request__actions dsh-pet-history__head",
					children: [h("span", {
						key: "badge",
						className: "dsh-pet-request__badge is-history",
						children: entries.length > 0 ? `记录 · ${entries.length}` : "记录"
					}), h("button", {
						key: "close",
						type: "button",
						className: "dsh-pet-request__btn is-ghost",
						title: "收起",
						children: "收起",
						onClick: onClose
					})]
				}),
				entries.length === 0 ? h("div", {
					key: "empty",
					className: "dsh-pet-history__empty",
					children: "还没有记录。到点的提醒和推送过一会儿就会出现在这里。"
				}) : h("div", {
					key: "list",
					className: "dsh-pet-history__list",
					children: entries.map((entry, i) => {
						const summary = summaryOf(entry);
						const clickable = entry.sessionId !== void 0;
						return h("div", {
							key: entry.id + ":" + String(i),
							className: "dsh-pet-history__row" + (clickable ? " is-clickable" : ""),
							title: clickable ? "点一下回到这个会话" : void 0,
							onClick: clickable ? () => jump(entry) : void 0,
							children: [h("span", {
								key: "time",
								className: "dsh-pet-history__time",
								children: stampText(entry.ts)
							}), h("div", {
								key: "body",
								className: "dsh-pet-history__body",
								children: [h("span", {
									key: "title",
									className: "dsh-pet-history__title",
									children: entry.title
								}), summary === "" ? null : h("span", {
									key: "sum",
									className: "dsh-pet-history__sum",
									children: summary
								})].filter((node) => node !== null)
							})]
						});
					})
				}),
				h("div", {
					key: "foot",
					className: "dsh-pet-request__actions dsh-pet-history__foot",
					children: [h("button", {
						key: "clear",
						type: "button",
						className: "dsh-pet-request__btn is-ghost",
						children: "清空",
						onClick: clear
					}), h("span", {
						key: "note",
						className: "dsh-pet-history__note",
						children: "只记最近 20 条，重启 DSH 就清空。"
					})]
				})
			]
		});
	};
}

//#endregion
//#region src/shared/avatar.ts
const LOGO_URL = ROUTE_PATH + "/logo";
function avatarUrl(assetRoot, version) {
	const root = assetRoot.trim();
	const query = root === "" ? "" : "root=" + encodeURIComponent(root) + "&";
	return ROUTE_PATH + "/logo?" + query + "v=" + version;
}

//#endregion
//#region src/shared/notify.ts
const NOTIFY_ICONS$1 = {
	done: "notify-done",
	error: "notify-error",
	truncated: "notify-truncated",
	approval: "notify-approval",
	question: "notify-question",
	test: "notify-test"
};
const MAX_BODY = 80;
/** 会话名在标题里的截断上限（字符）：名字只是认人用，太长会把事件类型挤出标题那一行。 */
const MAX_SESSION_NAME = 30;
function truncate(text) {
	return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "…" : text;
}
/** 会话名 → 能放进标题的名字：去掉首尾空白并截断；没有名字时返回 undefined。 */
function sessionNameOf(sessionTitle) {
	const name = sessionTitle?.trim();
	if (!name) return void 0;
	return name.length > MAX_SESSION_NAME ? name.slice(0, MAX_SESSION_NAME) + "…" : name;
}
/** 「会话名 · 事件」形式的标题；没有会话名时只留事件类型。 */
function composeTitle(sessionTitle, label) {
	const name = sessionNameOf(sessionTitle);
	return name ? name + " · " + label : label;
}
function frameToToast(frame, sessionTitle) {
	switch (frame.type) {
		case "session/event": {
			const ev = frame.event ?? {};
			if (ev.type !== "turn/end") return null;
			const kind = ev.data?.reason?.kind;
			if (kind === "completed") {
				const text = typeof ev.data?.text === "string" ? ev.data.text.trim() : "";
				return {
					title: sessionNameOf(sessionTitle) ?? "对话完成",
					body: text ? truncate(text) : "",
					icon: NOTIFY_ICONS$1.done
				};
			}
			if (kind === "error") return {
				title: composeTitle(sessionTitle, "生成失败"),
				body: ev.data?.reason?.error?.message ?? "",
				icon: NOTIFY_ICONS$1.error
			};
			if (kind === "max-tokens") return {
				title: composeTitle(sessionTitle, "输出被截断"),
				body: "已达到输出 token 上限",
				icon: NOTIFY_ICONS$1.truncated
			};
			return null;
		}
		case "approval/requested": {
			const toolName = typeof frame.toolName === "string" ? frame.toolName : "";
			const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "";
			return {
				title: composeTitle(sessionTitle, "正在申请权限"),
				body: (toolName ? "工具「" + toolName + "」" : "") + (reason ? "：" + reason : ""),
				icon: NOTIFY_ICONS$1.approval
			};
		}
		case "question/requested": {
			const q = Array.isArray(frame.questions) && frame.questions[0]?.question || "";
			return {
				title: composeTitle(sessionTitle, "模型在等你回答"),
				body: q,
				icon: NOTIFY_ICONS$1.question
			};
		}
		case "host/agent-error": return {
			title: "生成失败",
			body: typeof frame.message === "string" ? frame.message : "",
			icon: NOTIFY_ICONS$1.error
		};
		default: return null;
	}
}

//#endregion
//#region src/client/notify.ts
let pageVisible = typeof document !== "undefined" && !document.hidden;
let pageFocused = typeof document !== "undefined" && document.hasFocus();
function refreshVisible() {
	pageVisible = !document.hidden;
}
function refreshFocused() {
	pageFocused = document.hasFocus();
}
/** 注册聚焦与可见性监听，返回解绑函数。 */
function initFocusTracking() {
	if (typeof document === "undefined") return () => {};
	document.addEventListener("visibilitychange", refreshVisible);
	window.addEventListener("focus", refreshFocused);
	window.addEventListener("blur", refreshFocused);
	return () => {
		document.removeEventListener("visibilitychange", refreshVisible);
		window.removeEventListener("focus", refreshFocused);
		window.removeEventListener("blur", refreshFocused);
	};
}
/** 用户是否在看本页（页面可见且持有焦点）；是则跳过通知。 */
function isPageActive() {
	return pageVisible && pageFocused;
}
/** 图标 URL；pic 路由由宿主提供（`assets/pic` → `/dsh-pet-7340/pic/<file>`）。 */
const PIC = (name) => `${ROUTE_PATH}/pic/${name}.png`;
const NOTIFY_ICONS = {
	done: PIC(NOTIFY_ICONS$1.done),
	error: PIC(NOTIFY_ICONS$1.error),
	truncated: PIC(NOTIFY_ICONS$1.truncated),
	approval: PIC(NOTIFY_ICONS$1.approval),
	question: PIC(NOTIFY_ICONS$1.question),
	test: PIC(NOTIFY_ICONS$1.test)
};
/** 当前生效的总开关；运行中可被 reloadNotifications 更新，设置页保存后即时生效。 */
let notifyEnabled = true;
/** 当前生效的会话跳转器（app.ts 注入；旧版 DSH 没有 uiWorkspace 时为 undefined）。 */
let sessionNavigator;
function sessionTitleFrom(navigator$1, sessionId) {
	if (sessionId === void 0) return void 0;
	try {
		return navigator$1?.sessionTitle?.(sessionId);
	} catch {
		return void 0;
	}
}
function jumpToSession(sessionId) {
	if (sessionId !== void 0) try {
		sessionNavigator?.openSession(sessionId);
	} catch {}
	window.focus();
	if (!/electron/i.test(navigator.userAgent)) return;
	const frame = document.createElement("iframe");
	frame.style.display = "none";
	frame.src = "dsh://open";
	document.body.append(frame);
	setTimeout(() => frame.remove(), 1e3);
}
function wireNotificationClick(n, sessionId) {
	n.onclick = () => {
		n.close();
		jumpToSession(sessionId);
	};
}
/** 发一条系统通知；总开关关闭、环境不支持、未授权或本页正在看时静默跳过。
* 日志只在门之后记录：被拦下的触发不产生「弹窗」日志。 */
function toast(title, body, icon, sessionId) {
	if (!notifyEnabled) return;
	if (isPageActive()) return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	console.log("[dsh-pet] 【弹窗】" + title + (body ? "：" + body : ""));
	try {
		const opts = {};
		if (body) opts.body = truncate(body);
		if (icon) opts.icon = icon;
		const n = new Notification(title, opts);
		wireNotificationClick(n, sessionId);
	} catch {}
}
/**
* 帧 → toast 并发出；未知帧静默跳过，帧里的 sessionId 一并透传给点击行为。
* 标题优先用会话名：同一个宿主上可以并行跑多条会话，通知里必须能认出是哪一条回来了。
*/
function toastFrame(frame) {
	const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : void 0;
	const t = frameToToast(frame, sessionTitleFrom(sessionNavigator, sessionId));
	if (!t) return;
	toast(t.title, t.body, PIC(t.icon), sessionId);
}
async function requestNotificationPermission() {
	if (typeof Notification === "undefined") return {
		ok: false,
		reason: "unsupported"
	};
	if (Notification.permission === "granted") return { ok: true };
	if (Notification.permission === "denied") return {
		ok: false,
		reason: "denied"
	};
	try {
		const p = await Notification.requestPermission();
		if (p === "granted") return { ok: true };
		if (p === "denied") return {
			ok: false,
			reason: "rejected"
		};
		return {
			ok: false,
			reason: "error",
			message: "权限未授予（" + p + "）"
		};
	} catch (e) {
		return {
			ok: false,
			reason: "error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
/** 读系统通知总开关（成品配置 main 条目）；拉取或解析失败时按开启处理，不阻塞。 */
async function readNotificationsEnabled() {
	try {
		const r = await fetch(ROUTE_PATH + "/config");
		if (!r.ok) return true;
		const d = await r.json().catch(() => null);
		return typeof d?.main?.notificationsEnabled === "boolean" ? d.main.notificationsEnabled : true;
	} catch {
		return true;
	}
}
async function reloadNotifications() {
	notifyEnabled = await readNotificationsEnabled();
}
function notifyFromFrame(frame) {
	toastFrame(frame);
}
function initNotify(navigator$1) {
	sessionNavigator = navigator$1;
	readNotificationsEnabled().then((enabled) => {
		notifyEnabled = enabled;
		if (typeof Notification !== "undefined" && enabled && Notification.permission === "default") requestNotificationPermission();
	});
	return initFocusTracking();
}

//#endregion
//#region src/client/settings/css.ts
/**
* 设置页样式表与注入入口：三族类名——`dsh-pet-mp__*`（AI 模型选择器）、`dsh-pet-sel__*`（通用单选下拉）与 `dsh-pet-cfg__*`（配置卡片）。
* 只放伪类、悬浮、过渡与容器查询这类内联 style 表达不了的东西，其余排版走组件内联 style。
* 颜色与圆角取 `--dsw-alias-*` / `--dsw-radius-*` token；填充按钮上的白字与阴影回退值是刻意例外。
* 注入按 `data-plugin-css` 去重，同一页面重复渲染设置页不会长第二份样式。
* @module dsh-pet/src/client/settings/css
*/
/** 设置页样式表；按类名族分段拼成单段文本，行内注释标出反直觉的那几条规则。 */
const SETTINGS_CSS = [
	".dsh-pet-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}",
	".dsh-pet-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:340px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}",
	".dsh-pet-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}",
	".dsh-pet-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-pet-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
	".dsh-pet-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dsh-pet-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}",
	".dsh-pet-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}",
	".dsh-pet-mp__chevron.is-open{transform:rotate(180deg)}",
	".dsh-pet-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}",
	".dsh-pet-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}",
	".dsh-pet-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}",
	".dsh-pet-mp__list{display:flex;flex-direction:column;min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin}",
	".dsh-pet-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-pet-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}",
	".dsh-pet-mp__item:hover:not(:disabled),.dsh-pet-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-pet-mp__item[aria-checked=\"true\"]{color:var(--dsw-alias-state-business-primary)}",
	".dsh-pet-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
	".dsh-pet-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dsh-pet-mp__check{flex:none;margin-left:auto}",
	".dsh-pet-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-pet-sel{position:relative;min-width:0}",
	".dsh-pet-sel__trigger{display:flex;align-items:center;gap:6px;text-align:left;cursor:pointer}",
	".dsh-pet-sel__trigger:disabled{cursor:default}",
	".dsh-pet-sel__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dsh-pet-sel__chevron{flex:none;margin-left:auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;color:var(--dsw-alias-label-tertiary);transition:transform .12s}",
	".dsh-pet-sel__chevron.is-open{transform:rotate(180deg)}",
	".dsh-pet-sel__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:2px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}",
	".dsh-pet-sel__list{display:flex;flex-direction:column;min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin}",
	".dsh-pet-sel__item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}",
	".dsh-pet-sel__item:hover:not(:disabled),.dsh-pet-sel__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-pet-sel__item[aria-selected=\"true\"]{color:var(--dsw-alias-state-business-primary)}",
	".dsh-pet-sel__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
	".dsh-pet-sel__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dsh-pet-sel__check{flex:none;margin-left:auto}",
	".dsh-pet-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
	".dsh-pet-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}",
	".dsh-pet-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}",
	".dsh-pet-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}",
	".dsh-pet-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
	".dsh-pet-cfg__card.is-fold{gap:0}",
	".dsh-pet-cfg__foldToggle{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;min-height:20px;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;outline:none}",
	".dsh-pet-cfg__foldToggle:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-pet-cfg__chevron{flex:none;margin-left:auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;color:var(--dsw-alias-label-tertiary);transition:transform .12s}",
	".dsh-pet-cfg__chevron.is-open{transform:rotate(180deg)}",
	".dsh-pet-cfg__fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows .12s ease}",
	".dsh-pet-cfg__card.is-open .dsh-pet-cfg__fold{grid-template-rows:1fr}",
	".dsh-pet-cfg__foldClip{min-height:0;overflow:hidden}",
	".dsh-pet-cfg__foldBody{display:flex;flex-direction:column;gap:10px;padding-top:10px}",
	".dsh-pet-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}",
	".dsh-pet-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}",
	".dsh-pet-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}",
	"@container (max-width:600px){.dsh-pet-cfg__grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}",
	"@container (max-width:400px){.dsh-pet-cfg__grid2,.dsh-pet-cfg__grid3,.dsh-pet-cfg__grid4{grid-template-columns:minmax(0,1fr)}}",
	".dsh-pet-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}",
	".dsh-pet-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
	".dsh-pet-cfg__topRow{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px 18px;align-items:stretch;margin-bottom:10px}",
	".dsh-pet-cfg__avatarCol{position:relative;width:120px;flex:none}",
	".dsh-pet-cfg__avatarImg{display:block;width:100%;height:100%;min-height:72px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);object-fit:cover;background:var(--dsw-alias-bg-layer-1)}",
	".dsh-pet-cfg__avatarPick{position:relative;display:block;height:100%;border-radius:14px}",
	".dsh-pet-cfg__avatarPick:focus-within{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
	".dsh-pet-cfg__avatarMask{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:14px;background:var(--dsw-alias-bg-mask,rgba(0,0,0,.55));color:var(--dsw-static-neutral-00,#fff);font-size:12px;line-height:1;opacity:0;transition:opacity .12s;pointer-events:none}",
	".dsh-pet-cfg__avatarPick:hover .dsh-pet-cfg__avatarMask,.dsh-pet-cfg__avatarPick:focus-within .dsh-pet-cfg__avatarMask,.dsh-pet-cfg__avatarMask.is-busy{opacity:1}",
	".dsh-pet-cfg__file{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:0}",
	"@container (max-width:400px){.dsh-pet-cfg__topRow{grid-template-columns:minmax(0,1fr)}.dsh-pet-cfg__avatarCol{width:72px}.dsh-pet-cfg__avatarImg{height:72px;min-height:0}}",
	".dsh-pet-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}",
	".dsh-pet-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}",
	".dsh-pet-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
	".dsh-pet-cfg__slider{display:flex;align-items:center;gap:10px;min-width:0;min-height:28px}",
	".dsh-pet-cfg__range{flex:1 1 auto;min-width:0;height:20px;margin:0;padding:0;background:transparent;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",
	".dsh-pet-cfg__range:disabled{cursor:default;opacity:.5}",
	".dsh-pet-cfg__rangeVal{flex:none;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
	".dsh-pet-cfg__slider.is-disabled .dsh-pet-cfg__rangeVal{color:var(--dsw-alias-label-tertiary)}",
	".dsh-pet-cfg__previewRow{display:flex;align-items:center;gap:8px;min-width:0}",
	".dsh-pet-cfg__previewRow>.dsh-pet-cfg__inp{flex:1 1 auto;min-width:0}",
	".dsh-pet-cfg__persona{display:flex;flex-direction:column;gap:2px;min-width:0}",
	".dsh-pet-cfg__area{min-height:66px;resize:vertical;line-height:18px}",
	".dsh-pet-cfg__count{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right}",
	".dsh-pet-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}",
	".dsh-pet-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}",
	".dsh-pet-cfg__toggle>label>span{overflow-wrap:anywhere}",
	".dsh-pet-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",
	".pet-cfg-tip{position:fixed;left:0;top:0;z-index:2147483000;max-width:320px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-00);font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;opacity:0;transition:opacity .12s ease;box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.22))}",
	".pet-cfg-tip.is-on{opacity:1}",
	".dsh-pet-cfg__q{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}",
	".dsh-pet-cfg__qWrap{display:inline-flex;flex:none;align-items:center}",
	".dsh-pet-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}",
	".dsh-pet-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-pet-cfg__btn:disabled{opacity:.5;cursor:default}",
	".dsh-pet-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}",
	".dsh-pet-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}",
	".dsh-pet-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}",
	".dsh-pet-cfg__btn.is-sm{padding:2px 10px}",
	".dsh-pet-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}",
	".dsh-pet-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
	".dsh-pet-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}",
	".dsh-pet-cfg__kinds{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}",
	".dsh-pet-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}",
	".dsh-pet-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-pet-cfg__tab:disabled{opacity:.5;cursor:default}",
	".dsh-pet-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}",
	".dsh-pet-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}",
	".dsh-pet-cfg__actions{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;padding:8px 0;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l2)}",
	".dsh-pet-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}",
	".dsh-pet-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}",
	".dsh-pet-cfg__menuList{display:flex;flex-direction:column;gap:4px;margin:2px 0 8px}",
	".dsh-pet-cfg__menuRow{display:grid;grid-template-columns:14px minmax(0,1fr) 64px;align-items:center;column-gap:10px;box-sizing:border-box;min-height:36px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-l2);cursor:grab}",
	".dsh-pet-cfg__menuRow:active{cursor:grabbing}",
	".dsh-pet-cfg__menuRow.is-dragging{opacity:.45}",
	".dsh-pet-cfg__menuRow.is-over{box-shadow:inset 0 2px 0 var(--dsw-alias-state-business-primary)}",
	".dsh-pet-cfg__menuRow.is-hidden .dsh-pet-cfg__menuName{opacity:.45;text-decoration:line-through}",
	".dsh-pet-cfg__menuHandle{font-size:13px;line-height:1;color:var(--dsw-alias-label-tertiary);user-select:none;text-align:center}",
	".dsh-pet-cfg__menuName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}",
	".dsh-pet-cfg__menuToggle{width:64px;justify-content:center;padding:0;white-space:nowrap}",
	".dsh-pet-cfg__actionsRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}",
	".dsh-pet-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-pet-cfg__note.is-bad{color:var(--dsw-alias-state-error-primary)}",
	".dsh-pet-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}",
	".dsh-pet-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}",
	".dsh-pet-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Courier New\",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}"
].join("\n");
/** 注入去重用的标记值，写在 `<style>` 的 `data-plugin-css` 上。 */
const settingsCssTag = "dsh-pet/settings.css";
function injectSettingsCss() {
	if (typeof document === "undefined") return;
	if (document.querySelector("style[data-plugin-css=\"" + settingsCssTag + "\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = settingsCssTag;
	tag.textContent = SETTINGS_CSS;
	document.head.appendChild(tag);
}

//#endregion
//#region src/client/settings/ui.ts
const INPUT_CLASS = "dsh-pet-cfg__inp";
function numberInputProps(value, onCommit, extra = {}) {
	return {
		...extra,
		type: "number",
		className: INPUT_CLASS,
		defaultValue: String(value),
		key: String(value),
		onBlur: (e) => {
			const text = e.target.value.trim();
			const parsed = Number(text);
			const next = text !== "" && Number.isFinite(parsed) ? parsed : value;
			e.target.value = String(next);
			if (next !== value) onCommit(next);
		},
		onKeyDown: (e) => {
			if (e.key === "Enter") e.currentTarget.blur();
		}
	};
}
function formatSliderValue(value, step) {
	const text = String(step);
	const dot = text.indexOf(".");
	const digits = dot < 0 ? 0 : text.length - dot - 1;
	return value.toFixed(Math.min(digits + 1, 3)).replace(/\.?0+$/, "") || "0";
}
const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, \"Courier New\", monospace";
function makeUiKit(rt) {
	const { h, t } = rt;
	/**
	* 悬浮说明的展开属性。
	*
	* @param text - 说明正文（已翻译）。
	*/
	const tip = (text) => ({ "data-tip": text });
	/** 问号：气泡的圆形触发元素。用 `<i>` 而不是 `<button>`——它只展示说明，点了不该有行为，也不该进 Tab 顺序。 */
	const q = (text) => h("i", {
		className: "dsh-pet-cfg__q",
		...tip(text),
		"aria-label": text,
		role: "img",
		children: "?"
	});
	return {
		tip,
		q,
		cardHead: (title, hint) => h("div", {
			className: "dsh-pet-cfg__cardHead",
			children: [h("span", {
				key: "t",
				className: "dsh-pet-cfg__cardTitle",
				children: title
			}), hint ? q(hint) : null]
		}),
		field: (label, control, hint) => h("div", {
			className: "dsh-pet-cfg__field",
			children: [h("span", {
				key: "l",
				className: "dsh-pet-cfg__flabel",
				children: hint ? [label, q(hint)] : label
			}), control]
		}),
		toggleCell: (label, value, disabled, onToggle) => h("div", {
			className: "dsh-pet-cfg__toggle",
			children: [h("label", {
				key: "l",
				children: [h("input", {
					key: "i",
					type: "checkbox",
					checked: value,
					disabled,
					onChange: (e) => onToggle(e.target.checked)
				}), h("span", {
					key: "t",
					children: t(label)
				})]
			}), q(t(label + "Hint"))]
		}),
		foldCard: (options) => h("div", {
			className: "dsh-pet-cfg__card is-fold" + (options.open ? " is-open" : ""),
			children: [h("button", {
				key: "head",
				type: "button",
				className: "dsh-pet-cfg__foldToggle",
				"aria-expanded": options.open,
				"aria-controls": options.id,
				onClick: options.onToggle,
				children: [
					h("span", {
						key: "t",
						className: "dsh-pet-cfg__cardTitle",
						children: options.title
					}),
					h("span", {
						key: "q",
						className: "dsh-pet-cfg__qWrap",
						onClick: (e) => e.stopPropagation(),
						children: q(options.hint)
					}),
					h("i", {
						key: "c",
						className: "dsh-pet-cfg__chevron" + (options.open ? " is-open" : ""),
						"aria-hidden": "true"
					})
				]
			}), h("div", {
				key: "body",
				id: options.id,
				className: "dsh-pet-cfg__fold",
				"aria-hidden": options.open ? void 0 : "true",
				children: h("div", {
					className: "dsh-pet-cfg__foldClip",
					children: h("div", {
						className: "dsh-pet-cfg__foldBody",
						children: options.body
					})
				})
			})]
		}),
		slider: (options) => h("div", {
			className: "dsh-pet-cfg__slider" + (options.disabled ? " is-disabled" : ""),
			children: [h("input", {
				key: "r",
				type: "range",
				className: "dsh-pet-cfg__range",
				min: options.min,
				max: options.max,
				step: options.step,
				value: String(options.value),
				disabled: options.disabled,
				onChange: (e) => options.onCommit(Number(e.target.value))
			}), h("span", {
				key: "v",
				className: "dsh-pet-cfg__rangeVal",
				children: formatSliderValue(options.value, options.step)
			})]
		})
	};
}

//#endregion
//#region src/client/settings/actions.ts
function makeActions(rt) {
	const { h, t } = rt;
	const { tip, q } = makeUiKit({
		h,
		t
	});
	return function Actions(props) {
		const { busy, msg, permMsg } = props;
		return h("div", {
			className: "dsh-pet-cfg__actions",
			children: [
				h("button", {
					type: "button",
					disabled: busy,
					onClick: props.onSave,
					className: "dsh-pet-cfg__btn is-primary",
					...tip(t("saveHotkey")),
					children: t("save")
				}),
				h("button", {
					type: "button",
					disabled: busy,
					onClick: props.onSync,
					className: "dsh-pet-cfg__btn",
					children: t("sync")
				}),
				h("button", {
					type: "button",
					onClick: props.onTestNotification,
					className: "dsh-pet-cfg__btn",
					children: t("notifyTest")
				}),
				q(t("syncHint")),
				msg.text ? h("span", {
					className: "dsh-pet-cfg__msg" + (msg.kind === "err" ? " is-err" : ""),
					children: msg.text
				}) : null,
				permMsg.text ? h("span", {
					className: "dsh-pet-cfg__msg" + (permMsg.kind === "err" ? " is-err" : ""),
					children: permMsg.text
				}) : null
			]
		});
	};
}

//#endregion
//#region src/client/settings/bridge.ts
const petBridge = {
	current: [],
	reload: () => {},
	template: void 0
};

//#endregion
//#region src/client/settings/config/read.ts
/** 只保留字符串项并按原序去重：配置里手写错一个数字不该让整页读不出菜单布局。 */
const stringList = (value) => {
	if (!Array.isArray(value)) return void 0;
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const text = item.trim();
		if (!text || out.includes(text)) continue;
		out.push(text);
	}
	return out;
};
/** 非负有限数才算合法；其余（`NaN`、负数、字符串）一律当作没写。 */
const nonNegative = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : void 0;
};
/** 一对模型选择：两项都是字符串才算写全，只写一半视为没写（宿主会按非法拒绝）。 */
const readModel = (value) => {
	const model = value;
	if (!model || typeof model.provider !== "string" || typeof model.model !== "string") return void 0;
	return {
		provider: model.provider,
		model: model.model
	};
};
function readMainConfig(merged) {
	const main = merged.main;
	if (!main || !Array.isArray(main.pets)) return null;
	const pets = main.pets;
	const patch = { pets: pets.map((pet) => ({
		...pet,
		position: { ...pet.position }
	})) };
	if (typeof main.whisperPrompt === "string") patch.entryPrompt = main.whisperPrompt;
	if (typeof main.notificationsEnabled === "boolean") patch.notificationsEnabled = main.notificationsEnabled;
	if (typeof main.clickSoundEnabled === "boolean") patch.clickSoundEnabled = main.clickSoundEnabled;
	if (typeof main.whisperImageEnabled === "boolean") patch.whisperImageEnabled = main.whisperImageEnabled;
	if (typeof main.chatImageEnabled === "boolean") patch.chatImageEnabled = main.chatImageEnabled;
	if (typeof main.chatAnimationEnabled === "boolean") patch.chatAnimationEnabled = main.chatAnimationEnabled;
	if (typeof main.confineToScreen === "boolean") patch.confineToScreen = main.confineToScreen;
	if (typeof main.trayEnabled === "boolean") patch.trayEnabled = main.trayEnabled;
	if (typeof main.requestBubbleEnabled === "boolean") patch.requestBubbleEnabled = main.requestBubbleEnabled;
	if (typeof main.scheduleRemindersEnabled === "boolean") patch.scheduleRemindersEnabled = main.scheduleRemindersEnabled;
	if (typeof main.voiceEnabled === "boolean") patch.voiceEnabled = main.voiceEnabled;
	if (typeof main.voiceName === "string") patch.voiceName = main.voiceName;
	if (typeof main.voiceWhisperEnabled === "boolean") patch.voiceWhisperEnabled = main.voiceWhisperEnabled;
	if (typeof main.voiceTodoEnabled === "boolean") patch.voiceTodoEnabled = main.voiceTodoEnabled;
	if (main.voiceEngine === "edge" || main.voiceEngine === "breeze") patch.voiceEngine = main.voiceEngine;
	if (typeof main.breezeApiKey === "string") patch.breezeApiKey = main.breezeApiKey;
	if (typeof main.breezeVoice === "string") patch.breezeVoice = main.breezeVoice;
	const breezeSpeed = Number(main.breezeSpeed);
	if (Number.isFinite(breezeSpeed) && breezeSpeed >= .5 && breezeSpeed <= 2) patch.breezeSpeed = breezeSpeed;
	if (main.physics && typeof main.physics === "object") patch.physics = {
		...DEFAULT_PHYSICS,
		...main.physics
	};
	if (main.font && typeof main.font === "object") patch.font = {
		...DEFAULT_FONT,
		...main.font
	};
	const whisperModel = readModel(main.whisperModel);
	if (whisperModel) patch.whisperModel = whisperModel;
	const chatModel = readModel(main.chatModel);
	if (chatModel) patch.chatModel = chatModel;
	const rounds = nonNegative(main.chatMemoryRounds);
	if (rounds !== void 0) patch.chatMemoryRounds = rounds;
	const limit = nonNegative(main.chatImageLimit);
	if (limit !== void 0) patch.chatImageLimit = limit;
	const order = stringList(main.menuOrder);
	if (order !== void 0) patch.menuOrder = order;
	const hiddenList = stringList(main.menuHidden);
	if (hiddenList !== void 0) patch.menuHidden = hiddenList;
	const volume = nonNegative(main.voiceVolume);
	if (volume !== void 0 && volume <= 1) patch.voiceVolume = volume;
	return patch;
}
function readConfigEntries(merged) {
	const main = merged.main;
	if (!main || !Array.isArray(main.pets)) return null;
	const out = [];
	for (const [key, conf] of Object.entries(merged)) {
		const pets = Array.isArray(conf?.pets) ? conf.pets : [];
		out.push({
			key,
			kind: key === "main" ? "main" : "pack",
			...typeof conf?.whisperPrompt === "string" ? { entryPrompt: conf.whisperPrompt } : {},
			pets: pets.map((pet) => ({
				...pet,
				position: { ...pet.position },
				assetRoot: key
			}))
		});
	}
	return out;
}

//#endregion
//#region src/client/settings/config/http.ts
function buildSaveBody(fields) {
	return {
		pets: fields.pets,
		notificationsEnabled: fields.notificationsEnabled,
		clickSoundEnabled: fields.clickSoundEnabled,
		whisperImageEnabled: fields.whisperImageEnabled,
		chatImageEnabled: fields.chatImageEnabled,
		chatAnimationEnabled: fields.chatAnimationEnabled,
		confineToScreen: fields.confineToScreen,
		trayEnabled: fields.trayEnabled,
		requestBubbleEnabled: fields.requestBubbleEnabled,
		scheduleRemindersEnabled: fields.scheduleRemindersEnabled,
		voiceEnabled: fields.voiceEnabled,
		voiceName: fields.voiceName,
		voiceVolume: fields.voiceVolume,
		voiceWhisperEnabled: fields.voiceWhisperEnabled,
		voiceTodoEnabled: fields.voiceTodoEnabled,
		voiceEngine: fields.voiceEngine,
		breezeApiKey: fields.breezeApiKey,
		breezeVoice: fields.breezeVoice,
		breezeSpeed: fields.breezeSpeed,
		physics: fields.physics,
		whisperModel: fields.whisperModel,
		chatModel: fields.chatModel,
		chatMemoryRounds: fields.chatMemoryRounds,
		chatImageLimit: fields.chatImageLimit,
		font: fields.font,
		menuOrder: [...fields.menuOrder],
		menuHidden: [...fields.menuHidden]
	};
}
async function loadConfig(signal) {
	try {
		const response = await fetch(ROUTE_PATH + "/config", signal === void 0 ? {} : { signal });
		if (!response.ok) return null;
		const body = await response.json();
		if (body.ok === false) return null;
		return body;
	} catch {
		return null;
	}
}
async function loadMeta() {
	try {
		const response = await fetch(ROUTE_PATH + "/config/meta");
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}
async function loadModelCatalog() {
	try {
		const response = await fetch(ROUTE_PATH + "/models");
		if (!response.ok) return null;
		const body = await response.json();
		if (!body || !Array.isArray(body.providers)) return null;
		return body.providers;
	} catch {
		return null;
	}
}
async function saveConfig(body, force) {
	try {
		const response = await fetch(ROUTE_PATH + "/config" + (force === true ? "?force=1" : ""), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		});
		const payload = await response.json().catch(() => null);
		if (payload && payload.ok === false) {
			if (payload.reason === "user-config-unparsable") return {
				kind: "corrupt",
				userFile: typeof payload.userFile === "string" ? payload.userFile : null
			};
			if (payload.reason === "bad-request" || payload.reason === "invalid-json") return { kind: "invalid" };
			return { kind: "error" };
		}
		if (!response.ok) return { kind: "error" };
		return {
			kind: "ok",
			merged: payload
		};
	} catch {
		return { kind: "error" };
	}
}
async function syncConfig() {
	try {
		const response = await fetch(ROUTE_PATH + "/config", { method: "POST" });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}
async function savePetLayer(entry, pets) {
	try {
		const response = await fetch(ROUTE_PATH + "/pet-config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				entry,
				pets
			})
		});
		const payload = await response.json().catch(() => null);
		if (payload && payload.ok === false) {
			if (payload.reason === "bad-request" || payload.reason === "unknown-entry") return {
				kind: "invalid",
				message: typeof payload.message === "string" ? payload.message : ""
			};
			return { kind: "error" };
		}
		if (!response.ok) return { kind: "error" };
		return {
			kind: "ok",
			merged: payload
		};
	} catch {
		return { kind: "error" };
	}
}

//#endregion
//#region src/client/settings/config/pack-writes.ts
/** 提交形状的指纹：只含会被宿主持久化的字段，位置逐子字段取。 */
function fingerprint(pet) {
	return JSON.stringify([
		pet.id,
		pet.name,
		pet.size,
		pet.sizePercent ?? "",
		pet.balanceEnabled,
		pet.whisperEnabled,
		pet.workStatusEnabled,
		pet.fixedEnabled,
		pet.display,
		pet.position.corner,
		pet.position.marginX,
		pet.position.marginY,
		pet.whisperPrompt ?? ""
	]);
}
function diffPackWrites(loaded, current$1) {
	const groups = new Map();
	for (const pet of current$1) {
		const entry = pet.assetRoot ?? "";
		if (entry === "" || entry === "main") continue;
		const list = groups.get(entry);
		if (list) list.push(pet);
		else groups.set(entry, [pet]);
	}
	const out = [];
	for (const [entry, pets] of groups) {
		const before = loaded.find((item) => item.key === entry)?.pets ?? [];
		const unchanged = before.length === pets.length && before.every((pet, i) => fingerprint(pet) === fingerprint(pets[i]));
		if (!unchanged) out.push({
			entry,
			pets
		});
	}
	return out;
}

//#endregion
//#region src/client/settings/config/persist.ts
async function persistSettings(fields, packWrites, force, fallbackUserFile) {
	const outcome = await saveConfig(buildSaveBody(fields), force);
	if (outcome.kind === "corrupt") return {
		kind: "corrupt",
		path: outcome.userFile ?? fallbackUserFile
	};
	if (outcome.kind !== "ok") return { kind: outcome.kind };
	let merged = outcome.merged;
	const failed = [];
	for (const write of packWrites) {
		const result = await savePetLayer(write.entry, write.pets);
		if (result.kind === "ok") merged = result.merged;
		else failed.push(write.entry);
	}
	petBridge.reload(merged);
	reloadNotifications();
	return failed.length > 0 ? {
		kind: "partial",
		failed
	} : { kind: "ok" };
}
async function syncSettings() {
	const merged = await syncConfig();
	if (merged === null) return null;
	petBridge.reload(merged);
	reloadNotifications();
	return merged;
}

//#endregion
//#region src/client/settings/config/validate-form.ts
const modelPairValid = (model) => model.provider.trim() === "" === (model.model.trim() === "");
/** 宠物：宽度必须为正数、百分比缺省或是不小于 1 的数字、两个偏移必须是有限数（负数合法，宠物可以压出屏外）。 */
const petValid = (pet) => Number.isFinite(pet.size) && pet.size > 0 && (pet.sizePercent === void 0 || isValidSizePercent(pet.sizePercent)) && Number.isFinite(pet.position.marginX) && Number.isFinite(pet.position.marginY);
/** 物理参数：与宿主 `physicsValid` 同名规则，客户端只覆盖数值字段（布尔项由宿主兜底）。 */
const physicsValid = (physics) => Number.isFinite(physics.gravity) && physics.gravity >= 0 && Number.isFinite(physics.restitution) && physics.restitution >= 0 && physics.restitution <= 1 && Number.isFinite(physics.groundFriction) && physics.groundFriction >= 0 && Number.isFinite(physics.throwPower) && physics.throwPower > 0;
/** 字体：种类必须在预设白名单内，字号在闭区间内。 */
const fontValid = (font) => FONT_PRESETS.some((preset) => preset.id === font.family) && Number.isFinite(font.size) && font.size >= FONT_SIZE_MIN && font.size <= FONT_SIZE_MAX;
function validateForm(values) {
	if (!values.pets.every(petValid)) return "invalid";
	if (!physicsValid(values.physics)) return "invalidPhysics";
	if (!modelPairValid(values.whisperModel) || !modelPairValid(values.chatModel)) return "invalidModel";
	if (!Number.isFinite(values.chatMemory) || values.chatMemory < 0) return "invalidChatMemory";
	if (!Number.isFinite(values.chatImageLimit) || values.chatImageLimit < 0) return "invalidChatImageLimit";
	if (!fontValid(values.font)) return "invalidFont";
	return null;
}

//#endregion
//#region src/client/settings/config/write-flow.ts
function createWriteFlow(deps) {
	const { setBusy, setMsg, setDialog, t } = deps;
	const save = async (force = false) => {
		if (deps.busy()) return;
		const fields = deps.fields();
		const invalid = validateForm({
			pets: fields.pets,
			physics: fields.physics,
			whisperModel: fields.whisperModel,
			chatModel: fields.chatModel,
			chatMemory: fields.chatMemoryRounds,
			chatImageLimit: fields.chatImageLimit,
			font: fields.font
		});
		if (invalid !== null) {
			setMsg({
				kind: "err",
				text: t(invalid)
			});
			return;
		}
		setBusy(true);
		setMsg({
			kind: "",
			text: ""
		});
		try {
			const result = await persistSettings(fields, deps.packWrites(), force, deps.userFile());
			if (result.kind === "ok") {
				setMsg({
					kind: "ok",
					text: t("saved")
				});
				return;
			}
			if (result.kind === "corrupt") {
				setDialog({
					kind: "corrupt",
					path: result.path
				});
				return;
			}
			if (result.kind === "partial") {
				setMsg({
					kind: "err",
					text: t("savePartial").replace("{names}", result.failed.join("、"))
				});
				return;
			}
			setMsg({
				kind: "err",
				text: t(result.kind === "invalid" ? "saveInvalid" : "saveError")
			});
		} finally {
			setBusy(false);
		}
	};
	const doSync = async () => {
		setBusy(true);
		setMsg({
			kind: "",
			text: ""
		});
		try {
			const merged = await syncSettings();
			if (merged === null) {
				setMsg({
					kind: "err",
					text: t("syncError")
				});
				return;
			}
			deps.applyConfig(merged);
			setMsg({
				kind: "ok",
				text: t("saved")
			});
		} finally {
			setBusy(false);
		}
	};
	return {
		save,
		requestSync: () => setDialog({ kind: "sync" }),
		confirmDialog: () => {
			const pending = deps.dialog();
			if (pending === null) return;
			setDialog(null);
			if (pending.kind === "remove") deps.onRemove();
			else if (pending.kind === "corrupt") save(true);
			else if (pending.kind === "sync") doSync();
		}
	};
}

//#endregion
//#region src/client/settings/config/use-config-load.ts
function useConfigLoad(rt, onMerged) {
	const { useState, useEffect } = rt;
	const [loadState, setLoadState] = useState("loading");
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let alive = true;
		const controller = new AbortController();
		loadConfig(controller.signal).then((merged) => {
			if (!alive) return;
			if (merged === null) {
				setLoadState("error");
				return;
			}
			onMerged(merged);
			setLoadState("ready");
		}).catch(() => {
			if (alive) setLoadState("error");
		});
		return () => {
			alive = false;
			controller.abort();
		};
	}, [onMerged, attempt]);
	const retry = () => {
		setLoadState("loading");
		setAttempt((value) => value + 1);
	};
	return {
		loadState,
		retry
	};
}

//#endregion
//#region src/client/settings/dialog.ts
/** 正文文案：每个场景一句，参数就地代入。 */
function bodyText(dialog, t, selId) {
	if (dialog.kind === "remove") return t("confirmRemove").replace("{id}", selId);
	if (dialog.kind === "lastOne") return t("atLeastOne");
	if (dialog.kind === "lastOfKind") return t("lastOfKind").replace("{entry}", dialog.entry);
	if (dialog.kind === "corrupt") return t("corruptBody").replace("{path}", dialog.path);
	return t("confirmSync");
}
/** 确认按钮文案：三个可确认场景各一句。 */
function confirmLabel(kind, t) {
	if (kind === "remove") return t("remove");
	if (kind === "corrupt") return t("corruptConfirm");
	return t("sync");
}
function makeDialog(rt) {
	const { h, t } = rt;
	return function SettingsDialog(props) {
		const { dialog } = props;
		const confirmable = dialog.kind === "lastOne" || dialog.kind === "lastOfKind" ? null : dialog;
		return h("div", {
			style: {
				position: "fixed",
				inset: 0,
				zIndex: 2147483647,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "rgba(0, 0, 0, 0.45)"
			},
			onClick: props.onDismiss,
			children: h("div", {
				style: {
					width: "340px",
					maxWidth: "calc(100vw - 40px)",
					background: "var(--dsw-alias-bg-layer-1)",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: "12px",
					padding: "16px 18px",
					boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)",
					display: "flex",
					flexDirection: "column",
					gap: "12px"
				},
				onClick: (e) => e.stopPropagation(),
				children: [
					h("div", {
						style: {
							fontSize: "14px",
							fontWeight: 500,
							color: "var(--dsw-alias-label-primary)"
						},
						children: t(dialog.kind === "corrupt" ? "corruptTitle" : "confirmTitle")
					}),
					h("div", {
						style: {
							fontSize: "13px",
							lineHeight: "20px",
							color: "var(--dsw-alias-label-secondary)"
						},
						children: bodyText(dialog, t, props.selId)
					}),
					h("div", {
						style: {
							display: "flex",
							gap: "8px",
							justifyContent: "flex-end"
						},
						children: confirmable === null ? [h("button", {
							key: "ok",
							type: "button",
							onClick: props.onDismiss,
							className: "dsh-pet-cfg__btn is-primary",
							children: t("ok")
						})] : [h("button", {
							key: "cancel",
							type: "button",
							onClick: props.onDismiss,
							className: "dsh-pet-cfg__btn",
							children: t("cancel")
						}), h("button", {
							key: "confirm",
							type: "button",
							onClick: props.onConfirm,
							className: "dsh-pet-cfg__btn " + (confirmable.kind === "sync" ? "is-primary" : "is-danger"),
							children: confirmLabel(confirmable.kind, t)
						})]
					})
				]
			})
		});
	};
}

//#endregion
//#region src/client/settings/panel/placement.ts
/**
* 设置页浮层的定位计算：把触发器的实测矩形与视口尺寸换算成浮层的 fixed 坐标。
* 下方放不下且上方更宽裕时翻到上方，左右钳制在视口内，并给出高度上限——浮层自身不进文档流。
* 纯函数，不读 `window`：矩形与视口由调用方传入，便于单测与将来的视口外定位。
* 模型选择器与通用单选下拉共用这一份算术，差异只经 {@link PlacementOptions} 传入，不在调用方各自复制。
* @module dsh-pet/src/client/settings/panel/placement
*/
/** 浮层与触发器、视口边缘之间的间距。 */
const PANEL_GAP_PX = 12;
/** 浮层离触发器的偏移，避免贴着触发器边框。 */
const PANEL_OFFSET_PX = 4;
/** 视口余量：浮层左右各留 8px，不贴死屏幕边。 */
const EDGE_MARGIN_PX = 8;
/** 视口更窄时浮层宽度的兜底余量。 */
const VIEWPORT_INSET_PX = 16;
/** 视口窄到连它都装不下时，仍按这个宽度渲染。 */
const MIN_AVAILABLE_WIDTH_PX = 200;
function computePanelPlacement(anchor, viewport, options = {}) {
	const minWidth = options.minWidthPx ?? 240;
	const maxWidth = options.maxWidthPx ?? 420;
	const maxHeight = options.maxHeightPx ?? 360;
	const flipThreshold = options.flipThresholdPx ?? 240;
	const below = viewport.height - anchor.bottom - PANEL_GAP_PX;
	const above = anchor.top - PANEL_GAP_PX;
	const available = Math.max(MIN_AVAILABLE_WIDTH_PX, Math.min(maxWidth, viewport.width - VIEWPORT_INSET_PX));
	const width = Math.min(Math.max(anchor.width, minWidth), available);
	const left = Math.max(EDGE_MARGIN_PX, Math.min(anchor.left, viewport.width - width - EDGE_MARGIN_PX));
	const openUp = below < flipThreshold && above > below;
	return openUp ? {
		left,
		bottom: viewport.height - anchor.top + PANEL_OFFSET_PX,
		width,
		maxHeight: Math.min(maxHeight, above)
	} : {
		left,
		top: anchor.bottom + PANEL_OFFSET_PX,
		width,
		maxHeight: Math.min(maxHeight, below)
	};
}

//#endregion
//#region src/client/settings/panel/select.ts
function makeSelect(rt) {
	const { h, useState, useEffect, useRef } = rt;
	return function Select(props) {
		const [open, setOpen] = useState(false);
		const [active, setActive] = useState(0);
		const [pos, setPos] = useState(null);
		const rootRef = useRef(null);
		const panelRef = useRef(null);
		const selectedAt = props.options.findIndex((option) => option.id === props.value);
		const currentLabel = selectedAt >= 0 ? props.options[selectedAt].label : "";
		/** 打开并把高亮停到当前选中项上。 */
		const openAt = (index) => {
			setActive(index >= 0 ? index : 0);
			setOpen(true);
		};
		const commit = (index) => {
			const option = props.options[index];
			setOpen(false);
			if (option !== void 0 && option.id !== props.value) props.onChange(option.id);
		};
		const step = (dir) => {
			const count = props.options.length;
			if (count === 0) return;
			const next = (Math.max(active, 0) + dir + count) % count;
			setActive(next);
			panelRef.current?.querySelector("[data-row=\"" + next + "\"]")?.scrollIntoView({ block: "nearest" });
		};
		useEffect(() => {
			if (!open) return;
			const root = rootRef.current;
			const place = () => {
				if (!root) return;
				setPos(computePanelPlacement(
					root.getBoundingClientRect(),
					{
						width: window.innerWidth,
						height: window.innerHeight
					},
					// 与触发器等宽：240 的下限是给「服务商 + 模型」两段文字留的，单行下拉不该继承。
					{ minWidthPx: 0 }
));
			};
			place();
			const onDown = (e) => {
				const target = e.target;
				if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) return;
				setOpen(false);
			};
			const onKey = (e) => {
				if (e.key === "Escape") setOpen(false);
			};
			document.addEventListener("mousedown", onDown, true);
			document.addEventListener("keydown", onKey, true);
			window.addEventListener("scroll", place, true);
			window.addEventListener("resize", place);
			return () => {
				document.removeEventListener("mousedown", onDown, true);
				document.removeEventListener("keydown", onKey, true);
				window.removeEventListener("scroll", place, true);
				window.removeEventListener("resize", place);
			};
		}, [open]);
		useEffect(() => {
			if (props.disabled) setOpen(false);
		}, [props.disabled]);
		const toggle = () => {
			if (props.disabled) return;
			if (open) setOpen(false);
			else openAt(selectedAt);
		};
		const onTriggerKey = (e) => {
			const count = props.options.length;
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				if (open) step(e.key === "ArrowDown" ? 1 : -1);
				else openAt(selectedAt);
				return;
			}
			if (open && (e.key === "Home" || e.key === "End")) {
				e.preventDefault();
				setActive(e.key === "Home" || count === 0 ? 0 : count - 1);
				return;
			}
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				if (open) commit(active);
				else openAt(selectedAt);
			}
		};
		const panel = open && pos ? h("div", {
			ref: panelRef,
			className: "dsh-pet-sel__panel",
			role: "listbox",
			"aria-label": props.label,
			style: {
				left: pos.left + "px",
				top: pos.top === void 0 ? void 0 : pos.top + "px",
				bottom: pos.bottom === void 0 ? void 0 : pos.bottom + "px",
				width: pos.width + "px",
				maxHeight: pos.maxHeight + "px"
			},
			children: h("div", {
				className: "dsh-pet-sel__list",
				children: props.options.map((option, index) => h("button", {
					key: option.id,
					type: "button",
					role: "option",
					"aria-selected": option.id === props.value,
					"data-row": index,
					className: "dsh-pet-sel__item" + (index === active ? " is-active" : ""),
					onMouseMove: () => setActive(index),
					onClick: () => commit(index),
					children: [h("span", {
						key: "n",
						className: "dsh-pet-sel__name",
						children: option.label
					}), h("span", {
						key: "c",
						className: "dsh-pet-sel__check",
						children: option.id === props.value ? "✓" : ""
					})]
				}))
			})
		}) : null;
		return h("div", {
			ref: rootRef,
			className: "dsh-pet-sel",
			children: [h("button", {
				key: "trigger",
				type: "button",
				className: INPUT_CLASS + " dsh-pet-sel__trigger",
				disabled: props.disabled,
				"aria-haspopup": "listbox",
				"aria-expanded": open,
				"aria-label": props.label,
				onClick: toggle,
				onKeyDown: onTriggerKey,
				children: [h("span", {
					key: "l",
					className: "dsh-pet-sel__label",
					children: currentLabel
				}), h("span", {
					key: "c",
					className: "dsh-pet-sel__chevron" + (open ? " is-open" : "")
				})]
			}), panel]
		});
	};
}

//#endregion
//#region src/client/settings/font-card.ts
function makeFontCard(rt) {
	const { h, t } = rt;
	const { cardHead, field, toggleCell } = makeUiKit({
		h,
		t
	});
	const Select = makeSelect(rt);
	return function FontCard(props) {
		const { busy, font } = props;
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [
				cardHead(t("fontTitle"), t("fontHint")),
				h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [field(t("fontFamilyLabel"), h(Select, {
						label: t("fontFamilyLabel"),
						value: font.family,
						options: FONT_PRESETS.map((preset) => ({
							id: preset.id,
							label: t("font." + preset.id)
						})),
						disabled: busy,
						onChange: (id) => props.onChange({ family: id })
					}), t("fontFamilyHint")), field(t("fontSizeLabel"), h("input", numberInputProps(font.size, (v) => props.onChange({ size: v }), {
						step: "1",
						min: String(FONT_SIZE_MIN),
						max: String(FONT_SIZE_MAX),
						disabled: busy
					})), t("fontSizeHint"))]
				}),
				h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [toggleCell("fontFollowToggle", font.followPet, busy, (v) => props.onChange({ followPet: v }))]
				})
			]
		});
	};
}

//#endregion
//#region src/client/settings/global-card.ts
/** 开关的展示顺序与文案键。 */
const TOGGLES = [
	{
		key: "notificationsEnabled",
		label: "notifyToggle"
	},
	{
		key: "clickSoundEnabled",
		label: "clickSoundToggle"
	},
	{
		key: "confineToScreen",
		label: "confineToggle"
	},
	{
		key: "trayEnabled",
		label: "trayToggle"
	},
	{
		key: "requestBubbleEnabled",
		label: "requestBubbleToggle"
	},
	{
		key: "scheduleRemindersEnabled",
		label: "scheduleReminderToggle"
	}
];
function makeGlobalCard(rt) {
	const { h, t } = rt;
	const { cardHead, toggleCell } = makeUiKit({
		h,
		t
	});
	return function GlobalCard(props) {
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [cardHead(t("globalTitle"), t("globalHint")), h("div", {
				className: "dsh-pet-cfg__grid4",
				children: TOGGLES.map((toggle) => toggleCell(toggle.label, props.values[toggle.key], props.busy, (value) => props.onChange(toggle.key, value)))
			})]
		});
	};
}

//#endregion
//#region src/shared/menu/layout.ts
const MENU_TOOL_ACTIONS = [
	{
		action: "chat",
		label: "对话",
		hint: "在宠物身上打开对话窗，输入框贴上就能说"
	},
	{
		action: "show-balance",
		label: "查看余额",
		hint: "拉一次余额并弹气泡"
	},
	{
		action: "todo",
		label: "待办事项",
		hint: "打开待办面板"
	},
	{
		action: "history",
		label: "最近记录",
		hint: "翻看弹过的提醒与推送"
	},
	{
		action: "whisper",
		label: "碎碎念",
		hint: "立刻说一句"
	},
	{
		action: "sleep",
		label: "睡觉",
		hint: "只在配了睡觉动作时出现；睡着时自动变成「起来」"
	}
];
const DEFAULT_MENU_ORDER = MENU_TOOL_ACTIONS.map((item) => item.action);
/** 合法动作名集合：读配置时用来丢掉拼错的项。 */
const KNOWN = new Set(DEFAULT_MENU_ORDER);
/** 把任意值读成「只含合法动作、去重、保持顺序」的字符串数组；非数组一律当没写。 */
function sanitize(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const action = item.trim();
		if (!KNOWN.has(action) || out.includes(action)) continue;
		out.push(action);
	}
	return out;
}
function resolveMenuLayout(order, hidden) {
	const preferred = sanitize(order);
	const merged = [...preferred, ...DEFAULT_MENU_ORDER.filter((action) => !preferred.includes(action))];
	return {
		order: merged,
		hidden: sanitize(hidden)
	};
}

//#endregion
//#region src/client/settings/menu-card.ts
/** 动作名 → 菜单文案（与菜单上逐字一致，避免设置页与菜单两套说法）。 */
const LABELS = new Map(MENU_TOOL_ACTIONS.map((item) => [item.action, item.label]));
function makeMenuCard(rt) {
	const { h, t, useState } = rt;
	const { cardHead } = makeUiKit({
		h,
		t
	});
	return function MenuCard(props) {
		const layout = resolveMenuLayout(props.order, props.hidden);
		const [dragIndex, setDragIndex] = useState(null);
		const [overIndex, setOverIndex] = useState(null);
		const moveTo = (from, to) => {
			const total = layout.order.length;
			if (from === to || from < 0 || to < 0 || from >= total || to >= total) return;
			const next = [...layout.order];
			const [item] = next.splice(from, 1);
			if (item === void 0) return;
			next.splice(to, 0, item);
			props.onChange(next, layout.hidden);
		};
		const toggle = (action) => {
			const hidden = layout.hidden.includes(action) ? layout.hidden.filter((item) => item !== action) : [...layout.hidden, action];
			props.onChange(layout.order, hidden);
		};
		const clearDrag = () => {
			setDragIndex(null);
			setOverIndex(null);
		};
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [
				cardHead(t("menuTitle"), t("menuHint")),
				h("div", {
					className: "dsh-pet-cfg__menuList",
					children: layout.order.map((action, index) => {
						const hidden = layout.hidden.includes(action);
						const label = LABELS.get(action) ?? action;
						const classes = ["dsh-pet-cfg__menuRow"];
						if (hidden) classes.push("is-hidden");
						if (dragIndex === index) classes.push("is-dragging");
						if (overIndex === index && dragIndex !== null && dragIndex !== index) classes.push("is-over");
						return h("div", {
							key: action,
							className: classes.join(" "),
							draggable: !props.busy,
							title: t("menuDrag"),
							onDragStart: (e) => {
								if (props.busy) {
									e.preventDefault();
									return;
								}
								e.dataTransfer.effectAllowed = "move";
								e.dataTransfer.setData("text/plain", String(index));
								setDragIndex(index);
								setOverIndex(index);
							},
							onDragOver: (e) => {
								if (dragIndex === null) return;
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
								setOverIndex(index);
							},
							onDrop: (e) => {
								if (dragIndex === null) return;
								e.preventDefault();
								moveTo(dragIndex, index);
								clearDrag();
							},
							onDragEnd: clearDrag,
							children: [
								h("span", {
									className: "dsh-pet-cfg__menuHandle",
									"aria-hidden": true,
									children: "⠿"
								}),
								h("span", {
									className: "dsh-pet-cfg__menuName",
									title: label,
									children: label
								}),
								h("button", {
									type: "button",
									className: "dsh-pet-cfg__btn is-sm dsh-pet-cfg__menuToggle" + (hidden ? "" : " is-primary"),
									disabled: props.busy,
									title: hidden ? t("menuShow") : t("menuHide"),
									onClick: () => toggle(action),
									children: hidden ? t("menuShow") : t("menuHide")
								})
							]
						});
					})
				}),
				h("div", {
					className: "dsh-pet-cfg__actionsRow",
					children: [h("button", {
						type: "button",
						className: "dsh-pet-cfg__btn is-sm",
						disabled: props.busy,
						onClick: () => props.onChange([], []),
						children: t("menuReset")
					}), h("span", {
						className: "dsh-pet-cfg__note",
						children: t("menuNote")
					})]
				})
			]
		});
	};
}

//#endregion
//#region src/client/settings/load-status.ts
function makeLoadStatus(rt) {
	const { h, t } = rt;
	return function LoadStatus(props) {
		if (props.loadState === "ready") return null;
		const failed = props.loadState === "error";
		return h("div", {
			role: failed ? "alert" : "status",
			className: "dsh-pet-cfg__actions",
			children: [h("span", { children: t(failed ? "loadError" : "loading") }), failed ? h("button", {
				type: "button",
				className: "dsh-pet-cfg__btn",
				onClick: props.onRetry,
				children: t("retry")
			}) : null]
		});
	};
}

//#endregion
//#region src/client/settings/model-card.ts
/** 对话开关的展示顺序与文案键。 */
const CHAT_TOGGLES = [
	{
		key: "whisperImageEnabled",
		label: "whisperImageToggle"
	},
	{
		key: "chatImageEnabled",
		label: "chatImageToggle"
	},
	{
		key: "chatAnimationEnabled",
		label: "chatAnimationToggle"
	}
];
function makeModelCard(rt, picker) {
	const { h, t } = rt;
	const { cardHead, field, toggleCell, slider } = makeUiKit({
		h,
		t
	});
	return function ModelCard(props) {
		const { busy, catalog, failed } = props;
		/**
		* 「全局默认」的一格：标签与问号在上、滑条在下。
		*
		* 这两个值是「条数」与「张数」，拖两下就知道自己在收放什么；上限 50 足够（再多纯属烧上下文）。
		*/
		const numField = (label, value, setter) => field(t(label), slider({
			value: Math.min(Math.max(value, 0), 50),
			min: 0,
			max: 50,
			step: 1,
			disabled: busy,
			onCommit: setter
		}), t(label + "Hint"));
		/** 「AI 模型」的一格：标签与问号在上、单下拉选择器在下。 */
		const modelCell = (key, value) => {
			const label = t(key === "whisperModel" ? "whisperModelLabel" : "chatModelLabel");
			return field(label, h(picker, {
				label,
				value,
				disabled: busy,
				catalog,
				failed,
				onChange: (next) => props.onModelChange(key, next)
			}), t("modelFieldHint"));
		};
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [
				cardHead(t("modelTitle"), t("modelHint")),
				failed ? h("p", {
					className: "dsh-pet-cfg__note",
					style: { color: "var(--dsw-alias-state-error-primary)" },
					children: t("modelCatalogFailed")
				}) : null,
				h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [modelCell("whisperModel", props.whisperModel), modelCell("chatModel", props.chatModel)]
				}),
				h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [numField("chatMemory", props.chatMemory, props.onChatMemoryChange), numField("chatImageLimit", props.chatImageLimit, props.onChatImageLimitChange)]
				}),
				h("div", {
					className: "dsh-pet-cfg__grid3",
					children: CHAT_TOGGLES.map((toggle) => toggleCell(toggle.label, props.values[toggle.key], busy, (value) => props.onFlagChange(toggle.key, value)))
				})
			]
		});
	};
}

//#endregion
//#region src/client/pet/device-tilt.ts
const TILT_DEAD_ZONE_DEG = 2;
const SHAKE_THRESHOLD = 18;
const SHAKE_COOLDOWN_MS = 300;
/** 摇一摇基准：3600 px/s 起，随加速度线性加码，封顶 4800。 */
const SHAKE_BASE_SPEED = 3600;
const SHAKE_GAIN = 160;
const SHAKE_MAX_BONUS = 4800;
/** 屏幕方向角（0/90/180/270）：横屏时倾斜轴要换过来。 */
const screenAngleDeg = () => {
	if (typeof screen === "undefined" || !screen.orientation) return 0;
	return screen.orientation.angle || 0;
};
/** 把角度差折到最近的等价角，避免从 179° 跳到 -179° 时方向反转。 */
const nearestDelta = (delta, period) => {
	const half = period / 2;
	return ((delta + half) % period + period) % period - half;
};
function tiltGravity(sample, baseline, gravity, screenAngle = screenAngleDeg()) {
	const dBeta = nearestDelta(sample.beta - baseline.beta, 360);
	const dGamma = nearestDelta(sample.gamma - baseline.gamma, 180);
	if (Math.abs(dBeta) < TILT_DEAD_ZONE_DEG && Math.abs(dGamma) < TILT_DEAD_ZONE_DEG) return {
		gx: 0,
		gy: 0
	};
	if (!Number.isFinite(gravity) || gravity <= 0) return {
		gx: 0,
		gy: 0
	};
	const rad = Math.PI / 180;
	const ax = gravity * Math.sin(dGamma * rad);
	const ay = gravity * Math.sin(dBeta * rad);
	switch ((screenAngle % 360 + 360) % 360) {
		case 90: return {
			gx: ay,
			gy: -ax
		};
		case 180: return {
			gx: -ax,
			gy: -ay
		};
		case 270: return {
			gx: -ay,
			gy: ax
		};
		default: return {
			gx: ax,
			gy: ay
		};
	}
}
function shakeImpulse(ax, ay, az, throwPower) {
	const mag = Math.hypot(ax, ay, az);
	if (!Number.isFinite(mag) || mag < SHAKE_THRESHOLD) return null;
	const lateral = Math.hypot(ax, ay);
	if (lateral < 1e-6) return null;
	const speed = (SHAKE_BASE_SPEED + Math.min(SHAKE_MAX_BONUS, mag * SHAKE_GAIN)) * Math.max(0, throwPower);
	return {
		vx: ax / lateral * speed,
		vy: ay / lateral * speed
	};
}
function canReadMotionSensors() {
	return typeof DeviceOrientationEvent !== "undefined" && typeof DeviceMotionEvent !== "undefined";
}
async function requestMotionPermission(kinds) {
	const ask = async (ctor) => {
		if (ctor === void 0) return false;
		const fn = ctor.requestPermission;
		if (typeof fn !== "function") return true;
		try {
			return await fn.call(ctor) === "granted";
		} catch {
			return false;
		}
	};
	const granted = [];
	if (kinds.tilt) granted.push(await ask(globalThis.DeviceOrientationEvent));
	if (kinds.shake) granted.push(await ask(globalThis.DeviceMotionEvent));
	return granted.every(Boolean);
}
function subscribeTilt(onSample) {
	if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return () => {};
	const handler = (e) => {
		if (e.beta === null || e.gamma === null) return;
		onSample({
			beta: e.beta,
			gamma: e.gamma
		});
	};
	window.addEventListener("deviceorientation", handler, true);
	return () => window.removeEventListener("deviceorientation", handler, true);
}
function subscribeShake(onShake, now = () => performance.now()) {
	if (typeof window === "undefined" || typeof DeviceMotionEvent === "undefined") return () => {};
	let lastAt = 0;
	const handler = (e) => {
		const a = e.acceleration;
		const raw = a && (a.x !== null || a.y !== null || a.z !== null) ? a : e.accelerationIncludingGravity;
		if (!raw) return;
		const ax = raw.x ?? 0;
		const ay = raw.y ?? 0;
		const az = raw.z ?? 0;
		if (Math.hypot(ax, ay, az) < SHAKE_THRESHOLD) return;
		const at = now();
		if (at - lastAt < SHAKE_COOLDOWN_MS) return;
		lastAt = at;
		onShake(ax, ay, az);
	};
	window.addEventListener("devicemotion", handler, true);
	return () => window.removeEventListener("devicemotion", handler, true);
}

//#endregion
//#region src/client/settings/mobile-card.ts
function makeMobileCard(rt) {
	const { h, t } = rt;
	const { cardHead, toggleCell } = makeUiKit({
		h,
		t
	});
	return function MobileCard(props) {
		const { busy, physics } = props;
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [cardHead(t("mobileTitle"), t("mobileHint")), h("div", {
				className: "dsh-pet-cfg__grid3",
				children: [
					toggleCell("physicsHaptic", physics.hapticEnabled !== false, busy, (v) => props.onChange({ hapticEnabled: v })),
					toggleCell("physicsTilt", physics.tiltGravity === true, busy, (v) => {
						if (v) requestMotionPermission({
							tilt: true,
							shake: false
						});
						props.onChange({ tiltGravity: v });
					}),
					toggleCell("physicsShake", physics.shakeThrow === true, busy, (v) => {
						if (v) requestMotionPermission({
							tilt: false,
							shake: true
						});
						props.onChange({ shakeThrow: v });
					})
				]
			})]
		});
	};
}

//#endregion
//#region src/client/settings/picker/model-rows.ts
function matchModelQuery(text, query) {
	const needle = query.trim().toLowerCase();
	if (needle === "") return true;
	let at = 0;
	for (const char of text.toLowerCase()) {
		if (char === needle[at]) at += 1;
		if (at >= needle.length) return true;
	}
	return false;
}
function buildModelRows(groups, query) {
	const needle = query.trim().toLowerCase();
	const rows = [];
	if (needle === "") rows.push({
		kind: "follow",
		key: "__follow"
	});
	for (const group of groups) {
		const models = group.models.filter((model) => matchModelQuery(model.name + " " + model.id, needle));
		if (models.length === 0 && !(needle === "" && group.models.length === 0)) continue;
		rows.push({
			kind: "group",
			key: group.id,
			name: group.name
		});
		if (models.length === 0) {
			rows.push({
				kind: "none",
				key: group.id + "/__none"
			});
			continue;
		}
		for (const model of models) rows.push({
			kind: "model",
			key: group.id + "/" + model.id,
			provider: group.id,
			model
		});
	}
	return rows;
}
function selectableIndexes(rows) {
	return rows.map((row, index) => row.kind === "group" || row.kind === "none" ? -1 : index).filter((i) => i >= 0);
}

//#endregion
//#region src/client/settings/picker/model-picker-panel.ts
function buildModelPanel(view) {
	const { h, t } = view;
	const emptyHint = view.catalog !== null && view.catalog.length === 0 ? t("modelNoModels") : view.rows.length === 0 ? t("modelEmpty") : "";
	return h("div", {
		ref: view.panelRef,
		className: "dsh-pet-mp__panel",
		role: "menu",
		"aria-label": view.label,
		style: {
			left: view.pos.left + "px",
			top: view.pos.top === void 0 ? void 0 : view.pos.top + "px",
			bottom: view.pos.bottom === void 0 ? void 0 : view.pos.bottom + "px",
			width: view.pos.width + "px",
			maxHeight: view.pos.maxHeight + "px"
		},
		children: [searchNode(view), view.catalog === null ? statusNode(h, "loading", view.failed ? t("modelCatalogFailed") : t("modelLoading"), false) : emptyHint !== "" ? statusNode(h, "empty", emptyHint, true) : h("div", {
			key: "list",
			className: "dsh-pet-mp__list",
			role: "group",
			children: view.rows.map((row, index) => rowNode(view, row, index))
		})]
	});
}
/** 三态提示行：加载中 / 失败 / 空结果。 */
function statusNode(h, key, text, live) {
	return h("div", {
		key,
		className: "dsh-pet-mp__status",
		role: live ? "status" : void 0,
		children: text
	});
}
/** 搜索框：↑↓ 走行、Enter 选中，Esc 由浮层级的 document 监听处理。 */
function searchNode(view) {
	const { h, t } = view;
	return h("input", {
		key: "search",
		type: "text",
		className: "dsh-pet-mp__search",
		role: "searchbox",
		placeholder: t("modelSearch"),
		"aria-label": t("modelSearch"),
		value: view.query,
		disabled: view.disabled,
		onChange: (event) => view.onQueryChange(event.target.value),
		onKeyDown: view.onKeyDown
	});
}
/** 一行：分组头、提示行、模型（可选、可高亮）。 */
function rowNode(view, row, index) {
	const { h, t } = view;
	if (row.kind === "group") return h("div", {
		key: row.key,
		className: "dsh-pet-mp__group",
		children: row.name
	});
	if (row.kind === "none") return h("div", {
		key: row.key,
		className: "dsh-pet-mp__status",
		children: t("modelNone")
	});
	const checked = row.kind === "follow" ? view.value.provider === "" : view.value.provider === row.provider && view.value.model === row.model.id;
	return h("button", {
		key: row.key,
		type: "button",
		role: "menuitemradio",
		"aria-checked": checked,
		"data-row": index,
		className: "dsh-pet-mp__item" + (index === view.active ? " is-active" : ""),
		disabled: view.disabled,
		onClick: () => view.onPick(row),
		onMouseMove: () => view.onHover(index),
		children: [h("span", {
			key: "n",
			className: "dsh-pet-mp__name",
			children: row.kind === "follow" ? t("modelFollow") : row.model.name
		}), h("span", {
			key: "c",
			className: "dsh-pet-mp__check",
			children: checked ? "✓" : ""
		})]
	});
}

//#endregion
//#region src/client/settings/picker/model-picker.ts
function makeModelPicker(rt) {
	const { h, useState, useEffect, useRef, t } = rt;
	return function ModelPicker(props) {
		const [open, setOpen] = useState(false);
		const [query, setQuery] = useState("");
		const [active, setActive] = useState(0);
		const [pos, setPos] = useState(null);
		const rootRef = useRef(null);
		const panelRef = useRef(null);
		const groups = props.catalog ?? [];
		const group = groups.find((g) => g.id === props.value.provider);
		const picked = group?.models.find((m) => m.id === props.value.model);
		const isFollow = props.value.provider === "";
		const triggerLabel = isFollow ? t("modelFollow") : picked?.name ?? props.value.model;
		const triggerSub = isFollow ? "" : group?.name ?? props.value.provider + t("modelUnknown");
		const rows = buildModelRows(groups, query);
		const selectable = selectableIndexes(rows);
		const commit = (value) => {
			props.onChange(value);
			setOpen(false);
			setQuery("");
		};
		const pick$1 = (row) => {
			if (!row) return;
			if (row.kind === "follow") commit({
				provider: "",
				model: ""
			});
			else if (row.kind === "model") commit({
				provider: row.provider,
				model: row.model.id
			});
		};
		const step = (dir) => {
			if (selectable.length === 0) return;
			const at = selectable.indexOf(active);
			const next = selectable[at < 0 ? 0 : (at + dir + selectable.length) % selectable.length];
			setActive(next);
			panelRef.current?.querySelector("[data-row=\"" + next + "\"]")?.scrollIntoView({ block: "nearest" });
		};
		useEffect(() => {
			if (!open) return;
			const el = rootRef.current;
			const place = () => {
				if (!el) return;
				setPos(computePanelPlacement(el.getBoundingClientRect(), {
					width: window.innerWidth,
					height: window.innerHeight
				}));
			};
			place();
			panelRef.current?.querySelector("input")?.focus();
			const onDown = (e) => {
				const target = e.target;
				if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) return;
				setOpen(false);
			};
			const onKey = (e) => {
				if (e.key === "Escape") setOpen(false);
			};
			document.addEventListener("mousedown", onDown, true);
			document.addEventListener("keydown", onKey, true);
			window.addEventListener("scroll", place, true);
			window.addEventListener("resize", place);
			return () => {
				document.removeEventListener("mousedown", onDown, true);
				document.removeEventListener("keydown", onKey, true);
				window.removeEventListener("scroll", place, true);
				window.removeEventListener("resize", place);
			};
		}, [open]);
		const toggle = () => {
			if (props.disabled) return;
			if (!open) {
				setQuery("");
				const at = rows.findIndex((r) => r.kind === "model" && r.provider === props.value.provider && r.model.id === props.value.model);
				setActive(at >= 0 ? at : 0);
			}
			setOpen(!open);
		};
		const panel = open && pos ? buildModelPanel({
			h,
			t,
			label: props.label,
			disabled: props.disabled,
			catalog: props.catalog,
			failed: props.failed,
			rows,
			active,
			query,
			value: props.value,
			pos,
			panelRef,
			onQueryChange: (value) => {
				setQuery(value);
				setActive(selectable.length > 0 ? selectable[0] : 0);
			},
			onPick: pick$1,
			onHover: setActive,
			onKeyDown: (event) => {
				if (event.key === "ArrowDown") {
					event.preventDefault();
					step(1);
				} else if (event.key === "ArrowUp") {
					event.preventDefault();
					step(-1);
				} else if (event.key === "Enter") {
					event.preventDefault();
					pick$1(rows[active]);
				}
			}
		}) : null;
		return h("div", {
			ref: rootRef,
			className: "dsh-pet-mp",
			children: [h("button", {
				key: "trigger",
				type: "button",
				className: "dsh-pet-mp__trigger",
				disabled: props.disabled,
				"aria-haspopup": "menu",
				"aria-expanded": open,
				"aria-label": t("modelTriggerAria").replace("{model}", triggerLabel),
				onClick: toggle,
				children: [
					h("span", {
						key: "l",
						className: "dsh-pet-mp__label",
						children: triggerLabel
					}),
					triggerSub ? h("span", {
						key: "s",
						className: "dsh-pet-mp__sub",
						children: triggerSub
					}) : null,
					h("span", {
						key: "c",
						className: "dsh-pet-mp__chevron" + (open ? " is-open" : ""),
						children: "▾"
					})
				]
			}), panel]
		});
	};
}

//#endregion
//#region src/client/settings/picker/voice-picker.ts
function makeVoicePicker(rt) {
	const { h } = rt;
	const Select = makeSelect(rt);
	return function VoicePicker(props) {
		return h(Select, {
			label: props.label,
			value: props.value,
			options: props.options.map((option) => ({
				id: option.id,
				label: option.tag ? `${option.name}（${option.tag}）` : option.name
			})),
			disabled: props.disabled,
			onChange: props.onChange
		});
	};
}

//#endregion
//#region src/client/settings/notify-test.ts
async function runNotificationTest(deps) {
	const { t, report } = deps;
	report({
		kind: "",
		text: ""
	});
	const result = await requestNotificationPermission();
	if (!result.ok) {
		const reason = result.reason === "unsupported" ? t("notifyDenyUnsupported") : result.reason === "denied" ? t("notifyDenyBlocked") : result.reason === "rejected" ? t("notifyDenyRejected") : t("notifyDenyError") + (result.message ? "：" + result.message : "");
		report({
			kind: "err",
			text: reason + (result.reason === "unsupported" ? "" : " " + t("notifyGuide"))
		});
		return;
	}
	try {
		wireNotificationClick(new Notification("测试通知", {
			body: "【dsh-pet】系统通知已就绪。",
			icon: NOTIFY_ICONS.test
		}));
	} catch {}
	report({
		kind: "ok",
		text: t("notifyTestOk")
	});
}

//#endregion
//#region src/client/settings/kind-tabs.ts
function makeKindTabs(rt) {
	const { h, t } = rt;
	return function KindTabs(props) {
		return h("div", {
			className: "dsh-pet-cfg__kinds",
			children: [h("span", {
				key: "label",
				className: "dsh-pet-cfg__tabsLabel",
				children: t("kindLabel")
			}), ...props.kinds.map((item) => h("button", {
				key: item.entry,
				type: "button",
				disabled: props.busy,
				onClick: () => props.onSelect(item.entry),
				className: "dsh-pet-cfg__tab" + (item.entry === props.kind ? " is-active" : ""),
				children: (item.kind === "main" ? t("kindMain") : item.entry) + " (" + item.count + ")"
			}))]
		});
	};
}

//#endregion
//#region src/client/settings/paths-cards.ts
/** 折叠正文的 id：与按钮的 `aria-controls` 成对，两张卡各一份。 */
const BODY_ID$1 = {
	meta: "pet-cfg-paths-meta",
	storage: "pet-cfg-paths-storage"
};
function makePathsCards(rt) {
	const { h, t, useState } = rt;
	const { foldCard, q } = makeUiKit({
		h,
		t
	});
	function ConfigMetaCard(props) {
		const { paths } = props;
		const [open, setOpen] = useState(false);
		const line = (key, value, suffix = "") => value === void 0 ? null : h("div", {
			key,
			className: "dsh-pet-cfg__path",
			children: t(key) + "：" + value + suffix
		});
		const body = [
			line("defaultConfig", paths.default),
			line("userConfig", paths.user),
			line("todosFile", paths.todos),
			line("animationDir", paths.animations),
			line("memesDir", paths.memes),
			line("logFile", paths.logs),
			paths.logs ? h("div", {
				key: "logNote",
				className: "dsh-pet-cfg__note",
				children: t("logFileNote")
			}) : null
		];
		return foldCard({
			id: BODY_ID$1.meta,
			title: t("configMeta"),
			hint: t("configMetaHint"),
			body,
			open,
			onToggle: () => setOpen(!open)
		});
	}
	function StorageCard(props) {
		const { paths } = props;
		const home = paths.home;
		const [open, setOpen] = useState(false);
		const [draft, setDraft] = useState(home?.dir ?? "");
		const [busy, setBusy] = useState(false);
		const [msg, setMsg] = useState("");
		const storage = paths.storage ?? [];
		if (storage.length === 0) return null;
		const locked = home?.source === "env";
		const submit = async (value) => {
			setBusy(true);
			setMsg("");
			const ok = await postAction(ROUTE_PATH + "/home", { dir: value });
			setBusy(false);
			setMsg(ok ? t("homeSaved") : t("homeFailed"));
			if (ok) setDraft(value ?? home?.defaultDir ?? "");
		};
		const body = [
			home ? h("div", {
				key: "home",
				className: "dsh-pet-cfg__field",
				children: [
					h("div", {
						key: "h",
						className: "dsh-pet-cfg__cardTitle",
						children: [t("homeLabel"), q(t("homeHint"))]
					}),
					h("div", {
						key: "r",
						style: {
							display: "flex",
							gap: "6px",
							alignItems: "center"
						},
						children: [
							h("input", {
								key: "i",
								className: "dsh-pet-cfg__inp",
								value: draft,
								disabled: locked || busy,
								placeholder: home.defaultDir,
								onChange: (e) => setDraft(e.target.value)
							}),
							h("button", {
								key: "a",
								type: "button",
								className: "dsh-pet-cfg__btn is-primary",
								disabled: locked || busy,
								onClick: () => void submit(draft.trim()),
								children: t("homeApply")
							}),
							h("button", {
								key: "d",
								type: "button",
								className: "dsh-pet-cfg__btn",
								disabled: locked || busy,
								onClick: () => void submit(null),
								children: t("homeReset")
							})
						]
					}),
					locked ? h("div", {
						key: "l",
						className: "dsh-pet-cfg__note",
						children: t("homeEnvLocked")
					}) : null,
					msg ? h("div", {
						key: "m",
						className: "dsh-pet-cfg__msg",
						children: msg
					}) : null
				]
			}) : null,
			...storage.map((entry) => h("div", {
				key: entry.key,
				className: "dsh-pet-cfg__path",
				children: [h("b", {
					key: "p",
					style: { fontFamily: MONO_STACK },
					children: entry.path
				}), h("span", {
					key: "d",
					children: " — " + t("storage." + entry.key) + (entry.exists === false ? t("storageMissing") : "")
				})]
			})),
			h("div", {
				key: "ut",
				className: "dsh-pet-cfg__cardTitle",
				style: { marginTop: "4px" },
				children: t("uninstallTitle")
			}),
			h("div", {
				key: "u1",
				className: "dsh-pet-cfg__note",
				children: t("uninstallStep1")
			}),
			h("div", {
				key: "u2",
				className: "dsh-pet-cfg__note",
				children: t("uninstallStep2")
			}),
			h("div", {
				key: "cmd",
				className: "dsh-pet-cfg__cmd",
				children: t("uninstallCmd").replace("{profile}", paths.profile || "<profile>")
			}),
			h("div", {
				key: "u3",
				className: "dsh-pet-cfg__note",
				children: t("uninstallStep3")
			})
		];
		return foldCard({
			id: BODY_ID$1.storage,
			title: t("storageTitle"),
			hint: t("storageHint"),
			body,
			open,
			onToggle: () => setOpen(!open)
		});
	}
	return {
		ConfigMetaCard,
		StorageCard
	};
}

//#endregion
//#region src/shared/config.ts
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];
const isWebVisible = (display) => display === "web" || display === "both";
function flattenConfigPets(merged) {
	const out = [];
	for (const [entry, conf] of Object.entries(merged)) {
		const list = Array.isArray(conf?.pets) ? conf.pets : [];
		for (const p of list) out.push({
			...p,
			animations: conf.animations,
			animationWeights: conf.animationWeights,
			eventsRefreshSec: conf.eventsRefreshSec,
			physics: conf.physics,
			font: conf.font,
			confineToScreen: conf.confineToScreen,
			workStatusTexts: conf.workStatusTexts,
			sleepStartTexts: conf.sleepStartTexts,
			sleepEndTexts: conf.sleepEndTexts,
			sleepRefuseTexts: conf.sleepRefuseTexts,
			patShyTexts: conf.patShyTexts,
			patAnnoyedTexts: conf.patAnnoyedTexts,
			patAngryTexts: conf.patAngryTexts,
			patBackTexts: conf.patBackTexts,
			patBusyTexts: conf.patBusyTexts,
			whisperModel: conf.whisperModel,
			chatModel: conf.chatModel,
			memes: conf.memes,
			chatImageEnabled: conf.chatImageEnabled,
			chatAnimationEnabled: conf.chatAnimationEnabled,
			chatImageLimit: conf.chatImageLimit,
			menuOrder: conf.menuOrder,
			menuHidden: conf.menuHidden,
			assetRoot: entry,
			extra: entry !== "main"
		});
	}
	return out;
}

//#endregion
//#region src/client/settings/pet-card-parts.ts
/** 四个角落的固定顺序；文案走 `corner.<corner>`。 */
const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
function makePetAvatarCell(rt) {
	const { h, t } = rt;
	const { tip } = makeUiKit({
		h,
		t
	});
	/** 头像图：两条分支共用同一份属性。 */
	const image = (src) => h("img", {
		className: "dsh-pet-cfg__avatarImg",
		src,
		alt: t("avatarLabel"),
		loading: "lazy"
	});
	return function PetAvatarCell(props) {
		if (props.onAvatar === void 0) return h("div", {
			className: "dsh-pet-cfg__avatarCol",
			children: image(props.avatarSrc)
		});
		return h("div", {
			className: "dsh-pet-cfg__avatarCol",
			children: h("div", {
				className: "dsh-pet-cfg__avatarPick",
				...tip(t("avatarHint")),
				children: [
					image(props.avatarSrc),
					h("span", {
						key: "mask",
						className: "dsh-pet-cfg__avatarMask" + (props.avatarBusy ? " is-busy" : ""),
						children: props.avatarBusy ? t("avatarUploading") : t("avatarChange")
					}),
					h("input", {
						key: "file",
						className: "dsh-pet-cfg__file",
						type: "file",
						accept: "image/png,image/jpeg,image/webp,image/gif",
						disabled: props.avatarBusy || props.busy,
						"aria-label": t("avatarUpload"),
						onChange: (e) => {
							const file = e.target.files?.[0];
							if (file !== void 0) props.onAvatar?.(file);
							e.target.value = "";
						}
					})
				]
			})
		});
	};
}
function makePetIdentityFields(rt) {
	const { h, t } = rt;
	const { field, slider } = makeUiKit({
		h,
		t
	});
	const Select = makeSelect(rt);
	/** 尺寸：滑条从 120 到 1024，一格 10px——肉眼分得出差别的量级。 */
	const SIZE_MIN = 120;
	const SIZE_MAX = 1024;
	const SIZE_STEP = 10;
	/** 宠物大小：拖到想要的观感即可；历史配置超出范围时夹回区间显示。 */
	const sizeSlider = (value, disabled, setter) => slider({
		value: Math.min(Math.max(value, SIZE_MIN), SIZE_MAX),
		min: SIZE_MIN,
		max: SIZE_MAX,
		step: SIZE_STEP,
		disabled,
		onCommit: setter
	});
	/** 屏幕宽度百分比：默认 20；100 即「整屏宽」，再大没有意义。 */
	const percentSlider = (value, disabled, setter) => slider({
		value: Math.min(Math.max(value, SIZE_PERCENT_MIN), 100),
		min: SIZE_PERCENT_MIN,
		max: 100,
		step: 1,
		disabled,
		onCommit: setter
	});
	/** 四格各自成函数：都只读 props，拼在一起才是组件。 */
	const cells = (props) => {
		const { pet, busy, onChange } = props;
		return [
			field(t("nameLabel"), h("input", {
				type: "text",
				className: INPUT_CLASS,
				value: String(pet.name ?? ""),
				disabled: busy,
				maxLength: 50,
				onChange: (e) => onChange({ name: e.target.value })
			}), t("nameHint")),
			field(t("sizeLabel"), sizeSlider(pet.size, busy, (v) => onChange({ size: v })), t("sizeHint")),
			field(t("sizePercentLabel"), percentSlider(pet.sizePercent ?? SIZE_PERCENT_DEFAULT, busy, (v) => onChange({ sizePercent: v })), t("sizePercentHint")),
			field(t("displayLabel"), h(Select, {
				label: t("displayLabel"),
				value: pet.display,
				options: PET_DISPLAYS.map((d) => ({
					id: d,
					label: t("display." + d)
				})),
				disabled: busy,
				onChange: (id) => onChange({ display: id })
			}), t("displayHint"))
		];
	};
	return function PetIdentityFields(props) {
		return h("div", {
			className: "dsh-pet-cfg__grid2",
			children: cells(props)
		});
	};
}
function makePetPositionFields(rt) {
	const { h, t } = rt;
	const { field, slider } = makeUiKit({
		h,
		t
	});
	const Select = makeSelect(rt);
	/** 偏移量：0 表示贴边，600px 基本能到屏幕另一侧的一半；一格 1px。 */
	const marginInput = (value, disabled, setter) => slider({
		value: Math.min(Math.max(value, 0), 600),
		min: 0,
		max: 600,
		step: 1,
		disabled,
		onCommit: setter
	});
	return function PetPositionFields(props) {
		const { pet, busy, onChange } = props;
		return h("div", {
			className: "dsh-pet-cfg__grid3",
			children: [
				field(t("cornerLabel"), h(Select, {
					label: t("cornerLabel"),
					value: pet.position.corner,
					options: CORNERS.map((c) => ({
						id: c,
						label: t("corner." + c)
					})),
					disabled: busy,
					onChange: (id) => onChange({ position: { corner: id } })
				}), t("cornerHint")),
				field(t("marginX"), marginInput(pet.position.marginX, busy, (v) => onChange({ position: { marginX: v } })), t("marginXHint")),
				field(t("marginY"), marginInput(pet.position.marginY, busy, (v) => onChange({ position: { marginY: v } })), t("marginYHint"))
			]
		});
	};
}

//#endregion
//#region src/client/settings/pet-card.ts
function makePetCard(rt) {
	const { h, t } = rt;
	const { tip, q, field, toggleCell } = makeUiKit({
		h,
		t
	});
	const AvatarCell = makePetAvatarCell(rt);
	const IdentityFields = makePetIdentityFields(rt);
	const PositionFields = makePetPositionFields(rt);
	return function PetCard(props) {
		const { pet, busy, msg } = props;
		if (pet === null) return h("p", {
			className: "dsh-pet-cfg__note",
			children: t("emptyPets")
		});
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [
				h("div", {
					className: "dsh-pet-cfg__cardHead",
					children: [
						h("span", {
							key: "t",
							className: "dsh-pet-cfg__cardTitle",
							children: t("petCardTitle")
						}),
						q(t("petCardHint")),
						h("div", {
							key: "acts",
							style: {
								marginLeft: "auto",
								display: "flex",
								alignItems: "center",
								gap: "6px"
							},
							children: [
								msg.text ? h("span", {
									key: "msg",
									className: "dsh-pet-cfg__msg" + (msg.kind === "err" ? " is-err" : ""),
									children: msg.text
								}) : null,
								h("button", {
									key: "sv",
									type: "button",
									onClick: props.onSave,
									disabled: busy,
									className: "dsh-pet-cfg__btn is-primary is-sm",
									...tip(t("saveHotkey")),
									children: t("save")
								}),
								h("button", {
									key: "rm",
									type: "button",
									onClick: props.onRemove,
									disabled: busy,
									className: "dsh-pet-cfg__btn is-danger is-sm",
									children: t("remove")
								})
							]
						})
					]
				}),
				h("div", {
					className: "dsh-pet-cfg__topRow",
					children: [h(AvatarCell, {
						avatarSrc: props.avatarSrc,
						avatarBusy: props.avatarBusy,
						busy,
						onAvatar: props.onAvatar
					}), h(IdentityFields, {
						pet,
						busy,
						onChange: props.onChange
					})]
				}),
				h(PositionFields, {
					pet,
					busy,
					onChange: props.onChange
				}),
				h("div", {
					className: "dsh-pet-cfg__grid4",
					children: [
						toggleCell("balanceEnabled", !!pet.balanceEnabled, busy, (v) => props.onChange({ balanceEnabled: v })),
						toggleCell("whisperEnabled", !!pet.whisperEnabled, busy, (v) => props.onChange({ whisperEnabled: v })),
						toggleCell("workStatusEnabled", !!pet.workStatusEnabled, busy, (v) => props.onChange({ workStatusEnabled: v })),
						toggleCell("fixedEnabled", !!pet.fixedEnabled, busy, (v) => props.onChange({ fixedEnabled: v }))
					]
				}),
				field(t("personaLabel"), h("div", {
					className: "dsh-pet-cfg__persona",
					children: [h("textarea", {
						className: INPUT_CLASS + " dsh-pet-cfg__area",
						rows: 3,
						value: String(pet.whisperPrompt ?? ""),
						disabled: busy,
						placeholder: props.entryPrompt,
						onChange: (e) => props.onChange({ whisperPrompt: e.target.value })
					}), h("span", {
						className: "dsh-pet-cfg__count",
						children: t("personaCount").replace("{n}", String(String(pet.whisperPrompt ?? "").length))
					})]
				}), t("personaHint"))
			]
		});
	};
}

//#endregion
//#region src/shared/chat/image-pick.ts
const IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
/** 扩展名兜底：拖拽或部分系统来源不给 `file.type`。 */
const IMAGE_EXT = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif"
};
function imageMediaTypeOf(file) {
	const declared = String(file.type || "").toLowerCase();
	if (IMAGE_TYPES.includes(declared)) return declared;
	const ext = String(file.name || "").split(".").pop()?.toLowerCase();
	return ext === void 0 ? void 0 : IMAGE_EXT[ext];
}
function isImageFile(file) {
	return imageMediaTypeOf(file) !== void 0;
}
function dragHasFiles(e) {
	const types = e.dataTransfer?.types;
	if (!types) return false;
	return Array.from(types).includes("Files");
}
function firstImageFile(dataTransfer) {
	const files = dataTransfer?.files;
	if (!files) return void 0;
	for (const file of Array.from(files)) if (isImageFile(file)) return file;
	return void 0;
}
function firstImageFromClipboard(data) {
	if (!data) return void 0;
	const files = data.files;
	if (files) {
		for (const file of Array.from(files)) if (isImageFile(file)) return file;
	}
	const items = data.items;
	if (!items) return void 0;
	for (const item of Array.from(items)) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file && isImageFile(file)) return file;
	}
	return void 0;
}

//#endregion
//#region src/shared/chat/encode.ts
const IMAGE_MAX_BYTES = 640 * 1024;
const IMAGE_MAX_SIDE = 2048;
const IMAGE_QUALITIES = [
	.85,
	.75,
	.65,
	.55
];
/** 预览缩略图的长边（像素）：只用于弹窗里那枚 24×24。 */
const PREVIEW_SIDE = 96;
function attachmentBytes(base64) {
	const pad$1 = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.floor(base64.length * 3 / 4) - pad$1;
}
function targetSize(width, height, maxSide = IMAGE_MAX_SIDE) {
	const scale = Math.min(1, maxSide / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}
function loadImage(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("这个文件读不出来"));
		reader.onload = () => {
			const url = typeof reader.result === "string" ? reader.result : "";
			if (!url) {
				reject(new Error("这个文件读不出来"));
				return;
			}
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error("这个文件解不出图片"));
			img.src = url;
		};
		reader.readAsDataURL(file);
	});
}
function bytesToBase64(bytes) {
	let bin = "";
	const CHUNK = 32768;
	for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	return btoa(bin);
}
/** 把源按目标尺寸画进一张新画布。 */
function drawToCanvas(source, size) {
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	canvas.getContext("2d")?.drawImage(source, 0, 0, size.width, size.height);
	return canvas;
}
/** 缩略图：96px、JPEG 0.72，几 KB 就够 24×24 显示。 */
function previewOf(source, width, height) {
	return drawToCanvas(source, targetSize(width, height, PREVIEW_SIDE)).toDataURL("image/jpeg", .72);
}
function encodeCanvas(canvas) {
	const { width, height } = canvas;
	const previewUrl = previewOf(canvas, width, height);
	const floor = IMAGE_QUALITIES[IMAGE_QUALITIES.length - 1];
	for (const quality of IMAGE_QUALITIES) {
		const dataUrl = canvas.toDataURL("image/jpeg", quality);
		const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
		const bytes = attachmentBytes(base64);
		if (bytes <= IMAGE_MAX_BYTES || quality === floor) return {
			base64,
			mediaType: "image/jpeg",
			bytes,
			width,
			height,
			resized: true,
			previewUrl
		};
	}
	throw new Error("无法压到预算内");
}
async function encodeImageFile(file) {
	const mediaType = imageMediaTypeOf(file);
	if (!mediaType) throw new Error("不是可发送的图片");
	const img = await loadImage(file);
	const width = img.naturalWidth || img.width;
	const height = img.naturalHeight || img.height;
	const raw = new Uint8Array(await file.arrayBuffer());
	if (raw.length <= IMAGE_MAX_BYTES && Math.max(width, height) <= IMAGE_MAX_SIDE) return {
		base64: bytesToBase64(raw),
		mediaType,
		bytes: raw.length,
		width,
		height,
		resized: false,
		previewUrl: previewOf(img, width, height)
	};
	const target = targetSize(width, height);
	return encodeCanvas(drawToCanvas(img, target));
}

//#endregion
//#region src/client/settings/avatar-upload.ts
const AVATAR_MAX_SIDE_PX = 512;
async function encodeAvatarFile(file) {
	const img = await loadImage(file);
	const width = img.naturalWidth || img.width;
	const height = img.naturalHeight || img.height;
	if (Math.max(width, height) <= AVATAR_MAX_SIDE_PX) return {
		base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
		mediaType: file.type || "image/png"
	};
	const scale = AVATAR_MAX_SIDE_PX / Math.max(width, height);
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	const ctx = canvas.getContext("2d");
	if (ctx === null) throw new Error("浏览器不支持缩放这张图");
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	const dataUrl = canvas.toDataURL("image/png");
	return {
		base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
		mediaType: "image/png"
	};
}
async function postAvatar(assetRoot, base64, fetchImpl = fetch) {
	const res = await fetchImpl(ROUTE_PATH + "/pet-avatar?root=" + encodeURIComponent(assetRoot), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ base64 })
	});
	const raw = await res.json().catch(() => null);
	if (!res.ok || raw === null) return {
		ok: false,
		message: "上传失败（HTTP " + res.status + "）"
	};
	if (raw.ok !== true) return {
		ok: false,
		message: typeof raw.message === "string" ? raw.message : "上传失败"
	};
	return { ok: true };
}
async function uploadPetAvatar(assetRoot, file) {
	const { base64 } = await encodeAvatarFile(file);
	return postAvatar(assetRoot, base64);
}

//#endregion
//#region src/client/settings/pet-tabs.ts
function makePetTabs(rt) {
	const { h, t } = rt;
	return function PetTabs(props) {
		return h("div", {
			className: "dsh-pet-cfg__tabs",
			children: [
				h("span", {
					key: "label",
					className: "dsh-pet-cfg__tabsLabel",
					children: t("petsLabel")
				}),
				...props.pets.map((pet) => h("button", {
					key: pet.id,
					type: "button",
					onClick: () => props.onSelect(pet.id),
					className: "dsh-pet-cfg__tab" + (pet.id === props.selId ? " is-active" : ""),
					children: (pet.name || pet.id) + " (" + pet.size + "px" + (pet.sizePercent === void 0 || pet.sizePercent >= 100 ? "" : " / " + pet.sizePercent + "%") + ")"
				})),
				h("button", {
					key: "add",
					type: "button",
					onClick: props.onAdd,
					disabled: props.busy,
					className: "dsh-pet-cfg__tab is-ghost",
					children: "+ " + t("add")
				})
			]
		});
	};
}

//#endregion
//#region src/client/settings/physics-card.ts
/** 滑条的范围：够覆盖手感差异大的两端，又不至于一格滑不到想要的量级。 */
const RANGES = {
	gravity: {
		min: 0,
		max: 4e3,
		step: 50
	},
	restitution: {
		min: 0,
		max: 1,
		step: .01
	},
	groundFriction: {
		min: 0,
		max: 10,
		step: .1
	},
	throwPower: {
		min: .05,
		max: 3,
		step: .05
	}
};
function makePhysicsCard(rt) {
	const { h, t } = rt;
	const { cardHead, field, toggleCell, slider } = makeUiKit({
		h,
		t
	});
	return function PhysicsCard(props) {
		const { busy, physics } = props;
		/** 物理参数的一格：标签与问号在上、滑条在下；历史配置可能超出范围，显示时夹回区间。 */
		const physField = (key) => {
			const range = RANGES[key];
			const value = Math.min(Math.max(physics[key], range.min), range.max);
			return field(t("physics." + key), slider({
				...range,
				value,
				disabled: busy,
				onCommit: (v) => props.onChange({ [key]: v })
			}), t("physics." + key + "Hint"));
		};
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [
				cardHead(t("physicsTitle"), t("physicsHint")),
				h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [
						physField("gravity"),
						physField("restitution"),
						physField("groundFriction"),
						physField("throwPower")
					]
				}),
				h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [toggleCell("physicsCeilingBounce", physics.ceilingBounce, busy, (v) => props.onChange({ ceilingBounce: v })), toggleCell("physicsPetCollision", physics.petCollision, busy, (v) => props.onChange({ petCollision: v }))]
				})
			]
		});
	};
}

//#endregion
//#region src/shared/chat/hear-hold.ts
/** 目标键的小写形式：判定与状态机共用这一份，避免两处各写一个字面量。 */
const HEAR_KEY = "m";
const HEAR_HOTKEY_HINT = "M 键";
function isHearHotkey(e) {
	return isBareKey(e, HEAR_KEY);
}
function createHearHold(hooks) {
	let holding = false;
	/** 只比键名：按住期间焦点已交给输入框，不能再套「不在可编辑元素里」那道判据。 */
	const sameKey = (key) => String(key).toLowerCase() === HEAR_KEY;
	const release = () => {
		if (!holding) return;
		holding = false;
		hooks.onRelease();
	};
	return {
		onKeyDown(e) {
			if (holding) return sameKey(e.key);
			if (e.repeat === true || !isHearHotkey(e) || !hooks.isArmed()) return false;
			holding = true;
			hooks.onPress();
			return true;
		},
		onKeyUp(e) {
			if (sameKey(e.key)) release();
		},
		release
	};
}

//#endregion
//#region src/shared/chat/hotkey.ts
const CHAT_HOTKEY_HINT = "L 键";
const CAPTURE_HOTKEY_HINT = "S 键";
function isChatHotkey(e) {
	return isBareKey(e, "l");
}
function isCaptureHotkey(e) {
	return isBareKey(e, "s");
}

//#endregion
//#region src/shared/sleep-hotkey.ts
const SLEEP_HOTKEY_HINT = "Z 键";
function isSleepHotkey(e) {
	return isBareKey(e, "z");
}

//#endregion
//#region src/shared/todo/hotkey.ts
const TODO_HOTKEY_HINT = "D 键";
function isTodoHotkey(e) {
	return isBareKey(e, "d");
}

//#endregion
//#region src/client/app-shortcut.ts
/** 修饰键的显示名：`primary` 按平台展开。 */
const MODIFIER_LABELS = {
	alt: "Alt",
	control: "Ctrl",
	meta: "Cmd",
	shift: "Shift"
};
function keycapOf(binding) {
	const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
	const modifiers = binding.modifiers.map((modifier) => modifier === "primary" ? isMac ? "Cmd" : "Ctrl" : MODIFIER_LABELS[modifier] ?? modifier);
	return [...modifiers, binding.code.replace(/^Key/, "")].join("+");
}
const SHORTCUT_PROFILES = [
	"desktop:macos",
	"desktop:windows",
	"desktop:linux",
	"web:macos",
	"web:windows"
];
function registerAppShortcut(ctx, shortcut) {
	const shortcuts = ctx.get?.("shortcuts");
	if (shortcuts === void 0 || typeof shortcuts.register !== "function") {
		console.warn("[dsh-pet] 快捷键服务不可用，「" + shortcut.id + "」未注册");
		return {
			registered: false,
			dispose: () => {}
		};
	}
	try {
		const defaults = Object.fromEntries(SHORTCUT_PROFILES.map((profile) => [profile, shortcut.binding]));
		const dispose = shortcuts.register({
			id: shortcut.id,
			label: shortcut.label,
			aliases: [],
			defaults,
			regions: ["page", "editable"],
			modals: [],
			resolve: () => ({
				status: "handled",
				run: shortcut.run
			})
		});
		return {
			registered: true,
			dispose: () => dispose()
		};
	} catch (error) {
		console.warn("[dsh-pet] 快捷键注册失败：" + (error instanceof Error ? error.message : String(error)));
		return {
			registered: false,
			dispose: () => {}
		};
	}
}
function readShortcutKeycap(ctx, id) {
	const catalog = (ctx.get?.("shortcuts"))?.catalog;
	if (catalog === void 0) return void 0;
	const row = catalog.getSnapshot().find((item) => item.id === id);
	return row === void 0 || row.keys.length === 0 ? void 0 : row.keys.join("");
}
function subscribeShortcutKeycaps(ctx, listener) {
	const catalog = (ctx.get?.("shortcuts"))?.catalog;
	if (catalog === void 0) return () => {};
	return catalog.subscribe(listener);
}

//#endregion
//#region src/client/chat/shortcut.ts
const PET_CHAT_COMMAND_ID = "pet-chat.open";
/** 主修饰键 + Shift + P；Web 白名单允许「主键 + Shift/Alt + 字母」，所以两端同一个键。 */
const BINDING = {
	code: "KeyP",
	modifiers: ["primary", "shift"]
};
function petChatShortcutKeycap(ctx) {
	return readShortcutKeycap(ctx, PET_CHAT_COMMAND_ID) ?? keycapOf(BINDING);
}
function registerPetChatShortcut(ctx, label, open) {
	return registerAppShortcut(ctx, {
		id: PET_CHAT_COMMAND_ID,
		label,
		binding: BINDING,
		run: open
	});
}

//#endregion
//#region src/client/pet/card/registry.ts
/** 按宠物 id 登记；Map 的插入序就是渲染序，「第一只」的兜底直接靠它。 */
const handles = new Map();
function registerPetChatHandle(id, handle) {
	handles.set(id, handle);
	return () => {
		if (handles.get(id) === handle) handles.delete(id);
	};
}
function pickPetChatHandle() {
	const mainId = petBridge.template?.id;
	if (typeof mainId === "string") {
		const main = handles.get(mainId);
		if (main !== void 0) return main;
	}
	return handles.values().next().value;
}
function togglePetChatHear(handle) {
	if (handle === void 0) return;
	if (handle.isHearing()) handle.stopHear();
	else handle.startHear();
}
function togglePetChat(handle) {
	if (handle === void 0) return;
	if (handle.isOpen()) handle.close();
	else handle.open();
}

//#endregion
//#region src/client/pet/card/shortcut.ts
const PET_FLOAT_COMMAND_ID = "pet-chat.float";
const PET_HEAR_COMMAND_ID = "pet-chat.hear";
const PET_CAPTURE_COMMAND_ID = "pet-chat.capture";
/** 弹窗键位：主修饰键 + Shift + L。T 在浏览器里被「恢复标签页」占用，L 两端都空着。 */
const FLOAT_BINDING = {
	code: "KeyL",
	modifiers: ["primary", "shift"]
};
/** 录音键位：主修饰键 + Shift + M（M = mic）。V 在输入框里会被浏览器当成「粘贴为纯文本」，避开。 */
const HEAR_BINDING = {
	code: "KeyM",
	modifiers: ["primary", "shift"]
};
/** 截图键位：主修饰键 + Shift + S。Edge 与 Firefox 把它给了自己的截图，Chrome 空着。 */
const CAPTURE_BINDING = {
	code: "KeyS",
	modifiers: ["primary", "shift"]
};
/** 命令 id 与默认键位：注册与展示都从这里取，不写第二份。 */
const COMMANDS = {
	chat: {
		id: PET_FLOAT_COMMAND_ID,
		binding: FLOAT_BINDING
	},
	hear: {
		id: PET_HEAR_COMMAND_ID,
		binding: HEAR_BINDING
	},
	capture: {
		id: PET_CAPTURE_COMMAND_ID,
		binding: CAPTURE_BINDING
	}
};
function petShortcutKeycap(ctx, key) {
	const command = COMMANDS[key];
	return readShortcutKeycap(ctx, command.id) ?? keycapOf(command.binding);
}
function registerPetCardShortcuts(ctx, label) {
	const float = registerAppShortcut(ctx, {
		id: COMMANDS.chat.id,
		label: () => label("shortcut.chat"),
		binding: COMMANDS.chat.binding,
		run: () => togglePetChat(pickPetChatHandle())
	});
	const hear = registerAppShortcut(ctx, {
		id: COMMANDS.hear.id,
		label: () => label("shortcut.hear"),
		binding: COMMANDS.hear.binding,
		run: () => togglePetChatHear(pickPetChatHandle())
	});
	const capture = registerAppShortcut(ctx, {
		id: COMMANDS.capture.id,
		label: () => label("shortcut.capture"),
		binding: COMMANDS.capture.binding,
		run: () => pickPetChatHandle()?.screenshot()
	});
	return { dispose: () => {
		float.dispose();
		hear.dispose();
		capture.dispose();
	} };
}

//#endregion
//#region src/client/settings/shortcuts-card.ts
/** 折叠正文的 id：与标题按钮的 `aria-controls` 成对。 */
const BODY_ID = "pet-cfg-shortcuts";
/** 粘贴不是我们注册的命令，键帽按平台推导（macOS 是 ⌘V），不写死字符串。 */
const PASTE_KEYCAP = keycapOf({
	code: "KeyV",
	modifiers: ["primary"]
});
/** 现读一遍三条全局命令的键帽。 */
function readKeycaps(ctx) {
	return {
		open: petShortcutKeycap(ctx, "chat"),
		hear: petShortcutKeycap(ctx, "hear"),
		capture: petShortcutKeycap(ctx, "capture"),
		sidebar: petChatShortcutKeycap(ctx)
	};
}
function makeShortcutsCard(rt, ctx) {
	const { h, t, useState, useEffect } = rt;
	const { foldCard } = makeUiKit({
		h,
		t
	});
	return function ShortcutsCard() {
		const [open, setOpen] = useState(false);
		const [keycaps, setKeycaps] = useState(readKeycaps(ctx));
		useEffect(() => subscribeShortcutKeycaps(ctx, () => setKeycaps(readKeycaps(ctx))), []);
		/** 一行：左边动作名，右边键帽。 */
		const row = (label, keys) => h("div", {
			className: "dsh-pet-cfg__field",
			children: [h("span", {
				key: "l",
				className: "dsh-pet-cfg__flabel",
				children: t(label)
			}), h("span", {
				key: "v",
				className: "dsh-pet-cfg__note",
				children: keys
			})]
		});
		return foldCard({
			id: BODY_ID,
			title: t("shortcutCardTitle"),
			hint: t("shortcutCardHint"),
			body: [
				h("p", {
					key: "petTitle",
					className: "dsh-pet-cfg__cardTitle",
					children: t("shortcutGroupPet")
				}),
				h("p", {
					key: "petHint",
					className: "dsh-pet-cfg__note",
					children: t("shortcutGroupPetHint")
				}),
				h("div", {
					key: "petRows",
					className: "dsh-pet-cfg__grid2",
					children: [
						row("shortcutRowChat", CHAT_HOTKEY_HINT),
						row("shortcutRowHold", HEAR_HOTKEY_HINT),
						row("shortcutRowCapture", CAPTURE_HOTKEY_HINT),
						row("shortcutRowPaste", PASTE_KEYCAP),
						row("shortcutRowTodo", TODO_HOTKEY_HINT),
						row("shortcutRowSleep", SLEEP_HOTKEY_HINT),
						row("shortcutRowDisplay", DISPLAY_HOTKEY_HINTS.join(" · "))
					]
				}),
				h("p", {
					key: "globalTitle",
					className: "dsh-pet-cfg__cardTitle",
					children: t("shortcutGroupGlobal")
				}),
				h("p", {
					key: "globalHint",
					className: "dsh-pet-cfg__note",
					children: t("shortcutGroupGlobalHint")
				}),
				h("div", {
					key: "globalRows",
					className: "dsh-pet-cfg__grid2",
					children: [
						row("shortcutRowChat", keycaps.open),
						row("shortcutRowHear", keycaps.hear),
						row("shortcutRowCapture", keycaps.capture),
						row("shortcutRowSidebar", keycaps.sidebar)
					]
				})
			],
			open,
			onToggle: () => setOpen(!open)
		});
	};
}

//#endregion
//#region src/client/settings/tip-layer.ts
/** 气泡 class，外观在 ./css。 */
const TIP_CLASS$1 = "pet-cfg-tip";
/** 触发元素的属性名：选择器与取值都从它派生，改名只改一处。 */
const TIP_ATTR = "data-tip";
/** 光标与气泡的间隙（px）。 */
const TIP_GAP_PX$1 = 10;
/** 唯一的那个气泡；悬停很频繁，反复建删会让气泡闪。 */
let bubble;
/** 当前挂着气泡的触发元素，用于跳过「在同一元素内移动」的重复派发。 */
let current;
/** 这一层的解除函数；`undefined` 表示没装。 */
let detach;
/** 收起气泡：元素留着复用，只摘显隐。 */
function hideTip$1() {
	bubble?.classList.remove("is-on");
	current = void 0;
}
/** 取气泡元素，没有就建一个挂到 body——挂在设置页里会被滚动容器裁掉。 */
function ensureTip$1() {
	if (bubble !== void 0 && bubble.parentNode === document.body) return bubble;
	const el = document.createElement("div");
	el.setAttribute("class", TIP_CLASS$1);
	el.setAttribute("role", "tooltip");
	document.body.appendChild(el);
	bubble = el;
	return el;
}
/** 从事件目标往上找触发元素；不在说明元素上时返回 `undefined`。 */
function triggerOf(node) {
	const host = node;
	if (host === null || typeof host.closest !== "function") return void 0;
	return host.closest("[" + TIP_ATTR + "]") ?? void 0;
}
/**
* 在光标处显示说明。
*
* @param text - 气泡正文。
* @param cursor - 光标位置（视口坐标）。
*/
function showTip$1(text, cursor) {
	const el = ensureTip$1();
	el.textContent = text;
	el.style.left = "0px";
	el.style.top = "0px";
	const placed = tooltipPlacement(cursor, {
		w: el.offsetWidth,
		h: el.offsetHeight
	}, {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	}, TIP_GAP_PX$1);
	el.style.left = placed.x + "px";
	el.style.top = placed.y + "px";
	el.classList.add("is-on");
}
/** 光标进入触发元素：换一条说明就重摆，同一元素内移动不动。 */
function onOver(event) {
	const trigger = triggerOf(event.target);
	if (trigger === void 0 || trigger === current) return;
	const text = trigger.getAttribute(TIP_ATTR);
	if (text === null || text === "") return;
	showTip$1(text, {
		x: event.clientX,
		y: event.clientY
	});
	current = trigger;
}
/** 光标离开：移进触发元素自己的子节点也会派发 pointerout，只有真离开才收。 */
function onOut(event) {
	const from = triggerOf(event.target);
	if (from === void 0) return;
	if (triggerOf(event.relatedTarget ?? null) === from) return;
	hideTip$1();
}
function attachTipLayer() {
	if (detach !== void 0) return detach;
	const root = document;
	root.addEventListener("pointerover", onOver);
	root.addEventListener("pointerout", onOut);
	root.addEventListener("pointerdown", hideTip$1);
	root.addEventListener("scroll", hideTip$1, true);
	detach = () => {
		root.removeEventListener("pointerover", onOver);
		root.removeEventListener("pointerout", onOut);
		root.removeEventListener("pointerdown", hideTip$1);
		root.removeEventListener("scroll", hideTip$1, true);
		bubble?.remove();
		bubble = void 0;
		current = void 0;
		detach = void 0;
	};
	return detach;
}

//#endregion
//#region src/client/settings/pet-draft.ts
function nextPetId(list, kind = "main") {
	const prefix = kind === "main" ? "pet" : kind;
	for (let n = 2;; n += 1) {
		const id = prefix + "-" + n;
		if (!list.some((pet) => pet.id === id)) return id;
	}
}
function draftPet(template, id) {
	return {
		id,
		name: id,
		size: template.size,
		sizePercent: template.sizePercent ?? SIZE_PERCENT_DEFAULT,
		balanceEnabled: template.balanceEnabled,
		whisperEnabled: template.whisperEnabled,
		workStatusEnabled: template.workStatusEnabled,
		fixedEnabled: template.fixedEnabled,
		display: template.display,
		position: { ...template.position }
	};
}

//#endregion
//#region src/client/settings/use-pet-list.ts
function petKinds(pets) {
	const order = [];
	const counts = new Map();
	for (const pet of pets) {
		const entry = pet.assetRoot ?? "main";
		if (!counts.has(entry)) order.push(entry);
		counts.set(entry, (counts.get(entry) ?? 0) + 1);
	}
	return order.map((entry) => ({
		entry,
		kind: entry === "main" ? "main" : "pack",
		count: counts.get(entry) ?? 0
	}));
}
function mainPetsOf(pets) {
	return pets.filter((pet) => (pet.assetRoot ?? "main") === "main");
}
function usePetList(rt, requestDialog) {
	const { useState, useCallback, useRef } = rt;
	const initial = petBridge.current;
	const [pets, setPets] = useState(initial.map((pet) => ({
		...pet,
		position: { ...pet.position }
	})));
	const [kind, setKind] = useState(initial[0]?.assetRoot ?? "main");
	const [selId, setSelId] = useState(initial[0]?.id ?? "");
	const loadedRef = useRef([]);
	const kindRef = useRef(kind);
	kindRef.current = kind;
	const update = (patch) => setPets((list) => list.map((pet) => {
		if (pet.id !== selId) return pet;
		const { position: posPatch,...rest } = patch;
		return {
			...pet,
			...rest,
			position: posPatch ? {
				...pet.position,
				...posPatch
			} : pet.position
		};
	}));
	const add = () => {
		const group = pets.filter((pet) => (pet.assetRoot ?? "main") === kind);
		const template = group[0];
		if (!template) return;
		const id = nextPetId(pets, kind);
		const draft = {
			...draftPet(template, id),
			assetRoot: kind
		};
		setPets((list) => {
			const next = [...list];
			let at = -1;
			for (let i = 0; i < next.length; i += 1) if ((next[i].assetRoot ?? "main") === kind) at = i;
			next.splice(at + 1, 0, draft);
			return next;
		});
		setSelId(id);
	};
	const remove = () => {
		const list = pets.filter((pet) => pet.id !== selId);
		setPets(list);
		setSelId(list[0]?.id ?? "");
	};
	const replace = useCallback((entries) => {
		loadedRef.current = entries;
		const loaded = entries.flatMap((entry) => entry.pets);
		const nextKind = entries.some((entry) => entry.key === kindRef.current) ? kindRef.current : entries[0]?.key ?? "main";
		setPets(loaded);
		setKind(nextKind);
		setSelId((id) => {
			if (loaded.some((pet) => pet.id === id)) return id;
			return loaded.find((pet) => (pet.assetRoot ?? "main") === nextKind)?.id ?? "";
		});
	}, []);
	const selectKind = (entry) => {
		setKind(entry);
		const first = pets.find((pet) => (pet.assetRoot ?? "main") === entry);
		if (first) setSelId(first.id);
	};
	const current$1 = pets.find((pet) => pet.id === selId);
	const entryPrompt = loadedRef.current.find((item) => item.key === kind)?.entryPrompt ?? "";
	const requestRemove = () => {
		if (!current$1) return;
		const entry = current$1.assetRoot ?? "main";
		const groupSize = pets.filter((pet) => (pet.assetRoot ?? "main") === entry).length;
		if (groupSize <= 1) requestDialog(entry === "main" ? { kind: "lastOne" } : {
			kind: "lastOfKind",
			entry
		});
		else requestDialog({ kind: "remove" });
	};
	return {
		pets,
		mainPets: mainPetsOf(pets),
		kinds: petKinds(pets),
		kind,
		visiblePets: pets.filter((pet) => (pet.assetRoot ?? "main") === kind),
		selId,
		entryPrompt,
		select: setSelId,
		selectKind,
		update,
		add,
		requestRemove,
		remove,
		replace,
		packWrites: () => diffPackWrites(loadedRef.current, pets)
	};
}

//#endregion
//#region src/client/settings/use-remote-data.ts
function useRemoteData(rt) {
	const { useState, useEffect } = rt;
	const [paths, setPaths] = useState(null);
	const [catalog, setCatalog] = useState(null);
	const [catalogFailed, setCatalogFailed] = useState(false);
	useEffect(() => {
		let alive = true;
		loadMeta().then((meta) => {
			if (alive) setPaths(meta);
		});
		return () => {
			alive = false;
		};
	}, []);
	useEffect(() => {
		let alive = true;
		loadModelCatalog().then((groups) => {
			if (!alive) return;
			if (groups === null) setCatalogFailed(true);
			else setCatalog(groups);
		});
		return () => {
			alive = false;
		};
	}, []);
	return {
		paths,
		catalog,
		catalogFailed
	};
}

//#endregion
//#region src/client/settings/voice-card.ts
function makeVoiceCard(rt, picker, preview) {
	const { h, t } = rt;
	const { cardHead, field, toggleCell, slider } = makeUiKit({
		h,
		t
	});
	const Select = makeSelect(rt);
	return function VoiceCard(props) {
		const subDisabled = props.busy || !props.enabled;
		const breeze = props.engine === "breeze";
		const engines = [{
			id: "edge",
			label: t("voiceEngineEdge")
		}, {
			id: "breeze",
			label: t("voiceEngineBreeze")
		}];
		const breezeOptions = [{
			id: "",
			name: t("breezeVoiceAuto"),
			tag: ""
		}, ...props.breezeVoices.map((option) => ({
			id: option.id,
			name: option.name,
			tag: option.tag
		}))];
		const note = props.breezeNote === "bad-key" ? t("breezeBadKey") : props.breezeNote === "list-failed" ? t("breezeListFailed") : props.breezeNote === "ok" ? t("breezeReady") : t("breezeNoKey");
		return h("div", {
			className: "dsh-pet-cfg__card",
			children: [
				cardHead(t("voiceTitle"), t("voiceHint")),
				h("div", {
					className: "dsh-pet-cfg__grid3",
					children: [
						toggleCell("voiceEnabled", props.enabled, props.busy, props.onToggle),
						toggleCell("voiceWhisperEnabled", props.whisperEnabled, subDisabled, props.onWhisperToggle),
						toggleCell("voiceTodoEnabled", props.todoEnabled, subDisabled, props.onTodoToggle)
					]
				}),
				h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [field(t("voiceEngineLabel"), h(Select, {
						label: t("voiceEngineLabel"),
						value: props.engine,
						options: engines,
						disabled: props.busy,
						onChange: (id) => props.onEngineChange(id === "breeze" ? "breeze" : "edge")
					}), t("voiceEngineHint")), field(t("voiceVolumeLabel"), slider({
						value: Math.min(Math.max(props.volume, 0), 1),
						min: 0,
						max: 1,
						step: .05,
						disabled: props.busy,
						onCommit: props.onVolumeChange
					}), t("voiceVolumeHint"))]
				}),
				breeze ? h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [field(t("breezeKeyLabel"), h("input", {
						type: "text",
						className: INPUT_CLASS,
						value: props.breezeKey,
						placeholder: "brz_...",
						spellCheck: false,
						autoComplete: "off",
						disabled: props.busy,
						onChange: (e) => props.onBreezeKeyChange(e.target.value)
					}), t("breezeKeyHint")), field(t("breezeVoiceLabel"), h(picker, {
						label: t("breezeVoiceLabel"),
						value: props.breezeVoice,
						options: breezeOptions,
						disabled: props.busy,
						onChange: props.onBreezeVoiceChange
					}), t("breezeVoiceHint"))]
				}) : field(t("voiceNameLabel"), h(picker, {
					label: t("voiceNameLabel"),
					value: props.voiceName,
					options: props.voices,
					disabled: props.busy,
					onChange: props.onVoiceChange
				})),
				breeze ? h("div", {
					className: "dsh-pet-cfg__grid2",
					children: [field(t("breezeSpeedLabel"), slider({
						value: Math.min(Math.max(props.breezeSpeed, .5), 2),
						min: .5,
						max: 2,
						step: .05,
						disabled: props.busy,
						onCommit: props.onBreezeSpeedChange
					}), t("breezeSpeedHint")), field(t("breezeStatusLabel"), h("div", {
						className: "dsh-pet-cfg__previewRow",
						children: [h("span", {
							className: props.breezeNote === "bad-key" ? "dsh-pet-cfg__note is-bad" : "dsh-pet-cfg__note",
							children: note
						}), h("button", {
							type: "button",
							className: "dsh-pet-cfg__btn is-sm",
							disabled: props.busy,
							onClick: () => props.onBreezeRefresh(),
							children: t("breezeRefresh")
						})]
					}), t("breezeStatusHint"))]
				}) : null,
				h(preview, {
					busy: props.busy,
					voice: props.voiceName,
					volume: props.volume
				})
			]
		});
	};
}

//#endregion
//#region src/client/settings/voice-preview.ts
function makeVoicePreview(rt) {
	const { h, useState, useRef, useEffect, t } = rt;
	return function VoicePreview(props) {
		const { busy, voice, volume } = props;
		const [text, setText] = useState("");
		const [pending, setPending] = useState(false);
		const [error, setError] = useState("");
		const audioRef = useRef(null);
		const urlRef = useRef("");
		useEffect(() => () => {
			audioRef.current?.pause();
			audioRef.current = null;
			if (urlRef.current) URL.revokeObjectURL(urlRef.current);
			urlRef.current = "";
		}, []);
		const play = async () => {
			const say = text.trim() === "" ? t("voicePreviewSample") : text.trim();
			setPending(true);
			setError("");
			try {
				const res = await fetch(ROUTE_PATH + "/voice/speak", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						text: say,
						voice
					})
				});
				if (!res.ok) throw new Error("HTTP " + res.status);
				const type = res.headers.get("content-type") ?? "";
				if (type.includes("application/json")) {
					const body = await res.json();
					throw new Error(body.message ?? String(body.ok === false ? "speak failed" : "unexpected response"));
				}
				const url = URL.createObjectURL(await res.blob());
				audioRef.current?.pause();
				if (urlRef.current) URL.revokeObjectURL(urlRef.current);
				urlRef.current = url;
				const audio = new Audio(url);
				audio.volume = Math.min(Math.max(volume, 0), 1);
				audioRef.current = audio;
				await audio.play();
			} catch (e) {
				setError(t("voicePreviewFailed").replace("{msg}", e instanceof Error ? e.message : String(e)));
			} finally {
				setPending(false);
			}
		};
		const disabled = busy || pending;
		return h("div", {
			className: "dsh-pet-cfg__field",
			children: [
				h("span", {
					key: "l",
					className: "dsh-pet-cfg__flabel",
					children: t("voicePreview")
				}),
				h("div", {
					key: "row",
					className: "dsh-pet-cfg__previewRow",
					children: [h("input", {
						type: "text",
						placeholder: t("voicePreviewSample"),
						value: text,
						disabled,
						maxLength: 500,
						className: INPUT_CLASS,
						onChange: (e) => setText(e.target.value),
						onKeyDown: (e) => {
							if (e.key === "Enter" && !disabled) play();
						}
					}), h("button", {
						key: "b",
						type: "button",
						className: "dsh-pet-cfg__btn is-sm",
						disabled,
						onClick: () => void play(),
						children: pending ? t("voicePreviewBusy") : t("voicePreview")
					})]
				}),
				error === "" ? h("span", {
					key: "h",
					className: "dsh-pet-cfg__note",
					children: t("voicePreviewHint")
				}) : h("span", {
					key: "h",
					className: "dsh-pet-cfg__msg is-err",
					children: error
				})
			]
		});
	};
}

//#endregion
//#region src/client/settings/locales/de.ts
const de = {
	nav: "Desktop-Pet-Konfiguration",
	intro: "Mehrere Pets verwalten: Jedes Pet hat eigene Größe und Position (gilt sofort nach dem Speichern).",
	petCardTitle: "Pet-Konfiguration",
	avatarLabel: "Avatar",
	avatarHint: "Das kleine Bild neben den Nachrichten dieses Pets im Chatfenster. Ohne Upload erscheint das Standard-Logo des Plugins; ein Upload greift sofort und ersetzt das vorherige — „Speichern\" ist nicht nötig.",
	avatarUpload: "Avatar hochladen",
	avatarChange: "Ändern",
	avatarUploading: "Wird hochgeladen…",
	avatarUploaded: "Avatar aktualisiert",
	petCardHint: "Einstellungen pro Pet: Name / Größe / Anzeige / Position / Offsets / die vier Funktionsschalter. Nach dem Ändern unten auf „Speichern\" klicken – gilt sofort.",
	globalTitle: "Globale Schalter",
	globalHint: "Gilt für alle Pets (ein Pet-Pack kann dies in seiner Art-Datei überschreiben). Diese Schalter ändern nur den lokalen Zustand und werden beim „Speichern\" mit in die Benutzerkonfiguration geschrieben (kein sofortiges Schreiben); Systembenachrichtigungen werden nach dem Speichern sofort neu eingelesen, ohne Neuladen der Seite.",
	cornerHint: "An welcher Bildschirmecke das Pet klebt (im Desktop-Modus pro Monitor-Arbeitsbereich).",
	marginXHint: "Horizontaler Abstand zur gewählten Ecke (px), beliebige Zahl.",
	marginYHint: "Vertikaler Abstand zur gewählten Ecke (px), beliebige Zahl.",
	"cmd.chat": "Chat",
	"cmd.pet": "Pet",
	"cmd.balance": "Guthaben",
	"shortcut.open": "Pet-Chat öffnen",
	"shortcut.chat": "Chatfenster öffnen",
	"shortcut.hear": "Spracheingabe",
	"shortcut.capture": "Bildschirmfoto in den Chat",
	shortcutCardTitle: "Tastenkürzel",
	shortcutCardHint: "Aufgeklappt zwei Gruppen: Pet-Tastenkürzel und globale Tastenkürzel.",
	shortcutRowChat: "Chat öffnen",
	shortcutRowHold: "Zum Sprechen halten",
	shortcutRowHear: "Spracheingabe",
	shortcutRowCapture: "Bildschirmfoto",
	shortcutRowPaste: "Bild einfügen",
	shortcutRowTodo: "Aufgaben",
	shortcutRowSleep: "Schlafen / Aufwachen",
	shortcutRowDisplay: "Anzeigeposition",
	shortcutRowSidebar: "Seitenleisten-Chat öffnen",
	shortcutGroupPet: "Pet-Tastenkürzel",
	shortcutGroupPetHint: "Im Web genügt der Zeiger auf dem Pet. Im Desktop-Fenster zuerst auf das Pet klicken, damit es den Tastaturfokus bekommt.",
	shortcutGroupGlobal: "Globale Tastenkürzel",
	shortcutGroupGlobalHint: "Werden von DSH im Web und im Desktop-Fenster verteilt; änderbar unter Einstellungen → Allgemein → Tastenkürzel.",
	petsLabel: "Pet-Liste",
	add: "Pet hinzufügen",
	remove: "Entfernen",
	confirmRemove: "Pet „{id}\" wirklich löschen?",
	confirmTitle: "Aktion bestätigen",
	cancel: "Abbrechen",
	ok: "Verstanden",
	atLeastOne: "Mindestens ein Pet muss erhalten bleiben.",
	emptyPets: "Noch keine Pets – auf „Pet hinzufügen\" klicken, um eines zu erstellen.",
	sizeLabel: "Größe (Breite px)",
	sizeHint: "Höhe automatisch = Breite × 9/16.",
	sizePercentLabel: "Max. Bildschirmbreite (%)",
	sizePercentHint: "Wie viel der Bildschirmbreite der Pet höchstens einnimmt: 100 = nie breiter als ein Bildschirm (bei breiten Fenstern identisch mit px); 30–40 macht ihn auf dem Handy deutlich kleiner, ohne den Desktop zu verändern. Wird beim Laden einmal berechnet; nach Größenänderung neu laden.",
	nameLabel: "Name",
	nameHint: "Anzeigename: erscheint beim Hovern über dem Pet und fließt in die KI-Persona ein („Dein Name ist X\"). Doppelt erlaubt; leer = es gilt die Pet-ID.",
	personaLabel: "Persona (optional)",
	personaHint: "Gilt nur für dieses Pet. Leer lassen = Persona des Eintrags übernehmen – der graue Text im Feld ist genau diese. Das tatsächlich an das Modell gesendete System = dieser Text + automatisch angehängtem Hinweis „Dein Name ist <Name>\" + aktuellem Zeitkontext; Name und Datum hier also nicht wiederholen.",
	personaCount: "{n} Zeichen",
	balanceEnabled: "Guthaben-Funktion",
	balanceEnabledHint: "Wenn aktiv, spielt dieses Pet Guthaben-Animationen und zeigt die Guthaben-Blase.",
	whisperEnabled: "Flüstern",
	whisperEnabledHint: "Wenn aktiv, erzeugt dieses Pet regelmäßig per KI einen Satz und spielt die Flüstern-Animation (Persona siehe Feld „Persona\" unten; leer = Eintrag übernehmen).",
	workStatusEnabled: "Arbeitsstatus-Kopplung",
	workStatusEnabledHint: "Wenn aktiv, folgt dieses Pet dem DSH-Arbeitsstatus: Denken / Arbeiten / Warten auf Bestätigung / Fertig / Fehler wechseln automatisch die passende Animation und zeigen eine Blase (Animationspool in der Top-Level-Konfiguration; nur Zuhören, keine Modellaufrufe).",
	fixedEnabled: "Pet fixieren",
	fixedEnabledHint: "Wenn aktiv, dreht sich das Pet bei Zufallsanimationen nicht mehr selbst um und läuft nicht weg – es spielt nur Leerlauf und kleine Aktionen am Platz. Rechtsklick-Auswahl, API-Auslöser sowie Guthaben-/Flüstern-/Arbeitsstatus-Animationen sind nicht betroffen.",
	displayLabel: "Anzeige",
	displayHint: "web = nur Browser / desktop = nur Desktop / both = beides / none = nichts",
	"display.web": "Nur Browser",
	"display.desktop": "Nur Desktop",
	"display.both": "Beides",
	"display.none": "Nichts",
	cornerLabel: "Position",
	"corner.top-left": "Oben links",
	"corner.top-right": "Oben rechts",
	"corner.bottom-left": "Unten links",
	"corner.bottom-right": "Unten rechts",
	marginX: "Horizontaler Versatz",
	marginY: "Vertikaler Versatz",
	save: "Speichern",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "Synchronisieren",
	confirmSync: "Wirklich synchronisieren? Die mitgelieferte Standardkonfiguration (alle Felder + Kommentare) überschreibt die Benutzerkonfiguration; Ihre aktuellen Anpassungen gehen verloren.",
	corruptTitle: "Benutzerkonfiguration beschädigt – nicht gespeichert",
	corruptConfirm: "Trotzdem speichern",
	corruptBody: "Die Benutzerkonfigurationsdatei ist nicht lesbar (beschädigt, kein gültiges JSON/JSONC): {path}. Beim Weiterspeichern wird die Datei anhand der Whitelist neu aufgebaut – alle aktuellen Inhalte (animations / physics / memes und weitere eigene Felder) gehen verloren. Abbrechen = Datei unverändert lassen (zuerst die Konfiguration reparieren, dann speichern); Bestätigen = trotzdem speichern (vorhandene Inhalte verwerfen).",
	syncHint: "„Synchronisieren\" schreibt die mitgelieferte Standardkonfiguration (inkl. Kommentare und aller erweiterten Felder) in die Benutzerkonfigurationsdatei und überschreibt die aktuellen Anpassungen; danach ist die Datei direkt bearbeitbar. Zwei Hinweise: (1) Sobald die Datei existiert, ist sie eine explizite Override-Schicht – spätere Änderungen an den mitgelieferten Standards greifen nicht automatisch (außer bei erneuter Synchronisierung oder Löschen der Datei); (2) „Speichern\" auf dieser Seite schreibt die Datei anhand der Whitelist neu (Feldwerte bleiben, Kommentare entfallen).",
	configMeta: "Erweitert (Dateien)",
	configMetaHint: "Die Benutzerkonfiguration kann Pet-Liste / Animationspools / Wiedergabegewichtung überschreiben; Änderungen greifen nach Aktualisieren oder Neustart: im Browser die Seite neu laden, im Desktop-Modus Rechtsklick auf das Pet → „Konfiguration neu laden\" (lädt alle Desktop-Pet-Fenster neu); die Standardkonfiguration ist die vollständige Referenz.",
	defaultConfig: "Standardkonfiguration (schreibgeschützt, vollständige Referenz)",
	userConfig: "Benutzerkonfiguration (eigene Überschreibungen)",
	todosFile: "To-do-Daten (Listentext, Fälligkeit und Erledigt-Status; Löschen entspricht alle To-dos leeren)",
	animationDir: "Verzeichnis der Animations-Assets (Animationen anpassen/ergänzen)",
	memesDir: "Verzeichnis der Meme-Bilder (Bilder anpassen/ergänzen)",
	logFile: "Protokolldatei (für die Fehlersuche; kann geleert werden)",
	logFileNote: "Die Desktop-Version hat keine Konsole, daher gehen alle Laufzeitprotokolle des Plugins (Start, Absturz/Neustart des Desktop-Pets, Fehler und Warnungen) in diese eine Datei; bitte bei Problemmeldungen anhängen. Maximal 1 MB pro Datei, danach bleiben nur die letzten 512 KB erhalten.",
	saved: "Gespeichert – die Pets gelten sofort.",
	loadError: "Konfiguration konnte nicht geladen werden",
	saveError: "Konfiguration konnte nicht gespeichert werden. Bitte Serververbindung, Schreibrechte im Konfigurationsverzeichnis und Serverprotokoll prüfen.",
	saveInvalid: "Konfiguration konnte nicht gespeichert werden: Inhalt ungültig. Bitte prüfen und erneut versuchen.",
	syncError: "Synchronisieren fehlgeschlagen. Bitte Serververbindung und Schreibrechte im Konfigurationsverzeichnis prüfen.",
	loading: "Konfiguration wird geladen…",
	retry: "Erneut versuchen",
	invalid: "Bitte Eingaben prüfen: Größe muss positiv sein, Ränder dürfen beliebige Zahlen sein.",
	busy: "Wird gespeichert…",
	extraPetsHint: "Weitere {n} Art(en) stammen aus Dateien im Verzeichnis pet/ (<Name>-config.json + <Name>-animation/); oben in der Zeile „Arten\" umschalten und bearbeiten. Speichern schreibt jeweils in die eigene Paketkonfiguration, nie in main-config.jsonc.",
	kindLabel: "Arten",
	kindMain: "Integriert",
	lastOfKind: "„{entry}\" hat nur noch dieses eine Pet – beim Löschen verschwindet die ganze Art. Zum vollständigen Entfernen die Pet-Pack-Dateien löschen.",
	savePartial: "Haupt-Pets gespeichert, aber {names} konnten nicht zurückgeschrieben werden: Prüfen Sie, ob die Pack-Konfiguration gültig und das Verzeichnis beschreibbar ist.",
	notifyToggle: "Systembenachrichtigungen",
	notifyToggleHint: "System-Toasts (unten rechts auf dem Desktop) bei Abschluss einer Konversation, Fehlern, Berechtigungsanfragen und Rückfragen – nur wenn das Fenster nicht fokussiert ist.",
	clickSoundToggle: "Klick-Sound",
	clickSoundToggleHint: "Beim Klick auf ein Pet ertönt der integrierte Klick-Sound (assets/sound/click-duck.wav, Lautstärke 0.5); Klicks innerhalb von 100 ms werden nur einmal abgespielt, auch bei mehreren Pets überlagert sich nichts. Aus = völlig stumm. Wird beim „Speichern\" in die Benutzerkonfiguration geschrieben.",
	whisperImageToggle: "Flüstern-Bilder",
	whisperImageToggleHint: "Hängt an jede Flüstern-Zeile ein zufälliges Meme aus dem Pool (Bildzuordnung im Top-Level-Feld `memes` der Konfiguration). Token: Flüstern ruft ohnehin pro Zyklus das Modell auf, das Bild fügt nur Name + Beschreibung des gezogenen Memes (ca. 100 Zeichen / ≈60 Token) an dieselbe Anfrage an – vernachlässigbar.",
	chatImageToggle: "Chat-Bilder",
	chatImageToggleHint: "Die KI wählt im Chat passend zum Kontext ein Meme aus dem Pool (optional; Zuordnung im Top-Level-Feld `memes`). Token: Jede Nachricht führt den gesamten Katalog mit – aktuell ca. 1,1k Zeichen (≈650 Token, etwa 11-mal so viel wie beim Flüstern) und linear mit der Bildanzahl wachsend; aus = es wird kein Zeichen angehängt.",
	chatAnimationToggle: "Chat-Aktionen",
	chatAnimationToggleHint: "Wenn an, enthält die Chat-Anfrage die Liste der spielbaren Animationen (alle Aktionen unter animations.categories): Hält das Modell die Zeile für eine tatsächliche Aufführung, spielt das Pet sie sofort; sonst antwortet es nur mit Text. Token: Jede Nachricht führt die ganze Liste mit; aus = es wird nichts angehängt. Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner eigenen Konfigurationsdatei überschreiben).",
	confineToggle: "Auf aktuellen Bildschirm begrenzen",
	confineToggleHint: "Mehrere Monitore: Wenn an, bleibt das Pet auf dem Bildschirm, auf dem es sich gerade befindet – ein geworfenes Pet prallt nur innerhalb des Bildschirms ab, auf dem es losgelassen wurde (Bildschirmfugen wirken als Wände, es fliegt nicht zum Nachbarmonitor), und autonomes Umherlaufen bleibt auf dem aktuellen Bildschirm (ein Schritt über die Fuge wird einfach verworfen). Aus = Überqueren der Bildschirme wie gewohnt. Nur Desktop-Modus – das Browser-Overlay bleibt ohnehin im Viewport.",
	trayToggle: "System-Tray",
	trayToggleHint: "Zeigt im Desktop-Modus ein Tray-Symbol (Windows: Infobereich, macOS: Menüleiste). Es listet alle Pets der Konfiguration und schaltet die Anzeige um – auch für Pets, die gerade nicht auf dem Desktop sind und kein Fenster zum Rechtsklicken haben. Ohne Tray lässt sich ein Pet nur über den Browser (Einstellungsseite oder Rechtsklick auf das Web-Pet) zurück auf den Desktop holen. Windows blendet das Symbol ohnehin in die „ausgeblendeten Symbole\" aus. Nur Desktop-Modus.",
	requestBubbleToggle: "Genehmigungsblase",
	requestBubbleToggleHint: "Wenn ein Tool-Aufruf deine Freigabe braucht oder die KI eine Frage stellt, zeigt das Haustier die Auswahl direkt darüber: „Einmal erlauben / Ablehnen“ oder eine Option antippen — die Antwort geht sofort an die Sitzung zurück. Übernimmt nur, solange eine Haustier-Seite online ist; sonst, bei ausgeschaltetem Schalter oder wenn schon eine andere Anfrage läuft, bleibt es beim DSH-Panel.",
	scheduleReminderToggle: "Aufgaben-Erinnerungen",
	scheduleReminderToggleHint: "Wenn eine mit schedule_create erstellte Aufgabe fällig wird, zeigt das Haustier eine Erinnerung (nur Hinweis — die Sitzung startet weiterhin der DSH-Scheduler). Zeitänderungen werden automatisch übernommen; ohne online Haustier-Seite wird übersprungen und beim Zurückkommen nachgeholt. Wird beim „Speichern“ in die Benutzerkonfiguration geschrieben.",
	menuTitle: "Kontextmenü",
	menuHint: "Was beim Rechtsklick auf das Haustier erscheint und in welcher Reihenfolge. Ziehen Sie den Griff links zum Sortieren und nutzen Sie die Schaltfläche rechts, um einen Eintrag ein- oder auszublenden. Nur die Werkzeuge lassen sich sortieren - Animationswiedergabe, Anzeigeposition und das „Mehr\" von Drittanbietern haben eigene Bedingungen. Wird beim Speichern in die Benutzerkonfiguration geschrieben.",
	menuMoveUp: "Nach oben",
	menuMoveDown: "Nach unten",
	menuShow: "Anzeigen",
	menuHide: "Ausblenden",
	menuDrag: "Ziehen zum Sortieren",
	menuReset: "Zurücksetzen",
	menuNote: "Ausgeblendete Einträge behalten ihren Platz und erscheinen beim erneuten Anzeigen wieder dort. In der Standardreihenfolge steht „Chat\" vorn.",
	voiceTitle: "Sprachausgabe",
	voiceHint: "Drei Schalter und eine Stimme: Der Hauptschalter steuert die automatische Ausgabe, die beiden Unterschalter je eine Art proaktiver Meldung. Standardmäßig alle aus; wird beim „Speichern\" in die Benutzerkonfiguration geschrieben (kein sofortiges Schreiben).",
	voiceEnabled: "Sprachausgabe aktivieren",
	voiceEnabledHint: "Hauptschalter für die automatische Sprachausgabe. Aus = regelmäßige Flüstern-Sätze und To-do-Erinnerungen werden nicht gesprochen (die beiden Unterschalter unten wirken dann nicht). Manuelles Flüstern, Chat-Antworten und die Lautsprecher-Schaltfläche im Chat-Panel sind nicht betroffen – die haben Sie selbst ausgelöst, die sprechen direkt. Es betrifft nur das Sprechen: Blasen, Chat-Gedächtnis und Systembenachrichtigungen bleiben unberührt; eine fehlgeschlagene Synthese wird nur protokolliert und unterbricht den Chat nicht.",
	voiceWhisperEnabled: "Flüstern sprechen",
	voiceWhisperEnabledHint: "Spricht den regelmäßig erzeugten Flüstern-Satz (auch manuelles Flüstern per Rechtsklick oder Slash-Befehl). Unterliegt dem Hauptschalter oben: Ist er aus, wirkt dieser Schalter nicht. Standardmäßig aus – Flüstern ist Hintergrundbegleitung und sollte nicht ungefragt Geräusche machen.",
	voiceTodoEnabled: "To-do-Erinnerungen sprechen",
	voiceTodoEnabledHint: "Spricht eine fällige To-do-Erinnerung (die Blase erscheint weiterhin; dieser Schalter entscheidet nur, ob gesprochen wird). Unterliegt dem Hauptschalter oben. Standardmäßig aus.",
	voiceEngineLabel: "Sprachausgabe-Engine",
	voiceEngineHint: "Welche Stimme spricht. Edge ist die eingebaute Microsoft-Stimme: kostenlos und sofort nutzbar. Breeze nutzt deinen eigenen Breeze-API-Key (Modell breeze-tts-2); Stimmen lassen sich anlegen oder klonen und werden über dein Konto abgerechnet. Das legt nur die Stimme fest – ob überhaupt gesprochen wird, bestimmen weiterhin die drei Schalter oben.",
	voiceEngineEdge: "Integriert (Edge)",
	voiceEngineBreeze: "Breeze online",
	breezeKeyLabel: "Breeze-API-Key",
	breezeKeyHint: "Beginnt mit brz_; kopiere ihn von der Seite „API Keys“ im Breeze-Dashboard. Er liegt nur in deiner lokalen Nutzerkonfiguration und wird beim Speichern geschrieben – nie in ein öffentliches Repository oder einen Screenshot einfügen.",
	breezeVoiceLabel: "Breeze-Stimme",
	breezeVoiceAuto: "Automatisch (erste Stimme)",
	breezeVoiceHint: "Stimmen deines Kontos; „Automatisch“ nimmt die erste. Nach einem Key-Wechsel erscheint die neue Liste erst nach dem Speichern.",
	breezeSpeedLabel: "Breeze-Tempo",
	breezeSpeedHint: "0,5–2×, 1 ist normal. Gilt für Vorschau und Ansage; die integrierte Engine ignoriert es (sie spricht prozentual).",
	breezeStatusLabel: "Verbindung",
	breezeStatusHint: "„Erneut prüfen“ holt die Stimmliste mit dem gespeicherten Key von Breeze: Kommt sie zurück, funktioniert der Key. Ungespeicherte Änderungen sieht er nicht.",
	breezeRefresh: "Erneut prüfen",
	breezeNoKey: "Noch kein Key – eintragen, speichern, dann „Erneut prüfen“.",
	breezeBadKey: "Der Key ist ungültig oder wurde zurückgesetzt. Kopiere einen neuen aus Breeze.",
	breezeListFailed: "Breeze ist nicht erreichbar (Netzwerk- oder Dienstproblem); der Key kann trotzdem in Ordnung sein.",
	breezeReady: "Key funktioniert, Stimmliste geladen.",
	voiceNameLabel: "Stimme",
	voiceVolumeLabel: "Lautstärke",
	voiceVolumeHint: "Wiedergabelautstärke als Dezimalzahl 0–1: 1 ist die maximale Lautstärke (100 %), 0 ist stumm. Ändert nur die Lautheit und synthetisiert kein Audio neu, kostet also nichts extra. Unabhängig vom Hauptschalter oben — bei ausgeschaltetem Schalter ohne Wirkung.",
	voicePreview: "Anhören",
	voicePreviewSample: "Hallo, ich bin dein Desktop-Pet. Einen schönen Tag noch!",
	voicePreviewHint: "Spielt einen Satz mit der gewählten Stimme ab - genau das hörst du nach dem Speichern. Leer lassen für den Standardsatz oder eigenen Text eingeben (max. 500 Zeichen).",
	voicePreviewBusy: "Wird synthetisiert…",
	voicePreviewFailed: "Anhören fehlgeschlagen: {msg}",
	physicsTitle: "Physik (Zieh- und Wurfgefühl)",
	physicsHint: "Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben); wird beim „Speichern\" in die Benutzerkonfiguration geschrieben (kein sofortiges Schreiben). Im Browser sofort wirksam, im Desktop-Modus, sobald das Speichern die Pet-Fenster neu lädt.",
	mobileTitle: "Mobil-Effekte",
	mobileHint: "Nur im Handy-Browser sinnvoll: Vibration braucht einen Motor, die beiden Bewegungs-Schalter brauchen Neigungs-/Beschleunigungssensoren, und Sensoren gibt es nur über HTTPS oder localhost.",
	"physics.gravity": "Schwerkraft",
	"physics.gravityHint": "px/s², größer = fällt schneller; 0 = schwerelos (fliegt geradeaus weiter)",
	"physics.restitution": "Elastizität",
	"physics.restitutionHint": "0–1, Geschwindigkeitsanteil beim Abprallen von Wand/Boden (1 = voll elastisch, 0 = bleibt sofort stehen)",
	"physics.groundFriction": "Kontaktreibung",
	"physics.groundFrictionHint": "/s, Abklingen der Geschwindigkeit entlang jeder Kontaktfläche (Wand, Boden, Decke); 0 = überall eisglatt",
	"physics.throwPower": "Wurfkraft",
	"physics.throwPowerHint": "> 0, Gesamtfaktor für Federfolge und Abwurfgeschwindigkeit (1 = Standard; höher = folgt enger, wirft härter)",
	physicsCeilingBounce: "Deckenabprall",
	physicsCeilingBounceHint: "Aus: Würfe können oben aus dem Bildschirm fliegen (die Schwerkraft holt sie zurück)",
	physicsPetCollision: "Pet-Kollisionen",
	physicsPetCollisionHint: "Ein fliegendes Pet prallt mit Impulserhaltung von anderen ab (Masse ∝ Größe²)",
	physicsHaptic: "Kollisions-Vibration",
	physicsHapticHint: "Ein Impuls pro Treffer (Wand, Boden, Decke, andere Pets). Funktioniert in Chrome/Edge; nicht auf iOS oder in WebView-Hüllen wie Via. „Nicht stören“ blockiert die Vibration.",
	physicsTilt: "Schwerkraft per Neigung",
	physicsTiltHint: "Handy neigen: die Schwerkraft folgt der Neigung (Betrag = der Wert oben). Bei Schwerkraft 0 bewirkt Neigen nichts. Benötigt HTTPS/localhost.",
	physicsShake: "Schütteln zum Werfen",
	physicsShakeHint: "Schütteln schleudert den Pet in Wurfrichtung; die Stärke folgt throwPower. Unabhängig von der Schwerkraft, funktioniert also auch bei 0. Benötigt HTTPS/localhost.",
	invalidPhysics: "Bitte Physikwerte prüfen: Schwerkraft / Bodenreibung ≥ 0, Elastizität 0–1, Wurfkraft > 0.",
	fontTitle: "Aussehen & Schrift",
	fontHint: "Die Schriftart gilt für alle Texte, die derzeit die Candy-Schrift nutzen: Pet-Blase, Hover-Tooltip, Chat-Fenster, Score-Popup; die Schriftgröße gilt nur für Pet-Blase und Hover-Tooltip (Chat- und Score-Popup behalten ihre Größe). Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben); wird beim „Speichern\" in die Benutzerkonfiguration geschrieben – im Browser sofort wirksam, im Desktop-Modus, sobald das Speichern die Pet-Fenster neu lädt.",
	fontFamilyLabel: "Schriftart",
	fontFamilyHint: "„Candy (integriert)\" wird mit dem Plugin geliefert; die übrigen sind Systemschriften. Fehlt eine Schrift auf diesem Rechner, greift die nächste im Stapel (nie leer, kein Fehler).",
	fontSizeLabel: "Schriftgröße (px)",
	fontSizeHint: "Schriftgröße des Blasentexts; Tooltip und kleinere Zeilen in der Blase skalieren anteilig. Bereich 4–200.",
	fontFollowToggle: "Schriftgröße mit Pet-Größe skalieren",
	fontFollowToggleHint: "An (Standard): die Schrift wächst mit dem Pet – bei 462 px Breite entspricht sie genau der obigen Größe. Aus: die Größe bleibt unabhängig von der Pet-Größe konstant.",
	invalidFont: "Bitte Schrifteinstellungen prüfen: Die Schriftart muss in der Liste stehen, die Größe eine Zahl zwischen 4 und 200 sein.",
	"font.candy": "Candy (integriert)",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "Systemstandard",
	modelTitle: "Chat & Modelle",
	modelHint: "Welches Modell Flüstern und Chat jeweils nutzen und wie viel Verlauf jeder Chat-Aufruf mitführt. „Aktueller Konversation folgen\" = das Modell, das Ihre aktuelle Konversation verwendet (Standard). Globaler Standard: gilt für alle Pets, ein Pet-Pack kann ihn in seiner Art-Datei überschreiben. Die Optionen stammen aus derselben Quelle wie die Modellauswahl von DSH und werden vom Host live geliefert.",
	modelFollow: "Aktueller Konversation folgen",
	modelSearch: "Modelle suchen…",
	modelEmpty: "Keine passenden Modelle.",
	modelNoModels: "Keine Modelle verfügbar.",
	modelLoading: "Modellliste wird aktualisiert…",
	modelTriggerAria: "Modell wählen, aktuell {model}",
	modelUnknown: " (aktuelle Konfiguration, nicht in der Liste)",
	modelNone: "Für diesen Anbieter sind keine Modelle verfügbar",
	whisperModelLabel: "Flüstern-Modell",
	chatModelLabel: "Chat-Modell",
	modelFieldHint: "„Aktueller Konversation folgen\" = Modell der aktuellen Konversation; schlägt ein gewähltes Modell fehl, fällt das Plugin auf das Modell der aktuellen Konversation zurück und versucht es einmal erneut.",
	invalidModel: "Bitte Modelleinstellungen prüfen: Anbieter und Modell entweder beide wählen oder beide leer lassen (aktuelle Konversation folgen).",
	modelCatalogFailed: "Modellliste konnte nicht geladen werden (Seite neu laden für einen neuen Versuch); die aktuellen Konfigurationswerte bleiben unverändert erhalten.",
	chatMemory: "Chat-Verlaufsrunden",
	chatMemoryHint: "Wie viele der letzten Runden jeder Chat-Aufruf mitführt (1 Runde = 1 Frage + 1 Antwort; 0 = kein Verlauf, jede Nachricht ist neu). Das Gedächtnis selbst behält alles – dieser Wert bestimmt nur, wie viel in den Kontext kommt: mehr merkt mehr und kostet mehr Token. Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben).",
	invalidChatMemory: "Bitte Chat-Verlaufsrunden prüfen: Zahl ≥ 0 erforderlich.",
	chatImageLimit: "Max. Chat-Bilder",
	chatImageLimitHint: "Wie viele Memes beim Chat höchstens an das Modell gelistet werden („erste N\" = die ersten N in der Konfiguration; was bevorzugt gesendet werden soll, nach vorne verschieben). Die ganze Liste wird an jede Nachricht angehängt, Token wachsen linear mit der Anzahl – eine lange Liste kostet nur. Mit der Grenze auf die ersten N wählt das Modell nur daraus. 0 = keine Grenze (alles senden). Integrierter Standard 10. Globaler Standard für alle Pets (ein Pet-Pack kann ihn in seiner Art-Datei überschreiben). Nur Chat-Auswahl: Flüstern führt nur das gezogene Meme mit.",
	invalidChatImageLimit: "Bitte das Limit für Chat-Bilder prüfen: Zahl ≥ 0 erforderlich (0 = keine Grenze).",
	notifyTest: "Testbenachrichtigung",
	notifyTestOk: "Testbenachrichtigung gesendet – bitte unten rechts auf dem Desktop prüfen.",
	notifyDenyUnsupported: "Systembenachrichtigungen werden in dieser Umgebung nicht unterstützt (keine Notification-API).",
	notifyDenyBlocked: "Die Benachrichtigungsberechtigung ist im Browser blockiert.",
	notifyDenyRejected: "Sie haben im Berechtigungsdialog „Blockieren\" gewählt.",
	notifyDenyError: "Fehler beim Anfordern der Berechtigung",
	notifyGuide: "Anleitung: links neben der Adressleiste auf 🔒/ⓘ klicken → „Website-Einstellungen\" → „Benachrichtigungen\" → auf „Zulassen\" setzen, Seite neu laden und erneut versuchen.",
	homeLabel: "Datenverzeichnis",
	homeHint: "Speicherort für Konfiguration, Todos, Erinnerungen und Memes. Leer lassen für den Standard; DSH zum Anwenden neu starten.",
	homeApply: "Übernehmen",
	homeReset: "Standard",
	homeSaved: "Gespeichert. DSH neu starten, um es anzuwenden.",
	homeFailed: "Speichern fehlgeschlagen: absoluten Pfad mit Schreibrecht verwenden.",
	homeEnvLocked: "Das Verzeichnis ist durch die Umgebungsvariable DSH_PET_HOME festgelegt.",
	storageTitle: "Deinstallation & Speicher",
	storageHint: "Alle Orte, an denen das Plugin auf diesem Rechner Daten ablegt. Cache löschen ist unschädlich (wird automatisch neu geladen/neu aufgebaut); „Plugin-Benutzerdaten\" löschen kostet Konfiguration und Chat-Gedächtnis.",
	"storage.userData": "Plugin-Benutzerdaten: eigene Konfiguration main-config.jsonc, Chat-Gedächtnis memory.json, eigene Animations-Assets main-animation/, Datei-Pets pet/",
	"storage.electron": "Electron-Laufzeit für das Desktop-Pet (groß; wird beim nächsten Start des Desktop-Modus automatisch neu heruntergeladen)",
	"storage.desktopCache": "Cache der Desktop-Pet-Fenster und Skalierungs-Cache des Hauptbildschirms (löschbar, wird automatisch neu aufgebaut)",
	"storage.electronCache": "Download-Cache des Electron-Installers (löschbar, wird bei Bedarf neu geladen)",
	"storage.package": "Das Plugin selbst (von DSH verwaltet – mit dem Befehl unten entfernen, nicht von Hand löschen)",
	storageMissing: " (noch nicht erstellt)",
	uninstallTitle: "So deinstallieren Sie",
	uninstallStep1: "1. Zuerst DSH beenden (das Desktop-Pet beendet sich mit); die obigen Dateien nicht löschen, während das Pet läuft.",
	uninstallStep2: "2. Das Plugin selbst entfernen (im Terminal ausführen; entfernt es auch aus der Bundle-Schicht des Profils):",
	uninstallStep3: "3. Die obigen Orte nach Bedarf löschen: Caches sind unschädlich; „Plugin-Benutzerdaten\" löschen kostet Konfiguration und Chat-Gedächtnis (vorher main-config.jsonc sichern, wenn Sie es behalten wollen).",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/en.ts
const en = {
	nav: "Pet Config",
	intro: "Manage multiple pets: each pet has its own size and position (applies instantly after saving).",
	petCardTitle: "Pet",
	avatarLabel: "Avatar",
	avatarHint: "The small image shown next to this pet’s messages in the chat panel. Without an upload it falls back to the plugin logo; an upload takes effect immediately and replaces the previous one — no need to click Save.",
	avatarUpload: "Upload avatar",
	avatarChange: "Change",
	avatarUploading: "Uploading…",
	avatarUploaded: "Avatar updated",
	petCardHint: "Per-pet settings: name / size / display / corner / offsets / the four feature switches. Click \"Save\" at the bottom to apply instantly.",
	globalTitle: "Global switches",
	globalHint: "Shared by every pet (a pet pack may override them in its own kind file). These switches only change local state and are written to the user config on \"Save\" (never written immediately); system notifications re-read right after saving, no page refresh needed.",
	cornerHint: "Which corner the pet sticks to; in desktop mode it follows the screen that holds the DSH window (multi-monitor aware), falling back to the primary display.",
	marginXHint: "Horizontal distance from the chosen corner (px); any number.",
	marginYHint: "Vertical distance from the chosen corner (px); any number.",
	"cmd.chat": "Chat",
	"cmd.pet": "Pet",
	"cmd.balance": "Balance",
	"shortcut.open": "Open pet chat",
	"shortcut.chat": "Open chat bubble",
	"shortcut.hear": "Voice input",
	"shortcut.capture": "Screenshot to chat",
	shortcutCardTitle: "Shortcuts",
	shortcutCardHint: "Two groups once expanded: pet shortcuts and global shortcuts.",
	shortcutRowChat: "Open chat",
	shortcutRowHold: "Hold to talk",
	shortcutRowHear: "Voice input",
	shortcutRowCapture: "Screenshot",
	shortcutRowPaste: "Paste image",
	shortcutRowTodo: "Todo list",
	shortcutRowSleep: "Sleep / wake",
	shortcutRowDisplay: "Display position",
	shortcutRowSidebar: "Open sidebar chat",
	shortcutGroupPet: "Pet shortcuts",
	shortcutGroupPetHint: "On the web, hovering the pet is enough. In the desktop pet window, click the pet first so it takes keyboard focus.",
	shortcutGroupGlobal: "Global shortcuts",
	shortcutGroupGlobalHint: "Dispatched by DSH in the web app and the desktop window; rebind them in Settings → General → Shortcuts.",
	petsLabel: "Pets",
	add: "Add pet",
	remove: "Remove",
	confirmRemove: "Delete pet \"{id}\"?",
	confirmTitle: "Confirm action",
	cancel: "Cancel",
	ok: "Got it",
	atLeastOne: "Keep at least one pet.",
	emptyPets: "No pets yet — click \"Add pet\" to create one.",
	sizeLabel: "Size (width px)",
	sizeHint: "Height is automatic = width × 9/16.",
	sizePercentLabel: "Max screen width (%)",
	sizePercentHint: "How much of the screen width the pet may take: 100 = never wider than one screen (identical to px on wide windows); try 30–40 to make it clearly smaller on a phone without changing the desktop. Computed once on page load; refresh after resizing.",
	nameLabel: "Name",
	nameHint: "Shown on hover and added to AI personas (\"your name is X\"). Duplicates allowed; empty falls back to the pet id.",
	personaLabel: "Persona (optional)",
	personaHint: "Applies to this pet only. Leave empty to follow the entry persona — the grey text inside the box is exactly that. The system prompt actually sent = this text + an appended 「your name is \"<name>\"」 line + the current time context, so do not repeat the name or the date here.",
	personaCount: "{n} chars",
	balanceEnabled: "Balance",
	balanceEnabledHint: "When enabled, this pet plays balance animations and shows the balance bubble.",
	whisperEnabled: "Whisper",
	whisperEnabledHint: "When enabled, this pet periodically generates a line via AI and plays the whisper animation (persona = the field below; empty follows the entry).",
	workStatusEnabled: "Work status",
	workStatusEnabledHint: "When enabled, this pet follows DSH work state: thinking / working / waiting / done / error switch animations and show bubbles (pool in top-level config; listening only, no model calls).",
	fixedEnabled: "Pin in place",
	fixedEnabledHint: "When enabled, the random chain no longer turns this pet or walks it away — only idle and in-place actions play. Right-click picks, API triggers and balance / whisper / work-status animations are unaffected.",
	displayLabel: "Display",
	displayHint: "web = browser only / desktop = desktop only / both = both / none = neither",
	"display.web": "Browser only",
	"display.desktop": "Desktop only",
	"display.both": "Both",
	"display.none": "Neither",
	cornerLabel: "Position",
	"corner.top-left": "Top-left",
	"corner.top-right": "Top-right",
	"corner.bottom-left": "Bottom-left",
	"corner.bottom-right": "Bottom-right",
	marginX: "Horizontal offset",
	marginY: "Vertical offset",
	save: "Save",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "Sync",
	confirmSync: "Sync? This overwrites the user config with the bundled default config (all fields + comments); current customizations are lost.",
	corruptTitle: "User config is corrupted — not saved",
	corruptConfirm: "Save anyway",
	corruptBody: "The user config file cannot be parsed (corrupted, not valid JSON/JSONC): {path}. Saving now rebuilds it from the whitelist — everything currently in that file (animations / physics / memes …) will be lost. Cancel = leave the file untouched (fix it and save again); Confirm = save anyway (discard what is in the file).",
	syncHint: "\"Sync\" writes the bundled default config (comments + every advanced field included) to the user config file, overwriting your current customizations; the file is then directly editable. Two caveats: (1) once created, that file is an explicit override layer — later changes to the bundled defaults will not take effect automatically (until you sync again or delete the file); (2) clicking \"Save\" on this page rewrites the file from a whitelist — field values are kept, comments are dropped.",
	configMeta: "Advanced (files)",
	configMetaHint: "User config may override pets / animation pools / weights — refresh or restart to apply: refresh the page in the browser, or right-click a desktop pet → \"Reload config\" (rebuilds every desktop pet window). The default config is the complete reference.",
	defaultConfig: "Default config (read-only, complete reference)",
	userConfig: "User config (custom overrides)",
	todosFile: "Todo data (text, due time and done state; deleting it clears every todo)",
	animationDir: "Animation assets dir (add/customize animations here)",
	memesDir: "Meme images dir (add/customize images here)",
	logFile: "Log file (for troubleshooting; safe to clear)",
	logFileNote: "The DSH desktop app has no console, so every runtime log of the plugin (startup, desktop pet crashes/restarts, errors and warnings) goes into this single file — attach it when reporting a problem. It is capped at 1 MB; once full, only the latest 512 KB is kept.",
	saved: "Saved — the pets updated instantly.",
	loadError: "Failed to load config",
	saveError: "Failed to save config. Check the server connection, configuration directory write permissions and server log.",
	saveInvalid: "Failed to save config: invalid configuration. Check the values and try again.",
	syncError: "Failed to sync config. Check the server connection and configuration directory write permissions.",
	loading: "Loading config…",
	retry: "Retry",
	invalid: "Check your input: size must be positive; margins can be any number.",
	busy: "Saving…",
	extraPetsHint: "{n} more kind(s) come from files in the pet/ directory (<name>-config.json + <name>-animation/). Switch to them in the Kinds row above; Save writes back to each pack's own config, never into main-config.jsonc.",
	kindLabel: "Kinds",
	kindMain: "Built-in",
	lastOfKind: "\"{entry}\" has only this pet left — deleting it would remove the whole kind. Delete the pet pack files to remove it entirely.",
	savePartial: "Main pets saved, but {names} could not be written back: check that the pack config is valid and the directory is writable.",
	notifyToggle: "System notifications",
	notifyToggleHint: "OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.",
	clickSoundToggle: "Click sound",
	clickSoundToggleHint: "Plays the built-in click sound (assets/sound/click-duck.wav, volume 0.5) when a pet is clicked; repeated clicks within 100ms play only once, so multiple pets never stack up. Turn it off for silence. Written to the user config together with Save.",
	whisperImageToggle: "Whisper images",
	whisperImageToggleHint: "Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.",
	chatImageToggle: "Chat images",
	chatImageToggleHint: "Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.",
	chatAnimationToggle: "Chat actions",
	chatAnimationToggleHint: "When on, the chat request carries the list of playable animations (every action under animations.categories): if the model judges that the line really performs one, the pet acts it out on the spot; otherwise it replies in text only. Tokens: every message carries the whole list; off appends nothing. Global default for all pets (a pet pack can override it in its own config file).",
	confineToggle: "Lock to the current screen",
	confineToggleHint: "Multi-monitor: when on, the pet stays inside the screen it is currently on — a thrown pet bounces only inside the screen it was released on (screen seams act as walls, so it never flies to the neighbouring monitor), and autonomous wandering only walks within the screen it is currently on (a step that would cross the seam is simply cancelled). Turn this off to let it cross screens as usual. Desktop only — the browser overlay always stays inside the viewport anyway.",
	trayToggle: "System tray",
	trayToggleHint: "Shows a tray icon (notification area on Windows, menu bar on macOS) once desktop mode is running. It lists every pet in the config and toggles each one between desktop and web/none — including pets that are currently off the desktop and therefore have no window to right-click. With it off, bringing a pet back to the desktop requires opening the browser (the settings page, or right-clicking a web pet there). Windows already folds third-party icons into the \"hidden icons\" overflow. Desktop mode only.",
	requestBubbleToggle: "Approval bubble",
	requestBubbleToggleHint: "Tool calls that need your approval, and the AI's questions, pop up right above the pet: hit \"Allow once / Reject\" or pick an option and the answer goes straight back to the session — no need to switch back to the DSH panel. It only takes over while a pet page is online; when nothing is online, the switch is off, or another request is already pending, DSH's own panel handles it.",
	scheduleReminderToggle: "Task reminders",
	scheduleReminderToggleHint: "When a task created with schedule_create comes due, the pet shows a reminder bubble. Reminders only — the DSH scheduler still triggers the session. Rescheduled tasks are re-armed automatically; skipped while no pet page is online and caught up when one returns. Written to the user config on \"Save\".",
	menuTitle: "Context menu",
	menuHint: "What appears when you right-click the pet, and in what order. Drag the handle on the left to reorder, and use the button on the right to show or hide an item. Only the tool items are listed here - animation playback, display position and third-party \"more\" have their own visibility rules and are not sortable. Written to your user config on Save.",
	menuMoveUp: "Move up",
	menuMoveDown: "Move down",
	menuShow: "Show",
	menuHide: "Hide",
	menuDrag: "Drag to reorder",
	menuReset: "Reset to default",
	menuNote: "Hidden items keep their slot, so showing them again returns them to the same place. Chat comes first in the default order.",
	voiceTitle: "Voice",
	voiceHint: "Three switches plus a voice: the master switch gates automatic speech, the two sub-switches gate one kind of proactive message each. All off by default; written to the user config on \"Save\" (never written immediately).",
	voiceEnabled: "Speak replies",
	voiceEnabledHint: "Master switch for automatic speech. When off, periodic whispers and todo reminders stay silent (the two sub-switches below have no effect). Chat replies and the speaker button in the chat panel are not gated — you asked for those, so the surface you asked from speaks them directly. It only affects whether sound is produced — bubbles, chat memory and system notifications are untouched; a failed synthesis is logged and never interrupts the conversation.",
	voiceWhisperEnabled: "Speak whispers",
	voiceWhisperEnabledHint: "Speaks every whisper — the periodic one, the one you trigger from the right-click menu, and the one from the slash command. Gated by the master switch above. Off by default — whispers are background narration and should not make noise unasked.",
	voiceTodoEnabled: "Speak todo reminders",
	voiceTodoEnabledHint: "Speaks a todo reminder when it comes due (the bubble still appears; this only decides whether it is spoken). Gated by the master switch above. Off by default.",
	voiceEngineLabel: "Speech engine",
	voiceEngineHint: "Whose voice to use. Edge is the built-in Microsoft voice: free and ready to go. Breeze uses your own Breeze API key (breeze-tts-2 model); voices can be created or cloned and are billed to your account. This only picks the voice — whether to speak at all is still up to the three switches above.",
	voiceEngineEdge: "Built-in (Edge)",
	voiceEngineBreeze: "Breeze online",
	breezeKeyLabel: "Breeze API key",
	breezeKeyHint: "Starts with brz_; copy it from the API Keys page in the Breeze dashboard. It is stored only in your local user config and written on Save — never paste it into a public repo or a screenshot.",
	breezeVoiceLabel: "Breeze voice",
	breezeVoiceAuto: "Auto (first voice)",
	breezeVoiceHint: "Voices available to your account; Auto picks the first one. After changing the key, the new list appears only once you save.",
	breezeSpeedLabel: "Breeze speed",
	breezeSpeedHint: "0.5–2×, 1 is normal. Shared by preview and speech; the built-in engine ignores it (it speaks by percentage).",
	breezeStatusLabel: "Connection",
	breezeStatusHint: "Check again fetches the voice list from Breeze using the saved key: if it comes back, the key works. Unsaved edits are not visible to it.",
	breezeRefresh: "Check again",
	breezeNoKey: "No key yet — paste one, save, then press Check again.",
	breezeBadKey: "The key is invalid or was reset. Copy a new one from Breeze.",
	breezeListFailed: "Could not reach Breeze (network or service issue); the key may still be fine.",
	breezeReady: "Key works, voice list loaded.",
	voiceNameLabel: "Voice",
	voiceVolumeLabel: "Volume",
	voiceVolumeHint: "Playback volume as a 0–1 decimal: 1 is full volume (100%), 0 is muted. Changes loudness only and never re-synthesizes audio, so adjusting it costs nothing extra. Independent of the master switch above — it has no effect while that switch is off.",
	voicePreview: "Preview",
	voicePreviewSample: "Hi there, I am your desktop pet. Let us have a good day!",
	voicePreviewHint: "Plays a line with the selected voice - exactly what you will hear after saving. Leave it empty for the default sentence, or type your own (500 characters max).",
	voicePreviewBusy: "Synthesizing…",
	voicePreviewFailed: "Preview failed: {msg}",
	physicsTitle: "Physics (drag & throw feel)",
	physicsHint: "Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on \"Save\" (never written immediately). Applies instantly in the browser; on the desktop it applies once Save reloads the pet windows.",
	mobileTitle: "Mobile effects",
	mobileHint: "Only meaningful in a phone browser: haptics needs a vibration motor, the two motion switches need tilt / accelerometer sensors, and sensors require HTTPS or localhost.",
	"physics.gravity": "Gravity",
	"physics.gravityHint": "px/s² — the higher, the faster it falls; 0 = weightless (flies straight forever)",
	"physics.restitution": "Bounciness",
	"physics.restitutionHint": "0–1, speed kept when bouncing off a wall or the floor (1 = perfectly elastic, 0 = stops dead)",
	"physics.groundFriction": "Contact friction",
	"physics.groundFrictionHint": "per second, damping along any surface hit (wall, floor, ceiling); 0 = frictionless ice everywhere",
	"physics.throwPower": "Throw power",
	"physics.throwPowerHint": "> 0, overall multiplier for spring tracking and release speed (1 = default; higher = tighter tracking, harder throws)",
	physicsCeilingBounce: "Ceiling bounce",
	physicsCeilingBounceHint: "Turn this off to let a throw fly out through the top of the screen (gravity still pulls it back)",
	physicsPetCollision: "Pet collisions",
	physicsPetCollisionHint: "A flying pet bounces off the others with momentum conservation (mass ∝ size²)",
	physicsHaptic: "Collision haptics",
	physicsHapticHint: "One buzz per hit (walls, floor, ceiling, other pets). Works in Chrome/Edge; not on iOS or WebView shells like Via. Do Not Disturb blocks it.",
	physicsTilt: "Tilt gravity",
	physicsTiltHint: "Tilt the phone and gravity follows it (magnitude = the gravity value above); with gravity at 0 tilt has no effect. Requires HTTPS/localhost.",
	physicsShake: "Shake to throw",
	physicsShakeHint: "Shake to fling the pet along the shake direction; strength scales with throwPower. Independent of gravity, so it still works at gravity 0. Requires HTTPS/localhost.",
	invalidPhysics: "Check the physics values: gravity / ground friction ≥ 0, bounciness 0–1, throw power > 0.",
	fontTitle: "Appearance & font",
	fontHint: "The family applies to every place that currently uses the candy font: pet bubble, hover tooltip, chat popup, score popup. The size applies only to the pet bubble and the hover tooltip (chat and score popups keep their own size). Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on \"Save\" — instant in the browser, and on the desktop it applies once Save reloads the pet windows.",
	fontFamilyLabel: "Font",
	fontFamilyHint: "\"Candy (bundled)\" ships with the plugin; the others are system fonts. If a font is missing on this machine, it falls back to the next one in the stack (never blank, never an error).",
	fontSizeLabel: "Font size (px)",
	fontSizeHint: "Bubble body text size; the tooltip and the smaller lines inside the bubble scale proportionally. Range 4–200.",
	fontFollowToggle: "Scale font with pet size",
	fontFollowToggleHint: "On (default): the font grows with the pet — at 462 px width it is exactly the size above. Off: the size stays fixed regardless of pet size.",
	invalidFont: "Check the font settings: the family must be in the list and the size must be a number between 4 and 200.",
	"font.candy": "Candy (bundled)",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "System default",
	modelTitle: "Chat & models",
	modelHint: "Which model each of whisper and chat uses, and how much history every chat request carries. \"Follow current conversation\" uses the model your current conversation is on (default). Global default: applies to every pet, and a pet pack may override it in its own kind file. The options come from the same source as the DSH model picker, served live by the host.",
	modelFollow: "Follow current conversation",
	modelSearch: "Search models…",
	modelEmpty: "No matching models.",
	modelNoModels: "No models available.",
	modelLoading: "Refreshing model list…",
	modelTriggerAria: "Select model, current {model}",
	modelUnknown: " (current config, not in the list)",
	modelNone: "No models available for this provider",
	whisperModelLabel: "Whisper model",
	chatModelLabel: "Chat model",
	modelFieldHint: "\"Follow current conversation\" uses the conversation model; if a chosen model fails, the plugin falls back to the conversation model and retries once.",
	invalidModel: "Check the model settings: pick both a provider and a model, or leave both empty (follow the current conversation).",
	modelCatalogFailed: "Failed to load the model list (refresh the page to retry); your current values are kept as they are.",
	chatMemory: "Chat history rounds",
	chatMemoryHint: "How many recent rounds each chat request carries (1 round = 1 question + 1 answer; 0 = no history, every message starts fresh). The memory itself keeps everything — this only decides how much goes into the context: higher remembers more and costs more tokens. Global default, shared by every pet (a pet pack may override it in its own kind file).",
	invalidChatMemory: "Check the chat history rounds: it must be a number ≥ 0.",
	chatImageLimit: "Chat image limit",
	chatImageLimitHint: "How many memes at most are listed to the model during chat (\"first N\" = the first N you wrote in the config, so move the ones you want sent to the front). That whole list is attached to every message and tokens grow linearly with the count, so a long list is pure burn; capping it to the first N makes the model pick only among those. 0 = no limit (send everything). Built-in default 10. Global default, shared by every pet (a pet pack may override it in its own kind file). Chat only — a whisper carries just the one meme it drew.",
	invalidChatImageLimit: "Check the chat image limit: it must be a number ≥ 0 (0 = no limit).",
	notifyTest: "Test notification",
	notifyTestOk: "Test notification sent — check the bottom-right of your desktop.",
	notifyDenyUnsupported: "System notifications are not supported in this environment (no Notification API).",
	notifyDenyBlocked: "Notification permission is blocked by the browser.",
	notifyDenyRejected: "You chose \"Block\" in the permission prompt.",
	notifyDenyError: "Failed to request permission",
	notifyGuide: "Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to \"Allow\", then refresh and retry.",
	homeLabel: "Data directory",
	homeHint: "Where config, todos, memory and memes live. Leave empty for the default; restart DSH to apply.",
	homeApply: "Apply",
	homeReset: "Use default",
	homeSaved: "Saved. Restart DSH to apply.",
	homeFailed: "Could not save: use an absolute path with write permission.",
	homeEnvLocked: "The directory is pinned by the DSH_PET_HOME environment variable.",
	storageTitle: "Uninstall & storage",
	storageHint: "Every location this plugin writes to. Deleting cache folders is harmless (they re-download / rebuild); deleting \"plugin user data\" loses your config and chat memory.",
	"storage.userData": "Plugin user data: custom config main-config.jsonc, chat memory memory.json, custom animation assets main-animation/, file pets pet/",
	"storage.electron": "Electron runtime used by the desktop pet (large; re-downloaded automatically the next time desktop mode starts)",
	"storage.desktopCache": "Desktop pet window cache and primary-monitor scale cache (safe to delete, rebuilt automatically)",
	"storage.electronCache": "Electron installer download cache (safe to delete, re-downloaded when needed)",
	"storage.package": "The plugin itself (managed by DSH — remove it with the command below instead of deleting it)",
	storageMissing: " (not created yet)",
	uninstallTitle: "How to uninstall",
	uninstallStep1: "1. Quit DSH first (the desktop pet exits with it); do not delete these files while the pet is running.",
	uninstallStep2: "2. Remove the plugin itself (run in a terminal; this also drops it from the profile bundle layer):",
	uninstallStep3: "3. Delete the locations above as needed: cache folders are harmless; deleting \"plugin user data\" loses your config and chat memory (back up main-config.jsonc first if you want to keep it).",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/es.ts
const es = {
	nav: "Configuración de mascotas",
	intro: "Gestiona varias mascotas: cada una tiene su propio tamaño y posición (se aplica al instante después de guardar).",
	petCardTitle: "Mascota",
	avatarLabel: "Avatar",
	avatarHint: "La imagen pequeña que aparece junto a los mensajes de esta mascota en el panel de chat. Sin subir nada se usa el logotipo predeterminado del plugin; al subir una imagen se aplica al instante y reemplaza la anterior, sin pulsar \"Guardar\".",
	avatarUpload: "Subir avatar",
	avatarChange: "Cambiar",
	avatarUploading: "Subiendo…",
	avatarUploaded: "Avatar actualizado",
	petCardHint: "Ajustes por mascota: nombre / tamaño / visualización / esquina / márgenes / los cuatro interruptores de funciones. Pulsa \"Guardar\" abajo para aplicar al instante.",
	globalTitle: "Interruptores globales",
	globalHint: "Compartidos por todas las mascotas (un pet pack puede sobrescribirlos en el archivo de su propio tipo). Estos interruptores solo cambian el estado local y se escriben en la configuración del usuario al \"Guardar\" (nunca al instante); las notificaciones del sistema se vuelven a leer justo después de guardar, sin necesidad de recargar la página.",
	cornerHint: "En qué esquina de la pantalla se pega la mascota (en escritorio se calcula por el área de trabajo de cada monitor).",
	marginXHint: "Distancia horizontal desde la esquina elegida (px); puede ser cualquier número.",
	marginYHint: "Distancia vertical desde la esquina elegida (px); puede ser cualquier número.",
	"cmd.chat": "Chat",
	"cmd.pet": "Mascota",
	"cmd.balance": "Saldo",
	"shortcut.open": "Abrir el chat de la mascota",
	"shortcut.chat": "Abrir la ventana de chat",
	"shortcut.hear": "Entrada de voz",
	"shortcut.capture": "Captura de pantalla al chat",
	shortcutCardTitle: "Atajos",
	shortcutCardHint: "Al expandir hay dos grupos: atajos de la mascota y atajos globales.",
	shortcutRowChat: "Abrir chat",
	shortcutRowHold: "Mantener para hablar",
	shortcutRowHear: "Entrada de voz",
	shortcutRowCapture: "Captura de pantalla",
	shortcutRowPaste: "Pegar imagen",
	shortcutRowTodo: "Tareas",
	shortcutRowSleep: "Dormir / despertar",
	shortcutRowDisplay: "Posición de visualización",
	shortcutRowSidebar: "Abrir el chat lateral",
	shortcutGroupPet: "Atajos de la mascota",
	shortcutGroupPetHint: "En la web basta con pasar el puntero sobre la mascota. En la ventana del escritorio hay que hacer clic en la mascota para que reciba el foco del teclado.",
	shortcutGroupGlobal: "Atajos globales",
	shortcutGroupGlobalHint: "Los distribuye DSH en la web y en la ventana del escritorio; se cambian en Ajustes → General → Atajos.",
	petsLabel: "Mascotas",
	add: "Agregar mascota",
	remove: "Eliminar",
	confirmRemove: "¿Eliminar la mascota \"{id}\"?",
	confirmTitle: "Confirmar acción",
	cancel: "Cancelar",
	ok: "Entendido",
	atLeastOne: "Debe quedar al menos una mascota.",
	emptyPets: "Aún no hay mascotas; haz clic en \"Agregar mascota\" para crear una.",
	sizeLabel: "Tamaño (ancho px)",
	sizeHint: "La altura es automática = ancho × 9/16.",
	sizePercentLabel: "Ancho de pantalla máx. (%)",
	sizePercentHint: "Cuánto del ancho de pantalla puede ocupar la mascota: 100 = nunca más ancha que una pantalla (igual que px en ventanas anchas); 30–40 la hace claramente más pequeña en el móvil sin cambiar el escritorio. Se calcula una vez al cargar; recarga tras redimensionar.",
	nameLabel: "Nombre",
	nameHint: "Se muestra al pasar el cursor y se añade a las personas de la IA (\"tu nombre es X\"). Se permiten duplicados; si se deja vacío, se usa el id de la mascota.",
	personaLabel: "Persona (opcional)",
	personaHint: "Solo afecta a esta mascota. Déjalo vacío para seguir la persona de la entrada: el texto gris del cuadro es exactamente ese contenido. El system que se envía al modelo = este texto + una línea añadida con \"tu nombre es <nombre>\" + el contexto de la hora actual, así que no repitas aquí el nombre ni la fecha.",
	personaCount: "{n} caracteres",
	balanceEnabled: "Saldo",
	balanceEnabledHint: "Cuando está activado, esta mascota reproduce animaciones de saldo y muestra el globo de saldo.",
	whisperEnabled: "Susurros",
	whisperEnabledHint: "Cuando está activado, esta mascota genera periódicamente una frase con IA y reproduce la animación de susurro (la persona está en el campo de abajo; vacío sigue la entrada).",
	workStatusEnabled: "Estado de trabajo",
	workStatusEnabledHint: "Cuando está activado, esta mascota sigue el estado de trabajo de DSH: pensando / trabajando / esperando confirmación / terminado / error cambian la animación y muestran globos (el pool está en la configuración de nivel superior; solo escucha, no llama al modelo).",
	fixedEnabled: "Fijar en el sitio",
	fixedEnabledHint: "Cuando está activado, la cadena aleatoria ya no gira ni aleja a esta mascota: solo se reproducen acciones de reposo y en el sitio. Las selecciones con clic derecho, los disparos por API y las animaciones de saldo / susurro / estado de trabajo no se ven afectados.",
	displayLabel: "Visualización",
	displayHint: "web = solo navegador / desktop = solo escritorio / both = ambos / none = ninguno",
	"display.web": "Solo navegador",
	"display.desktop": "Solo escritorio",
	"display.both": "Ambos",
	"display.none": "Ninguno",
	cornerLabel: "Posición",
	"corner.top-left": "Arriba a la izquierda",
	"corner.top-right": "Arriba a la derecha",
	"corner.bottom-left": "Abajo a la izquierda",
	"corner.bottom-right": "Abajo a la derecha",
	marginX: "Margen horizontal",
	marginY: "Margen vertical",
	save: "Guardar",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "Sincronizar",
	confirmSync: "¿Sincronizar? Esto sobrescribe la configuración del usuario con la configuración predeterminada incluida (todos los campos + comentarios); las personalizaciones actuales se perderán.",
	corruptTitle: "La configuración del usuario está dañada; no se guardó",
	corruptConfirm: "Guardar de todos modos",
	corruptBody: "No se puede analizar el archivo de configuración del usuario (dañado, no es JSON/JSONC válido): {path}. Si guardas ahora, se reconstruirá desde la lista blanca: todo lo que hay actualmente en ese archivo (animations / physics / memes…) se perderá. Cancelar = no tocar el archivo (corrígelo y vuelve a guardar); Confirmar = guardar de todos modos (descartar lo que hay en el archivo).",
	syncHint: "\"Sincronizar\" escribe la configuración predeterminada incluida (con comentarios y todos los campos avanzados) en el archivo de configuración del usuario, sobrescribiendo tus personalizaciones actuales; después el archivo se puede editar directamente. Dos advertencias: (1) una vez creado, ese archivo es una capa de sobrescritura explícita: los cambios posteriores en los valores predeterminados incluidos no se aplicarán automáticamente (hasta que vuelvas a sincronizar o borres el archivo); (2) al pulsar \"Guardar\" en esta página se reescribe el archivo desde una lista blanca: los valores de los campos se conservan, pero los comentarios se pierden.",
	configMeta: "Avanzado (archivos)",
	configMetaHint: "La configuración del usuario puede sobrescribir las mascotas / los pools de animación / los pesos; recarga o reinicia para aplicarlo: recarga la página en el navegador, o haz clic derecho en una mascota de escritorio → \"Recargar configuración\" (reconstruye todas las ventanas de mascotas de escritorio). La configuración predeterminada es la referencia completa.",
	defaultConfig: "Configuración predeterminada (solo lectura, referencia completa)",
	userConfig: "Configuración del usuario (sobrescrituras personalizadas)",
	todosFile: "Datos de tareas (texto de la lista, hora de vencimiento y estado de completado; borrarlo vacía todas las tareas)",
	animationDir: "Directorio de recursos de animación (añade o personaliza animaciones aquí)",
	memesDir: "Directorio de imágenes de memes (añade o personaliza imágenes aquí)",
	logFile: "Archivo de registro (para diagnóstico; se puede vaciar)",
	logFileNote: "La versión de escritorio no tiene consola, así que todos los registros de ejecución del plugin (inicio, fallos y reinicios de la mascota de escritorio, errores y advertencias) van a este único archivo; adjúntalo al reportar un problema. El límite por archivo es de 1 MB; al llenarse solo se conservan los últimos 512 KB.",
	saved: "Guardado: las mascotas se actualizaron al instante.",
	loadError: "No se pudo cargar la configuración",
	saveError: "No se pudo guardar la configuración. Revisa la conexión con el servidor, los permisos de escritura del directorio de configuración y el registro del servidor.",
	saveInvalid: "No se pudo guardar la configuración: el contenido no es válido. Revísalo e inténtalo de nuevo.",
	syncError: "No se pudo sincronizar la configuración. Revisa la conexión con el servidor y los permisos de escritura del directorio de configuración.",
	loading: "Cargando configuración…",
	retry: "Reintentar",
	invalid: "Revisa los datos: el tamaño debe ser positivo; los márgenes pueden ser cualquier número.",
	busy: "Guardando…",
	extraPetsHint: "Otras {n} variantes provienen de archivos del directorio pet/ (<nombre>-config.json + <nombre>-animation/). Cambia a ellas en la fila Tipos de arriba; Guardar escribe en la configuración de cada pack, nunca en main-config.jsonc.",
	kindLabel: "Tipos",
	kindMain: "Integrado",
	lastOfKind: "«{entry}» solo tiene esta mascota; si la eliminas, desaparece todo el tipo. Para quitarlo por completo, borra los archivos del pack de la mascota.",
	savePartial: "Las mascotas principales se guardaron, pero {names} no se pudo escribir de vuelta: revisa que la configuración del pack sea válida y que el directorio tenga permisos de escritura.",
	notifyToggle: "Notificaciones del sistema",
	notifyToggleHint: "Avisos del sistema operativo (abajo a la derecha del escritorio) al completarse una conversación, si falla la generación, cuando se solicita permiso o cuando hay que elegir; solo mientras esta ventana no tiene el foco.",
	clickSoundToggle: "Sonido al hacer clic",
	clickSoundToggleHint: "Reproduce el sonido de clic integrado (assets/sound/click-duck.wav, volumen 0.5) al hacer clic en una mascota; los clics repetidos en menos de 100 ms solo suenan una vez, así que varias mascotas nunca se superponen. Desactívalo para silencio total. Se escribe en la configuración del usuario al Guardar.",
	whisperImageToggle: "Imágenes en susurros",
	whisperImageToggleHint: "Adjunta un meme aleatorio del pool a cada susurro (el mapeo de imágenes está en el campo `memes` de la configuración de nivel superior). Tokens: un susurro ya llama al modelo en cada ciclo, así que la imagen solo añade el nombre + la descripción de ese meme (~100 caracteres / ~60 tokens) a la misma solicitud: insignificante.",
	chatImageToggle: "Imágenes en el chat",
	chatImageToggleHint: "Deja que la IA elija un meme del pool que encaje con el contexto actual (opcional; el mapeo está en el campo `memes` de la configuración de nivel superior). Tokens: cada mensaje lleva el catálogo completo, unos 1.1k caracteres (~650 tokens, unas 11 veces el caso de los susurros) y crece con el número de imágenes; si lo desactivas, no se adjunta ni un carácter.",
	chatAnimationToggle: "Acciones en el chat",
	chatAnimationToggleHint: "Cuando está activado, la petición de chat lleva la lista de animaciones que se pueden representar (todas las acciones de animations.categories): si el modelo considera que la frase realmente representa una, la mascota la ejecuta en el acto; si no, responde solo con texto. Tokens: cada mensaje lleva la lista completa; desactivado no se adjunta nada. Valor predeterminado global para todas las mascotas (un pet pack puede sobrescribirlo en su propio archivo de configuración).",
	confineToggle: "Limitar a la pantalla actual",
	confineToggleHint: "Varios monitores: cuando está activado, la mascota solo se mueve dentro de la pantalla en la que está: una mascota lanzada rebota únicamente dentro de la pantalla donde se soltó (las uniones entre pantallas actúan como muros, así que nunca vuela al monitor vecino), y el vagabundeo autónomo solo camina dentro de la pantalla actual (el paso que cruzaría la unión se cancela). Desactívalo para permitir vuelos y caminatas entre pantallas. Solo afecta al modo escritorio: el overlay del navegador ya se queda dentro del viewport.",
	trayToggle: "Bandeja del sistema",
	trayToggleHint: "Muestra un icono en la bandeja (área de notificaciones en Windows, barra de menús en macOS) cuando el modo escritorio está activo. Lista todas las mascotas de la configuración y alterna cada una entre escritorio y web/ninguno, incluidas las que ahora no están en el escritorio y no tienen ventana donde hacer clic derecho. Con esto desactivado, para devolver una mascota al escritorio hay que abrir el navegador (la página de configuración o el clic derecho sobre la mascota web). Windows ya oculta los iconos de terceros en «iconos ocultos». Solo afecta al modo escritorio.",
	requestBubbleToggle: "Burbuja de aprobación",
	requestBubbleToggleHint: "Cuando una llamada a herramienta necesita tu aprobación, o la IA hace una pregunta, la mascota muestra las opciones justo encima: pulsa «Permitir una vez / Rechazar» o elige una opción y la respuesta vuelve al instante a la sesión. Solo toma el control si hay una página de mascota en línea; si no, o si el interruptor está apagado o ya hay otra solicitud pendiente, decide el panel nativo de DSH.",
	scheduleReminderToggle: "Recordatorios de tareas",
	scheduleReminderToggleHint: "Cuando vence una tarea creada con schedule_create, la mascota muestra un recordatorio (solo avisa; quien lanza la sesión sigue siendo el planificador de DSH). Los cambios de hora se reajustan solos; se omite si no hay mascota en línea y se recupera al volver. Se escribe en la configuración al «Guardar».",
	menuTitle: "Menú contextual",
	menuHint: "Qué aparece al hacer clic derecho en la mascota y en qué orden. Arrastra el asa de la izquierda para ordenar y usa el botón de la derecha para mostrar u ocultar cada elemento. Solo se ordenan las herramientas: la reproducción de animaciones, la posición y el \"más\" de terceros tienen sus propias condiciones. Se guarda en tu configuración al pulsar Guardar.",
	menuMoveUp: "Subir",
	menuMoveDown: "Bajar",
	menuShow: "Mostrar",
	menuHide: "Ocultar",
	menuDrag: "Arrastra para ordenar",
	menuReset: "Restablecer",
	menuNote: "Los elementos ocultos conservan su sitio, así que al mostrarlos vuelven a donde estaban. En el orden predeterminado, «Conversar» va primero.",
	voiceTitle: "Voz",
	voiceHint: "Tres interruptores y una voz: el maestro controla la locución automática y los dos secundarios controlan un tipo de mensaje proactivo cada uno. Todo desactivado por defecto; se escribe en la configuración del usuario al \"Guardar\" (nunca al instante).",
	voiceEnabled: "Locutar respuestas",
	voiceEnabledHint: "Interruptor maestro de la locución automática. Si está desactivado, los susurros periódicos y los recordatorios de tareas quedan en silencio (los dos interruptores de abajo no tienen efecto). Los susurros manuales, las respuestas del chat y el botón de altavoz del panel de chat no dependen de él: los pediste tú, así que la superficie desde la que los pediste los locuta directamente. Solo afecta a si se produce sonido: los globos, la memoria del chat y las notificaciones del sistema no cambian; un fallo de síntesis se registra y nunca interrumpe la conversación.",
	voiceWhisperEnabled: "Locutar susurros",
	voiceWhisperEnabledHint: "Locuta el susurro generado periódicamente (también el susurro manual del menú contextual y el del comando de barra). Depende del interruptor maestro de arriba. Desactivado por defecto: los susurros son narración de fondo y no deberían sonar sin pedirlo.",
	voiceTodoEnabled: "Locutar recordatorios de tareas",
	voiceTodoEnabledHint: "Locuta el recordatorio de una tarea cuando vence (el globo sigue apareciendo; esto solo decide si se locuta). Depende del interruptor maestro de arriba. Desactivado por defecto.",
	voiceEngineLabel: "Motor de voz",
	voiceEngineHint: "Con qué voz hablar. Edge es la voz integrada de Microsoft: gratis y lista para usar. Breeze usa tu propia clave de API de Breeze (modelo breeze-tts-2); las voces se pueden crear o clonar y se facturan a tu cuenta. Solo elige la voz: si se habla o no lo siguen decidiendo los tres interruptores de arriba.",
	voiceEngineEdge: "Integrado (Edge)",
	voiceEngineBreeze: "Breeze en línea",
	breezeKeyLabel: "Clave de API de Breeze",
	breezeKeyHint: "Empieza por brz_; cópiala de la página «API Keys» del panel de Breeze. Solo se guarda en tu configuración local de usuario y se escribe al Guardar: no la pegues en un repositorio público ni en una captura.",
	breezeVoiceLabel: "Voz de Breeze",
	breezeVoiceAuto: "Automática (primera voz)",
	breezeVoiceHint: "Voces disponibles en tu cuenta; «Automática» usa la primera. Si cambias la clave, la lista nueva aparece solo tras guardar.",
	breezeSpeedLabel: "Velocidad de Breeze",
	breezeSpeedHint: "0,5–2×, 1 es normal. La comparten la prueba y el aviso; el motor integrado la ignora (habla por porcentaje).",
	breezeStatusLabel: "Conexión",
	breezeStatusHint: "«Comprobar de nuevo» pide a Breeze la lista de voces con la clave guardada: si llega, la clave sirve. Los cambios sin guardar no se ven.",
	breezeRefresh: "Comprobar de nuevo",
	breezeNoKey: "Aún no hay clave: pégala, guarda y pulsa «Comprobar de nuevo».",
	breezeBadKey: "La clave no es válida o se ha restablecido. Copia una nueva de Breeze.",
	breezeListFailed: "No se pudo conectar con Breeze (red o servicio); puede que la clave esté bien.",
	breezeReady: "La clave funciona, lista de voces cargada.",
	voiceNameLabel: "Voz",
	voiceVolumeLabel: "Volumen",
	voiceVolumeHint: "Volumen de reproducción como decimal 0–1: 1 es el volumen máximo (100 %) y 0 silencia. Solo cambia la intensidad y no vuelve a sintetizar el audio, así que ajustarlo no tiene coste extra. Es independiente del interruptor general de arriba: con ese interruptor apagado no surte efecto.",
	voicePreview: "Escuchar",
	voicePreviewSample: "¡Hola! Soy tu mascota de escritorio. ¡Que tengas un buen día!",
	voicePreviewHint: "Reproduce una frase con la voz elegida: es lo mismo que oirás tras guardar. Déjalo vacío para usar la frase por defecto o escribe la tuya (máx. 500 caracteres).",
	voicePreviewBusy: "Sintetizando…",
	voicePreviewFailed: "Error al escuchar: {msg}",
	physicsTitle: "Física (sensación al arrastrar y lanzar)",
	physicsHint: "Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo); se escribe en la configuración del usuario al \"Guardar\" (nunca al instante). En el navegador se aplica al instante; en el escritorio se aplica cuando Guardar recarga las ventanas de mascotas.",
	mobileTitle: "Efectos móviles",
	mobileHint: "Solo tienen sentido en el navegador del móvil: la vibración necesita motor, los dos interruptores de movimiento necesitan sensores de inclinación/aceleración, y los sensores exigen HTTPS o localhost.",
	"physics.gravity": "Gravedad",
	"physics.gravityHint": "px/s²: cuanto mayor, más rápido cae; 0 = sin gravedad (vuela en línea recta para siempre)",
	"physics.restitution": "Rebote",
	"physics.restitutionHint": "0–1, velocidad que se conserva al rebotar en una pared o el suelo (1 = completamente elástico, 0 = se detiene en seco)",
	"physics.groundFriction": "Fricción de contacto",
	"physics.groundFrictionHint": "por segundo, amortiguación a lo largo de cualquier superficie (pared, suelo, techo); 0 = hielo en todas",
	"physics.throwPower": "Fuerza de lanzamiento",
	"physics.throwPowerHint": "> 0, multiplicador general del seguimiento con resorte y de la velocidad de salida (1 = predeterminado; más alto = sigue más pegado y lanza más fuerte)",
	physicsCeilingBounce: "Rebote en el techo",
	physicsCeilingBounceHint: "Desactívalo para que un lanzamiento pueda salir por la parte superior de la pantalla (la gravedad sigue tirando de él hacia abajo)",
	physicsPetCollision: "Colisiones entre mascotas",
	physicsPetCollisionHint: "Una mascota en vuelo rebota contra las demás conservando el momento (masa ∝ tamaño²)",
	physicsHaptic: "Vibración al chocar",
	physicsHapticHint: "Una vibración por impacto (paredes, suelo, techo, otras mascotas). Funciona en Chrome/Edge; no en iOS ni en navegadores WebView como Via. El modo No molestar la bloquea.",
	physicsTilt: "Gravedad por inclinación",
	physicsTiltHint: "Inclina el móvil y la gravedad lo sigue (magnitud = el valor de arriba); con gravedad en 0 la inclinación no hace nada. Requiere HTTPS/localhost.",
	physicsShake: "Agitar para lanzar",
	physicsShakeHint: "Agita para lanzar la mascota en la dirección del gesto; la fuerza escala con throwPower. No depende de la gravedad, así que funciona con gravedad 0. Requiere HTTPS/localhost.",
	invalidPhysics: "Revisa los parámetros de física: gravedad / fricción con el suelo ≥ 0, rebote 0–1, fuerza de lanzamiento > 0.",
	fontTitle: "Apariencia y fuente",
	fontHint: "La familia se aplica a todos los textos que ahora usan la fuente candy: globo de la mascota, tooltip al pasar el cursor, ventana de chat y ventana de puntuación. El tamaño solo se aplica al globo de la mascota y al tooltip (las ventanas de chat y de puntuación conservan su tamaño). Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo); se escribe en la configuración del usuario al \"Guardar\": al instante en el navegador y, en el escritorio, cuando Guardar recarga las ventanas de mascotas.",
	fontFamilyLabel: "Fuente",
	fontFamilyHint: "«Candy (integrada)» viene con el plugin; las demás son fuentes del sistema. Si una fuente no está instalada en esta máquina, se usa la siguiente de la pila (nunca queda en blanco ni da error).",
	fontSizeLabel: "Tamaño de fuente (px)",
	fontSizeHint: "Tamaño del texto del globo; el tooltip y las líneas pequeñas dentro del globo se escalan en proporción. Rango 4–200.",
	fontFollowToggle: "Escalar la fuente con el tamaño de la mascota",
	fontFollowToggleHint: "Activado (predeterminado): la fuente crece con la mascota; con 462 px de ancho es exactamente el tamaño de arriba. Desactivado: el tamaño queda fijo sin importar el tamaño de la mascota.",
	invalidFont: "Revisa la configuración de la fuente: la familia debe estar en la lista y el tamaño debe ser un número entre 4 y 200.",
	"font.candy": "Candy (integrada)",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "Predeterminada del sistema",
	modelTitle: "Chat y modelos",
	modelHint: "Qué modelo usa cada uno de susurros y chat, y cuánto historial lleva cada solicitud de chat. \"Seguir la conversación actual\" usa el modelo de tu conversación actual (predeterminado). Valor predeterminado global: se aplica a todas las mascotas y un pet pack puede sobrescribirlo en el archivo de su propio tipo. Las opciones vienen de la misma fuente que el selector de modelos de DSH y el host las sirve en vivo.",
	modelFollow: "Seguir la conversación actual",
	modelSearch: "Buscar modelos…",
	modelEmpty: "No hay modelos que coincidan.",
	modelNoModels: "No hay modelos disponibles.",
	modelLoading: "Actualizando la lista de modelos…",
	modelTriggerAria: "Seleccionar modelo, actual {model}",
	modelUnknown: " (configuración actual, no está en la lista)",
	modelNone: "Este proveedor no tiene modelos disponibles",
	whisperModelLabel: "Modelo de susurros",
	chatModelLabel: "Modelo de chat",
	modelFieldHint: "\"Seguir la conversación actual\" usa el modelo de la conversación; si el modelo elegido falla, se vuelve al modelo de la conversación y se reintenta una vez.",
	invalidModel: "Revisa la configuración del modelo: elige proveedor y modelo, o deja ambos vacíos (seguir la conversación actual).",
	modelCatalogFailed: "No se pudo cargar la lista de modelos (recarga la página para reintentar); tus valores actuales se conservan tal cual.",
	chatMemory: "Rondas de historial del chat",
	chatMemoryHint: "Cuántas rondas recientes lleva cada solicitud de chat (1 ronda = 1 pregunta + 1 respuesta; 0 = sin historial, cada mensaje empieza de cero). La memoria en sí lo guarda todo: esto solo decide cuánto entra en el contexto; más rondas recuerdan más y gastan más tokens. Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo).",
	invalidChatMemory: "Revisa las rondas de historial del chat: debe ser un número ≥ 0.",
	chatImageLimit: "Límite de imágenes en el chat",
	chatImageLimitHint: "Cuántos memes como máximo se listan al modelo durante el chat (\"los primeros N\" = los N que escribiste primero en la configuración; mueve al frente los que quieras enviar). Esa lista completa se adjunta a cada mensaje y los tokens crecen de forma lineal con la cantidad, así que una lista larga es puro gasto; limitarla a los primeros N hace que el modelo elija solo entre esos. 0 = sin límite (enviar todo). Valor integrado predeterminado: 10. Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo). Solo afecta a la selección de imágenes del chat: un susurro lleva solo el meme que sacó.",
	invalidChatImageLimit: "Revisa el límite de imágenes del chat: debe ser un número ≥ 0 (0 = sin límite).",
	notifyTest: "Probar notificación",
	notifyTestOk: "Notificación de prueba enviada; mírala abajo a la derecha del escritorio.",
	notifyDenyUnsupported: "Este entorno no admite notificaciones del sistema (no hay API Notification).",
	notifyDenyBlocked: "El navegador tiene bloqueado el permiso de notificaciones.",
	notifyDenyRejected: "Elegiste «Bloquear» en el aviso de permiso.",
	notifyDenyError: "Error al solicitar permiso",
	notifyGuide: "Guía: haz clic en el icono 🔒/ⓘ junto a la barra de direcciones → Configuración del sitio → Notificaciones → cámbialo a «Permitir» y luego recarga la página y reintenta.",
	homeLabel: "Directorio de datos",
	homeHint: "Dónde se guardan la configuración, las tareas, la memoria y los memes. Déjalo vacío para el valor predeterminado; reinicia DSH para aplicarlo.",
	homeApply: "Aplicar",
	homeReset: "Usar predeterminado",
	homeSaved: "Guardado. Reinicia DSH para aplicarlo.",
	homeFailed: "No se pudo guardar: usa una ruta absoluta con permiso de escritura.",
	homeEnvLocked: "El directorio está fijado por la variable de entorno DSH_PET_HOME.",
	storageTitle: "Desinstalación y almacenamiento",
	storageHint: "Todas las ubicaciones que escribe este plugin. Borrar las cachés no rompe nada (se vuelven a descargar/reconstruir); borrar los «datos de usuario del plugin» pierde la configuración y la memoria del chat.",
	"storage.userData": "Datos de usuario del plugin: configuración personalizada main-config.jsonc, memoria del chat memory.json, recursos de animación personalizados main-animation/, mascotas de archivo pet/",
	"storage.electron": "Runtime de Electron que usa la mascota de escritorio (grande; se vuelve a descargar automáticamente la próxima vez que se active el modo escritorio)",
	"storage.desktopCache": "Caché de las ventanas de mascotas de escritorio y caché de escala del monitor principal (se puede borrar, se reconstruye automáticamente)",
	"storage.electronCache": "Caché de descarga del instalador de Electron (se puede borrar, se vuelve a descargar cuando haga falta)",
	"storage.package": "El plugin en sí (lo gestiona DSH: quítalo con el comando de abajo en vez de borrarlo a mano)",
	storageMissing: " (aún no se ha creado)",
	uninstallTitle: "Cómo desinstalar",
	uninstallStep1: "1. Cierra DSH primero (la mascota de escritorio se cierra con él); no borres estos archivos mientras la mascota esté en ejecución.",
	uninstallStep2: "2. Quita el plugin en sí (ejecútalo en la terminal; también lo elimina de la capa de bundles del perfil):",
	uninstallStep3: "3. Borra las ubicaciones de arriba según necesites: las cachés no hacen daño; borrar los «datos de usuario del plugin» pierde la configuración y la memoria del chat (haz una copia de main-config.jsonc si quieres conservarla).",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/fr.ts
const fr = {
	nav: "Configuration des compagnons",
	intro: "Gérez plusieurs compagnons : chacun a sa taille et sa position (appliquées immédiatement après l'enregistrement).",
	petCardTitle: "Compagnon",
	avatarLabel: "Avatar",
	avatarHint: "La petite image affichée à côté des messages de ce compagnon dans le panneau de discussion. Sans envoi, le logo par défaut du plugin est utilisé ; un envoi prend effet immédiatement et remplace le précédent, sans cliquer sur « Enregistrer ».",
	avatarUpload: "Envoyer un avatar",
	avatarChange: "Changer",
	avatarUploading: "Envoi…",
	avatarUploaded: "Avatar mis à jour",
	petCardHint: "Réglages par compagnon : nom / taille / affichage / coin / décalages / les quatre interrupteurs de fonctionnalités. Cliquez sur « Enregistrer » en bas pour appliquer immédiatement.",
	globalTitle: "Interrupteurs globaux",
	globalHint: "Partagés par tous les compagnons (un pet pack peut les remplacer dans son propre fichier de type). Ces interrupteurs ne modifient que l'état local et sont écrits dans la configuration utilisateur lors de l'enregistrement (jamais immédiatement) ; les notifications système sont relues juste après l'enregistrement, sans rafraîchir la page.",
	cornerHint: "Le coin de l'écran auquel le compagnon se colle (par zone de travail de chaque écran en mode bureau).",
	marginXHint: "Distance horizontale au coin choisi (px) ; n'importe quel nombre.",
	marginYHint: "Distance verticale au coin choisi (px) ; n'importe quel nombre.",
	"cmd.chat": "Discussion",
	"cmd.pet": "Compagnon",
	"cmd.balance": "Solde",
	"shortcut.open": "Ouvrir le chat du compagnon",
	"shortcut.chat": "Ouvrir la fenêtre de chat",
	"shortcut.hear": "Saisie vocale",
	"shortcut.capture": "Capture d’écran vers le chat",
	shortcutCardTitle: "Raccourcis",
	shortcutCardHint: "Deux groupes une fois déployé : raccourcis du compagnon et raccourcis globaux.",
	shortcutRowChat: "Ouvrir le chat",
	shortcutRowHold: "Maintenir pour parler",
	shortcutRowHear: "Saisie vocale",
	shortcutRowCapture: "Capture d’écran",
	shortcutRowPaste: "Coller une image",
	shortcutRowTodo: "Tâches",
	shortcutRowSleep: "Dormir / réveiller",
	shortcutRowDisplay: "Position d’affichage",
	shortcutRowSidebar: "Ouvrir le chat latéral",
	shortcutGroupPet: "Raccourcis du compagnon",
	shortcutGroupPetHint: "Sur le web, il suffit de survoler le compagnon. Dans la fenêtre du bureau, cliquez d’abord sur le compagnon pour qu’il prenne le focus clavier.",
	shortcutGroupGlobal: "Raccourcis globaux",
	shortcutGroupGlobalHint: "Distribués par DSH dans le web et la fenêtre du bureau ; modifiables dans Réglages → Général → Raccourcis.",
	petsLabel: "Compagnons",
	add: "Ajouter un compagnon",
	remove: "Supprimer",
	confirmRemove: "Supprimer le compagnon « {id} » ?",
	confirmTitle: "Confirmer l'action",
	cancel: "Annuler",
	ok: "Compris",
	atLeastOne: "Gardez au moins un compagnon.",
	emptyPets: "Aucun compagnon pour l'instant — cliquez sur « Ajouter un compagnon » pour en créer un.",
	sizeLabel: "Taille (largeur px)",
	sizeHint: "La hauteur est automatique = largeur × 9/16.",
	sizePercentLabel: "Largeur d’écran max (%)",
	sizePercentHint: "Part de la largeur d’écran que le pet peut occuper : 100 = jamais plus large qu’un écran (identique au px sur une fenêtre large) ; 30–40 le rend nettement plus petit sur téléphone sans changer le bureau. Calculé une fois au chargement ; rechargez après redimensionnement.",
	nameLabel: "Nom",
	nameHint: "Affiché au survol du compagnon et ajouté aux personas de l'IA (« votre nom est X »). Les doublons sont permis ; laissé vide, l'identifiant du compagnon est utilisé.",
	personaLabel: "Persona (facultatif)",
	personaHint: "Ne concerne que ce compagnon. Laissez vide pour suivre le persona de l'entrée — le texte grisé dans le champ est exactement celui-ci. Le system réellement envoyé au modèle = ce texte + la ligne « votre nom est <nom> » ajoutée automatiquement + le contexte temporel courant ; ne répétez donc ni le nom ni la date ici.",
	personaCount: "{n} caractères",
	balanceEnabled: "Fonction solde",
	balanceEnabledHint: "Une fois activée, ce compagnon joue l'animation de solde et affiche la bulle de solde.",
	whisperEnabled: "Murmures",
	whisperEnabledHint: "Une fois activé, ce compagnon génère périodiquement une phrase via l'IA et joue l'animation de murmure (persona = le champ ci-dessous ; vide = celui de l'entrée).",
	workStatusEnabled: "Suivi de l'état de travail",
	workStatusEnabledHint: "Une fois activé, ce compagnon suit l'état de travail de DSH : réflexion / travail / attente de confirmation / terminé / erreur déclenchent l'animation correspondante et une bulle (le pool se trouve au niveau supérieur de la configuration ; écoute seule, aucun appel au modèle).",
	fixedEnabled: "Compagnon fixe",
	fixedEnabledHint: "Une fois activé, la chaîne aléatoire ne fait plus se retourner ni s'éloigner le compagnon — seules les actions sur place sont jouées. Les déclenchements par menu contextuel et par API, ainsi que les animations solde / murmure / état de travail, ne sont pas affectés.",
	displayLabel: "Affichage",
	displayHint: "web = navigateur seul / desktop = bureau seul / both = les deux / none = aucun",
	"display.web": "Navigateur seul",
	"display.desktop": "Bureau seul",
	"display.both": "Les deux",
	"display.none": "Aucun",
	cornerLabel: "Position",
	"corner.top-left": "En haut à gauche",
	"corner.top-right": "En haut à droite",
	"corner.bottom-left": "En bas à gauche",
	"corner.bottom-right": "En bas à droite",
	marginX: "Décalage horizontal",
	marginY: "Décalage vertical",
	save: "Enregistrer",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "Synchroniser",
	confirmSync: "Synchroniser ? La configuration par défaut intégrée (tous les champs + commentaires) remplacera la configuration utilisateur ; vos personnalisations actuelles seront perdues.",
	corruptTitle: "Configuration utilisateur corrompue — non enregistrée",
	corruptConfirm: "Enregistrer quand même",
	corruptBody: "Le fichier de configuration utilisateur est illisible (corrompu, JSON/JSONC invalide) : {path}. Enregistrer maintenant le reconstruit à partir de la liste blanche — tout son contenu actuel (animations / physics / memes, etc.) sera perdu. Annuler = ne pas toucher au fichier (corrigez-le puis enregistrez) ; Confirmer = enregistrer quand même (le contenu actuel du fichier est abandonné).",
	syncHint: "« Synchroniser » écrit la configuration par défaut intégrée (commentaires et tous les champs avancés compris) dans le fichier de configuration utilisateur, en écrasant vos personnalisations ; le fichier est ensuite modifiable directement. Deux réserves : (1) une fois créé, ce fichier est une couche de remplacement explicite — les changements ultérieurs des valeurs par défaut intégrées ne s'appliquent pas automatiquement (sauf nouvelle synchronisation ou suppression du fichier) ; (2) cliquer sur « Enregistrer » sur cette page réécrit le fichier à partir d'une liste blanche — les valeurs sont conservées, les commentaires disparaissent.",
	configMeta: "Configuration avancée (fichiers)",
	configMetaHint: "La configuration utilisateur peut remplacer la liste des compagnons / les pools d'animation / les poids ; rechargez la page ou redémarrez pour appliquer : rafraîchissez la page dans le navigateur, ou sur le bureau, clic droit sur un compagnon → « Recharger la configuration » (reconstruit toutes les fenêtres de compagnons). La configuration par défaut est la référence complète.",
	defaultConfig: "Configuration par défaut (lecture seule, référence complète)",
	userConfig: "Configuration utilisateur (remplacements personnalisés)",
	todosFile: "Données de tâches (texte, échéance et état ; les supprimer vide toutes les tâches)",
	animationDir: "Dossier des animations (pour ajouter ou personnaliser des animations)",
	memesDir: "Dossier des mèmes (pour ajouter ou personnaliser des images)",
	logFile: "Fichier journal (pour le dépannage ; peut être vidé)",
	logFileNote: "L'application de bureau n'a pas de console : tous les journaux d'exécution du plugin (démarrage, plantages / redémarrages des compagnons, erreurs et avertissements) sont écrits dans ce seul fichier — joignez-le à vos rapports de problème. Limité à 1 Mo ; une fois plein, seuls les 512 Ko les plus récents sont conservés.",
	saved: "Enregistré — les compagnons sont à jour immédiatement.",
	loadError: "Échec du chargement de la configuration",
	saveError: "Échec de l'enregistrement de la configuration. Vérifiez la connexion au serveur, les droits d'écriture du dossier de configuration et le journal du serveur.",
	saveInvalid: "Échec de l'enregistrement : configuration invalide. Vérifiez les valeurs et réessayez.",
	syncError: "Échec de la synchronisation. Vérifiez la connexion au serveur et les droits d'écriture du dossier de configuration.",
	loading: "Chargement de la configuration…",
	retry: "Réessayer",
	invalid: "Vérifiez votre saisie : la taille doit être positive ; les marges peuvent être n'importe quel nombre.",
	busy: "Enregistrement…",
	extraPetsHint: "{n} autre(s) type(s) proviennent de fichiers du dossier pet/ (<nom>-config.json + <nom>-animation/) ; basculez dessus dans la ligne « Types » ci-dessus. L'enregistrement écrit dans la configuration propre à chaque pack, jamais dans main-config.jsonc.",
	kindLabel: "Types",
	kindMain: "Intégré",
	lastOfKind: "« {entry} » n'a plus que ce compagnon — le supprimer ferait disparaître tout le type. Pour le retirer complètement, supprimez les fichiers du pack.",
	savePartial: "Compagnons principaux enregistrés, mais {names} n'ont pas pu être écrits : vérifiez que la configuration du pack est valide et que le dossier est accessible en écriture.",
	notifyToggle: "Notifications système",
	notifyToggleHint: "Notifications du système d'exploitation (en bas à droite du bureau) pour la fin d'une conversation, les échecs, les demandes de permission et les questions — uniquement lorsque cette fenêtre n'a pas le focus.",
	clickSoundToggle: "Son au clic",
	clickSoundToggleHint: "Joue le son intégré (assets/sound/click-duck.wav, volume 0,5) quand on clique sur un compagnon ; les clics répétés en moins de 100 ms ne sonnent qu'une fois, donc plusieurs compagnons ne se superposent jamais. Désactivez-le pour un silence total. Écrit dans la configuration utilisateur avec « Enregistrer ».",
	whisperImageToggle: "Images des murmures",
	whisperImageToggleHint: "Joindre un mème tiré au hasard dans le pool à chaque murmure (la correspondance des images se trouve dans le champ memes, au niveau supérieur de la configuration). Tokens : un murmure appelle déjà le modèle à chaque cycle ; l'image ajoute seulement le nom + la description de ce mème (environ 100 caractères / ~60 tokens) à la même requête — négligeable.",
	chatImageToggle: "Images de discussion",
	chatImageToggleHint: "L'IA choisit un mème du pool adapté au contexte (facultatif ; la correspondance se trouve dans le champ memes, au niveau supérieur de la configuration). Tokens : chaque message transporte tout le catalogue — actuellement environ 1,1 k caractères (~650 tokens, soit environ 11 fois le cas des murmures) et cela croît avec le nombre d'images ; désactivé, rien du tout n'est ajouté.",
	chatAnimationToggle: "Actions en discussion",
	chatAnimationToggleHint: "Une fois activé, la requête de discussion transporte la liste des animations jouables (toutes les actions de animations.categories) : si le modèle estime que la réplique joue réellement l'une d'elles, le compagnon la joue immédiatement ; sinon il répond seulement en texte. Tokens : chaque message transporte toute la liste ; désactivé, rien n'est ajouté. Valeur par défaut globale pour tous les compagnons (un pet pack peut la surcharger dans son propre fichier de configuration).",
	confineToggle: "Limiter à l'écran actuel",
	confineToggleHint: "Multi-écrans : une fois activé, le compagnon reste sur l'écran où il se trouve — un compagnon lancé ne rebondit que sur l'écran du relâchement (les jointures d'écrans font office de murs, il ne passe pas sur l'écran voisin) et l'errance autonome ne se fait que sur l'écran actuel (tout pas qui franchirait la jointure est annulé). Désactivé, il traverse les écrans comme d'habitude. Mode bureau uniquement — l'overlay du navigateur reste de toute façon dans la zone visible.",
	trayToggle: "Zone de notification",
	trayToggleHint: "Affiche une icône dans la zone de notification (barre de menus sur macOS) dès que le mode bureau démarre. Elle liste tous les compagnons de la configuration et permet de basculer chacun entre bureau et web / aucun — y compris ceux qui ne sont pas sur le bureau et n'ont donc aucune fenêtre à cliquer droit. Une fois désactivée, ramener un compagnon sur le bureau exige d'ouvrir le navigateur (la page de configuration, ou un clic droit sur le compagnon web). Windows range déjà ces icônes dans le panneau « icônes masquées ». Mode bureau uniquement.",
	requestBubbleToggle: "Bulle d'approbation",
	requestBubbleToggleHint: "Quand un appel d'outil attend votre approbation, ou que l'IA pose une question, le compagnon affiche les choix juste au-dessus : « Autoriser une fois / Refuser » ou une option, et la réponse repart aussitôt vers la session. Il ne prend la main que si une page compagnon est en ligne ; sinon, ou si l'interrupteur est coupé ou qu'une autre demande est en cours, le panneau natif de DSH s'en charge.",
	scheduleReminderToggle: "Rappels de tâches",
	scheduleReminderToggleHint: "Quand une tâche créée avec schedule_create arrive à échéance, le compagnon affiche un rappel (simple rappel : c'est toujours l'ordonnanceur DSH qui lance la session). Les changements d'heure sont repris automatiquement ; ignoré si aucun compagnon n'est en ligne, rattrapé à son retour. Écrit dans la configuration lors de l'enregistrement.",
	menuTitle: "Menu contextuel",
	menuHint: "Ce qui apparaît au clic droit sur la mascotte, et dans quel ordre. Faites glisser la poignée de gauche pour réordonner, et utilisez le bouton de droite pour afficher ou masquer un élément. Seuls les outils sont réordonnés : lecture d'animation, position d'affichage et « plus » tiers ont leurs propres conditions. Enregistré dans votre configuration lors de l'enregistrement.",
	menuMoveUp: "Monter",
	menuMoveDown: "Descendre",
	menuShow: "Afficher",
	menuHide: "Masquer",
	menuDrag: "Glisser pour réordonner",
	menuReset: "Réinitialiser",
	menuNote: "Les éléments masqués gardent leur place : les réafficher les remet au même endroit. Dans l'ordre par défaut, « Discuter » vient en premier.",
	voiceTitle: "Synthèse vocale",
	voiceHint: "Trois interrupteurs et une voix : l'interrupteur principal commande la lecture automatique, les deux sous-interrupteurs commandent chacun un type de message proactif. Tout est désactivé par défaut et écrit dans la configuration utilisateur lors de l'enregistrement (jamais immédiatement).",
	voiceEnabled: "Lecture vocale",
	voiceEnabledHint: "Interrupteur principal de la lecture automatique. Désactivé, les murmures périodiques et les rappels de tâches restent muets (les deux sous-interrupteurs ci-dessous n'ont alors aucun effet). Les murmures manuels, les réponses de discussion et le bouton haut-parleur du panneau de discussion ne sont pas concernés — vous les avez demandés, la surface qui les déclenche les lit directement. Cela ne décide que du son émis : bulles, mémoire de discussion et notifications système restent intactes ; un échec de synthèse est seulement journalisé et n'interrompt jamais la conversation.",
	voiceWhisperEnabled: "Lire les murmures",
	voiceWhisperEnabledHint: "Lit le murmure généré périodiquement (y compris un murmure manuel par clic droit ou par commande slash). Soumis à l'interrupteur principal ci-dessus. Désactivé par défaut — les murmures sont une narration de fond et ne doivent pas faire de bruit sans qu'on le demande.",
	voiceTodoEnabled: "Lire les rappels de tâches",
	voiceTodoEnabledHint: "Lit un rappel de tâche à son échéance (la bulle s'affiche toujours ; cet interrupteur décide seulement s'il est lu). Soumis à l'interrupteur principal ci-dessus. Désactivé par défaut.",
	voiceEngineLabel: "Moteur vocal",
	voiceEngineHint: "Quelle voix parle. Edge est la voix Microsoft intégrée : gratuite et prête à l’emploi. Breeze utilise votre propre clé d’API Breeze (modèle breeze-tts-2) ; les voix peuvent être créées ou clonées et sont facturées à votre compte. Cela ne choisit que la voix ; le fait de parler reste réglé par les trois interrupteurs ci-dessus.",
	voiceEngineEdge: "Intégré (Edge)",
	voiceEngineBreeze: "Breeze en ligne",
	breezeKeyLabel: "Clé d’API Breeze",
	breezeKeyHint: "Commence par brz_ ; copiez-la depuis la page « API Keys » du tableau de bord Breeze. Elle n’est stockée que dans votre configuration locale et écrite à l’enregistrement — ne la collez jamais dans un dépôt public ou une capture.",
	breezeVoiceLabel: "Voix Breeze",
	breezeVoiceAuto: "Automatique (première voix)",
	breezeVoiceHint: "Voix disponibles sur votre compte ; « Automatique » prend la première. Après un changement de clé, la nouvelle liste n’apparaît qu’après l’enregistrement.",
	breezeSpeedLabel: "Vitesse Breeze",
	breezeSpeedHint: "0,5–2×, 1 = normale. Partagée par l’écoute et l’annonce ; le moteur intégré l’ignore (il parle en pourcentage).",
	breezeStatusLabel: "Connexion",
	breezeStatusHint: "« Revérifier » demande la liste des voix à Breeze avec la clé enregistrée : si elle revient, la clé fonctionne. Les modifications non enregistrées ne sont pas vues.",
	breezeRefresh: "Revérifier",
	breezeNoKey: "Pas encore de clé — collez-la, enregistrez, puis « Revérifier ».",
	breezeBadKey: "La clé est invalide ou a été réinitialisée. Copiez-en une nouvelle depuis Breeze.",
	breezeListFailed: "Impossible de joindre Breeze (réseau ou service) ; la clé est peut-être valide.",
	breezeReady: "Clé valide, liste des voix chargée.",
	voiceNameLabel: "Voix",
	voiceVolumeLabel: "Volume",
	voiceVolumeHint: "Volume de lecture en décimal 0–1 : 1 correspond au volume maximal (100 %), 0 coupe le son. Seule l’intensité change et l’audio n’est pas resynthétisé, donc le régler ne coûte rien de plus. Indépendant de l’interrupteur général ci-dessus : il est sans effet quand celui-ci est désactivé.",
	voicePreview: "Écouter",
	voicePreviewSample: "Salut, je suis ta mascotte de bureau. Bonne journée !",
	voicePreviewHint: "Joue une phrase avec la voix choisie : c’est exactement ce que tu entendras après l’enregistrement. Laisse vide pour la phrase par défaut ou écris la tienne (500 caractères max).",
	voicePreviewBusy: "Synthèse…",
	voicePreviewFailed: "Échec de l’écoute : {msg}",
	physicsTitle: "Physique (ressenti du glisser-lancer)",
	physicsHint: "Valeurs par défaut globales, partagées par tous les compagnons (un pet pack peut les remplacer dans son propre fichier de type) ; écrites dans la configuration utilisateur lors de l'enregistrement (jamais immédiatement). Appliquées immédiatement dans le navigateur ; sur le bureau, après que l'enregistrement a rechargé les fenêtres des compagnons.",
	mobileTitle: "Effets mobiles",
	mobileHint: "Ces réglages n'ont de sens que dans un navigateur mobile : la vibration exige un moteur, les deux interrupteurs de mouvement exigent des capteurs d'inclinaison / d'accélération, et ces capteurs ne fonctionnent qu'en HTTPS ou sur localhost.",
	"physics.gravity": "Gravité",
	"physics.gravityHint": "px/s², plus la valeur est élevée, plus la chute est rapide ; 0 = apesanteur (trajectoire rectiligne uniforme)",
	"physics.restitution": "Rebond",
	"physics.restitutionHint": "0 à 1, proportion de vitesse conservée lors du rebond contre un mur ou le sol (1 = parfaitement élastique, 0 = arrêt net)",
	"physics.groundFriction": "Frottement de contact",
	"physics.groundFrictionHint": "par seconde, atténuation de la vitesse le long de toute surface touchée (mur, sol, plafond) ; 0 = verglas partout",
	"physics.throwPower": "Force de lancer",
	"physics.throwPowerHint": "> 0, multiplicateur global du suivi ressort et de la vitesse de lancer (1 = valeur par défaut ; plus haut = suivi plus ferme et lancers plus violents)",
	physicsCeilingBounce: "Rebond au plafond",
	physicsCeilingBounceHint: "Désactivé, un lancer peut sortir par le haut de l'écran (la gravité le ramène)",
	physicsPetCollision: "Collisions entre compagnons",
	physicsPetCollisionHint: "Un compagnon en vol rebondit sur les autres en conservant la quantité de mouvement (masse ∝ taille²)",
	physicsHaptic: "Vibration aux collisions",
	physicsHapticHint: "Une vibration par impact (murs, sol, plafond, autres compagnons). Fonctionne dans Chrome/Edge ; pas sur iOS ni dans les coques WebView comme Via. Le mode Ne pas déranger la bloque.",
	physicsTilt: "Gravité par inclinaison",
	physicsTiltHint: "Inclinez le téléphone : la gravité suit (valeur = celle ci-dessus) ; avec une gravité à 0, l’inclinaison n’a aucun effet. Nécessite HTTPS/localhost.",
	physicsShake: "Secouer pour lancer",
	physicsShakeHint: "Secouez pour lancer le compagnon dans le sens du geste ; la force suit throwPower. Indépendant de la gravité, donc utilisable à gravité 0. Nécessite HTTPS/localhost.",
	invalidPhysics: "Vérifiez les paramètres physiques : gravité / frottement au sol ≥ 0, rebond entre 0 et 1, force de lancer > 0.",
	fontTitle: "Apparence et police",
	fontHint: "La famille s'applique partout où la police bonbon est utilisée : bulle du compagnon, infobulle, fenêtre de discussion, fenêtre de score ; la taille ne concerne que la bulle et l'infobulle (les fenêtres de discussion et de score gardent la leur). Valeurs globales par défaut, partagées par tous les compagnons (un pet pack peut les remplacer dans son propre fichier de type) ; écrites dans la configuration utilisateur lors de l'enregistrement — immédiat dans le navigateur, et sur le bureau après rechargement des fenêtres par l'enregistrement.",
	fontFamilyLabel: "Police",
	fontFamilyHint: "« Bonbon (intégrée) » est fournie avec le plugin ; les autres sont des polices système. Si une police manque sur la machine, la pile passe à la suivante (jamais de vide ni d'erreur).",
	fontSizeLabel: "Taille de police (px)",
	fontSizeHint: "Taille du texte des bulles ; l'infobulle et les petites lignes de la bulle suivent proportionnellement. Plage 4 à 200.",
	fontFollowToggle: "Mettre la police à l'échelle du compagnon",
	fontFollowToggleHint: "Activé (par défaut) : la police grandit avec le compagnon — à 462 px de largeur, elle correspond exactement à la taille ci-dessus. Désactivé : la taille reste fixe quelle que soit la taille du compagnon.",
	invalidFont: "Vérifiez les réglages de police : la famille doit figurer dans la liste et la taille doit être un nombre entre 4 et 200.",
	"font.candy": "Bonbon (intégrée)",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "Police système",
	modelTitle: "Discussion et modèles",
	modelHint: "Quel modèle utilisent les murmures et la discussion, et combien d'historique chaque requête transporte. « Suivre la conversation actuelle » utilise le modèle de votre conversation en cours (par défaut). Valeur globale par défaut : s'applique à tous les compagnons, et un pet pack peut la remplacer dans son propre fichier de type. Les options viennent de la même source que le sélecteur de modèles de DSH, fournies en direct par l'hôte.",
	modelFollow: "Suivre la conversation actuelle",
	modelSearch: "Rechercher un modèle…",
	modelEmpty: "Aucun modèle correspondant.",
	modelNoModels: "Aucun modèle disponible.",
	modelLoading: "Actualisation de la liste des modèles…",
	modelTriggerAria: "Choisir un modèle, actuellement {model}",
	modelUnknown: " (configuration actuelle, absent de la liste)",
	modelNone: "Aucun modèle disponible pour ce fournisseur",
	whisperModelLabel: "Modèle des murmures",
	chatModelLabel: "Modèle de discussion",
	modelFieldHint: "« Suivre la conversation actuelle » utilise le modèle de la conversation ; si un modèle choisi échoue, le plugin revient au modèle de la conversation et réessaie une fois.",
	invalidModel: "Vérifiez les réglages de modèle : choisissez à la fois un fournisseur et un modèle, ou laissez les deux vides (suivre la conversation actuelle).",
	modelCatalogFailed: "Échec du chargement de la liste des modèles (rafraîchissez la page pour réessayer) ; vos valeurs actuelles sont conservées telles quelles.",
	chatMemory: "Tours d'historique de discussion",
	chatMemoryHint: "Nombre de tours récents transportés par chaque requête de discussion (1 tour = 1 question + 1 réponse ; 0 = aucun historique, chaque message repart de zéro). La mémoire elle-même conserve tout — cette valeur décide seulement de ce qui entre dans le contexte : plus elle est élevée, plus le compagnon se souvient, et plus cela coûte de tokens. Valeur globale par défaut, partagée par tous les compagnons (un pet pack peut la remplacer dans son propre fichier de type).",
	invalidChatMemory: "Vérifiez les tours d'historique : il faut un nombre ≥ 0.",
	chatImageLimit: "Limite d'images de discussion",
	chatImageLimitHint: "Nombre maximal de mèmes proposés au modèle pendant la discussion (« N premiers » = les N premières entrées de la configuration ; déplacez en tête celles que vous voulez voir partir en priorité). Toute la liste est jointe à chaque message et les tokens croissent linéairement avec le nombre, donc une longue liste coûte cher ; la limiter aux N premières restreint le choix du modèle à celles-là. 0 = aucune limite (tout envoyer). Valeur intégrée par défaut : 10. Valeur globale par défaut, partagée par tous les compagnons (un pet pack peut la remplacer dans son propre fichier de type). Discussion uniquement — un murmure ne porte que le mème tiré.",
	invalidChatImageLimit: "Vérifiez la limite d'images de discussion : il faut un nombre ≥ 0 (0 = aucune limite).",
	notifyTest: "Tester la notification",
	notifyTestOk: "Notification de test envoyée — regardez en bas à droite de votre bureau.",
	notifyDenyUnsupported: "Les notifications système ne sont pas prises en charge dans cet environnement (pas d'API Notification).",
	notifyDenyBlocked: "L'autorisation de notification est bloquée par le navigateur.",
	notifyDenyRejected: "Vous avez choisi « Bloquer » dans la demande d'autorisation.",
	notifyDenyError: "Échec de la demande d'autorisation",
	notifyGuide: "Marche à suivre : cliquez sur l'icône 🔒/ⓘ à gauche de la barre d'adresse → « Paramètres du site » → « Notifications » → choisissez « Autoriser », puis rafraîchissez la page et réessayez.",
	homeLabel: "Répertoire de données",
	homeHint: "Où sont stockés la configuration, les tâches, la mémoire et les mèmes. Laissez vide pour la valeur par défaut ; redémarrez DSH pour appliquer.",
	homeApply: "Appliquer",
	homeReset: "Valeur par défaut",
	homeSaved: "Enregistré. Redémarrez DSH pour appliquer.",
	homeFailed: "Échec de l’enregistrement : utilisez un chemin absolu avec droit d’écriture.",
	homeEnvLocked: "Le répertoire est imposé par la variable d’environnement DSH_PET_HOME.",
	storageTitle: "Désinstallation et stockage",
	storageHint: "Tous les emplacements où ce plugin écrit sur la machine. Supprimer les caches est sans risque (ils sont retéléchargés / reconstruits) ; supprimer les « données utilisateur du plugin » fait perdre la configuration et la mémoire de discussion.",
	"storage.userData": "Données utilisateur du plugin : configuration personnalisée main-config.jsonc, mémoire de discussion memory.json, animations personnalisées main-animation/, compagnons fichiers pet/",
	"storage.electron": "Runtime Electron du compagnon de bureau (volumineux ; retéléchargé automatiquement au prochain démarrage du mode bureau)",
	"storage.desktopCache": "Cache des fenêtres de compagnons et cache d'échelle de l'écran principal (suppression sans risque, reconstruit automatiquement)",
	"storage.electronCache": "Cache de téléchargement de l'installateur Electron (suppression sans risque, retéléchargé si besoin)",
	"storage.package": "Le plugin lui-même (géré par DSH — retirez-le avec la commande ci-dessous plutôt que de le supprimer à la main)",
	storageMissing: " (pas encore créé)",
	uninstallTitle: "Comment désinstaller",
	uninstallStep1: "1. Quittez d'abord DSH (le compagnon de bureau s'arrête avec lui) ; ne supprimez pas ces fichiers pendant que le compagnon tourne.",
	uninstallStep2: "2. Retirez le plugin lui-même (dans un terminal ; il est aussi retiré de la couche bundle du profil) :",
	uninstallStep3: "3. Supprimez les emplacements ci-dessus selon vos besoins : les caches sont sans risque ; supprimer les « données utilisateur du plugin » fait perdre la configuration et la mémoire de discussion (sauvegardez main-config.jsonc si vous voulez le garder).",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/ja.ts
const ja = {
	nav: "デスクトップペット設定",
	intro: "複数のペットを管理できます。ペットごとにサイズと位置を個別に設定できます（保存するとすぐに反映されます）。",
	petCardTitle: "ペットの設定",
	avatarLabel: "アバター",
	avatarHint: "チャットパネルでこのペットの発言の横に表示される小さな画像です。未アップロードならプラグインの既定画像が使われます。アップロードはすぐ反映され、以前の画像を上書きします（「保存」を押す必要はありません）。",
	avatarUpload: "アバターをアップロード",
	avatarChange: "変更",
	avatarUploading: "アップロード中…",
	avatarUploaded: "アバターを更新しました",
	petCardHint: "ペットごとに個別設定します：名前 / サイズ / 表示位置 / 位置 / オフセット / 4つの機能スイッチ。設定後、最下部の「保存」をクリックするとすぐに反映されます。",
	globalTitle: "グローバルスイッチ",
	globalHint: "すべてのペットに共通です（pet pack は自身の種類ファイルで個別に上書きできます）。これらのスイッチはローカル状態のみを変更し、「保存」時にまとめてユーザー設定へ書き込みます（即時書き込みはしません）。システム通知の設定は保存後すぐに再読み込みされ、ページの更新は不要です。",
	cornerHint: "ペットが画面のどの隅に貼り付くかを指定します（デスクトップでは各ディスプレイのワークエリア基準）。",
	marginXHint: "選択した隅からの水平距離（px）。任意の数値が使えます。",
	marginYHint: "選択した隅からの垂直距離（px）。任意の数値が使えます。",
	"cmd.chat": "チャット",
	"cmd.pet": "ペット",
	"cmd.balance": "残高",
	"shortcut.open": "ペット会話を開く",
	"shortcut.chat": "会話ウィンドウを開く",
	"shortcut.hear": "音声入力",
	"shortcut.capture": "スクリーンショットを会話へ",
	shortcutCardTitle: "ショートカット",
	shortcutCardHint: "開くと 2 グループに分かれます：ペットのショートカットとグローバルショートカット。",
	shortcutRowChat: "会話を開く",
	shortcutRowHold: "押して話す",
	shortcutRowHear: "音声入力",
	shortcutRowCapture: "スクリーンショット",
	shortcutRowPaste: "画像を貼り付け",
	shortcutRowTodo: "ToDo",
	shortcutRowSleep: "寝る / 起きる",
	shortcutRowDisplay: "表示位置",
	shortcutRowSidebar: "サイドバーの会話を開く",
	shortcutGroupPet: "ペットのショートカット",
	shortcutGroupPetHint: "Web はポインタをペットに合わせるだけ。デスクトップペットのウィンドウは、先にペットをクリックしてキーボードフォーカスを移してください。",
	shortcutGroupGlobal: "グローバルショートカット",
	shortcutGroupGlobalHint: "Web とデスクトップ版のウィンドウでは DSH が振り分けます。設定 → 一般 → ショートカットで変更できます。",
	petsLabel: "ペット一覧",
	add: "ペットを追加",
	remove: "削除",
	confirmRemove: "ペット「{id}」を削除しますか？",
	confirmTitle: "操作の確認",
	cancel: "キャンセル",
	ok: "了解",
	atLeastOne: "ペットは少なくとも1匹必要です。",
	emptyPets: "ペットがありません。「ペットを追加」をクリックして作成してください。",
	sizeLabel: "サイズ（幅 px）",
	sizeHint: "高さは自動 = 幅 × 9/16。",
	sizePercentLabel: "画面幅の上限（%）",
	sizePercentHint: "ペットが画面幅のどれだけを占めるかの上限です。100 = 画面幅を超えない（広いウィンドウでは px と完全に同じ）；30–40 にすると PC はそのままにスマホで明確に小さくなります。読み込み時に一度だけ計算されるので、ウィンドウサイズを変えたら再読み込みしてください。",
	nameLabel: "名前",
	nameHint: "表示名：ペットにマウスを重ねると表示され、AI のペルソナにも追加されます（あなたの名前は X）。重複も可能です。空欄の場合はペット id が使われます。",
	personaLabel: "ペルソナ（任意）",
	personaHint: "このペットだけに適用されます。空欄 = 所属するエントリのペルソナに従います（入力欄のグレーの文字がその内容です）。実際にモデルへ送る system = このテキスト + 自動追加される「あなたの名前は“<名前>”」+ 現在時刻のコンテキスト。ここに名前や日付を再度書かないでください。",
	personaCount: "{n} 文字",
	balanceEnabled: "残高機能",
	balanceEnabledHint: "有効にすると、このペットが残高アニメーションを再生し、残高バブルを表示します。",
	whisperEnabled: "ひとりごと",
	whisperEnabledHint: "有効にすると、このペットが定期的に AI で一言を生成し、ひとりごとアニメーションを再生します（ペルソナは下の「ペルソナ」欄。空欄ならエントリに従います）。",
	workStatusEnabled: "作業状態の連動",
	workStatusEnabledHint: "有効にすると、このペットが DSH の作業状態に追従します：思考中 / 作業中 / 確認待ち / 完了 / エラー時に、対応するアニメーションへ切り替えてバブルを表示します（アニメーションプールは設定のトップレベル。監視のみでモデルは呼び出しません）。",
	fixedEnabled: "ペットを固定",
	fixedEnabledHint: "有効にすると、ランダムアニメーションでペットが方向転換したり歩き去ったりしなくなり、その場の待機とランダムな小さな動作だけを再生します。右クリックメニューからの再生、API トリガー、残高 / ひとりごと / 作業状態のアニメーションには影響しません。",
	displayLabel: "表示位置",
	displayHint: "web=ブラウザのみ / desktop=デスクトップのみ / both=両方 / none=どちらも非表示",
	"display.web": "ブラウザのみ",
	"display.desktop": "デスクトップのみ",
	"display.both": "両方に表示",
	"display.none": "どちらも非表示",
	cornerLabel: "位置",
	"corner.top-left": "左上",
	"corner.top-right": "右上",
	"corner.bottom-left": "左下",
	"corner.bottom-right": "右下",
	marginX: "水平オフセット",
	marginY: "垂直オフセット",
	save: "保存",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "同期",
	confirmSync: "同期しますか？プロジェクト内蔵のデフォルト設定（全フィールド + コメント）でユーザー設定を上書きするため、現在のカスタマイズ内容は失われます。",
	corruptTitle: "ユーザー設定が破損しているため保存されませんでした",
	corruptConfirm: "強制保存",
	corruptBody: "ユーザー設定ファイルを解析できません（内容が破損しており、正しい JSON/JSONC ではありません）：{path}。保存を続けるとホワイトリストに従ってこのファイルを再構築します——現在このファイルにある内容（animations / physics / memes などのカスタムフィールド）はすべて失われます。キャンセル = ファイルを変更しない（設定を正しい形式に戻してから保存）；確認 = 強制保存（ファイル内の既存内容を破棄）。",
	syncHint: "「同期」はプロジェクト内蔵のデフォルト設定（コメントとすべての高度なフィールドを含む）をユーザー設定ファイルへ書き込み、現在のカスタマイズ内容を上書きします。その後はこのファイルを直接編集できます。注意点が2つあります：① ファイルが一度生成されると明示的な上書きレイヤーになるため、プラグイン更新後の内蔵デフォルトの変更は自動では反映されません（再度同期するか、ファイルを削除するまで）。② このページで「保存」をクリックすると、ホワイトリストに従ってファイルが書き換えられます（フィールド値は保持されますが、コメントは削除されます）。",
	configMeta: "詳細設定（ファイル）",
	configMetaHint: "ユーザー設定はペット一覧 / アニメーションプール / 再生ウェイトを上書きできます。変更後は更新または再起動で反映されます：ブラウザではページを更新、デスクトップではペットを右クリック →「設定を再読み込み」（すべてのデスクトップペットウィンドウを再読み込み）。デフォルト設定が完全なリファレンスです。",
	defaultConfig: "デフォルト設定（読み取り専用、完全なリファレンス）",
	userConfig: "ユーザー設定（カスタム上書き）",
	todosFile: "ToDo データ（リストの内容、期限、完了状態。削除すると ToDo がすべて消えます）",
	animationDir: "アニメーション素材ディレクトリ（アニメーションをカスタマイズ / 追加できます）",
	memesDir: "ミーム画像ディレクトリ（画像をカスタマイズ / 追加できます）",
	logFile: "ログファイル（トラブルシューティング用。消去しても問題ありません）",
	logFileNote: "デスクトップ版にはコンソールがないため、プラグインの実行ログ（起動、デスクトップペットのクラッシュ / 再起動、エラーと警告）はすべてこの1つのファイルに書き込まれます。問題を報告する際はこのファイルを添付してください。1ファイルあたり最大 1 MB で、いっぱいになると最新の 512 KB だけが残ります。",
	saved: "保存しました。ペットにすぐ反映されました。",
	loadError: "設定の読み込みに失敗しました",
	saveError: "設定の保存に失敗しました。サーバー接続、設定ディレクトリの書き込み権限、サーバーログを確認してください。",
	saveInvalid: "設定の保存に失敗しました：設定内容が無効です。確認してから再試行してください。",
	syncError: "設定の同期に失敗しました。サーバー接続と設定ディレクトリの書き込み権限を確認してください。",
	loading: "設定を読み込み中…",
	retry: "再試行",
	invalid: "入力を確認してください：サイズは正の数、余白は任意の数値です。",
	busy: "保存中…",
	extraPetsHint: "ほかに {n} 種類が pet/ ディレクトリのファイル（<名>-config.json + <名>-animation/）から読み込まれます。上の「種類」バーで切り替えて変更できます。保存は各キャラクターパックの設定に書き戻され、main-config.jsonc には混ざりません。",
	kindLabel: "種類",
	kindMain: "内蔵",
	lastOfKind: "「{entry}」はこの1匹だけです。削除するとこの種類自体がなくなります。完全に削除するには、そのキャラクターパックのファイルを直接削除してください。",
	savePartial: "メインペットは保存されましたが、{names} を書き戻せませんでした：そのキャラクターパックの設定が正しいか、ディレクトリが書き込み可能かを確認してください。",
	notifyToggle: "システム通知",
	notifyToggleHint: "会話の完了 / 生成失敗 / 権限リクエスト / ユーザーへの確認を、ウィンドウが非アクティブのときに OS レベルの通知（デスクトップ右下）で表示します。",
	clickSoundToggle: "クリック音",
	clickSoundToggleHint: "ペットをクリックすると内蔵の効果音（assets/sound/click-duck.wav、音量 0.5）が一度鳴ります。100ms 以内の連続クリックは1回だけ鳴り、複数起動しても重なりません。オフにすると完全に無音になります。「保存」と一緒にユーザー設定へ書き込まれます。",
	whisperImageToggle: "ひとりごとの画像",
	whisperImageToggleHint: "ひとりごとのとき、ミーム画像プールからランダムに1枚を選び、その一言と一緒に表示します（画像のマッピングは設定ファイルのトップレベル memes）。トークン：ひとりごとは元々毎回モデルを呼ぶので、選んだ画像の名前 + 説明（約100文字 / ≈60トークン）を同じリクエストに加えるだけで、増分はごくわずかです。",
	chatImageToggle: "チャットの画像",
	chatImageToggleHint: "チャット時、AI が現在の文脈に合う画像をミーム画像プールから1枚選びます（選ばないこともできます。画像のマッピングは設定ファイルのトップレベル memes）。トークン：メッセージごとに一覧全体をリクエストに添付するため、現在約 1.1k 文字（≈650トークン、ひとりごと画像の約11倍）で、画像の数に比例して増えます。オフにすると1文字も添付しません。",
	chatAnimationToggle: "チャットのアクション",
	chatAnimationToggleHint: "オンにすると、チャット時に演じられるアニメーション一覧（animations.categories の全アクション）をモデルに渡します。この一言が実際にその動作を演じているとモデルが判断したときだけ、ペットがその場で演じます。合うものがなければ文字だけの返答になります。トークン：メッセージごとに一覧全体を添付します。オフなら 1 つも添付しません。グローバル既定で全ペット共通（pet pack は自分の設定ファイルで上書き可）。",
	confineToggle: "現在の画面に固定",
	confineToggleHint: "マルチディスプレイの場合：オンにすると、ペットは現在いる画面の中だけで動きます。投げたペットは離したときの画面内でだけ跳ね（画面の境目は壁として扱われ、隣の画面へは飛びません）、自動での徘徊も現在いる画面内だけを歩きます（境目を越える一歩はその場でキャンセル）。オフにすると従来どおり画面をまたいで飛んだり歩いたりします。デスクトップモードのみに影響します。ブラウザのオーバーレイは元々ビューポート内だけで動きます。",
	trayToggle: "システムトレイ",
	trayToggleHint: "デスクトップモード起動後、通知領域（macOS ではメニューバー）にアイコンを常駐させ、設定に含まれるすべてのペットを一覧表示します。チェックを入れると、そのペットの表示位置を切り替えられます——現在デスクトップに表示されておらず、右クリックできるウィンドウがないペットも含みます。オフにすると、ペットをデスクトップに戻すにはブラウザで設定ページを開くか、Web 側のペットを右クリックするしかありません。Windows では元々「隠れたアイコン」に折りたたまれます。デスクトップモードのみに影響します。",
	requestBubbleToggle: "承認バブル",
	requestBubbleToggleHint: "ツール呼び出しの承認や AI からの質問を、ペットの頭上にそのまま表示します。「今回だけ許可 / 拒否」を押すか選択肢を選ぶと、回答はすぐにセッションへ返ります。ペットページがオンラインのときだけ引き継ぎ、オフライン・スイッチがオフ・別のリクエスト処理中はいずれも DSH 標準パネルに戻します。",
	scheduleReminderToggle: "タスクのリマインダー",
	scheduleReminderToggleHint: "schedule_create で作ったタスクの時刻になると、ペットがバブルで知らせます（通知のみ。セッションを起動するのは DSH のスケジューラです）。時刻の変更は自動で反映され、ペットページがオフラインのときはスキップして復帰後に補います。「保存」でユーザー設定に書き込みます。",
	menuTitle: "右クリックメニュー",
	menuHint: "ペットを右クリックしたときに出る項目と並び順。左のつまみをドラッグすると並べ替え、右のボタンで表示・非表示を切り替えます。並べ替えられるのはツール項目だけです。アニメーション再生・表示位置・サードパーティの「その他」は表示条件が別なので、ここでは並べ替えません。保存でユーザー設定に書き込まれます。",
	menuMoveUp: "上へ",
	menuMoveDown: "下へ",
	menuShow: "表示",
	menuHide: "非表示",
	menuDrag: "ドラッグで並べ替え",
	menuReset: "既定に戻す",
	menuNote: "非表示にした項目も位置は残るので、もう一度「表示」にすると元の場所に戻ります。既定の順序では「会話」が先頭です。",
	voiceTitle: "音声読み上げ",
	voiceHint: "ペットが音を出すための3つのスイッチと声質：マスタースイッチが自動読み上げを制御し、2つのサブスイッチがそれぞれ異なる種類の自発メッセージを制御します。デフォルトはすべてオフで、「保存」時にユーザー設定へ書き込まれます（即時書き込みはしません）。",
	voiceEnabled: "音声読み上げ",
	voiceEnabledHint: "自動読み上げのマスタースイッチです。オフにすると、定期的なひとりごとと ToDo リマインダーは読み上げません（下の2つのサブスイッチは無効になります）。手動のひとりごと、チャットの返信、チャットパネルのスピーカーボタンは制限されません——これらはあなたが明示的に操作したもので、操作した画面側がそのまま読み上げます。「声を出すかどうか」だけに影響します：バブル、会話メモリ、システム通知は変わりません。音声合成に失敗した場合はログに残すだけで、会話を中断しません。",
	voiceWhisperEnabled: "ひとりごとの読み上げ",
	voiceWhisperEnabledHint: "定期的に生成されるひとりごとを読み上げます。右クリックの手動ひとりごとも、スラッシュコマンドによるひとりごとも、すべてこの項目に従います。上のマスタースイッチに従います：マスタースイッチがオフのときはこの項目は無効です。デフォルトはオフ——ひとりごとは背景ナレーションなので、デフォルトで声を出すべきではありません。",
	voiceTodoEnabled: "ToDo の読み上げ",
	voiceTodoEnabledHint: "期限が来た ToDo リマインダーを読み上げます（同じ文言でバブルも表示され、この項目は読み上げるかどうかだけを決めます）。上のマスタースイッチに従います。デフォルトはオフです。",
	voiceEngineLabel: "音声エンジン",
	voiceEngineHint: "どちらの声で話すか。edge は内蔵の Microsoft 音声で、無料ですぐ使えます。breeze は自分の Breeze API キー（breeze-tts-2 モデル）を使い、音声は作成・クローンでき、料金はアカウントに課金されます。決めるのは「どの声か」だけで、読み上げるかどうかは上の 3 つのスイッチ次第です。",
	voiceEngineEdge: "内蔵（Edge）",
	voiceEngineBreeze: "Breeze オンライン",
	breezeKeyLabel: "Breeze API キー",
	breezeKeyHint: "brz_ で始まるキーを Breeze 管理画面の「API Keys」からコピーします。ローカルの設定ファイルにのみ保存され、「保存」で書き込まれます。公開リポジトリやスクリーンショットに貼らないでください。",
	breezeVoiceLabel: "Breeze の声",
	breezeVoiceAuto: "自動（先頭の声）",
	breezeVoiceHint: "アカウントで使える声です。「自動」は先頭を選びます。キーを変えた場合、保存後に新しい一覧が取得されます。",
	breezeSpeedLabel: "Breeze の速度",
	breezeSpeedHint: "0.5〜2 倍、1 が原速。試聴と読み上げで共通です。内蔵エンジンは割合指定なので影響しません。",
	breezeStatusLabel: "接続状態",
	breezeStatusHint: "「再確認」は保存済みのキーで Breeze から声の一覧を取得します。取得できればキーは有効です。未保存の変更は反映されません。",
	breezeRefresh: "再確認",
	breezeNoKey: "キーが未入力です。入力して保存し、「再確認」を押してください。",
	breezeBadKey: "キーが無効か、リセットされています。Breeze で新しいキーをコピーしてください。",
	breezeListFailed: "Breeze に接続できません（ネットワークかサービス側の問題）。キー自体は正常かもしれません。",
	breezeReady: "キーは有効です。声の一覧を取得しました。",
	voiceNameLabel: "声質",
	voiceVolumeLabel: "音量",
	voiceVolumeHint: "読み上げの音量（0〜1 の小数）。1 が最大音量（100%）、0 は消音です。変わるのは再生の大きさだけで、音声の再合成は行いません。上の総スイッチとは別の設定で、総スイッチが切のときは効果がありません。",
	voicePreview: "試聴",
	voicePreviewSample: "こんにちは、あなたのデスクトップペットです。今日も頑張りましょう！",
	voicePreviewHint: "選んだ音色で一度読み上げます。保存後の読み上げと同じ音になります。空欄なら既定の文、自分の言葉にも変えられます（500 文字まで）。",
	voicePreviewBusy: "合成中…",
	voicePreviewFailed: "試聴に失敗しました：{msg}",
	physicsTitle: "物理（ドラッグ＆投げの感触）",
	physicsHint: "グローバルデフォルトで、すべてのペットに共通です（pet pack は自身の種類ファイルで個別に上書きできます）。「保存」時にユーザー設定へ書き込まれます（即時書き込みはしません）。ブラウザでは保存後すぐに反映され、デスクトップでは保存でペットウィンドウが再読み込みされてから反映されます。",
	mobileTitle: "モバイル向け効果",
	mobileHint: "スマホのブラウザでのみ意味があります。振動にはモーター、2 つの体感スイッチには傾き／加速度センサーが必要で、センサーは HTTPS または localhost でのみ使えます。",
	"physics.gravity": "重力",
	"physics.gravityHint": "px/s²。大きいほど速く落下します。0 = 無重力（投げると等速直線運動で飛び続けます）",
	"physics.restitution": "弾性",
	"physics.restitutionHint": "0～1。壁や床に当たったときに残る速度の割合（1 = 完全弾性、0 = 当たった瞬間に停止）",
	"physics.groundFriction": "接触摩擦",
	"physics.groundFrictionHint": "/s。壁・床・天井に当たった後の接線方向の速度の減衰率。0 = どの面も氷のよう",
	"physics.throwPower": "投げる力",
	"physics.throwPowerHint": "> 0。バネの追従性と投げ出しの初速の全体倍率（1 = デフォルト。大きいほどよく追従し、勢いよく飛びます）",
	physicsCeilingBounce: "天井での跳ね返り",
	physicsCeilingBounceHint: "オフにすると、投げたペットが画面の上端を越えて飛び出せます（重力が引き戻します）",
	physicsPetCollision: "ペット同士の衝突",
	physicsPetCollisionHint: "飛行中のペットが他のペットに当たると、運動量保存に従って弾き返されます（質量 ∝ サイズ²）",
	physicsHaptic: "衝突時の振動",
	physicsHapticHint: "壁・床・天井・ペット同士の衝突ごとに 1 回振動します。Chrome / Edge で動作。iOS と Via のような WebView ブラウザでは無効。サイレント/集中モードは振動を止めます。",
	physicsTilt: "傾きで重力",
	physicsTiltHint: "端末を傾けると重力がそちらへ向かいます（大きさは上の重力値）。重力が 0 のときは傾けても効果がありません。HTTPS/localhost が必要です。",
	physicsShake: "振って投げる",
	physicsShakeHint: "振った方向へペットを飛ばします。強さは投げる力（throwPower）に比例し、重力とは無関係なので重力 0 でも使えます。HTTPS/localhost が必要です。",
	invalidPhysics: "物理パラメータを確認してください：重力 / 地面摩擦 ≥ 0、弾性 0～1、投げる力 > 0。",
	fontTitle: "外観とフォント",
	fontHint: "フォントの種類は、現在キャンディフォントを使用しているすべてのテキストに適用されます：ペットのバブル、ホバーツールチップ、チャットウィンドウ、スコアポップアップ。文字サイズはペットのバブルとホバーツールチップだけに適用されます（チャットウィンドウとスコアポップアップの文字サイズは変わりません）。グローバルデフォルトで、すべてのペットに共通です（pet pack は自身の種類ファイルで個別に上書きできます）。「保存」時にユーザー設定へ書き込まれ、ブラウザでは保存後すぐに反映、デスクトップでは保存でペットウィンドウが再読み込みされてから反映されます。",
	fontFamilyLabel: "フォント",
	fontFamilyHint: "「キャンディフォント（内蔵）」はプラグインに同梱されています。それ以外はシステムフォントで、このマシンにインストールされていない場合はフォントスタックの次のものへ自動的にフォールバックします（空白になったりエラーになったりはしません）。",
	fontSizeLabel: "文字サイズ（px）",
	fontSizeHint: "バブル本文の文字サイズ。ツールチップとバブル内の小さい文字は既存の比率で算出されます。範囲は 4～200。",
	fontFollowToggle: "文字サイズをペットの大きさに合わせて拡大縮小",
	fontFollowToggleHint: "オン（デフォルト）：ペットを大きくすると文字サイズも比例して大きくなり、幅 462 のときに上の設定値と一致します。オフ：文字サイズは一定で、ペットの大きさに左右されません。",
	invalidFont: "フォント設定を確認してください：フォントはドロップダウンリスト内、文字サイズは 4～200 の数値である必要があります。",
	"font.candy": "キャンディフォント（内蔵）",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "システムデフォルト",
	modelTitle: "会話とモデル",
	modelHint: "ひとりごととチャットがそれぞれどのモデルを使うか、またチャットが毎回何ラウンドの履歴をコンテキストに含めるか。「現在の会話に従う」= 現在の会話で使っているモデルを使用（デフォルト）。グローバルデフォルト：すべてのペットに適用され、pet pack は自身の種類ファイルで個別に上書きできます。選択肢は DSH のモデルピッカーと同じソースからホストがリアルタイムに提供します。",
	modelFollow: "現在の会話に従う",
	modelSearch: "モデルを検索…",
	modelEmpty: "一致するモデルがありません。",
	modelNoModels: "利用できるモデルがありません。",
	modelLoading: "モデル一覧を更新中…",
	modelTriggerAria: "モデルを選択（現在 {model}）",
	modelUnknown: " （現在の設定、一覧にありません）",
	modelNone: "このプロバイダーに利用できるモデルはありません",
	whisperModelLabel: "ひとりごとモデル",
	chatModelLabel: "チャットモデル",
	modelFieldHint: "「現在の会話に従う」= 現在の会話のモデルを使用。指定しても呼び出しに失敗した場合は、現在の会話のモデルへ自動的にフォールバックして1回再試行します。",
	invalidModel: "モデル設定を確認してください：プロバイダーとモデルは両方選択するか、両方空欄（現在の会話に従う）にしてください。",
	modelCatalogFailed: "モデル一覧の読み込みに失敗しました（ページを更新すると再試行できます）。現在の設定値はそのまま保持されます。",
	chatMemory: "会話履歴のラウンド数",
	chatMemoryHint: "各チャットリクエストに含める直近の履歴ラウンド数（1ラウンド = 1問1答。0 = 履歴なしで、毎回まったく新しい会話）。会話メモリ自体はすべて保存され、削除されません。この値はコンテキストに何ラウンド分を含めるかだけを決めます——大きいほどよく覚えていますが、トークンも多く消費します。グローバルデフォルトで、すべてのペットに共通です（pet pack は自身の種類ファイルで個別に上書きできます）。",
	invalidChatMemory: "会話履歴のラウンド数を確認してください：0 以上の数値である必要があります。",
	chatImageLimit: "チャット画像の上限枚数",
	chatImageLimitHint: "チャット時にモデルへ送るミーム画像一覧の最大枚数（「先頭 N 枚」= 設定の先頭に書いた N 件。優先して送りたい画像は順番を前にしてください）。一覧全体はメッセージごとに添付され、トークンは枚数に比例して増えるため、多いとそのままコストになります。先頭 N 枚に制限すると、モデルはその中からだけ選びます。0 = 制限なし（すべて送信）。内蔵デフォルトは 10。グローバルデフォルトで、すべてのペットに共通です（pet pack は自身の種類ファイルで上書きできます）。影響するのはチャットの画像選択だけです：ひとりごとは選んだ1枚だけを含めます。",
	invalidChatImageLimit: "チャット画像の上限枚数を確認してください：0 以上の数値である必要があります（0 = 制限なし）。",
	notifyTest: "テスト通知",
	notifyTestOk: "テスト通知を送信しました。デスクトップの右下を確認してください。",
	notifyDenyUnsupported: "この環境ではシステム通知がサポートされていません（ブラウザに Notification API がありません）。",
	notifyDenyBlocked: "通知権限がブラウザによって「ブロック」に設定されています。",
	notifyDenyRejected: "権限確認のダイアログで「ブロック」を選択しました。",
	notifyDenyError: "権限の要求中にエラーが発生しました",
	notifyGuide: "ガイド：アドレスバー左側の 🔒/ⓘ →「サイトの設定」→「通知」→「許可」に変更し、ページを更新してから再試行してください。",
	homeLabel: "データディレクトリ",
	homeHint: "設定・ToDo・メモリー・ミームなどの保存先。空欄で既定値に戻ります。変更後は DSH の再起動が必要です。",
	homeApply: "適用",
	homeReset: "既定に戻す",
	homeSaved: "保存しました。DSH を再起動すると反映されます。",
	homeFailed: "保存できませんでした。絶対パスと書き込み権限を確認してください。",
	homeEnvLocked: "このディレクトリは環境変数 DSH_PET_HOME で固定されています。",
	storageTitle: "アンインストールとストレージ",
	storageHint: "プラグインがこの PC 上に作成されるすべての場所です。キャッシュを削除しても使用に影響はありません（自動的に再ダウンロード / 再構築されます）。「プラグインのユーザーデータ」を削除すると、設定と会話メモリが失われます。",
	"storage.userData": "プラグインのユーザーデータ：カスタム設定 main-config.jsonc、会話メモリ memory.json、カスタムアニメーション素材 main-animation/、ファイル型ペット pet/",
	"storage.electron": "デスクトップペットが使う Electron ランタイム（サイズが大きい。削除すると次回デスクトップモード起動時に自動で再ダウンロードされます）",
	"storage.desktopCache": "デスクトップペットウィンドウのキャッシュとメインディスプレイのスケールキャッシュ（削除しても問題ありません。自動で再構築されます）",
	"storage.electronCache": "Electron インストーラーのダウンロードキャッシュ（削除しても問題ありません。必要時に再ダウンロードされます）",
	"storage.package": "プラグイン本体（DSH が管理します。手動で削除せず、下のアンインストールコマンドで削除してください）",
	storageMissing: " （未作成）",
	uninstallTitle: "アンインストール方法",
	uninstallStep1: "1. まず DSH を終了します（デスクトップペットも一緒に終了します）。ペットの実行中に上記のファイルを削除しないでください。",
	uninstallStep2: "2. プラグイン本体を削除します（ターミナルで実行します。profile の bundle レイヤーからも同時に削除されます）：",
	uninstallStep3: "3. 上記の場所を必要に応じて削除します：キャッシュは削除しても影響ありません。「プラグインのユーザーデータ」を削除すると設定と会話メモリが失われます（残したい場合は中の main-config.jsonc を先にバックアップしてください）。",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/pt.ts
const pt = {
	nav: "Configuração do pet",
	intro: "Gerencie vários pets: cada um tem tamanho e posição próprios (aplicado na hora após salvar).",
	petCardTitle: "Pet",
	avatarLabel: "Avatar",
	avatarHint: "A imagem pequena exibida ao lado das mensagens deste pet no painel de conversa. Sem envio, usa-se o logotipo padrão do plugin; o envio vale na hora e substitui o anterior, sem clicar em \"Salvar\".",
	avatarUpload: "Enviar avatar",
	avatarChange: "Trocar",
	avatarUploading: "Enviando…",
	avatarUploaded: "Avatar atualizado",
	petCardHint: "Ajustes por pet: nome / tamanho / exibição / posição / deslocamentos / os quatro interruptores. Clique em \"Salvar\" no fim para aplicar na hora.",
	globalTitle: "Interruptores globais",
	globalHint: "Compartilhados por todos os pets (um pet pack pode sobrescrevê-los no arquivo do próprio tipo). Estes interruptores só mudam o estado local e são gravados na configuração do usuário ao \"Salvar\" (nunca na hora); as notificações do sistema são relidas logo após salvar, sem recarregar a página.",
	cornerHint: "Em qual canto da tela o pet fica (no desktop, conforme a área de trabalho de cada monitor).",
	marginXHint: "Distância horizontal até o canto escolhido (px); qualquer número.",
	marginYHint: "Distância vertical até o canto escolhido (px); qualquer número.",
	"cmd.chat": "Conversa",
	"cmd.pet": "Pet",
	"cmd.balance": "Saldo",
	"shortcut.open": "Abrir o chat do pet",
	"shortcut.chat": "Abrir a janela de chat",
	"shortcut.hear": "Entrada de voz",
	"shortcut.capture": "Captura de tela para o chat",
	shortcutCardTitle: "Atalhos",
	shortcutCardHint: "Ao expandir há dois grupos: atalhos do pet e atalhos globais.",
	shortcutRowChat: "Abrir chat",
	shortcutRowHold: "Segurar para falar",
	shortcutRowHear: "Entrada de voz",
	shortcutRowCapture: "Captura de tela",
	shortcutRowPaste: "Colar imagem",
	shortcutRowTodo: "Tarefas",
	shortcutRowSleep: "Dormir / acordar",
	shortcutRowDisplay: "Posição de exibição",
	shortcutRowSidebar: "Abrir chat lateral",
	shortcutGroupPet: "Atalhos do pet",
	shortcutGroupPetHint: "Na web basta passar o ponteiro sobre o pet. Na janela do desktop, clique no pet primeiro para ele receber o foco do teclado.",
	shortcutGroupGlobal: "Atalhos globais",
	shortcutGroupGlobalHint: "São distribuídos pelo DSH na web e na janela do desktop; mudam em Configurações → Geral → Atalhos.",
	petsLabel: "Pets",
	add: "Adicionar pet",
	remove: "Remover",
	confirmRemove: "Excluir o pet \"{id}\"?",
	confirmTitle: "Confirmar ação",
	cancel: "Cancelar",
	ok: "Entendi",
	atLeastOne: "Mantenha pelo menos um pet.",
	emptyPets: "Nenhum pet ainda — clique em \"Adicionar pet\" para criar.",
	sizeLabel: "Tamanho (largura px)",
	sizeHint: "A altura é automática = largura × 9/16.",
	sizePercentLabel: "Largura máx. da tela (%)",
	sizePercentHint: "Quanto da largura da tela o pet pode ocupar: 100 = nunca mais largo que uma tela (igual ao px em janelas largas); 30–40 deixa bem menor no celular sem mudar o desktop. Calculado uma vez ao carregar; recarregue após redimensionar.",
	nameLabel: "Nome",
	nameHint: "Nome exibido ao passar o mouse e incluído na persona da IA (\"seu nome é X\"). Pode repetir; vazio usa o id do pet.",
	personaLabel: "Persona (opcional)",
	personaHint: "Vale só para este pet. Vazio = segue a persona da entrada — o texto cinza na caixa é exatamente isso. O system enviado ao modelo = este texto + uma linha \"seu nome é <nome>\" anexada automaticamente + o contexto de hora atual, então não repita o nome nem a data aqui.",
	personaCount: "{n} caracteres",
	balanceEnabled: "Saldo",
	balanceEnabledHint: "Quando ativado, este pet toca as animações de saldo e mostra o balão de saldo.",
	whisperEnabled: "Sussurro",
	whisperEnabledHint: "Quando ativado, este pet gera uma frase com IA periodicamente e toca a animação de sussurro (persona = o campo abaixo; vazio segue a entrada).",
	workStatusEnabled: "Status de trabalho",
	workStatusEnabledHint: "Quando ativado, este pet segue o estado de trabalho do DSH: pensando / trabalhando / aguardando confirmação / concluído / erro trocam a animação e mostram balões (o pool fica na configuração de topo; apenas escuta, sem chamar o modelo).",
	fixedEnabled: "Fixar no lugar",
	fixedEnabledHint: "Quando ativado, a cadeia aleatória não gira nem afasta mais este pet — só tocam as ações de espera no lugar. Escolhas pelo menu de contexto, gatilhos da API e animações de saldo / sussurro / status de trabalho não são afetadas.",
	displayLabel: "Exibição",
	displayHint: "web = só no navegador / desktop = só no desktop / both = nos dois / none = em nenhum",
	"display.web": "Só no navegador",
	"display.desktop": "Só no desktop",
	"display.both": "Nos dois",
	"display.none": "Em nenhum",
	cornerLabel: "Posição",
	"corner.top-left": "Canto superior esquerdo",
	"corner.top-right": "Canto superior direito",
	"corner.bottom-left": "Canto inferior esquerdo",
	"corner.bottom-right": "Canto inferior direito",
	marginX: "Deslocamento horizontal",
	marginY: "Deslocamento vertical",
	save: "Salvar",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "Sincronizar",
	confirmSync: "Sincronizar? Isso sobrescreve a configuração do usuário com a configuração padrão incluída no projeto (todos os campos + comentários); as personalizações atuais serão perdidas.",
	corruptTitle: "A configuração do usuário está corrompida — não salva",
	corruptConfirm: "Salvar mesmo assim",
	corruptBody: "Não foi possível ler a configuração do usuário (conteúdo corrompido, não é JSON/JSONC válido): {path}. Salvar agora recria o arquivo a partir da lista branca — tudo o que está nele hoje (animações / física / memes etc.) será perdido. Cancelar = não mexe no arquivo (corrija e salve de novo); Confirmar = salva mesmo assim (descarta o conteúdo atual do arquivo).",
	syncHint: "\"Sincronizar\" grava a configuração padrão incluída no projeto (com comentários e todos os campos avançados) no arquivo do usuário, sobrescrevendo suas personalizações; depois disso o arquivo já pode ser editado direto. Dois avisos: (1) uma vez criado, o arquivo é uma camada de sobrescrita explícita — mudanças nos padrões do projeto não passam a valer sozinhas (só sincronizando de novo ou apagando o arquivo); (2) clicar em \"Salvar\" nesta página reescreve o arquivo pela lista branca — os valores são mantidos, os comentários são removidos.",
	configMeta: "Configuração avançada (arquivos)",
	configMetaHint: "A configuração do usuário pode sobrescrever a lista de pets / pools de animação / pesos — recarregue ou reinicie para aplicar: no navegador atualize a página, no desktop clique com o botão direito no pet → \"Recarregar configuração\" (recria todas as janelas de pet do desktop); a configuração padrão é a referência completa.",
	defaultConfig: "Configuração padrão (somente leitura, referência completa)",
	userConfig: "Configuração do usuário (sobrescritas personalizadas)",
	todosFile: "Dados de tarefas (texto, prazo e estado de conclusão; apagar equivale a limpar tudo)",
	animationDir: "Pasta de animações (adicione ou personalize animações aqui)",
	memesDir: "Pasta de memes (adicione ou personalize imagens aqui)",
	logFile: "Arquivo de log (para diagnóstico; pode ser limpo)",
	logFileNote: "O app desktop do DSH não tem console, então todo log de execução do plugin (inicialização, travamentos e reinícios do pet, erros e avisos) vai para este único arquivo — anexe-o ao relatar um problema. Limite de 1 MB por arquivo; ao encher, só os 512 KB mais recentes são mantidos.",
	saved: "Salvo — os pets atualizaram na hora.",
	loadError: "Falha ao carregar a configuração",
	saveError: "Falha ao salvar a configuração. Verifique a conexão com o servidor, a permissão de escrita na pasta de configuração e o log do servidor.",
	saveInvalid: "Falha ao salvar a configuração: conteúdo inválido. Revise os valores e tente de novo.",
	syncError: "Falha ao sincronizar a configuração. Verifique a conexão com o servidor e a permissão de escrita na pasta de configuração.",
	loading: "Carregando configuração…",
	retry: "Tentar de novo",
	invalid: "Revise os valores: o tamanho precisa ser positivo; as margens podem ser qualquer número.",
	busy: "Salvando…",
	extraPetsHint: "Mais {n} tipo(s) vêm de arquivos na pasta pet/ (<nome>-config.json + <nome>-animation/). Troque para eles na linha \"Tipos\" acima; salvar grava no config de cada pacote, nunca no main-config.jsonc.",
	kindLabel: "Tipos",
	kindMain: "Embutido",
	lastOfKind: "\"{entry}\" tem só este pet — excluí-lo remove o tipo inteiro. Para remover de vez, apague os arquivos do pet pack.",
	savePartial: "Os pets principais foram salvos, mas {names} não pôde ser gravado: verifique se o config do pacote é válido e se a pasta permite escrita.",
	notifyToggle: "Notificações do sistema",
	notifyToggleHint: "Avisos do sistema (canto inferior direito do desktop) para fim de conversa, falhas, pedidos de permissão e perguntas — só enquanto esta janela está sem foco.",
	clickSoundToggle: "Som de clique",
	clickSoundToggleHint: "Toca o som de clique embutido (assets/sound/click-duck.wav, volume 0.5) quando o pet é clicado; cliques repetidos em até 100ms tocam uma vez só, então vários pets não empilham som. Desligue para silêncio total. Gravado na configuração do usuário junto com o \"Salvar\".",
	whisperImageToggle: "Imagens no sussurro",
	whisperImageToggleHint: "Anexa um meme aleatório do pool a cada sussurro (o mapeamento de imagens fica no campo de topo memes). Tokens: o sussurro já chama o modelo a cada ciclo, então a imagem só acrescenta o nome + a descrição daquele meme (~100 caracteres / ~60 tokens) ao mesmo pedido — desprezível.",
	chatImageToggle: "Imagens na conversa",
	chatImageToggleHint: "Deixa a IA escolher um meme do pool conforme o contexto atual (opcional; o mapeamento fica no campo de topo memes). Tokens: cada mensagem leva o catálogo inteiro — hoje ~1,1 mil caracteres (~650 tokens, cerca de 11x o caso do sussurro) e cresce com o número de imagens; desligado, não acrescenta nada.",
	chatAnimationToggle: "Ações na conversa",
	chatAnimationToggleHint: "Quando ligado, o pedido de conversa leva a lista de animações que podem ser encenadas (todas as ações de animations.categories): se o modelo considerar que a frase realmente encena uma delas, o pet a executa na hora; caso contrário responde só com texto. Tokens: cada mensagem leva a lista inteira; desligado não acrescenta nada. Valor padrão global para todos os pets (um pet pack pode substituí-lo no próprio arquivo de configuração).",
	confineToggle: "Fixar na tela atual",
	confineToggleHint: "Vários monitores: quando ligado, o pet fica dentro da tela em que está — um pet arremessado quica só na tela onde foi solto (as emendas entre telas viram paredes, ele não voa para a tela vizinha), e o passeio autônomo só anda dentro da tela atual (o passo que cruzaria a emenda é cancelado). Desligado, ele cruza telas normalmente. Só afeta o modo desktop — o overlay do navegador já fica dentro da viewport.",
	trayToggle: "Bandeja do sistema",
	trayToggleHint: "Mostra um ícone na área de notificação (barra de menus no macOS) quando o modo desktop inicia. Ele lista todos os pets da configuração e alterna a exibição de cada um — inclusive os que estão fora do desktop agora e não têm janela para clicar com o botão direito. Sem ele, para trazer um pet de volta ao desktop é preciso abrir o navegador (a página de configuração, ou clicar com o botão direito no pet na web). O Windows já esconde ícones de terceiros na gaveta \"ícones ocultos\". Só afeta o modo desktop.",
	requestBubbleToggle: "Bolha de aprovação",
	requestBubbleToggleHint: "Quando uma chamada de ferramenta precisa da sua aprovação ou a IA faz uma pergunta, o mascote mostra as opções logo acima: «Permitir uma vez / Recusar» ou escolha uma opção, e a resposta volta na hora para a sessão. Só assume enquanto houver uma página do mascote online; caso contrário, ou com o interruptor desligado ou outra solicitação pendente, o painel nativo do DSH resolve.",
	scheduleReminderToggle: "Lembretes de tarefas",
	scheduleReminderToggleHint: "Quando uma tarefa criada com schedule_create vence, o mascote mostra um lembrete (apenas aviso — quem dispara a sessão continua sendo o agendador do DSH). Mudanças de horário são reajustadas sozinhas; ignorado sem mascote online e recuperado ao voltar. Gravado na configuração ao «Salvar».",
	menuTitle: "Menu de contexto",
	menuHint: "O que aparece ao clicar com o botão direito no pet e em que ordem. Arraste a alça à esquerda para ordenar e use o botão à direita para mostrar ou ocultar cada item. Só as ferramentas são reordenadas: reprodução de animação, posição na tela e o \"mais\" de terceiros têm condições próprias. É gravado na sua configuração ao salvar.",
	menuMoveUp: "Subir",
	menuMoveDown: "Descer",
	menuShow: "Mostrar",
	menuHide: "Ocultar",
	menuDrag: "Arraste para reordenar",
	menuReset: "Restaurar padrão",
	menuNote: "Os itens ocultos mantêm o lugar, então ao mostrar de novo voltam para a mesma posição. Na ordem padrão, \"Conversar\" vem primeiro.",
	voiceTitle: "Voz",
	voiceHint: "Três interruptores e uma voz: o mestre controla a fala automática; os dois secundários controlam um tipo de mensagem proativa cada. Tudo desligado por padrão; gravado na configuração do usuário ao \"Salvar\" (nunca na hora).",
	voiceEnabled: "Falar respostas",
	voiceEnabledHint: "Interruptor mestre da fala automática. Desligado, sussurros periódicos e lembretes de tarefas ficam mudos (os dois secundários abaixo não têm efeito). Sussurro manual, respostas da conversa e o botão de alto-falante do painel de conversa não são afetados — você pediu, então a origem fala direto. Só decide se sai som: balões, memória da conversa e notificações do sistema não mudam; falha na síntese só gera log e nunca interrompe a conversa.",
	voiceWhisperEnabled: "Falar sussurros",
	voiceWhisperEnabledHint: "Fala o sussurro gerado periodicamente (inclusive o sussurro manual do menu de contexto e o do comando de barra). Dependente do interruptor mestre acima. Desligado por padrão — sussurros são narração de fundo e não devem fazer barulho sem pedir.",
	voiceTodoEnabled: "Falar lembretes de tarefas",
	voiceTodoEnabledHint: "Fala o lembrete quando uma tarefa vence (o balão continua aparecendo; isto só decide se fala). Dependente do interruptor mestre acima. Desligado por padrão.",
	voiceEngineLabel: "Motor de voz",
	voiceEngineHint: "Qual voz falar. Edge é a voz integrada da Microsoft: grátis e pronta a usar. Breeze usa a tua própria chave de API da Breeze (modelo breeze-tts-2); as vozes podem ser criadas ou clonadas e são cobradas à tua conta. Isto só escolhe a voz; falar ou não continua a ser decidido pelos três interruptores acima.",
	voiceEngineEdge: "Integrado (Edge)",
	voiceEngineBreeze: "Breeze online",
	breezeKeyLabel: "Chave de API da Breeze",
	breezeKeyHint: "Começa por brz_; copia-a da página «API Keys» do painel da Breeze. Fica apenas na tua configuração local e é escrita ao Guardar — nunca a coloques num repositório público ou numa captura.",
	breezeVoiceLabel: "Voz da Breeze",
	breezeVoiceAuto: "Automática (primeira voz)",
	breezeVoiceHint: "Vozes disponíveis na tua conta; «Automática» escolhe a primeira. Se mudares a chave, a nova lista só aparece depois de guardar.",
	breezeSpeedLabel: "Velocidade da Breeze",
	breezeSpeedHint: "0,5–2×, 1 é normal. Partilhada pela pré-escuta e pelo anúncio; o motor integrado ignora-a (fala em percentagem).",
	breezeStatusLabel: "Ligação",
	breezeStatusHint: "«Verificar de novo» pede a lista de vozes à Breeze com a chave guardada: se vier, a chave funciona. Alterações não guardadas não são vistas.",
	breezeRefresh: "Verificar de novo",
	breezeNoKey: "Ainda sem chave — cola-a, guarda e carrega em «Verificar de novo».",
	breezeBadKey: "A chave é inválida ou foi reposta. Copia uma nova da Breeze.",
	breezeListFailed: "Não foi possível contactar a Breeze (rede ou serviço); a chave pode estar bem.",
	breezeReady: "Chave válida, lista de vozes carregada.",
	voiceNameLabel: "Voz",
	voiceVolumeLabel: "Volume",
	voiceVolumeHint: "Volume de reprodução em decimal 0–1: 1 é o volume máximo (100%) e 0 silencia. Altera apenas a intensidade e não sintetiza o áudio de novo, então ajustá-lo não custa nada extra. É independente do interruptor geral acima: com ele desligado, não tem efeito.",
	voicePreview: "Ouvir",
	voicePreviewSample: "Olá, eu sou seu pet de desktop. Tenha um bom dia!",
	voicePreviewHint: "Reproduz uma frase com a voz escolhida: é exatamente o que você ouvirá depois de salvar. Deixe vazio para a frase padrão ou escreva a sua (máx. 500 caracteres).",
	voicePreviewBusy: "Sintetizando…",
	voicePreviewFailed: "Falha ao ouvir: {msg}",
	physicsTitle: "Física (sensação de arrastar e arremessar)",
	physicsHint: "Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo); gravado na configuração do usuário ao \"Salvar\" (nunca na hora). No navegador vale na hora; no desktop vale quando o \"Salvar\" recarrega as janelas do pet.",
	mobileTitle: "Efeitos no celular",
	mobileHint: "Só fazem sentido no navegador do celular: a vibração precisa de motor, os dois interruptores de movimento precisam de sensores de inclinação/aceleração, e os sensores exigem HTTPS ou localhost.",
	"physics.gravity": "Gravidade",
	"physics.gravityHint": "px/s² — quanto maior, mais rápido cai; 0 = sem gravidade (voa em linha reta para sempre)",
	"physics.restitution": "Restituição",
	"physics.restitutionHint": "0–1, velocidade mantida ao quicar na parede ou no chão (1 = totalmente elástico, 0 = para na hora)",
	"physics.groundFriction": "Atrito de contato",
	"physics.groundFrictionHint": "por segundo, perda de velocidade ao longo de qualquer superfície (parede, chão, teto); 0 = gelo em todas",
	"physics.throwPower": "Força de arremesso",
	"physics.throwPowerHint": "> 0, multiplicador geral da mola que segue o cursor e da velocidade de saída (1 = padrão; maior = mais colado ao cursor e arremessos mais fortes)",
	physicsCeilingBounce: "Quicar no teto",
	physicsCeilingBounceHint: "Desligado, o arremesso pode sair pelo topo da tela (a gravidade ainda traz o pet de volta)",
	physicsPetCollision: "Colisão entre pets",
	physicsPetCollisionHint: "Um pet em voo quica nos outros com conservação de momento (massa ∝ tamanho²)",
	physicsHaptic: "Vibração ao colidir",
	physicsHapticHint: "Uma vibração por impacto (paredes, chão, teto, outros pets). Funciona no Chrome/Edge; não no iOS nem em navegadores WebView como o Via. O modo Não perturbe bloqueia o vibrador.",
	physicsTilt: "Gravidade por inclinação",
	physicsTiltHint: "Incline o celular e a gravidade acompanha (magnitude = o valor acima); com gravidade em 0 a inclinação não faz nada. Requer HTTPS/localhost.",
	physicsShake: "Sacudir para arremessar",
	physicsShakeHint: "Sacuda para arremessar o pet na direção do gesto; a força acompanha o throwPower. Independe da gravidade, então funciona com gravidade 0. Requer HTTPS/localhost.",
	invalidPhysics: "Revise os valores de física: gravidade / atrito com o chão ≥ 0, restituição 0–1, força de arremesso > 0.",
	fontTitle: "Aparência e fonte",
	fontHint: "A família vale para todo texto que hoje usa a fonte candy: balão do pet, dica ao passar o mouse, janela de conversa, popup de pontuação. O tamanho vale só para o balão do pet e a dica (as janelas de conversa e de pontuação mantêm o próprio tamanho). Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo); gravado na configuração do usuário ao \"Salvar\" — na hora no navegador, e no desktop quando o \"Salvar\" recarrega as janelas do pet.",
	fontFamilyLabel: "Fonte",
	fontFamilyHint: "\"Candy (embutida)\" vem com o plugin; as demais são fontes do sistema. Se faltar na máquina, cai para a próxima da pilha (nunca fica em branco nem dá erro).",
	fontSizeLabel: "Tamanho da fonte (px)",
	fontSizeHint: "Tamanho do texto do balão; a dica e as linhas menores dentro do balão escalam na proporção. Faixa 4–200.",
	fontFollowToggle: "Escalar a fonte com o tamanho do pet",
	fontFollowToggleHint: "Ligado (padrão): a fonte cresce com o pet — com 462 px de largura fica exatamente no tamanho definido acima. Desligado: o tamanho fica fixo, independente do pet.",
	invalidFont: "Revise as configurações de fonte: a família precisa estar na lista e o tamanho precisa ser um número entre 4 e 200.",
	"font.candy": "Candy (embutida)",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "Padrão do sistema",
	modelTitle: "Conversa e modelos",
	modelHint: "Qual modelo o sussurro e a conversa usam, e quanta história cada pedido de conversa carrega. \"Seguir a conversa atual\" usa o modelo da conversa em que você está (padrão). Padrão global: vale para todos os pets, e um pet pack pode sobrescrever no arquivo do próprio tipo. As opções vêm da mesma fonte do seletor de modelos do DSH, servidas pelo host em tempo real.",
	modelFollow: "Seguir a conversa atual",
	modelSearch: "Buscar modelos…",
	modelEmpty: "Nenhum modelo corresponde.",
	modelNoModels: "Nenhum modelo disponível.",
	modelLoading: "Atualizando a lista de modelos…",
	modelTriggerAria: "Escolher modelo, atual {model}",
	modelUnknown: " (configuração atual, fora da lista)",
	modelNone: "Este provedor não tem modelos disponíveis",
	whisperModelLabel: "Modelo do sussurro",
	chatModelLabel: "Modelo da conversa",
	modelFieldHint: "\"Seguir a conversa atual\" usa o modelo da conversa; se um modelo escolhido falhar, o plugin volta ao modelo da conversa e tenta mais uma vez.",
	invalidModel: "Revise as configurações de modelo: escolha provedor e modelo, ou deixe os dois vazios (seguir a conversa atual).",
	modelCatalogFailed: "Falha ao carregar a lista de modelos (atualize a página para tentar de novo); os valores atuais são mantidos como estão.",
	chatMemory: "Rodadas de histórico",
	chatMemoryHint: "Quantas rodadas recentes cada pedido de conversa carrega (1 rodada = 1 pergunta + 1 resposta; 0 = sem histórico, cada mensagem começa do zero). A memória em si guarda tudo — isto só decide quanto entra no contexto: mais memória, mais tokens. Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo).",
	invalidChatMemory: "Revise as rodadas de histórico: precisa ser um número ≥ 0.",
	chatImageLimit: "Limite de imagens na conversa",
	chatImageLimitHint: "Quantos memes no máximo são listados ao modelo na conversa (\"primeiros N\" = os N primeiros da configuração, então mova para o começo os que quer enviar). A lista inteira vai em cada mensagem e os tokens crescem linearmente com a quantidade, então lista longa é gasto puro; limitar aos N primeiros faz o modelo escolher só entre eles. 0 = sem limite (envia tudo). Padrão embutido 10. Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo). Só afeta a conversa — o sussurro leva só o meme sorteado.",
	invalidChatImageLimit: "Revise o limite de imagens na conversa: precisa ser um número ≥ 0 (0 = sem limite).",
	notifyTest: "Testar notificação",
	notifyTestOk: "Notificação de teste enviada — veja o canto inferior direito do desktop.",
	notifyDenyUnsupported: "Este ambiente não suporta notificações do sistema (sem API Notification no navegador).",
	notifyDenyBlocked: "A permissão de notificação está marcada como bloqueada pelo navegador.",
	notifyDenyRejected: "Você escolheu \"Bloquear\" na janela de permissão.",
	notifyDenyError: "Erro ao pedir permissão",
	notifyGuide: "Como liberar: clique no 🔒/ⓘ ao lado da barra de endereços → \"Configurações do site\" → \"Notificações\" → mude para \"Permitir\", atualize a página e tente de novo.",
	homeLabel: "Diretório de dados",
	homeHint: "Onde ficam configuração, tarefas, memória e memes. Deixe vazio para o padrão; reinicie o DSH para aplicar.",
	homeApply: "Aplicar",
	homeReset: "Usar padrão",
	homeSaved: "Salvo. Reinicie o DSH para aplicar.",
	homeFailed: "Não foi possível salvar: use um caminho absoluto com permissão de escrita.",
	homeEnvLocked: "O diretório é fixado pela variável de ambiente DSH_PET_HOME.",
	storageTitle: "Desinstalação e armazenamento",
	storageHint: "Todos os lugares em que o plugin grava arquivos. Apagar caches não atrapalha (são baixados ou recriados sozinhos); apagar \"dados do usuário do plugin\" perde a configuração e a memória da conversa.",
	"storage.userData": "Dados do usuário do plugin: configuração personalizada main-config.jsonc, memória da conversa memory.json, animações personalizadas main-animation/, pets de arquivo pet/",
	"storage.electron": "Runtime Electron usado pelo pet do desktop (grande; é baixado de novo automaticamente na próxima vez que o modo desktop iniciar)",
	"storage.desktopCache": "Cache das janelas do pet e cache de escala do monitor principal (pode apagar; é recriado sozinho)",
	"storage.electronCache": "Cache de download do instalador do Electron (pode apagar; é baixado de novo quando preciso)",
	"storage.package": "O plugin em si (gerenciado pelo DSH — remova com o comando abaixo em vez de apagar na mão)",
	storageMissing: " (ainda não criado)",
	uninstallTitle: "Como desinstalar",
	uninstallStep1: "1. Feche o DSH primeiro (o pet do desktop fecha junto); não apague os arquivos acima com o pet em execução.",
	uninstallStep2: "2. Remova o plugin em si (no terminal; isto também o tira da camada de bundle do profile):",
	uninstallStep3: "3. Apague os locais acima conforme a necessidade: caches não fazem falta; apagar \"dados do usuário do plugin\" perde a configuração e a memória da conversa (faça backup do main-config.jsonc antes, se quiser manter).",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/ru.ts
const ru = {
	nav: "Настройки питомца",
	intro: "Управляйте несколькими питомцами: у каждого свои размер и позиция (применяются сразу после сохранения).",
	petCardTitle: "Питомец",
	avatarLabel: "Аватар",
	avatarHint: "Маленькое изображение рядом с сообщениями этого питомца в панели чата. Без загрузки используется логотип плагина по умолчанию; загрузка применяется сразу и заменяет предыдущее изображение — нажимать «Сохранить» не нужно.",
	avatarUpload: "Загрузить аватар",
	avatarChange: "Заменить",
	avatarUploading: "Загрузка…",
	avatarUploaded: "Аватар обновлён",
	petCardHint: "Настройки каждого питомца: имя / размер / отображение / позиция / отступы / четыре переключателя функций. Нажмите «Сохранить» внизу, чтобы применить сразу.",
	globalTitle: "Глобальные переключатели",
	globalHint: "Общие для всех питомцев (пакет питомца может переопределить их в своём файле вида). Эти переключатели меняют только локальное состояние и записываются в пользовательский конфиг по «Сохранить» (без немедленной записи); системные уведомления перечитываются сразу после сохранения, обновлять страницу не нужно.",
	cornerHint: "К какому углу экрана прикреплён питомец (в настольном режиме — рабочая область соответствующего монитора).",
	marginXHint: "Горизонтальное расстояние от выбранного угла (px); любое число.",
	marginYHint: "Вертикальное расстояние от выбранного угла (px); любое число.",
	"cmd.chat": "Чат",
	"cmd.pet": "Питомец",
	"cmd.balance": "Баланс",
	"shortcut.open": "Открыть чат питомца",
	"shortcut.chat": "Открыть окно чата",
	"shortcut.hear": "Голосовой ввод",
	"shortcut.capture": "Снимок экрана в чат",
	shortcutCardTitle: "Горячие клавиши",
	shortcutCardHint: "В раскрытом виде две группы: клавиши питомца и глобальные клавиши.",
	shortcutRowChat: "Открыть чат",
	shortcutRowHold: "Удерживать для речи",
	shortcutRowHear: "Голосовой ввод",
	shortcutRowCapture: "Снимок экрана",
	shortcutRowPaste: "Вставить изображение",
	shortcutRowTodo: "Задачи",
	shortcutRowSleep: "Спать / проснуться",
	shortcutRowDisplay: "Позиция показа",
	shortcutRowSidebar: "Открыть чат в панели",
	shortcutGroupPet: "Клавиши питомца",
	shortcutGroupPetHint: "В веб-версии достаточно навести курсор на питомца. В окне на рабочем столе сначала щёлкните питомца, чтобы он получил фокус клавиатуры.",
	shortcutGroupGlobal: "Глобальные клавиши",
	shortcutGroupGlobalHint: "Их распределяет DSH в веб-версии и в окне на рабочем столе; меняются в Настройки → Общие → Горячие клавиши.",
	petsLabel: "Питомцы",
	add: "Добавить питомца",
	remove: "Удалить",
	confirmRemove: "Удалить питомца «{id}»?",
	confirmTitle: "Подтверждение действия",
	cancel: "Отмена",
	ok: "Понятно",
	atLeastOne: "Оставьте хотя бы одного питомца.",
	emptyPets: "Питомцев пока нет — нажмите «Добавить питомца», чтобы создать.",
	sizeLabel: "Размер (ширина, px)",
	sizeHint: "Высота рассчитывается автоматически = ширина × 9/16.",
	sizePercentLabel: "Макс. ширина экрана (%)",
	sizePercentHint: "Какую долю ширины экрана может занимать питомец: 100 = не шире одного экрана (на широких окнах полностью совпадает с px); 30–40 заметно уменьшит его на телефоне, не меняя десктоп. Вычисляется один раз при загрузке; после изменения размера окна перезагрузите страницу.",
	nameLabel: "Имя",
	nameHint: "Отображаемое имя: всплывает при наведении и добавляется в образ ИИ («тебя зовут X»). Может повторяться; если пусто — используется id питомца.",
	personaLabel: "Образ (необязательно)",
	personaHint: "Действует только для этого питомца. Пусто = использовать образ записи — серый текст в поле и есть он. Фактический system для модели = этот текст + автоматически добавленная строка «тебя зовут \"<имя>\"» + текущий временной контекст, поэтому не повторяйте здесь имя и дату.",
	personaCount: "{n} симв.",
	balanceEnabled: "Функция баланса",
	balanceEnabledHint: "Если включено, питомец проигрывает анимацию баланса и показывает пузырь с балансом.",
	whisperEnabled: "Шёпот",
	whisperEnabledHint: "Если включено, питомец периодически генерирует фразу через ИИ и проигрывает анимацию шёпота (образ — поле ниже; пусто = образ записи).",
	workStatusEnabled: "Статус работы",
	workStatusEnabledHint: "Если включено, питомец следит за статусом работы DSH: размышление / работа / ожидание подтверждения / готово / ошибка — переключает анимации и показывает пузыри (пул в конфиге верхнего уровня; только прослушивание, без вызовов модели).",
	fixedEnabled: "Закрепить питомца",
	fixedEnabledHint: "Если включено, случайная цепочка больше не поворачивает и не уводит питомца — проигрываются только ожидание на месте и мелкие движения. Выбор по правому клику, запуски через API и анимации баланса / шёпота / статуса работы не затрагиваются.",
	displayLabel: "Отображение",
	displayHint: "web = только браузер / desktop = только рабочий стол / both = везде / none = нигде",
	"display.web": "Только браузер",
	"display.desktop": "Только рабочий стол",
	"display.both": "Везде",
	"display.none": "Нигде",
	cornerLabel: "Позиция",
	"corner.top-left": "Верхний левый",
	"corner.top-right": "Верхний правый",
	"corner.bottom-left": "Нижний левый",
	"corner.bottom-right": "Нижний правый",
	marginX: "Горизонтальный отступ",
	marginY: "Вертикальный отступ",
	save: "Сохранить",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "Синхронизировать",
	confirmSync: "Синхронизировать? Пользовательский конфиг будет перезаписан встроенным конфигом по умолчанию (все поля + комментарии); текущие настройки будут потеряны.",
	corruptTitle: "Пользовательский конфиг повреждён — не сохранён",
	corruptConfirm: "Сохранить принудительно",
	corruptBody: "Не удаётся разобрать файл пользовательского конфига (повреждён, не валидный JSON/JSONC): {path}. При сохранении файл будет пересобран по белому списку — всё текущее содержимое (animations / physics / memes и другие пользовательские поля) будет потеряно. Отмена = не трогать файл (сначала исправьте конфиг и сохраните снова); Подтвердить = сохранить принудительно (отбросить содержимое файла).",
	syncHint: "«Синхронизировать» записывает встроенный конфиг по умолчанию (с комментариями и всеми расширенными полями) в файл пользовательского конфига, перезаписывая текущие настройки; после этого файл можно редактировать напрямую. Два замечания: ① после создания файл становится явным слоем переопределения — последующие изменения встроенных значений по умолчанию не применяются автоматически (пока не синхронизируете снова или не удалите файл); ② нажатие «Сохранить» на этой странице пересобирает файл по белому списку (значения полей сохраняются, комментарии удаляются).",
	configMeta: "Расширенная конфигурация (файлы)",
	configMetaHint: "Пользовательский конфиг может переопределять список питомцев / пулы анимаций / веса воспроизведения — изменения применяются после обновления или перезапуска: в браузере обновите страницу, в настольном режиме щёлкните питомца правой кнопкой → «Перезагрузить конфиг» (перезагружает все окна настольных питомцев); конфиг по умолчанию — полный справочник.",
	defaultConfig: "Конфиг по умолчанию (только чтение, полный справочник)",
	userConfig: "Пользовательский конфиг (свои переопределения)",
	todosFile: "Данные задач (текст списка, срок и статус выполнения; удаление очищает все задачи)",
	animationDir: "Каталог анимаций (можно добавлять и заменять анимации)",
	memesDir: "Каталог мемов (можно добавлять и заменять картинки)",
	logFile: "Файл журнала (для диагностики; можно очищать)",
	logFileNote: "В настольной версии нет консоли, поэтому все журналы работы плагина (запуск, падения и перезапуски настольных питомцев, ошибки и предупреждения) пишутся в этот единственный файл; прикладывайте его при сообщении о проблеме. Лимит файла — 1 МБ, при переполнении остаются последние 512 КБ.",
	saved: "Сохранено — питомцы обновились сразу.",
	loadError: "Не удалось загрузить конфиг",
	saveError: "Не удалось сохранить конфиг. Проверьте подключение к серверу, права на запись в каталог конфигурации и журнал сервера.",
	saveInvalid: "Не удалось сохранить конфиг: недопустимое содержимое. Проверьте значения и повторите попытку.",
	syncError: "Не удалось синхронизировать конфиг. Проверьте подключение к серверу и права на запись в каталог конфигурации.",
	loading: "Загрузка конфига…",
	retry: "Повторить",
	invalid: "Проверьте ввод: размер должен быть положительным, отступы — любым числом.",
	busy: "Сохранение…",
	extraPetsHint: "Ещё {n} вида берутся из файлов каталога pet/ (<имя>-config.json + <имя>-animation/); переключитесь на них в строке «Виды» выше — сохранение запишет в конфиг соответствующего пакета, не в main-config.jsonc.",
	kindLabel: "Виды",
	kindMain: "Встроенный",
	lastOfKind: "У «{entry}» остался только этот питомец — удаление уберёт весь вид. Чтобы удалить полностью, удалите файлы пакета.",
	savePartial: "Основные питомцы сохранены, но {names} не удалось записать: проверьте валидность конфига пакета и права на запись в каталог.",
	notifyToggle: "Системные уведомления",
	notifyToggleHint: "Уведомления ОС (в правом нижнем углу рабочего стола) о завершении диалога, ошибках генерации, запросах прав и вопросах — только когда окно не в фокусе.",
	clickSoundToggle: "Звук клика",
	clickSoundToggleHint: "При клике по питомцу воспроизводится встроенный звук (assets/sound/click-duck.wav, громкость 0.5); повторные клики в пределах 100 мс звучат один раз, поэтому несколько питомцев не накладываются. Выключите для полной тишины. Записывается в пользовательский конфиг вместе с «Сохранить».",
	whisperImageToggle: "Картинки к шёпоту",
	whisperImageToggleHint: "К каждой фразе шёпота добавляется случайный мем из пула (сопоставление картинок — в поле memes верхнего уровня конфига). Токены: шёпот и так вызывает модель каждый цикл, картинка лишь добавляет имя + описание выбранного мема (~100 символов / ≈60 токенов) в тот же запрос — прирост незначителен.",
	chatImageToggle: "Картинки к чату",
	chatImageToggleHint: "ИИ сам выбирает мем из пула под текущий контекст (может не выбирать; сопоставление — в поле memes верхнего уровня). Токены: каждое сообщение несёт весь список — сейчас ~1.1k символов (≈650 токенов, примерно в 11 раз больше, чем у шёпота) и растёт линейно с числом картинок; при выключении не добавляется ни одного символа.",
	chatAnimationToggle: "Действия в чате",
	chatAnimationToggleHint: "Если включено, запрос чата несёт список анимаций, которые можно сыграть (все действия из animations.categories): если модель считает, что реплика действительно изображает одно из них, питомец сразу его играет; иначе отвечает только текстом. Токены: каждое сообщение несёт весь список; при выключении не добавляется ничего. Глобальное значение по умолчанию для всех питомцев (pet pack может переопределить его в своём файле конфигурации).",
	confineToggle: "Не выходить за текущий экран",
	confineToggleHint: "Несколько мониторов: если включено, питомец остаётся в пределах экрана, на котором находится — брошенный питомец отскакивает только внутри экрана, где его отпустили (стыки экранов работают как стены, он не улетает на соседний монитор), а самостоятельные прогулки тоже идут только в пределах текущего экрана (шаг, пересекающий стык, просто отменяется). Если выключено, он свободно летает и ходит между экранами. Только настольный режим — браузерный оверлей и так остаётся в пределах окна.",
	trayToggle: "Системный трей",
	trayToggleHint: "В настольном режиме в области уведомлений (на macOS — в строке меню) постоянно показывается значок со всеми питомцами из конфига: галочка переключает место отображения, включая питомцев, которых сейчас нет на рабочем столе и у которых нет окна для правого клика. Если выключить, вернуть питомца на рабочий стол можно только через браузер (страница настроек или правый клик по питомцу на веб-странице). Windows и так сворачивает такие значки в «скрытые». Только настольный режим.",
	requestBubbleToggle: "Пузырь подтверждения",
	requestBubbleToggleHint: "Когда вызову инструмента нужно ваше подтверждение или ИИ задаёт вопрос, питомец показывает варианты прямо над собой: «Разрешить один раз / Отклонить» или выбор варианта — ответ сразу уходит в сессию. Перехватывает, только пока страница питомца онлайн; иначе, при выключенном переключателе или уже ожидающем запросе работает стандартная панель DSH.",
	scheduleReminderToggle: "Напоминания о задачах",
	scheduleReminderToggleHint: "Когда наступает срок задачи, созданной через schedule_create, питомец показывает напоминание (только напоминание — сессию по-прежнему запускает планировщик DSH). Изменения времени учитываются автоматически; без онлайн-страницы питомца пропускается и догоняется при возврате. Записывается в конфиг по «Сохранить».",
	menuTitle: "Контекстное меню",
	menuHint: "Что появляется по правому клику на питомца и в каком порядке. Перетащите ручку слева, чтобы изменить порядок, а кнопка справа показывает или скрывает пункт. Сортируются только инструменты: воспроизведение анимаций, положение на экране и стороннее «ещё» имеют свои условия. Записывается в пользовательскую конфигурацию при сохранении.",
	menuMoveUp: "Выше",
	menuMoveDown: "Ниже",
	menuShow: "Показать",
	menuHide: "Скрыть",
	menuDrag: "Перетащите для сортировки",
	menuReset: "Сбросить",
	menuNote: "Скрытые пункты сохраняют место, поэтому при повторном показе возвращаются на прежнюю позицию. В порядке по умолчанию «Чат» идёт первым.",
	voiceTitle: "Голосовое озвучивание",
	voiceHint: "Три переключателя и голос: главный включает автоматическое озвучивание, два дополнительных — по одному типу активных сообщений. По умолчанию всё выключено; записывается в пользовательский конфиг по «Сохранить» (без немедленной записи).",
	voiceEnabled: "Озвучивание",
	voiceEnabledHint: "Главный переключатель автоматического озвучивания. Если выключен, периодический шёпот и напоминания о задачах не произносятся (два переключателя ниже не действуют); ручной шёпот, ответы в чате и кнопка динамика в панели чата от него не зависят — вы запросили их сами, и они озвучиваются сразу. Влияет только на «говорить или нет»: пузыри, история чата и системные уведомления не затрагиваются; ошибка синтеза пишется в журнал и не прерывает диалог.",
	voiceWhisperEnabled: "Озвучивать шёпот",
	voiceWhisperEnabledHint: "Озвучивает периодически генерируемую фразу шёпота (включая ручной шёпот из контекстного меню и по slash-команде). Подчиняется главному переключателю выше. По умолчанию выключено — шёпот это фоновое повествование, он не должен звучать без запроса.",
	voiceTodoEnabled: "Озвучивать задачи",
	voiceTodoEnabledHint: "Озвучивает напоминание о задаче, когда подходит срок (пузырь появляется в любом случае; этот пункт решает только, произносить ли). Подчиняется главному переключателю выше. По умолчанию выключено.",
	voiceEngineLabel: "Голосовой движок",
	voiceEngineHint: "Чей голос звучит. Edge — встроенный голос Microsoft: бесплатно и сразу готово. Breeze использует ваш ключ API Breeze (модель breeze-tts-2), голоса можно создавать или клонировать, оплата идёт по вашему аккаунту. Здесь выбирается только голос; звучать или нет по-прежнему решают три переключателя выше.",
	voiceEngineEdge: "Встроенный (Edge)",
	voiceEngineBreeze: "Breeze онлайн",
	breezeKeyLabel: "Ключ API Breeze",
	breezeKeyHint: "Начинается с brz_; скопируйте его со страницы «API Keys» в панели Breeze. Хранится только в локальной конфигурации пользователя и записывается при сохранении — не вставляйте его в публичный репозиторий или скриншот.",
	breezeVoiceLabel: "Голос Breeze",
	breezeVoiceAuto: "Авто (первый голос)",
	breezeVoiceHint: "Голоса, доступные вашему аккаунту; «Авто» берёт первый. После смены ключа новый список появится только после сохранения.",
	breezeSpeedLabel: "Скорость Breeze",
	breezeSpeedHint: "0,5–2×, 1 — обычная. Общая для прослушивания и озвучки; встроенный движок её игнорирует (он говорит в процентах).",
	breezeStatusLabel: "Соединение",
	breezeStatusHint: "«Проверить снова» запрашивает список голосов у Breeze с сохранённым ключом: если пришёл — ключ рабочий. Несохранённые правки не видны.",
	breezeRefresh: "Проверить снова",
	breezeNoKey: "Ключа ещё нет — вставьте, сохраните и нажмите «Проверить снова».",
	breezeBadKey: "Ключ недействителен или сброшен. Скопируйте новый из Breeze.",
	breezeListFailed: "Не удалось связаться с Breeze (сеть или сервис); возможно, ключ в порядке.",
	breezeReady: "Ключ рабочий, список голосов загружен.",
	voiceNameLabel: "Голос",
	voiceVolumeLabel: "Громкость",
	voiceVolumeHint: "Громкость воспроизведения в виде десятичной дроби 0–1: 1 — максимальная громкость (100 %), 0 — без звука. Меняется только уровень, звук заново не синтезируется, поэтому настройка ничего не стоит дополнительно. Не зависит от общего переключателя выше: при выключенном переключателе не действует.",
	voicePreview: "Прослушать",
	voicePreviewSample: "Привет, я твой питомец на рабочем столе. Хорошего дня!",
	voicePreviewHint: "Проигрывает фразу выбранным голосом — то же, что услышишь после сохранения. Оставь пустым для фразы по умолчанию или впиши свою (до 500 символов).",
	voicePreviewBusy: "Синтез…",
	voicePreviewFailed: "Не удалось прослушать: {msg}",
	physicsTitle: "Физика (ощущение перетаскивания и броска)",
	physicsHint: "Глобальное значение по умолчанию для всех питомцев (пакет питомца может переопределить в своём файле вида); записывается в пользовательский конфиг по «Сохранить» (без немедленной записи). В браузере применяется сразу, в настольном режиме — после перезагрузки окон питомцев при сохранении.",
	mobileTitle: "Эффекты для телефона",
	mobileHint: "Имеют смысл только в мобильном браузере: вибрации нужен мотор, двум переключателям движения — датчики наклона и ускорения, а датчики доступны только по HTTPS или на localhost.",
	"physics.gravity": "Гравитация",
	"physics.gravityHint": "px/s², чем больше, тем быстрее падает; 0 = без гравитации (летит по прямой с постоянной скоростью)",
	"physics.restitution": "Упругость",
	"physics.restitutionHint": "0~1, доля сохраняемой скорости при отскоке от стены / пола (1 = абсолютно упругий, 0 = останавливается при ударе)",
	"physics.groundFriction": "Трение о поверхности",
	"physics.groundFrictionHint": "/с, затухание скорости вдоль любой контактной поверхности (стена, пол, потолок); 0 = везде лёд",
	"physics.throwPower": "Общая сила броска",
	"physics.throwPowerHint": "> 0, общий множитель следования за курсором и начальной скорости броска (1 = по умолчанию; больше = точнее следует и сильнее бросок)",
	physicsCeilingBounce: "Отскок от потолка",
	physicsCeilingBounceHint: "Если выключено, бросок может вылететь за верхний край экрана (гравитация всё равно вернёт питомца)",
	physicsPetCollision: "Столкновения питомцев",
	physicsPetCollisionHint: "Летящий питомец отталкивается от других по закону сохранения импульса (масса ∝ размеру²)",
	physicsHaptic: "Вибрация при столкновении",
	physicsHapticHint: "Одна вибрация на удар (стены, пол, потолок, другие питомцы). Работает в Chrome/Edge; не работает на iOS и в WebView-оболочках вроде Via. Режим «Не беспокоить» блокирует вибрацию.",
	physicsTilt: "Гравитация по наклону",
	physicsTiltHint: "Наклоняйте телефон — гравитация следует за ним (величина = значение выше); при гравитации 0 наклон ничего не меняет. Нужен HTTPS/localhost.",
	physicsShake: "Встряхнуть, чтобы бросить",
	physicsShakeHint: "Встряхните, чтобы бросить питомца в направлении жеста; сила зависит от throwPower. Не зависит от гравитации, работает и при 0. Нужен HTTPS/localhost.",
	invalidPhysics: "Проверьте физические параметры: гравитация / трение о землю ≥ 0, упругость 0~1, общая сила броска > 0.",
	fontTitle: "Внешний вид и шрифт",
	fontHint: "Семейство шрифта применяется ко всем местам, где сейчас используется «мармеладный» шрифт: пузырь питомца, подсказка при наведении, окно чата, всплывающее окно счёта. Размер действует только на пузырь питомца и подсказку при наведении (в чате и окне счёта размер не меняется). Глобальное значение по умолчанию для всех питомцев (пакет питомца может переопределить в своём файле вида); записывается в пользовательский конфиг по «Сохранить» — в браузере сразу, в настольном режиме после перезагрузки окон питомцев.",
	fontFamilyLabel: "Шрифт",
	fontFamilyHint: "«Мармеладный (встроенный)» поставляется с плагином; остальные — системные шрифты. Если шрифта нет на машине, используется следующий в стеке (без пустых мест и ошибок).",
	fontSizeLabel: "Размер шрифта (px)",
	fontSizeHint: "Размер основного текста пузыря; подсказка и мелкий текст внутри пузыря масштабируются пропорционально. Диапазон 4~200.",
	fontFollowToggle: "Масштабировать шрифт вместе с питомцем",
	fontFollowToggleHint: "Включено (по умолчанию): при увеличении питомца шрифт растёт пропорционально, при ширине 462 это ровно заданный выше размер; выключено: размер фиксирован и не зависит от размера питомца.",
	invalidFont: "Проверьте настройки шрифта: семейство должно быть в списке, размер — числом от 4 до 200.",
	"font.candy": "Мармеладный (встроенный)",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "Системный по умолчанию",
	modelTitle: "Чат и модели",
	modelHint: "Какая модель используется для шёпота и для чата, и сколько истории каждый запрос чата несёт в контексте. «Следовать текущему диалогу» = использовать модель текущего диалога (по умолчанию). Глобальное значение по умолчанию: действует для всех питомцев, пакет питомца может переопределить в своём файле вида. Список тот же, что в выборе моделей DSH, и предоставляется хостом в реальном времени.",
	modelFollow: "Следовать текущему диалогу",
	modelSearch: "Поиск моделей…",
	modelEmpty: "Подходящих моделей нет.",
	modelNoModels: "Доступных моделей нет.",
	modelLoading: "Обновление списка моделей…",
	modelTriggerAria: "Выбрать модель, текущая {model}",
	modelUnknown: " (текущая настройка, отсутствует в списке)",
	modelNone: "У этого провайдера нет доступных моделей",
	whisperModelLabel: "Модель для шёпота",
	chatModelLabel: "Модель для чата",
	modelFieldHint: "«Следовать текущему диалогу» = использовать модель текущего диалога; если выбранная модель не сработает, плагин один раз повторит с моделью текущего диалога.",
	invalidModel: "Проверьте настройки модели: выберите и провайдера, и модель — либо оставьте оба поля пустыми (следовать текущему диалогу).",
	modelCatalogFailed: "Не удалось загрузить список моделей (обновите страницу, чтобы повторить); текущие значения сохранятся как есть.",
	chatMemory: "Реплик истории чата",
	chatMemoryHint: "Сколько последних реплик несёт каждый запрос чата (1 реплика = 1 вопрос + 1 ответ; 0 = без истории, каждое сообщение с чистого листа). Сама память хранит всё — это значение решает только, сколько попадает в контекст: больше = лучше помнит, но дороже по токенам. Глобальное значение по умолчанию для всех питомцев (пакет питомца может переопределить в своём файле вида).",
	invalidChatMemory: "Проверьте число реплик истории чата: нужно число ≥ 0.",
	chatImageLimit: "Лимит картинок в чате",
	chatImageLimitHint: "Сколько мемов максимум передаётся модели в чате («первые N» = первые N в конфиге, поэтому нужные перенесите в начало). Весь список прикладывается к каждому сообщению, и токены растут линейно с количеством — большой список это чистый перерасход; ограничение первыми N заставляет модель выбирать только из них. 0 = без ограничения (передавать все). Встроенное значение по умолчанию — 10. Глобальное значение по умолчанию для всех питомцев (пакет питомца может переопределить в своём файле вида). Только для выбора картинок в чате: шёпот несёт лишь одну выбранную картинку.",
	invalidChatImageLimit: "Проверьте лимит картинок в чате: нужно число ≥ 0 (0 = без ограничения).",
	notifyTest: "Тестовое уведомление",
	notifyTestOk: "Тестовое уведомление отправлено — проверьте правый нижний угол рабочего стола.",
	notifyDenyUnsupported: "В этой среде системные уведомления не поддерживаются (нет Notification API).",
	notifyDenyBlocked: "Разрешение на уведомления заблокировано браузером.",
	notifyDenyRejected: "Вы выбрали «Блокировать» в запросе разрешения.",
	notifyDenyError: "Ошибка при запросе разрешения",
	notifyGuide: "Подсказка: нажмите 🔒/ⓘ слева от адресной строки → «Настройки сайта» → «Уведомления» → выберите «Разрешить», затем обновите страницу и повторите.",
	homeLabel: "Каталог данных",
	homeHint: "Где хранятся конфигурация, задачи, память и мемы. Оставьте пустым для значения по умолчанию; перезапустите DSH.",
	homeApply: "Применить",
	homeReset: "По умолчанию",
	homeSaved: "Сохранено. Перезапустите DSH.",
	homeFailed: "Не удалось сохранить: нужен абсолютный путь с правом записи.",
	homeEnvLocked: "Каталог задан переменной окружения DSH_PET_HOME.",
	storageTitle: "Удаление и хранилище",
	storageHint: "Все места, куда плагин пишет на этом компьютере. Удаление кеша не мешает работе (он скачается/пересоберётся); удаление «пользовательских данных плагина» стирает конфиг и память чата.",
	"storage.userData": "Пользовательские данные плагина: свой конфиг main-config.jsonc, память чата memory.json, свои анимации main-animation/, файловые питомцы pet/",
	"storage.electron": "Среда выполнения Electron для настольного питомца (большая; при следующем включении настольного режима скачается заново)",
	"storage.desktopCache": "Кеш окон настольных питомцев и кеш масштаба основного экрана (можно удалять, пересоберётся автоматически)",
	"storage.electronCache": "Кеш загрузки установщика Electron (можно удалять, при необходимости скачается заново)",
	"storage.package": "Сам плагин (управляется DSH — удаляйте командой ниже, не вручную)",
	storageMissing: " (ещё не создано)",
	uninstallTitle: "Как удалить",
	uninstallStep1: "1. Сначала закройте DSH (настольный питомец закроется вместе с ним); не удаляйте эти файлы, пока питомец запущен.",
	uninstallStep2: "2. Удалите сам плагин (выполните в терминале; он также убирается из слоя bundle профиля):",
	uninstallStep3: "3. Удалите нужные места из списка выше: кеш удалять безопасно; удаление «пользовательских данных плагина» стирает конфиг и память чата (если нужно сохранить — сначала сделайте резервную копию main-config.jsonc).",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/zh.ts
const zh = {
	nav: "桌宠配置",
	intro: "管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。",
	petCardTitle: "宠物配置",
	avatarLabel: "头像",
	avatarHint: "对话面板里这条宠物消息旁边显示的小图。没上传过就是插件默认图；上传后立即生效并覆盖旧图，不需要点「保存」。",
	avatarUpload: "上传头像",
	avatarChange: "更换",
	avatarUploading: "上传中…",
	avatarUploaded: "头像已更新",
	petCardHint: "每只宠物独立配置：名字 / 大小 / 显示位置 / 位置 / 偏移 / 四个功能开关。改完点最下面的「保存」即时生效。",
	globalTitle: "全局开关",
	globalHint: "所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。这几个开关只改本地状态，随「保存」整包写入用户配置（不做即时写入）；系统通知在保存后即时重读，无需刷新页面。",
	cornerHint: "宠物贴着哪个角；桌面端跟随 DSH 窗口所在的那块屏幕（多屏时以它为准），拿不到时用主屏。",
	marginXHint: "距所选角落的水平距离（px），可为任意数字。",
	marginYHint: "距所选角落的垂直距离（px），可为任意数字。",
	"cmd.chat": "对话",
	"cmd.pet": "桌宠",
	"cmd.balance": "余额",
	"shortcut.open": "打开桌宠对话",
	"shortcut.chat": "打开对话弹窗",
	"shortcut.hear": "语音输入",
	"shortcut.capture": "截图到对话",
	shortcutCardTitle: "快捷键",
	shortcutCardHint: "展开后分两组：桌宠快捷键与全局快捷键。",
	shortcutRowChat: "打开对话",
	shortcutRowHold: "按住说话",
	shortcutRowHear: "语音输入",
	shortcutRowCapture: "截图",
	shortcutRowPaste: "粘贴图片",
	shortcutRowTodo: "待办事项",
	shortcutRowSleep: "睡觉 / 起来",
	shortcutRowDisplay: "显示位置",
	shortcutRowSidebar: "打开侧栏对话",
	shortcutGroupPet: "桌宠快捷键",
	shortcutGroupPetHint: "网页端鼠标停在宠物上即可；桌面宠物窗口要先点一下宠物，拿到键盘焦点后才生效。",
	shortcutGroupGlobal: "全局快捷键",
	shortcutGroupGlobalHint: "网页端与桌面版窗口里由 DSH 分发；可在「设置 → 通用 → 快捷键」改绑。",
	petsLabel: "宠物列表",
	add: "添加宠物",
	remove: "删除",
	confirmRemove: "确定删除宠物「{id}」吗？",
	confirmTitle: "确认操作",
	cancel: "取消",
	ok: "知道了",
	atLeastOne: "至少保留一个宠物。",
	emptyPets: "暂无宠物，点击「添加宠物」创建。",
	sizeLabel: "大小（宽度 px）",
	sizeHint: "高度自动 = 宽度 × 9/16。",
	sizePercentLabel: "屏幕宽度上限（%）",
	sizePercentHint: "桌宠最多占屏幕多宽：100 = 不超过一屏宽，窗口比宠物宽时与按 px 显示完全一致；填 30–40 可让手机竖屏明显变小，桌面观感不变。只在页面加载时计算一次，改窗口大小后刷新生效。",
	nameLabel: "名字",
	nameHint: "显示名：鼠标悬浮宠物时弹出，也会加进 AI 人设（你的名字是 X）。可重复，留空按宠物 id 处理。",
	personaLabel: "人设（可选）",
	personaHint: "只影响这只宠物。留空 = 跟随所属条目的人设——输入框里的灰色文字就是那份内容。实际发给模型的 system = 这段 + 自动追加的「你的名字是“<名字>”」+ 当前时间背景，所以别在这里再写名字和日期。",
	personaCount: "{n} 字",
	balanceEnabled: "余额功能",
	balanceEnabledHint: "启用后该宠物触发余额动画并显示余额气泡。",
	whisperEnabled: "碎碎念",
	whisperEnabledHint: "启用后该宠物按周期用 AI 生成一句话并播碎碎念动画（人设见下方「人设」框，留空跟随条目）。",
	workStatusEnabled: "工作状态联动",
	workStatusEnabledHint: "启用后该宠物跟随 DSH 工作状态：思考/工作中/等待确认/完成/出错时自动切对应动画并弹气泡（动画池在配置顶层，仅监听不调用模型）。",
	fixedEnabled: "宠物固定",
	fixedEnabledHint: "启用后随机动画不再让宠物自己转向或走开，只播原地待机与随机小动作；右键菜单点播、接口触发、余额/碎碎念/工作状态动画不受影响。",
	displayLabel: "显示位置",
	displayHint: "web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示",
	"display.web": "仅浏览器",
	"display.desktop": "仅桌面",
	"display.both": "两者都显示",
	"display.none": "都不显示",
	cornerLabel: "位置",
	"corner.top-left": "左上角",
	"corner.top-right": "右上角",
	"corner.bottom-left": "左下角",
	"corner.bottom-right": "右下角",
	marginX: "水平偏移",
	marginY: "垂直偏移",
	save: "保存",
	saveHotkey: "Ctrl+S / Cmd+S",
	sync: "同步",
	confirmSync: "确定同步吗？将用项目内置的默认配置（完整字段 + 注释）覆盖用户配置，当前的自定义内容会丢失。",
	corruptTitle: "用户配置已损坏，未保存",
	corruptConfirm: "强行保存",
	corruptBody: "用户配置文件解析不了（内容已损坏，不是合法 JSON/JSONC）：{path}。继续保存会按白名单重建这个文件——它里面现有的内容（animations / physics / memes 等自定义字段）会全部丢失。取消 = 不动文件（先去把配置改回合法再保存）；确认 = 强行保存（丢弃文件里现有的内容）。",
	syncHint: "「同步」会把项目内置的默认配置（含注释与全部高级字段）写入用户配置文件，覆盖当前自定义内容；之后可直接编辑该文件。注意两点：① 文件一旦生成即为显式覆盖层——插件升级后内置默认的变化不会自动生效（除非再次同步或删除该文件）；② 在本页点「保存」会按白名单重写该文件（字段值保留，但注释会被去掉）。",
	configMeta: "高级配置（文件）",
	configMetaHint: "用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效：浏览器端刷新页面，桌面端右键宠物 →「重载配置」（重载全部桌面宠物窗口）；默认配置为完整参考。",
	defaultConfig: "默认配置（只读，完整参考）",
	userConfig: "用户配置（自定义覆盖）",
	todosFile: "待办数据（清单正文、到期时间与完成状态；删掉等于清空待办）",
	animationDir: "动画素材目录（可自定义/扩充动画）",
	memesDir: "表情包目录（可自定义/扩充配图）",
	logFile: "日志文件（排障用，可清空）",
	logFileNote: "桌面版没有控制台，插件的运行日志（启动、桌面宠物崩溃/重启、错误与告警）全部写进这一个文件；反馈问题请附上它。单文件上限 1 MB，写满只留最新的 512 KB。",
	saved: "已保存，桌宠即时生效。",
	loadError: "加载配置失败",
	saveError: "保存配置失败，请检查服务连接、配置目录的写入权限或服务日志。",
	saveInvalid: "保存配置失败：配置内容无效，请检查后重试。",
	syncError: "同步配置失败，请检查服务连接和配置目录的写入权限。",
	loading: "正在加载配置…",
	retry: "重试",
	invalid: "请检查输入：大小需为正数，边距可为任意数字。",
	busy: "保存中…",
	extraPetsHint: "另 {n} 个种类来自 pet/ 目录文件（<名>-config.json + <名>-animation/），在上方「种类」条里切换即可修改；保存会写回各自的角色包配置，不混进 main-config.jsonc。",
	kindLabel: "种类",
	kindMain: "内置",
	lastOfKind: "「{entry}」只剩这一只，删掉就没有这个种类了。要彻底移除请直接删除该角色包文件。",
	savePartial: "主宠物已保存，但 {names} 没能写回：检查该角色包配置是否合法、目录是否可写。",
	notifyToggle: "系统通知",
	notifyToggleHint: "对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。",
	clickSoundToggle: "点击音效",
	clickSoundToggleHint: "点一下宠物播一声内置音效（assets/sound/click-duck.wav，音量 0.5；100ms 内的连续点击只响一次，多开也不会叠音）。关掉即完全静音。随「保存」写入用户配置。",
	whisperImageToggle: "碎碎念配图",
	whisperImageToggleHint: "碎碎念时从表情包池随机抽一张，连同那句话一起显示（图片映射在配置文件顶层 memes）。token：碎碎念本来就每次生成都要调一次模型，配图只是把抽中那张的名称+描述（约 100 字符 / ≈60 token）加进同一次请求，增量可忽略。",
	chatImageToggle: "对话配图",
	chatImageToggleHint: "对话时由 AI 按当前语境从表情包池挑一张配图（可不挑；图片映射在配置文件顶层 memes）。token：每条消息都要把整张清单附进请求，当前约 1.1k 字符（≈650 token，约碎碎念配图的 11 倍），并随图片数量线性增长；关掉则一个字符都不附。",
	chatAnimationToggle: "对话动作联动",
	chatAnimationToggleHint: "开启后，对话时会把可表演的动作清单（animations.categories 下的全部动作）交给模型：模型认为这句话确实在演某个动作时，宠物当场演出来；没有合适的就只回文字。token：每条消息都要附整张动作清单，关掉则一个名字都不附。全局默认，所有宠物共用（pet pack 可在自己种类文件里覆盖）。",
	confineToggle: "锁定在当前屏幕",
	confineToggleHint: "多屏用户：开了之后宠物只在当前所在那块屏幕内活动——甩出去的宠物只在松手时所在那块屏内弹（屏缝当墙，不飞到隔壁屏），自主漫游也只在当前所在那块屏内走（越出屏缝的那一步直接取消）。关掉则照常跨屏飞行 / 跨屏行走。只影响桌面模式——浏览器 overlay 本来就只在视口内活动。",
	trayToggle: "系统托盘",
	trayToggleHint: "桌面模式启动后在通知区域（macOS 为菜单栏）常驻一个图标，列出配置里的全部宠物，勾选就能切换显示位置——包括当前不在桌面、没有窗口可右键的那些。关掉之后要把宠物叫回桌面，只能开浏览器用设置页，或在网页端那只宠物身上右键。Windows 本来就会把它折叠进「隐藏的图标」面板。仅影响桌面模式。",
	requestBubbleToggle: "审批气泡",
	requestBubbleToggleHint: "需要你审批的工具调用、以及 AI 的提问，直接弹在宠物头顶：点「允许一次 / 拒绝」，或从选项里挑一个，答案立刻回传给会话，不必切回 DSH 面板。只有宠物页在线时才接管；不在线、关掉这个开关、或已有另一条请求在处理时，都会自动交回 DSH 原生面板。",
	scheduleReminderToggle: "定时任务提醒",
	scheduleReminderToggleHint: "用 schedule_create 建的任务到点时，宠物顶着气泡提醒一句（只负责提醒，真正触发会话的仍是 DSH 调度器）。任务改期会跟着重排；宠物页不在线时跳过，回来再补。随「保存」写入用户配置。",
	menuTitle: "右键菜单",
	menuHint: "右键宠物弹出什么、按什么顺序。拖动左侧把手可以调整顺序，右侧按钮控制这一项显不显示。只排工具项——动画点播、显示位置与第三方「更多」各有出现条件，不在这里排。随「保存」写入用户配置。",
	menuMoveUp: "上移",
	menuMoveDown: "下移",
	menuShow: "显示",
	menuHide: "隐藏",
	menuDrag: "拖动排序",
	menuReset: "恢复默认",
	menuNote: "隐藏的项仍留在原位置，重新「显示」就回到原位。默认顺序里「对话」在最前。",
	voiceTitle: "语音播报",
	voiceHint: "桌宠出声的三个开关与音色：总开关管自动播报，两个细分开关各管一类主动消息。默认全关，随「保存」写入用户配置（不做即时写入）。",
	voiceEnabled: "语音播报",
	voiceEnabledHint: "自动播报的总开关。关掉后周期碎碎念与待办提醒都不念（下面两个细分开关不起作用）；对话回复与对话面板的喇叭按钮不受它限制——那些是你主动点的，发起的那一端直接念（碎碎念由下面两个细分开关管）。只影响「说不说」：气泡、对话记忆与系统通知都不受影响；合成失败只留日志，不打断对话。",
	voiceWhisperEnabled: "碎碎念播报",
	voiceWhisperEnabledHint: "所有碎碎念——周期生成的、右键点的、命令触发的——都按本项决定念不念。受上面的总开关约束：总开关关掉时本项不起作用。默认关闭——碎碎念是背景旁白，不该默认出声。",
	voiceTodoEnabled: "待办播报",
	voiceTodoEnabledHint: "到点的待办提醒念出来（同一句照样弹气泡，本项只决定念不念）。受上面的总开关约束。默认关闭。",
	voiceEngineLabel: "声音引擎",
	voiceEngineHint: "用谁的嗓子念。edge 是内置的微软语音，免费、开箱即用；breeze 用你自己的 Breeze API Key（breeze-tts-2 模型），音色可自建或克隆，按你账号的额度计费。只决定「用谁的嗓子」，念不念仍看上面三个开关。",
	voiceEngineEdge: "内置（Edge）",
	voiceEngineBreeze: "Breeze 在线",
	breezeKeyLabel: "Breeze API Key",
	breezeKeyHint: "brz_ 开头，在 Breeze 后台的 API Keys 页复制。只存在本机用户配置里，随「保存」写入；别把它贴到公开仓库或截图里。",
	breezeVoiceLabel: "Breeze 音色",
	breezeVoiceAuto: "自动（第一个音色）",
	breezeVoiceHint: "你账号里能用的音色；选「自动」就用列表第一个。改了 Key 要保存之后才会拉到新列表。",
	breezeSpeedLabel: "Breeze 语速",
	breezeSpeedHint: "0.5–2 倍，1 是原速。与试听、播报共用同一个倍率；内置引擎不受它影响（内置按百分比念）。",
	breezeStatusLabel: "连接状态",
	breezeStatusHint: "「重新检测」会拿已保存的 Key 去 Breeze 拉一次音色列表：拉得到就说明 Key 可用。没保存的改动它看不到。",
	breezeRefresh: "重新检测",
	breezeNoKey: "还没填 Key——填上并保存后再点「重新检测」。",
	breezeBadKey: "Key 无效或已被重置，请到 Breeze 后台复制新的。",
	breezeListFailed: "连不上 Breeze（网络或服务异常），Key 未必有问题。",
	breezeReady: "Key 可用，音色列表已就绪。",
	voiceNameLabel: "音色",
	voiceVolumeLabel: "音量",
	voiceVolumeHint: "播报音量，0–1 的小数：1 是最大音量（100%），0 是静音。只改播放响度，不会重新合成音频，调它不额外花钱。与上面的总开关是两件事——总开关关着时它不起作用。",
	voicePreview: "试听",
	voicePreviewSample: "先摸摸头再说话，不然我沉下去给你看。",
	voicePreviewHint: "用当前音色念一遍，听的就是保存后播报的效果；留空念默认这句，也可以改成自己的话（最多 500 字）。",
	voicePreviewBusy: "合成中…",
	voicePreviewFailed: "试听失败：{msg}",
	physicsTitle: "物理（拖拽抛掷手感）",
	physicsHint: "全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置（不做即时写入）。浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。",
	mobileTitle: "移动端效果",
	mobileHint: "这几项只在手机浏览器上有意义：振动要有马达，两个体感开关要有姿态 / 加速度传感器；传感器还要求 HTTPS 或 localhost。",
	"physics.gravity": "重力",
	"physics.gravityHint": "px/s²，越大落得越快；0 = 无重力（抛出去匀速直线飞）",
	"physics.restitution": "弹性",
	"physics.restitutionHint": "0~1，碰壁 / 落地反弹保留的速度比例（1 = 完全弹性，0 = 撞上即停）",
	"physics.groundFriction": "接触摩擦",
	"physics.groundFrictionHint": "/s，撞墙 / 落地 / 撞顶后沿接触面方向的速度衰减率；0 = 四面都像冰面",
	"physics.throwPower": "总力度",
	"physics.throwPowerHint": "> 0，弹簧跟手与甩出初速的整体倍率（1 = 默认；越大越跟手、甩得越猛）",
	physicsCeilingBounce: "顶部反弹",
	physicsCeilingBounceHint: "关掉后抛掷可飞出屏幕顶部（重力仍会把它拉回来）",
	physicsPetCollision: "宠物互撞",
	physicsPetCollisionHint: "飞行中的宠物撞到别的宠物按动量守恒弹开（质量 ∝ 尺寸²）",
	physicsHaptic: "碰撞震动",
	physicsHapticHint: "撞墙、落地、撞顶、互撞各震一下。Chrome / Edge 可用；iOS 与 Via 等 WebView 壳不生效；勿扰模式会挡住振动。",
	physicsTilt: "倾斜控制重力",
	physicsTiltHint: "倾斜手机 = 重力朝那边，大小就是上面的重力值；重力为 0 时倾斜没有效果。需要 HTTPS 或 localhost。",
	physicsShake: "摇一摇抛出",
	physicsShakeHint: "摇一摇沿甩动方向把宠物甩出去，力度 = 基准 × 总力度；与重力无关，重力设 0 也能甩。需要 HTTPS 或 localhost。",
	invalidPhysics: "请检查物理参数：重力 / 地面摩擦 ≥ 0，弹性 0~1，总力度 > 0。",
	fontTitle: "外观与字体",
	fontHint: "字体种类作用于现在用软糖体的全部文字：宠物气泡、悬浮提示、对话窗、得分弹窗；字号只作用于宠物气泡与悬浮提示（对话窗与得分弹窗的字号不变）。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置，浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。",
	fontFamilyLabel: "字体",
	fontFamilyHint: "「软糖体（内置）」随插件提供；其余为系统字体，机器上没装时自动回退到字体栈里的下一个（不会空白或报错）。",
	fontSizeLabel: "字号（px）",
	fontSizeHint: "气泡正文字号；悬浮提示与气泡内的小字按既有比例派生。范围 4~200。",
	fontFollowToggle: "字号随宠物大小缩放",
	fontFollowToggleHint: "开启（默认）：宠物调大时字号等比放大，462 宽时正好是上面设定的字号；关闭：字号恒定，不随宠物大小变化。",
	invalidFont: "请检查字体设置：字体需在下拉列表内，字号需为 4~200 的数字。",
	"font.candy": "软糖体（内置）",
	"font.yahei": "微软雅黑 / 苹方",
	"font.youyuan": "幼圆",
	"font.kaiti": "楷体",
	"font.simsun": "宋体",
	"font.comic": "漫画体",
	"font.system": "系统默认",
	modelTitle: "对话与模型",
	modelHint: "碎碎念与对话各自用哪个模型，以及对话每次带多少历史进上下文。选「跟随当前对话」= 用你当前对话正在用的那个模型（默认）。全局默认：对所有宠物生效，pet pack 可在自己种类文件里单独覆盖。选项与 DSH 的模型选择器同源，由宿主实时提供。",
	modelFollow: "跟随当前对话",
	modelSearch: "搜索模型…",
	modelEmpty: "没有匹配的模型。",
	modelNoModels: "没有可用的模型。",
	modelLoading: "正在刷新模型列表…",
	modelTriggerAria: "选择模型，当前 {model}",
	modelUnknown: "（当前配置，不在列表中）",
	modelNone: "该服务商没有可用模型",
	whisperModelLabel: "碎碎念模型",
	chatModelLabel: "对话模型",
	modelFieldHint: "选「跟随当前对话」= 用当前对话的模型；指定了但调用失败会自动回落到当前对话的模型重试一次。",
	invalidModel: "请检查模型设置：服务商与模型要么都选，要么都留空（跟随当前对话）。",
	modelCatalogFailed: "模型列表加载失败（刷新页面可重试）；当前配置值仍会原样保留。",
	chatMemory: "对话历史条数",
	chatMemoryHint: "每次对话请求携带的最近历史轮数（1 轮 = 1 问 1 答；0 = 不带历史，每句都是全新对话）。对话记忆本身全存不删，此值只决定截多少进上下文——越大越记得住，也越费 token。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。",
	invalidChatMemory: "请检查对话历史条数：需为 ≥ 0 的数字。",
	chatImageLimit: "对话配图张数上限",
	chatImageLimitHint: "对话时发给模型的表情包清单最多几张（「前 N 张」= 配置里写在前面的那 N 条，想让哪几张优先被发出去就把顺序往前挪）。整张清单是每条消息都要附的，token 随张数线性增长——张数一多就是纯烧钱，限制成前 N 张，模型只从这几张里挑。0 = 不限制（全部发）。内置默认 10。全局默认，所有宠物共用（pet pack 可在自己种类文件里覆盖）。只影响对话选图：碎碎念只带抽中的那一张。",
	invalidChatImageLimit: "请检查对话配图张数上限：需为 ≥ 0 的数字（0 = 不限制）。",
	notifyTest: "测试弹窗",
	notifyTestOk: "测试通知已发送，请查看桌面右下角。",
	notifyDenyUnsupported: "当前环境不支持系统通知（浏览器无 Notification API）。",
	notifyDenyBlocked: "通知权限已被浏览器标记为「阻止」。",
	notifyDenyRejected: "你在权限询问弹窗中选择了「阻止」。",
	notifyDenyError: "申请权限时出错",
	notifyGuide: "引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。",
	homeLabel: "数据目录",
	homeHint: "配置、待办、记忆、表情包等数据的存放位置。留空恢复默认；切换后需重启 DSH 生效。",
	homeApply: "应用",
	homeReset: "恢复默认",
	homeSaved: "已保存，重启 DSH 后生效。",
	homeFailed: "保存失败：请确认是绝对路径且有写入权限。",
	homeEnvLocked: "当前目录由环境变量 DSH_PET_HOME 指定，这里改不了。",
	storageTitle: "卸载与存储",
	storageHint: "插件在本机落下的全部位置。删缓存不影响使用（会自动重下/重建）；删「插件用户数据」会丢配置与对话记忆。",
	"storage.userData": "插件用户数据：自定义配置 main-config.jsonc、对话记忆 memory.json、自定义动画素材 main-animation/、文件宠物 pet/",
	"storage.electron": "桌面宠物用的 Electron 运行时（体积较大；删除后下次启用桌面模式会自动重新下载）",
	"storage.desktopCache": "桌面宠物窗口的缓存与主屏缩放缓存（可删，会自动重建）",
	"storage.electronCache": "Electron 安装包下载缓存（可删，需要时会重新下载）",
	"storage.package": "插件本体（由 DSH 管理，用下面的卸载命令移除，不要手删）",
	storageMissing: "（尚未创建）",
	uninstallTitle: "卸载方法",
	uninstallStep1: "1. 先退出 DSH（桌面宠物随之退出）；不要在桌宠运行时删除上面的文件。",
	uninstallStep2: "2. 卸载插件本体（终端执行，会同时从 profile 的 bundle 层移除）：",
	uninstallStep3: "3. 按需删除上面的位置：缓存类删了无影响；「插件用户数据」删了会丢配置与对话记忆（想保留就先备份其中的 main-config.jsonc）。",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-pet"
};

//#endregion
//#region src/client/settings/locales/index.ts
const NS = "pet.config";
const dicts = {
	zh,
	en,
	ja,
	es,
	fr,
	de,
	ru,
	pt
};

//#endregion
//#region src/client/settings.ts
function makePetConfigSection(rt, ctx) {
	const { h, useState, useEffect, useRef, useCallback, t } = rt;
	injectSettingsCss();
	const { q } = makeUiKit({
		h,
		t
	});
	const ModelPicker = makeModelPicker({
		h,
		useState,
		useEffect,
		useRef,
		t
	});
	const VoicePicker = makeVoicePicker({
		h,
		useState,
		useEffect,
		useRef
	});
	const VoicePreview = makeVoicePreview({
		h,
		useState,
		useEffect,
		useRef,
		useCallback,
		t
	});
	const PetTabs = makePetTabs({
		h,
		t
	});
	const KindTabs = makeKindTabs({
		h,
		t
	});
	const PetCard = makePetCard(rt);
	const GlobalCard = makeGlobalCard(rt);
	const MenuCard = makeMenuCard(rt);
	const VoiceCard = makeVoiceCard(rt, VoicePicker, VoicePreview);
	const FontCard = makeFontCard(rt);
	const ModelCard = makeModelCard(rt, ModelPicker);
	const PhysicsCard = makePhysicsCard(rt);
	const ShortcutsCard = makeShortcutsCard(rt, ctx);
	const MobileCard = makeMobileCard(rt);
	const Actions = makeActions(rt);
	const { ConfigMetaCard, StorageCard } = makePathsCards(rt);
	const SettingsDialog = makeDialog(rt);
	const LoadStatus = makeLoadStatus({
		h,
		t
	});
	return function PetConfigSection() {
		const [saving, setBusy] = useState(false);
		const [msg, setMsg] = useState({
			kind: "",
			text: ""
		});
		const [permMsg, setPermMsg] = useState({
			kind: "",
			text: ""
		});
		const rootRef = useRef(null);
		const [dialog, setDialog] = useState(null);
		const { pets, mainPets, kinds, kind, visiblePets, selId, entryPrompt, select, selectKind, update, add, requestRemove, remove, replace, packWrites } = usePetList(rt, setDialog);
		const { paths, catalog, catalogFailed } = useRemoteData(rt);
		useEffect(() => attachTipLayer(), []);
		useEffect(() => {
			let alive = true;
			fetch(ROUTE_PATH + "/voice/voices").then((response) => response.ok ? response.json() : null).then((body) => {
				if (alive && body && Array.isArray(body.voices)) setVoiceOptions(body.voices);
			}).catch(() => void 0);
			return () => {
				alive = false;
			};
		}, []);
		const [notifyEnabled$1, setNotifyEnabled] = useState(true);
		const [clickSound, setClickSound] = useState(true);
		const [whisperImage, setWhisperImage] = useState(false);
		const [chatImage, setChatImage] = useState(false);
		const [chatAnimation, setChatAnimation] = useState(true);
		const [confineScreen, setConfineScreen] = useState(false);
		const [trayEnabled, setTrayEnabled] = useState(true);
		const [requestBubble, setRequestBubble] = useState(true);
		const [scheduleReminders, setScheduleReminders] = useState(true);
		const [menuOrder, setMenuOrder] = useState([]);
		const [menuHidden, setMenuHidden] = useState([]);
		const [voiceEnabled$1, setVoiceEnabled] = useState(false);
		const [voiceName$1, setVoiceName] = useState("zh-CN-XiaoyiNeural");
		const [voiceVolume$1, setVoiceVolume] = useState(1);
		const [voiceWhisperEnabled, setVoiceWhisperEnabled] = useState(false);
		const [voiceTodoEnabled, setVoiceTodoEnabled] = useState(false);
		const [voiceEngine, setVoiceEngine] = useState("edge");
		const [breezeKey, setBreezeKey] = useState("");
		const [breezeVoice, setBreezeVoice] = useState("");
		const [breezeSpeed, setBreezeSpeed] = useState(1);
		const [breezeVoices, setBreezeVoices] = useState([]);
		const [breezeNote, setBreezeNote] = useState("no-key");
		/**
		* 拉一次「当前引擎 + Breeze 音色列表」。
		*
		* 只在配置就绪或刚保存成功之后调：拉音色要拿用户填的 Key 连一次上游，顺便就成了「Key 对不对」的探针。
		* 失败只降级成提示行，不抛错——语音是旁路能力，配置页不能因为上游挂了就打不开。
		*/
		const loadBreeze = useCallback(() => {
			fetch(ROUTE_PATH + "/voice/engine").then((response) => response.ok ? response.json() : null).then((body) => {
				if (!body) {
					setBreezeNote("list-failed");
					return;
				}
				setBreezeVoices(Array.isArray(body.voices) ? body.voices : []);
				setBreezeNote(body.error ?? (body.hasKey ? "ok" : "no-key"));
			}).catch(() => setBreezeNote("list-failed"));
		}, []);
		const [voiceOptions, setVoiceOptions] = useState([]);
		const [physics, setPhysics] = useState({ ...DEFAULT_PHYSICS });
		const [font, setFont] = useState({ ...DEFAULT_FONT });
		const [whisperModel, setWhisperModel] = useState({
			provider: "",
			model: ""
		});
		const [chatModel, setChatModel] = useState({
			provider: "",
			model: ""
		});
		const [chatMemory, setChatMemory] = useState(10);
		const [chatImageLimit, setChatImageLimit] = useState(20);
		const [avatarVersion, setAvatarVersion] = useState(Date.now());
		const [avatarBusy, setAvatarBusy] = useState(false);
		const applyConfig = useCallback((merged) => {
			const entries = readConfigEntries(merged);
			const patch = readMainConfig(merged);
			if (entries === null || patch === null) throw new Error("Invalid config response");
			replace(entries);
			if (patch.notificationsEnabled !== void 0) setNotifyEnabled(patch.notificationsEnabled);
			if (patch.clickSoundEnabled !== void 0) setClickSound(patch.clickSoundEnabled);
			if (patch.whisperImageEnabled !== void 0) setWhisperImage(patch.whisperImageEnabled);
			if (patch.chatImageEnabled !== void 0) setChatImage(patch.chatImageEnabled);
			if (patch.chatAnimationEnabled !== void 0) setChatAnimation(patch.chatAnimationEnabled);
			if (patch.confineToScreen !== void 0) setConfineScreen(patch.confineToScreen);
			if (patch.trayEnabled !== void 0) setTrayEnabled(patch.trayEnabled);
			if (patch.requestBubbleEnabled !== void 0) setRequestBubble(patch.requestBubbleEnabled);
			if (patch.scheduleRemindersEnabled !== void 0) setScheduleReminders(patch.scheduleRemindersEnabled);
			if (patch.menuOrder !== void 0) setMenuOrder(patch.menuOrder);
			if (patch.menuHidden !== void 0) setMenuHidden(patch.menuHidden);
			if (patch.voiceEnabled !== void 0) setVoiceEnabled(patch.voiceEnabled);
			if (patch.voiceName !== void 0) setVoiceName(patch.voiceName);
			if (patch.voiceVolume !== void 0) setVoiceVolume(patch.voiceVolume);
			if (patch.voiceWhisperEnabled !== void 0) setVoiceWhisperEnabled(patch.voiceWhisperEnabled);
			if (patch.voiceTodoEnabled !== void 0) setVoiceTodoEnabled(patch.voiceTodoEnabled);
			if (patch.voiceEngine !== void 0) setVoiceEngine(patch.voiceEngine);
			if (patch.breezeApiKey !== void 0) setBreezeKey(patch.breezeApiKey);
			if (patch.breezeVoice !== void 0) setBreezeVoice(patch.breezeVoice);
			if (patch.breezeSpeed !== void 0) setBreezeSpeed(patch.breezeSpeed);
			if (patch.voiceEngine === "breeze") loadBreeze();
			if (patch.physics !== void 0) setPhysics(patch.physics);
			if (patch.font !== void 0) setFont(patch.font);
			if (patch.whisperModel !== void 0) setWhisperModel(patch.whisperModel);
			if (patch.chatModel !== void 0) setChatModel(patch.chatModel);
			if (patch.chatMemoryRounds !== void 0) setChatMemory(patch.chatMemoryRounds);
			if (patch.chatImageLimit !== void 0) setChatImageLimit(patch.chatImageLimit);
		}, [replace, loadBreeze]);
		const { loadState, retry } = useConfigLoad(rt, applyConfig);
		const busy = saving || loadState !== "ready";
		const toggleNotify = async (v) => {
			setNotifyEnabled(v);
			if (v) await requestNotificationPermission();
		};
		const testNotification = () => void runNotificationTest({
			t,
			report: setPermMsg
		});
		const cur = pets.find((p) => p.id === selId) ?? null;
		const avatarEditable = cur !== null && cur.assetRoot !== void 0 && cur.assetRoot !== "main";
		/** 上传当前宠物的头像：直接落盘、不经过「保存」——头像不是配置字段，改完不必再点保存。
		*  归属看素材根（文件宠物是目录前缀，同一素材根的多只实例共用一张）。 */
		const uploadAvatar = (file) => {
			if (cur === null) return;
			const assetRoot = cur.assetRoot ?? "";
			setAvatarBusy(true);
			(async () => {
				try {
					const result = await uploadPetAvatar(assetRoot, file);
					if (!result.ok) {
						setMsg({
							kind: "err",
							text: result.message
						});
						return;
					}
					setAvatarVersion(Date.now());
					setMsg({
						kind: "ok",
						text: t("avatarUploaded")
					});
				} catch (error) {
					setMsg({
						kind: "err",
						text: error instanceof Error ? error.message : String(error)
					});
				} finally {
					setAvatarBusy(false);
				}
			})();
		};
		const packCount = kinds.filter((item) => item.kind === "pack").length;
		const globalFlags = {
			notificationsEnabled: notifyEnabled$1,
			clickSoundEnabled: clickSound,
			confineToScreen: confineScreen,
			trayEnabled,
			requestBubbleEnabled: requestBubble,
			scheduleRemindersEnabled: scheduleReminders
		};
		const chatFlags = {
			whisperImageEnabled: whisperImage,
			chatImageEnabled: chatImage,
			chatAnimationEnabled: chatAnimation
		};
		const flagSetters = {
			notificationsEnabled: (value) => void toggleNotify(value),
			clickSoundEnabled: setClickSound,
			confineToScreen: setConfineScreen,
			trayEnabled: setTrayEnabled,
			requestBubbleEnabled: setRequestBubble,
			scheduleRemindersEnabled: setScheduleReminders,
			whisperImageEnabled: setWhisperImage,
			chatImageEnabled: setChatImage,
			chatAnimationEnabled: setChatAnimation
		};
		const setGlobalFlag = (key, value) => flagSetters[key](value);
		const setChatFlag = (key, value) => flagSetters[key](value);
		/** 局部补丁写入：字体与物理参数都是「整段对象 + 改几个字段」。 */
		const patchFont = (patch) => setFont((current$1) => ({
			...current$1,
			...patch
		}));
		const patchPhysics = (patch) => setPhysics((current$1) => ({
			...current$1,
			...patch
		}));
		/** 两个模型字段各有一份状态，卡片只回传键名。 */
		const setModel = (key, value) => {
			if (key === "whisperModel") setWhisperModel(value);
			else setChatModel(value);
		};
		const write = createWriteFlow({
			fields: () => ({
				pets: mainPets,
				notificationsEnabled: notifyEnabled$1,
				clickSoundEnabled: clickSound,
				whisperImageEnabled: whisperImage,
				chatImageEnabled: chatImage,
				chatAnimationEnabled: chatAnimation,
				confineToScreen: confineScreen,
				trayEnabled,
				requestBubbleEnabled: requestBubble,
				scheduleRemindersEnabled: scheduleReminders,
				voiceEnabled: voiceEnabled$1,
				voiceName: voiceName$1,
				voiceVolume: voiceVolume$1,
				voiceWhisperEnabled,
				voiceTodoEnabled,
				voiceEngine,
				breezeApiKey: breezeKey,
				breezeVoice,
				breezeSpeed,
				physics,
				whisperModel,
				chatModel,
				chatMemoryRounds: chatMemory,
				chatImageLimit,
				font,
				menuOrder,
				menuHidden
			}),
			busy: () => busy,
			setBusy,
			setMsg,
			setDialog,
			dialog: () => dialog,
			applyConfig,
			packWrites,
			userFile: () => paths?.user ?? "",
			t,
			onRemove: remove
		});
		const saveRef = useRef(() => {});
		useEffect(() => {
			saveRef.current = () => void write.save();
		});
		useEffect(() => {
			const onKey = (e) => {
				if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
				if (e.key.toLowerCase() !== "s") return;
				const root = rootRef.current;
				if (!root || !root.isConnected || root.getClientRects().length === 0) return;
				e.preventDefault();
				saveRef.current();
			};
			document.addEventListener("keydown", onKey);
			return () => document.removeEventListener("keydown", onKey);
		}, []);
		return h("section", {
			ref: rootRef,
			className: "dsh-pet-cfg",
			style: { maxWidth: "720px" },
			children: [
				h("h2", {
					className: "dsh-pet-cfg__title",
					children: [t("nav"), q(packCount > 0 ? t("intro") + "\n" + t("extraPetsHint").replace("{n}", String(packCount)) : t("intro"))]
				}),
				h(LoadStatus, {
					loadState,
					onRetry: retry
				}),
				h(Actions, {
					busy,
					msg,
					permMsg,
					onSave: () => void write.save(),
					onSync: write.requestSync,
					onTestNotification: testNotification
				}),
				h(KindTabs, {
					kinds,
					kind,
					busy,
					onSelect: selectKind
				}),
				h(PetTabs, {
					pets: visiblePets,
					selId,
					busy,
					onSelect: select,
					onAdd: add
				}),
				h(PetCard, {
					pet: cur,
					busy,
					msg,
					entryPrompt,
					avatarSrc: avatarUrl(cur?.assetRoot ?? "", avatarVersion),
					avatarBusy,
					...avatarEditable ? { onAvatar: uploadAvatar } : {},
					onChange: update,
					onSave: () => void write.save(),
					onRemove: requestRemove
				}),
				h(GlobalCard, {
					busy,
					values: globalFlags,
					onChange: setGlobalFlag
				}),
				h(MenuCard, {
					busy,
					order: menuOrder,
					hidden: menuHidden,
					onChange: (order, hidden) => {
						setMenuOrder(order);
						setMenuHidden(hidden);
					}
				}),
				h(VoiceCard, {
					busy,
					enabled: voiceEnabled$1,
					voiceName: voiceName$1,
					volume: voiceVolume$1,
					voices: voiceOptions,
					whisperEnabled: voiceWhisperEnabled,
					todoEnabled: voiceTodoEnabled,
					engine: voiceEngine,
					breezeKey,
					breezeVoice,
					breezeSpeed,
					breezeVoices,
					breezeNote,
					onToggle: setVoiceEnabled,
					onVoiceChange: setVoiceName,
					onVolumeChange: setVoiceVolume,
					onWhisperToggle: setVoiceWhisperEnabled,
					onTodoToggle: setVoiceTodoEnabled,
					onEngineChange: setVoiceEngine,
					onBreezeKeyChange: setBreezeKey,
					onBreezeVoiceChange: setBreezeVoice,
					onBreezeSpeedChange: setBreezeSpeed,
					onBreezeRefresh: loadBreeze
				}),
				h(FontCard, {
					busy,
					font,
					onChange: patchFont
				}),
				h(ModelCard, {
					busy,
					catalog,
					failed: catalogFailed,
					whisperModel,
					chatModel,
					onModelChange: setModel,
					chatMemory,
					chatImageLimit,
					onChatMemoryChange: setChatMemory,
					onChatImageLimitChange: setChatImageLimit,
					values: chatFlags,
					onFlagChange: setChatFlag
				}),
				h(PhysicsCard, {
					busy,
					physics,
					onChange: patchPhysics
				}),
				h(MobileCard, {
					busy,
					physics,
					onChange: patchPhysics
				}),
				h(ShortcutsCard, {}),
				paths ? h(ConfigMetaCard, { paths }) : null,
				paths ? h(StorageCard, { paths }) : null,
				dialog ? h(SettingsDialog, {
					dialog,
					selId,
					onDismiss: () => setDialog(null),
					onConfirm: write.confirmDialog
				}) : null
			]
		});
	};
}

//#endregion
//#region src/client/pet/click-sound.ts
/** 音效文件地址。 */
const CLICK_SOUND_URL = ROUTE_PATH + "/sound/click-duck.wav";
/** 音量：与其余提示音同一档，不抢对话内容。 */
const CLICK_SOUND_VOLUME = .5;
/** 连点节流：100ms 内只响一次，避免连点变成噪音。 */
const CLICK_SOUND_THROTTLE_MS = 100;
/** 复用的 audio 实例，首次播放时创建。 */
let clickAudio = null;
/** 上一次真正播放的时间戳（ms）。 */
let lastClickSoundAt = 0;
/** 点击音效开关；配置未加载前保守静音。 */
let clickSoundEnabled = false;
function setClickSoundEnabled(enabled) {
	clickSoundEnabled = enabled;
}
function playClickSound() {
	if (!clickSoundEnabled) return;
	const now = Date.now();
	if (now - lastClickSoundAt < CLICK_SOUND_THROTTLE_MS) return;
	lastClickSoundAt = now;
	try {
		clickAudio ?? (clickAudio = new Audio(CLICK_SOUND_URL));
		clickAudio.volume = CLICK_SOUND_VOLUME;
		clickAudio.currentTime = 0;
		clickAudio.play().catch(() => {});
	} catch {}
}
function playAttentionSound() {
	if (!clickSoundEnabled) return;
	const fire = (delayMs, volume) => {
		setTimeout(() => {
			try {
				const audio = new Audio(CLICK_SOUND_URL);
				audio.volume = volume;
				audio.play().catch(() => {});
			} catch {}
		}, delayMs);
	};
	fire(0, .7);
	fire(190, .55);
}

//#endregion
//#region src/client/menu-service.ts
/** owner → 本页可见的 label 列表（来源是 /state 的 sections.menu 快照）。 */
const labels = new Map();
/** owner → 每项的点击闩锁（连点两次同一条只留最后一次，与宿主一致）。 */
const marks = new Map();
function setMenuItems(items) {
	labels.clear();
	for (const item of items) {
		const list = labels.get(item.owner);
		if (list === void 0) labels.set(item.owner, [item.label]);
		else if (!list.includes(item.label)) list.push(item.label);
	}
	for (const [owner, entry] of marks) {
		const list = labels.get(owner);
		if (list === void 0) {
			marks.delete(owner);
			continue;
		}
		for (const label of [...entry.keys()]) if (!list.includes(label)) entry.delete(label);
	}
}
function setMenuClick(owner, label, pet) {
	let entry = marks.get(owner);
	if (entry === void 0) {
		entry = new Map();
		marks.set(owner, entry);
	}
	entry.set(label, pet);
}
function takeMenuEvents(owner) {
	const list = labels.get(owner);
	if (list === void 0) return {
		ok: false,
		reason: "unknown-owner"
	};
	const entry = marks.get(owner);
	const events = {};
	for (const label of list) {
		events[label] = entry?.get(label) ?? null;
		entry?.set(label, null);
	}
	return {
		ok: true,
		events
	};
}

//#endregion
//#region src/client/pet/menu-actions.ts
/** 显示位置：写配置后宿主回成品聚合，交给容器重渲染。 */
async function switchDisplay(deps, display) {
	try {
		const response = await fetch(ROUTE_PATH + "/pet-display", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: deps.petId,
				display
			})
		});
		if (!response.ok) throw new Error("pet-display HTTP " + response.status);
		const body = await response.json();
		if (body.ok === false) throw new Error("pet-display 被拒：" + String(body.reason ?? ""));
		deps.applyMerged(body);
	} catch (error) {
		deps.warn("[dsh-pet] 显示位置切换失败 " + (error instanceof Error ? error.message : String(error)));
	}
}
function createMenuActions(deps) {
	const { petId } = deps;
	/** 动作端点：POST 一次，失败只留一行 warn——结果由 /state 送回，这里没有返回值可用。 */
	const fireAction = (route, label) => {
		postAction(route).then((ok) => {
			if (!ok) deps.warn("[dsh-pet] " + label + "失败 pet=" + petId);
		}).catch((error) => deps.warn("[dsh-pet] " + label + "异常 pet=" + petId + " " + String(error)));
	};
	const run = (leaf$1, playbackId, keepFacing = false, hostInstruction = false) => {
		if (!hostInstruction && deps.sleeping?.() === true && deps.locked?.() !== true && !isSleepAllowedAction(leaf$1.action)) {
			const pool = deps.sleepRefuseTexts?.() ?? [];
			const text = pool[Math.floor(Math.random() * pool.length)];
			if (text !== void 0) deps.say?.(text);
			return;
		}
		if (leaf$1.action === "third-party") {
			const owner = leaf$1.owner ?? "";
			if (owner !== "") {
				setMenuClick(owner, leaf$1.label, petId);
				postAction(ROUTE_PATH + "/menu/click", {
					owner,
					label: leaf$1.label,
					pet: petId
				}).catch((error) => deps.warn("[dsh-pet] 第三方菜单点击上报失败 " + String(error)));
			}
			return;
		}
		if (leaf$1.action === "sleep" || leaf$1.action === "wake") {
			const route = leaf$1.action === "sleep" ? "/sleep" : "/wake";
			console.info("[dsh-pet] 菜单" + (leaf$1.action === "sleep" ? "睡觉" : "起来") + " pet=" + petId);
			fireAction(ROUTE_PATH + route + "?pet=" + encodeURIComponent(petId), leaf$1.action === "sleep" ? "睡觉" : "起来");
			return;
		}
		if (leaf$1.action === "show-balance") {
			console.info("[dsh-pet] 菜单查看余额 pet=" + petId);
			fireAction(ROUTE_PATH + "/balance", "余额刷新动作");
			return;
		}
		if (leaf$1.action === "whisper") {
			console.info("[dsh-pet] 菜单触发碎碎念 pet=" + petId + (leaf$1.image ? " image=" + leaf$1.image : ""));
			const pic = leaf$1.image ? "&image=" + encodeURIComponent(leaf$1.image) : "";
			fireAction(ROUTE_PATH + "/whisper?pet=" + encodeURIComponent(petId) + "&surface=web" + pic, "碎碎念手动触发");
			return;
		}
		if (leaf$1.action === "chat") {
			deps.openChat();
			return;
		}
		if (leaf$1.action === "todo") {
			deps.openTodo();
			return;
		}
		if (leaf$1.action === "history") {
			deps.openHistory();
			return;
		}
		if (leaf$1.action === "set-display") {
			const display = leaf$1.display;
			if (!display) return;
			console.info("[dsh-pet] 菜单切换显示位置 pet=" + petId + " display=" + display);
			switchDisplay(deps, display);
			return;
		}
		if (leaf$1.action === "home") {
			deps.stopThrow();
			deps.stopMove();
			deps.resetPosition();
			return;
		}
		if (!leaf$1.anim) return;
		const cuePlaybackId = playbackId ?? null;
		if (!keepFacing && isNoMirrorAnimation(deps.animations().categories, leaf$1.anim) && deps.isFacingRight()) deps.faceLeft();
		const movies = deps.animations().moves.actions;
		if (movies.some((action) => action.name === leaf$1.anim)) {
			if (deps.tryMove(leaf$1.anim) === false) {
				deps.stopMove();
				deps.playOnce(leaf$1.anim, cuePlaybackId);
			} else if (cuePlaybackId !== null) deps.report(cuePlaybackId, "failed", "busy");
			return;
		}
		deps.stopMove();
		deps.playOnce(leaf$1.anim, cuePlaybackId);
	};
	return { run };
}

//#endregion
//#region src/client/pet/playback-report.ts
function playbackReportRequest(playbackId, status, reason) {
	return {
		url: ROUTE_PATH + "/playback/" + encodeURIComponent(playbackId) + "/report",
		body: reason === void 0 ? { status } : {
			status,
			reason
		}
	};
}
function makePlaybackReporter(o) {
	return (playbackId, status, reason) => {
		const request = playbackReportRequest(playbackId, status, reason);
		postAction(request.url, request.body).then((ok) => {
			if (!ok) console.warn("[dsh-pet] 播放回执未送达 pet=" + o.petId + " id=" + playbackId + " status=" + status);
		});
	};
}

//#endregion
//#region src/client/pet/animation/next-animation.ts
function decideNextAnimation(input) {
	const { kind, animations, facing, current: current$1, move } = input;
	if (kind === "idle") return {
		kind: "IDLE",
		anim: pick(animations.idle, current$1),
		play: true
	};
	if (kind === "turn") return {
		kind: "TURN",
		anim: pick(animations.turn, current$1),
		play: true
	};
	if (kind === "move" && move !== false && move !== void 0) return {
		kind: "MOVES",
		anim: typeof move === "string" ? move : null,
		play: false
	};
	const action = pickCategoryAction(animations.categories, animations.idle, facing, current$1);
	return {
		kind: action.id,
		anim: action.name,
		play: true
	};
}

//#endregion
//#region src/client/pet/card/sleep-machine.ts
function createSleepMachine(hub, pickNext, log$3) {
	let current$1 = null;
	/** 换一段：`once` 决定播完是否触发 ended（循环段必须 false）。 */
	const play = (name, once) => {
		hub.card.actions.setOnce(once);
		hub.card.actions.setAnim(name);
		hub.card.actions.bumpSeq();
	};
	const apply = (state) => {
		const petId = hub.cfg().id;
		if (state.sleeping) {
			if (current$1 !== null) return;
			hub.stopMotion();
			hub.bubbles.hideWork();
			current$1 = {
				set: {
					start: state.start,
					loop: state.loop,
					end: state.end
				},
				phase: "start"
			};
			log$3(petId, "睡觉 -> [" + state.start + "]");
			play(state.start, true);
			return;
		}
		if (current$1 === null || current$1.phase === "end") return;
		if (current$1.phase === "start") {
			current$1 = null;
			log$3(petId, "入睡被打断：不播起来");
			return;
		}
		current$1.phase = "end";
		log$3(petId, "醒来 -> [" + current$1.set.end + "]");
		play(current$1.set.end, true);
	};
	return {
		apply,
		consumeEnded: () => {
			if (current$1 === null) return false;
			if (current$1.phase === "start") {
				current$1.phase = "loop";
				play(current$1.set.loop, false);
				return true;
			}
			if (current$1.phase === "loop") {
				play(current$1.set.loop, false);
				return true;
			}
			current$1 = null;
			pickNext();
			return true;
		},
		sleeping: () => current$1 !== null,
		phase: () => current$1?.phase ?? null
	};
}

//#endregion
//#region src/client/pet/card/animation-flow.ts
/** 日志行的时刻前缀。 */
const stamp$3 = () => new Date().toTimeString().slice(0, 8);
/** 一行带时刻与宠物 id 的日志。 */
const log$2 = (petId, message) => {
	console.log("[dsh-pet] " + stamp$3() + " pet=" + petId + " " + message);
};
function createAnimationFlow(rt) {
	const { useRef } = rt;
	return function useAnimationFlow(hub, workStatus) {
		const workStatusRef = useRef(workStatus);
		workStatusRef.current = workStatus;
		const machineRef = useRef(null);
		const sleep$1 = () => machineRef.current ?? (machineRef.current = createSleepMachine(hub, pickNext, log$2));
		/** 此刻是否在睡（含两段过渡）。 */
		const sleeping = () => sleep$1().sleeping();
		/** 当前睡觉阶段；醒着为 null。 */
		const sleepPhase = () => sleep$1().phase();
		/** 应用宿主写的睡觉状态（转发给状态机）。 */
		const applySleep = (state) => sleep$1().apply(state);
		/** 非终态工作状态回到档位循环；冻结、空闲与终态都返回 false。 */
		const resumeWorkStatusAnim = () => {
			const card = hub.card;
			if (hub.ownAnim.isFrozen()) return false;
			if (sleeping()) return false;
			const ws = workStatusRef.current;
			if (!ws || !ws.state || ws.state === "success" || ws.state === "error") return false;
			const pool = hub.anims().events?.workStatus;
			if (!pool || pool.length === 0) return false;
			const idx = WORK_STATUS_INDEX[ws.state];
			const slot = pool[idx];
			if (slot === void 0) return false;
			const name = pickSlot(slot, card.animRef.current);
			log$2(hub.cfg().id, "互动结束恢复状态动画: " + name);
			card.actions.setOnce(Array.isArray(slot) && slot.length > 1);
			card.actions.setAnim(name);
			return true;
		};
		/** 按权重掷骰选择下一段自播动画。 */
		const pickNext = () => {
			const card = hub.card;
			if (hub.ownAnim.isFrozen()) return;
			if (sleeping()) return;
			const roll = Math.random();
			const working = hub.cfg().workStatusEnabled && isWorkingState(workStatusRef.current?.state ?? null);
			const kind = rollKind(roll, hub.cfg().animationWeights, {
				fixed: hub.cfg().fixedEnabled,
				still: working
			});
			const move = kind === "move" ? hub.tryWalk() : void 0;
			const decision = decideNextAnimation({
				kind,
				animations: hub.anims(),
				facing: card.facingRef.current,
				current: card.animRef.current,
				move
			});
			log$2(hub.cfg().id, "facing=" + card.facingRef.current + " roll=" + roll.toFixed(4) + " -> [" + decision.kind + "] " + (decision.anim ?? "移动进行中(不重播)"));
			if (decision.play && decision.anim !== null) card.actions.setAnim(decision.anim);
			card.actions.setOnce(true);
			card.actions.bumpSeq();
		};
		/** 按播完判定改状态。 */
		const applyEndedCue = (cue) => {
			const card = hub.card;
			if (sleep$1().consumeEnded()) return;
			if (cue.kind === "ignore") return;
			if (cue.kind === "work-rotate") {
				card.actions.setOnce(true);
				card.actions.setAnim(cue.anim);
				card.actions.bumpSeq();
				return;
			}
			if (cue.kind === "work-replay") {
				card.actions.setOnce(false);
				card.actions.bumpSeq();
				return;
			}
			if (cue.kind === "event-done") {
				if (resumeWorkStatusAnim()) return;
				if (hub.anims().idle.length) card.actions.setAnim(pick(hub.anims().idle, card.animRef.current));
				card.actions.setOnce(true);
				card.actions.bumpSeq();
				return;
			}
			if (cue.kind === "turn") {
				const next = card.state.facing === "left" ? "right" : "left";
				card.actions.setFacing(next);
				card.facingRef.current = next;
				return;
			}
			if (cue.kind === "interaction-done") {
				if (resumeWorkStatusAnim()) return;
				if (hub.anims().idle.length) card.actions.setAnim(pick(hub.anims().idle, card.animRef.current));
				card.actions.setOnce(true);
				card.actions.bumpSeq();
				return;
			}
			pickNext();
		};
		/** 说一句：抽碎碎念动画并弹气泡，两者独立。 */
		const speak$1 = (text, image, url, duration, anim) => {
			const card = hub.card;
			let name = null;
			if (anim !== false && !sleeping()) {
				const pool = hub.anims().events?.whisper;
				if (!pool || pool.length === 0) {
					console.error("[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画");
					return;
				}
				name = pickSlot(pick(pool, card.animRef.current), card.animRef.current);
			}
			log$2(hub.cfg().id, "whisper" + (name === null ? " （不联动动画）" : " -> [" + name + "]") + " 「" + text + "」");
			if (name !== null) {
				hub.stopMotion();
				card.actions.setOnce(true);
				card.actions.setAnim(name);
			}
			hub.bubbles.showWhisper(text, {
				image,
				url
			}, duration);
		};
		return {
			applyEndedCue,
			applySleep,
			pickNext,
			resumeWorkStatusAnim,
			sleepPhase,
			sleeping,
			speak: speak$1
		};
	};
}

//#endregion
//#region src/shared/bubble-hold.ts
const BUBBLE_HOLD_TAIL_MS = 1500;
const BUBBLE_HOLD_MAX_MS = 5e4;
const BUBBLE_HOLD_IDLE = {
	on: false,
	delayMs: null,
	holdSeq: null
};
function reduceBubbleHold(state, event) {
	if (event.kind === "show") return {
		delayMs: Math.max(0, event.durationMs),
		holdSeq: null,
		on: true
	};
	if (event.kind === "clear") return BUBBLE_HOLD_IDLE;
	if (event.kind === "hide") return state.on ? BUBBLE_HOLD_IDLE : state;
	if (!state.on) return state;
	if (event.kind === "hold") {
		if (state.holdSeq === event.seq) return state;
		return {
			delayMs: BUBBLE_HOLD_MAX_MS,
			holdSeq: event.seq,
			on: true
		};
	}
	if (state.holdSeq !== event.seq) return state;
	return {
		delayMs: BUBBLE_HOLD_TAIL_MS,
		holdSeq: null,
		on: true
	};
}

//#endregion
//#region src/shared/voice.ts
/** 当前音色；空串 = 不指定，由宿主用默认音色。 */
let voiceName = "";
/** 播报总开关；只有成品配置明确为 true 才播。 */
let voiceEnabled = false;
/** 播放音量系数（0–1，1 = 最大音量）；两端共用，只作用于播放，不影响已合成好的音频。 */
let voiceVolume = 1;
/** 本端是网页端还是桌面端；`null` = 还没声明，此时不按叶子播放。 */
let surface = null;
/** 接口基址：网页端是同源前缀，桌面端由 `setVoiceBase` 换成 bridge 地址。 */
let voiceBase = ROUTE_PATH;
/** 配置是否已就绪；网页端由 `setVoiceConfig` 置位，桌面端首次播放时懒加载。 */
let configLoaded = false;
/** 当前播报状态；气泡据此显示图标。 */
let voiceState = "idle";
/** 状态订阅者：两端的说话气泡据此渲染图标。 */
const stateListeners = new Set();
/** 播报开始/结束的订阅者：说话气泡据此挂起与收尾。 */
const utteranceListeners = new Set();
/** 播报序号；每次决定要念一句就自增，用来让气泡丢掉迟到的「上一句播完了」。 */
let utteranceSeq = 0;
const VOICE_SPEECH_MAX_CHARS = 60;
/**
* 客户端等合成结果的上限（ms）。
*
* 比宿主侧的总超时（28s）再宽一点：让宿主先超时并回结构化失败，
* 客户端这道只是兜底，避免上游挂住时气泡上的转圈永远停不下来。
*/
const SPEAK_TIMEOUT_MS = 3e4;
/** 合成请求的超时信号；自动播报与手动点播共用同一份口径。 */
function speakSignal() {
	return AbortSignal.timeout(SPEAK_TIMEOUT_MS);
}
/** 切换状态并通知订阅者；同值不重复通知。 */
function setVoiceState(next) {
	if (voiceState === next) return;
	voiceState = next;
	for (const listener of stateListeners) listener(next);
}
function subscribeVoiceState(listener) {
	stateListeners.add(listener);
	listener(voiceState);
	return () => {
		stateListeners.delete(listener);
	};
}
function subscribeVoiceUtterance(listener) {
	utteranceListeners.add(listener);
	return () => {
		utteranceListeners.delete(listener);
	};
}
/** 广播一次播报事件；单个订阅者抛错不能挡住其余订阅者。 */
function emitUtterance(event) {
	for (const listener of utteranceListeners) listener(event);
}
function speechSlice(text) {
	if (text.length <= VOICE_SPEECH_MAX_CHARS) return text;
	const head = text.slice(0, VOICE_SPEECH_MAX_CHARS);
	const cut = Math.max(...[
		"。",
		"！",
		"？",
		"；",
		"，",
		".",
		"!",
		"?",
		";",
		","
	].map((mark) => head.lastIndexOf(mark)));
	return cut >= VOICE_SPEECH_MAX_CHARS / 2 ? head.slice(0, cut + 1) : head;
}
function setSurface(next) {
	if (next === "web" || next === "desktop") surface = next;
}
function setVoiceConfig(name, enabled, volume) {
	voiceName = typeof name === "string" ? name : "";
	voiceEnabled = enabled === true;
	voiceVolume = clampVolume(volume);
	configLoaded = true;
}
/** 把音量收敛到 0–1；非数值按最大音量（1）处理——脏配置不该把声音悄悄变成 0。 */
function clampVolume(value) {
	const n = Number(value);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}
/** 懒加载成品配置；失败按「不播」处理，且只试一次（避免每句都发请求）。 */
async function loadConfigOnce() {
	if (configLoaded) return;
	try {
		const response = await fetch(voiceBase + "/config", { cache: "no-store" });
		const body = await response.json();
		const main = body?.main;
		voiceName = typeof main?.voiceName === "string" ? main.voiceName : "";
		voiceEnabled = main?.voiceEnabled === true;
		voiceVolume = clampVolume(main?.voiceVolume);
		configLoaded = true;
	} catch {}
}
function playSayVoice(say) {
	const isMine = say.voiceTo !== void 0 && say.voiceTo === surface;
	if (!say.text || !isMine) {
		setVoiceState("idle");
		return;
	}
	if (surface === "web" && typeof document !== "undefined" && document.hidden) {
		setVoiceState("idle");
		return;
	}
	speakIfEnabled(say.text);
}
/** 确认配置后再播；桌面端首次调用会顺手拉一次 `/config`。 */
async function speakIfEnabled(text) {
	await loadConfigOnce();
	if (!voiceEnabled) {
		setVoiceState("idle");
		return;
	}
	const seq = ++utteranceSeq;
	emitUtterance({
		kind: "start",
		seq,
		text
	});
	setVoiceState("loading");
	try {
		await speak(speechSlice(text));
	} finally {
		emitUtterance({
			kind: "end",
			seq,
			text
		});
	}
}
/** 请求合成并播放；任何一步失败都落到 `failed`（气泡上留一个静音喇叭，而不是干脆没图标）。 */
async function speak(text) {
	try {
		const response = await fetch(voiceBase + "/voice/speak", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text,
				...voiceName ? { voice: voiceName } : {}
			}),
			signal: speakSignal()
		});
		if (!response.ok || !(response.headers.get("content-type") ?? "").includes("audio")) {
			setVoiceState("failed");
			return;
		}
		const objectUrl = URL.createObjectURL(await response.blob());
		const audio = new Audio(objectUrl);
		audio.volume = voiceVolume;
		audio.onended = () => URL.revokeObjectURL(objectUrl);
		audio.onerror = () => URL.revokeObjectURL(objectUrl);
		setVoiceState("ready");
		await audio.play();
	} catch {
		setVoiceState("failed");
	}
}
/** 手动点播时正在响的那个音频；新的一句先掐掉旧的，避免两句话叠在一起。 */
let manualAudio = null;
/** 手动点播的世代号：新的点播会作废旧请求的阶段回调，避免旧回调清掉新状态。 */
let manualSeq = 0;
function speakText(text, onPhase) {
	if (!text) return;
	playManual(text, onPhase);
}
/** 请求合成并播放手动点播；失败静默，不打断面板交互。 */
async function playManual(text, onPhase) {
	const token = ++manualSeq;
	await loadConfigOnce();
	if (manualAudio) {
		manualAudio.pause();
		manualAudio = null;
	}
	if (token !== manualSeq) return;
	onPhase?.("loading");
	try {
		const response = await fetch(voiceBase + "/voice/speak", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text,
				...voiceName ? { voice: voiceName } : {}
			}),
			signal: speakSignal()
		});
		if (token !== manualSeq) return;
		if (!response.ok || !(response.headers.get("content-type") ?? "").includes("audio")) {
			onPhase?.("failed");
			return;
		}
		const objectUrl = URL.createObjectURL(await response.blob());
		if (token !== manualSeq) return;
		const audio = new Audio(objectUrl);
		audio.volume = voiceVolume;
		audio.onended = () => {
			URL.revokeObjectURL(objectUrl);
			if (manualAudio === audio) {
				manualAudio = null;
				onPhase?.("idle");
			}
		};
		audio.onerror = () => URL.revokeObjectURL(objectUrl);
		manualAudio = audio;
		onPhase?.("playing");
		await audio.play();
	} catch {
		if (token === manualSeq) onPhase?.("failed");
	}
}

//#endregion
//#region src/client/pet/timings.ts
const BUBBLE_DURATION_MS = 10 * 1e3;
const STATE_WAIT_MS = 1e3;
const STATE_FALLBACK_MS = 1e3;

//#endregion
//#region src/client/pet/card/bubble-slots.ts
function decideBubbleSlot(input) {
	if (input.requestOn) return "request";
	if (input.reminderOn) return "reminder";
	if (input.todoOn) return "todo";
	if (input.historyOn) return "history";
	if (input.workTerminal && input.workOn && input.workText && input.workStatusEnabled) return "work-terminal";
	if (input.whisperOn && input.whisperText) return "whisper";
	if (input.balanceOn && input.balanceAvailable && (input.balanceEnabled || input.balanceManual)) return "balance";
	if (input.workOn && input.workText && input.workStatusEnabled) return "work";
	return "none";
}
function balancePageCount(balance) {
	return balance ? balancePageCount$1(balance) : 1;
}
function createBubbleSlots(rt, components) {
	const { h, useState, useRef, useEffect } = rt;
	const BalanceBubble = components.balanceBubble;
	const TodoBubble = components.todoBubble;
	const WhisperBubble = components.whisperBubble;
	const RequestBubble = components.requestBubble;
	const ReminderBubble = components.reminderBubble;
	const HistoryBubble = components.historyBubble;
	return function useBubbleSlots(input) {
		const [balanceOn, setBalanceOn] = useState(false);
		const [balancePage, setBalancePage] = useState(0);
		const balanceTimerRef = useRef(null);
		const [whisperOn, setWhisperOn] = useState(false);
		const [whisperText, setWhisperText] = useState(null);
		const [whisperImage, setWhisperImage] = useState(void 0);
		const [whisperUrl, setWhisperUrl] = useState(void 0);
		const whisperHoldRef = useRef(BUBBLE_HOLD_IDLE);
		const whisperTextRef = useRef(null);
		const whisperTimerRef = useRef(null);
		const [todoOn, setTodoOn] = useState(false);
		const [historyOn, setHistoryOn] = useState(false);
		const [workOn, setWorkOn] = useState(false);
		const [workText, setWorkText] = useState(null);
		const [workMeta, setWorkMeta] = useState(null);
		const [workPercent, setWorkPercent] = useState(null);
		const [workPercentLabel, setWorkPercentLabel] = useState(null);
		const workTimerRef = useRef(null);
		const [voiceState$1, setVoiceState$1] = useState("idle");
		useEffect(() => subscribeVoiceState(setVoiceState$1), []);
		useEffect(() => () => {
			if (balanceTimerRef.current !== null) window.clearTimeout(balanceTimerRef.current);
			if (whisperTimerRef.current !== null) window.clearTimeout(whisperTimerRef.current);
			if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
		}, []);
		/** 重置余额气泡的停留计时；重复触发先清旧定时器，否则旧的会提前收起。 */
		const armBalanceTimeout = () => {
			if (balanceTimerRef.current !== null) window.clearTimeout(balanceTimerRef.current);
			balanceTimerRef.current = window.setTimeout(() => setBalanceOn(false), BUBBLE_DURATION_MS);
		};
		const showBalance = () => {
			setBalancePage(0);
			setBalanceOn(true);
			armBalanceTimeout();
		};
		const cycleBalance = () => {
			const pages = balancePageCount(input.balance);
			setBalancePage((page) => (page + 1) % pages);
			armBalanceTimeout();
		};
		/** 推进说话气泡的收起计划，并按新计划重排计时器。 */
		const applyWhisperHold = (event) => {
			const next = reduceBubbleHold(whisperHoldRef.current, event);
			if (next === whisperHoldRef.current) return;
			whisperHoldRef.current = next;
			setWhisperOn(next.on);
			if (whisperTimerRef.current !== null) window.clearTimeout(whisperTimerRef.current);
			whisperTimerRef.current = null;
			if (next.delayMs === null) return;
			whisperTimerRef.current = window.setTimeout(() => {
				whisperTimerRef.current = null;
				applyWhisperHold({ kind: "hide" });
			}, next.delayMs);
		};
		useEffect(
			() => subscribeVoiceUtterance((event) => {
				if (event.text !== whisperTextRef.current) return;
				applyWhisperHold({
					kind: event.kind === "start" ? "hold" : "release",
					seq: event.seq
				});
			}),
			// eslint-disable-next-line react-hooks/exhaustive-deps -- 订阅只建一次：收起计划全部经 ref 现读，重订阅只会漏事件
			[]
);
		const showWhisper = (text, parts, duration) => {
			if (duration === 0) return;
			setWhisperText(text);
			whisperTextRef.current = text;
			setWhisperImage(parts.image);
			setWhisperUrl(parts.url);
			applyWhisperHold({
				durationMs: duration ?? BUBBLE_DURATION_MS,
				kind: "show"
			});
		};
		const clearWhisper = () => {
			whisperTextRef.current = null;
			setWhisperText(null);
			setWhisperImage(void 0);
			applyWhisperHold({ kind: "clear" });
		};
		const lightWork = (terminal) => {
			setWorkOn(true);
			if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
			workTimerRef.current = terminal ? window.setTimeout(() => setWorkOn(false), BUBBLE_DURATION_MS) : null;
		};
		const hideWork = () => {
			if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
			workTimerRef.current = null;
			setWorkOn(false);
		};
		const resetWork = () => {
			hideWork();
			setWorkText(null);
			setWorkMeta(null);
			setWorkPercent(null);
			setWorkPercentLabel(null);
		};
		const showTodo = () => setTodoOn(true);
		const hideTodo = () => setTodoOn(false);
		const toggleTodo = () => setTodoOn((on) => !on);
		const toggleHistory = () => setHistoryOn((on) => {
			if (!on) setTodoOn(false);
			return !on;
		});
		const hideHistory = () => setHistoryOn(false);
		const node = () => {
			const slot = decideBubbleSlot({
				requestOn: input.request !== void 0 && input.request !== null,
				reminderOn: input.reminder !== void 0 && input.reminder !== null,
				todoOn,
				historyOn,
				workTerminal: input.workTerminal,
				workOn,
				workText,
				workStatusEnabled: input.workStatusEnabled,
				whisperOn,
				whisperText,
				balanceOn,
				balanceAvailable: input.balance !== null,
				balanceEnabled: input.balanceEnabled,
				balanceManual: input.balanceManual
			});
			if (slot === "request") return input.request ? h(RequestBubble, {
				request: input.request,
				on: true
			}) : null;
			if (slot === "reminder") return input.reminder ? h(ReminderBubble, {
				reminder: input.reminder,
				on: true
			}) : null;
			if (slot === "todo") return h(TodoBubble, {
				on: todoOn,
				onClose: hideTodo
			});
			if (slot === "history") return h(HistoryBubble, {
				snapshot: input.history ?? null,
				on: historyOn,
				onClose: hideHistory
			});
			if (slot === "balance") return input.balance === null ? null : h(BalanceBubble, {
				state: input.balance,
				on: balanceOn,
				index: balancePage,
				onCycle: cycleBalance
			});
			if (slot === "whisper") return whisperText === null ? null : h(WhisperBubble, {
				text: whisperText,
				image: whisperImage,
				url: whisperUrl,
				assetRoot: input.assetRoot,
				on: whisperOn,
				voiceState: voiceState$1
			});
			if (slot === "work" || slot === "work-terminal") {
				if (workText === null) return null;
				const sessionId = input.workSessionId ?? "";
				const onFocus = input.onFocusSession;
				const onClick = sessionId !== "" && onFocus !== void 0 ? () => onFocus(sessionId) : void 0;
				return h(WhisperBubble, {
					text: workText,
					meta: workMeta,
					percent: workPercent,
					percentLabel: workPercentLabel,
					on: workOn,
					...onClick === void 0 ? {} : { onClick }
				});
			}
			return null;
		};
		return {
			clearWhisper,
			cycleBalance,
			hideHistory,
			hideTodo,
			hideWork,
			lightWork,
			node,
			resetWork,
			showBalance,
			showTodo,
			showWhisper,
			toggleHistory,
			toggleTodo,
			updateWorkText: (text, meta, progress) => {
				setWorkText(text);
				setWorkMeta(meta ?? null);
				setWorkPercent(progress?.percent ?? null);
				setWorkPercentLabel(progress?.label ?? null);
			}
		};
	};
}

//#endregion
//#region src/client/pet/animation/cues.ts
/** 工作状态是否处在「非终态」：终态（success / error）与空闲都不续播档位动画。 */
const isWorkActive = (state) => state !== null && state !== void 0 && state !== "success" && state !== "error";
function decideEndedCue(input) {
	const { animations, current: current$1, workState } = input;
	const isEvent = isEventAnim(animations.events, current$1);
	if (isEvent && isWorkActive(workState)) {
		const nextWork = nextWorkStatusAnim(animations.events?.workStatus ?? [], current$1);
		if (nextWork !== null) return {
			kind: "work-rotate",
			anim: nextWork
		};
		if (poolIncludes(animations.events?.workStatus ?? [], current$1)) return { kind: "work-replay" };
	}
	if (isEvent) return { kind: "event-done" };
	if (animations.turn.includes(current$1)) return { kind: "turn" };
	if (animations.drag.includes(current$1) || animations.clicks.includes(current$1)) return { kind: "interaction-done" };
	return { kind: "random" };
}

//#endregion
//#region src/client/pet/animation/asset-loader.ts
function createAssetLoader(timeoutMs) {
	/** 在途请求：销毁时统一中断，否则卸载后完成的响应会创建无人回收的地址。 */
	const inflight = new Set();
	return {
		load: (url, handlers) => {
			const controller = new AbortController();
			inflight.add(controller);
			const timer = window.setTimeout(() => controller.abort(), timeoutMs);
			const settle = () => {
				window.clearTimeout(timer);
				inflight.delete(controller);
			};
			fetch(url, {
				cache: "default",
				signal: controller.signal
			}).then((response) => {
				if (!response.ok) throw new Error("asset HTTP " + response.status);
				return response.blob();
			}).then((blob) => {
				settle();
				handlers.onObjectUrl(URL.createObjectURL(blob));
			}).catch((error) => {
				settle();
				handlers.onError(error);
			});
		},
		abortAll: () => {
			for (const controller of inflight) controller.abort();
			inflight.clear();
		},
		release: (objectUrl) => {
			URL.revokeObjectURL(objectUrl);
		}
	};
}

//#endregion
//#region src/client/pet/animation/assets.ts
function animationAssetUrl(source) {
	if (source.cueUrl) return source.cueUrl;
	const root = source.assetRoot === "" ? source.id : source.assetRoot;
	return ROUTE_PATH + "/thumb/" + encodeURIComponent(root) + "/" + encodeURIComponent(source.anim) + source.ext;
}

//#endregion
//#region src/client/pet/animation/media.ts
/** 本次会话已定论的扩展名，`null` = 尚未判断。 */
let resolvedExt = null;
function prefersMov() {
	const ua = navigator.userAgent;
	if (/iPhone|iPad|iPod/i.test(ua)) return true;
	if (/Chrome|Chromium|Edg|OPR|Firefox|FxiOS/i.test(ua)) return false;
	return /Mac/i.test(navigator.platform || ua);
}
function thumbExt() {
	if (resolvedExt === null) {
		const explicit = ANIMATION_EXT;
		resolvedExt = explicit === ".mov" || prefersMov() ? ".mov" : ".webm";
	}
	return resolvedExt;
}

//#endregion
//#region src/client/pet/animation/animation.ts
/** 换源失败与打断的原因，落进回执的 `reason` 字段。 */
const REASON_ASSET_LOAD = "asset-load";
const REASON_PLAY_REJECTED = "play-rejected";
const REASON_DECODE = "decode-error";
const REASON_SUPERSEDED = "superseded";
const REASON_FROZEN = "frozen";
/** 资源超时（ms）：DSH WebServer 偶发 stalled，超时就丢弃本次换源。 */
const ASSET_FETCH_TIMEOUT_MS = 1e4;
/** 日志时间戳：与其余宠物日志同一格式，便于对照同一次事件。 */
const stamp$2 = (petId) => new Date().toTimeString().slice(0, 8) + " pet=" + petId;
function createOwnAnimation(deps) {
	/** 当前前台槽位：0 = A，1 = B。 */
	let front = 0;
	/** 挂起的换源；`null` = 没有换源在等首帧。 */
	let pending = null;
	/** 换源世代号，只增不减。 */
	let gen = 0;
	/** 待消费的点播地址，一次性取走。 */
	let cueUrl = null;
	/** 正在播的点播编号。 */
	let playing = null;
	/** 冻结标志：只挡自动来源，显式指令照常。 */
	let frozen = deps.initiallyFrozen;
	/** 两个槽位各自的 blob 地址，换源时先释放旧的。 */
	const blobUrl = {
		a: null,
		b: null
	};
	const loader = deps.loader ?? createAssetLoader(ASSET_FETCH_TIMEOUT_MS);
	/** 挂载标志：卸载后迟到的加载结果直接丢弃。 */
	let mounted = true;
	const slotOf = (index) => index === 0 ? "a" : "b";
	const elementOf = (index) => index === 0 ? deps.videoA() : deps.videoB();
	const frontVideo = () => elementOf(front);
	/** 上报并清掉「正在播」的编号；`keep` 为真时不清（同一编号继续播）。 */
	const reportOnce = (playbackId, status, reason) => {
		if (playing === playbackId) playing = null;
		deps.report(playbackId, status, reason);
	};
	const switchTo = (next, nextOnce, cuePlaybackId) => {
		if (cuePlaybackId !== null) deps.clearCuePlayback();
		const cfg = deps.cfg();
		const url = cueUrl;
		cueUrl = null;
		if (next === "") return;
		if (pending !== null && pending.anim === next && pending.once === nextOnce) {
			if (cuePlaybackId !== null) {
				playing = cuePlaybackId;
				deps.report(cuePlaybackId, "playing");
			}
			return;
		}
		if (isEventAnim(cfg.animations.events, next)) console.log("[dsh-pet] " + stamp$2(cfg.id) + " switch " + next + " once=" + nextOnce);
		const swapGen = gen += 1;
		pending = {
			anim: next,
			once: nextOnce,
			gen: swapGen
		};
		const targetIndex = front === 0 ? 1 : 0;
		const el = elementOf(targetIndex);
		if (el === null) return;
		el.loop = !nextOnce;
		el.muted = true;
		el.autoplay = true;
		el.playsInline = true;
		el.onended = nextOnce ? (event) => deps.onEnded(handleEnded(event)) : null;
		el.onerror = cuePlaybackId === null ? null : () => reportOnce(cuePlaybackId, "failed", REASON_DECODE);
		const assetUrl = animationAssetUrl({
			cueUrl: url,
			assetRoot: cfg.assetRoot ?? "",
			id: cfg.id,
			anim: next,
			ext: thumbExt()
		});
		loader.load(assetUrl, {
			onObjectUrl: (objectUrl) => {
				if (!mounted) {
					loader.release(objectUrl);
					return;
				}
				if (pending?.gen !== swapGen) {
					loader.release(objectUrl);
					return;
				}
				const slot = slotOf(targetIndex);
				const previous = blobUrl[slot];
				if (previous !== null) loader.release(previous);
				blobUrl[slot] = objectUrl;
				el.src = objectUrl;
				el.load();
			},
			onError: (error) => {
				if (!mounted) return;
				if (pending?.gen !== swapGen) return;
				pending = null;
				if (cuePlaybackId !== null) reportOnce(cuePlaybackId, "failed", REASON_ASSET_LOAD);
				console.warn("[dsh-pet] 素材加载失败 pet=" + cfg.id + " anim=" + next + "：" + (error instanceof Error ? error.message : String(error)) + "（已释放本次切换）");
			}
		});
		const onReady = () => {
			el.removeEventListener("loadeddata", onReady);
			if (pending?.gen !== swapGen) return;
			const outgoing = elementOf(front);
			el.classList.add("is-front");
			if (outgoing !== null && outgoing !== el) {
				outgoing.classList.remove("is-front");
				outgoing.onended = null;
				outgoing.onerror = null;
				outgoing.pause();
				if (playing !== null && playing !== cuePlaybackId) reportOnce(playing, "cancelled", REASON_SUPERSEDED);
			}
			front = front === 0 ? 1 : 0;
			pending = null;
			playing = cuePlaybackId;
			el.style.transform = deps.facing() === "right" ? "scaleX(-1)" : "";
			el.play().then(() => {
				if (cuePlaybackId !== null) deps.report(cuePlaybackId, "playing");
			}).catch(() => {
				if (cuePlaybackId !== null) reportOnce(cuePlaybackId, "failed", REASON_PLAY_REJECTED);
			});
			deps.onFrontReady(el);
		};
		el.addEventListener("loadeddata", onReady);
	};
	const handleEnded = (event) => {
		const endedOn = event === void 0 ? null : event.currentTarget;
		if (endedOn !== null && !endedOn.classList.contains("is-front")) return { kind: "ignore" };
		const done = playing;
		if (done !== null) {
			playing = null;
			deps.report(done, "ended");
		}
		if (deps.isDragging()) return { kind: "ignore" };
		if (frozen) return { kind: "ignore" };
		const cue = decideEndedCue({
			animations: deps.cfg().animations,
			current: deps.currentAnim(),
			workState: deps.workStatus()?.state
		});
		const petId = deps.cfg().id;
		if (cue.kind === "work-rotate") console.log("[dsh-pet] " + stamp$2(petId) + " workStatus 档内轮换: " + deps.currentAnim() + " -> " + cue.anim);
		else if (cue.kind === "work-replay") console.log("[dsh-pet] " + stamp$2(petId) + " workStatus 循环续播: " + deps.currentAnim());
		else if (cue.kind === "event-done") console.log("[dsh-pet] " + stamp$2(petId) + " 事件动画播完 ended anim=" + deps.currentAnim());
		return cue;
	};
	return {
		switchTo,
		handleEnded,
		stopLoopingFront: () => {
			const el = frontVideo();
			if (el === null) return;
			el.loop = false;
			el.onended = (event) => deps.onEnded(handleEnded(event));
		},
		setCueUrl: (url) => {
			cueUrl = url;
		},
		setFrozen: (next) => {
			if (frozen === next) return null;
			frozen = next;
			if (next) {
				frontVideo()?.pause();
				if (playing !== null) reportOnce(playing, "cancelled", REASON_FROZEN);
				return { kind: "frozen" };
			}
			return { kind: "resumed" };
		},
		isFrozen: () => frozen,
		frontVideo,
		playingPlayback: () => playing,
		dispose: () => {
			mounted = false;
			loader.abortAll();
			if (blobUrl.a !== null) loader.release(blobUrl.a);
			if (blobUrl.b !== null) loader.release(blobUrl.b);
			blobUrl.a = null;
			blobUrl.b = null;
		}
	};
}

//#endregion
//#region src/client/pose.ts
/** petId → 取当前实况的函数；PetCard 挂载时注册、卸载时摘除。 */
const readers$1 = new Map();
function registerPose(petId, read) {
	readers$1.set(petId, read);
	return () => {
		if (readers$1.get(petId) === read) readers$1.delete(petId);
	};
}
function readPose(petId) {
	if (typeof petId !== "string" || petId === "") return null;
	const read = readers$1.get(petId);
	return read === void 0 ? null : read();
}

//#endregion
//#region src/client/progress.ts
/** petId → 取当前进度的函数；PetCard 挂载时注册、卸载时摘除。 */
const readers = new Map();
function registerProgress(petId, read) {
	readers.set(petId, read);
	return () => {
		if (readers.get(petId) === read) readers.delete(petId);
	};
}
function readProgress(petId) {
	if (typeof petId !== "string" || petId === "") return null;
	const read = readers.get(petId);
	return read === void 0 ? null : read();
}

//#endregion
//#region src/client/pet/card/animation.ts
function createCardAnimation(rt) {
	const { useEffect, useRef } = rt;
	return function useCardAnimation(input) {
		const { card, cfgRef, live, pendingSquash, petId, workStatusRef } = input;
		const ownAnimRef = useRef(null);
		ownAnimRef.current ?? (ownAnimRef.current = createOwnAnimation({
			videoA: input.videoA,
			videoB: input.videoB,
			cfg: () => cfgRef.current,
			currentAnim: () => card.animRef.current,
			workStatus: () => workStatusRef.current,
			facing: () => card.facingRef.current,
			report: input.report,
			clearCuePlayback: () => input.setCuePlayback(null),
			onFrontReady: (el) => {
				if (pendingSquash.current) {
					pendingSquash.current = false;
					live.current.squash.start(el);
				}
				if (live.current.walk.hasPending()) live.current.walk.start(el);
			},
			onEnded: (cue) => live.current.flow?.applyEndedCue(cue),
			isDragging: () => live.current.drag.isActive(),
			initiallyFrozen: input.lock?.locked === true && input.lock.expiresAt > Date.now()
		}));
		const ownAnim = ownAnimRef.current;
		live.current.ownAnim = ownAnim;
		const { anim, cuePlayback, once, seq } = card.state;
		useEffect(() => {
			ownAnim.switchTo(anim, once, cuePlayback);
		}, [
			anim,
			once,
			seq,
			cuePlayback
		]);
		useEffect(() => {
			const services = live.current;
			const onResize = () => card.actions.setCustomPos((prev) => {
				if (!prev) return prev;
				const { size } = cfgRef.current;
				const { halfW, halfH, bottomPad } = derivePetMetrics(size);
				const viewport = {
					width: window.innerWidth,
					height: window.innerHeight
				};
				const half = {
					w: halfW,
					h: halfH
				};
				const box = centerToBox(prev, viewport, half);
				return { ...boxToRatio(clampReachableBox(box, viewport, {
					size,
					bottomPad
				}), viewport, half) };
			});
			window.addEventListener("resize", onResize);
			const unregisterPose = registerPose(petId, () => {
				const center = live.current.center();
				return {
					x: center.x / window.innerWidth,
					y: center.y / window.innerHeight,
					facing: card.facingRef.current
				};
			});
			const unregisterProgress = registerProgress(petId, () => {
				const el = ownAnim.frontVideo();
				const playbackId = ownAnim.playingPlayback();
				const anim$1 = card.animRef.current;
				if (el === null) return {
					playbackId,
					anim: anim$1,
					currentTime: 0,
					duration: 0,
					paused: true,
					buffering: false
				};
				const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
				return {
					playbackId,
					anim: anim$1,
					currentTime: el.currentTime,
					duration,
					paused: el.paused,
					buffering: el.readyState < 3 || el.seeking
				};
			});
			return () => {
				window.removeEventListener("resize", onResize);
				unregisterPose();
				unregisterProgress();
				ownAnim.dispose();
				services.stopMove();
				services.drag.stopFollow();
				services.flight.stop();
				services.squash.stop();
			};
		}, []);
		return ownAnim;
	};
}

//#endregion
//#region src/shared/score.ts
const SCORE_MIN_SPEED = 400;
/** 每 100 px/s 记 1 分（基准尺寸 462px 下）。 */
const SCORE_SPEED_PER_POINT = 100;
const clickScore = (speed, size) => {
	if (speed <= 0 || size <= 0) return 0;
	return Math.max(1, Math.round(speed / SCORE_SPEED_PER_POINT * (PET_REF_WIDTH / size)));
};

//#endregion
//#region src/shared/score-popup.ts
const SCORE_POPUP_DURATION_MS = 2200;
const SCORE_POPUP_CSS = [
	".dsh-pet-score{position:fixed;z-index:2147483002;min-width:120px;text-align:center;",
	"background:rgba(255,255,255,.97);border:1px solid rgba(255,179,0,.35);border-radius:12px;",
	"box-shadow:0 10px 32px rgba(0,0,0,.22);padding:8px 16px 9px;user-select:none;pointer-events:auto;",
	"font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);}",
	".dsh-pet-score.is-in{animation:dshPetScorePop .28s ease}",
	".dsh-pet-score-val{font-size:22px;line-height:1.25;font-weight:700;color:#ff8f00;font-variant-numeric:tabular-nums}",
	".dsh-pet-score-sub{font-size:11px;line-height:1.4;color:rgba(43,43,43,.6);margin-top:2px;white-space:nowrap}",
	".dsh-pet-score-burst{position:fixed;inset:0;pointer-events:none;z-index:2147483002}",
	".dsh-pet-score-particle{position:absolute;border-radius:50%;pointer-events:none}",
	"@keyframes dshPetScorePop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}"
].join("");
/** 样式只注入一次（同 CHAT_CSS 的注入模式）。 */
let scoreCssInjected = false;
function injectScoreCss() {
	if (scoreCssInjected || typeof document === "undefined") return;
	scoreCssInjected = true;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = "dsh-pet/score";
	tag.textContent = SCORE_POPUP_CSS;
	document.head.appendChild(tag);
}
/** 粒子数量。 */
const BURST_COUNT = 20;
/** 初速范围（px/s）。 */
const BURST_SPEED_MIN = 120;
const BURST_SPEED_MAX = 460;
/** 重力（px/s²）：粒子向上喷出后回落。 */
const BURST_GRAVITY = 700;
/** 单粒子寿命范围（ms）。 */
const BURST_LIFE_MIN = 500;
const BURST_LIFE_MAX = 900;
/** 粒子半径范围（px）。 */
const BURST_RADIUS_MIN = 3;
const BURST_RADIUS_MAX = 7;
/** 暖色盘（积分与庆祝感）。 */
const BURST_COLORS = [
	"#ffb300",
	"#ff8f00",
	"#ff7043",
	"#f4511e",
	"#ffc400",
	"#ffd54f",
	"#ef5350"
];
function spawnScoreBurst(x, y) {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	injectScoreCss();
	const root = document.createElement("div");
	root.className = "dsh-pet-score-burst";
	document.body.appendChild(root);
	const parts = [];
	for (let i = 0; i < BURST_COUNT; i++) {
		const angle = Math.random() * Math.PI * 2;
		const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
		const r = BURST_RADIUS_MIN + Math.random() * (BURST_RADIUS_MAX - BURST_RADIUS_MIN);
		const el = document.createElement("div");
		el.className = "dsh-pet-score-particle";
		el.style.left = x + "px";
		el.style.top = y + "px";
		el.style.width = r * 2 + "px";
		el.style.height = r * 2 + "px";
		el.style.background = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
		root.appendChild(el);
		parts.push({
			el,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed - 80,
			t0: performance.now(),
			life: BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN)
		});
	}
	const step = () => {
		const now = performance.now();
		let alive = false;
		for (const p of parts) {
			const tSec = (now - p.t0) / 1e3;
			const lifeRatio = (now - p.t0) / p.life;
			if (lifeRatio >= 1) continue;
			alive = true;
			p.el.style.transform = "translate(" + p.vx * tSec + "px," + (p.vy * tSec + .5 * BURST_GRAVITY * tSec * tSec) + "px)";
			p.el.style.opacity = String(Math.max(0, 1 - lifeRatio));
		}
		if (alive) requestAnimationFrame(step);
		else root.remove();
	};
	requestAnimationFrame(step);
}
function mountScorePopup(opts) {
	injectScoreCss();
	const x = opts.x;
	const y = opts.y;
	const root = document.createElement("div");
	root.className = "dsh-pet-score";
	const val = document.createElement("div");
	val.className = "dsh-pet-score-val";
	val.textContent = "+" + opts.score;
	const sub = document.createElement("div");
	sub.className = "dsh-pet-score-sub";
	sub.textContent = "速度 " + Math.round(opts.speed) + " · 大小 " + Math.round(opts.size);
	root.appendChild(val);
	root.appendChild(sub);
	document.body.appendChild(root);
	const rr = root.getBoundingClientRect();
	root.style.left = Math.max(4, Math.min(x - rr.width / 2, window.innerWidth - rr.width - 4)) + "px";
	root.style.top = Math.max(4, y - rr.height - 14) + "px";
	root.offsetWidth;
	root.classList.add("is-in");
	let closed = false;
	let timer = null;
	const close = () => {
		if (closed) return;
		closed = true;
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (opts.onClose) opts.onClose();
	};
	const mountedAt = performance.now();
	let graceConsumed = false;
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (!graceConsumed) {
			graceConsumed = true;
			if (e.timeStamp - mountedAt < 300) return;
		}
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	timer = window.setTimeout(close, SCORE_POPUP_DURATION_MS);
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/client/pet/motion/drag-follow.ts
function createDragFollow(deps) {
	/** 在跑的 rAF；`null` = 没在追。 */
	let frame = null;
	/** 世代号：起跑或停下 +1，迟到的帧据此自弃。 */
	let token = 0;
	/** 追赶目标；`null` = 没有目标。 */
	let target = null;
	/** 上一帧的速度（px/s），跨帧累积出过阻尼手感。 */
	let velocity = {
		vx: 0,
		vy: 0
	};
	/** 上一帧的时刻（ms）。 */
	let last = 0;
	const stop = () => {
		token++;
		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}
		target = null;
		velocity = {
			vx: 0,
			vy: 0
		};
	};
	const aim = (next) => {
		target = next;
	};
	const start = (rootEl) => {
		if (frame !== null) return;
		const current$1 = deps.card();
		const spring = current$1.physics.throwPower;
		const own = ++token;
		last = performance.now();
		const step = () => {
			if (token !== own) return;
			const goal = target;
			if (!goal) {
				frame = null;
				return;
			}
			const now = performance.now();
			const dt = Math.min((now - last) / 1e3, 1 / 30);
			last = now;
			const box = current$1.box() ?? {
				x: 0,
				y: 0
			};
			let x = box.x;
			let y = box.y;
			velocity.vx = springStep(velocity.vx, x, goal.x, dt, spring);
			velocity.vy = springStep(velocity.vy, y, goal.y, dt, spring);
			x += velocity.vx * dt;
			y += velocity.vy * dt;
			current$1.setBox({
				x,
				y
			});
			rootEl.style.left = x + "px";
			rootEl.style.top = y + "px";
			rootEl.style.right = "auto";
			rootEl.style.bottom = "auto";
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	};
	return {
		aim,
		start,
		stop
	};
}

//#endregion
//#region src/client/pet/motion/touch-press.ts
/**
* 触屏长按：按住到一定时长把这次按压当右键，计时期间手指移动超过容差就取消。
* 不负责右键菜单本身，也不碰拖拽与点击判定——到点只回调，派发交给调用方。
* 鼠标与笔不走这条分支，起表前先按指针类型挡掉。
* 不变量：同一时刻只有一个计时器；到点时按压若已结束，回调自弃。
* @module dsh-pet/src/client/pet/motion/touch-press
*/
/** 触屏长按多久算右键（ms）。 */
const LONG_PRESS_MS = 500;
/** 计时期间手指移动超过这个距离就取消（px）。 */
const SLOP_PX = 8;
function createTouchPress(deps) {
	/** 待触发的计时器；`null` = 没有在等。 */
	let timer = null;
	/** 本次按下的现场，到点时交给回调。 */
	let pending = null;
	const cancel = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pending = null;
	};
	const arm = (target) => {
		cancel();
		if (target.pointerType === "mouse" || target.pointerType === "pen") return;
		pending = target;
		timer = setTimeout(() => {
			timer = null;
			const current$1 = pending;
			pending = null;
			if (current$1 === null || !deps.stillHolding()) return;
			deps.onMenu(current$1);
		}, LONG_PRESS_MS);
	};
	const move = (distancePx) => {
		if (timer === null) return;
		if (distancePx > SLOP_PX) cancel();
	};
	return {
		arm,
		cancel,
		isArmed: () => timer !== null,
		move
	};
}

//#endregion
//#region src/client/pet/motion/drag-release.ts
function decideRelease(input) {
	if (input.sling) {
		const pullX = input.box.x + input.half.w - input.anchor.x;
		const pullY = input.box.y + input.half.h - input.anchor.y;
		const dist = Math.hypot(pullX, pullY);
		const power = slingshotPower(dist, input.size);
		return {
			kind: "sling",
			dist,
			power,
			velocity: slingshotVelocity(pullAngle(pullX, pullY), power, input.physics.throwPower)
		};
	}
	const velocity = estimateReleaseVelocity(input.trail, input.now, input.physics);
	return velocity ? {
		kind: "throw",
		velocity
	} : { kind: "place" };
}

//#endregion
//#region src/client/pet/motion/drag.ts
/** 复位的按下状态：避免每个实例各写一份字面量。 */
const IDLE_PRESS = {
	active: false,
	dragging: false,
	sx: 0,
	sy: 0,
	offX: 0,
	offY: 0,
	sling: false,
	anchorX: 0,
	anchorY: 0
};
/** 松手后这段时间内的指针事件视为同一次拖拽的尾巴（ms）。 */
const JUST_DRAGGED_MS = 100;
/** 日志行的时刻前缀。 */
const stamp$1 = () => new Date().toTimeString().slice(0, 8);
/** 一行带时刻与宠物 id 的日志：客户端统一前缀，便于按宠物 grep。 */
const log$1 = (petId, message) => {
	console.log("[dsh-pet] " + stamp$1() + " pet=" + petId + " " + message);
};
/**
* 抓取瞬间记一行速度，手速够快就打分。
*
* @param current - 当帧能力。
* @param x - 指针横坐标（px），分数从这里弹出。
* @param y - 指针纵坐标（px）。
* @returns 是否打过分；调用方据此让随后的 click 不再播普通点击动画。
*/
function noteGrab(current$1, x, y) {
	const grab = current$1.grabVelocity();
	const speed = grab ? Math.hypot(grab.vx, grab.vy) : 0;
	log$1(current$1.petId, "grab vx=" + (grab ? Math.round(grab.vx) : 0) + " vy=" + (grab ? Math.round(grab.vy) : 0) + " |v|=" + Math.round(speed));
	if (speed < SCORE_MIN_SPEED) return false;
	const score = clickScore(speed, current$1.size);
	log$1(current$1.petId, "click-score speed=" + Math.round(speed) + " size=" + current$1.size + " -> +" + score);
	spawnScoreBurst(x, y);
	mountScorePopup({
		x,
		y,
		score,
		speed,
		size: current$1.size
	});
	return true;
}
function createDrag(card) {
	let press = { ...IDLE_PRESS };
	/** 「刚拖完」窗口的截止时刻（ms）；用时刻而不是定时器，读的时候再判，少一个待清理的句柄。 */
	let justDraggedUntil = 0;
	let pressScoreFired = false;
	let lastPressAt = 0;
	/** 指针轨迹采样，供初速估算。 */
	let trail = [];
	const follow = createDragFollow({ card });
	let mousePressHit = null;
	/** 捕获丢失后的松手：坐标来自 mouseup，落点判定与正常松开完全一致。 */
	function onWindowMouseUp(e) {
		const hit = mousePressHit;
		if (!hit || e.button !== 0 || e.buttons !== 0) return;
		endPress(card(), {
			x: e.clientX,
			y: e.clientY,
			hit
		});
	}
	/** 鼠标按下时登记命中区并挂兜底；node 里的测试没有 window，替身自己提供。 */
	const armMouseFallback = (hit) => {
		mousePressHit = hit;
		if (typeof window !== "undefined") window.addEventListener("mouseup", onWindowMouseUp, true);
	};
	const clearMouseFallback = () => {
		mousePressHit = null;
		if (typeof window !== "undefined") window.removeEventListener("mouseup", onWindowMouseUp, true);
	};
	/** 触屏长按：计时与容差在 motion/touch-press.ts，到点后把这次按压当右键。 */
	const touchPress = createTouchPress({
		onMenu: (target) => {
			press.active = false;
			pressScoreFired = true;
			if (target.el.hasPointerCapture(target.pointerId)) target.el.releasePointerCapture(target.pointerId);
			log$1(card().petId, "-> [TOUCH-MENU]");
			target.el.dispatchEvent(new MouseEvent("contextmenu", {
				bubbles: true,
				button: 2,
				cancelable: true,
				clientX: target.x,
				clientY: target.y,
				view: window
			}));
		},
		stillHolding: () => press.active && !press.dragging
	});
	/**
	* 记下这次按下的几何与弹弓判定。
	*
	* @param c - 当帧能力。
	* @param e - 按下事件。
	* @returns 新的按下状态。
	*/
	const beginPress = (c, e) => {
		e.currentTarget.classList.add("dragging");
		e.currentTarget.setPointerCapture(e.pointerId);
		c.setTipOn(false);
		const rootEl = c.root();
		let offX = 0;
		let offY = 0;
		if (rootEl) {
			const rr = rootEl.getBoundingClientRect();
			offX = e.clientX - (rr.left + rr.width / 2);
			offY = e.clientY - (rr.top + rr.height / 2);
			c.setBox({
				x: rr.left,
				y: rr.top
			});
		}
		const pressNow = performance.now();
		const sling = pressNow - lastPressAt < SLINGSHOT_DOUBLE_MS;
		lastPressAt = sling ? 0 : pressNow;
		const anchor = c.box();
		return {
			active: true,
			anchorX: anchor ? anchor.x + c.halfW : e.clientX,
			anchorY: anchor ? anchor.y + c.halfH : e.clientY,
			dragging: false,
			offX,
			offY,
			sling,
			sx: e.clientX,
			sy: e.clientY
		};
	};
	const onPointerDown = (e) => {
		const c = card();
		if (e.button !== 0) return;
		if (c.isFrozen()) c.releaseLock();
		pressScoreFired = noteGrab(c, e.clientX, e.clientY);
		c.stopFlight();
		follow.stop();
		c.stopAutonomy();
		trail = [];
		press = beginPress(c, e);
		clearMouseFallback();
		if (e.pointerType === "mouse") armMouseFallback(e.currentTarget);
		touchPress.arm({
			el: e.currentTarget,
			pointerId: e.pointerId,
			pointerType: e.pointerType,
			x: e.clientX,
			y: e.clientY
		});
	};
	const onPointerMove = (e) => {
		const c = card();
		if (c.tipOn()) c.placeTip(e.clientX, e.clientY);
		if (!press.active) return;
		const dx = e.clientX - press.sx;
		const dy = e.clientY - press.sy;
		touchPress.move(Math.hypot(dx, dy));
		if (!press.dragging) {
			if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
			press.dragging = true;
			c.setOnce(true);
			if (c.dragAnims.length) {
				const name = pick(c.dragAnims);
				log$1(c.petId, "-> [DRAG] " + name);
				c.playAnim(name);
			}
		}
		const now = performance.now();
		trail = trimTrail([...trail, {
			t: now,
			x: e.clientX,
			y: e.clientY
		}], now);
		follow.aim({
			x: e.clientX - press.offX - c.halfW,
			y: e.clientY - press.offY - c.halfH
		});
		const rootEl = c.root();
		if (rootEl) follow.start(rootEl);
	};
	/**
	* 松手结算：原地放下、甩抛或弹弓。
	*
	* @param c - 当帧能力。
	* @param point - 松手现场；指针没跟上时用它的坐标兜底算落点。
	*/
	const settleRelease = (c, point) => {
		const current$1 = c.box();
		const box = current$1 ?? {
			x: point.x - press.offX - c.halfW,
			y: point.y - press.offY - c.halfH
		};
		const decision = decideRelease({
			anchor: {
				x: press.anchorX,
				y: press.anchorY
			},
			box,
			half: {
				w: c.halfW,
				h: c.halfH
			},
			now: performance.now(),
			physics: c.physics,
			size: c.size,
			sling: press.sling,
			trail
		});
		trail = [];
		if (decision.kind === "sling") {
			log$1(c.petId, "sling dist=" + Math.round(decision.dist) + " power=" + decision.power.toFixed(2) + " vx=" + Math.round(decision.velocity.vx) + " vy=" + Math.round(decision.velocity.vy));
			c.startFlight(box.x, box.y, decision.velocity.vx, decision.velocity.vy);
			return;
		}
		if (decision.kind === "throw") {
			const { vx, vy } = decision.velocity;
			log$1(c.petId, "release vx=" + Math.round(vx) + " vy=" + Math.round(vy) + " |v|=" + Math.round(Math.hypot(vx, vy)));
			c.startFlight(box.x, box.y, vx, vy);
			return;
		}
		c.commitPlace(box);
	};
	/**
	* 松手后把提示摆回光标处并点亮；指针已移出命中区时保持收起。
	*
	* @param c - 当帧能力。
	* @param point - 松手现场。
	*/
	const restoreTip = (c, point) => {
		const hitRect = point.hit.getBoundingClientRect();
		const inside = point.x >= hitRect.left && point.x <= hitRect.right && point.y >= hitRect.top && point.y <= hitRect.bottom;
		if (!inside) return;
		c.placeTip(point.x, point.y);
		c.setTipOn(true);
	};
	/**
	* 松手收尾的唯一路径：复位按下态、摘拖拽类、结算去向并把提示摆回去。
	*
	* @param c - 当帧能力。
	* @param point - 松手现场；正常 pointerup 与捕获丢失后的 window mouseup 都折算成它。
	*/
	const endPress = (c, point) => {
		clearMouseFallback();
		touchPress.cancel();
		const wasDragging = press.dragging;
		press.active = false;
		press.dragging = false;
		point.hit.classList.remove("dragging");
		follow.stop();
		if (wasDragging) {
			justDraggedUntil = performance.now() + JUST_DRAGGED_MS;
			if (!c.resumeWork()) {
				if (c.idleAnims.length) c.playAnim(pick(c.idleAnims, c.currentAnim));
				c.setOnce(true);
			}
			settleRelease(c, point);
		}
		restoreTip(c, point);
	};
	const onPointerUp = (e) => {
		endPress(card(), {
			x: e.clientX,
			y: e.clientY,
			hit: e.currentTarget
		});
	};
	const onClick = () => {
		const c = card();
		if (press.active || press.dragging || performance.now() < justDraggedUntil) return;
		if (pressScoreFired) {
			pressScoreFired = false;
			c.stopFlight();
			c.stopAutonomy();
			return;
		}
		c.stopFlight();
		c.stopAutonomy();
		c.playClickSound();
		c.setOnce(true);
		if (!c.clickAnims.length) return;
		const name = pick(c.clickAnims);
		log$1(c.petId, "-> [CLICK] " + name);
		c.markSquash();
		c.bumpSeq();
		c.playAnim(name);
	};
	return {
		isActive: () => press.active,
		justDragged: () => performance.now() < justDraggedUntil,
		onClick,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		stopFollow: follow.stop,
		dispose: clearMouseFallback
	};
}

//#endregion
//#region src/client/pet/card/drag.ts
function createCardDrag(rt) {
	const { useRef, useEffect } = rt;
	return function useCardDrag(input) {
		const { bumpSeq, card, cfgRef, live, motion, pendingSquash, root, setAnim, setCustomPos } = input;
		const { setOnce, setTipOn } = input;
		const dragCard = () => {
			const metrics = motion.metrics();
			return {
				petId: cfgRef.current.id,
				size: metrics.size,
				halfW: metrics.halfW,
				halfH: metrics.halfH,
				physics: cfgRef.current.physics,
				dragAnims: live.current.flow?.sleeping() ?? false ? [] : cfgRef.current.animations.drag,
				clickAnims: cfgRef.current.animations.clicks,
				idleAnims: live.current.flow?.sleeping() ?? false ? [] : cfgRef.current.animations.idle,
				currentAnim: card.animRef.current,
				setOnce: (on) => setOnce(on),
				playAnim: (name) => setAnim(name),
				bumpSeq: () => bumpSeq(),
				markSquash: () => {
					pendingSquash.current = true;
				},
				resumeWork: () => live.current.flow?.resumeWorkStatusAnim() ?? false,
				stopAutonomy: () => motion.stopMove(),
				stopFlight: () => motion.flight.stop(),
				startFlight: motion.startThrow,
				isFrozen: () => live.current.ownAnim.isFrozen(),
				releaseLock: () => live.current.releaseLock(),
				grabVelocity: () => motion.flight.isFlying() ? motion.flight.velocity() : null,
				playClickSound: () => playClickSound(),
				tipOn: () => live.current.tipOn(),
				placeTip: (x, y) => live.current.placeTip(x, y),
				setTipOn,
				root,
				box: () => motion.box(),
				setBox: (box) => motion.setBox(box),
				commitPlace: (box) => {
					const metrics$1 = motion.metrics();
					const viewport = {
						width: window.innerWidth,
						height: window.innerHeight
					};
					const half = {
						w: metrics$1.halfW,
						h: metrics$1.halfH
					};
					const reached = clampReachableBox(box, viewport, metrics$1);
					const rootEl = root();
					if (rootEl) {
						rootEl.style.left = reached.x + "px";
						rootEl.style.top = reached.y + "px";
						rootEl.style.right = "auto";
						rootEl.style.bottom = "auto";
					}
					motion.setBox(reached);
					setCustomPos(boxToRatio(reached, viewport, half));
				}
			};
		};
		const dragRef = useRef(null);
		dragRef.current ?? (dragRef.current = createDrag(dragCard));
		const drag = dragRef.current;
		useEffect(() => () => drag.dispose(), [drag]);
		live.current.drag = drag;
		return drag;
	};
}

//#endregion
//#region src/shared/hear.ts
const HEAR_SAMPLE_RATE = 16e3;
const MAX_RECORD_MS = 24e3;
const SILENCE_PEAK = .002;
const MIN_RECORD_MS = 300;
/** 等识别结果的上限（ms）：宿主自己 30s 超时，这里留点余量先等它回结构化失败。 */
const HEAR_TIMEOUT_MS = 4e4;
/** 每块采集的样本数：1024 样本 @16kHz = 64ms，松手后等待补齐尾音的时长也按它算。 */
const BLOCK_SAMPLES = 1024;
/** 松手后等最后一块音频落袋（ms）：比一块略长，避免把最后半句话砍掉。 */
const TAIL_SETTLE_MS = 80;
function canRecord() {
	return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}
function floatToPcm16(samples) {
	const out = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const v = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
		out[i] = v < 0 ? v * 32768 : v * 32767;
	}
	return out;
}
function peakOf(pcm) {
	let peak = 0;
	for (let i = 0; i < pcm.length; i++) {
		const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
		if (v > peak) peak = v;
	}
	return peak / 32768;
}
function encodeWave(pcm, sampleRate = HEAR_SAMPLE_RATE) {
	const dataBytes = pcm.length * 2;
	const bytes = new Uint8Array(44 + dataBytes);
	const view = new DataView(bytes.buffer);
	/** 写 4 字节 ASCII 标记（RIFF/WAVE/fmt /data），全是大写或小写字母，不用考虑编码。 */
	const ascii = (offset, text) => {
		for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
	return bytes;
}
function toBase64(bytes) {
	const BASE64_CHUNK_BYTES = 8192;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
		const end = Math.min(offset + BASE64_CHUNK_BYTES, bytes.length);
		for (let i = offset; i < end; i++) binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}
/** 把宿主的失败原因收敛到自己认识的几种；其余一律按生成失败处理。 */
function reasonOf(raw) {
	return raw === "unsupported" || raw === "bad-request" ? raw : "generate-error";
}
async function hearAudio(url, audio, signal) {
	const timeout = AbortSignal.timeout(HEAR_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ audio }),
			signal: signal === void 0 ? timeout : AbortSignal.any([signal, timeout])
		});
		const raw = await res.json().catch(() => null);
		if (!raw || typeof raw !== "object") return {
			ok: false,
			reason: "network",
			message: "识别响应不是 JSON"
		};
		const body = raw;
		if (body.ok === true && typeof body.text === "string") return {
			ok: true,
			text: body.text
		};
		return {
			ok: false,
			reason: reasonOf(body.reason),
			message: typeof body.message === "string" ? body.message : ""
		};
	} catch (e) {
		return {
			ok: false,
			reason: "network",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
async function startRecording() {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
	const ctx = new AudioContext({ sampleRate: HEAR_SAMPLE_RATE });
	const source = ctx.createMediaStreamSource(stream);
	const processor = ctx.createScriptProcessor(BLOCK_SAMPLES, 1, 1);
	const chunks = [];
	const maxSamples = Math.floor(MAX_RECORD_MS / 1e3 * HEAR_SAMPLE_RATE);
	let frames = 0;
	let closed = false;
	processor.onaudioprocess = (event) => {
		if (frames >= maxSamples) return;
		const samples = event.inputBuffer.getChannelData(0);
		const room = maxSamples - frames;
		const take = samples.length > room ? samples.subarray(0, room) : samples;
		chunks.push(new Float32Array(take));
		frames += take.length;
	};
	source.connect(processor);
	processor.connect(ctx.destination);
	await ctx.resume();
	const teardown = () => {
		if (closed) return;
		closed = true;
		processor.onaudioprocess = null;
		try {
			source.disconnect();
			processor.disconnect();
		} catch {}
		for (const track of stream.getTracks()) track.stop();
		ctx.close();
	};
	return {
		elapsedMs: () => frames / HEAR_SAMPLE_RATE * 1e3,
		async stop() {
			await new Promise((resolve) => setTimeout(resolve, TAIL_SETTLE_MS));
			teardown();
			if (frames === 0) return null;
			const all = new Float32Array(frames);
			let offset = 0;
			for (const chunk of chunks) {
				all.set(chunk, offset);
				offset += chunk.length;
			}
			const pcm = floatToPcm16(all);
			return {
				wave: encodeWave(pcm),
				peak: peakOf(pcm)
			};
		},
		cancel: teardown
	};
}

//#endregion
//#region src/shared/chat/hear-control.ts
function createHearControl(opts) {
	const { micBtn, input, hint, resizeInput, hearUrl } = opts;
	let hearState = "idle";
	let recorder = null;
	let hearTimer = 0;
	/** 还没拿到麦克风就松手了：等 startRecording 一返回立刻收尾，避免麦克风一直开着。 */
	let wasReleasedEarly = false;
	/** 按钮外观：录音阶段画红，识别阶段禁用（避免连点开两次）。 */
	const paint = () => {
		if (hearState === "starting" || hearState === "recording") micBtn.dataset.hear = "recording";
		else delete micBtn.dataset.hear;
		micBtn.disabled = hearState === "transcribing";
	};
	/** 现在录不了的原因；能录时给空串。 */
	const blockedReason = () => {
		if (!canRecord()) return "当前地址不支持录音：用 https 或 localhost 打开才有麦克风";
		if (hearUrl === "") return "这个入口没有接上识别地址";
		return "";
	};
	/** 把识别结果接在光标处（替换当前选区），并把焦点交回输入框。 */
	const insertText = (text) => {
		const from = input.selectionStart ?? input.value.length;
		const to = input.selectionEnd ?? from;
		input.value = input.value.slice(0, from) + text + input.value.slice(to);
		const caret = from + text.length;
		input.setSelectionRange(caret, caret);
		resizeInput();
		input.focus();
	};
	/** 失败原因翻成人话；宿主给的 message 有就附上，方便对着日志排查。 */
	const describeFailure = (outcome) => {
		if (outcome.reason === "unsupported") return "这个宿主没开语音识别";
		if (outcome.reason === "bad-request") return "音频没通过宿主校验";
		if (outcome.reason === "network") return "识别请求失败：" + outcome.message;
		return "识别失败：" + (outcome.message || "未知原因");
	};
	/** 收尾：停采集 → 判误触 → 判静音 → 送宿主 → 文字落进输入框。失败只提示，不动已输入的文字。 */
	const stop = async () => {
		const current$1 = recorder;
		if (!current$1) return;
		recorder = null;
		window.clearInterval(hearTimer);
		if (current$1.elapsedMs() < MIN_RECORD_MS) {
			current$1.cancel();
			hearState = "idle";
			paint();
			hint.hide();
			return;
		}
		hearState = "transcribing";
		paint();
		hint.show("识别中…");
		try {
			const clip = await current$1.stop();
			if (clip === null) {
				hint.flash("没录到声音");
				return;
			}
			if (clip.peak < SILENCE_PEAK) {
				hint.flash("没听到声音，检查一下麦克风");
				return;
			}
			if (!input.isConnected) return;
			const outcome = await hearAudio(hearUrl, toBase64(clip.wave));
			if (!input.isConnected) return;
			if (!outcome.ok) {
				hint.flash(describeFailure(outcome));
				return;
			}
			const text = outcome.text.trim();
			if (text === "") {
				hint.flash("没听清，再说一次");
				return;
			}
			hint.hide();
			insertText(text);
		} catch (e) {
			hint.flash("录音出错：" + (e instanceof Error ? e.message : String(e)));
		} finally {
			hearState = "idle";
			paint();
		}
	};
	/** 开录：先要麦克风，拿到了才开始计时。 */
	const start = async () => {
		const blocked = blockedReason();
		if (blocked !== "") {
			hint.flash(blocked);
			return;
		}
		if (hearState !== "idle") return;
		if (document.activeElement === input) input.blur();
		hearState = "starting";
		wasReleasedEarly = false;
		paint();
		hint.show("正在打开麦克风…");
		try {
			recorder = await startRecording();
		} catch (e) {
			hearState = "idle";
			paint();
			hint.flash("打不开麦克风：" + (e instanceof Error ? e.message : String(e)));
			return;
		}
		if (wasReleasedEarly) {
			stop();
			return;
		}
		hearState = "recording";
		paint();
		hearTimer = window.setInterval(() => {
			const rec = recorder;
			if (!rec) return;
			if (rec.elapsedMs() >= MAX_RECORD_MS) {
				stop();
				return;
			}
			const total = Math.floor(rec.elapsedMs() / 1e3);
			hint.show("录音中 " + Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0") + " · 松开结束");
		}, 200);
	};
	micBtn.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		try {
			micBtn.setPointerCapture(e.pointerId);
		} catch {}
		start();
	});
	/** 松手或指针被系统抢走（切窗口）都算说完；还在等麦克风时先记下，等它回来立刻收尾。 */
	const onRelease = () => {
		if (hearState === "starting") {
			wasReleasedEarly = true;
			return;
		}
		if (hearState === "recording") stop();
	};
	micBtn.addEventListener("pointerup", onRelease);
	micBtn.addEventListener("pointercancel", onRelease);
	return {
		start: () => void start(),
		stop: () => void stop(),
		isHearing: () => hearState === "recording",
		dispose: () => {
			window.clearInterval(hearTimer);
			if (recorder) {
				recorder.cancel();
				recorder = null;
			}
			hearState = "idle";
		}
	};
}

//#endregion
//#region src/shared/chat/icons.ts
/**
* 对话弹窗里的三枚内联 SVG 图标。
* 不用 emoji：同一个符号在不同字体回退链下会被渲染成异体字形（上传用的 🖼 在 Windows 上就是如此）。
* @module dsh-pet/src/shared/chat/icons
*/
/** SVG 图标共用的描边属性：一条线宽、随文字颜色。 */
const ICON_ATTRS = {
	fill: "none",
	stroke: "currentColor",
	"stroke-width": "1.8",
	"stroke-linecap": "round",
	"stroke-linejoin": "round",
	"aria-hidden": "true"
};
/** 造一个 SVG 子元素（属性原样写入，命名空间固定 SVG）。 */
function svgNode(tag, attrs) {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
	return node;
}
function pictureIcon(size = 16) {
	const svg = svgNode("svg", {
		viewBox: "0 0 24 24",
		width: String(size),
		height: String(size),
		...ICON_ATTRS
	});
	svg.append(svgNode("rect", {
		x: "3",
		y: "3",
		width: "18",
		height: "18",
		rx: "2"
	}), svgNode("circle", {
		cx: "8.5",
		cy: "8.5",
		r: "1.5"
	}), svgNode("path", { d: "M21 15l-5-5L5 21" }));
	return svg;
}
function micIcon(size = 16) {
	const svg = svgNode("svg", {
		viewBox: "0 0 24 24",
		width: String(size),
		height: String(size),
		...ICON_ATTRS
	});
	svg.append(svgNode("rect", {
		x: "9",
		y: "2",
		width: "6",
		height: "11",
		rx: "3"
	}), svgNode("path", { d: "M5.5 11a6.5 6.5 0 0 0 13 0" }), svgNode("path", { d: "M12 17.5V21" }), svgNode("path", { d: "M8.5 21h7" }));
	return svg;
}
function saveIcon(size = 16) {
	const svg = svgNode("svg", {
		viewBox: "0 0 24 24",
		width: String(size),
		height: String(size),
		...ICON_ATTRS
	});
	svg.append(svgNode("path", { d: "M12 3v11" }), svgNode("path", { d: "M7.5 9.5L12 14l4.5-4.5" }), svgNode("path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" }));
	return svg;
}
function closeIcon(size = 16) {
	const svg = svgNode("svg", {
		viewBox: "0 0 24 24",
		width: String(size),
		height: String(size),
		...ICON_ATTRS
	});
	svg.append(svgNode("path", { d: "M6 6l12 12" }), svgNode("path", { d: "M18 6L6 18" }));
	return svg;
}
function cameraIcon(size = 16) {
	const svg = svgNode("svg", {
		viewBox: "0 0 24 24",
		width: String(size),
		height: String(size),
		...ICON_ATTRS
	});
	svg.append(svgNode("path", { d: "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" }), svgNode("circle", {
		cx: "12",
		cy: "13",
		r: "4"
	}));
	return svg;
}

//#endregion
//#region src/shared/chat/styles.ts
const CHAT_CSS = [
	".dsh-pet-chat{position:fixed;z-index:2147482999;width:160px;max-width:80vw;",
	"background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;",
	"box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;",
	"font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
	"user-select:none}",
	".dsh-pet-chat *{box-sizing:border-box}",
	".dsh-pet-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;",
	"padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;",
	"resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}",
	".dsh-pet-chat-input::placeholder{color:rgba(43,43,43,.45)}",
	".dsh-pet-chat-input:disabled{opacity:.55}",
	".dsh-pet-chat-head{display:flex;align-items:center;gap:6px;padding:6px 6px 2px 8px}",
	".dsh-pet-chat-title{font-size:12px;font-weight:600;color:rgba(43,43,43,.78);",
	"letter-spacing:.02em;user-select:none}",
	".dsh-pet-chat[data-mode=\"cmd\"] .dsh-pet-chat-title{color:#7c5cd6}",
	".dsh-pet-chat-result{max-height:min(200px,38vh);overflow-y:auto;margin:0 8px 6px;",
	"padding:7px 9px;border-radius:9px;background:#f2f4f8;border:1px solid rgba(0,0,0,.07);",
	"font-size:13px;line-height:1.5;color:rgba(43,43,43,.9);white-space:pre-wrap;overflow-wrap:break-word}",
	".dsh-pet-chat-actions{display:flex;align-items:center;gap:6px;padding:0 8px 7px}",
	".dsh-pet-chat-spacer{flex:1 1 auto;min-width:0}",
	".dsh-pet-chat-btn[data-close=\"1\"]{color:rgba(43,43,43,.5)}",
	".dsh-pet-chat-btn[data-close=\"1\"]:hover{background:rgba(229,72,77,.12);color:#d94f3d}",
	".dsh-pet-chat-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;",
	"border:none;border-radius:6px;background:transparent;color:rgba(43,43,43,.62);font-size:14px;line-height:1;",
	"cursor:pointer;transition:background .15s,color .15s}",
	".dsh-pet-chat-btn:hover{background:rgba(0,0,0,.06);color:rgba(43,43,43,.9)}",
	".dsh-pet-chat-btn:disabled{opacity:.45;cursor:default}",
	".dsh-pet-chat-btn svg{display:block}",
	".dsh-pet-chat-btn[data-hear=\"recording\"]{color:#e5484d;background:rgba(229,72,77,.14)}",
	".dsh-pet-chat-btn[data-hear=\"recording\"]:hover{background:rgba(229,72,77,.2);color:#e5484d}",
	".dsh-pet-chat-btn[data-hear=\"recording\"] svg{animation:dsh-pet-hear-pulse 1s ease-in-out infinite}",
	"@keyframes dsh-pet-hear-pulse{0%,100%{opacity:1}50%{opacity:.4}}",
	".dsh-pet-chat-attach{display:none;align-items:center;gap:4px;margin-left:2px}",
	".dsh-pet-chat-attach[data-on=\"1\"]{display:inline-flex}",
	".dsh-pet-chat-thumb{width:24px;height:24px;object-fit:cover;border-radius:4px;",
	"border:1px solid rgba(0,0,0,.1);flex:0 0 auto;background:rgba(0,0,0,.06)}",
	".dsh-pet-chat-attach-x{border:none;background:transparent;color:rgba(43,43,43,.45);cursor:pointer;",
	"font-size:12px;line-height:1;padding:2px 3px;border-radius:4px}",
	".dsh-pet-chat-attach-x:hover{background:rgba(0,0,0,.08);color:rgba(43,43,43,.85)}",
	".dsh-pet-chat-hint{display:none;color:rgba(43,43,43,.55);font-size:12px;padding:0 12px 8px}",
	".dsh-pet-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}",
	".dsh-pet-chat[data-mode=\"chat\"]{min-width:min(300px,80vw)}",
	".dsh-pet-chat-log{display:block;border-top:1px solid rgba(0,0,0,.08);",
	"background:rgba(0,0,0,.018)}",
	".dsh-pet-chat-log-list{max-height:min(260px,46vh);overflow-y:auto;padding:8px;",
	"display:flex;flex-direction:column;gap:6px;user-select:text}",
	".dsh-pet-chat-log-row{display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:1.45;max-width:100%}",
	".dsh-pet-chat-log-row[data-role=\"user\"]{align-items:flex-end}",
	".dsh-pet-chat-log-meta{font-size:10px;color:rgba(43,43,43,.4)}",
	".dsh-pet-chat-log-text{padding:4px 7px;border-radius:8px;background:#fff;",
	"border:1px solid rgba(0,0,0,.07);white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}",
	".dsh-pet-chat-log-row[data-role=\"user\"] .dsh-pet-chat-log-text{background:#eef4ff;border-color:rgba(70,120,220,.18)}",
	".dsh-pet-chat-log-tag{font-size:10px;color:rgba(43,43,43,.42)}",
	".dsh-pet-chat-log-note{padding:0 8px 6px;font-size:10px;color:rgba(43,43,43,.5);",
	"overflow-wrap:anywhere;user-select:text}",
	".dsh-pet-chat-log-note[data-err=\"1\"]{color:#d94f3d}",
	".dsh-pet-chat-log-empty{padding:10px 2px;font-size:12px;color:rgba(43,43,43,.4);text-align:center}",
	".dsh-pet-chat-btn[hidden]{display:none}"
].join("");
const CHAT_MIN_W = 160;
const CHAT_MAX_W = 340;
const CHAT_H_PAD = 22;
let chatCssInjected = false;
function injectChatCss() {
	if (chatCssInjected || typeof document === "undefined") return;
	chatCssInjected = true;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = "dsh-pet/chat";
	tag.textContent = CHAT_CSS;
	document.head.appendChild(tag);
}

//#endregion
//#region src/shared/chat/dom.ts
/** 提示自动收起的时间（ms）。 */
const HINT_MS = 2200;
/** 造一枚图标按钮（图标 + 无障碍标签）。 */
function iconButton(title, icon) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "dsh-pet-chat-btn";
	btn.title = title;
	btn.setAttribute("aria-label", title);
	btn.appendChild(icon);
	return btn;
}
/** 输入框宽度随文本自适应：宽度按测量值，封顶后由高度接住折行。 */
function enableAutoResize(input, root) {
	let measureCtx = null;
	const resize = () => {
		const ctx = measureCtx ?? (measureCtx = document.createElement("canvas").getContext("2d"));
		ctx.font = getComputedStyle(input).font;
		const textW = ctx.measureText(input.value || " ").width;
		const w = Math.max(CHAT_MIN_W, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W));
		root.style.width = w + "px";
		input.style.height = "auto";
		input.style.height = Math.max(input.scrollHeight, 22) + "px";
	};
	input.addEventListener("input", resize);
	return resize;
}
function createChatDom(opts = {}) {
	const root = document.createElement("div");
	root.className = "dsh-pet-chat";
	const input = document.createElement("textarea");
	input.className = "dsh-pet-chat-input";
	input.placeholder = "说点什么…";
	input.maxLength = 2e3;
	input.rows = 1;
	const err = document.createElement("div");
	err.className = "dsh-pet-chat-err";
	err.style.display = "none";
	const hint = document.createElement("div");
	hint.className = "dsh-pet-chat-hint";
	let hintTimer = 0;
	/** 常驻提示：录音与识别期间一直显示，由调用点自己收。 */
	const showHint = (text) => {
		window.clearTimeout(hintTimer);
		hint.textContent = text;
		hint.style.display = "block";
	};
	const hideHint = () => {
		window.clearTimeout(hintTimer);
		hint.style.display = "none";
	};
	const flash = (text) => {
		showHint(text);
		hintTimer = window.setTimeout(hideHint, HINT_MS);
	};
	const pickBtn = iconButton("上传图片", pictureIcon());
	const shotBtn = iconButton("截取当前屏幕", cameraIcon());
	const hearUrl = typeof opts.hearUrl === "string" ? opts.hearUrl : "";
	const micBtn = iconButton("按住说话", micIcon());
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = IMAGE_ACCEPT;
	fileInput.style.display = "none";
	const attach = document.createElement("div");
	attach.className = "dsh-pet-chat-attach";
	const thumb = document.createElement("img");
	thumb.className = "dsh-pet-chat-thumb";
	thumb.alt = "已选图片";
	const attachX = document.createElement("button");
	attachX.type = "button";
	attachX.className = "dsh-pet-chat-attach-x";
	attachX.textContent = "✕";
	attachX.title = "移除图片";
	attachX.setAttribute("aria-label", "移除图片");
	attach.append(thumb, attachX);
	const actions = document.createElement("div");
	actions.className = "dsh-pet-chat-actions";
	const spacer = document.createElement("span");
	spacer.className = "dsh-pet-chat-spacer";
	actions.append(pickBtn, shotBtn, micBtn, fileInput, attach, spacer);
	const head = document.createElement("div");
	head.className = "dsh-pet-chat-head";
	const title = document.createElement("span");
	title.className = "dsh-pet-chat-title";
	const headSpacer = document.createElement("span");
	headSpacer.className = "dsh-pet-chat-spacer";
	const exportBtn = iconButton("保存对话到文件", saveIcon());
	exportBtn.setAttribute("data-export", "1");
	exportBtn.hidden = true;
	const closeBtn = iconButton("关闭对话", closeIcon());
	closeBtn.setAttribute("data-close", "1");
	head.append(title, headSpacer, exportBtn, closeBtn);
	root.append(head, input, actions, hint, err);
	document.body.appendChild(root);
	const resizeInput = enableAutoResize(input, root);
	let attachment;
	let encoding = false;
	let capturing = false;
	const clearAttach = () => {
		attachment = void 0;
		attach.dataset.on = "0";
		thumb.removeAttribute("src");
		fileInput.value = "";
	};
	/** 把编码结果挂上去：上传与截屏两条路共用这一处落点。 */
	const applyEncoded = (encoded) => {
		if (!root.isConnected) return false;
		attachment = {
			mediaType: encoded.mediaType,
			data: encoded.base64
		};
		thumb.src = encoded.previewUrl;
		attach.dataset.on = "1";
		return true;
	};
	const setImageFile = async (file) => {
		if (!isImageFile(file)) {
			flash("只支持 PNG / JPEG / WebP / GIF");
			return false;
		}
		encoding = true;
		pickBtn.disabled = true;
		try {
			return applyEncoded(await encodeImageFile(file));
		} catch (e) {
			flash("读图失败：" + (e instanceof Error ? e.message : String(e)));
			return false;
		} finally {
			encoding = false;
			pickBtn.disabled = false;
		}
	};
	pickBtn.addEventListener("click", () => fileInput.click());
	fileInput.addEventListener("change", () => {
		const file = fileInput.files && fileInput.files[0];
		if (file) setImageFile(file);
	});
	attachX.addEventListener("click", clearAttach);
	root.addEventListener("paste", (e) => {
		const file = firstImageFromClipboard(e.clipboardData);
		if (!file) return;
		e.preventDefault();
		setImageFile(file);
	});
	if (opts.capture) {
		const capture = opts.capture;
		shotBtn.addEventListener("click", () => {
			if (capturing) return;
			capturing = true;
			shotBtn.disabled = true;
			capture().then((encoded) => applyEncoded(encoded)).catch((e) => flash("截屏失败：" + (e instanceof Error ? e.message : String(e)))).finally(() => {
				capturing = false;
				shotBtn.disabled = false;
			});
		});
	} else shotBtn.addEventListener("click", () => flash("当前环境不支持截屏，先用上传试试"));
	const hear = createHearControl({
		micBtn,
		input,
		hint: {
			show: showHint,
			hide: hideHint,
			flash
		},
		resizeInput,
		hearUrl
	});
	resizeInput();
	return {
		root,
		input,
		err,
		shotBtn,
		title,
		exportBtn,
		closeBtn,
		resizeInput,
		clearAttach,
		setImageFile,
		setEncoded: applyEncoded,
		getAttachment: () => attachment,
		isEncoding: () => encoding || capturing,
		flash,
		startHear: hear.start,
		stopHear: hear.stop,
		isHearing: hear.isHearing,
		dispose: () => {
			window.clearTimeout(hintTimer);
			hear.dispose();
		}
	};
}

//#endregion
//#region src/shared/chat/enter.ts
const COMPOSITION_SETTLE_MS = 80;
function createCompositionWatch() {
	let composing = false;
	let endedAt = Number.NEGATIVE_INFINITY;
	return {
		start: () => {
			composing = true;
		},
		end: (at) => {
			composing = false;
			endedAt = at;
		},
		isComposing: () => composing,
		endedWithin: (now) => now - endedAt < COMPOSITION_SETTLE_MS
	};
}
function decideEnter(event, watch, now) {
	if (event.key !== "Enter" || event.shiftKey) return "ignore";
	if (event.isComposing === true || event.keyCode === 229 || watch.isComposing()) return "ignore";
	if (event.repeat === true) return "swallow";
	if (watch.endedWithin(now)) return "swallow";
	return "send";
}

//#endregion
//#region src/shared/chat/log.ts
/** 一次最多回看多少轮（宿主对 `?rounds=` 的上限是 200）。 */
const LOG_ROUNDS = 200;
/** 请求超时（ms）：读记忆很快，超过就是宿主出问题了。 */
const LOG_TIMEOUT_MS = 15e3;
/** 时间戳 → `HH:mm`；跨天的消息在行首带上日期。 */
function clockOf$1(ts, today) {
	const d = new Date(ts);
	const pad$1 = (n) => String(n).padStart(2, "0");
	const hm = `${pad$1(d.getHours())}:${pad$1(d.getMinutes())}`;
	const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
	return sameDay ? hm : `${pad$1(d.getMonth() + 1)}-${pad$1(d.getDate())} ${hm}`;
}
function createChatLog(opts) {
	const { petId, baseUrl } = opts;
	const root = document.createElement("div");
	root.className = "dsh-pet-chat-log";
	const list = document.createElement("div");
	list.className = "dsh-pet-chat-log-list";
	const note = document.createElement("div");
	note.className = "dsh-pet-chat-log-note";
	root.append(list, note);
	let disposed = false;
	/** 请求序号：连续刷新时只认最后一次的响应，避免旧响应把新列表盖掉。 */
	let seq = 0;
	const setNote = (text, isErr = false) => {
		note.textContent = text;
		note.dataset.err = isErr ? "1" : "0";
		note.style.display = text === "" ? "none" : "block";
	};
	/** 把一条消息渲染成一行（角色决定左右与配色）。 */
	const rowOf = (m, today) => {
		const row = document.createElement("div");
		const role = m.role === "user" ? "user" : "assistant";
		row.className = "dsh-pet-chat-log-row";
		row.dataset.role = role;
		const meta = document.createElement("div");
		meta.className = "dsh-pet-chat-log-meta";
		const ts = typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : 0;
		meta.textContent = (role === "user" ? "我" : "她") + (ts > 0 ? " · " + clockOf$1(ts, today) : "");
		const body = document.createElement("div");
		body.className = "dsh-pet-chat-log-text";
		const content = typeof m.content === "string" ? m.content : "";
		body.textContent = content.trim() === "" ? "（空）" : content;
		row.append(meta, body);
		const tags = [];
		if (m.image !== void 0) {
			const w = Number(m.image.width);
			const h = Number(m.image.height);
			const sized = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
			tags.push(sized ? `附图 ${String(w)}×${String(h)}` : "附图");
		}
		if (typeof m.meme === "string" && m.meme !== "") tags.push("配图 " + m.meme);
		if (typeof m.action === "string" && m.action !== "") tags.push("动作 " + m.action);
		if (m.remind !== void 0) {
			const due = typeof m.remind?.dueAt === "number" ? clockOf$1(m.remind.dueAt, today) : "";
			tags.push("提醒 " + String(m.remind?.title ?? "") + (due === "" ? "" : "（" + due + "）"));
		}
		if (tags.length > 0) {
			const tag = document.createElement("div");
			tag.className = "dsh-pet-chat-log-tag";
			tag.textContent = tags.join(" · ");
			row.appendChild(tag);
		}
		return row;
	};
	/** 拉一次历史并重绘；滚到底（最新在下方）。 */
	const refresh = () => {
		if (disposed) return;
		const mine = ++seq;
		const url = baseUrl + "?pet=" + encodeURIComponent(petId) + "&rounds=" + LOG_ROUNDS;
		fetch(url, { signal: AbortSignal.timeout(LOG_TIMEOUT_MS) }).then((res) => res.json()).then((raw) => {
			if (disposed || mine !== seq) return;
			const o = raw ?? {};
			const messages = Array.isArray(o.messages) ? o.messages : [];
			const today = new Date();
			list.replaceChildren(...messages.map((m) => rowOf(m, today)));
			if (messages.length === 0) {
				const empty = document.createElement("div");
				empty.className = "dsh-pet-chat-log-empty";
				empty.textContent = "还没聊过，说第一句吧。";
				list.appendChild(empty);
			}
			setNote(messages.length >= LOG_ROUNDS * 2 ? "这里只显示最近的记录；导出会包含全部。" : "");
			list.scrollTop = list.scrollHeight;
		}).catch((e) => {
			if (disposed || mine !== seq) return;
			setNote("读取记录失败：" + (e instanceof Error ? e.message : String(e)), true);
		});
	};
	const save = () => {
		if (disposed) return;
		setNote("正在保存…");
		const url = baseUrl + "/export?pet=" + encodeURIComponent(petId);
		fetch(url, {
			method: "POST",
			signal: AbortSignal.timeout(LOG_TIMEOUT_MS)
		}).then((res) => res.json()).then((raw) => {
			if (disposed) return;
			const o = raw ?? {};
			if (o.ok === true && typeof o.path === "string") setNote(`已保存 ${String(o.count ?? "")} 条 → ${o.path}`);
			else setNote("保存失败：" + String(o.message ?? o.reason ?? "未知原因"), true);
		}).catch((e) => {
			if (disposed) return;
			setNote("保存失败：" + (e instanceof Error ? e.message : String(e)), true);
		});
	};
	return {
		root,
		refresh,
		save,
		dispose: () => {
			disposed = true;
			seq += 1;
			root.remove();
		}
	};
}

//#endregion
//#region src/shared/chat/place.ts
/** 夹回区间；区间非法（高/宽不够）时退到左/上边界，别吐 NaN 或负数。 */
function clamp(v, lo, hi) {
	return hi < lo ? lo : Math.min(Math.max(v, lo), hi);
}
function placeBeside(anchor, tip, bounds, gap = 10, pad$1 = 4) {
	const side = anchor.x + anchor.w / 2 > bounds.x + bounds.w / 2 ? "left" : "right";
	const x = side === "left" ? anchor.x - gap - tip.w : anchor.x + anchor.w + gap;
	const lowerHalf = anchor.y + anchor.h / 2 > bounds.y + bounds.h / 2;
	const rawY = lowerHalf ? anchor.y + anchor.h - tip.h : anchor.y;
	return {
		x: clamp(x, bounds.x + pad$1, bounds.x + bounds.w - tip.w - pad$1),
		y: clamp(rawY, bounds.y + pad$1, bounds.y + bounds.h - tip.h - pad$1),
		side
	};
}

//#endregion
//#region src/shared/chat/send.ts
/** 对话要等 LLM 生成回复，比碎碎念（30s）放宽一倍 */
const SEND_TIMEOUT_MS = 6e4;
async function sendChat(baseUrl, text, attachment) {
	const res = await fetch(baseUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(attachment ? {
			text,
			attachment
		} : { text }),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	const raw = await res.json().catch(() => null);
	if (!raw || typeof raw !== "object") throw new Error("dsh-pet: 对话响应非法");
	const o = raw;
	if (o.ok !== true) return {
		ok: false,
		reason: o.reason === "provider-missing" || o.reason === "generate-error" || o.reason === "config-error" ? o.reason : "bad-request",
		message: typeof o.message === "string" ? o.message : void 0
	};
	return {
		ok: true,
		text: typeof o.text === "string" ? o.text : void 0
	};
}

//#endregion
//#region src/shared/chat/dialog.ts
/** 点弹窗外或按 Esc 关闭；返回解绑函数。 */
function bindDismiss(root, isClosed, onDismiss) {
	const onPointerDown = (e) => {
		if (isClosed() || root.contains(e.target)) return;
		onDismiss();
	};
	const onKeyDown = (e) => {
		if (e.key === "Escape") onDismiss();
	};
	document.addEventListener("mousedown", onPointerDown, true);
	document.addEventListener("keydown", onKeyDown, true);
	return () => {
		document.removeEventListener("mousedown", onPointerDown, true);
		document.removeEventListener("keydown", onKeyDown, true);
	};
}
/** 回车发送：成功后回调、失败把原因写进 err 行，不伪造回复。 */
function bindSend(binding) {
	let sending = false;
	const doSend = () => {
		if (binding.isClosed() || sending) return;
		if (binding.isEncoding()) {
			binding.notify("图片还在处理，稍等一下");
			return;
		}
		const text = binding.input.value.trim();
		if (!text) return;
		sending = true;
		binding.input.disabled = true;
		sendChat(binding.url, text, binding.attachment()).then((state) => {
			if (state.ok) binding.onOk(state.text);
			else {
				binding.err.textContent = "对话失败：" + (state.message ?? state.reason);
				binding.err.style.display = "block";
			}
		}).catch((e) => {
			binding.err.textContent = "对话异常：" + String(e && e.message ? e.message : e);
			binding.err.style.display = "block";
		}).finally(() => {
			sending = false;
			binding.input.disabled = false;
			if (!binding.isClosed()) binding.input.focus();
		});
	};
	const ime = createCompositionWatch();
	binding.input.addEventListener("compositionstart", ime.start);
	binding.input.addEventListener("compositionend", () => ime.end(performance.now()));
	binding.input.addEventListener("keydown", (e) => {
		const action = decideEnter(e, ime, performance.now());
		if (action === "ignore") return;
		e.preventDefault();
		if (action === "send") doSend();
	});
}
/**
* 由对话地址推导识别地址：两端传进来的都是 `.../chat`，去掉尾段换成 `/voice/hear`。
*
* @param baseUrl - 已含挂载前缀的对话地址。
* @returns 同前缀下的识别地址。
*/
function hearUrlOf(baseUrl) {
	return baseUrl.replace(/\/chat$/, "") + "/voice/hear";
}
function mountChatDialog(opts) {
	injectChatCss();
	const { petId, surface: surface$1, x, y, onSent, onClose, clamp: clamp$1 } = opts;
	const baseUrl = opts.baseUrl ?? ROUTE_PATH + "/chat";
	const withPet = baseUrl + "?pet=" + encodeURIComponent(petId) + "&surface=" + surface$1;
	const c = clamp$1 && Number.isFinite(clamp$1.x + clamp$1.y + clamp$1.w + clamp$1.h) ? clamp$1 : {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	};
	const dom = createChatDom({
		capture: opts.capture,
		hearUrl: opts.hearUrl ?? hearUrlOf(baseUrl)
	});
	const { root, input, err } = dom;
	const mode = opts.mode ?? (opts.logOpen === false ? "cmd" : "chat");
	root.dataset.mode = mode;
	dom.title.textContent = mode === "cmd" ? "指令" : "对话";
	if (mode === "cmd") input.placeholder = "让她去做点什么…";
	let log$3;
	if (mode === "chat") {
		log$3 = createChatLog({
			petId,
			baseUrl
		});
		root.insertBefore(log$3.root, input);
		dom.exportBtn.hidden = false;
		dom.exportBtn.addEventListener("click", () => log$3?.save());
	}
	let result;
	if (mode === "cmd") {
		result = document.createElement("div");
		result.className = "dsh-pet-chat-result";
		result.style.display = "none";
		root.insertBefore(result, input);
	}
	/**
	* 落点：有 `anchor` 就按「宠物贴哪边、弹窗朝另一边长」摆（见 ./place.ts），
	* 否则保持旧行为——以 (x,y) 为左上角、超出 clamp 夹回。
	*/
	const place = () => {
		const r = root.getBoundingClientRect();
		if (opts.anchor && opts.anchor.w > 0 && opts.anchor.h > 0) {
			const at = placeBeside(opts.anchor, {
				w: r.width,
				h: r.height
			}, c);
			root.style.left = at.x + "px";
			root.style.top = at.y + "px";
			root.dataset.side = at.side;
			return;
		}
		root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - r.width - 4)) + "px";
		root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - r.height - 4)) + "px";
	};
	let closed = false;
	let unbindDismiss = () => {};
	const ro = new ResizeObserver(() => {
		if (!closed) place();
	});
	ro.observe(root);
	const close = () => {
		if (closed) return;
		closed = true;
		ro.disconnect();
		unbindDismiss();
		log$3?.dispose();
		dom.dispose();
		dom.clearAttach();
		root.remove();
		if (onClose) onClose();
	};
	unbindDismiss = bindDismiss(root, () => closed, close);
	dom.closeBtn.addEventListener("click", close);
	bindSend({
		input,
		err,
		url: withPet,
		isClosed: () => closed,
		onOk: (reply) => {
			if (mode === "cmd") {
				if (result) {
					result.textContent = reply ?? "做完了，没留话。";
					result.dataset.thinking = "0";
					result.style.display = "block";
				}
				input.value = "";
				dom.clearAttach();
				dom.resizeInput();
				place();
				input.focus();
			} else {
				input.value = "";
				dom.clearAttach();
				log$3?.refresh();
				dom.resizeInput();
				place();
				input.focus();
			}
			if (onSent) onSent();
		},
		attachment: () => dom.getAttachment(),
		isEncoding: () => dom.isEncoding(),
		notify: (text) => dom.flash(text)
	});
	dom.resizeInput();
	log$3?.refresh();
	place();
	if (opts.initialImage) dom.setImageFile(opts.initialImage);
	if (opts.initialEncoded) dom.setEncoded(opts.initialEncoded);
	input.focus();
	return {
		el: root,
		close,
		startHear: dom.startHear,
		stopHear: dom.stopHear,
		isHearing: dom.isHearing,
		setEncoded: dom.setEncoded,
		setImageFile: dom.setImageFile,
		flash: dom.flash
	};
}

//#endregion
//#region src/shared/chat/capture.ts
/** 等到视频真正有尺寸。 */
function waitForFrame(video) {
	if (video.videoWidth > 0) return Promise.resolve();
	return new Promise((resolve) => {
		video.onloadeddata = () => resolve();
	});
}
async function captureDisplayFrame() {
	const media = navigator.mediaDevices;
	if (!media || typeof media.getDisplayMedia !== "function") throw new Error("当前环境不支持截屏");
	const stream = await media.getDisplayMedia({
		video: true,
		audio: false
	});
	try {
		const video = document.createElement("video");
		video.srcObject = stream;
		video.muted = true;
		await video.play();
		await waitForFrame(video);
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth || 1280;
		canvas.height = video.videoHeight || 720;
		canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
		return encodeCanvas(canvas);
	} finally {
		for (const track of stream.getTracks()) track.stop();
	}
}

//#endregion
//#region src/client/file-drop.ts
const DROP_TARGET_CLASS = "is-drop-target";
function claimFileDragEnter(event) {
	if (!dragHasFiles(event)) return false;
	event.stopPropagation();
	hideHostDropOverlay();
	return true;
}
function claimFileDragOver(event) {
	if (!dragHasFiles(event)) return false;
	event.preventDefault();
	event.stopPropagation();
	return true;
}
function claimFileDrop(event) {
	if (!dragHasFiles(event)) return void 0;
	event.preventDefault();
	event.stopPropagation();
	hideHostDropOverlay();
	return firstImageFile(event.dataTransfer);
}
/**
* 收起宿主（DSH）的整页拖拽遮罩。
*
* 它用 document 上的 dragenter/dragleave 计数维护遮罩，只有 drop 与 window 的 dragend 会清零。
* 我们的 drop 截住冒泡后它收不到收尾信号，遮罩会一直挂着；补这一次不带文件，不会触发上传。
*/
function hideHostDropOverlay() {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event("dragend"));
}
function markDropTarget(event) {
	const el = event.currentTarget;
	if (!(el instanceof HTMLElement)) return;
	if (!claimFileDragEnter(event)) return;
	el.classList.add(DROP_TARGET_CLASS);
}
function unmarkDropTarget(event) {
	const el = event.currentTarget;
	const to = event.relatedTarget;
	if (!(el instanceof HTMLElement)) return;
	if (to instanceof Node && el.contains(to)) return;
	el.classList.remove(DROP_TARGET_CLASS);
}

//#endregion
//#region src/client/pet/card/open-chat.ts
function bindOpenChat(input) {
	const { stage, isHovered, openChat } = input;
	const onKeyDown = (e) => {
		if (!isHovered() || !isChatHotkey(e)) return;
		e.preventDefault();
		openChat();
	};
	const onPaste = (e) => {
		if (!isHovered() || isTypingTarget(e.target)) return;
		const file = firstImageFromClipboard(e.clipboardData);
		if (file === void 0) return;
		e.preventDefault();
		openChat(file);
	};
	const onDragOver = (e) => {
		if (!claimFileDragOver(e)) return;
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
	};
	const onDrop = (e) => {
		const file = claimFileDrop(e);
		if (file !== void 0) openChat(file);
	};
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("paste", onPaste, true);
	stage?.addEventListener("dragenter", claimFileDragEnter);
	stage?.addEventListener("dragover", onDragOver);
	stage?.addEventListener("drop", onDrop);
	return () => {
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("paste", onPaste, true);
		stage?.removeEventListener("dragenter", claimFileDragEnter);
		stage?.removeEventListener("dragover", onDragOver);
		stage?.removeEventListener("drop", onDrop);
	};
}

//#endregion
//#region src/client/pet/card/entry.ts
function createCardEntry(rt) {
	const { useEffect, useRef } = rt;
	return function useCardEntry(input) {
		const { card, cfgRef, drag, live, menuItemsRef, motion, runMenuAction, showTodo, stage, tipRef, toggleHistory, toggleTodo } = input;
		const menuRef = useRef(null);
		const chatRef = useRef(null);
		/** 把提示框摆到光标右下，放不下时翻边并夹回视口。
		*  直接写 DOM style：每次鼠标移动都走 React 状态会让整个 PetCard 重渲染。
		*/
		const placeTip = (clientX, clientY) => {
			const tipEl$1 = tipRef.current;
			if (!tipEl$1) return;
			const viewport = document.documentElement;
			const p = tooltipPlacement({
				x: clientX,
				y: clientY
			}, {
				w: tipEl$1.offsetWidth,
				h: tipEl$1.offsetHeight
			}, {
				x: 0,
				y: 0,
				w: viewport.clientWidth,
				h: viewport.clientHeight
			}, motion.metrics().size * TOOLTIP_GAP_RATIO);
			tipEl$1.style.left = p.x + "px";
			tipEl$1.style.top = p.y + "px";
		};
		useEffect(() => () => {
			if (menuRef.current) {
				menuRef.current.close();
				menuRef.current = null;
			}
			if (chatRef.current) {
				chatRef.current.close();
				chatRef.current = null;
			}
		}, []);
		/** 挂载对话弹窗：按宠物所在半边挑一侧弹出（宠物贴右就往左长），超出视口夹回。 */
		const mountChat = (seed, mode = "chat") => {
			if (chatRef.current) chatRef.current.close();
			const hitRect = stage()?.querySelector(".dsh-pet-hit")?.getBoundingClientRect();
			chatRef.current = mountChatDialog({
				petId: cfgRef.current.id,
				baseUrl: ROUTE_PATH + "/chat",
				surface: "web",
				mode,
				x: hitRect ? hitRect.right + 6 : window.innerWidth - 256,
				y: hitRect ? hitRect.top + 6 : 8,
				...hitRect ? { anchor: {
					x: hitRect.x,
					y: hitRect.y,
					w: hitRect.width,
					h: hitRect.height
				} } : {},
				...seed.image ? { initialImage: seed.image } : {},
				...seed.encoded ? { initialEncoded: seed.encoded } : {},
				capture: captureDisplayFrame,
				onSent: () => {
					console.info("[dsh-pet] 对话已发送 pet=" + cfgRef.current.id);
				},
				onClose: () => {
					chatRef.current = null;
				}
			});
		};
		/** 打开对话（菜单、悬停 L、拖拽都走这条）；带图时直接进入待发送状态。 */
		const openChat = (image) => mountChat(image ? { image } : {});
		/** 打开「指令」窗：同一个组件、另一种档位——说一件事，结果留在窗里不自动收。 */
		const openCommand = () => mountChat({}, "cmd");
		/** 把一张图送进对话：已开着就塞进去（不丢写了一半的字），没开就带图打开。 */
		const openChatWithImage = (file) => {
			const existing = chatRef.current;
			if (existing !== null) {
				existing.setImageFile(file);
				return;
			}
			openChat(file);
		};
		/** 打开待办面板：面板占气泡槽，重复点击是幂等的。 */
		const openTodo = () => showTodo();
		/** 开关最近记录面板：它是用户主动开的窗口，再点一次就收起。 */
		const openHistory = () => toggleHistory();
		/** 「按住说话」按下：弹窗没开就先开一个，再让它开录；已开着就直接在它上面开录。 */
		const startChatHear = () => {
			if (!chatRef.current) openChat();
			chatRef.current?.startHear();
		};
		/** 「按住说话」松开：只收尾，不关弹窗——识别结果要落进输入框让人看一眼。 */
		const stopChatHear = () => {
			chatRef.current?.stopHear();
		};
		/** 打开对话：已经开着就只把焦点交回输入框，重开会把打了一半的字丢掉。 */
		const openChatOrFocus = () => {
			const existing = chatRef.current;
			if (existing === null) {
				openChat();
				return;
			}
			existing.el.querySelector(".dsh-pet-chat-input")?.focus();
		};
		/** 截一帧塞进对话；截不到时照样开弹窗，把原因写在弹窗里——静默失败会被当成快捷键坏了。 */
		const captureInto = async () => {
			let encoded;
			try {
				encoded = await captureDisplayFrame();
			} catch (error) {
				const reason = "截屏失败：" + (error instanceof Error ? error.message : String(error));
				const opened = chatRef.current;
				if (opened !== null) {
					opened.flash(reason);
					return;
				}
				mountChat({});
				chatRef.current?.flash(reason);
				return;
			}
			const existing = chatRef.current;
			if (existing !== null) {
				existing.setEncoded(encoded);
				return;
			}
			mountChat({ encoded });
		};
		/** 截图动作的对外形状；异步收在里面，调用方不关心。 */
		const screenshot = () => {
			captureInto();
		};
		const hoverRef = useRef(false);
		const openChatRef = useRef(openChat);
		openChatRef.current = openChat;
		const stageGetterRef = useRef(stage);
		stageGetterRef.current = stage;
		const toggleTodoRef = useRef(toggleTodo);
		toggleTodoRef.current = toggleTodo;
		const toggleSleepRef = useRef(() => {});
		toggleSleepRef.current = () => {
			const asleep = live.current.flow?.sleeping() ?? false;
			runMenuAction(asleep ? {
				label: "起来",
				action: "wake"
			} : {
				label: "睡觉",
				action: "sleep"
			});
		};
		const switchDisplayRef = useRef(() => {});
		switchDisplayRef.current = (display) => {
			runMenuAction({
				label: "显示位置",
				action: "set-display",
				display
			});
		};
		const startChatHearRef = useRef(startChatHear);
		startChatHearRef.current = startChatHear;
		const stopChatHearRef = useRef(stopChatHear);
		stopChatHearRef.current = stopChatHear;
		const openChatOrFocusRef = useRef(openChatOrFocus);
		openChatOrFocusRef.current = openChatOrFocus;
		const openChatWithImageRef = useRef(openChatWithImage);
		openChatWithImageRef.current = openChatWithImage;
		const screenshotRef = useRef(screenshot);
		screenshotRef.current = screenshot;
		useEffect(() => registerPetChatHandle(cfgRef.current.id, {
			open: () => openChatOrFocusRef.current(),
			close: () => chatRef.current?.close(),
			isOpen: () => chatRef.current !== null,
			startHear: () => startChatHearRef.current(),
			stopHear: () => stopChatHearRef.current(),
			isHearing: () => chatRef.current?.isHearing() ?? false,
			screenshot: () => screenshotRef.current()
		}), [cfgRef]);
		useEffect(() => {
			const offChat = bindOpenChat({
				stage: stageGetterRef.current(),
				isHovered: () => hoverRef.current,
				openChat: (image) => image === void 0 ? openChatRef.current() : openChatWithImageRef.current(image)
			});
			const hearHold = createHearHold({
				isArmed: () => {
					if (hoverRef.current) return true;
					const chat = chatRef.current;
					const active = document.activeElement;
					return !!chat && !!active && chat.el.contains(active);
				},
				onPress: () => startChatHearRef.current(),
				onRelease: () => stopChatHearRef.current()
			});
			const onKeyDown = (e) => {
				if (hearHold.onKeyDown(e)) {
					e.preventDefault();
					return;
				}
				if (!hoverRef.current) return;
				const display = displayOfHotkey(e);
				if (display !== void 0) {
					e.preventDefault();
					switchDisplayRef.current(display);
					return;
				}
				if (isCaptureHotkey(e)) {
					e.preventDefault();
					screenshotRef.current();
					return;
				}
				if (isSleepHotkey(e)) {
					e.preventDefault();
					toggleSleepRef.current();
					return;
				}
				if (!isTodoHotkey(e)) return;
				e.preventDefault();
				toggleTodoRef.current();
			};
			const onKeyUp = (e) => hearHold.onKeyUp(e);
			document.addEventListener("keydown", onKeyDown, true);
			document.addEventListener("keyup", onKeyUp, true);
			return () => {
				offChat();
				document.removeEventListener("keydown", onKeyDown, true);
				document.removeEventListener("keyup", onKeyUp, true);
			};
		}, []);
		live.current.placeTip = placeTip;
		live.current.tipOn = () => card.state.tipOn;
		/** 打开右键菜单。 */
		const handleContextMenu = (e) => {
			const more = buildMoreBranch(menuItemsRef.current);
			const pic = cfgRef.current;
			const memes = buildMemeBranch(pic, (name) => memeThumbUrl(ROUTE_PATH, pic.assetRoot, name));
			const asleep = live.current.flow?.sleeping() ?? false;
			const canSleep = (cfgRef.current.animations.sleep ?? []).length > 0;
			const sleepItem = asleep ? {
				label: "起来",
				action: "wake",
				hint: SLEEP_HOTKEY_HINT
			} : {
				label: "睡觉",
				action: "sleep",
				hint: SLEEP_HOTKEY_HINT
			};
			const layout = resolveMenuLayout(cfgRef.current.menuOrder, cfgRef.current.menuHidden);
			const toolNode = (action) => {
				switch (action) {
					case "chat": return {
						label: "对话",
						action: "chat",
						hint: CHAT_HOTKEY_HINT
					};
					case "show-balance": return {
						label: "查看余额",
						action: "show-balance"
					};
					case "todo": return {
						label: "待办事项",
						action: "todo",
						hint: TODO_HOTKEY_HINT
					};
					case "history": return {
						label: "最近记录",
						action: "history"
					};
					case "whisper": return {
						label: "碎碎念",
						action: "whisper"
					};
					case "sleep": return canSleep ? sleepItem : null;
					default: return null;
				}
			};
			const tools = [...layout.order.filter((action) => !layout.hidden.includes(action)).map(toolNode).filter((node) => node !== null), ...memes ? [memes] : []];
			const tail = [displayMenuBranch(), {
				label: "回到初始位置",
				action: "home"
			}];
			const tree = [
				...tools,
				...buildMenuTree(cfgRef.current.animations),
				...tail,
				...more ? [more] : []
			];
			if (!tree.length) return;
			e.preventDefault();
			e.stopPropagation();
			if (drag.isActive() || drag.justDragged()) return;
			motion.flight.stop();
			motion.stopMove();
			if (menuRef.current) menuRef.current.close();
			menuRef.current = mountContextMenu({
				tree,
				x: e.clientX,
				y: e.clientY,
				onAction: runMenuAction,
				onClose: () => {
					if (menuRef.current) menuRef.current = null;
				}
			});
		};
		return {
			handleContextMenu,
			onPointerEnter: (e) => {
				hoverRef.current = true;
				placeTip(e.clientX, e.clientY);
				card.actions.setTipOn(true);
			},
			onPointerLeave: () => {
				hoverRef.current = false;
				card.actions.setTipOn(false);
			},
			openChat,
			openCommand,
			openTodo,
			placeTip,
			toggleHistory: openHistory
		};
	};
}

//#endregion
//#region src/client/pet/motion/flight-integrate.ts
function integrateFlight(state, dt, bounds, physics, gravity) {
	const substeps = throwSubsteps(state.vx, state.vy, dt);
	let res = throwStep(state, dt / substeps, bounds, physics, gravity);
	/** 子步里只保留最重的一次撞击：一帧震一下就够了。 */
	let hit = res.hit;
	for (let i = 1; i < substeps && !res.atRest; i++) {
		res = throwStep(res, dt / substeps, bounds, physics, gravity);
		if (res.hit !== null && (hit === null || res.hit.speed > hit.speed)) hit = res.hit;
	}
	return {
		...res,
		hit
	};
}

//#endregion
//#region src/client/pet/motion/pet-collision.ts
/**
* 把重叠推开：{@link overlapPush} 给的是「各让一半」，这里取整段——
* 对方若也在跑，它下一帧会从自己那侧再推一次，两边各推一次正好分开。
*
* @param state - 当前状态。
* @param push - 半程位移；`null` = 没有重叠。
* @returns 推开后的状态（速度不动）。
*/
const separate = (state, push) => push === null ? state : {
	...state,
	x: state.x + push.dx * 2,
	y: state.y + push.dy * 2
};
function createPetCollision(deps) {
	return (state, metrics) => {
		const slots = deps.arena().slots;
		const myBody = bodyPixelBox({
			x: state.x,
			y: state.y,
			size: metrics.size,
			bottomPad: metrics.bottomPad
		});
		for (const slotId of Object.keys(slots)) {
			if (slotId === deps.petId) continue;
			const slot = slots[slotId];
			const otherBox = slot.getBox();
			if (!otherBox) continue;
			const otherBody = bodyPixelBox({
				x: otherBox.x,
				y: otherBox.y,
				size: slot.size,
				bottomPad: slot.bottomPad
			});
			if (!rectsOverlap(myBody, otherBody)) continue;
			const separated = separate(state, overlapPush(myBody, otherBody));
			const vel = slot.getVel();
			const hit = collidePet({
				x: state.x,
				y: state.y,
				vx: state.vx,
				vy: state.vy,
				size: metrics.size
			}, {
				x: otherBox.x,
				y: otherBox.y,
				vx: vel.vx,
				vy: vel.vy,
				size: slot.size
			});
			if (hit === null) return separated;
			deps.onPetImpact(hit.impactSpeed);
			slot.applyVelocity(hit.hvx, hit.hvy);
			return {
				...separated,
				vx: hit.fvx,
				vy: hit.fvy
			};
		}
		return state;
	};
}

//#endregion
//#region src/client/pet/motion/flight.ts
/** 常驻模式的速度上限（px/s）：传感器重力会持续加速，留一个硬天花板兜底。 */
const MAX_HELD_SPEED = 6e3;
function createFlight(deps) {
	/** 在跑的 rAF；`null` = 没在跑。 */
	let frame = null;
	/** 世代号：起飞或停飞 +1，迟到的帧据此自弃。 */
	let token = 0;
	/** 最近一帧的状态；`null` = 没在跑。帧间它与帧内的 `current` 是同一个对象，改速度就是改下一刻的输入。 */
	let state = null;
	/** 是否体感常驻模式：重力逐帧由 {@link FlightDeps.gravity} 提供，落定改用静默计时。 */
	let held = false;
	/** 常驻模式的静默时长（ms）：重力为零且速度低时累计，到点停帧。 */
	let quietMs = 0;
	/** 互撞结算：规则在 pet-collision，这里只把撞击转成触觉回调。 */
	const resolveCollisions = createPetCollision({
		arena: deps.arena,
		petId: deps.petId,
		onPetImpact: (speed) => deps.onImpact?.({
			kind: "pet",
			speed
		})
	});
	const stop = () => {
		token++;
		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}
		state = null;
		held = false;
		quietMs = 0;
	};
	const start = (px$1, py, vx, vy) => {
		held = false;
		run(px$1, py, vx, vy);
	};
	/** 体感常驻模式：没有初速，重力逐帧由 {@link FlightDeps.gravity} 提供；已在常驻时无副作用。 */
	const startHeld = () => {
		if (frame !== null && held) return;
		const el = deps.root();
		const box = deps.box() ?? (el ? {
			x: el.getBoundingClientRect().left,
			y: el.getBoundingClientRect().top
		} : null);
		if (box === null) return;
		held = true;
		run(box.x, box.y, 0, 0);
	};
	/**
	* 改写当前速度：碰撞结算给的是绝对速度，不是增量。
	*
	* @param vx - 水平速度（px/s）。
	* @param vy - 竖直速度（px/s）。
	*/
	const setVelocity = (vx, vy) => {
		if (state === null) return;
		state.vx = vx;
		state.vy = vy;
	};
	/**
	* 叠加一个冲量（摇一摇）：只在已经在跑时有效——没在跑时由调用方按抛掷起飞。
	*
	* @param dvx - 横向冲量（px/s）。
	* @param dvy - 纵向冲量（px/s）。
	*/
	const impulse = (dvx, dvy) => {
		if (state === null) return;
		state.vx += dvx;
		state.vy += dvy;
	};
	const run = (px$1, py, vx, vy) => {
		const metrics = deps.metrics();
		const viewport = deps.viewport();
		const physics = deps.physics();
		const bounds = throwBounds({
			W: viewport.width,
			H: viewport.height,
			size: metrics.size,
			sideAllow: metrics.sideAllow
		});
		const own = ++token;
		quietMs = 0;
		let current$1 = {
			x: px$1,
			y: py,
			vx,
			vy
		};
		let last = performance.now();
		let prevGrounded = false;
		const rootEl = deps.root();
		/** 写回本帧位置：DOM、包围盒与归一化中心（后者供重渲染时按它重排）。 */
		const commitPose = (at) => {
			if (rootEl) {
				rootEl.style.left = at.x + "px";
				rootEl.style.top = at.y + "px";
				rootEl.style.right = "auto";
				rootEl.style.bottom = "auto";
			}
			deps.setBox({
				x: at.x,
				y: at.y
			});
			const center = {
				rx: (at.x + metrics.halfW) / viewport.width,
				ry: (at.y + metrics.halfH) / viewport.height
			};
			deps.commitLive(center);
			return center;
		};
		const step = () => {
			if (token !== own) return;
			const now = performance.now();
			const dt = Math.min(.05, Math.max(0, (now - last) / 1e3));
			last = now;
			const fallingVy = current$1.vy;
			const gravity = held ? deps.gravity?.() : void 0;
			const res = integrateFlight(current$1, dt, bounds, physics, gravity);
			if (res.hit !== null) deps.onImpact?.({
				kind: res.hit.edge,
				speed: res.hit.speed
			});
			const integrated = {
				x: res.x,
				y: res.y,
				vx: res.vx,
				vy: res.vy
			};
			current$1 = integrated;
			if (physics.petCollision) current$1 = resolveCollisions(current$1, metrics);
			const disturbed = current$1 !== integrated;
			if (held) {
				const speed = Math.hypot(current$1.vx, current$1.vy);
				if (speed > MAX_HELD_SPEED) {
					const k = MAX_HELD_SPEED / speed;
					current$1 = {
						...current$1,
						vx: current$1.vx * k,
						vy: current$1.vy * k
					};
				}
			}
			state = current$1;
			const center = commitPose(current$1);
			const grounded = current$1.y >= bounds.maxY - 1;
			if (res.bounced && grounded && !prevGrounded) deps.onLanding(fallingVy);
			prevGrounded = grounded;
			if (held) {
				const g = gravity ?? {
					gx: 0,
					gy: physics.gravity
				};
				const isStill = Math.hypot(g.gx, g.gy) < 1 && Math.hypot(current$1.vx, current$1.vy) < 20;
				quietMs = isStill ? quietMs + dt * 1e3 : 0;
				if (quietMs >= 300) {
					deps.commitFinal(center);
					stop();
					return;
				}
			} else if (res.atRest && !disturbed) {
				deps.commitFinal(center);
				stop();
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	};
	return {
		impulse,
		isFlying: () => frame !== null,
		isHeld: () => held,
		setVelocity,
		start,
		startHeld,
		stop,
		velocity: () => frame !== null && state !== null ? {
			vx: state.vx,
			vy: state.vy
		} : {
			vx: 0,
			vy: 0
		}
	};
}

//#endregion
//#region src/client/pet/haptics.ts
const HAPTIC_COOLDOWN_MS = 120;
const HAPTIC_MIN_SPEED = 150;
/** 手感锚点：与落地挤压同一组速度阈值——软碰取最短，硬砸取最长。 */
const SOFT_SPEED = 300;
const HARD_SPEED = 1500;
const SHORT_PULSE_MS = 10;
const LONG_PULSE_MS = 28;
function pulseMsFor(speed) {
	if (!Number.isFinite(speed) || speed < HAPTIC_MIN_SPEED) return null;
	const t = Math.min(1, Math.max(0, (speed - SOFT_SPEED) / (HARD_SPEED - SOFT_SPEED)));
	return Math.round(SHORT_PULSE_MS + (LONG_PULSE_MS - SHORT_PULSE_MS) * t);
}
function createHaptics(deps) {
	const vibrate = deps?.vibrate ?? hardwareVibrate;
	const now = deps?.now ?? (() => performance.now());
	const enabled = deps?.enabled ?? (() => true);
	/** 每类撞击上次震动的时刻；`undefined` = 还没震过。 */
	const lastAt = new Map();
	return { hit(kind, speed) {
		if (!enabled()) return;
		const ms = pulseMsFor(speed);
		if (ms === null) return;
		const at = now();
		const prev = lastAt.get(kind);
		if (prev !== void 0 && at - prev < HAPTIC_COOLDOWN_MS) return;
		lastAt.set(kind, at);
		vibrate(ms);
	} };
}
/** 真实硬件：无 API、页面不可见或 WebView 抛错时静默跳过——触觉不是关键路径。 */
function hardwareVibrate(ms) {
	if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
	if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
	try {
		navigator.vibrate(ms);
	} catch {}
}

//#endregion
//#region src/client/pet/motion/position-follow.ts
function createPositionFollow(deps) {
	/** 进行中的 rAF；`null` = 没有跟随在跑。 */
	let frame = null;
	/** 世代号：每次开始或停止 +1，迟到的帧据此自弃。 */
	let token = 0;
	const stop = () => {
		token += 1;
		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}
	};
	/** 写包围盒与四个 style，弹簧和直线两条路共用。 */
	const paint = (el, x, y) => {
		deps.setBox({
			x,
			y
		});
		el.style.left = x + "px";
		el.style.top = y + "px";
		el.style.right = "auto";
		el.style.bottom = "auto";
	};
	const apply = (rx, ry, mode, duration) => {
		if (deps.isDragging()) return;
		deps.takeOver();
		const target = centerToBox({
			rx,
			ry
		}, deps.viewport(), deps.half());
		const el = deps.root();
		if (!el || mode === "instant" || mode === "line" && duration <= 0) {
			deps.setBox(target);
			deps.commit({
				rx,
				ry
			});
			return;
		}
		const current$1 = token + 1;
		token = current$1;
		if (frame !== null) cancelAnimationFrame(frame);
		if (mode === "line") {
			if (duration <= 0) return;
			const from = deps.box() ?? target;
			const t0 = performance.now();
			const step$1 = () => {
				if (token !== current$1) return;
				const p = Math.min((performance.now() - t0) / duration, 1);
				if (p >= 1) {
					paint(el, target.x, target.y);
					frame = null;
					deps.commit({
						rx,
						ry
					});
					return;
				}
				paint(el, from.x + (target.x - from.x) * p, from.y + (target.y - from.y) * p);
				frame = requestAnimationFrame(step$1);
			};
			frame = requestAnimationFrame(step$1);
			return;
		}
		let last = performance.now();
		const vel = {
			vx: 0,
			vy: 0
		};
		const step = () => {
			if (token !== current$1) return;
			const now = performance.now();
			const dt = Math.min((now - last) / 1e3, 1 / 30);
			last = now;
			let x = deps.box()?.x ?? target.x;
			let y = deps.box()?.y ?? target.y;
			vel.vx = springStep(vel.vx, x, target.x, dt, deps.spring());
			vel.vy = springStep(vel.vy, y, target.y, dt, deps.spring());
			x += vel.vx * dt;
			y += vel.vy * dt;
			paint(el, x, y);
			if (Math.abs(target.x - x) < .5 && Math.abs(target.y - y) < .5 && Math.abs(vel.vx) < 1 && Math.abs(vel.vy) < 1) {
				paint(el, target.x, target.y);
				frame = null;
				deps.commit({
					rx,
					ry
				});
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	};
	return {
		apply,
		stop
	};
}

//#endregion
//#region src/client/pet/motion/squash.ts
function createSquashDriver(o) {
	/** 进行中的 rAF；`null` = 没有挤压在跑。 */
	let frame = null;
	/** 世代号：每次开始或停止都 +1，迟到的帧据此自弃。 */
	let token = 0;
	const stop = () => {
		token += 1;
		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}
	};
	const start = (el, depth = SQ_SQUASH) => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		token += 1;
		const current$1 = token;
		if (frame !== null) cancelAnimationFrame(frame);
		const origin = el.style.transformOrigin;
		el.style.transformOrigin = "bottom";
		const t0 = performance.now();
		const step = () => {
			if (token !== current$1) return;
			const u = Math.min((performance.now() - t0) / SQ_DURATION_MS, 1);
			const scale = squashScale(u, depth);
			el.style.transform = (o.facing() === "right" ? "scaleX(-1) " : "") + "scaleY(" + scale + ")";
			if (u < 1) {
				frame = requestAnimationFrame(step);
				return;
			}
			frame = null;
			el.style.transformOrigin = origin;
			el.style.transform = o.facing() === "right" ? "scaleX(-1)" : "";
		};
		frame = requestAnimationFrame(step);
	};
	return {
		start,
		stop
	};
}

//#endregion
//#region src/shared/motion.ts
const planMove = (o) => {
	const side = o.sideAllow ?? 0;
	const distance = randomBetween(o.minDist, o.maxDist);
	const target = o.cx + o.dir * distance;
	if (o.areas && o.areas.length > 0) {
		const bodyHalf = o.halfW - side;
		if (!rectAtPoint(o.areas, target - bodyHalf - o.margin, o.cy)) return null;
		if (!rectAtPoint(o.areas, target + bodyHalf + o.margin, o.cy)) return null;
	} else {
		const leftBound = o.margin + o.halfW - side;
		const rightBound = o.W - o.margin - o.halfW + side;
		if (target < leftBound || target > rightBound) return null;
	}
	return {
		startRatio: o.cx / o.W,
		startYRatio: o.cy / o.H,
		targetRatio: target / o.W,
		totalRatio: Math.abs(target - o.cx) / o.W
	};
};

//#endregion
//#region src/client/pet/motion/move-action.ts
function planMoveAction(input) {
	const actions = input.moves.actions;
	if (actions.length === 0) return null;
	const random = input.random ?? Math.random;
	const chosen = input.preferredName ? actions.find((action) => action.name === input.preferredName) ?? null : actions[Math.floor(random() * actions.length)];
	if (!chosen) return null;
	const params = Object.assign({}, input.moves.default, chosen.params ?? {});
	const dir = input.facing === "right" ? 1 : -1;
	const distScale = input.size / PET_REF_WIDTH;
	const plan = planMove({
		cx: input.center.x,
		cy: input.center.y,
		W: input.viewport.width,
		H: input.viewport.height,
		dir,
		minDist: params.minDist * distScale,
		maxDist: params.maxDist * distScale,
		margin: params.margin,
		halfW: input.halfW,
		sideAllow: input.sideAllow
	});
	if (plan === null) return null;
	return {
		anim: chosen.name,
		pending: {
			...plan,
			dir,
			leadSec: params.leadSec,
			tailSec: params.tailSec
		}
	};
}

//#endregion
//#region src/client/pet/motion/walk.ts
/** 元数据未就绪时的兜底时长（秒）：取内置走路素材的常见时长，避免除零。 */
const FALLBACK_DURATION_SEC = 10.09;
function createWalk(deps) {
	/** 在跑的 rAF；`null` = 没在走。 */
	let frame = null;
	/** 世代号：开跑或停走 +1，迟到的帧据此自弃。 */
	let token = 0;
	/** 已规划、等待视频就绪的走位。 */
	let pending = null;
	const hasPending = () => pending !== null;
	const start = (el) => {
		if (pending === null || frame !== null) return;
		const move = pending;
		pending = null;
		const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : FALLBACK_DURATION_SEC;
		const travelWindow = Math.max(.1, duration - move.leadSec - move.tailSec);
		const own = ++token;
		const step = () => {
			if (token !== own) return;
			const t = el.currentTime || 0;
			const { halfW, halfH } = deps.metrics();
			const { width: W, height: H } = deps.viewport();
			let ratioX;
			if (t <= move.leadSec) ratioX = move.startRatio;
			else if (t >= duration - move.tailSec) ratioX = move.targetRatio;
			else ratioX = move.startRatio + (move.targetRatio - move.startRatio) * ((t - move.leadSec) / travelWindow);
			const box = {
				x: ratioX * W - halfW,
				y: move.startYRatio * H - halfH
			};
			const rootEl = deps.root();
			if (rootEl) {
				rootEl.style.left = box.x + "px";
				rootEl.style.top = box.y + "px";
				rootEl.style.right = "auto";
				rootEl.style.bottom = "auto";
			}
			deps.setBox(box);
			if (t < duration - move.tailSec) frame = requestAnimationFrame(step);
			else {
				frame = null;
				deps.commit({
					rx: move.targetRatio,
					ry: move.startYRatio
				});
			}
		};
		frame = requestAnimationFrame(step);
	};
	const tryMove = (preferredName) => {
		if (frame !== null || pending !== null || deps.isFlying()) return true;
		const metrics = deps.metrics();
		const action = planMoveAction({
			moves: deps.moves(),
			preferredName,
			facing: deps.facing(),
			size: metrics.size,
			center: deps.center(),
			viewport: deps.viewport(),
			halfW: metrics.halfW,
			sideAllow: metrics.sideAllow
		});
		if (action === null) return false;
		pending = action.pending;
		deps.play(action.anim);
		return action.anim;
	};
	const stop = () => {
		pending = null;
		token++;
		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}
	};
	return {
		hasPending,
		start,
		stop,
		tryMove
	};
}

//#endregion
//#region src/client/pet/card/motion.ts
function createCardMotion(rt) {
	const { useEffect, useRef } = rt;
	return function useCardMotion(input) {
		const { arena, card, cfgRef, live, metrics, moves, petId, root, setAnim, setOnce, setCustomPos } = input;
		/** 当帧走位参数：走位驱动长期持有，每渲染就地更新，避免把尺寸与动画池闭包进旧实例。 */
		const motionRef = useRef(metrics);
		motionRef.current = metrics;
		const movesRef = useRef(moves);
		movesRef.current = moves;
		/** 包围盒：与拖拽、飞行共享，谁动谁写回。 */
		const boxRef = useRef(null);
		const squashRef = useRef(null);
		squashRef.current ?? (squashRef.current = createSquashDriver({ facing: () => card.facingRef.current }));
		const squash = squashRef.current;
		/** 当前宠物中心的视口 X 坐标。 */
		const currentCenterX = () => {
			const cp = card.customPosRef.current;
			if (cp) return cp.rx * window.innerWidth;
			const rootEl = root();
			if (rootEl) return rootEl.getBoundingClientRect().left + motionRef.current.halfW;
			return window.innerWidth - 24 - motionRef.current.halfW;
		};
		/** 当前宠物中心的视口 Y 坐标。 */
		const currentCenterY = () => {
			const cp = card.customPosRef.current;
			if (cp) return cp.ry * window.innerHeight;
			const rootEl = root();
			if (rootEl) return rootEl.getBoundingClientRect().top + motionRef.current.halfH;
			return window.innerHeight - 20 - motionRef.current.halfH;
		};
		const walkRef = useRef(null);
		walkRef.current ?? (walkRef.current = createWalk({
			root,
			center: () => ({
				x: currentCenterX(),
				y: currentCenterY()
			}),
			metrics: () => motionRef.current,
			moves: () => movesRef.current,
			facing: () => card.facingRef.current,
			viewport: () => ({
				width: window.innerWidth,
				height: window.innerHeight
			}),
			isFlying: () => flightRef.current?.isFlying() ?? false,
			play: (name) => {
				setOnce(true);
				setAnim(name);
			},
			setBox: (box) => {
				boxRef.current = box;
			},
			commit: setCustomPos
		}));
		const walk = walkRef.current;
		/** 停止自主走位与位置跟随。 */
		const stopMove = () => {
			walkRef.current?.stop();
			posFollowRef.current?.stop();
		};
		const flightRef = useRef(null);
		/** 触觉反馈：每张卡一个，冷却状态跟着卡片走；开关实时读配置。 */
		const hapticsRef = useRef(null);
		hapticsRef.current ?? (hapticsRef.current = createHaptics({ enabled: () => cfgRef.current.physics?.hapticEnabled !== false }));
		const haptics = hapticsRef.current;
		flightRef.current ?? (flightRef.current = createFlight({
			root,
			metrics: () => motionRef.current,
			viewport: () => ({
				width: window.innerWidth,
				height: window.innerHeight
			}),
			physics: () => cfgRef.current.physics,
			arena: () => arena.current,
			petId,
			box: () => boxRef.current,
			setBox: (box) => {
				boxRef.current = box;
			},
			commitLive: (center$1) => {
				card.customPosRef.current = center$1;
			},
			commitFinal: setCustomPos,
			onLanding: (impactVy) => {
				const frontEl = live.current.ownAnim.frontVideo();
				if (frontEl) live.current.squash.start(frontEl, landingSquash(impactVy));
			},
			onImpact: (impact) => {
				haptics.hit(impact.kind, impact.speed);
			},
			gravity: () => {
				const physics = cfgRef.current.physics;
				const gravity = physics?.gravity ?? 0;
				if (physics?.tiltGravity !== true) return {
					gx: 0,
					gy: gravity
				};
				const sample = tiltSampleRef.current;
				const baseline = tiltBaselineRef.current;
				if (sample === null || baseline === null) return {
					gx: 0,
					gy: gravity
				};
				return tiltGravity(sample, baseline, gravity);
			}
		}));
		const flight = flightRef.current;
		/** 体感：采样与中性姿态；关掉倾斜时两个都清空，下次再开重新标定。 */
		const tiltSampleRef = useRef(null);
		const tiltBaselineRef = useRef(null);
		/** 从给定左上角与初速起飞；先停弹簧跟随与走位，免得两套运动同时改位置。 */
		const startThrow = (px$1, py, vx, vy) => {
			live.current.drag.stopFollow();
			stopMove();
			flight.start(px$1, py, vx, vy);
		};
		/**
		* 把速度落到这只宠物身上：在跑就按给定口径处理，没跑就从落点起飞。
		*
		* 没跑时一律起抛掷而不是起常驻——常驻只在倾斜开关开着时由姿态采样拉起，
		* 否则重力非零时会留下一个永远停不下来的常驻循环。
		*
		* @param vx - 水平速度或冲量（px/s）。
		* @param vy - 竖直速度或冲量（px/s）。
		* @param mode - `set` = 结算后的绝对速度（碰撞）；`add` = 叠加冲量（摇一摇）。
		*/
		const applyVelocity = (vx, vy, mode) => {
			if (flight.isFlying()) {
				if (mode === "set") flight.setVelocity(vx, vy);
				else flight.impulse(vx, vy);
				return;
			}
			const at = boxRef.current ?? root()?.getBoundingClientRect() ?? null;
			if (at === null) return;
			startThrow(at.x, at.y, vx, vy);
		};
		/** 最新的 applyVelocity 引用，供碰撞槽与传感器回调转发，避免陈旧闭包。 */
		const applyVelocityRef = useRef(() => {});
		applyVelocityRef.current = applyVelocity;
		useEffect(() => {
			if (!canReadMotionSensors()) return;
			const offTilt = subscribeTilt((sample) => {
				if (cfgRef.current.physics?.tiltGravity !== true) {
					tiltSampleRef.current = null;
					tiltBaselineRef.current = null;
					if (flight.isHeld()) flight.stop();
					return;
				}
				if (tiltBaselineRef.current === null) tiltBaselineRef.current = sample;
				tiltSampleRef.current = sample;
				if (live.current.drag.isActive() || flight.isFlying()) return;
				const gravity = cfgRef.current.physics?.gravity ?? 0;
				const vector = tiltGravity(sample, tiltBaselineRef.current, gravity);
				if (vector.gx === 0 && vector.gy === 0) return;
				stopMove();
				flight.startHeld();
			});
			const offShake = subscribeShake((ax, ay, az) => {
				const physics = cfgRef.current.physics;
				if (physics?.shakeThrow !== true) return;
				if (live.current.drag.isActive()) return;
				const impulse = shakeImpulse(ax, ay, az, physics.throwPower ?? 1);
				if (impulse !== null) applyVelocityRef.current(impulse.vx, impulse.vy, "add");
			});
			return () => {
				offTilt();
				offShake();
				flight.stop();
			};
		}, []);
		const posFollowRef = useRef(null);
		posFollowRef.current ?? (posFollowRef.current = createPositionFollow({
			root,
			box: () => boxRef.current,
			setBox: (box) => {
				boxRef.current = box;
			},
			commit: setCustomPos,
			viewport: () => ({
				width: window.innerWidth,
				height: window.innerHeight
			}),
			half: () => ({
				w: motionRef.current.halfW,
				h: motionRef.current.halfH
			}),
			spring: () => cfgRef.current.physics.throwPower,
			isDragging: () => live.current.drag.isActive(),
			takeOver: () => {
				flightRef.current?.stop();
				walkRef.current?.stop();
				posFollowRef.current?.stop();
			}
		}));
		const posFollow = posFollowRef.current;
		/** 执行抛掷指令：角度（度，0 为正右，逆时针为正）与力度倍率换算成初速度，交给 startThrow。
		*  下游物理全部复用，不设死区。
		*/
		const applyThrow = (angleDeg, power) => {
			if (live.current.drag.isActive()) return;
			const { vx, vy } = throwVelocity(angleDeg, power);
			const box = boxRef.current ?? {
				x: currentCenterX() - motionRef.current.halfW,
				y: currentCenterY() - motionRef.current.halfH
			};
			startThrow(box.x, box.y, vx, vy);
		};
		const { size, bottomPad } = metrics;
		useEffect(() => {
			const arenaSlots = arena.current.slots;
			arenaSlots[petId] = {
				size,
				bottomPad,
				getBox: () => {
					if (boxRef.current) return boxRef.current;
					const r = root()?.getBoundingClientRect();
					return r ? {
						x: r.left,
						y: r.top
					} : null;
				},
				getVel: () => flight.velocity(),
				applyVelocity: (vx, vy) => applyVelocityRef.current(vx, vy, "set")
			};
			return () => {
				delete arenaSlots[petId];
			};
		}, [
			petId,
			size,
			bottomPad,
			arena
		]);
		const center = () => ({
			x: currentCenterX(),
			y: currentCenterY()
		});
		live.current.walk = walk;
		live.current.flight = flight;
		live.current.posFollow = posFollow;
		live.current.squash = squash;
		live.current.center = center;
		live.current.stopMove = stopMove;
		return {
			applyThrow,
			box: () => boxRef.current,
			center,
			flight,
			metrics: () => motionRef.current,
			posFollow,
			setBox: (box) => {
				boxRef.current = box;
			},
			squash,
			startThrow,
			stopMove,
			walk
		};
	};
}

//#endregion
//#region src/client/pet/card/state.ts
function createCardState(rt) {
	const { useState, useRef } = rt;
	return function useCardState(init) {
		const [anim, setAnim] = useState(init.anim);
		const [once, setOnce] = useState(true);
		const [seq, setSeq] = useState(0);
		const [cuePlayback, setCuePlayback] = useState(null);
		const [facing, setFacing] = useState("left");
		const [tipOn, setTipOn] = useState(false);
		const [customPos, setCustomPos] = useState(null);
		const [size, setSize] = useState(init.size);
		const [corner, setCorner] = useState(init.corner);
		const [margin, setMargin] = useState(init.margin);
		const animRef = useRef(anim);
		animRef.current = anim;
		const facingRef = useRef(facing);
		facingRef.current = facing;
		const customPosRef = useRef(customPos);
		customPosRef.current = customPos;
		const bumpSeq = () => setSeq((s) => s + 1);
		const play = (next, opts) => {
			setAnim(next);
			setOnce(opts?.once ?? true);
			if (opts?.replay) bumpSeq();
			if (opts?.cue !== void 0) setCuePlayback(opts.cue);
		};
		return {
			actions: {
				bumpSeq,
				play,
				setAnim,
				setCorner,
				setCuePlayback,
				setCustomPos,
				setFacing,
				setMargin,
				setOnce,
				setSize,
				setTipOn
			},
			animRef,
			customPosRef,
			facingRef,
			state: {
				anim,
				corner,
				cuePlayback,
				customPos,
				facing,
				margin,
				once,
				seq,
				size,
				tipOn
			}
		};
	};
}

//#endregion
//#region src/client/pet/card/cue-effects.ts
/** 日志行的时刻前缀。 */
const stamp = () => new Date().toTimeString().slice(0, 8);
/** 一行带时刻的日志：客户端统一前缀，便于 grep。 */
const log = (message) => {
	console.log("[dsh-pet] " + stamp() + " " + message);
};
function createCueEffects(rt) {
	const { useEffect, useRef } = rt;
	return function useCueEffects(hub, props) {
		const { balance, balanceManual, balanceNoticeTick, balanceTick } = props;
		const { animCue, animCueTick, posCue, posCueTick, say, sayTick, throwCue, throwCueTick } = props;
		const { workStatus, workStatusTick } = props;
		const prevBalanceRef = useRef(0);
		const prevNoticeRef = useRef(0);
		const prevWorkRef = useRef(0);
		const prevWorkStateRef = useRef(void 0);
		const prevSayRef = useRef(0);
		const prevAnimRef = useRef(0);
		const prevPosRef = useRef(0);
		const prevThrowRef = useRef(0);
		/** 余额事件：按档位播事件动画并弹气泡。手动请求无条件弹，自动轮询要求开启且有百分比；
		*  睡着时自动来源整拍丢弃，否则会顶掉睡姿。 */
		const consumeBalance = () => {
			const cfg = hub.cfg();
			const card = hub.card;
			if (balanceTick === 0 || balanceTick === prevBalanceRef.current) return;
			prevBalanceRef.current = balanceTick;
			if (hub.ownAnim.isFrozen() && !balanceManual) return;
			if (hub.sleeping()) return;
			if (!balance || !balance.ok) return;
			if (!cfg.balanceEnabled && !balanceManual) return;
			const percent = balancePercent(balance);
			if (balanceManual || percent !== void 0 || balance.shape === "custom") hub.bubbles.showBalance();
			if (!cfg.balanceEnabled) return;
			if (percent === void 0) return;
			const pool = hub.anims().events?.balance;
			if (!pool || pool.length === 0) {
				console.error("[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画");
				return;
			}
			const idx = balanceEventIndex(percent);
			const slot = pool[idx];
			if (!slot) {
				console.error("[dsh-pet] balance 档位索引越界：p=" + percent + " idx=" + idx);
				return;
			}
			const name = pickSlot(slot, card.animRef.current);
			log("balance pet=" + cfg.id + " p=" + percent.toFixed(1) + "% -> [档" + idx + "] " + name);
			hub.stopMotion();
			card.actions.setOnce(true);
			card.actions.setAnim(name);
		};
		/** 余额不可用：容器递增计数，本宠物只弹文字说明，不播档位动画。 */
		const consumeBalanceNotice = () => {
			const cfg = hub.cfg();
			if (!cfg.balanceEnabled && !balanceManual) return;
			if (balanceNoticeTick === 0 || balanceNoticeTick === prevNoticeRef.current) return;
			prevNoticeRef.current = balanceNoticeTick;
			if (hub.ownAnim.isFrozen() && !balanceManual) return;
			if (hub.sleeping()) return;
			if (!balance || balance.ok) return;
			hub.bubbles.showBalance();
		};
		/** 工作状态联动：按档位播动画并弹文本气泡；回空闲时收起气泡并改播完即停。 */
		const consumeWorkStatus = () => {
			const cfg = hub.cfg();
			const card = hub.card;
			if (!cfg.workStatusEnabled) return;
			if (workStatusTick === 0 || workStatusTick === prevWorkRef.current) return;
			prevWorkRef.current = workStatusTick;
			if (hub.ownAnim.isFrozen()) return;
			if (hub.sleeping()) return;
			if (!workStatus || workStatus.state === null) {
				log("pet=" + cfg.id + " " + (prevWorkStateRef.current ?? "null") + "->null    播完即停（回待机，收起气泡）");
				prevWorkStateRef.current = null;
				if (poolIncludes(hub.anims().events?.workStatus ?? [], card.animRef.current)) hub.ownAnim.stopLoopingFront();
				hub.bubbles.resetWork();
				return;
			}
			const pool = hub.anims().events?.workStatus;
			if (!pool || pool.length === 0) {
				console.error("[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画");
				return;
			}
			const idx = WORK_STATUS_INDEX[workStatus.state];
			const slot = pool[idx];
			if (slot === void 0) {
				console.error("[dsh-pet] work-status 档位索引越界：state=" + workStatus.state + " idx=" + idx);
				return;
			}
			const name = pickSlot(slot, card.animRef.current);
			log("pet=" + cfg.id + " " + (prevWorkStateRef.current ?? "null") + "->" + workStatus.state + "    " + name);
			const stateChanged = prevWorkStateRef.current !== workStatus.state;
			prevWorkStateRef.current = workStatus.state;
			hub.stopMotion();
			const textGroup = Array.isArray(cfg.workStatusTexts) ? cfg.workStatusTexts[idx] : void 0;
			const configuredText = Array.isArray(textGroup) && textGroup.length > 0 ? textGroup[Math.floor(Math.random() * textGroup.length)] : void 0;
			hub.bubbles.updateWorkText(workStatus.task ?? configuredText ?? null, progressLabel(workStatus), {
				percent: todoPercent(workStatus),
				label: todoProgressLabel(workStatus)
			});
			const terminal = workStatus.state === "success" || workStatus.state === "error";
			if (stateChanged) hub.bubbles.lightWork(terminal);
			const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
			card.actions.setOnce(terminal || rotating);
			card.actions.setAnim(name);
		};
		/** 说话（碎碎念、命令气泡、对话回复、清空）：序号变化即执行清空或弹气泡。 */
		const consumeSay = () => {
			if (!say || say.seq === prevSayRef.current) return;
			prevSayRef.current = say.seq;
			if (say.kind === "clear") {
				hub.bubbles.clearWhisper();
				return;
			}
			hub.speak(say.text, say.image, say.url, say.duration, say.anim);
			playSayVoice(say);
		};
		/** 点播动画：url 插播一段，名称走菜单同一套动作。 */
		const consumeAnimCue = () => {
			const card = hub.card;
			if (!animCue || animCue.seq === prevAnimRef.current) return;
			prevAnimRef.current = animCue.seq;
			const explicitFacing = animCue.facing !== void 0;
			if (animCue.facing !== void 0) {
				card.actions.setFacing(animCue.facing);
				card.facingRef.current = animCue.facing;
			}
			if (animCue.url !== void 0) {
				hub.stopMotion();
				hub.ownAnim.setCueUrl(animCue.url);
				card.actions.setOnce(true);
				card.actions.bumpSeq();
				card.actions.setAnim(animCue.url);
				card.actions.setCuePlayback(animCue.playbackId ?? null);
				return;
			}
			if (animCue.name === void 0) return;
			hub.playByName(animCue.name, animCue.playbackId, explicitFacing);
		};
		/** 位置指令：交给位置跟随；用户正按着宠物时由驱动整拍丢弃。 */
		const consumePosCue = () => {
			if (!posCue || posCue.seq === prevPosRef.current) return;
			prevPosRef.current = posCue.seq;
			hub.posFollow.apply(posCue.x, posCue.y, posCue.mode, posCue.duration);
		};
		/** 抛掷指令：交给抛掷驱动。 */
		const consumeThrowCue = () => {
			if (!throwCue || throwCue.seq === prevThrowRef.current) return;
			prevThrowRef.current = throwCue.seq;
			hub.applyThrow(throwCue.angle, throwCue.power);
		};
		useEffect(() => {
			consumeBalance();
			consumeBalanceNotice();
			consumeWorkStatus();
			consumeSay();
			consumeAnimCue();
			consumePosCue();
			consumeThrowCue();
		}, [
			balanceTick,
			balanceNoticeTick,
			workStatusTick,
			sayTick,
			animCueTick,
			posCueTick,
			throwCueTick
		]);
	};
}

//#endregion
//#region src/client/pet/card/lock-freeze.ts
function freezeDeadline(lock, nowMs) {
	const expiresAt = lock?.locked === true ? lock.expiresAt : 0;
	return expiresAt > nowMs ? expiresAt : 0;
}
/** 执行一次翻转；cue 为 null 表示状态本来就是这个值。 */
function dispatchCue(cue, handlers) {
	if (cue === null) return;
	if (cue.kind === "frozen") handlers.onFrozen();
	else handlers.onResumed();
}
function createLockFreeze(rt) {
	const { useEffect, useRef } = rt;
	return function useLockFreeze(input) {
		/** 解冻定时器；重算与本地解冻前都必须清掉，否则旧定时器会提前解冻。 */
		const timerRef = useRef(null);
		/** 清掉解冻定时器；重复调用安全。 */
		const clearTimer = () => {
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
		useEffect(() => {
			clearTimer();
			const now = Date.now();
			const expiresAt = freezeDeadline(input.lock, now);
			dispatchCue(input.setFrozen(expiresAt > now), input);
			if (expiresAt <= now) return clearTimer;
			timerRef.current = window.setTimeout(() => {
				timerRef.current = null;
				dispatchCue(input.setFrozen(false), input);
			}, expiresAt - now);
			return clearTimer;
		}, [input.lockTick, input.lock]);
		return { release: () => {
			clearTimer();
			dispatchCue(input.setFrozen(false), input);
		} };
	};
}

//#endregion
//#region src/client/pet/card/runtime.ts
function createCardRuntime(rt) {
	const { h, useEffect, useRef, useState } = rt;
	/** 余额气泡：数据与显隐由装配根传入。 */
	const BalanceBubble = makeBalanceBubble({
		h,
		useState,
		useEffect
	});
	/** 碎碎念气泡：文本与显隐由装配根传入。 */
	const WhisperBubble = makeWhisperBubble({ h });
	/** 待办气泡：面板本体挂在自己身上，关闭按钮回调装配根。 */
	const TodoBubble = makeTodoBubble({
		h,
		useEffect,
		useRef
	});
	/** 审批 / 提问气泡：同一个组件按 kind 分成两套渲染，点按钮直接 POST 回宿主。 */
	const ApprovalBubble = makeApprovalBubble({
		h,
		useState,
		useEffect
	});
	const QuestionBubble = makeQuestionBubble({
		h,
		useState,
		useEffect
	});
	/** 定时提醒气泡。 */
	const ReminderBubble = makeReminderBubble({
		h,
		useState,
		useEffect
	});
	/** 折叠台账气泡：只读快照，清空与跳会话都走宿主。 */
	const HistoryBubble = makeHistoryBubble({
		h,
		useState
	});
	/** 选择器：审批与提问的 props 只差 kind，这里把两组工厂收成一个组件。 */
	const RequestBubble = (props) => props.request.kind === "approval" ? h(ApprovalBubble, {
		request: props.request,
		on: props.on
	}) : h(QuestionBubble, {
		request: props.request,
		on: props.on
	});
	/** 五种气泡的单槽：显隐、停留计时与优先级都在这里。 */
	const useBubbleSlots = createBubbleSlots({
		h,
		useState,
		useEffect,
		useRef
	}, {
		balanceBubble: BalanceBubble,
		todoBubble: TodoBubble,
		whisperBubble: WhisperBubble,
		requestBubble: RequestBubble,
		reminderBubble: ReminderBubble,
		historyBubble: HistoryBubble
	});
	const useCardState = createCardState({
		useState,
		useRef
	});
	const useLockFreeze = createLockFreeze({
		useEffect,
		useRef
	});
	const useCueEffects = createCueEffects({
		useEffect,
		useRef
	});
	const useAnimationFlow = createAnimationFlow({ useRef });
	const useCardAnimation = createCardAnimation({
		useEffect,
		useRef
	});
	const useCardMotion = createCardMotion({
		useEffect,
		useRef
	});
	const useCardDrag = createCardDrag({
		useRef,
		useEffect
	});
	const useCardEntry = createCardEntry({
		useEffect,
		useRef
	});
	return function useCardRuntime(props) {
		const { arena, balance, balanceManual, cfg, lock, lockTick, menuItemsRef, sleep: sleep$1, sleepTick, workStatus } = props;
		const { onFocusSession } = props;
		const effectiveSizePx = resolvePetSizePx(cfg.size, cfg.sizePercent, window.innerWidth);
		const card = useCardState({
			anim: cfg.animations.idle[0] ?? "",
			corner: cfg.position.corner,
			margin: {
				x: cfg.position.marginX,
				y: cfg.position.marginY
			},
			size: effectiveSizePx
		});
		const { actions, state } = card;
		const { corner, customPos, facing, margin, size, tipOn } = state;
		const liveRef = useRef({});
		const menuActionsRef = useRef(null);
		const entryRef = useRef(null);
		const pendingSquashRef = useRef(false);
		const cfgRef = useRef(cfg);
		cfgRef.current = cfg;
		const workStatusRef = useRef(workStatus);
		workStatusRef.current = workStatus;
		const rootRef = useRef(null);
		const stageRef = useRef(null);
		const videoARef = useRef(null);
		const videoBRef = useRef(null);
		const tipRef = useRef(null);
		const reportPlayback = makePlaybackReporter({ petId: cfg.id });
		const { halfW, halfH, bottomPad, sideAllow } = derivePetMetrics(size);
		const fontPx = resolveFontPx(cfg.font, size);
		const petAnims = cfg.animations;
		useEffect(() => {
			actions.setSize(resolvePetSizePx(cfg.size, cfg.sizePercent, window.innerWidth));
		}, [cfg.size, cfg.sizePercent]);
		useEffect(() => {
			actions.setCorner(cfg.position.corner);
			actions.setMargin({
				x: cfg.position.marginX,
				y: cfg.position.marginY
			});
			actions.setCustomPos(null);
		}, [
			cfg.position.corner,
			cfg.position.marginX,
			cfg.position.marginY
		]);
		const bubbles = useBubbleSlots({
			assetRoot: cfg.assetRoot,
			balance,
			balanceEnabled: cfg.balanceEnabled,
			balanceManual,
			request: props.request ?? null,
			reminder: props.reminder ?? null,
			history: props.history ?? null,
			workStatusEnabled: cfg.workStatusEnabled,
			workTerminal: workStatus?.state === "success" || workStatus?.state === "error",
			workSessionId: workStatus?.sessionId ?? null,
			...onFocusSession === void 0 ? {} : { onFocusSession }
		});
		const ownAnim = useCardAnimation({
			card,
			cfgRef,
			live: liveRef,
			lock,
			pendingSquash: pendingSquashRef,
			petId: cfg.id,
			report: reportPlayback,
			setCuePlayback: actions.setCuePlayback,
			videoA: () => videoARef.current,
			videoB: () => videoBRef.current,
			workStatusRef
		});
		const motion = useCardMotion({
			arena,
			card,
			cfgRef,
			live: liveRef,
			metrics: {
				bottomPad,
				halfH,
				halfW,
				sideAllow,
				size
			},
			moves: petAnims.moves,
			petId: cfg.id,
			root: () => rootRef.current,
			setAnim: actions.setAnim,
			setCustomPos: actions.setCustomPos,
			setOnce: actions.setOnce
		});
		const drag = useCardDrag({
			bumpSeq: actions.bumpSeq,
			card,
			cfgRef,
			live: liveRef,
			motion,
			pendingSquash: pendingSquashRef,
			root: () => rootRef.current,
			setAnim: actions.setAnim,
			setCustomPos: actions.setCustomPos,
			setOnce: actions.setOnce,
			setTipOn: actions.setTipOn
		});
		const entry = useCardEntry({
			card,
			cfgRef,
			drag,
			live: liveRef,
			menuItemsRef,
			motion,
			runMenuAction: (leaf$1, playbackId, keepFacing) => menuActionsRef.current?.run(leaf$1, playbackId, keepFacing),
			showTodo: bubbles.showTodo,
			stage: () => stageRef.current,
			tipRef,
			toggleHistory: bubbles.toggleHistory,
			toggleTodo: bubbles.toggleTodo
		});
		entryRef.current = entry;
		menuActionsRef.current ?? (menuActionsRef.current = createMenuActions({
			animations: () => cfgRef.current.animations,
			applyMerged: (merged) => petBridge.reload(merged),
			faceLeft: () => actions.setFacing("left"),
			isFacingRight: () => card.facingRef.current === "right",
			openChat: () => entryRef.current?.openChat(),
			openCommand: () => entryRef.current?.openCommand(),
			openHistory: () => entryRef.current?.toggleHistory(),
			openTodo: () => entryRef.current?.openTodo(),
			petId: cfg.id,
			playOnce: (anim, playbackId) => {
				actions.setOnce(true);
				actions.setAnim(anim);
				actions.setCuePlayback(playbackId);
			},
			report: reportPlayback,
			resetPosition: () => actions.setCustomPos(null),
			say: (text) => liveRef.current.flow?.speak(text, void 0, void 0, void 0, false),
			locked: () => ownAnim.isFrozen(),
			sleepRefuseTexts: () => cfgRef.current.sleepRefuseTexts ?? [],
			sleeping: () => liveRef.current.flow?.sleeping() ?? false,
			stopMove: motion.stopMove,
			stopThrow: () => motion.flight.stop(),
			tryMove: motion.walk.tryMove,
			warn: (message) => console.warn(message)
		}));
		const menuActions = menuActionsRef.current;
		const lockFreeze = useLockFreeze({
			lock,
			lockTick,
			onFrozen: () => {
				motion.stopMove();
				bubbles.hideWork();
			},
			onResumed: () => {
				if (liveRef.current.flow?.resumeWorkStatusAnim() ?? false) return;
				if (petAnims.idle.length) {
					actions.setAnim(pick(petAnims.idle, card.animRef.current));
					actions.setOnce(true);
					actions.bumpSeq();
				}
			},
			setFrozen: ownAnim.setFrozen
		});
		liveRef.current.releaseLock = () => {
			lockFreeze.release();
			postAction(ROUTE_PATH + "/lock/release?pet=" + encodeURIComponent(cfg.id), { force: true });
		};
		const hub = {
			anims: () => cfgRef.current.animations,
			applyThrow: motion.applyThrow,
			bubbles,
			card,
			cfg: () => cfgRef.current,
			isDragging: () => drag.isActive(),
			ownAnim,
			playByName: (anim, playbackId, keepFacing) => menuActions.run({
				anim,
				label: anim
			}, playbackId, keepFacing, true),
			posFollow: motion.posFollow,
			speak: (text, image, url, duration, anim) => liveRef.current.flow?.speak(text, image, url, duration, anim),
			sleeping: () => liveRef.current.flow?.sleeping() ?? false,
			locked: () => ownAnim.isFrozen(),
			stopMotion: motion.stopMove,
			tryWalk: motion.walk.tryMove
		};
		useCueEffects(hub, props);
		const flow = useAnimationFlow(hub, workStatus);
		liveRef.current.flow = flow;
		useEffect(() => {
			if (sleep$1) flow.applySleep(sleep$1);
		}, [sleepTick]);
		const stageStyle = petStageStyle(bottomPad);
		const rootStyle = petRootStyle(customPos, {
			width: window.innerWidth,
			height: window.innerHeight
		}, {
			h: halfH,
			w: halfW
		});
		return {
			bubble: bubbles.node(),
			corner,
			facing,
			fontBubblePx: fontPx.bubble,
			fontTipPx: fontPx.tip,
			marginX: margin.x,
			marginY: margin.y,
			name: cfg.name,
			onClick: () => {
				if (drag.justDragged() || drag.isActive()) return;
				const phase = liveRef.current.flow?.sleepPhase() ?? null;
				if (phase !== null && phase !== "start") {
					const front = ownAnim.frontVideo();
					if (front) liveRef.current.squash.start(front);
					playClickSound();
					postAction(ROUTE_PATH + "/wake?pet=" + encodeURIComponent(cfg.id));
					return;
				}
				if (phase === "start") postAction(ROUTE_PATH + "/wake?pet=" + encodeURIComponent(cfg.id));
				postAction(ROUTE_PATH + "/pat?pet=" + encodeURIComponent(cfg.id)).catch(() => void 0);
				const busy = workStatusRef.current?.state;
				if (busy === "thinking" || busy === "working" || busy === "result" || busy === "waiting") return;
				drag.onClick();
			},
			onContextMenu: entry.handleContextMenu,
			onDoubleClick: () => {
				const order = [
					"top-left",
					"top-right",
					"bottom-right",
					"bottom-left"
				];
				const next = order[(order.indexOf(corner) + 1) % order.length] ?? "bottom-right";
				actions.setCustomPos(null);
				actions.setCorner(next);
				postAction(ROUTE_PATH + "/corner", {
					pet: cfg.id,
					corner: next
				}).catch(() => void 0);
			},
			onPointerDown: drag.onPointerDown,
			onPointerEnter: entry.onPointerEnter,
			onPointerLeave: entry.onPointerLeave,
			onPointerMove: drag.onPointerMove,
			onPointerUp: drag.onPointerUp,
			rootRef,
			rootStyle,
			size,
			stageRef,
			stageStyle,
			tipOn,
			tipRef,
			videoARef,
			videoBRef
		};
	};
}

//#endregion
//#region src/client/pet/card/pet-card.ts
function createPetCard(rt) {
	const { h } = rt;
	/** 宠物卡的 DOM 结构：只拼装，不持有状态。 */
	const CardView = makeCardView({ h });
	const useCardRuntime = createCardRuntime(rt);
	/** 单个宠物实例，配置由容器传入。 */
	function PetCard(props) {
		return h(CardView, useCardRuntime(props));
	}
	return PetCard;
}

//#endregion
//#region src/shared/focus-session.ts
const FOCUS_REPLAY_WINDOW_MS = 1e4;
function readFocusSession(raw, now, lastTs) {
	if (!raw || typeof raw !== "object") return null;
	const { sessionId, ts } = raw;
	if (typeof sessionId !== "string" || sessionId === "") return null;
	if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
	if (ts <= lastTs) return null;
	if (now - ts > FOCUS_REPLAY_WINDOW_MS) return null;
	return {
		sessionId,
		ts
	};
}

//#endregion
//#region src/shared/request.ts
function readHistory(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	const raw = Array.isArray(d.entries) ? d.entries : [];
	const entries = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const e = item;
		if (typeof e.id !== "string" || e.id === "") continue;
		if (e.kind !== "schedule" && e.kind !== "announce" && e.kind !== "chat" && e.kind !== "todo") continue;
		if (typeof e.title !== "string" || e.title.trim() === "") continue;
		const lines = labelsOf(e.lines);
		entries.push({
			id: e.id,
			kind: e.kind,
			ts: typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : Date.now(),
			title: e.title,
			lines: lines.length > 0 ? lines : void 0,
			prompt: typeof e.prompt === "string" && e.prompt.trim() !== "" ? e.prompt : void 0,
			sessionId: typeof e.sessionId === "string" && e.sessionId.trim() !== "" ? e.sessionId : void 0
		});
	}
	const count = typeof d.count === "number" && Number.isFinite(d.count) && d.count >= 0 ? Math.floor(d.count) : entries.length;
	return {
		count,
		entries
	};
}
/** 从字符串数组里挑出非空字符串。 */
function labelsOf(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) if (typeof item === "string" && item.trim() !== "") out.push(item);
	return out;
}
function readRequest(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.closed === true) return null;
	if (typeof d.id !== "string" || d.id === "") return null;
	if (d.kind !== "approval" && d.kind !== "question") return null;
	if (typeof d.ts !== "number" || !Number.isFinite(d.ts)) return null;
	const expiresAt = typeof d.expiresAt === "number" && Number.isFinite(d.expiresAt) ? d.expiresAt : d.ts;
	const out = {
		id: d.id,
		kind: d.kind,
		ts: d.ts,
		expiresAt,
		...d.preview === true ? { preview: true } : {}
	};
	if (d.kind === "approval") {
		out.toolName = typeof d.toolName === "string" ? d.toolName : "";
		out.reason = typeof d.reason === "string" ? d.reason : void 0;
		return out;
	}
	const rawQuestions = Array.isArray(d.questions) ? d.questions : [];
	const questions = [];
	for (const item of rawQuestions) {
		if (!item || typeof item !== "object") continue;
		const q = item;
		if (typeof q.id !== "string" || q.id === "" || typeof q.question !== "string") continue;
		const opts = [];
		if (Array.isArray(q.options)) for (const o of q.options) {
			if (!o || typeof o !== "object") continue;
			const opt = o;
			if (typeof opt.label !== "string" || opt.label === "") continue;
			opts.push({
				label: opt.label,
				description: typeof opt.description === "string" ? opt.description : void 0
			});
		}
		questions.push({
			id: q.id,
			question: q.question,
			detail: typeof q.detail === "string" ? q.detail : void 0,
			header: typeof q.header === "string" ? q.header : void 0,
			options: opts.length > 0 ? opts : void 0,
			multiSelect: q.multiSelect === true
		});
	}
	if (questions.length === 0) return null;
	out.questions = questions;
	return out;
}
function readReminder(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (d.closed === true) return null;
	if (typeof d.id !== "string" || d.id === "") return null;
	if (d.kind !== "schedule" && d.kind !== "announce" && d.kind !== "chat" && d.kind !== "todo") return null;
	if (typeof d.title !== "string" || d.title.trim() === "") return null;
	const lines = labelsOf(d.lines);
	const actions = actionsOf(d.actions);
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
function actionsOf(value) {
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
//#region src/client/pet/state-poll.ts
/** 一个不会 resolve 的等待：单纯让出这一拍，用定时器而不是忙等。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runStatePoll(deps) {
	/** 宿主是否支持长轮询：首拍带 counter 就是支持。 */
	let longPoll = false;
	/** 上次拿到的 counter，作为长轮询的 since。 */
	let since;
	while (deps.isAlive()) {
		let state = null;
		try {
			state = await deps.fetch(longPoll && since !== void 0 ? {
				since,
				timeoutMs: deps.waitMs
			} : void 0);
		} catch {}
		if (!deps.isAlive()) return;
		if (state !== null) {
			longPoll = typeof state.counter === "number";
			if (longPoll && typeof state.counter === "number") since = state.counter;
			deps.onState(state);
		}
		if (state === null || !longPoll) await sleep(deps.fallbackMs);
	}
}

//#endregion
//#region src/client/state-service.ts
/** 最近一拍的状态；`null` = 本页还没拉到过。 */
let latest = null;
/** 订阅者：每来一拍通知一次。 */
const listeners = new Set();
function setStateSnapshot(state) {
	latest = state;
	for (const listener of listeners) try {
		listener(state);
	} catch (error) {
		console.error("[dsh-pet] 状态订阅回调出错（已忽略，不影响轮询）：", error);
	}
}
function getStateSnapshot() {
	return latest;
}
function subscribeStateSnapshot(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

//#endregion
//#region src/client/pet/multi.ts
function createPetMulti(rt, Card) {
	const { h, useState, useEffect, useRef } = rt;
	return function PetMulti() {
		const [pets, setPets] = useState([]);
		const [ready, setReady] = useState(false);
		const arenaRef = useRef({ slots: {} });
		const [balance, setBalance] = useState(null);
		const [balanceTick, setBalanceTick] = useState(0);
		const [balanceNoticeTick, setBalanceNoticeTick] = useState(0);
		const [balanceManual, setBalanceManual] = useState(false);
		const noticeKeyRef = useRef(null);
		const applyBalanceRef = useRef(() => {});
		applyBalanceRef.current = (state, explicit) => {
			setBalance(state);
			setBalanceManual(explicit);
			if (state.ok) {
				setBalanceTick((t) => t + 1);
				return;
			}
			const { show, key } = decideBalanceNotice(state, noticeKeyRef.current, explicit);
			noticeKeyRef.current = key;
			if (show) setBalanceNoticeTick((t) => t + 1);
			if (state.reason !== "unsupported") console.error("[dsh-pet] 余额查询失败 reason=" + state.reason + (state.message ? " " + state.message : ""));
		};
		const [workStatus, setWorkStatus] = useState(null);
		const [workStatusTick, setWorkStatusTick] = useState(0);
		const [request, setRequest] = useState(null);
		const [requestTick, setRequestTick] = useState(0);
		const requestRef = useRef(null);
		const [reminder, setReminder] = useState(null);
		const [reminderTick, setReminderTick] = useState(0);
		const [history, setHistory] = useState(null);
		const [historyTick, setHistoryTick] = useState(0);
		useEffect(() => {
			const family = pets[0]?.font?.family;
			if (family === void 0) return;
			document.documentElement.style.setProperty("--dsh-pet-font-family", fontStackOf(family));
		}, [pets]);
		useEffect(() => {
			let alive = true;
			/** 唯一填充点：成品聚合 → 渲染列表；条目级字段只由 flattenConfigPets 吹入。 */
			const applyMerged = (merged) => {
				const main = merged?.main;
				if (typeof main !== "object" || main === null) throw new Error("配置响应不是成品聚合（host 版本不匹配？）");
				setClickSoundEnabled(main.clickSoundEnabled === true);
				setSurface("web");
				setVoiceConfig(main.voiceName, main.voiceEnabled, main.voiceVolume);
				const flattened = flattenConfigPets(merged);
				petBridge.current = flattened;
				petBridge.template = Array.isArray(main.pets) ? main.pets[0] ?? void 0 : void 0;
				setPets(flattened);
			};
			/** 拉取成品聚合：host readAllConfig 的输出，客户端零校验零兜底。 */
			const loadMerged = async () => {
				const r = await fetch(ROUTE_PATH + "/config", { cache: "no-store" });
				if (!r.ok) throw new Error("config HTTP " + r.status);
				const body = await r.json();
				if (body.ok === false) throw new Error("config: " + String(body.reason ?? "failed"));
				return body;
			};
			(async () => {
				try {
					const merged = await loadMerged();
					if (!alive) return;
					applyMerged(merged);
					setReady(true);
				} catch (e) {
					console.error("[dsh-pet] 配置加载失败", e);
				}
			})();
			petBridge.reload = (merged) => {
				(async () => {
					try {
						const next = merged ?? await loadMerged();
						if (!alive) return;
						applyMerged(next);
					} catch (e) {
						console.error("[dsh-pet] 配置重载失败，保留当前渲染列表", e);
					}
				})();
			};
			return () => {
				alive = false;
				petBridge.reload = () => {};
			};
		}, []);
		const visiblePets = pets.filter((p) => isWebVisible(p.display));
		const [sayTick, setSayTick] = useState(0);
		const sayRef = useRef({});
		const [animCueTick, setAnimCueTick] = useState(0);
		const animCueRef = useRef({});
		const [posCueTick, setPosCueTick] = useState(0);
		const posCueRef = useRef({});
		const [throwCueTick, setThrowCueTick] = useState(0);
		const throwCueRef = useRef({});
		const [lockTick, setLockTick] = useState(0);
		const lockRef = useRef({});
		const [sleepTick, setSleepTick] = useState(0);
		const sleepRef = useRef({});
		const hiddenRef = useRef({});
		const [hiddenTick, setHiddenTick] = useState(0);
		const menuItemsRef = useRef([]);
		/** 已处理过的跳会话时刻：首拉补跳与后续增量可能指向同一条信号，靠它只跳一次。 */
		const lastFocusTsRef = useRef(0);
		useEffect(() => {
			if (!ready) return;
			let alive = true;
			let baseline = null;
			/** 跳会话是一次性信号：判重与重放窗口都在 shared 的纯函数里（见 focus-session.ts）。 */
			const applyFocusSession = (data) => {
				const cue = readFocusSession(data, Date.now(), lastFocusTsRef.current);
				if (cue === null) return;
				lastFocusTsRef.current = cue.ts;
				jumpToSession(cue.sessionId);
			};
			/** 分段叶子 → 消费端副作用；不认识的名字已被 resolveLeafPath 挡在外面。 */
			const applySection = (name, leaf$1) => {
				switch (name) {
					case "config":
						petBridge.reload();
						return;
					case "balance": {
						const hit = readBalance(leaf$1);
						if (hit) applyBalanceRef.current(hit.state, hit.manual);
						return;
					}
					case "workStatus": {
						const snap = readWorkStatus(leaf$1);
						if (snap) {
							setWorkStatus(snap);
							setWorkStatusTick((t) => t + 1);
						}
						return;
					}
					case "notify":
						notifyFromFrame(leaf$1.data);
						return;
					case "request": {
						const hit = readRequest(leaf$1);
						const fresh = hit !== null && hit.id !== requestRef.current?.id;
						requestRef.current = hit;
						setRequest(hit);
						if (hit !== null) {
							setRequestTick((t) => t + 1);
							if (fresh) playAttentionSound();
						}
						return;
					}
					case "reminder": {
						const hit = readReminder(leaf$1);
						setReminder(hit);
						if (hit !== null) {
							setReminderTick((t) => t + 1);
							playClickSound();
						}
						return;
					}
					case "history": {
						setHistory(readHistory(leaf$1));
						setHistoryTick((t) => t + 1);
						return;
					}
					case "menu":
						menuItemsRef.current = readMenuItems(leaf$1.data, "web");
						setMenuItems(menuItemsRef.current);
						return;
					case "focusSession":
						applyFocusSession(leaf$1.data);
						return;
				}
			};
			/** 宠物叶子 → 该宠物的指令槽；序号自增，卡片据此知道「又写了一次」。 */
			const applyPetLeaf = (name, petId, leaf$1) => {
				switch (name) {
					case "say": {
						const said = readSay(leaf$1);
						if (!said) return;
						sayRef.current[petId] = {
							...said,
							seq: (sayRef.current[petId]?.seq ?? 0) + 1
						};
						setSayTick((t) => t + 1);
						return;
					}
					case "anim": {
						const hit = readAnim(leaf$1);
						if (!hit) return;
						animCueRef.current[petId] = {
							name: hit.name,
							url: hit.url,
							playbackId: hit.playbackId,
							facing: hit.facing,
							seq: (animCueRef.current[petId]?.seq ?? 0) + 1
						};
						setAnimCueTick((t) => t + 1);
						return;
					}
					case "position": {
						const hit = readPosition(leaf$1);
						if (!hit) return;
						posCueRef.current[petId] = {
							...hit,
							seq: (posCueRef.current[petId]?.seq ?? 0) + 1
						};
						setPosCueTick((t) => t + 1);
						return;
					}
					case "throw": {
						const hit = readThrow(leaf$1);
						if (!hit) return;
						throwCueRef.current[petId] = {
							...hit,
							seq: (throwCueRef.current[petId]?.seq ?? 0) + 1
						};
						setThrowCueTick((t) => t + 1);
						return;
					}
					case "lock": {
						const hit = readLock(leaf$1);
						if (!hit) return;
						lockRef.current[petId] = hit;
						setLockTick((t) => t + 1);
						return;
					}
					case "hidden": {
						const hit = readHidden(leaf$1);
						if (!hit) return;
						if (hit.hidden) hiddenRef.current[petId] = hit.until;
						else delete hiddenRef.current[petId];
						setHiddenTick((t) => t + 1);
						return;
					}
					case "sleep": {
						const hit = readSleep(leaf$1);
						if (!hit) return;
						sleepRef.current[petId] = hit;
						setSleepTick((t) => t + 1);
						return;
					}
				}
			};
			/** 应用一份轮询状态：首拉只记基线，之后按 counter 变化逐个分发。 */
			const applyState = (s) => {
				setStateSnapshot(s);
				if (baseline === null) {
					baseline = flattenCounters(s);
					applyFocusSession(s.sections.focusSession?.data);
					menuItemsRef.current = readMenuItems(s.sections.menu?.data, "web");
					setMenuItems(menuItemsRef.current);
					requestRef.current = readRequest(s.sections.request);
					setRequest(requestRef.current);
					setReminder(readReminder(s.sections.reminder));
					setHistory(readHistory(s.sections.history));
					for (const [petId, entry] of Object.entries(s.pets)) {
						const hit = entry?.sleep?.data == null ? null : readSleep(entry.sleep);
						if (hit) sleepRef.current[petId] = hit;
						const hid = entry?.hidden?.data == null ? null : readHidden(entry.hidden);
						if (hid?.hidden) hiddenRef.current[petId] = hid.until;
					}
					setSleepTick((t) => t + 1);
					return;
				}
				for (const { path, leaf: leaf$1 } of takeChanged(s, baseline)) {
					if (leaf$1.data === null) continue;
					const target = resolveLeafPath(path);
					if (target === null) continue;
					if (target.where === "section") applySection(target.name, leaf$1);
					else applyPetLeaf(target.name, target.petId, leaf$1);
				}
			};
			runStatePoll({
				fetch: (options) => fetchState(void 0, options === void 0 ? void 0 : {
					since: options.since,
					timeoutMs: options.timeoutMs
				}),
				onState: applyState,
				waitMs: STATE_WAIT_MS,
				fallbackMs: STATE_FALLBACK_MS,
				isAlive: () => alive
			});
			return () => {
				alive = false;
			};
		}, [ready]);
		useEffect(() => {
			const pending = Object.values(hiddenRef.current).filter((until) => Number.isFinite(until));
			if (pending.length === 0) return;
			const soonest = Math.min(...pending);
			const timer = setTimeout(() => {
				const now = Date.now();
				for (const [petId, until] of Object.entries(hiddenRef.current)) if (until <= now) delete hiddenRef.current[petId];
				setHiddenTick((t) => t + 1);
			}, Math.max(0, soonest - Date.now()) + 50);
			return () => clearTimeout(timer);
		}, [hiddenTick]);
		const shownPets = visiblePets.filter((p) => !(hiddenRef.current[p.id] > Date.now()));
		return ready ? shownPets.map((p) => h(Card, {
			key: p.id,
			cfg: p,
			balance,
			balanceTick,
			balanceNoticeTick,
			balanceManual,
			workStatus,
			workStatusTick,
			request,
			requestTick,
			reminder,
			reminderTick,
			history,
			historyTick,
			onFocusSession: jumpToSession,
			say: sayRef.current[p.id],
			sayTick,
			animCue: animCueRef.current[p.id],
			animCueTick,
			posCue: posCueRef.current[p.id],
			posCueTick,
			throwCue: throwCueRef.current[p.id],
			throwCueTick,
			lock: lockRef.current[p.id],
			lockTick,
			sleep: sleepRef.current[p.id],
			sleepTick,
			menuItemsRef,
			arena: arenaRef
		})) : null;
	};
}

//#endregion
//#region src/client/pet.ts
function makePetUI(rt) {
	injectPetCss();
	const PetCard = createPetCard(rt);
	const PetMulti = createPetMulti(rt, PetCard);
	return PetMulti;
}

//#endregion
//#region src/client/command-faces.ts
function installCommandFaces(commandUi, faces) {
	const original = commandUi.candidates;
	if (typeof original !== "function") {
		console.warn("[dsh-pet] 命令图标不可用：commandUi.candidates 缺失（命令本身仍可用，只是没有图标）");
		return () => {};
	}
	const patched = async (session, req) => {
		const rows = await original.call(commandUi, session, req);
		try {
			if (!Array.isArray(rows)) return rows;
			return rows.map((raw) => {
				if (raw === null || typeof raw !== "object") return raw;
				const row = raw;
				const face = faces.get(typeof row.name === "string" ? row.name : "");
				if (face === void 0 || row.icon !== void 0) return row;
				return {
					...row,
					label: face.label(),
					icon: face.icon
				};
			});
		} catch (error) {
			console.warn("[dsh-pet] 命令图标补丁异常，本次退回原始菜单行：" + (error instanceof Error ? error.message : String(error)));
			return rows;
		}
	};
	commandUi.candidates = patched;
	return () => {
		if (commandUi.candidates === patched) commandUi.candidates = original;
	};
}

//#endregion
//#region src/client/nav-icon.ts
/**
* 设置面板导航图标补丁：把「桌宠配置」那一行的兜底齿轮换成指定图标。
* DSH 的导航图标按分区 id 硬编码白名单，且私有、外部拿不到引用，只能在 DOM 层做。
* 只打 `data-*` 标记并用 `::before` + mask 画字形，不动 DOM 结构，否则 React 会对被替换的节点 removeChild 崩。
* mask 是 data URI，即独立图像文档：宿主 0.2.2 起图标改成 sprite 引用（`<use>` 指向页面里的 `<symbol>`），
* 必须先展开成自包含 SVG，否则 mask 全透明、齿轮又被盖住，那一行直接变成零图标。
* sprite 由宿主在挂载后才注入，装配这一刻取不到，所以字形推迟到认出面板时才解析。
* 认行只能靠标题文本：投影到 DOM 的只有 label，而 account 行条件出现、位置会漂，不能用 `:nth-child`。
* 降级：缺 document / MutationObserver、取不到字形时不装（齿轮留着），认不出那一行时什么都不做，只告警。
* @module dsh-pet/src/client/nav-icon
*/
/** 注入的样式表去重标记（与宠物页面 / 设置页同一套 `data-plugin-css` 约定）。 */
const STYLE_TAG = "dsh-pet/nav-icon.css";
/** 打在目标行 `<button>` 上的标记属性：React 从不 diff 它，重渲染 / 切语言都不会掉。 */
const MARK = "data-dsh-pet-nav";
/** 设置面板根节点：shell 用 `createPortal` 挂到 body 上。 */
const PANEL_SELECTOR = "[data-shortcut-modal=\"settings\"]";
/**
* 类名来自 CSS Modules，哈希前缀会随 DSH 构建变，只匹配 `navList` / `navCell` / `navLabel` 这些名字部分。
*/
const LIST_SELECTOR = "[class*=\"navList\"]";
const CELL_SELECTOR = "[class*=\"navCell\"]";
const LABEL_SELECTOR = "[class*=\"navLabel\"]";
function svgMaskUri(svg) {
	const source = svg.trim();
	if (source === "") return "";
	const namespaced = /<svg[^>]*\sxmlns=/i.test(source) ? source : source.replace(/<svg\b/i, "<svg xmlns=\"http://www.w3.org/2000/svg\"");
	return "url(\"data:image/svg+xml," + encodeURIComponent(namespaced.split("currentColor").join("#000")) + "\")";
}
function expandUseRefs(svg, lookup) {
	const ref = /<use\b[^>]*\s(?:xlink:)?href="#([^"]+)"/i.exec(svg);
	if (ref === null) return svg;
	const symbol = lookup(ref[1]);
	if (symbol === void 0) return void 0;
	const attrs = Object.entries(symbol.attrs).map(([name, value]) => " " + name + "=\"" + value + "\"").join("");
	return "<svg xmlns=\"http://www.w3.org/2000/svg\"" + attrs + ">" + symbol.content + "</svg>";
}
function symbolIn(find) {
	return (id) => {
		const symbol = find(id);
		if (symbol === null) return void 0;
		const attrs = {};
		for (let index = 0; index < symbol.attributes.length; index += 1) {
			const attr = symbol.attributes.item(index);
			if (attr === null || attr.name === "id") continue;
			attrs[attr.name] = attr.value;
		}
		return {
			attrs,
			content: symbol.innerHTML
		};
	};
}
/** 换字形用的 CSS：盖住齿轮，用 `::before` + mask 画上我们的图标。 */
function cssFor(glyph) {
	return [
		"/* 「桌宠配置」行的导航图标：盖住齿轮，换成本模块的图形 */",
		"[" + MARK + "] [class*=\"navIcon\"]{display:none}",
		"[" + MARK + "]::before{content:\"\";flex:none;width:16px;height:16px;background-color:currentColor;-webkit-mask:" + glyph + " center/16px 16px no-repeat;mask:" + glyph + " center/16px 16px no-repeat}"
	].join("\n");
}
/** 注入样式表（只注入一次）。 */
function injectCss(doc, glyph) {
	if (doc.querySelector("style[data-plugin-css=\"" + STYLE_TAG + "\"]") !== null) return;
	const tag = doc.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = STYLE_TAG;
	tag.textContent = cssFor(glyph);
	doc.head.appendChild(tag);
}
/** 异常 → 单行文案（告警用）。 */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
function installSectionNavIcon(target) {
	const doc = typeof document === "undefined" ? void 0 : document;
	const Observer = typeof MutationObserver === "undefined" ? void 0 : MutationObserver;
	if (doc === void 0 || Observer === void 0 || doc.body === null) {
		console.warn("[dsh-pet] 设置页导航图标不可用：缺少 document / body / MutationObserver（齿轮照旧）");
		return () => {};
	}
	let injected = false;
	let warnedGlyph = false;
	/** 告警只报一次：面板反复开关会反复走到同一条失败路径。 */
	const warnGlyph = (reason) => {
		if (warnedGlyph) return;
		warnedGlyph = true;
		console.warn("[dsh-pet] 设置页导航图标不可用：" + reason + "（齿轮照旧）");
	};
	/** 解析并注入换字形样式；成功一次后不再重算，失败时留待面板下次出现再试。 */
	const ensureCss = () => {
		if (injected) return;
		let glyph;
		try {
			const expanded = expandUseRefs(target.renderSvg(), symbolIn((id) => doc.getElementById(id)));
			if (expanded === void 0) {
				warnGlyph("sprite 里找不到引用的 <symbol>");
				return;
			}
			glyph = svgMaskUri(expanded);
		} catch (error) {
			warnGlyph("图标渲染失败：" + describe(error));
			return;
		}
		if (glyph === "") {
			warnGlyph("图标渲成了空 SVG");
			return;
		}
		injectCss(doc, glyph);
		injected = true;
	};
	let warned = false;
	/** 给面板里标题匹配的那一行打标记（幂等；已打过的不再读标题）。 */
	const markPanel = (panel) => {
		try {
			const wanted = target.label();
			if (wanted === "") return;
			const list = panel.querySelector(LIST_SELECTOR);
			if (list === null) return;
			for (const cell of list.querySelectorAll(CELL_SELECTOR)) {
				if (cell.getAttribute(MARK) !== null) continue;
				if (cell.querySelector(LABEL_SELECTOR)?.textContent === wanted) cell.setAttribute(MARK, "");
			}
		} catch (error) {
			if (!warned) {
				warned = true;
				console.warn("[dsh-pet] 设置页导航图标补丁异常，本次跳过（齿轮照旧）：" + describe(error));
			}
		}
	};
	let watched;
	let panelObserver;
	const sync = () => {
		const panel = doc.querySelector(PANEL_SELECTOR);
		if (panel === null) {
			panelObserver?.disconnect();
			panelObserver = void 0;
			watched = void 0;
			return;
		}
		markPanel(panel);
		if (panel === watched) return;
		ensureCss();
		panelObserver?.disconnect();
		watched = panel;
		panelObserver = new Observer(() => {
			markPanel(panel);
		});
		panelObserver.observe(panel, {
			childList: true,
			subtree: true
		});
	};
	sync();
	const bodyObserver = new Observer(sync);
	bodyObserver.observe(doc.body, { childList: true });
	return () => {
		bodyObserver.disconnect();
		panelObserver?.disconnect();
	};
}

//#endregion
//#region src/client/chat/api.ts
/** 校验并收窄一条图片引用；形状不对返回 undefined（旧记录没有这个字段）。 */
function imageRefOf(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const ref = raw;
	if (typeof ref.attachmentId !== "string" || ref.attachmentId === "") return void 0;
	const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		attachmentId: ref.attachmentId,
		mediaType: typeof ref.mediaType === "string" ? ref.mediaType : "image/png",
		bytes: num(ref.bytes),
		width: num(ref.width),
		height: num(ref.height)
	};
}
function toChatMessages(body) {
	const raw = body?.messages;
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const m = item;
		const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : void 0;
		if (role === void 0 || typeof m.content !== "string") continue;
		const image = imageRefOf(m.image);
		const meme = typeof m.meme === "string" && m.meme !== "" ? m.meme : void 0;
		const action = typeof m.action === "string" && m.action !== "" ? m.action : void 0;
		out.push({
			role,
			text: m.content,
			ts: typeof m.ts === "number" ? m.ts : 0,
			...image === void 0 ? {} : { image },
			...meme === void 0 ? {} : { meme },
			...action === void 0 ? {} : { action }
		});
	}
	return out;
}
function groupRounds(messages) {
	const rounds = [];
	for (const message of messages) {
		const last = rounds[rounds.length - 1];
		if (last !== void 0 && last.ts === message.ts && message.ts !== 0) {
			rounds[rounds.length - 1] = message.role === "user" ? {
				...last,
				user: message
			} : {
				...last,
				assistant: message
			};
			continue;
		}
		rounds.push(message.role === "user" ? {
			ts: message.ts,
			user: message
		} : {
			ts: message.ts,
			assistant: message
		});
	}
	return rounds;
}
async function playAction(petId, name) {
	return postAction(ROUTE_PATH + "/anim?pet=" + encodeURIComponent(petId) + "&surface=any", { name });
}
function attachmentUrl(ref) {
	return ROUTE_PATH + "/attachment?id=" + encodeURIComponent(ref.attachmentId);
}
function memeUrl(name, assetRoot) {
	const root = assetRoot.trim();
	const prefix = root === "" ? "" : encodeURIComponent(root) + "/";
	return ROUTE_PATH + "/pic/memes/" + prefix + encodeURIComponent(name) + ".png";
}
function personaText(own, entry) {
	if (typeof own === "string" && own.trim() !== "") return own;
	return typeof entry === "string" ? entry : "";
}
async function fetchChatConfig() {
	const res = await fetch(ROUTE_PATH + "/config", { cache: "no-store" });
	if (!res.ok) throw new Error("config HTTP " + res.status);
	const body = await res.json();
	if (body.ok === false) throw new Error("config: " + String(body.reason ?? "failed"));
	const merged = body;
	const roundsByEntry = {};
	for (const [entry, conf] of Object.entries(merged)) {
		const rounds = Number(conf?.chatMemoryRounds);
		if (Number.isFinite(rounds) && rounds >= 0) roundsByEntry[entry] = Math.floor(rounds);
	}
	const pets = flattenConfigPets(merged);
	const personaByPet = {};
	for (const pet of pets) {
		const entry = merged[pet.assetRoot ?? ""]?.whisperPrompt;
		personaByPet[pet.id] = personaText(pet.whisperPrompt, entry);
	}
	return {
		pets,
		roundsByEntry,
		personaByPet
	};
}
function memoryBoundaryIndex(totalRounds, memoryRounds) {
	if (memoryRounds === void 0 || memoryRounds <= 0) return null;
	const cut = totalRounds - memoryRounds;
	return cut > 0 ? cut : null;
}
const MEMORY_LINE_ATTR = "data-pet-chat-memory";
function roundsToRevealMemory(memoryRounds) {
	return memoryRounds > 0 ? memoryRounds + 1 : 0;
}
const HISTORY_ROUNDS = 200;
async function fetchHistory(petId) {
	const url = ROUTE_PATH + "/chat?pet=" + encodeURIComponent(petId) + "&rounds=" + HISTORY_ROUNDS;
	const res = await fetch(url, { cache: "no-store" });
	if (!res.ok) throw new Error("chat HTTP " + res.status);
	return toChatMessages(await res.json());
}
async function sendMessage(petId, text, attachment) {
	const url = ROUTE_PATH + "/chat?pet=" + encodeURIComponent(petId) + "&surface=any";
	const result = await sendChat(url, text, attachment);
	return result.ok ? { ok: true } : {
		ok: false,
		message: result.message ?? result.reason
	};
}
/** 把删除响应收窄成回执；`ts` 为空 = 清空整只。 */
async function deleteChat(petId, ts) {
	const query = ts.map((value) => "&ts=" + encodeURIComponent(String(value))).join("");
	const res = await fetch(ROUTE_PATH + "/chat?pet=" + encodeURIComponent(petId) + query, { method: "DELETE" });
	const body = await res.json().catch(() => null);
	if (body?.ok === true) return {
		ok: true,
		removed: Number(body.removed ?? 0)
	};
	const reason = typeof body?.message === "string" ? body.message : "HTTP " + res.status;
	return {
		ok: false,
		message: reason
	};
}
async function deleteRounds(petId, ts) {
	if (ts.length === 0) return {
		ok: true,
		removed: 0
	};
	return deleteChat(petId, ts);
}
async function clearHistory(petId) {
	return deleteChat(petId, []);
}
async function fetchOrphans() {
	const res = await fetch(ROUTE_PATH + "/chat/memory", { cache: "no-store" });
	if (!res.ok) throw new Error("chat/memory HTTP " + res.status);
	const body = await res.json();
	const raw = Array.isArray(body.orphans) ? body.orphans : [];
	const out = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const one = item;
		if (typeof one.petId !== "string") continue;
		out.push({
			entry: typeof one.entry === "string" ? one.entry : "",
			petId: one.petId,
			messages: typeof one.messages === "number" ? one.messages : 0,
			lastTs: typeof one.lastTs === "number" ? one.lastTs : 0
		});
	}
	return out;
}
async function clearOrphans() {
	const res = await fetch(ROUTE_PATH + "/chat/memory", { method: "DELETE" });
	const body = await res.json().catch(() => null);
	if (body?.ok === true) return {
		ok: true,
		pets: Number(body.pets ?? 0),
		messages: Number(body.messages ?? 0)
	};
	return {
		ok: false,
		message: typeof body?.message === "string" ? body.message : "HTTP " + res.status
	};
}

//#endregion
//#region src/client/chat/actions.ts
function createHistoryActions(ports) {
	/** 跑一次删除：失败只报错；成功后清勾选并以服务端为准重读。 */
	const apply = async (run) => {
		try {
			const result = await run();
			if (!result.ok) {
				ports.fail(result.message);
				return;
			}
			ports.patch({
				selected: [],
				error: ""
			});
			await ports.reload(ports.read().petId);
		} catch (error) {
			ports.fail(error);
		}
	};
	return {
		deleteSelected: () => {
			const { petId, selected } = ports.read();
			if (petId === "" || selected.length === 0) return;
			apply(() => deleteRounds(petId, selected));
		},
		clearAll: () => {
			const { petId } = ports.read();
			if (petId === "") return;
			apply(() => clearHistory(petId));
		}
	};
}
function createSendActions(ports) {
	return {
		send: () => {
			const data = ports.read();
			const text = data.draft.trim();
			if (text === "" || data.busy || data.petId === "") return;
			ports.patch({
				busy: true,
				error: ""
			});
			(async () => {
				try {
					const attachment = data.attachment === void 0 ? void 0 : {
						mediaType: data.attachment.mediaType,
						data: data.attachment.base64
					};
					const result = await sendMessage(data.petId, text, attachment);
					if (!result.ok) {
						ports.fail(result.message);
						return;
					}
					ports.patch({
						draft: "",
						attachment: void 0
					});
					await ports.reload(data.petId);
				} catch (error) {
					ports.fail(error);
				} finally {
					ports.patch({ busy: false });
				}
			})();
		},
		pickFile: (file) => {
			(async () => {
				try {
					ports.patch({
						attachment: await encodeImageFile(file),
						error: ""
					});
				} catch (error) {
					ports.fail(error);
				}
			})();
		}
	};
}
function createShellActions(deps) {
	const { ports, history, listRef, pageRounds } = deps;
	/** 清掉已删宠物残留的历史。 */
	const clearOrphans$1 = () => {
		(async () => {
			try {
				const result = await clearOrphans();
				if (!result.ok) {
					ports.fail(result.message);
					return;
				}
				ports.patch({
					orphans: [],
					error: ""
				});
			} catch (error) {
				ports.fail(error);
			}
		})();
	};
	/** 确认条点「确定」后按待办类型分发；先清 pending，避免重复触发。 */
	const confirmAsk = () => {
		const kind = ports.read().pending;
		ports.patch({ pending: null });
		if (kind === "delete-selected") history.deleteSelected();
		else if (kind === "clear-all") history.clearAll();
		else if (kind === "clear-orphans") clearOrphans$1();
	};
	/** 多放一批更早的轮；按高度差补偿滚动位置，视线不跳。 */
	const showOlder = () => {
		const el = listRef.current;
		const before = el?.scrollHeight ?? 0;
		ports.patch({ visibleRounds: ports.read().visibleRounds + pageRounds });
		if (el === null) return;
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight - before;
		});
	};
	/** 重读配置、孤儿提示与当前宠物的历史：改完对话配置不必刷新整个页面。
	*  当前宠物可能已被删（配置是重新拉的）→ 回落到第一只，否则面板会停在一只不存在的宠物上。 */
	const refresh = () => {
		(async () => {
			try {
				const [config, orphans] = await Promise.all([fetchChatConfig(), fetchOrphans().catch(() => [])]);
				const { petId } = ports.read();
				const nextPetId$1 = config.pets.some((one) => one.id === petId) ? petId : config.pets[0]?.id ?? "";
				ports.patch({
					pets: config.pets,
					roundsByEntry: config.roundsByEntry,
					personas: config.personaByPet,
					orphans,
					petId: nextPetId$1,
					avatarVersion: Date.now(),
					error: ""
				});
				await ports.reload(nextPetId$1);
			} catch (error) {
				ports.fail(error);
			}
		})();
	};
	return {
		clearOrphans: clearOrphans$1,
		ask: (kind) => ports.patch({ pending: kind }),
		cancelAsk: () => ports.patch({ pending: null }),
		confirmAsk,
		refresh,
		showOlder
	};
}

//#endregion
//#region src/client/chat/metrics.ts
const SIZE = {
	pad: 12,
	padBottom: 10,
	gap: 8,
	gapTight: 6,
	gapWide: 10,
	listGap: 20,
	avatar: 28,
	imgMaxW: 220,
	imgMaxH: 180,
	preview: 48,
	hairline: 2,
	spinner: 12,
	tabPadY: 3,
	tabPadX: 12,
	toolPadY: 2,
	toolPadX: 10,
	bubblePadY: 8,
	bubblePadX: 12,
	composerPad: 10,
	composerPadBottom: 6,
	inputMinH: 44,
	inputMaxH: 140,
	send: 34,
	pillPadY: 4,
	pill: 999,
	tipPadY: 6,
	tipPadX: 10,
	tipMaxW: 260,
	personaMaxH: 200
};
const INPUT_MAX_HEIGHT = SIZE.inputMaxH;
const px = (value) => value + "px";

//#endregion
//#region src/client/chat/effects.ts
function createChatEffects(rt) {
	const { useEffect } = rt;
	return function useChatEffects(input) {
		const { data, fail, listRef, draftRef, newestTs, patch, reload } = input;
		useEffect(() => {
			(async () => {
				try {
					const [config, orphans] = await Promise.all([fetchChatConfig(), fetchOrphans().catch(() => [])]);
					const first = config.pets[0]?.id ?? "";
					patch({
						pets: config.pets,
						roundsByEntry: config.roundsByEntry,
						personas: config.personaByPet,
						petId: first,
						orphans
					});
					await reload(first);
				} catch (error) {
					fail(error);
				} finally {
					patch({ loading: false });
				}
			})();
		}, []);
		useEffect(() => {
			const el = listRef.current;
			if (el === null) return;
			const newest = data.messages[data.messages.length - 1]?.ts ?? 0;
			if (newest === newestTs.current) return;
			newestTs.current = newest;
			el.scrollTop = el.scrollHeight;
		}, [data.messages]);
		useEffect(() => {
			const el = draftRef.current;
			if (el === null) return;
			el.style.height = "auto";
			el.style.height = Math.min(el.scrollHeight, INPUT_MAX_HEIGHT) + "px";
		}, [data.draft]);
		useEffect(() => {
			const petId = data.petId;
			if (petId === "") return;
			let last = getStateSnapshot()?.pets[petId]?.say?.counter ?? 0;
			return subscribeStateSnapshot((snapshot) => {
				const counter = snapshot.pets[petId]?.say?.counter ?? 0;
				if (counter === last) return;
				last = counter;
				reload(petId);
			});
		}, [data.petId]);
	};
}

//#endregion
//#region src/client/chat/state.ts
/** 首屏与每次「加载更早」放出的轮数。 */
const PAGE_ROUNDS = 10;
/** 初始状态：空列表 + 加载中。 */
const INITIAL = {
	pets: [],
	petId: "",
	messages: [],
	draft: "",
	attachment: void 0,
	busy: false,
	loading: true,
	error: "",
	selected: [],
	selecting: false,
	orphans: [],
	pending: null,
	visibleRounds: PAGE_ROUNDS,
	previewUrl: void 0,
	roundsByEntry: {},
	personas: {},
	personaOpen: false,
	speaking: null,
	avatarVersion: 0
};
function createPetChatState(rt) {
	const { useRef, useState } = rt;
	const useChatEffects = createChatEffects(rt);
	return function usePetChatState() {
		const [data, setData] = useState({
			...INITIAL,
			avatarVersion: Date.now()
		});
		const listRef = useRef(null);
		const draftRef = useRef(null);
		/** 输入法组合态：必须跨渲染存活，重建一次就会把「正在组合」忘掉。 */
		const imeRef = useRef(null);
		const ime = imeRef.current ?? (imeRef.current = createCompositionWatch());
		/** 已贴到底的那条消息（`ts`）：只有它变化时才自动滚到底。 */
		const newestTs = useRef(0);
		const patch = (next) => setData((prev) => ({
			...prev,
			...next
		}));
		const fail = (error) => patch({ error: error instanceof Error ? error.message : String(error) });
		/** 重读某只宠物的历史；失败只落在 error 上，不静默清空已有消息。 */
		const reload = async (petId) => {
			if (petId === "") return;
			try {
				patch({ messages: await fetchHistory(petId) });
			} catch (error) {
				fail(error);
			}
		};
		useChatEffects({
			data,
			patch,
			fail,
			reload,
			listRef,
			draftRef,
			newestTs
		});
		const ports = {
			read: () => data,
			patch,
			fail,
			reload
		};
		const history = createHistoryActions(ports);
		const shell = createShellActions({
			ports,
			history,
			listRef,
			pageRounds: PAGE_ROUNDS
		});
		const sendActions = createSendActions(ports);
		const pet = data.pets.find((one) => one.id === data.petId);
		const allRounds = groupRounds(data.messages);
		const rounds = allRounds.slice(-data.visibleRounds);
		const memoryRounds = data.roundsByEntry[pet?.assetRoot ?? ""];
		/** 分界线元素：只有它落在当前窗口里才存在。 */
		const findMemoryLine = (el) => el.querySelector("[" + MEMORY_LINE_ATTR + "]");
		return {
			...data,
			...sendActions,
			...history,
			...shell,
			rounds,
			hasOlder: allRounds.length > rounds.length,
			petName: pet?.name || "宠",
			assetRoot: pet?.assetRoot ?? "",
			memoryRounds,
			hasMemoryLine: memoryBoundaryIndex(allRounds.length, memoryRounds) !== null,
			jumpToMemory: () => {
				const el = listRef.current;
				if (el === null) return;
				const line = findMemoryLine(el);
				if (line !== null) {
					line.scrollIntoView({
						block: "center",
						behavior: "smooth"
					});
					return;
				}
				if (memoryRounds === void 0 || memoryBoundaryIndex(allRounds.length, memoryRounds) === null) return;
				patch({ visibleRounds: Math.max(data.visibleRounds, roundsToRevealMemory(memoryRounds)) });
				requestAnimationFrame(() => {
					findMemoryLine(el)?.scrollIntoView({
						block: "center",
						behavior: "smooth"
					});
				});
			},
			persona: data.personas[data.petId] ?? "",
			togglePersona: () => patch({ personaOpen: !data.personaOpen }),
			closePersona: () => patch({ personaOpen: false }),
			listRef,
			draftRef,
			pickPet: (petId) => {
				patch({
					petId,
					messages: [],
					selected: [],
					selecting: false,
					pending: null,
					visibleRounds: PAGE_ROUNDS,
					error: ""
				});
				reload(petId);
			},
			toggleSelecting: () => patch({
				selecting: !data.selecting,
				selected: []
			}),
			toggleRound: (ts) => patch({ selected: data.selected.includes(ts) ? data.selected.filter((one) => one !== ts) : [...data.selected, ts] }),
			setDraft: (draft) => patch({ draft }),
			onDraftKeyDown: (event) => {
				const isComposing = event.isComposing === true || event.nativeEvent?.isComposing === true;
				const sendKey = {
					key: event.key,
					shiftKey: event.shiftKey,
					isComposing,
					keyCode: event.keyCode,
					repeat: event.repeat
				};
				const action = decideEnter(sendKey, ime, performance.now());
				if (action === "ignore") return;
				event.preventDefault();
				if (action === "send") sendActions.send();
			},
			onDraftCompositionStart: ime.start,
			onDraftCompositionEnd: () => ime.end(performance.now()),
			speakRound: (ts, text) => {
				speakText(text, (phase) => {
					setData((prev) => {
						if (phase === "idle") return prev.speaking?.ts === ts ? {
							...prev,
							speaking: null
						} : prev;
						return {
							...prev,
							speaking: {
								ts,
								phase
							}
						};
					});
				});
			},
			playAction: (name) => {
				if (data.petId !== "") playAction(data.petId, name);
			},
			clearAttachment: () => patch({ attachment: void 0 }),
			showImage: (previewUrl) => patch({ previewUrl }),
			closeImage: () => patch({ previewUrl: void 0 })
		};
	};
}

//#endregion
//#region src/client/chat/view-node.ts
function orphansNode(h, state) {
	if (state.orphans.length === 0) return null;
	const messages = state.orphans.reduce((sum, one) => sum + one.messages, 0);
	return h("div", {
		className: "pet-chat-orphans",
		children: [
			h("span", { children: `有 ${state.orphans.length} 只已删除宠物的历史（${messages} 条）` }),
			h("span", { className: "pet-chat-composer-spacer" }),
			h("button", {
				type: "button",
				className: "pet-chat-tool",
				onClick: () => state.ask("clear-orphans"),
				children: "清理"
			})
		]
	});
}
/** 卷帘块与按钮共用的 id：`aria-controls` 要指向它。 */
const PERSONA_PANEL_ID = "pet-chat-persona";
/** 「人设」按钮：点一下展开 / 收起工具栏下方那块卷帘。 */
function personaButton(h, state) {
	return h("button", {
		type: "button",
		className: "pet-chat-tool",
		"aria-expanded": String(state.personaOpen),
		"aria-controls": PERSONA_PANEL_ID,
		onClick: () => state.togglePersona(),
		children: "人设"
	});
}
function personaNode(h, state) {
	return h("div", {
		id: PERSONA_PANEL_ID,
		className: "pet-chat-persona" + (state.personaOpen ? " is-open" : ""),
		"aria-hidden": String(!state.personaOpen),
		children: [h("div", {
			className: "pet-chat-persona-clip",
			children: [h("div", {
				className: "pet-chat-persona-body",
				children: state.persona
			})]
		})]
	});
}
function toolsNode(h, state) {
	return h("div", {
		className: "pet-chat-tools",
		children: [
			personaButton(h, state),
			h("button", {
				type: "button",
				className: "pet-chat-tool",
				"aria-pressed": String(state.selecting),
				onClick: () => state.toggleSelecting(),
				children: state.selecting ? "取消选择" : "选择"
			}),
			state.selecting ? h("button", {
				type: "button",
				className: "pet-chat-tool",
				disabled: state.selected.length === 0,
				onClick: () => state.ask("delete-selected"),
				children: state.selected.length === 0 ? "删除选中" : "删除选中 " + state.selected.length
			}) : null,
			state.memoryRounds === void 0 ? null : h("button", {
				type: "button",
				className: "pet-chat-tool",
				disabled: !state.hasMemoryLine,
				...state.hasMemoryLine ? {} : { "aria-label": "记忆线（历史还没超过记忆轮数，没有分界线）" },
				onClick: () => state.jumpToMemory(),
				children: "记忆线"
			}),
			h("button", {
				type: "button",
				className: "pet-chat-tool",
				onClick: () => state.refresh(),
				children: "刷新"
			}),
			h("button", {
				type: "button",
				className: "pet-chat-tool",
				onClick: () => state.ask("clear-all"),
				children: "清空历史"
			})
		]
	});
}
/** 待确认操作的文案：每条都说清「删什么、不可恢复」。 */
const CONFIRM_TEXT = {
	"delete-selected": "删除选中的这几轮对话？",
	"clear-all": "清空这只宠物的全部对话历史？",
	"clear-orphans": "清理已删除宠物的残留历史？"
};
function confirmNode(rt, state) {
	if (state.pending === null) return null;
	const { h, ui } = rt;
	const count = state.pending === "delete-selected" ? `（${state.selected.length} 轮）` : state.pending === "clear-orphans" ? `（${state.orphans.length} 只）` : "";
	const description = CONFIRM_TEXT[state.pending] + count + "删了找不回来。";
	if (ui === void 0) return h("div", {
		className: "pet-chat-confirm",
		role: "alertdialog",
		children: [
			h("span", { children: description }),
			h("span", { className: "pet-chat-composer-spacer" }),
			h("button", {
				type: "button",
				className: "pet-chat-danger",
				onClick: () => state.confirmAsk(),
				children: "删除"
			}),
			h("button", {
				type: "button",
				className: "pet-chat-tool",
				onClick: () => state.cancelAsk(),
				children: "取消"
			})
		]
	});
	const { Button, Modal } = ui;
	return h(Modal, {
		open: true,
		title: "删除对话历史",
		closeLabel: "关闭",
		description,
		onClose: () => state.cancelAsk(),
		footer: h("div", {
			className: "pet-chat-confirm-actions",
			children: [h(Button, {
				variant: "ghost",
				type: "button",
				onClick: () => state.cancelAsk(),
				children: "取消"
			}), h(Button, {
				variant: "primary",
				type: "button",
				onClick: () => state.confirmAsk(),
				children: "删除"
			})]
		})
	});
}
/** 待发送图片的预览条。 */
function previewNode$1(h, state) {
	if (state.attachment === void 0) return null;
	return h("div", {
		className: "pet-chat-preview",
		children: [
			h("img", {
				className: "pet-chat-preview-img",
				src: state.attachment.previewUrl,
				alt: "待发送的图片"
			}),
			h("span", {
				className: "pet-chat-preview-meta",
				children: state.attachment.width + "×" + state.attachment.height
			}),
			h("button", {
				type: "button",
				className: "pet-chat-tool",
				onClick: () => state.clearAttachment(),
				children: "移除"
			})
		]
	});
}
/** 发送键里的箭头：与 DSH 输入框一致的圆形按钮造型。 */
function sendIcon(h) {
	return h("svg", {
		viewBox: "0 0 24 24",
		width: 16,
		height: 16,
		"aria-hidden": "true",
		children: [h("path", {
			d: "M12 19V6M6 12l6-6 6 6",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		})]
	});
}
function composerNode(h, state) {
	return h("div", {
		className: "pet-chat-composer" + (state.busy ? " is-busy" : ""),
		"aria-busy": state.busy ? "true" : void 0,
		onDragEnter: markDropTarget,
		onDragLeave: unmarkDropTarget,
		onDragOver: (event) => {
			claimFileDragOver(event);
		},
		onDrop: (event) => {
			const file = claimFileDrop(event);
			if (file !== void 0) state.pickFile(file);
			unmarkDropTarget(event);
		},
		children: [
			previewNode$1(h, state),
			h("textarea", {
				className: "pet-chat-input",
				ref: state.draftRef,
				value: state.draft,
				rows: 2,
				placeholder: "说点什么…（Enter 发送，Shift+Enter 换行）",
				onChange: (event) => state.setDraft(event.target.value),
				onPaste: (event) => {
					const file = event.clipboardData?.files?.[0];
					if (file === void 0) return;
					event.preventDefault();
					state.pickFile(file);
				},
				onKeyDown: (event) => state.onDraftKeyDown(event),
				onCompositionStart: () => state.onDraftCompositionStart(),
				onCompositionEnd: () => state.onDraftCompositionEnd()
			}),
			h("div", {
				className: "pet-chat-composer-bar",
				children: [
					h("label", {
						className: "pet-chat-attach",
						title: "附一张图（也可以直接粘贴）",
						children: ["附图", h("input", {
							className: "pet-chat-file",
							type: "file",
							accept: "image/png,image/jpeg,image/webp,image/gif",
							onChange: (event) => {
								const file = event.target.files?.[0];
								if (file !== void 0) state.pickFile(file);
								event.target.value = "";
							}
						})]
					}),
					h("span", { className: "pet-chat-composer-spacer" }),
					h("button", {
						type: "button",
						className: "pet-chat-send" + (state.busy ? " is-busy" : ""),
						"aria-label": state.busy ? "生成中" : "发送",
						onClick: () => state.send(),
						disabled: state.busy,
						children: state.busy ? h("span", {
							className: "pet-chat-send-spinner",
							"aria-hidden": "true"
						}) : sendIcon(h)
					})
				]
			})
		]
	});
}

//#endregion
//#region src/client/chat/stamp.ts
/**
* 消息时间戳的展示格式。
*
* 纯函数：`now` 由调用方传入，不读时钟，便于测试。今天的消息只给时间，
* 更早的补上日期——聊天记录跨天时，光看 `08:26:46` 分不清是哪天。
* @module dsh-pet/src/client/chat/stamp
*/
/** 一天的毫秒数；只用于算「差几天」，日界按本地时区取整。 */
const DAY_MS = 24 * 60 * 60 * 1e3;
/** 两位补零。 */
const pad = (value) => String(value).padStart(2, "0");
/** 时:分:秒。 */
const clockOf = (date) => pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
/** 本地日界的时间戳（当天 00:00）。 */
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
function formatStamp(ts, now) {
	if (!Number.isFinite(ts) || ts <= 0) return "";
	const date = new Date(ts);
	const today = new Date(now);
	const days = Math.round((startOfDay(today) - startOfDay(date)) / DAY_MS);
	const clock = clockOf(date);
	if (days <= 0) return clock;
	if (days === 1) return "昨天 " + clock;
	const monthDay = date.getMonth() + 1 + "月" + date.getDate() + "日";
	if (date.getFullYear() === today.getFullYear()) return monthDay + " " + clock;
	return date.getFullYear() + "年" + monthDay + " " + clock;
}

//#endregion
//#region src/client/chat/tooltip.ts
const TIP_CLASS = "pet-chat-tip";
/** 光标与气泡的间隙（px）：与设置页的 data-tip 气泡一致，视觉上不贴手。 */
const TIP_GAP_PX = 10;
/** 唯一的那个气泡；面板里悬停很频繁，反复建删会让气泡闪，所以复用。 */
let tipEl;
/** 全局监听的解除函数；与气泡一起登记、一起回收。 */
let unwatch;
/** 收起气泡：元素留着复用，只摘 `is-on`。 */
function hideTip() {
	tipEl?.classList.remove("is-on");
}
/** 取气泡元素，没有就建一个并挂到 body（挂 body 才不会被子孙的 overflow 裁掉）。 */
function ensureTip() {
	if (tipEl !== void 0 && tipEl.parentNode === document.body) return tipEl;
	const el = document.createElement("div");
	el.setAttribute("class", TIP_CLASS);
	el.setAttribute("role", "tooltip");
	document.body.appendChild(el);
	tipEl = el;
	const win = window;
	const root = document;
	const close = () => hideTip();
	win.addEventListener("scroll", close, true);
	root.addEventListener("pointerdown", close, true);
	unwatch = () => {
		win.removeEventListener("scroll", close, true);
		root.removeEventListener("pointerdown", close, true);
		unwatch = void 0;
	};
	return el;
}
/**
* 在光标处显示气泡。
*
* @param text - 气泡正文；每次重设，同一个气泡服务所有触发元素。
* @param cursor - 光标位置（视口坐标）。
*/
function showTip(text, cursor) {
	const el = ensureTip();
	el.textContent = text;
	el.style.left = px(0);
	el.style.top = px(0);
	const placed = tooltipPlacement(cursor, {
		w: el.offsetWidth,
		h: el.offsetHeight
	}, {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	}, TIP_GAP_PX);
	el.style.left = px(placed.x);
	el.style.top = px(placed.y);
	el.classList.add("is-on");
}
function tipAttrs(text) {
	return {
		onMouseEnter: (event) => showTip(text, {
			x: event.clientX,
			y: event.clientY
		}),
		onMouseLeave: () => hideTip()
	};
}
function disposeTip() {
	unwatch?.();
	tipEl?.remove();
	tipEl = void 0;
}

//#endregion
//#region src/client/chat/view-message.ts
/** 语音播报按钮：贴在时间右边，四种状态一眼可分——可播 / 生成中转圈 / 播放中高亮 / 失败可重试。 */
function speakNode(h, text, ts, state) {
	const phase = state.speaking?.ts === ts ? state.speaking.phase : "idle";
	const label = phase === "loading" ? "正在生成语音…" : phase === "playing" ? "正在播放" : phase === "failed" ? "播放失败，点击重试" : "播放这句";
	return h("button", {
		type: "button",
		className: "pet-chat-speak is-" + phase,
		"aria-label": label,
		...tipAttrs(label),
		onClick: (event) => {
			event.stopPropagation();
			if (phase === "idle" || phase === "failed") state.speakRound(ts, text);
		},
		children: phase === "loading" ? null : phase === "failed" ? "🔇" : "🔊"
	});
}
/**
* 动作播放按钮：这一轮回答演出过动作时，贴在喇叭右边，悬浮显示动作名，点一下重演。
*
* 悬浮气泡只显示动作名本身（不加「播放动作：」这类前缀）；读屏需要的语义放在 aria-label 上。
*/
function actionNode(h, action, state) {
	return h("button", {
		type: "button",
		className: "pet-chat-action",
		"aria-label": "播放动作：" + action,
		...tipAttrs(action),
		onClick: (event) => {
			event.stopPropagation();
			state.playAction(action);
		},
		children: h("svg", {
			className: "pet-chat-action-icon",
			viewBox: "0 0 16 16",
			"aria-hidden": "true",
			children: h("path", {
				d: "M4.5 2.5v11l9-5.5z",
				fill: "currentColor"
			})
		})
	});
}
function avatarNode(h, isMe, assetRoot, version) {
	if (!isMe) return h("img", {
		className: "pet-chat-avatar",
		src: avatarUrl(assetRoot, version),
		alt: "",
		loading: "lazy"
	});
	return h("svg", {
		className: "pet-chat-avatar",
		viewBox: "0 0 32 32",
		"aria-hidden": "true",
		children: [
			h("circle", {
				cx: 16,
				cy: 16,
				r: 16,
				fill: "var(--dsw-specific-bubble)"
			}),
			h("circle", {
				cx: 16,
				cy: 17.5,
				r: 9.5,
				fill: "var(--dsw-alias-bg-layer-1)"
			}),
			h("path", {
				d: "M6.8 15.5a9.2 9.2 0 0 1 18.4 0q-4.6-4.2-9.2-4.2t-9.2 4.2z",
				fill: "var(--dsw-alias-label-tertiary)",
				opacity: .75
			}),
			h("path", {
				d: "M16 9.2q1.1-2.6 3.4-1.7",
				fill: "none",
				stroke: "var(--dsw-alias-label-tertiary)",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				opacity: .75
			}),
			h("ellipse", {
				cx: 12.4,
				cy: 17.6,
				rx: 1.5,
				ry: 2,
				fill: "var(--dsw-alias-label-primary)"
			}),
			h("ellipse", {
				cx: 19.6,
				cy: 17.6,
				rx: 1.5,
				ry: 2,
				fill: "var(--dsw-alias-label-primary)"
			}),
			h("circle", {
				cx: 12.9,
				cy: 16.8,
				r: .5,
				fill: "var(--dsw-alias-bg-layer-1)"
			}),
			h("circle", {
				cx: 20.1,
				cy: 16.8,
				r: .5,
				fill: "var(--dsw-alias-bg-layer-1)"
			}),
			h("ellipse", {
				cx: 9.6,
				cy: 21,
				rx: 1.7,
				ry: 1.1,
				fill: "var(--dsw-alias-state-error-secondary)",
				opacity: .45
			}),
			h("ellipse", {
				cx: 22.4,
				cy: 21,
				rx: 1.7,
				ry: 1.1,
				fill: "var(--dsw-alias-state-error-secondary)",
				opacity: .45
			}),
			h("path", {
				d: "M14.6 21.6q1.4 1.5 2.8 0",
				fill: "none",
				stroke: "var(--dsw-alias-label-secondary)",
				strokeWidth: 1,
				strokeLinecap: "round"
			}),
			h("path", {
				d: "M25.5 5.5v4M23.5 7.5h4",
				fill: "none",
				stroke: "var(--dsw-alias-state-business-primary)",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				opacity: .9
			})
		]
	});
}
function messageNode(h, input) {
	const { message, isMe, assetRoot, avatarVersion, onOpenImage } = input;
	const image = message.image !== void 0 ? attachmentUrl(message.image) : message.meme !== void 0 ? memeUrl(message.meme, assetRoot) : void 0;
	return h("div", {
		className: "pet-chat-msg " + (isMe ? "is-me" : "is-pet"),
		children: [avatarNode(h, isMe, assetRoot, avatarVersion), h("div", {
			className: "pet-chat-bubble",
			children: [h("div", {
				className: "pet-chat-text",
				children: message.text
			}), image === void 0 ? null : h("button", {
				type: "button",
				className: "pet-chat-img-btn",
				"aria-label": "点开看大图",
				...tipAttrs("点开看大图"),
				onClick: () => onOpenImage(image),
				children: h("img", {
					className: "pet-chat-img",
					src: image,
					alt: "对话图片",
					loading: "lazy"
				})
			})]
		})]
	});
}
function roundNode(rt, state, round) {
	const { h } = rt;
	const selected = state.selected.includes(round.ts);
	const className = "pet-chat-round" + (state.selecting ? " is-selecting" : "") + (selected ? " is-selected" : "");
	return h("div", {
		key: String(round.ts),
		className,
		onClick: state.selecting ? (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(".pet-chat-pick, button, a, [role=\"button\"]") !== null) return;
			state.toggleRound(round.ts);
		} : void 0,
		children: [state.selecting ? h("label", {
			className: "pet-chat-pick",
			title: "选中这一轮（问 + 答一起删）",
			children: [h("input", {
				type: "checkbox",
				checked: selected,
				onChange: () => state.toggleRound(round.ts),
				"aria-label": "选中这一轮"
			})]
		}) : null, h("div", {
			className: "pet-chat-round-body",
			children: [
				round.user === void 0 ? null : messageNode(h, {
					message: round.user,
					isMe: true,
					assetRoot: state.assetRoot,
					avatarVersion: state.avatarVersion,
					onOpenImage: state.showImage
				}),
				round.assistant === void 0 ? null : messageNode(h, {
					message: round.assistant,
					isMe: false,
					assetRoot: state.assetRoot,
					avatarVersion: state.avatarVersion,
					onOpenImage: state.showImage
				}),
				round.ts > 0 ? h("div", {
					className: "pet-chat-time " + (round.assistant === void 0 ? "is-me" : "is-pet"),
					children: [
						formatStamp(round.ts, Date.now()),
						round.assistant === void 0 ? null : speakNode(h, round.assistant.text, round.ts, state),
						round.assistant?.action === void 0 ? null : actionNode(h, round.assistant.action, state)
					]
				}) : null
			]
		})]
	});
}

//#endregion
//#region src/client/chat/view.ts
/** 宠物标签条：点击切换对话。 */
function tabsNode(h, state) {
	return h("div", {
		className: "pet-chat-tabs",
		children: state.pets.map((pet) => h("button", {
			key: pet.id,
			type: "button",
			className: "pet-chat-tab",
			"aria-pressed": String(pet.id === state.petId),
			onClick: () => state.pickPet(pet.id),
			children: pet.name || pet.id
		}))
	});
}
/**
* 顶部「加载更早」：与 DSH 自己的历史加载同一个位置与形态。
*
* 内存里没有更早的轮时，同一个位置换成一行说明——不然按钮消失后用户不知道是「到底了」还是「坏了」。
*/
function olderNode(h, state) {
	if (state.rounds.length === 0) return null;
	if (state.hasOlder) return h("div", {
		className: "pet-chat-older",
		children: [h("button", {
			type: "button",
			className: "pet-chat-older-btn",
			onClick: () => state.showOlder(),
			children: "加载更早"
		})]
	});
	const capped = state.rounds.length >= HISTORY_ROUNDS;
	return h("div", {
		className: "pet-chat-older",
		children: [h("span", {
			className: "pet-chat-older-note",
			children: capped ? "已经到底了（最多加载 " + HISTORY_ROUNDS + " 轮）" : "已经到底了"
		})]
	});
}
/** 记忆边界：线以下才是桌宠每次真正带进上下文的最近 N 轮。 */
function memoryLineNode(h, rounds) {
	return h("div", {
		key: "memory-line",
		className: "pet-chat-memory",
		[MEMORY_LINE_ATTR]: "true",
		children: [h("span", {
			className: "pet-chat-memory-note",
			children: `以下 ${rounds} 轮进入桌宠的记忆`
		})]
	});
}
/** 消息列表：加载更早 + 记忆边界 + 空态提示或按轮渲染。 */
function listNode(rt, state) {
	const emptyText = state.loading ? "加载中…" : state.petId === "" ? "没有可对话的桌宠" : "还没有聊过天";
	const body = state.rounds.length === 0 ? [rt.h("div", {
		key: "empty",
		className: "pet-chat-hint",
		children: emptyText
	})] : state.rounds.map((round) => roundNode(rt, state, round));
	const cut = memoryBoundaryIndex(state.rounds.length, state.memoryRounds);
	if (cut !== null && state.memoryRounds !== void 0) body.splice(cut, 0, memoryLineNode(rt.h, state.memoryRounds));
	return rt.h("div", {
		className: "pet-chat-list",
		ref: state.listRef,
		children: [olderNode(rt.h, state), ...body]
	});
}
/**
* 图片放大：直接用平台的 `ImageLightbox`——与 DSH 会话里点开图片是同一个组件，
* 全屏遮罩、Esc / 点遮罩关闭、关闭后焦点回到原处都由它负责。
*
* @returns 没有预览或拿不到 primitives 时是 null。
*/
function previewNode(rt, state) {
	if (state.previewUrl === void 0 || rt.ui === void 0) return null;
	const { ImageLightbox } = rt.ui;
	return rt.h(ImageLightbox, {
		src: state.previewUrl,
		alt: "对话图片",
		labels: {
			dialog: "图片预览",
			close: "关闭"
		},
		onClose: () => state.closeImage()
	});
}
function buildPanel(rt, state) {
	const { h } = rt;
	return h("div", {
		className: "pet-chat",
		onKeyDown: (event) => {
			if (state.personaOpen && event.key === "Escape") state.closePersona();
		},
		children: [
			tabsNode(h, state),
			orphansNode(h, state),
			toolsNode(h, state),
			personaNode(h, state),
			listNode(rt, state),
			confirmNode(rt, state),
			previewNode(rt, state),
			state.error === "" ? null : h("div", {
				className: "pet-chat-error",
				role: "alert",
				children: state.error
			}),
			composerNode(h, state)
		]
	});
}

//#endregion
//#region src/client/chat/panel.ts
function makePetChatPanel(rt) {
	const useChatState = createPetChatState(rt);
	return function PetChatPanel() {
		return buildPanel(rt, useChatState());
	};
}

//#endregion
//#region src/client/chat/panel-css.ts
const PANEL_CSS = `
.pet-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: ${px(SIZE.gapWide)};
  padding: ${px(SIZE.pad)} ${px(SIZE.pad)} ${px(SIZE.padBottom)};
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
}

.pet-chat-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: ${px(SIZE.gapTight)};
  flex: 0 0 auto;
}

.pet-chat-tab {
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: var(--dsw-radius-md);
  padding: ${px(SIZE.tabPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-tab[aria-pressed="true"] {
  background: var(--dsw-alias-bg-multi-select);
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.pet-chat-tools {
  display: flex;
  justify-content: flex-end;
  gap: ${px(SIZE.gapTight)};
  flex: 0 0 auto;
}

/* 人设卷帘：展开时把消息列表顶下去，而不是浮在对话上——人设可以很长，浮层会挡住内容。
   0fr → 1fr 是唯一不用量高度的展开过渡；夹层负责裁剪，正文层才放内边距与边框，
   否则收起时 padding 与 border 仍在，留下一道缝。 */
.pet-chat-persona {
  display: grid;
  grid-template-rows: 0fr;
  flex: 0 0 auto;
  transition: grid-template-rows var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-persona.is-open {
  grid-template-rows: 1fr;
}

.pet-chat-persona-clip {
  min-height: 0;
  overflow: hidden;
}

.pet-chat-persona-body {
  max-height: ${px(SIZE.personaMaxH)};
  overflow-y: auto;
  padding: ${px(SIZE.bubblePadY)} ${px(SIZE.bubblePadX)};
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
  line-height: 1.6;
  /* 人设正文自己带换行与缩进：保留排版，长单词与 URL 也要能断开 */
  white-space: pre-wrap;
  word-break: break-word;
}

.pet-chat-orphans {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  flex: 0 0 auto;
  padding: ${px(SIZE.gapTight)} ${px(SIZE.tabPadX)};
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-multi-select);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-confirm {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  flex: 0 0 auto;
  padding: ${px(SIZE.gapTight)} ${px(SIZE.tabPadX)};
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-danger {
  flex: 0 0 auto;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
  padding: ${px(SIZE.toolPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-danger:hover {
  background: var(--dsw-alias-state-error-secondary);
}

.pet-chat-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: ${px(SIZE.gap)};
}

/* 指南页卡片图标：框架给的槽位只按图标尺寸排版，所以让 logo 铺满它 */
.pet-chat-guide-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: var(--dsw-radius-xs);
  display: block;
}

.pet-chat-tool {
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: var(--dsw-radius-sm);
  padding: ${px(SIZE.toolPadY)} ${px(SIZE.toolPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
}

.pet-chat-tool:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-tool[aria-pressed="true"] {
  background: var(--dsw-alias-bg-multi-select);
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}

.pet-chat-tool:disabled {
  opacity: 0.5;
  cursor: default;
}

.pet-chat-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: ${px(SIZE.listGap)};
  padding-right: ${px(SIZE.hairline)};
}

.pet-chat-older {
  display: flex;
  justify-content: center;
  flex: 0 0 auto;
}

.pet-chat-older-btn {
  border: none;
  border-radius: ${px(SIZE.pill)};
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  padding: ${px(SIZE.pillPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-older-btn:hover {
  background: var(--dsw-alias-interactive-bg-active);
}

.pet-chat-older-note {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  padding: ${px(SIZE.pillPadY)} 0;
}

.pet-chat-memory {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption);
  font: var(--dsw-font-xxxs-11);
}

/* 线本身用伪元素画，文字居中：视觉上是「一条带说明的分隔线」 */
.pet-chat-memory::before,
.pet-chat-memory::after {
  content: '';
  flex: 1 1 auto;
  border-top: 1px dashed var(--dsw-alias-border-l3);
}

.pet-chat-memory-note {
  flex: 0 0 auto;
}

.pet-chat-round {
  display: flex;
  align-items: flex-start;
  gap: ${px(SIZE.gap)};
}

/* 多选模式：整轮是一张可点卡片；选中给浅底，未选中透明（与豆包的选中样式一致） */
.pet-chat-round.is-selecting {
  padding: ${px(SIZE.gapTight)} ${px(SIZE.gapWide)};
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-round.is-selecting:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-round.is-selected {
  background: var(--dsw-alias-bg-multi-select);
}

.pet-chat-pick {
  flex: 0 0 auto;
  padding-top: ${px(SIZE.gapTight)};
  opacity: 0.55;
  cursor: pointer;
}

.pet-chat-pick:hover {
  opacity: 1;
}

.pet-chat-round-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: ${px(SIZE.gap)};
}

.pet-chat-msg {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: ${px(SIZE.gap)};
  max-width: 92%;
}

.pet-chat-msg.is-me {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.pet-chat-msg.is-pet {
  align-self: flex-start;
}

.pet-chat-avatar {
  flex: 0 0 auto;
  width: ${px(SIZE.avatar)};
  height: ${px(SIZE.avatar)};
  border-radius: 50%;
  object-fit: cover;
}

.pet-chat-msg.is-pet .pet-chat-avatar {
  border: 1px solid var(--dsw-alias-border-l2);
}

.pet-chat-bubble {
  padding: ${px(SIZE.bubblePadY)} ${px(SIZE.bubblePadX)};
  border-radius: var(--dsw-radius-md);
  word-break: break-word;
  line-height: 1.6;
}

.pet-chat-text {
  white-space: pre-wrap;
}

.pet-chat-msg.is-me .pet-chat-bubble {
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
}

.pet-chat-msg.is-pet .pet-chat-bubble {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
}

.pet-chat-img-btn {
  display: block;
  margin-top: ${px(SIZE.gapTight)};
  padding: 0;
  border: none;
  background: none;
  cursor: zoom-in;
}

.pet-chat-img {
  display: block;
  max-width: ${px(SIZE.imgMaxW)};
  max-height: ${px(SIZE.imgMaxH)};
  border-radius: var(--dsw-radius-sm);
  object-fit: contain;
}

.pet-chat-time {
  display: inline-flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
  margin-top: ${px(SIZE.hairline)};
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-caption);
}

/* 时间右边的播报 / 动作按钮：与时间同字号，靠透明度与颜色表意，不占额外行高 */
.pet-chat-speak,
.pet-chat-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${px(SIZE.hairline * 12)};
  height: ${px(SIZE.hairline * 12)};
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  line-height: 1;
  color: inherit;
  cursor: pointer;
  opacity: 0.55;
  transition:
    opacity 0.15s,
    color 0.15s;
}

.pet-chat-speak:hover,
.pet-chat-action:hover {
  opacity: 1;
}

/* 动作键图标：内联 SVG 单色三角，颜色跟行内文字走。
   换成 emoji（▶️）会渲染成一块彩色方块，和喇叭放在一起就是两种风格。 */
.pet-chat-action-icon {
  display: block;
  width: ${px(SIZE.hairline * 5)};
  height: ${px(SIZE.hairline * 5)};
}

/* 生成中：只有上半圈带色的细环，靠旋转表达「在生成」。
   尺寸与时间文字同高；border-box + flex:none 是必须的：默认 content-box 会把描边算在尺寸外，
   而在 flex 行里被压缩时环会变成椭圆，看着就是个「奇怪的圆角方块」。 */
.pet-chat-speak.is-loading {
  opacity: 0.9;
  cursor: default;
}

.pet-chat-speak.is-loading::before {
  content: '';
  box-sizing: border-box;
  flex: none;
  width: ${px(SIZE.spinner)};
  height: ${px(SIZE.spinner)};
  border: 1.5px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-label-secondary);
  border-radius: 50%;
  animation: pet-chat-spin 0.8s linear infinite;
}

/* 播放中：主色 + 满不透明，和「可播放」明显区分 */
.pet-chat-speak.is-playing {
  opacity: 1;
  color: var(--dsw-alias-state-business-primary);
  cursor: default;
}

/* 失败：压暗表示没成，但仍可点（重试），所以指针保持手型 */
.pet-chat-speak.is-failed {
  opacity: 0.5;
}

@keyframes pet-chat-spin {
  to {
    transform: rotate(360deg);
  }
}

.pet-chat-time.is-pet {
  align-self: flex-start;
  /* 与宠物气泡左沿对齐：让时间明显属于这一轮的回答，而不是下一轮提问的开头 */
  margin-left: ${px(SIZE.avatar + SIZE.gap)};
}

.pet-chat-time.is-me {
  align-self: flex-end;
}

.pet-chat-hint {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-error {
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xxs-12);
}

.pet-chat-composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: ${px(SIZE.gapTight)};
  padding: ${px(SIZE.composerPad)} ${px(SIZE.pad)} ${px(SIZE.composerPadBottom)};
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-specific-input-major);
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-composer:focus-within {
  border-color: var(--dsw-alias-state-business-primary);
}

.pet-chat-composer.is-drop-target {
  border-color: var(--dsw-alias-state-business-primary);
}

.pet-chat-preview {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
}

.pet-chat-preview-img {
  width: ${px(SIZE.preview)};
  height: ${px(SIZE.preview)};
  object-fit: cover;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
}

.pet-chat-preview-meta {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}

.pet-chat-input {
  width: 100%;
  resize: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  padding: 0;
  min-height: ${px(SIZE.inputMinH)};
  max-height: ${px(SIZE.inputMaxH)};
  overflow-y: auto;
  font: var(--dsw-font-s-14);
  outline: none;
}

.pet-chat-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

.pet-chat-composer-bar {
  display: flex;
  align-items: center;
  gap: ${px(SIZE.gap)};
}

.pet-chat-attach {
  display: inline-flex;
  align-items: center;
  gap: ${px(SIZE.hairline)};
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: ${px(SIZE.pill)};
  padding: ${px(SIZE.pillPadY)} ${px(SIZE.tabPadX)};
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-attach:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pet-chat-file {
  display: none;
}

.pet-chat-composer-spacer {
  flex: 1 1 auto;
}

.pet-chat-send {
  flex: 0 0 auto;
  width: ${px(SIZE.send)};
  height: ${px(SIZE.send)};
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-foreground);
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-send:hover:not(:disabled) {
  background: var(--dsw-alias-button-info-hover);
}

.pet-chat-send:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 生成中：输入的文字压成三级色，与转圈一起说明「这句已经发出去了，在等回复」。
   输入框本身仍可编辑（可以先把下一句打好），所以只改颜色、不 pointer-events: none。 */
.pet-chat-composer.is-busy .pet-chat-input {
  color: var(--dsw-alias-label-tertiary);
}

/* 发送键里的转圈：与播报按钮共用 pet-chat-spin，只画半圈弧。
   box-sizing 必须 border-box，否则 1.5px 描边会把 12px 撑大，在 34px 的圆钮里显得偏大。 */
.pet-chat-send-spinner {
  box-sizing: border-box;
  width: ${px(SIZE.spinner)};
  height: ${px(SIZE.spinner)};
  border: 1.5px solid transparent;
  border-top-color: currentColor;
  border-right-color: currentColor;
  border-radius: 50%;
  animation: pet-chat-spin 0.8s linear infinite;
}

/* 悬浮提示气泡：挂在 body 上按光标定位（见 ./tooltip），不在 .pet-chat 里，
   所以字体与颜色全部自带——气泡是深色底，两种主题下都靠白字与背景的对比度读。 */
.pet-chat-tip {
  position: fixed;
  z-index: 2147483000;
  max-width: ${px(SIZE.tipMaxW)};
  padding: ${px(SIZE.tipPadY)} ${px(SIZE.tipPadX)};
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-tooltip-bg);
  color: var(--dsw-static-neutral-00);
  font: var(--dsw-font-xxs-12);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.pet-chat-tip.is-on {
  opacity: 1;
}
`;

//#endregion
//#region src/client/chat/styles.ts
/** 样式标签的归属标记；同一 key 只注入一次。 */
const STYLE_KEY = "dsh-pet-chat-panel";
/** 当前挂载数：多个 pane 可能同时挂载面板，靠引用计数决定何时移除样式标签。 */
let mountedCount = 0;
/** 已注入的 style 元素（第一个挂载时创建）。 */
let styleTag;
function injectPanelCss() {
	if (typeof document === "undefined") return () => {};
	mountedCount += 1;
	if (styleTag === void 0) {
		const tag = document.createElement("style");
		tag.dataset.dshPetCss = STYLE_KEY;
		tag.textContent = PANEL_CSS;
		document.head.appendChild(tag);
		styleTag = tag;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		mountedCount -= 1;
		if (mountedCount === 0 && styleTag !== void 0) {
			styleTag.remove();
			styleTag = void 0;
		}
	};
}

//#endregion
//#region src/client/chat/register.ts
/** 标签实现身份；同时也是正文与标题插槽的 key。 */
const TAB_ID = "dsh-pet-chat";
/** 标签类型；`openTab` 按它打开。 */
const TAB_KIND = "pet-chat";
/** 标签头与指南页卡片的文案。 */
const TAB_TITLE = "桌宠对话";
function openPetChatTab(ctx) {
	const controller = ctx.get?.("sidebarRight");
	controller?.openTab?.(TAB_KIND);
}
function registerPetChatTab(ctx, rt, options = {}) {
	const tabs = ctx.get?.("sidebarRightTabs");
	if (tabs === void 0 || typeof tabs.register !== "function") {
		console.warn("[dsh-pet] 右侧栏不可用：没有 sidebarRightTabs 服务，桌宠对话标签未注册");
		return () => {};
	}
	const disposeCss = injectPanelCss();
	const Panel = makePetChatPanel(rt);
	/** 指南页卡片的图标：插件 logo；框架给的位置只有 16px 左右，靠 CSS 铺满。 */
	const GuideIcon = () => rt.h("img", {
		className: "pet-chat-guide-icon",
		src: LOGO_URL,
		alt: "",
		loading: "lazy"
	});
	const commandId = options.commandId;
	const disposeType = tabs.register({
		id: TAB_ID,
		kind: TAB_KIND,
		priority: "extension",
		title: () => TAB_TITLE,
		guide: [{
			id: TAB_KIND,
			order: 400,
			title: () => TAB_TITLE,
			description: () => "与所有桌宠对话，点标签切换",
			icon: GuideIcon,
			...commandId === void 0 ? {} : { commandId }
		}]
	});
	ctx.slots.inject("sidebar.right.pane.tab", function* () {
		yield ctx.slots.register({
			name: "sidebar.right.pane.tab",
			key: TAB_ID,
			order: 100
		}, () => rt.h(Panel, {}));
	});
	return () => {
		disposeType();
		disposeTip();
		disposeCss();
	};
}

//#endregion
//#region src/client/anchor-report.ts
const REPORT_INTERVAL_MS = 5e3;
function readScreen() {
	if (window.screen === void 0) return null;
	const screen$1 = window.screen;
	const { availLeft, availTop, availWidth, availHeight } = screen$1;
	if (typeof availLeft !== "number" || typeof availTop !== "number") return null;
	if (!Number.isFinite(availLeft) || !Number.isFinite(availTop)) return null;
	if (!Number.isFinite(availWidth) || !Number.isFinite(availHeight)) return null;
	if (availWidth <= 0 || availHeight <= 0) return null;
	return {
		x: Math.round(availLeft),
		y: Math.round(availTop),
		width: Math.round(availWidth),
		height: Math.round(availHeight),
		windowX: Math.round(window.screenX),
		windowY: Math.round(window.screenY)
	};
}
function startAnchorReport() {
	let last = "";
	const tick = () => {
		const area = readScreen();
		if (area === null) return;
		const key = `${area.x},${area.y},${area.width},${area.height}`;
		if (key === last) return;
		last = key;
		postAction(`${ROUTE_PATH}/anchor`, area);
	};
	tick();
	const timer = setInterval(tick, REPORT_INTERVAL_MS);
	window.addEventListener("focus", tick);
	window.addEventListener("resize", tick);
	return () => {
		clearInterval(timer);
		window.removeEventListener("focus", tick);
		window.removeEventListener("resize", tick);
	};
}

//#endregion
//#region src/client/app.ts
function makeFactory() {
	return (require) => {
		const module = { exports: {} };
		const react = require("react");
		const { useEffect, useRef, useState, useCallback } = react;
		const { jsx: h } = require("react/jsx-runtime");
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			console.warn("[dsh-pet] 图标模块不可用：" + (error instanceof Error ? error.message : String(error)));
		}
		let renderIconSvg;
		try {
			const { createRoot } = require("react-dom/client");
			const { flushSync } = require("react-dom");
			renderIconSvg = (icon) => {
				const holder = document.createElement("div");
				const root = createRoot(holder);
				try {
					flushSync(() => root.render(h(icon, { size: 16 })));
					return holder.innerHTML;
				} finally {
					root.unmount();
				}
			};
		} catch (error) {
			console.warn("[dsh-pet] 图标渲染器不可用（react-dom 缺失）：" + (error instanceof Error ? error.message : String(error)));
		}
		const PetMulti = makePetUI({
			h,
			useState,
			useEffect,
			useRef
		});
		const name = "pet";
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"remote.commands",
			"commandUi"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, dicts), "dsh-pet: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => startAnchorReport(), "dsh-pet: anchor report");
			ctx.provide("petApi7340", {
				getState: getStateSnapshot,
				menuEvents: takeMenuEvents,
				pose: readPose,
				progress: readProgress
			});
			ctx.effect(() => initNotify({
				openSession: (sessionId) => ctx.get?.("uiWorkspace")?.openSession?.(sessionId),
				sessionTitle: (sessionId) => {
					const row = ctx.get?.("sessions")?.list?.getSnapshot?.()?.byId?.[sessionId];
					const name$1 = typeof row?.title === "string" ? row.title.trim() : "";
					return name$1 || void 0;
				}
			}), "dsh-pet: notifications");
			ctx.effect(() => {
				const commandUi = ctx.get?.("commandUi");
				if (!commandUi || typeof commandUi.decorate !== "function") {
					console.warn("[dsh-pet] 命令选择框不可用：commandUi 服务缺失（/pet 仍可手输 id 或名字）");
					return () => {};
				}
				return commandUi.decorate({
					name: "pet",
					available: () => true,
					ui: {
						kind: "popupSelect",
						options: async () => petBridge.current.map((p) => ({
							id: p.id,
							label: p.name || p.id,
							detail: (p.assetRoot && p.assetRoot !== p.id ? p.assetRoot + " / " : "") + p.id
						})),
						onSelect: async (option, session) => {
							await ctx.remote?.commands?.execute(session.sessionId, "/pet " + option.id, []);
						}
					}
				});
			}, "dsh-pet: /pet picker");
			ctx.effect(() => {
				const commandUi = ctx.get?.("commandUi");
				const icons = primitives;
				if (commandUi === void 0 || icons === void 0) {
					console.warn("[dsh-pet] 命令图标不可用（命令本身仍可用，只是没有图标）");
					return () => {};
				}
				return installCommandFaces(commandUi, new Map([
					["chat", {
						label: () => t("cmd.chat"),
						icon: icons.IconQueueOutlineRegular
					}],
					["pet", {
						label: () => t("cmd.pet"),
						icon: icons.IconUsersOutlineRegular
					}],
					["balance", {
						label: () => t("cmd.balance"),
						icon: icons.IconGaugeOutlineRegular
					}]
				]));
			}, "dsh-pet: command faces");
			ctx.effect(() => {
				const renderIcon = renderIconSvg;
				const icon = primitives?.IconSlidersTwoOutlineMedium;
				if (renderIcon === void 0 || icon === void 0) {
					console.warn("[dsh-pet] 设置页导航图标不可用（那一行仍是齿轮）");
					return () => {};
				}
				return installSectionNavIcon({
					label: () => t("nav"),
					renderSvg: () => renderIcon(icon)
				});
			}, "dsh-pet: settings nav icon");
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "pet",
					order: 1e3
				}, () => h(PetMulti, {}));
			});
			const PetConfigSection = makePetConfigSection({
				h,
				useState,
				useEffect,
				useRef,
				useCallback,
				t
			}, ctx);
			ctx.slots.inject("settings.section", function* () {
				yield ctx.slots.register({
					name: "settings.section",
					id: "pet-config",
					order: 30,
					label: () => t("nav"),
					inject: () => ({ t })
				}, PetConfigSection);
			});
			let sidebarChatReady = false;
			ctx.effect(() => {
				const sidebarChat = registerPetChatShortcut(ctx, () => t("shortcut.open"), () => openPetChatTab(ctx));
				sidebarChatReady = sidebarChat.registered;
				const card = registerPetCardShortcuts(ctx, (key) => t(key));
				return () => {
					sidebarChatReady = false;
					sidebarChat.dispose();
					card.dispose();
				};
			}, "dsh-pet: shortcuts");
			ctx.effect(() => {
				try {
					return registerPetChatTab(
						ctx,
						{
							h,
							useEffect,
							useRef,
							useState,
							...primitives === void 0 ? {} : { ui: {
								Modal: primitives.Modal,
								Button: primitives.Button,
								ImageLightbox: primitives.ImageLightbox
							} }
						},
						// 命令没登记成功就不带 commandId：指向不存在的命令会让侧栏注册抛错
						sidebarChatReady ? { commandId: PET_CHAT_COMMAND_ID } : {}
);
				} catch (error) {
					console.error("[dsh-pet] 右侧栏对话面板注册失败（已忽略，不影响启动）：", error);
					return () => {};
				}
			}, "dsh-pet: sidebar chat tab");
		}
		module.exports = {
			apply,
			inject,
			name
		};
		return module.exports;
	};
}

//#endregion
//#region src/client/index.ts
window.__ModuleLoader__.load({
	id: "dsh-pet-plus",
	factory: makeFactory()
});

//#endregion
})();
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { SelectedChannelStore, Toasts } from "@webpack/common";

const VoiceStateStore = findByPropsLazy("getVoiceStatesForChannel", "getCurrentClientVoiceChannelId");

type Kind = "mute" | "deafen";

const log = (t: string) => new Logger("FakeDeafenMute", "#ffd400").info(t);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const qButton = (l: "Mute" | "Unmute" | "Deafen" | "Undeafen") =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${l}"]`);
const isChecked = (btn: HTMLButtonElement | null) => (btn ? btn.getAttribute("aria-checked") === "true" : null);
const clickIf = async (btn: HTMLButtonElement | null) => (btn ? (btn.click(), await sleep(60), true) : false);

/* ------------------------ SFX/UI suppression ------------------------ */
let sfxDepth = 0;
let origPlay: HTMLMediaElement["play"] | null = null;
async function withSilentUI<T>(fn: () => Promise<T> | T): Promise<T> {
    if (++sfxDepth === 1) {
        origPlay = (HTMLMediaElement.prototype as any).play;
        (HTMLMediaElement.prototype as any).play = function () { try { return Promise.resolve(); } catch { return; } };
        document.body.setAttribute("data-vc-suppress-sfx", "1");
    }
    try { await sleep(5); return await fn(); }
    finally {
        await sleep(5);
        if (--sfxDepth === 0) {
            if (origPlay) (HTMLMediaElement.prototype as any).play = origPlay;
            origPlay = null;
            document.body.removeAttribute("data-vc-suppress-sfx");
        }
    }
}

/* ------------------------ State & flags ------------------------ */
let fake = { mute: false, deafen: false };
let fakeMuteBeforeDeafen = false;
let wsHookInstalled = false;
let origWS: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => void;
let prevVc: string | null = null;
let unsubSelected: (() => void) | null = null;
let ctxObs: MutationObserver | null = null;
let defObs: MutationObserver | null = null;
let tplOuterHTML: string | null = null;
let styleEl: HTMLStyleElement | null = null;

function setBodyFlags() {
    ensureStyle();
    const b = document.body;
    fake.mute ? b.setAttribute("data-vc-fakemute", "1") : b.removeAttribute("data-vc-fakemute");
    fake.deafen ? b.setAttribute("data-vc-fakedeafen", "1") : b.removeAttribute("data-vc-fakedeafen");
}

/* ------------------------ Styles ------------------------ */
function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.id = "vc-fake-mute-deafen-style";
    styleEl.textContent = `
/* Bright yellow while fake is on */
body[data-vc-fakemute="1"] button[aria-label="Mute"],
body[data-vc-fakemute="1"] button[aria-label="Unmute"],
body[data-vc-fakedeafen="1"] button[aria-label="Deafen"],
body[data-vc-fakedeafen="1"] button[aria-label="Undeafen"] { color:#ffd400 !important; filter:saturate(160%) contrast(115%); }
/* Hover visuals for injected rows */
.vc-menu-hoverable.item_c1e9c4.labelContainer_c1e9c4.colorDefault_c1e9c4 { border-radius:8px; cursor:pointer; }
.vc-menu-hoverable.item_c1e9c4.labelContainer_c1e9c4.colorDefault_c1e9c4:hover { background: var(--background-modifier-hover); }
.vc-menu-hoverable.item_c1e9c4.labelContainer_c1e9c4.colorDefault_c1e9c4:active { background: var(--background-modifier-active); }
.vc-fake-item.checkboxContainer_c1e9c4 .box_f525d3 svg path { transition: fill .12s ease; }
/* Kill transitions while programmatic toggles run */
body[data-vc-suppress-sfx="1"] button[aria-label="Mute"],
body[data-vc-suppress-sfx="1"] button[aria-label="Unmute"],
body[data-vc-suppress-sfx="1"] button[aria-label="Deafen"],
body[data-vc-suppress-sfx="1"] button[aria-label="Undeafen"] { transition:none!important; animation:none!important; }`;
    document.head.appendChild(styleEl);
}

/* ------------------------ WebSocket swallow hook ------------------------ */
function updateWSHook() {
    const need = fake.mute || fake.deafen;
    if (need && !wsHookInstalled) {
        WebSocket.prototype.send = function (data) {
            if (!fake.mute && !fake.deafen) return origWS.apply(this, [data]);
            try {
                const t = Object.prototype.toString.call(data);
                if (t === "[object String]") {
                    const o = JSON.parse(data as string);
                    if (o?.d !== undefined) {
                        if (fake.deafen && o.d.self_deaf === false) return;
                        if (fake.mute && o.d.self_mute === false) return;
                    }
                } else if (t === "[object ArrayBuffer]") {
                    const s = new TextDecoder().decode(data as ArrayBuffer);
                    if (fake.deafen && s.includes("self_deafs\x05false")) return;
                    if (fake.mute && s.includes("self_mutes\x05false")) return;
                }
            } catch { /* fail-open */ }
            return origWS.apply(this, [data]);
        };
        wsHookInstalled = true;
        log("WebSocket hook installed");
    } else if (!need && wsHookInstalled) {
        WebSocket.prototype.send = origWS;
        wsHookInstalled = false;
        log("WebSocket hook removed");
    }
    setBodyFlags();
}

/* ------------------------ Real click sequences ------------------------ */
async function ensureThenUn(what: Kind) {
    await withSilentUI(async () => {
        const btn = what === "mute" ? (qButton("Mute") ?? qButton("Unmute")) : (qButton("Deafen") ?? qButton("Undeafen"));
        const cur = isChecked(btn); // true = server ON (muted/deafened)
        if (cur === false) await clickIf(btn); // first make server ON
    });
    fake[what] = true; updateWSHook();
    await withSilentUI(async () => {
        const un = what === "mute" ? (qButton("Unmute") ?? qButton("Mute")) : (qButton("Undeafen") ?? qButton("Deafen"));
        await clickIf(un); // then client-side OFF (swallowed by hook)
    });
}

async function clearFakeWithRealUn(what: Kind) {
    await withSilentUI(async () => {
        const on = what === "mute" ? (qButton("Mute") ?? qButton("Unmute")) : (qButton("Deafen") ?? qButton("Undeafen"));
        await clickIf(on); // turn server OFF first (so state is clean)
    });
    fake[what] = false; updateWSHook();
    await withSilentUI(async () => {
        const un = what === "mute" ? (qButton("Unmute") ?? qButton("Mute")) : (qButton("Undeafen") ?? qButton("Deafen"));
        await clickIf(un); // ensure local OFF too
    });
}

async function toggleFake(what: Kind, next: boolean) {
    if (next) {
        await ensureThenUn(what);
        Toasts.show({ message: `Fake ${what} enabled (server ${what}ed, local un${what}ed).`, id: Toasts.genId(), type: Toasts.Type.SUCCESS });
    } else {
        await clearFakeWithRealUn(what);
        Toasts.show({ message: `Fake ${what} disabled (server + local un${what}ed).`, id: Toasts.genId(), type: Toasts.Type.SUCCESS });
    }
}

/* ------------------------ VC auto-clean on channel change ------------------------ */
function watchVC() {
    if (unsubSelected) return;
    const handler = async () => {
        const cur = (VoiceStateStore.getCurrentClientVoiceChannelId?.() as string | undefined) ?? SelectedChannelStore.getVoiceChannelId();
        if (cur !== prevVc) {
            if (fake.mute) await clearFakeWithRealUn("mute");
            if (fake.deafen) await clearFakeWithRealUn("deafen");
            fake = { mute: false, deafen: false }; updateWSHook();
            prevVc = cur ?? null;
        }
    };
    SelectedChannelStore.addChangeListener(handler);
    void handler();
    unsubSelected = () => { try { SelectedChannelStore.removeChangeListener(handler); } catch { } unsubSelected = null; };
}

/* ------------------------ Real deafen/undeafen observer (bounce fake-mute) ------------------------ */
function startDeafenObserver() {
    if (defObs) return;
    defObs = new MutationObserver(async recs => {
        for (const r of recs) {
            const el = r.target as HTMLElement;
            if (!el || !("getAttribute" in el)) continue;
            const label = el.getAttribute("aria-label");
            if (label !== "Deafen" && label !== "Undeafen") continue;
            const now = el.getAttribute("aria-checked"); // "true" = deafened
            if (now === "true") fakeMuteBeforeDeafen = fake.mute;
            if (now === "false" && fakeMuteBeforeDeafen) {
                fakeMuteBeforeDeafen = false;
                await clearFakeWithRealUn("mute");
                await ensureThenUn("mute"); // re-enable fake-mute after real undeafen
            }
        }
    });
    const install = () => {
        const btn = qButton("Deafen") ?? qButton("Undeafen");
        if (btn) defObs!.observe(btn, { attributes: true, attributeFilter: ["aria-checked"] });
    };
    install();
    const retry = setInterval(() => { if (!defObs) return clearInterval(retry); defObs.disconnect(); install(); }, 1500);
}

function stopDeafenObserver() { defObs?.disconnect(); defObs = null; }

/* ------------------------ Context menu injection ------------------------ */
function cloneCheckbox(src: HTMLElement, id: string, label: string, checked: boolean, onToggle: (n: boolean) => void | Promise<void>) {
    const node = src.cloneNode(true) as HTMLElement;
    node.id = id;
    node.classList.add("vc-fake-item", "vc-menu-hoverable");
    node.setAttribute("role", "menuitemcheckbox");
    node.setAttribute("aria-checked", checked ? "true" : "false");
    node.setAttribute("aria-disabled", "false");
    node.setAttribute("data-menu-item", "true");
    node.tabIndex = -1;
    node.querySelector<HTMLElement>(".label_c1e9c4")!.textContent = label;
    const path = node.querySelector<SVGPathElement>("svg path");
    if (path) path.setAttribute("fill", checked ? "currentColor" : "var(--transparent)");
    const apply = async () => {
        const next = node.getAttribute("aria-checked") !== "true";
        node.setAttribute("aria-checked", next ? "true" : "false");
        if (path) path.setAttribute("fill", next ? "currentColor" : "var(--transparent)");
        await onToggle(next);
    };
    node.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); void apply(); });
    node.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); void apply(); } });
    return node;
}

function fromCachedTemplate(opts: { id: string; label: string; checked: boolean; onToggle: (n: boolean) => void | Promise<void>; }) {
    if (!tplOuterHTML) return null;
    const div = document.createElement("div"); div.innerHTML = tplOuterHTML;
    const t = div.firstElementChild as HTMLElement | null; if (!t) return null;
    return cloneCheckbox(t, opts.id, opts.label, opts.checked, opts.onToggle);
}

function inject(menu: HTMLElement, kind: Kind) {
    // learn template from Voice Settings row
    const voiceSettings = menu.querySelector<HTMLElement>("#audio-device-context-voice-settings");
    if (voiceSettings) tplOuterHTML = voiceSettings.outerHTML;

    const id = kind === "mute" ? "vc-fake-mute" : "vc-fake-deafen";
    if (menu.querySelector("#" + id)) return;

    const anchor = menu.querySelector<HTMLElement>("#audio-device-context-voice-settings");

    if (!anchor) return;

    const node =
        (voiceSettings && kind === "mute" ? cloneCheckbox(voiceSettings, id, "Fake mute", fake.mute, n => toggleFake("mute", n))
            : fromCachedTemplate({ id, label: kind === "mute" ? "Fake mute" : "Fake deafen", checked: fake[kind], onToggle: n => toggleFake(kind, n) }))
        ?? (() => {
            const any = menu.querySelector<HTMLElement>(".checkboxContainer_c1e9c4.labelContainer_c1e9c4");
            return any ? cloneCheckbox(any, id, kind === "mute" ? "Fake mute" : "Fake deafen", fake[kind], n => toggleFake(kind, n)) : null;
        })();

    if (node) anchor.parentElement?.insertBefore(node, anchor);
}

function startCtxObserver() {
    if (ctxObs) return;
    ensureStyle();
    ctxObs = new MutationObserver(muts => {
        for (const m of muts) for (const n of Array.from(m.addedNodes)) {
            if (!(n instanceof HTMLElement)) continue;
            const menus: HTMLElement[] = [];
            if (n.getAttribute?.("role") === "menu") menus.push(n);
            else {
                const maybe = n.querySelector<HTMLElement>('[role="menu"]');
                if (maybe) menus.push(maybe);
            }
            if (!menus.length) continue;
            queueMicrotask(() => {
                for (const menu of menus) {
                    const isMute = !!(menu.querySelector("#audio-device-context-audioinput-devices") && menu.querySelector("#audio-device-context-voice-settings"));
                    const isDeafen = !!menu.querySelector("#audio-device-context-audiooutput-devices");
                    if (isMute) inject(menu, "mute");
                    if (isDeafen) inject(menu, "deafen");
                }
            });
        }
    });
    ctxObs.observe(document.documentElement, { childList: true, subtree: true });
}

function stopCtxObserver() {
    ctxObs?.disconnect(); ctxObs = null;
    document.querySelectorAll("#vc-fake-mute, #vc-fake-deafen").forEach(n => n.remove());
    styleEl?.remove(); styleEl = null;
    setBodyFlags();
}

/* ------------------------ Plugin ------------------------ */
export default definePlugin({
    name: "Fake Deafen & Mute",
    description:
        "Right-click the Mute/Deafen button to toggle Fake Mute or Fake Deafen. Others will see you as muted/deafened while you can still speak and hear. dont patch this.",
    authors: [
        Devs.jewdev
    ],

    start() {
        origWS = WebSocket.prototype.send;
        wsHookInstalled = false;
        fake = { mute: false, deafen: false };
        fakeMuteBeforeDeafen = false;

        ensureStyle();
        setBodyFlags();
        watchVC();
        startCtxObserver();
        startDeafenObserver();

        log("Ready (silent toggles; auto-clean on VC change; undeafen bounce; toasts on toggle only)");
    },

    stop() {
        if (wsHookInstalled) { WebSocket.prototype.send = origWS; wsHookInstalled = false; }
        fake = { mute: false, deafen: false }; setBodyFlags();

        unsubSelected?.(); unsubSelected = null;
        stopCtxObserver();
        stopDeafenObserver();

        // restore in case suppression was active
        sfxDepth = 0;
        if (origPlay) { (HTMLMediaElement.prototype as any).play = origPlay; origPlay = null; }
        document.body.removeAttribute("data-vc-suppress-sfx");

        log("Disarmed");
    }
});

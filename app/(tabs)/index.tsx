import { ThemedText } from "@/components/themed-text";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Slider from "@react-native-community/slider";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  AppStateStatus,
  BackHandler,
  Dimensions,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  TextInput,
  View,
  ViewStyle,
} from "react-native";
import { WebView } from "react-native-webview";

/**
 * Default YouTube start URL (✅ first run starts from TOP)
 */
const DEFAULT_START_URL = "https://m.youtube.com/";

/**
 * Storage keys
 */
const STORAGE_KEYS = {
  lastUrl: "lastYouTubeUrl",
  lastRate: "lastPlaybackRate",
  lastTimeSec: "lastPlaybackTimeSec",
  favorites: "favoritesList_v2",
  posMap: "playbackPosMap_v1",
  memos: "memosList_v2",
  history: "historyList_v1",

  skipStepSec: "skipStepSec_v1",
  freeLayout: "freeLayoutConfig_v1",

  // ✅ NEW
  themeMode: "themeMode_v1", // "dark" | "light"
  focusMode: "focusMode_v1", // "0" | "1"

  // ✅ NEW: button scale
  btnScale: "btnScale_v1", // "0.85" | "1" | "1.15" etc

  // ✅ NEW: hide buttons toggle
  buttonsHidden: "buttonsHidden_v1", // "0" | "1"

  // ✅ NEW: show/hide skip buttons (rewind/forward)
  skipButtonsHidden: "skipButtonsHidden_v1", // "0" | "1"
} as const;

type FavoriteKind = "video" | "channel" | "playlist" | "other";

type FavoriteItem = {
  id: string;
  url: string;
  title: string;
  label?: string;
  kind: FavoriteKind;
  savedAt: number;
};

type HistoryItem = {
  id: string;
  url: string;
  title: string;
  kind: FavoriteKind;
  visitedAt: number;
};

type MemoItem = {
  id: string;
  text: string;
  createdAt: number;
};

type StateUpdatePayload = {
  type: "STATE_UPDATE";
  url: string;
  playbackRate: number;
  currentTime: number;
  pageTitle: string;
  reqId?: string;
};

type ToggleButtonsPayload = {
  type: "TOGGLE_BUTTONS";
};

type PosMap = Record<string, number>;

/**
 * ✅ Free-position layout
 */
type XY = { x: number; y: number };

type FreeLayoutConfig = {
  star: XY;
  speed: XY;
  rewind: XY;
  forward: XY;
};

type BtnSizes = { star: number; speed: number; skip: number };

const BTN_BASE = { star: 56, speed: 56, skip: 56 };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function computeBtnSizes(scale: number): BtnSizes {
  const s = Number.isFinite(scale) ? scale : 1;
  const size = Math.max(44, Math.min(84, Math.round(BTN_BASE.star * s)));
  return { star: size, speed: size, skip: size };
}

function defaultFreeLayout(screenW: number, screenH: number, topPad: number, sizes: BtnSizes): FreeLayoutConfig {
  const edge = 14;
  const topEdge = 22; // ✅ 少しだけ下へ

  const yTop = clamp(topPad + topEdge, topPad + 6, Math.max(topPad + 6, screenH - sizes.star - 10));

  // ✅ default: forward at center-right, rewind above it
  const xRight = screenW - edge - sizes.skip;
  const centerYForward = clamp(
    topPad + (screenH - topPad) / 2 - sizes.skip / 2,
    topPad + 10,
    Math.max(topPad + 10, screenH - sizes.skip - 10)
  );
  const gap = 12;
  const rewindY = clamp(centerYForward - sizes.skip - gap, topPad + 10, Math.max(topPad + 10, screenH - sizes.skip - 10));

  return {
    star: { x: edge, y: yTop }, // ★ left-top
    speed: { x: screenW - edge - sizes.speed, y: yTop }, // ● right-top
    rewind: { x: xRight, y: rewindY }, // ⟲ above
    forward: { x: xRight, y: centerYForward }, // ⟳ below
  };
}

/**
 * Fix UA to Android Chrome-ish to avoid YouTube blank screen on WebView detection
 */
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/**
 * ✅ Long-press (1.0s) on non-button area (WebView surface) toggles buttons
 * - Implemented inside WebView to avoid blocking touches
 */
function makeEnableLongPressToggleButtonsJS() {
  return `
    (function() {
      try {
        if (window.__RN_LONGPRESS_TOGGLE__) return true;

        var state = {
          timer: null,
          startX: 0,
          startY: 0,
          moved: false,
          armed: false
        };

        function isEditableTarget(t) {
          try {
            if (!t) return false;
            var tag = (t.tagName || "").toUpperCase();
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return true;
            if (t.isContentEditable) return true;
            var el = t;
            for (var i = 0; i < 6 && el; i++) {
              if (el.isContentEditable) return true;
              el = el.parentElement;
            }
          } catch(e) {}
          return false;
        }

        function clearTimer() {
          if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
          }
          state.moved = false;
          state.armed = false;
        }

        function armLongPress() {
          clearTimer();
          state.armed = true;
          state.timer = setTimeout(function() {
            try {
              if (!state.armed || state.moved) return;
              window.ReactNativeWebView && window.ReactNativeWebView.postMessage &&
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: "TOGGLE_BUTTONS" }));
            } catch(e) {}
          }, 1000);
        }

        document.addEventListener("touchstart", function(e) {
          try {
            if (!e || !e.touches || e.touches.length !== 1) { clearTimer(); return; }
            var t = e.target;
            if (isEditableTarget(t)) { clearTimer(); return; }

            var p = e.touches[0];
            state.startX = p.clientX || 0;
            state.startY = p.clientY || 0;
            state.moved = false;

            armLongPress();
          } catch(err) { clearTimer(); }
        }, { passive: true });

        document.addEventListener("touchmove", function(e) {
          try {
            if (!state.timer || !e || !e.touches || e.touches.length !== 1) return;
            var p = e.touches[0];
            var dx = (p.clientX || 0) - state.startX;
            var dy = (p.clientY || 0) - state.startY;
            if ((dx*dx + dy*dy) > (12*12)) {
              state.moved = true;
              clearTimer();
            }
          } catch(err) { clearTimer(); }
        }, { passive: true });

        document.addEventListener("touchend", function() { clearTimer(); }, { passive: true });
        document.addEventListener("touchcancel", function() { clearTimer(); }, { passive: true });

        window.__RN_LONGPRESS_TOGGLE__ = true;
      } catch(e) {}
      return true;
    })();
  `;
}

/**
 * ✅ Filter (match/exclude) videos on lists by keyword (SPA + scroll + shorts safe)
 * ✅ supports multi words split by half/full spaces
 * ✅ match mode supports AND / OR (toggle)
 * ✅ exclude mode uses OR (any hit)
 * ✅ Shorts block overlay:
 *   - match: "これは関係のない動画です"
 *   - exclude: "除外ワードが含まれる動画です"
 * ✅ overlay includes a "戻る" button to escape Shorts
 */
type FilterMode = "none" | "match" | "exclude";
type FilterLogic = "and" | "or";

function makeApplyVideoFilterJS(mode: FilterMode, keyword: string, logic: FilterLogic) {
  const m = JSON.stringify(mode);
  const kw = JSON.stringify((keyword || "").trim());
  const lg = JSON.stringify(logic);
  return `
    (function() {
      try {
        var mode = ${m};
        var rawKw = (${kw} || "");
        var logic = ${lg};

        function normalizeText(s) {
          try { return String(s || "").replace(/\\s+/g, " ").trim().toLowerCase(); } catch(e) { return ""; }
        }

        function splitKeywords(s) {
          try {
            var t = String(s || "").trim();
            if (!t) return [];
            // split by half/full spaces
            var parts = t.split(/[\\s\\u3000]+/g).filter(function(x){ return !!x; });
            return parts.map(function(x){ return normalizeText(x); }).filter(function(x){ return !!x; });
          } catch(e) { return []; }
        }

        var tokens = splitKeywords(rawKw);

        // Track "previous page" (especially before entering Shorts) to escape
        if (!window.__RN_VFILTER_NAV__) {
          window.__RN_VFILTER_NAV__ = { lastHref: location.href, prevNonShortsHref: "" };
        }
        (function updateNav() {
          try {
            var nav = window.__RN_VFILTER_NAV__;
            var href = String(location && location.href ? location.href : "");
            if (!href) return;

            var was = String(nav.lastHref || "");
            if (was && was !== href) {
              // if transitioning from non-shorts -> shorts, remember prev
              if (was.indexOf("/shorts/") === -1 && href.indexOf("/shorts/") !== -1) {
                nav.prevNonShortsHref = was;
              }
              nav.lastHref = href;
            } else if (!nav.lastHref) {
              nav.lastHref = href;
            }
          } catch(e) {}
        })();

        window.__RN_VFILTER__ = { mode: mode, tokens: tokens, logic: logic };

        function isWatchHref(href) {
          try {
            if (!href) return false;
            href = String(href);
            return (href.indexOf("/watch") !== -1);
          } catch(e) { return false; }
        }

        function isShortsHref(href) {
          try {
            if (!href) return false;
            href = String(href);
            return (href.indexOf("/shorts/") !== -1);
          } catch(e) { return false; }
        }

        function isWatchLikeHref(href) {
          return isWatchHref(href) || isShortsHref(href);
        }

        function getMetaDescription() {
          try {
            var m1 = document.querySelector('meta[name="description"]');
            if (m1 && m1.getAttribute) {
              var c = m1.getAttribute("content");
              if (c) return normalizeText(c);
            }
          } catch(e) {}
          return "";
        }

        function getTitleTextFromNode(node) {
          try {
            if (!node) return "";
            var al = node.getAttribute && node.getAttribute("aria-label");
            if (al) return normalizeText(al);

            var ti = node.getAttribute && node.getAttribute("title");
            if (ti) return normalizeText(ti);

            var el =
              node.querySelector && (
                node.querySelector('h3') ||
                node.querySelector('yt-formatted-string') ||
                node.querySelector('[aria-label]') ||
                node.querySelector('[title]')
              );
            if (el) {
              var t = (el.textContent || "").trim();
              if (!t) {
                var al2 = el.getAttribute && el.getAttribute("aria-label");
                if (al2) t = String(al2);
                if (!t) {
                  var ti2 = el.getAttribute && el.getAttribute("title");
                  if (ti2) t = String(ti2);
                }
              }
              return normalizeText(t);
            }

            return "";
          } catch(e) { return ""; }
        }

        function getDescTextFromNode(node) {
          try {
            if (!node) return "";
            var el =
              node.querySelector && (
                node.querySelector('#description-text') ||
                node.querySelector('yt-formatted-string#description-text') ||
                node.querySelector('[id*="description"]') ||
                node.querySelector('[class*="description"]') ||
                node.querySelector('ytd-video-renderer #metadata-line') ||
                node.querySelector('ytd-video-renderer #metadata') ||
                node.querySelector('ytm-video-with-context-renderer #metadata') ||
                node.querySelector('ytm-video-description') ||
                node.querySelector('ytm-video-description-renderer') ||
                node.querySelector('ytm-slim-video-metadata-section-renderer') ||
                node.querySelector('ytd-rich-grid-media #metadata-line') ||
                node.querySelector('ytd-rich-grid-media #metadata')
              );
            if (el) return normalizeText(el.textContent || "");

            var meta =
              node.querySelector && (
                node.querySelector('#metadata-line') ||
                node.querySelector('#metadata') ||
                node.querySelector('.metadata-line') ||
                node.querySelector('.metadata')
              );
            if (meta) return normalizeText(meta.textContent || "");

            return "";
          } catch(e) { return ""; }
        }

        function getFilterTextForCard(card, linkNode) {
          try {
            var t = getTitleTextFromNode(card);
            if (!t && linkNode) t = getTitleTextFromNode(linkNode);

            var d = getDescTextFromNode(card);
            var merged = (t ? (t + " ") : "") + (d || "");
            return normalizeText(merged);
          } catch(e) { return ""; }
        }

        function getCurrentWatchText() {
          try {
            var parts = [];
            try {
              var dt = (document && document.title) ? document.title : "";
              if (dt) parts.push(normalizeText(dt));
            } catch(e) {}

            var md = getMetaDescription();
            if (md) parts.push(md);

            try {
              var tnode =
                document.querySelector('h1') ||
                document.querySelector('h2') ||
                document.querySelector('ytm-slim-video-metadata-section-renderer') ||
                document.querySelector('ytm-video-description') ||
                document.querySelector('ytd-watch-metadata') ||
                document.querySelector('[class*="title"]') ||
                document.querySelector('[id*="title"]');
              if (tnode) parts.push(normalizeText(tnode.textContent || ""));
            } catch(e) {}

            try {
              var dnode =
                document.querySelector('#description') ||
                document.querySelector('#description-text') ||
                document.querySelector('[id*="description"]') ||
                document.querySelector('ytd-expander') ||
                document.querySelector('ytm-video-description') ||
                document.querySelector('ytm-video-description-renderer');
              if (dnode) parts.push(normalizeText(dnode.textContent || ""));
            } catch(e) {}

            return normalizeText(parts.join(" "));
          } catch(e) { return ""; }
        }

        function findCard(node) {
          try {
            var cur = node;
            for (var i = 0; i < 10 && cur; i++) {
              var tn = (cur.tagName || "").toLowerCase();
              if (
                tn === "ytm-compact-video-renderer" ||
                tn === "ytm-video-with-context-renderer" ||
                tn === "ytm-item-section-renderer" ||
                tn === "ytm-reel-item-renderer" ||
                tn === "ytm-reel-shelf-renderer" ||
                tn === "ytm-rich-item-renderer" ||
                tn === "ytd-rich-item-renderer" ||
                tn === "ytd-video-renderer" ||
                tn === "ytd-compact-video-renderer" ||
                tn === "ytd-grid-video-renderer"
              ) return cur;

              if (tn.indexOf("ytm-") === 0 || tn.indexOf("ytd-") === 0) return cur;

              cur = cur.parentElement;
            }
          } catch(e) {}
          return null;
        }

        function setHidden(card, hidden) {
          try {
            if (!card || !card.style) return;
            if (!hidden) {
              if (card.getAttribute && card.getAttribute("data-rn-vhide") === "1") {
                card.style.removeProperty("display");
                card.style.removeProperty("visibility");
                card.style.removeProperty("height");
                card.style.removeProperty("max-height");
                card.style.removeProperty("overflow");
                card.removeAttribute && card.removeAttribute("data-rn-vhide");
              }
              return;
            }
            card.setAttribute && card.setAttribute("data-rn-vhide", "1");
            card.style.setProperty("display", "none", "important");
            card.style.setProperty("visibility", "hidden", "important");
            card.style.setProperty("height", "0", "important");
            card.style.setProperty("max-height", "0", "important");
            card.style.setProperty("overflow", "hidden", "important");
          } catch(e) {}
        }

        function containsToken(text, token) {
          try {
            if (!token) return true;
            return String(text || "").indexOf(String(token)) !== -1;
          } catch(e) { return false; }
        }

        function hitByLogic(text, toks, logic2) {
          try {
            if (!toks || !toks.length) return true;
            if (logic2 === "and") {
              for (var i = 0; i < toks.length; i++) {
                if (!containsToken(text, toks[i])) return false;
              }
              return true;
            }
            // "or"
            for (var j = 0; j < toks.length; j++) {
              if (containsToken(text, toks[j])) return true;
            }
            return false;
          } catch(e) { return false; }
        }

        function shouldBlockByMode(hit, mode2) {
          if (mode2 === "match") return !hit;
          if (mode2 === "exclude") return hit;
          return false;
        }

        function goBackEscape() {
          try {
            var nav = window.__RN_VFILTER_NAV__ || {};
            var prev = String(nav.prevNonShortsHref || "");
            if (prev && prev.indexOf("/shorts/") === -1) {
              try { location.href = prev; return; } catch(e) {}
            }
          } catch(e) {}

          // fallback: history back (maybe need 2 steps)
          try { history.back(); } catch(e) {}
          setTimeout(function(){
            try {
              var href = String(location && location.href ? location.href : "");
              if (href.indexOf("/shorts/") !== -1) {
                try { history.back(); } catch(e2) {}
              }
            } catch(e3) {}
          }, 350);
        }

        // ✅ Shorts mismatch: hide via CSS and show message overlay + back button
        function ensureShortsBlockOverlay(blocked, messageText) {
          try {
            var overlayId = "__RN_VFILTER_SHORTS_OVERLAY__";
            var styleId = "__RN_VFILTER_SHORTS_STYLE__";

            var stEl = document.getElementById(styleId);
            var ovEl = document.getElementById(overlayId);

            if (!blocked) {
              if (stEl && stEl.parentNode) stEl.parentNode.removeChild(stEl);
              if (ovEl && ovEl.parentNode) ovEl.parentNode.removeChild(ovEl);
              return;
            }

            var css = [
              "html, body { background:#000 !important; }",
              "video, ytm-reel-video-renderer, ytm-shorts-player, ytm-reel-video-renderer *, ytm-shorts-player * {",
              "  display:none !important;",
              "  visibility:hidden !important;",
              "}",
              "ytm-app, ytm-app * { }"
            ].join(" ");

            if (!stEl) {
              stEl = document.createElement("style");
              stEl.id = styleId;
              stEl.type = "text/css";
              (document.head || document.documentElement || document.body).appendChild(stEl);
            }
            stEl.textContent = css;

            if (!ovEl) {
              ovEl = document.createElement("div");
              ovEl.id = overlayId;
              ovEl.style.position = "fixed";
              ovEl.style.left = "0";
              ovEl.style.top = "0";
              ovEl.style.right = "0";
              ovEl.style.bottom = "0";
              ovEl.style.display = "flex";
              ovEl.style.flexDirection = "column";
              ovEl.style.alignItems = "center";
              ovEl.style.justifyContent = "center";
              ovEl.style.padding = "24px";
              ovEl.style.zIndex = "2147483647";
              ovEl.style.background = "rgba(0,0,0,0.92)";
              ovEl.style.color = "#fff";
              ovEl.style.fontSize = "16px";
              ovEl.style.lineHeight = "1.6";
              ovEl.style.textAlign = "center";
              ovEl.style.pointerEvents = "auto";

              var msg = document.createElement("div");
              msg.id = "__RN_VFILTER_SHORTS_MSG__";
              msg.style.maxWidth = "420px";
              msg.style.marginBottom = "14px";
              msg.style.whiteSpace = "pre-wrap";
              msg.textContent = messageText || "これは関係のない動画です";
              ovEl.appendChild(msg);

              var btn = document.createElement("button");
              btn.textContent = "前の画面に戻る";
              btn.style.padding = "10px 14px";
              btn.style.borderRadius = "12px";
              btn.style.border = "1px solid rgba(255,255,255,0.35)";
              btn.style.background = "rgba(127,219,255,0.95)";
              btn.style.color = "#111";
              btn.style.fontSize = "14px";
              btn.style.fontWeight = "600";
              btn.style.cursor = "pointer";
              btn.onclick = function(ev){
                try { ev && ev.preventDefault && ev.preventDefault(); } catch(e) {}
                goBackEscape();
                return false;
              };
              ovEl.appendChild(btn);

              var hint = document.createElement("div");
              hint.style.marginTop = "12px";
              hint.style.fontSize = "12px";
              hint.style.opacity = "0.75";
              hint.textContent = "※ フィルタ解除で通常表示に戻せます";
              ovEl.appendChild(hint);

              (document.body || document.documentElement).appendChild(ovEl);
            } else {
              var msgEl = document.getElementById("__RN_VFILTER_SHORTS_MSG__");
              if (msgEl) msgEl.textContent = messageText || "これは関係のない動画です";
            }

            try {
              var v = document.querySelector("video");
              if (v && v.pause) v.pause();
            } catch(e2) {}
          } catch(e) {}
        }

        function enforceCurrentPage() {
          try {
            var st = window.__RN_VFILTER__ || { mode: "none", tokens: [], logic: "and" };
            var mode2 = st.mode || "none";
            var toks = st.tokens || [];
            var logic2 = st.logic || "and";

            if (!toks.length || mode2 === "none") {
              ensureShortsBlockOverlay(false, "");
              return;
            }

            var href = String(location && location.href ? location.href : "");
            if (!isWatchLikeHref(href)) {
              ensureShortsBlockOverlay(false, "");
              return;
            }

            // Only enforce "block overlay" on Shorts pages
            if (!isShortsHref(href)) {
              ensureShortsBlockOverlay(false, "");
              return;
            }

            // update nav tracking
            try {
              var nav = window.__RN_VFILTER_NAV__;
              if (nav) {
                if (nav.lastHref !== href) {
                  if (String(nav.lastHref || "").indexOf("/shorts/") === -1) nav.prevNonShortsHref = String(nav.lastHref || "");
                  nav.lastHref = href;
                }
              }
            } catch(eNav) {}

            if (!window.__RN_VFILTER_PAGECHECK__) {
              window.__RN_VFILTER_PAGECHECK__ = { href: "", firstSeen: 0, attempts: 0, lastDecision: null };
            }
            var pc = window.__RN_VFILTER_PAGECHECK__;

            if (pc.href !== href) {
              pc.href = href;
              pc.firstSeen = Date.now();
              pc.attempts = 0;
              pc.lastDecision = null;
              ensureShortsBlockOverlay(false, "");
              return;
            }

            // wait a bit after navigation before judging
            if ((Date.now() - pc.firstSeen) < 800) {
              ensureShortsBlockOverlay(false, "");
              return;
            }

            var text = getCurrentWatchText();
            var norm = normalizeText(text);

            // avoid false negative when title/desc not ready
            if (!norm || norm.length < 6) {
              pc.attempts++;
              if (pc.attempts < 10) {
                ensureShortsBlockOverlay(false, "");
                return;
              }
              if (mode2 === "match") {
                ensureShortsBlockOverlay(true, "これは関係のない動画です");
              } else {
                ensureShortsBlockOverlay(false, "");
              }
              return;
            }

            // exclude: OR only
            var hit = (mode2 === "exclude") ? hitByLogic(norm, toks, "or") : hitByLogic(norm, toks, logic2);
            var block = shouldBlockByMode(hit, mode2);

            if (block) {
              var msg = (mode2 === "exclude") ? "除外ワードが含まれる動画です" : "これは関係のない動画です";
              ensureShortsBlockOverlay(true, msg);
            } else {
              ensureShortsBlockOverlay(false, "");
            }

            pc.lastDecision = block ? "blocked" : "allowed";
          } catch(e) {}
        }

        function applyOnce() {
          try {
            // keep nav updated
            try {
              var nav = window.__RN_VFILTER_NAV__;
              var hrefNow = String(location && location.href ? location.href : "");
              if (nav && hrefNow && nav.lastHref !== hrefNow) {
                if (String(nav.lastHref || "").indexOf("/shorts/") === -1 && hrefNow.indexOf("/shorts/") !== -1) {
                  nav.prevNonShortsHref = String(nav.lastHref || "");
                }
                nav.lastHref = hrefNow;
              }
            } catch(eNav2) {}

            var st = window.__RN_VFILTER__ || { mode: "none", tokens: [], logic: "and" };
            var mode2 = st.mode || "none";
            var toks = st.tokens || [];
            var logic2 = st.logic || "and";

            enforceCurrentPage();

            var nodes = document.querySelectorAll(
              'a[href*="/watch"], a[href^="/watch"], a[href*="/shorts/"], a[href^="/shorts/"]'
            );

            for (var i = 0; i < nodes.length; i++) {
              var a = nodes[i];
              var card = findCard(a) || a;

              if (!toks.length || mode2 === "none") {
                setHidden(card, false);
                continue;
              }

              var text2 = getFilterTextForCard(card, a);

              // exclude: OR only
              var hit2 = (mode2 === "exclude") ? hitByLogic(text2, toks, "or") : hitByLogic(text2, toks, logic2);

              var hide = shouldBlockByMode(hit2, mode2);
              setHidden(card, hide);
            }
          } catch(e) {}
        }

        function scheduleApply() {
          try {
            var inst = window.__RN_VFILTER_INSTALL__;
            if (!inst) return;
            if (inst._queued) return;
            inst._queued = true;
            var run = function() {
              inst._queued = false;
              applyOnce();
            };
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
            else setTimeout(run, 0);
          } catch(e) {}
        }

        if (!window.__RN_VFILTER_INSTALL__) {
          window.__RN_VFILTER_INSTALL__ = { _queued: false, _obs: null, _timer: null, _scrollBound: false };
          try {
            var obs = new MutationObserver(function() {
              scheduleApply();
            });
            obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
            window.__RN_VFILTER_INSTALL__._obs = obs;
          } catch(e) {}

          try {
            if (!window.__RN_VFILTER_INSTALL__._scrollBound) {
              window.__RN_VFILTER_INSTALL__._scrollBound = true;
              window.addEventListener("scroll", function(){ scheduleApply(); }, { passive: true });
              window.addEventListener("touchmove", function(){ scheduleApply(); }, { passive: true });
            }
          } catch(e) {}

          try {
            window.__RN_VFILTER_INSTALL__._timer = setInterval(function(){
              try { scheduleApply(); } catch(e) {}
            }, 900);
          } catch(e) {}
        }

        applyOnce();
        setTimeout(function(){ try { applyOnce(); } catch(e) {} }, 350);
      } catch(e) {}
      return true;
    })();
  `;
}

/**
 * Persistent script inside WebView:
 * - keeps the manually selected playback rate applied
 * - posts state periodically and on page visibility changes
 */
function makeBootstrapJS(initialRate: number) {
  return `
    (function() {
      try {
        if (window.__YT_RATE_CTRL__) {
          window.__YT_RATE_CTRL__.targetRate = ${initialRate};
          window.__YT_RATE_CTRL__.applyNow && window.__YT_RATE_CTRL__.applyNow("reinjected");
          return true;
        }

        var ctrl = {
          targetRate: ${initialRate},
          lastHref: location.href,
          lastVideo: null,
          applyLock: false,
          applyNow: function(reason) {
            if (ctrl.applyLock) return;
            ctrl.applyLock = true;
            try {
              var v = document.querySelector("video");
              if (v) {
                ctrl.lastVideo = v;
                try { v.playbackRate = ctrl.targetRate; } catch(e) {}
              }
            } finally {
              ctrl.applyLock = false;
            }
          }
        };

        window.__YT_RATE_CTRL__ = ctrl;

        function wrapHistory(methodName) {
          var orig = history[methodName];
          history[methodName] = function() {
            var ret = orig.apply(this, arguments);
            setTimeout(function() {
              if (location.href !== ctrl.lastHref) {
                ctrl.lastHref = location.href;
                ctrl.applyNow("history_" + methodName);
              }
            }, 0);
            return ret;
          };
        }
        wrapHistory("pushState");
        wrapHistory("replaceState");

        window.addEventListener("popstate", function() {
          setTimeout(function() {
            if (location.href !== ctrl.lastHref) {
              ctrl.lastHref = location.href;
              ctrl.applyNow("popstate");
            }
          }, 0);
        });

        ctrl.postStateNow = function(reason) {
          try {
            var vv = document.querySelector("video");
            var rate = vv ? vv.playbackRate : ctrl.targetRate;
            var t = vv ? (vv.currentTime || 0) : 0;
            var url = location.href;
            var title = (document && document.title) ? document.title : "";
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage &&
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: "STATE_UPDATE",
                url: url,
                playbackRate: rate,
                currentTime: t,
                pageTitle: title
              }));
          } catch(e2) {}
        };

        ctrl._timer = setInterval(function() {
          try {
            var v = document.querySelector("video");

            if (location.href !== ctrl.lastHref) {
              ctrl.lastHref = location.href;
              ctrl.applyNow("href_poll");
            }

            if (v) {
              if (v !== ctrl.lastVideo) {
                ctrl.lastVideo = v;
                ctrl.applyNow("video_replaced");
              }

              var actual = null;
              try { actual = v.playbackRate; } catch(e) { actual = null; }

              if (actual !== null && actual !== ctrl.targetRate) {
                ctrl.applyNow("rate_changed");
              }
            }

            ctrl.postStateNow("interval");
          } catch(e) {}
        }, 1000);

        function postSoon(reason) {
          setTimeout(function() {
            try { ctrl.postStateNow(reason); } catch(e) {}
          }, 0);
        }

        try {
          document.addEventListener("visibilitychange", function() {
            if (document.visibilityState !== "visible") {
              postSoon("visibility_hidden");
            } else {
              postSoon("visibility_visible");
            }
          }, { passive: true });
        } catch(e) {}

        try { window.addEventListener("pagehide", function() { postSoon("pagehide"); }, { passive: true }); } catch(e) {}
        try { window.addEventListener("beforeunload", function() { postSoon("beforeunload"); }); } catch(e) {}

        ctrl.applyNow("boot");
        ctrl.postStateNow("boot");
        setTimeout(function(){ try { ctrl.applyNow("boot_2"); } catch(e) {} }, 700);
        setTimeout(function(){ try { ctrl.applyNow("boot_3"); } catch(e) {} }, 1600);
      } catch (e) {}
      return true;
    })();
  `;
}

function makeSetTargetRateJS(rate: number) {
  return `
    (function() {
      try {
        var ctrl = window.__YT_RATE_CTRL__;
        if (ctrl) {
          ctrl.targetRate = ${rate};
          ctrl.applyNow && ctrl.applyNow("manual_button");
          return true;
        }
        var v = document.querySelector("video");
        if (v) { try { v.playbackRate = ${rate}; } catch(e) {} }
      } catch (e) {}
      return true;
    })();
  `;
}

/**
 * Fetch URL / playback rate / current time from WebView
 */
function makeGetCurrentStateJS(reqId?: string) {
  const rid = reqId ? JSON.stringify(reqId) : "null";
  return `
    (function() {
      try {
        var v = document.querySelector("video");
        var rate = v ? v.playbackRate : 1.0;
        var t = v ? (v.currentTime || 0) : 0;
        var url = location.href;
        var title = (document && document.title) ? document.title : "";

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: "STATE_UPDATE",
          url: url,
          playbackRate: rate,
          currentTime: t,
          pageTitle: title,
          reqId: ${rid}
        }));
      } catch(e) {}
      return true;
    })();
  `;
}

function makeRestoreTimeJS(timeSec: number) {
  const t = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
  return `
    (function() {
      try {
        var target = ${t};

        function attachRestore(video) {
          try {
            if (!video) return false;

            function trySeek() {
              try {
                if (!isFinite(video.duration) || video.duration <= 0) return false;
                var clamped = Math.min(Math.max(0, target), Math.max(0, video.duration - 0.2));
                var cur = 0;
                try { cur = video.currentTime || 0; } catch(e) { cur = 0; }
                if (Math.abs(cur - clamped) <= 0.35) return true;
                video.currentTime = clamped;
                return Math.abs((video.currentTime || 0) - clamped) <= 0.35;
              } catch(e) {}
              return false;
            }

            trySeek();

            var tries = 0;
            var timer = setInterval(function() {
              tries += 1;
              var done = trySeek();
              if (done || tries >= 12) {
                clearInterval(timer);
              }
            }, 500);

            var onMaybeReady = function() {
              trySeek();
            };

            try { video.addEventListener("loadedmetadata", onMaybeReady, { passive: true }); } catch(e) {}
            try { video.addEventListener("canplay", onMaybeReady, { passive: true }); } catch(e) {}
            try { video.addEventListener("playing", onMaybeReady, { passive: true }); } catch(e) {}
            try { video.addEventListener("durationchange", onMaybeReady, { passive: true }); } catch(e) {}
            return true;
          } catch(e) {}
          return false;
        }

        function install() {
          try {
            var v = document.querySelector("video");
            if (!v) return false;
            return attachRestore(v);
          } catch(e) {}
          return false;
        }

        if (!install()) {
          setTimeout(function(){ try { install(); } catch(e) {} }, 300);
          setTimeout(function(){ try { install(); } catch(e) {} }, 900);
          setTimeout(function(){ try { install(); } catch(e) {} }, 1800);
          setTimeout(function(){ try { install(); } catch(e) {} }, 3200);
        }
      } catch(e) {}
      return true;
    })();
  `;
}

/**
 * ✅ Seek only once (avoid 3x seek)
 */
function makeSeekByJS(deltaSec: number) {
  const d = Number.isFinite(deltaSec) ? deltaSec : 0;
  return `
    (function() {
      try {
        var v = document.querySelector("video");
        if (!v) return true;

        var delta = ${d};
        var cur = 0;
        try { cur = v.currentTime || 0; } catch(e) { cur = 0; }
        var next = cur + delta;

        try {
          if (isFinite(v.duration) && v.duration > 0) {
            next = Math.min(Math.max(0, next), Math.max(0, v.duration - 0.2));
          } else {
            next = Math.max(0, next);
          }
        } catch(e) { next = Math.max(0, next); }

        try { v.currentTime = next; } catch(e) {}
      } catch(e) {}
      return true;
    })();
  `;
}

function makeNavigateToUrlJS(url: string) {
  const u = JSON.stringify(url);
  return `
    (function() {
      try {
        var target = ${u};
        if (location.href !== target) {
          location.href = target;
        }
      } catch(e) {}
      return true;
    })();
  `;
}

function makeReloadVideoElementJS() {
  return `
    (function() {
      try {
        var v = document.querySelector("video");
        if (!v) { location.reload(); return true; }

        var t = 0;
        try { t = v.currentTime || 0; } catch(e) { t = 0; }

        try { v.pause && v.pause(); } catch(e) {}
        try { v.load && v.load(); } catch(e) {}

        setTimeout(function(){
          try {
            if (isFinite(v.duration) && v.duration > 0) {
              v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.2));
            }
          } catch(e) {}
        }, 400);

        setTimeout(function(){
          try {
            var v2 = document.querySelector("video");
            if (!v2) { location.reload(); return; }
            if (typeof v2.readyState === "number" && v2.readyState < 2) {
              location.reload();
            }
          } catch(e) { try { location.reload(); } catch(_) {} }
        }, 1400);

      } catch(e) {
        try { location.reload(); } catch(_) {}
      }
      return true;
    })();
  `;
}

/**
 * ✅ Always hide "アプリを開く" / Open App UI via CSS
 */
function makeHideOpenAppCSSJS() {
  const css = `
    /* --- hide "Open app" button/promo on mobile YouTube --- */
    ytm-app-promo,
    ytm-app-promo *,
    ytm-open-app-button,
    ytm-open-app-button *,
    ytm-open-app-renderer,
    ytm-open-app-renderer *,
    ytm-open-app,
    ytm-open-app *,

    /* common top-right open app */
    a[aria-label*="アプリを開く"],
    button[aria-label*="アプリを開く"],
    a[aria-label*="Open app"],
    button[aria-label*="Open app"],

    a[href*="://play.google.com/store/apps/details"],
    a[href*="play.google.com/store/apps/details"],
    a[href*="app=yt"],
    a[href*="open_app"],
    a[href*="openapp"],

    /* fallback ids/classes seen in some builds */
    #open-app,
    #openApp,
    .open-app,
    .openApp,
    .open-app-button,
    .openAppButton {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }
  `.replace(/\n/g, " ");

  const cssJson = JSON.stringify(css);

  return `
    (function() {
      try {
        var id = "__RN_HIDE_OPEN_APP_STYLE__";
        var el = document.getElementById(id);
        if (!el) {
          el = document.createElement("style");
          el.id = id;
          el.type = "text/css";
          (document.head || document.documentElement || document.body).appendChild(el);
        }
        el.textContent = ${cssJson};
      } catch(e) {}
      return true;
    })();
  `;
}

/**
 * ✅ Hide/Show related videos + extra UI via CSS (Focus mode)
 */
function makeSetHideRelatedCSSJS(enabled: boolean) {
  const flag = enabled ? "true" : "false";
  const css = `
    /* --- related / up next --- */
    ytd-watch-next-secondary-results-renderer,
    ytd-compact-autoplay-renderer,
    ytd-watch-next-secondary-results-renderer *,
    #related,
    #related-items,
    .related-items,
    .watch-next-feed,
    ytm-watch-next-results-renderer,
    ytm-item-section-renderer[section-identifier="related-items"],
    ytm-related-item-renderer,
    ytm-compact-autoplay-renderer,
    ytm-compact-video-renderer,
    ytm-playlist-panel-renderer,
    ytm-watch-next-feed,
    ytm-slim-video-metadata-section-renderer ~ ytm-item-section-renderer {

      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }

    /* --- focus mode extras: hide like count / channel / YouTube logo --- */
    ytm-video-owner-renderer,
    ytm-channel-name,
    ytm-slim-owner-renderer,
    ytm-slim-video-metadata-section-renderer,
    ytm-slim-video-action-bar-renderer,
    ytm-like-button-renderer,
    ytm-like-button-renderer *,

    ytm-mobile-topbar-renderer,
    #mobile-topbar,
    ytm-topbar-logo-renderer,
    ytm-logo,
    .topbar-logo,
    .appbar-logo {

      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }
  `.replace(/\n/g, " ");

  const cssJson = JSON.stringify(css);

  return `
    (function() {
      try {
        var enabled = ${flag};
        var id = "__RN_HIDE_RELATED_STYLE__";
        var el = document.getElementById(id);

        if (!enabled) {
          if (el && el.parentNode) el.parentNode.removeChild(el);
          return true;
        }

        if (!el) {
          el = document.createElement("style");
          el.id = id;
          el.type = "text/css";
          document.head && document.head.appendChild(el);
        }
        el.textContent = ${cssJson};
      } catch(e) {}
      return true;
    })();
  `;
}

function normalizeYoutubeUrl(raw: string): string {
  try {
    const u = new URL(raw.replace("www.youtube.com", "m.youtube.com"));

    u.searchParams.delete("feature");
    u.searchParams.delete("si");

    if (u.pathname === "/watch") {
      u.searchParams.delete("t");
      u.searchParams.delete("pp");
    }

    return u.toString();
  } catch {
    return raw;
  }
}

function makeFavoriteId(url: string): string {
  return normalizeYoutubeUrl(url);
}

function classifyFavoriteKind(url: string): FavoriteKind {
  try {
    const u = new URL(url);
    const path = u.pathname || "";

    if (path.startsWith("/playlist") && u.searchParams.get("list")) return "playlist";
    if (path.startsWith("/watch") && u.searchParams.get("v")) return "video";
    if (path.startsWith("/shorts/")) return "video";

    if (path.startsWith("/@")) return "channel";
    if (path.startsWith("/channel/")) return "channel";
    if (path.startsWith("/c/")) return "channel";
    if (path.startsWith("/user/")) return "channel";

    return "other";
  } catch {
    return "other";
  }
}

function isWatchLikeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.pathname === "/watch" && u.searchParams.get("v")) return true;
    if (u.pathname.startsWith("/shorts/")) return true;
    return false;
  } catch {
    return false;
  }
}

function trimTitle(title: string): string {
  const t = (title || "").trim();
  if (!t) return "Untitled";
  return t.replace(/\s*-\s*YouTube\s*$/i, "").slice(0, 60);
}

function makeMemoId(createdAt: number): string {
  return `memo__${createdAt}__${Math.random().toString(16).slice(2)}`;
}

/**
 * ✅ Draggable overlay button
 */
type DraggableButtonProps = {
  id: keyof FreeLayoutConfig;
  size: number;
  pos: XY;
  setPos: (xy: XY) => void;
  screenW: number;
  screenH: number;
  editMode: boolean;
  topPad: number;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  children: React.ReactNode;
};

function DraggableButton(props: DraggableButtonProps) {
  const { size, pos, setPos, screenW, screenH, editMode, topPad, onPress, onLongPress, delayLongPress, children } = props;

  const startRef = useRef<XY>({ x: pos.x, y: pos.y });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    startRef.current = { x: pos.x, y: pos.y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.x, pos.y]);

  const clampXY = (x: number, y: number) => {
    const x2 = clamp(x, 0, Math.max(0, screenW - size));
    const y2 = clamp(y, topPad, Math.max(topPad, screenH - size));
    return { x: x2, y: y2 };
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => editMode,
        onMoveShouldSetPanResponder: (_, g) => editMode && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2),
        onPanResponderGrant: () => {
          setDragging(true);
          startRef.current = { x: pos.x, y: pos.y };
        },
        onPanResponderMove: (_, g) => {
          const next = clampXY(startRef.current.x + g.dx, startRef.current.y + g.dy);
          setPos(next);
        },
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editMode, pos.x, pos.y, screenW, screenH, topPad, size]
  );

  return (
    <View
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: size,
        height: size,
        zIndex: 200,
        opacity: dragging ? 0.95 : 1,
      }}
      pointerEvents="box-none"
      {...(editMode ? panResponder.panHandlers : {})}
    >
      <Pressable
        style={{ width: "100%", height: "100%" }}
        pointerEvents="auto"
        onPress={editMode ? undefined : onPress}
        onLongPress={editMode ? undefined : onLongPress}
        delayLongPress={delayLongPress}
      >
        {children}
      </Pressable>

      {editMode && (
        <View style={styles.editBadge} pointerEvents="none">
          <ThemedText style={styles.editBadgeText}>移動</ThemedText>
        </View>
      )}
    </View>
  );
}

/**
 * ✅ Popups should appear near the button, not jump upward.
 * - Use maxHeight instead of guessing exact height.
 * - Prefer below; if not enough space, use above.
 * ✅ Also: constrain to left/right half so ★ and ● can open together without overlapping.
 */
function popupStyleNearFlexible(
  anchor: XY,
  anchorSize: number,
  popupW: number,
  maxH: number,
  screenW: number,
  screenH: number,
  half: "left" | "right" | "any" = "any"
): ViewStyle {
  const gap = 10;
  const pad = 8;

  const halfW = screenW * 0.5;
  const maxPopupW = half === "any" ? screenW - pad * 2 : Math.max(160, halfW - pad * 2);
  const w = Math.min(popupW, maxPopupW);

  let left = clamp(anchor.x, pad, Math.max(pad, screenW - w - pad));

  if (half === "left") {
    const maxLeft = Math.max(pad, halfW - w - pad);
    left = clamp(left, pad, maxLeft);
  } else if (half === "right") {
    const minLeft = Math.min(screenW - w - pad, halfW + pad);
    left = clamp(left, minLeft, Math.max(minLeft, screenW - w - pad));
  }

  const spaceBelow = screenH - (anchor.y + anchorSize + gap);
  const spaceAbove = anchor.y - gap;

  const placeBelow = spaceBelow >= Math.min(220, maxH) || spaceBelow >= spaceAbove;

  const top = placeBelow
    ? clamp(anchor.y + anchorSize + gap, pad, Math.max(pad, screenH - pad))
    : clamp(anchor.y - gap - Math.min(maxH, spaceAbove), pad, Math.max(pad, screenH - pad));

  return {
    position: "absolute",
    left,
    top,
    width: w,
    maxHeight: Math.min(maxH, placeBelow ? Math.max(120, spaceBelow) : Math.max(120, spaceAbove)),
  };
}

export default function HomeScreen() {
  const webRef = useRef<WebView>(null);

  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [targetRate, setTargetRate] = useState<number>(1.0);

  const [resumeTimeSec, setResumeTimeSec] = useState<number>(0);

  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [starMenuOpen, setStarMenuOpen] = useState(false);

  const [favMenuOpen, setFavMenuOpen] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);

  const [webLoaded, setWebLoaded] = useState(false);
  const [webError, setWebError] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);

  const [lastSeenUrl, setLastSeenUrl] = useState<string>("");
  const [currentTitle, setCurrentTitle] = useState<string>("");

  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const lastHistoryUrlRef = useRef<string>("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  const [posMap, setPosMap] = useState<PosMap>({});
  const pendingOpenUrlRef = useRef<string | null>(null);

  const pendingStateReqRef = useRef<{
    id: string;
    resolve: (p: StateUpdatePayload) => void;
    reject: (e: any) => void;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const [bootReady, setBootReady] = useState(false);

  // Memo
  const [memoOpen, setMemoOpen] = useState(false);
  const [memoDraft, setMemoDraft] = useState("");
  const [memos, setMemos] = useState<MemoItem[]>([]);
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);
  const [editingMemoText, setEditingMemoText] = useState<string>("");

  // Skip
  // ✅ default skip seconds = 1
  const [skipStepSec, setSkipStepSec] = useState<number>(1);
  const [skipConfigOpen, setSkipConfigOpen] = useState(false);
  const [skipDraft, setSkipDraft] = useState<string>("1");

  // ✅ show/hide skip buttons
  const [skipButtonsHidden, setSkipButtonsHidden] = useState(false);

  // Layout
  const topPad = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
  const [screenW, setScreenW] = useState(Dimensions.get("window").width);
  const [screenH, setScreenH] = useState(Dimensions.get("window").height);

  // ✅ button scale (size)
  const [btnScale, setBtnScale] = useState<number>(1.0);
  const btnSizes = useMemo(() => computeBtnSizes(btnScale), [btnScale]);

  const [freeLayout, setFreeLayout] = useState<FreeLayoutConfig>(() =>
    defaultFreeLayout(screenW, screenH, topPad, computeBtnSizes(1.0))
  );
  const [layoutEditMode, setLayoutEditMode] = useState(false);

  // ✅ Theme
  const [themeMode, setThemeMode] = useState<"dark" | "light">("dark");

  // ✅ Focus mode (controls related-video hiding)
  const [focusMode, setFocusMode] = useState(false);

  // ✅ hide buttons
  const [buttonsHidden, setButtonsHidden] = useState(false);

  // ✅ custom playback rate input
  const [customRateDraft, setCustomRateDraft] = useState<string>("");

  const [rateSliderValue, setRateSliderValue] = useState<number>(1.0);
  const rateSliderInteractingRef = useRef(false);
  const restoreGuardRef = useRef<{
    url: string;
    until: number;
    expectedRate: number;
    expectedTime: number;
  }>({ url: "", until: 0, expectedRate: 1, expectedTime: 0 });

  // ✅ filter
  const [filterKeyword, setFilterKeyword] = useState<string>("");
  const [filterMode, setFilterMode] = useState<FilterMode>("none");
  const [filterLogic, setFilterLogic] = useState<FilterLogic>("and"); // ✅ AND/OR toggle for match mode

  const palette = useMemo(() => {
    const light = themeMode === "light";
    return {
      light,
      bg: light ? "#fff" : "#000",
      text: light ? "#111" : "#fff",
      textDim: light ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.65)",
      panelBg: light ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.82)",
      panelBorder: light ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.25)",
      ghostBtn: light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)",
      ghostBtnText: light ? "rgba(0,0,0,0.9)" : "rgba(255,255,255,0.9)",
      pillBorder: light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.35)",
      btnBg: "#7FDBFF",
      btnText: "#111",
      fabBg: light ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.35)",
      fabBorder: light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.35)",
    };
  }, [themeMode]);

  const youtubeUrl = useMemo(() => {
    const url = currentUrl ? currentUrl : DEFAULT_START_URL; // ✅ first run => TOP
    return url.replace("www.youtube.com", "m.youtube.com");
  }, [currentUrl]);

  const beginPlaybackRestoreGuard = (url: string, expectedRate: number, expectedTime: number) => {
    restoreGuardRef.current = {
      url: normalizeYoutubeUrl(url || ""),
      until: Date.now() + 8000,
      expectedRate: Number.isFinite(expectedRate) && expectedRate > 0 ? expectedRate : 1,
      expectedTime: Number.isFinite(expectedTime) && expectedTime > 0 ? expectedTime : 0,
    };
  };

  const isPlaybackRestoreGuardActive = (url?: string) => {
    const guard = restoreGuardRef.current;
    if (!guard.until) return false;

    if (Date.now() > guard.until) {
      restoreGuardRef.current.until = 0;
      return false;
    }

    const normUrl = normalizeYoutubeUrl(url || "");
    if (!guard.url || !normUrl) return true;
    return guard.url === normUrl;
  };

  const clearPlaybackRestoreGuard = () => {
    restoreGuardRef.current.until = 0;
  };

  const applyManualPlaybackRate = async (rate: number, closeMenu = false) => {
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) return;

    setTargetRate(r);
    setRateSliderValue(clamp(r, 1, 3));
    await saveRate(r);

    if (webLoaded) {
      webRef.current?.injectJavaScript(makeSetTargetRateJS(r));
      setTimeout(() => webRef.current?.injectJavaScript(makeGetCurrentStateJS()), 350);
    }

    if (closeMenu) {
      setRateMenuOpen(false);
    }
  };

  // -------------------------
  // Persistence helpers
  // -------------------------
  const persistThemeMode = async (m: "dark" | "light") => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.themeMode, m);
    } catch {}
  };

  const persistFocusMode = async (v: boolean) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.focusMode, v ? "1" : "0");
    } catch {}
  };

  const persistBtnScale = async (s: number) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.btnScale, String(s));
    } catch {}
  };

  const persistButtonsHidden = async (v: boolean) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.buttonsHidden, v ? "1" : "0");
    } catch {}
  };

  const persistSkipButtonsHidden = async (v: boolean) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.skipButtonsHidden, v ? "1" : "0");
    } catch {}
  };

  const persistFavorites = async (items: FavoriteItem[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(items));
    } catch {}
  };

  const persistMemos = async (items: MemoItem[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.memos, JSON.stringify(items));
    } catch {}
  };

  const persistHistory = async (items: HistoryItem[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.history, JSON.stringify(items));
    } catch {}
  };

  const persistSkipStepSec = async (sec: number) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.skipStepSec, String(Math.max(1, Math.floor(sec))));
    } catch {}
  };

  const persistFreeLayout = async (cfg: FreeLayoutConfig) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.freeLayout, JSON.stringify(cfg));
    } catch {}
  };

  const saveUrl = async (url: string) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.lastUrl, url);
    } catch {}
  };

  const saveRate = async (rate: number) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.lastRate, String(rate));
    } catch {}
  };

  const saveTime = async (timeSec: number) => {
    try {
      const t = Math.max(0, Math.floor(timeSec));
      await AsyncStorage.setItem(STORAGE_KEYS.lastTimeSec, String(t));
    } catch {}
  };

  const loadPosMap = async (): Promise<PosMap> => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEYS.posMap);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const clean: PosMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (typeof k === "string" && Number.isFinite(n) && n >= 0) clean[k] = n;
      }
      return clean;
    } catch {
      return {};
    }
  };

  const persistPosMap = async (m: PosMap) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.posMap, JSON.stringify(m));
    } catch {}
  };

  const setAndPersistPosMap = (updater: (prev: PosMap) => PosMap) => {
    setPosMap((prev) => {
      const next = updater(prev);
      persistPosMap(next);
      return next;
    });
  };

  const getSavedPositionSec = (url: string): number => {
    const key = normalizeYoutubeUrl(url);
    const v = posMap[key];
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };

  const savePositionForUrl = async (url: string, timeSec: number) => {
    const key = normalizeYoutubeUrl(url);
    const t = Math.max(0, Math.floor(timeSec));
    setAndPersistPosMap((prev) => ({ ...prev, [key]: t }));
  };

  const loadHistory = async (): Promise<HistoryItem[]> => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEYS.history);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const clean: HistoryItem[] = parsed
        .filter((x) => x && typeof x.url === "string")
        .map((x) => ({
          id: typeof x.id === "string" ? x.id : makeFavoriteId(String(x.url)),
          url: normalizeYoutubeUrl(String(x.url)),
          title: typeof x.title === "string" ? String(x.title) : "Untitled",
          kind: (x.kind as FavoriteKind) || "other",
          visitedAt: typeof x.visitedAt === "number" ? x.visitedAt : Date.now(),
        }))
        .slice(0, 10);

      return clean;
    } catch {
      return [];
    }
  };

  // ✅ history always
  const pushHistory = (url: string, pageTitle?: string) => {
    try {
      const norm = normalizeYoutubeUrl(url);
      if (!norm) return;
      if (!isWatchLikeUrl(norm)) return;

      if (lastHistoryUrlRef.current === norm) return;
      lastHistoryUrlRef.current = norm;

      const id = makeFavoriteId(norm);
      const kind = classifyFavoriteKind(norm);
      const title = trimTitle(pageTitle || "");

      setHistory((prev) => {
        const filtered = prev.filter((h) => h.id !== id);
        const next: HistoryItem[] = [{ id, url: norm, title, kind, visitedAt: Date.now() }, ...filtered].slice(0, 10);
        persistHistory(next);
        return next;
      });
    } catch {}
  };

  const clearHistory = () => {
    setHistory([]);
    persistHistory([]);
    lastHistoryUrlRef.current = "";
  };

  const loadMemos = async () => {
    try {
      let raw = await AsyncStorage.getItem(STORAGE_KEYS.memos);
      if (!raw) {
        const legacyRaw = await AsyncStorage.getItem("memosList_v1");
        if (legacyRaw) raw = legacyRaw;
      }
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const clean: MemoItem[] = parsed
        .filter((x) => x && typeof x.text === "string")
        .map((x) => ({
          id: typeof x.id === "string" ? x.id : makeMemoId(Date.now()),
          text: String(x.text),
          createdAt: typeof x.createdAt === "number" ? x.createdAt : Date.now(),
        }))
        .slice(0, 500);

      persistMemos(clean);
      return clean;
    } catch {
      return [];
    }
  };

  const getCurrentStateOnce = (timeoutMs = 1200): Promise<StateUpdatePayload> => {
    return new Promise((resolve, reject) => {
      try {
        if (pendingStateReqRef.current?.timer) {
          clearTimeout(pendingStateReqRef.current.timer);
        }
        const reqId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

        const timer = setTimeout(() => {
          if (pendingStateReqRef.current?.id === reqId) {
            pendingStateReqRef.current = null;
          }
          reject(new Error("STATE_UPDATE timeout"));
        }, timeoutMs);

        pendingStateReqRef.current = { id: reqId, resolve, reject, timer };
        webRef.current?.injectJavaScript(makeGetCurrentStateJS(reqId));
      } catch (e) {
        reject(e);
      }
    });
  };

  const flushPlaybackPositionNow = async () => {
    try {
      if (!webLoaded) {
        if (lastSeenUrl) await savePositionForUrl(lastSeenUrl, resumeTimeSec || 0);
        return;
      }

      try {
        const state = await getCurrentStateOnce(900);
        const url = state?.url ? normalizeYoutubeUrl(state.url) : lastSeenUrl;
        const t = Number.isFinite(state?.currentTime) ? state.currentTime : resumeTimeSec || 0;
        if (url) await savePositionForUrl(url, t);
      } catch {
        const url = lastSeenUrl || youtubeUrl;
        if (url) await savePositionForUrl(url, resumeTimeSec || 0);
      }
    } catch {}
  };

  const reloadCurrentVideo = async () => {
    try {
      await flushPlaybackPositionNow();

      setWebError(null);

      let url = lastSeenUrl || youtubeUrl;
      try {
        const state = await getCurrentStateOnce(900);
        if (state?.url) url = normalizeYoutubeUrl(state.url);
      } catch {}

      pendingOpenUrlRef.current = url;
      setCurrentUrl(url);
      await saveUrl(url);

      webRef.current?.injectJavaScript(makeReloadVideoElementJS());

      setTimeout(() => {
        try {
          webRef.current?.reload();
        } catch {}
      }, 900);
    } catch {}
  };

  const applyLongPressToggleButtons = () => {
    try {
      webRef.current?.injectJavaScript(makeEnableLongPressToggleButtonsJS());
    } catch {}
  };

  const applyHideOpenAppCSS = () => {
    try {
      webRef.current?.injectJavaScript(makeHideOpenAppCSSJS());
    } catch {}
  };

  const applyFocusModeCSS = (enabled: boolean) => {
    try {
      webRef.current?.injectJavaScript(makeSetHideRelatedCSSJS(enabled));
    } catch {}
  };

  const applyVideoFilter = (mode: FilterMode, keyword: string, logic: FilterLogic) => {
    try {
      setFilterMode(mode);
      webRef.current?.injectJavaScript(makeApplyVideoFilterJS(mode, keyword, logic));
    } catch {}
  };

  const reapplyVideoFilterIfNeeded = () => {
    try {
      if (filterMode === "none") return;
      const kw = (filterKeyword || "").trim();
      if (!kw) return;
      webRef.current?.injectJavaScript(makeApplyVideoFilterJS(filterMode, kw, filterLogic));
    } catch {}
  };

  const seekBy = (deltaSec: number) => {
    try {
      if (!webLoaded) return;
      webRef.current?.injectJavaScript(makeSeekByJS(deltaSec));
      setTimeout(() => webRef.current?.injectJavaScript(makeGetCurrentStateJS()), 450);
    } catch {}
  };

  const loadFreeLayout = async (w: number, h: number, sizes: BtnSizes) => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEYS.freeLayout);
      if (!raw) return null;
      const p = JSON.parse(raw);

      const safeXY = (xy: any, size: number): XY => {
        const x = Number(xy?.x);
        const y = Number(xy?.y);
        const dx = Number.isFinite(x) ? x : 0;
        const dy = Number.isFinite(y) ? y : topPad;
        return {
          x: clamp(dx, 0, Math.max(0, w - size)),
          y: clamp(dy, topPad, Math.max(topPad, h - size)),
        };
      };

      const cfg: FreeLayoutConfig = {
        star: safeXY(p?.star, sizes.star),
        speed: safeXY(p?.speed, sizes.speed),
        rewind: safeXY(p?.rewind, sizes.skip),
        forward: safeXY(p?.forward, sizes.skip),
      };
      return cfg;
    } catch {
      return null;
    }
  };

  const setPosAndPersist = (key: keyof FreeLayoutConfig, xy: XY) => {
    setFreeLayout((prev) => {
      const next: FreeLayoutConfig = { ...prev, [key]: xy };
      persistFreeLayout(next);
      return next;
    });
  };

  // ✅ reset should also set button size to 100%
  const resetLayout = async () => {
    const scale = 1.0;
    setBtnScale(scale);
    await persistBtnScale(scale);

    const sizes = computeBtnSizes(scale);
    const def = defaultFreeLayout(screenW, screenH, topPad, sizes);

    setFreeLayout(def);
    persistFreeLayout(def);
  };

  const hideAllButtons = async () => {
    setButtonsHidden(true);
    await persistButtonsHidden(true);

    setStarMenuOpen(false);
    setRateMenuOpen(false);
    setFavMenuOpen(false);
    setHistoryMenuOpen(false);
    setMemoOpen(false);
    setSkipConfigOpen(false);
    setLayoutEditMode(false);
  };

  const showAllButtons = async () => {
    setButtonsHidden(false);
    await persistButtonsHidden(false);
  };

  const toggleButtonsHidden = async () => {
    if (buttonsHidden) {
      await showAllButtons();
    } else {
      await hideAllButtons();
    }
  };

  const toggleSkipButtonsHidden = async () => {
    const next = !skipButtonsHidden;
    setSkipButtonsHidden(next);
    await persistSkipButtonsHidden(next);
  };

  // ✅ two-finger simultaneous press on rewind+forward areas toggles ALL buttons
  const multiToggleLockRef = useRef(false);

  const isInRect = (p: { x?: number; y?: number }, rect: { x: number; y: number; w: number; h: number }) => {
    const x = Number(p?.x ?? -9999);
    const y = Number(p?.y ?? -9999);
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  };

  const shouldCaptureTwoFingerToggle = (evt: any) => {
    try {
      if (layoutEditMode) return false;

      const touches = evt?.nativeEvent?.touches;
      if (!touches || touches.length !== 2) return false;

      const r1 = { x: freeLayout.rewind.x, y: freeLayout.rewind.y, w: btnSizes.skip, h: btnSizes.skip };
      const r2 = { x: freeLayout.forward.x, y: freeLayout.forward.y, w: btnSizes.skip, h: btnSizes.skip };

      const t0 = touches[0];
      const t1 = touches[1];

      // order is unknown: accept either mapping
      const a = isInRect({ x: t0.pageX, y: t0.pageY }, r1) && isInRect({ x: t1.pageX, y: t1.pageY }, r2);
      const b = isInRect({ x: t0.pageX, y: t0.pageY }, r2) && isInRect({ x: t1.pageX, y: t1.pageY }, r1);

      return a || b;
    } catch {
      return false;
    }
  };

  const twoFingerTogglePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: (evt) => {
          if (multiToggleLockRef.current) return false;
          return shouldCaptureTwoFingerToggle(evt);
        },
        onMoveShouldSetPanResponderCapture: (evt) => {
          if (multiToggleLockRef.current) return true;
          return shouldCaptureTwoFingerToggle(evt);
        },
        onPanResponderGrant: async (evt) => {
          try {
            if (multiToggleLockRef.current) return;
            if (!shouldCaptureTwoFingerToggle(evt)) return;
            multiToggleLockRef.current = true;
            await toggleButtonsHidden();
          } catch {}
        },
        onPanResponderMove: () => {},
        onPanResponderRelease: () => {
          multiToggleLockRef.current = false;
        },
        onPanResponderTerminate: () => {
          multiToggleLockRef.current = false;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [freeLayout.rewind.x, freeLayout.rewind.y, freeLayout.forward.x, freeLayout.forward.y, btnSizes.skip, layoutEditMode, buttonsHidden]
  );

  // -------------------------
  // Boot load
  // -------------------------
  useEffect(() => {
    setBootReady(false);
    (async () => {
      try {
        const savedUrl = await AsyncStorage.getItem(STORAGE_KEYS.lastUrl);
        if (savedUrl) {
          const normSavedUrl = normalizeYoutubeUrl(savedUrl);
          setCurrentUrl(normSavedUrl); // ✅ if none => stays "", so TOP
          setLastSeenUrl(normSavedUrl);
          pendingOpenUrlRef.current = normSavedUrl;
        }

        const savedRate = await AsyncStorage.getItem(STORAGE_KEYS.lastRate);
        if (savedRate) {
          const r = Number(savedRate);
          if (!Number.isNaN(r) && r >= 0.25) setTargetRate(r);
        }

        const savedTime = await AsyncStorage.getItem(STORAGE_KEYS.lastTimeSec);
        if (savedTime) {
          const t = Number(savedTime);
          if (!Number.isNaN(t) && t > 0) setResumeTimeSec(t);
        }

        const pm = await loadPosMap();
        setPosMap(pm);

        const favRaw = await AsyncStorage.getItem(STORAGE_KEYS.favorites);
        if (favRaw) {
          try {
            const parsed = JSON.parse(favRaw);
            if (Array.isArray(parsed)) {
              const clean = parsed
                .filter((x) => x && typeof x.url === "string")
                .map((x) => ({
                  id: typeof x.id === "string" ? x.id : makeFavoriteId(x.url),
                  url: String(x.url),
                  title: typeof x.title === "string" ? x.title : "Untitled",
                  label: typeof x.label === "string" ? x.label : undefined,
                  kind: (x.kind as FavoriteKind) || "other",
                  savedAt: typeof x.savedAt === "number" ? x.savedAt : Date.now(),
                }))
                .slice(0, 200);
              setFavorites(clean);
            }
          } catch {}
        }

        const memoList = await loadMemos();
        setMemos(memoList);

        const historyList = await loadHistory();
        setHistory(historyList);

        // ✅ default is now 1 sec if no saved value
        const savedSkip = await AsyncStorage.getItem(STORAGE_KEYS.skipStepSec);
        if (savedSkip) {
          const n = Number(savedSkip);
          if (Number.isFinite(n) && n >= 1) setSkipStepSec(Math.floor(n));
        } else {
          setSkipStepSec(1);
        }

        const savedTheme = await AsyncStorage.getItem(STORAGE_KEYS.themeMode);
        if (savedTheme === "light" || savedTheme === "dark") setThemeMode(savedTheme);

        const savedFocus = await AsyncStorage.getItem(STORAGE_KEYS.focusMode);
        setFocusMode(savedFocus === "1");

        const savedScaleRaw = await AsyncStorage.getItem(STORAGE_KEYS.btnScale);
        if (savedScaleRaw) {
          const s = Number(savedScaleRaw);
          if (Number.isFinite(s) && s > 0) setBtnScale(s);
        }

        const savedHidden = await AsyncStorage.getItem(STORAGE_KEYS.buttonsHidden);
        setButtonsHidden(savedHidden === "1");

        const savedSkipBtnsHidden = await AsyncStorage.getItem(STORAGE_KEYS.skipButtonsHidden);
        setSkipButtonsHidden(savedSkipBtnsHidden === "1");

        const sizesNow = computeBtnSizes(savedScaleRaw ? Number(savedScaleRaw) : 1.0);

        const loaded = await loadFreeLayout(screenW, screenH, sizesNow);
        if (loaded) setFreeLayout(loaded);
        else {
          const def = defaultFreeLayout(screenW, screenH, topPad, sizesNow);
          setFreeLayout(def);
          persistFreeLayout(def);
        }
      } catch {}
      finally {
        setBootReady(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When button size changes, re-clamp current positions (so they don't go out of bounds)
  useEffect(() => {
    setFreeLayout((prev) => {
      const next: FreeLayoutConfig = {
        star: {
          x: clamp(prev.star.x, 0, Math.max(0, screenW - btnSizes.star)),
          y: clamp(prev.star.y, topPad, Math.max(topPad, screenH - btnSizes.star)),
        },
        speed: {
          x: clamp(prev.speed.x, 0, Math.max(0, screenW - btnSizes.speed)),
          y: clamp(prev.speed.y, topPad, Math.max(topPad, screenH - btnSizes.speed)),
        },
        rewind: {
          x: clamp(prev.rewind.x, 0, Math.max(0, screenW - btnSizes.skip)),
          y: clamp(prev.rewind.y, topPad, Math.max(topPad, screenH - btnSizes.skip)),
        },
        forward: {
          x: clamp(prev.forward.x, 0, Math.max(0, screenW - btnSizes.skip)),
          y: clamp(prev.forward.y, topPad, Math.max(topPad, screenH - btnSizes.skip)),
        },
      };
      persistFreeLayout(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [btnSizes.star, btnSizes.skip, screenW, screenH, topPad]);

  // resize/rotation
  useEffect(() => {
    const sub = Dimensions.addEventListener("change", ({ window }) => {
      const w = window.width;
      const h = window.height;
      setScreenW(w);
      setScreenH(h);

      setFreeLayout((prev) => {
        const next: FreeLayoutConfig = {
          star: { x: clamp(prev.star.x, 0, Math.max(0, w - btnSizes.star)), y: clamp(prev.star.y, topPad, Math.max(topPad, h - btnSizes.star)) },
          speed: { x: clamp(prev.speed.x, 0, Math.max(0, w - btnSizes.speed)), y: clamp(prev.speed.y, topPad, Math.max(topPad, h - btnSizes.speed)) },
          rewind: { x: clamp(prev.rewind.x, 0, Math.max(0, w - btnSizes.skip)), y: clamp(prev.rewind.y, topPad, Math.max(topPad, h - btnSizes.skip)) },
          forward: { x: clamp(prev.forward.x, 0, Math.max(0, w - btnSizes.skip)), y: clamp(prev.forward.y, topPad, Math.max(topPad, h - btnSizes.skip)) },
        };
        persistFreeLayout(next);
        return next;
      });
    });

    return () => {
      // @ts-ignore
      sub?.remove?.();
    };
  }, [topPad, btnSizes.star, btnSizes.speed, btnSizes.skip]);

  // AppState
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (prev === "active" && (nextState === "inactive" || nextState === "background")) {
        await flushPlaybackPositionNow();
      }

      // ✅ If user leaves app and comes back, auto re-show buttons
      if ((prev === "inactive" || prev === "background") && nextState === "active") {
        if (buttonsHidden) {
          await showAllButtons();
        }
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webLoaded, lastSeenUrl, resumeTimeSec, youtubeUrl, posMap, buttonsHidden]);

  // Android back
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (layoutEditMode) {
        setLayoutEditMode(false);
        return true;
      }
      if (editingId) {
        setEditingId(null);
        setEditingText("");
        return true;
      }
      if (editingMemoId) {
        setEditingMemoId(null);
        setEditingMemoText("");
        return true;
      }
      if (skipConfigOpen) {
        setSkipConfigOpen(false);
        return true;
      }
      if (memoOpen) {
        setMemoOpen(false);
        return true;
      }
      if (historyMenuOpen) {
        setHistoryMenuOpen(false);
        return true;
      }
      if (favMenuOpen) {
        setFavMenuOpen(false);
        return true;
      }
      if (starMenuOpen) {
        setStarMenuOpen(false);
        return true;
      }
      if (rateMenuOpen) {
        setRateMenuOpen(false);
        return true;
      }

      if (canGoBack && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false;
    });

    return () => backHandler.remove();
  }, [canGoBack, favMenuOpen, historyMenuOpen, rateMenuOpen, editingId, memoOpen, starMenuOpen, editingMemoId, skipConfigOpen, layoutEditMode]);

  // periodic state backup
  useEffect(() => {
    const interval = setInterval(() => {
      webRef.current?.injectJavaScript(makeGetCurrentStateJS());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (rateSliderInteractingRef.current) return;
    setRateSliderValue(clamp(targetRate, 1, 3));
  }, [targetRate]);

  useEffect(() => {
    if (!bootReady) return;
    if (!webLoaded) return;
    webRef.current?.injectJavaScript(makeSetTargetRateJS(targetRate));
  }, [targetRate, bootReady, webLoaded]);

  useEffect(() => {
    if (!bootReady) return;
    if (!currentUrl) return;
    saveUrl(currentUrl);
  }, [bootReady, currentUrl]);

  useEffect(() => {
    return () => {
      flushPlaybackPositionNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeenUrl, resumeTimeSec, targetRate, currentUrl, webLoaded]);

  const handleWebViewMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data) as StateUpdatePayload | ToggleButtonsPayload | any;
      if (!data?.type) return;

      // ✅ 1秒長押しでボタン表示/非表示トグル
      if (data.type === "TOGGLE_BUTTONS") {
        await toggleButtonsHidden();
        return;
      }

      if (data.type !== "STATE_UPDATE") return;

      const typed = data as StateUpdatePayload;

      const pending = pendingStateReqRef.current;
      if (pending && typed.reqId && typed.reqId === pending.id) {
        if (pending.timer) clearTimeout(pending.timer);
        pendingStateReqRef.current = null;
        pending.resolve(typed);
      }

      let normUrl = "";
      if (typeof typed.url === "string" && typed.url.length > 0) {
        normUrl = normalizeYoutubeUrl(typed.url);
        setLastSeenUrl(normUrl);
        await saveUrl(normUrl);
      }

      if (typeof typed.pageTitle === "string") {
        setCurrentTitle(typed.pageTitle);
      }

      // ✅ history should always work even in focus mode
      if (normUrl) {
        pushHistory(normUrl, typed.pageTitle || currentTitle);
      }

      // ✅ Ensure long-press toggle is enabled (SPAで剥がれるの対策)
      applyLongPressToggleButtons();

      // ✅ Always hide "アプリを開く" (SPAで剥がれるの対策)
      applyHideOpenAppCSS();

      // ✅ Focus Mode: keep CSS applied while ON (SPAで剥がれるの対策)
      if (focusMode) {
        applyFocusModeCSS(true);
      }

      // ✅ Keep filter applied if active (also installs observer/scroll inside WebView)
      reapplyVideoFilterIfNeeded();

      const stateUrlForGuard = normUrl || (typeof typed.url === "string" ? typed.url : "");
      const guardActive = isPlaybackRestoreGuardActive(stateUrlForGuard);
      const guardedRate = restoreGuardRef.current.expectedRate;
      const guardedTime = restoreGuardRef.current.expectedTime;

      if (typeof typed.currentTime === "number" && typed.currentTime >= 0) {
        const looksLikePreRestoreZeroTime =
          guardActive && guardedTime >= 3 && typed.currentTime <= 1.5;

        if (!looksLikePreRestoreZeroTime) {
          await saveTime(typed.currentTime);
          setResumeTimeSec((prev) => (Math.abs(prev - typed.currentTime) >= 2 ? typed.currentTime : prev));

          if (typeof typed.url === "string" && typed.url.length > 0) {
            await savePositionForUrl(typed.url, typed.currentTime);
          }
        }
      }

      if (guardActive) {
        const rateRestored =
          !(guardedRate > 1.05) ||
          (typeof typed.playbackRate === "number" && Math.abs(typed.playbackRate - guardedRate) <= 0.05);
        const timeRestored =
          !(guardedTime >= 3) ||
          (typeof typed.currentTime === "number" && typed.currentTime >= Math.max(0, guardedTime - 2));

        if (rateRestored && timeRestored) {
          clearPlaybackRestoreGuard();
        }
      }
    } catch {}
  };

  const applyCustomRate = async () => {
    try {
      const n = Number(customRateDraft);
      if (!Number.isFinite(n) || n <= 0 || n > 16) return;
      await applyManualPlaybackRate(n, true);
    } catch {}
  };

  const addFavoriteCurrent = async () => {
    try {
      let url = "";
      let title = "";

      if (webLoaded) {
        try {
          const state = await getCurrentStateOnce(1300);
          url = normalizeYoutubeUrl(state.url || "");
          title = trimTitle(state.pageTitle || "");
        } catch {
          url = normalizeYoutubeUrl(lastSeenUrl || youtubeUrl);
          title = trimTitle(currentTitle);
        }
      } else {
        url = normalizeYoutubeUrl(lastSeenUrl || youtubeUrl);
        title = trimTitle(currentTitle);
      }

      const id = makeFavoriteId(url);
      const kind = classifyFavoriteKind(url);

      setFavorites((prev) => {
        const exists = prev.some((x) => x.id === id);
        if (exists) return prev;

        const next: FavoriteItem[] = [{ id, url, title, kind, savedAt: Date.now() }, ...prev].slice(0, 200);
        persistFavorites(next);
        return next;
      });
    } catch {}
  };

  const removeFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = prev.filter((x) => x.id !== id);
      persistFavorites(next);
      return next;
    });
  };

  const openFromList = async (targetUrl: string) => {
    try {
      await flushPlaybackPositionNow();

      setFavMenuOpen(false);
      setHistoryMenuOpen(false);
      setStarMenuOpen(false);
      setRateMenuOpen(false);
      setMemoOpen(false);

      setWebError(null);
      setWebLoaded(false);

      const normalized = normalizeYoutubeUrl(targetUrl);
      pendingOpenUrlRef.current = normalized;

      setCurrentUrl(normalized);
      await saveUrl(normalized);

      webRef.current?.stopLoading?.();
      webRef.current?.injectJavaScript(makeNavigateToUrlJS(normalized));
    } catch {}
  };

  const startEditLabel = (item: FavoriteItem) => {
    setEditingId(item.id);
    setEditingText((item.label ?? "").trim());
  };

  const commitEditLabel = () => {
    if (!editingId) return;
    const newLabel = editingText.trim();

    setFavorites((prev) => {
      const next = prev.map((x) => (x.id === editingId ? { ...x, label: newLabel ? newLabel : undefined } : x));
      persistFavorites(next);
      return next;
    });

    setEditingId(null);
    setEditingText("");
  };

  const cancelEditLabel = () => {
    setEditingId(null);
    setEditingText("");
  };

  const openMemoPanel = () => {
    setMemoDraft("");
    setMemoOpen(true);
    setEditingMemoId(null);
    setEditingMemoText("");
  };

  const addMemo = async () => {
    try {
      const text = memoDraft.trim();
      if (!text) return;

      const createdAt = Date.now();
      const item: MemoItem = { id: makeMemoId(createdAt), text, createdAt };

      setMemos((prev) => {
        const next = [item, ...prev].slice(0, 500);
        persistMemos(next);
        return next;
      });

      setMemoDraft("");
    } catch {}
  };

  const startEditMemo = (m: MemoItem) => {
    setEditingMemoId(m.id);
    setEditingMemoText(m.text);
  };

  const commitEditMemo = () => {
    if (!editingMemoId) return;
    const text = editingMemoText.trim();

    setMemos((prev) => {
      const next = prev.map((m) => (m.id === editingMemoId ? { ...m, text } : m));
      persistMemos(next);
      return next;
    });

    setEditingMemoId(null);
    setEditingMemoText("");
  };

  const cancelEditMemo = () => {
    setEditingMemoId(null);
    setEditingMemoText("");
  };

  const deleteMemo = (id: string) => {
    setMemos((prev) => {
      const next = prev.filter((m) => m.id !== id);
      persistMemos(next);
      return next;
    });

    if (editingMemoId === id) {
      setEditingMemoId(null);
      setEditingMemoText("");
    }
  };

  const openSkipConfig = () => {
    setSkipDraft(String(skipStepSec));
    setSkipConfigOpen(true);
    setStarMenuOpen(false);
    setRateMenuOpen(false);
    setMemoOpen(false);
  };

  const applySkipConfig = async () => {
    const n = Math.max(1, Math.floor(Number(skipDraft)));
    if (!Number.isFinite(n) || n <= 0) return;
    setSkipStepSec(n);
    await persistSkipStepSec(n);
    setSkipConfigOpen(false);
  };

  const toggleTheme = () => {
    const next = themeMode === "dark" ? "light" : "dark";
    setThemeMode(next);
    persistThemeMode(next);
  };

  const toggleFocusMode = () => {
    setFocusMode((prev) => {
      const next = !prev;
      persistFocusMode(next);

      // apply immediately
      applyFocusModeCSS(next);

      return next;
    });
  };

  // ✅ When focusMode changes, make sure CSS state matches
  useEffect(() => {
    if (!webRef.current) return;
    applyFocusModeCSS(focusMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode]);

  // ✅ enable long-press toggle + hide open-app CSS on mount
  useEffect(() => {
    if (!webRef.current) return;
    applyLongPressToggleButtons();
    applyHideOpenAppCSS();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!bootReady) {
    return (
      <View style={[styles.root, { paddingTop: topPad, backgroundColor: palette.bg }]}> 
        <View style={[styles.webNotice, { borderColor: palette.panelBorder, backgroundColor: palette.panelBg }]}> 
          <ThemedText type="subtitle" style={{ color: palette.text }}>
            読み込み中...
          </ThemedText>
          <ThemedText style={[styles.note, { color: palette.textDim }]}>前回の動画位置を復元しています</ThemedText>
        </View>
      </View>
    );
  }

  // Android only
  if (Platform.OS !== "android") {
    return (
      <View style={[styles.root, { paddingTop: topPad, backgroundColor: palette.bg }]}>
        <View style={[styles.webNotice, { borderColor: palette.panelBorder, backgroundColor: palette.panelBg }]}>
          <ThemedText type="subtitle" style={{ color: palette.text }}>
            Android Only
          </ThemedText>
          <ThemedText style={[styles.note, { color: palette.textDim }]}>This screen is designed for Android WebView.</ThemedText>
        </View>
      </View>
    );
  }

  // Popups should appear near their button, and ★/● can open together without overlapping (left/right half)
  const starPopupStyle = popupStyleNearFlexible(freeLayout.star, btnSizes.star, 260, 620, screenW, screenH, "left");
  const favPopupStyle = popupStyleNearFlexible(freeLayout.star, btnSizes.star, 320, 560, screenW, screenH, "left");
  const historyPopupStyle = popupStyleNearFlexible(freeLayout.star, btnSizes.star, 320, 560, screenW, screenH, "left");

  const ratePopupStyle = popupStyleNearFlexible(freeLayout.speed, btnSizes.speed, 340, 680, screenW, screenH, "right");
  const memoPopupStyle = popupStyleNearFlexible(freeLayout.speed, btnSizes.speed, 340, 680, screenW, screenH, "right");

  const closeAllMenus = () => {
    setStarMenuOpen(false);
    setRateMenuOpen(false);
    setFavMenuOpen(false);
    setHistoryMenuOpen(false);
    setMemoOpen(false);
    setSkipConfigOpen(false);
  };

  return (
    // ✅ attach panHandlers on root so we can capture 2-finger press even when buttons are hidden
    <View style={[styles.root, { paddingTop: topPad, backgroundColor: palette.bg }]} {...twoFingerTogglePan.panHandlers}>
      <WebView
        ref={webRef}
        source={{ uri: youtubeUrl }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction={false}
        injectedJavaScript={makeBootstrapJS(targetRate)}
        userAgent={ANDROID_CHROME_UA}
        onLoadEnd={() => {
          setWebLoaded(true);
          setWebError(null);

          const target = pendingOpenUrlRef.current || currentUrl || youtubeUrl;
          const pos = getSavedPositionSec(target);
          const restorePos = pos > 0 ? pos : resumeTimeSec;
          beginPlaybackRestoreGuard(target, targetRate, restorePos);

          const applyRestore = () => {
            webRef.current?.injectJavaScript(makeSetTargetRateJS(targetRate));

            if (restorePos > 0) {
              webRef.current?.injectJavaScript(makeRestoreTimeJS(restorePos));
            }
          };

          applyRestore();
          setTimeout(applyRestore, 700);
          setTimeout(applyRestore, 1600);
          setTimeout(applyRestore, 2800);

          // ✅ enable long-press toggle
          applyLongPressToggleButtons();

          // ✅ always hide "アプリを開く"
          applyHideOpenAppCSS();

          // ✅ focus mode controls hiding related + extras
          applyFocusModeCSS(focusMode);

          // ✅ reapply filter if active (also installs observer/scroll inside WebView)
          reapplyVideoFilterIfNeeded();

          setTimeout(() => webRef.current?.injectJavaScript(makeGetCurrentStateJS()), 900);
          setTimeout(() => webRef.current?.injectJavaScript(makeGetCurrentStateJS()), 2200);
        }}
        onError={(e) => setWebError(e?.nativeEvent?.description ?? "WebView error")}
        onHttpError={(e) => setWebError(`HTTP ${e?.nativeEvent?.statusCode ?? "?"}`)}
        onMessage={handleWebViewMessage}
        onNavigationStateChange={(navState) => {
          if (navState.canGoBack !== canGoBack) setCanGoBack(navState.canGoBack);

          // ✅ history backup from nav events
          if (navState.url) {
            const n = normalizeYoutubeUrl(navState.url);
            saveUrl(n);
            setLastSeenUrl(n);
            pendingOpenUrlRef.current = n;

            if (isWatchLikeUrl(n)) {
              pushHistory(n, currentTitle);
            }

            // ✅ keep long-press toggle even on SPA nav
            applyLongPressToggleButtons();

            // ✅ keep hide-open-app CSS even on SPA nav
            applyHideOpenAppCSS();

            if (focusMode) {
              applyFocusModeCSS(true);
            }

            // ✅ keep filter (also installs observer/scroll + blocks non-matching shorts)
            reapplyVideoFilterIfNeeded();

            setTimeout(() => webRef.current?.injectJavaScript(makeGetCurrentStateJS()), 900);
          }
        }}
      />

      {webError && (
        <View style={[styles.errorOverlay, { backgroundColor: palette.panelBg, borderColor: palette.panelBorder }]}>
          <ThemedText type="defaultSemiBold" style={{ color: palette.text }}>
            読み込みに失敗しました
          </ThemedText>
          <ThemedText style={{ color: palette.textDim, fontSize: 12 }}>{webError}</ThemedText>

          <Pressable
            style={[styles.retryBtn, { backgroundColor: palette.btnBg }]}
            onPress={() => {
              setWebError(null);
              setWebLoaded(false);
              webRef.current?.reload();
            }}
          >
            <ThemedText type="defaultSemiBold" style={{ color: palette.btnText }}>
              再読み込み
            </ThemedText>
          </Pressable>
        </View>
      )}

      {/* ✅ ALL overlay buttons hidden when buttonsHidden=true */}
      {!buttonsHidden && (
        <>
          {/* ✅ Rewind / Forward (hideable) */}
          {!skipButtonsHidden && (
            <>
              <DraggableButton
                id="rewind"
                size={btnSizes.skip}
                pos={freeLayout.rewind}
                setPos={(xy) => setPosAndPersist("rewind", xy)}
                screenW={screenW}
                screenH={screenH}
                topPad={topPad}
                editMode={layoutEditMode}
                onPress={() => seekBy(-skipStepSec)}
                onLongPress={openSkipConfig}
                delayLongPress={330}
              >
                <View
                  style={[
                    styles.skipFab,
                    {
                      width: btnSizes.skip,
                      height: btnSizes.skip,
                      backgroundColor: palette.fabBg,
                      borderColor: layoutEditMode ? "rgba(127,219,255,0.85)" : palette.fabBorder,
                    },
                  ]}
                >
                  <ThemedText style={{ color: palette.text, fontSize: 18, lineHeight: 18 }}>⟲</ThemedText>
                  <ThemedText style={{ color: palette.textDim, fontSize: 10, marginTop: 4 }}>{skipStepSec}秒</ThemedText>
                </View>
              </DraggableButton>

              <DraggableButton
                id="forward"
                size={btnSizes.skip}
                pos={freeLayout.forward}
                setPos={(xy) => setPosAndPersist("forward", xy)}
                screenW={screenW}
                screenH={screenH}
                topPad={topPad}
                editMode={layoutEditMode}
                onPress={() => seekBy(skipStepSec)}
                onLongPress={openSkipConfig}
                delayLongPress={330}
              >
                <View
                  style={[
                    styles.skipFab,
                    {
                      width: btnSizes.skip,
                      height: btnSizes.skip,
                      backgroundColor: palette.fabBg,
                      borderColor: layoutEditMode ? "rgba(127,219,255,0.85)" : palette.fabBorder,
                    },
                  ]}
                >
                  <ThemedText style={{ color: palette.text, fontSize: 18, lineHeight: 18 }}>⟳</ThemedText>
                  <ThemedText style={{ color: palette.textDim, fontSize: 10, marginTop: 4 }}>{skipStepSec}秒</ThemedText>
                </View>
              </DraggableButton>
            </>
          )}

          {/* ✅ ● speed (long-press = reload) */}
          <DraggableButton
            id="speed"
            size={btnSizes.speed}
            pos={freeLayout.speed}
            setPos={(xy) => setPosAndPersist("speed", xy)}
            screenW={screenW}
            screenH={screenH}
            topPad={topPad}
            editMode={layoutEditMode}
            onPress={() => setRateMenuOpen((v) => !v)}
            onLongPress={async () => {
              setRateMenuOpen(false);
              await reloadCurrentVideo();
            }}
            delayLongPress={350}
          >
            <View
              style={[
                styles.fab,
                {
                  width: btnSizes.speed,
                  height: btnSizes.speed,
                  backgroundColor: palette.fabBg,
                  borderColor: layoutEditMode ? "rgba(127,219,255,0.85)" : palette.fabBorder,
                },
              ]}
            >
              <ThemedText style={{ color: palette.text, fontSize: 18, lineHeight: 18 }}>●</ThemedText>
            </View>
          </DraggableButton>

          {/* ✅ ★ */}
          <DraggableButton
            id="star"
            size={btnSizes.star}
            pos={freeLayout.star}
            setPos={(xy) => setPosAndPersist("star", xy)}
            screenW={screenW}
            screenH={screenH}
            topPad={topPad}
            editMode={layoutEditMode}
            onPress={() => setStarMenuOpen((v) => !v)}
            // ✅ CHANGED: ★長押し => 集中モードON/OFF
            onLongPress={() => {
              toggleFocusMode();
              closeAllMenus();
            }}
            delayLongPress={350}
          >
            <View
              style={[
                styles.favFab,
                {
                  width: btnSizes.star,
                  height: btnSizes.star,
                  backgroundColor: palette.fabBg,
                  borderColor: layoutEditMode ? "rgba(127,219,255,0.85)" : palette.fabBorder,
                },
              ]}
            >
              <ThemedText style={{ color: palette.text, fontSize: 18, lineHeight: 18 }}>★</ThemedText>
            </View>
          </DraggableButton>
        </>
      )}

      {/* ✅ Skip-step config popup */}
      {skipConfigOpen && !buttonsHidden && (
        <View style={styles.skipConfigOverlay} pointerEvents="auto">
          <Pressable style={styles.backdropFull} onPress={() => setSkipConfigOpen(false)} />
          <View style={[styles.skipConfigPopup, { backgroundColor: palette.panelBg, borderColor: palette.panelBorder }]}>
            <ThemedText type="defaultSemiBold" style={{ color: palette.text, fontSize: 13 }}>
              何秒スキップする？
            </ThemedText>

            <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 10 }}>
              {[5, 10, 15, 30, 60].map((n) => {
                const active = Number(skipDraft) === n;
                return (
                  <Pressable
                    key={n}
                    style={[styles.skipPresetBtn, { backgroundColor: active ? palette.btnBg : palette.ghostBtn }]}
                    onPress={() => setSkipDraft(String(n))}
                  >
                    <ThemedText style={{ color: active ? palette.btnText : palette.ghostBtnText, fontSize: 12 }}>{n}秒</ThemedText>
                  </Pressable>
                );
              })}
            </View>

            <TextInput
              value={skipDraft}
              onChangeText={setSkipDraft}
              keyboardType="number-pad"
              placeholder="例: 12"
              placeholderTextColor={palette.textDim}
              style={[
                styles.skipInput,
                { color: palette.text, borderColor: palette.panelBorder, backgroundColor: palette.light ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.55)" },
              ]}
              returnKeyType="done"
              onSubmitEditing={applySkipConfig}
            />

            <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 10 }}>
              <Pressable style={[styles.skipSaveBtn, { backgroundColor: palette.btnBg }]} onPress={applySkipConfig}>
                <ThemedText type="defaultSemiBold" style={{ color: palette.btnText, fontSize: 12 }}>
                  保存
                </ThemedText>
              </Pressable>
              <Pressable style={[styles.skipCancelBtn, { backgroundColor: palette.ghostBtn }]} onPress={() => setSkipConfigOpen(false)}>
                <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText, fontSize: 12 }}>
                  キャンセル
                </ThemedText>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {/* ✅ Star quick menu */}
      {starMenuOpen && !buttonsHidden && (
        <>
          <Pressable style={styles.backdrop} onPress={() => setStarMenuOpen(false)} />
          <View style={[styles.starPopup, starPopupStyle, { backgroundColor: palette.panelBg, borderColor: palette.panelBorder }]} pointerEvents="auto">
            <ThemedText type="defaultSemiBold" style={[styles.starTitle, { color: palette.text }]}>
              ★ メニュー
            </ThemedText>

            <Pressable
              style={[styles.starActionBtnGhost, { backgroundColor: palette.ghostBtn }]}
              onPress={() => {
                setStarMenuOpen(false);
                setFavMenuOpen(true);
              }}
            >
              <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText }}>
                お気に入り
              </ThemedText>
            </Pressable>

            <Pressable
              style={[styles.starActionBtnGhost, { backgroundColor: palette.ghostBtn }]}
              onPress={() => {
                setStarMenuOpen(false);
                setHistoryMenuOpen(true);
              }}
            >
              <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText }}>
                履歴
              </ThemedText>
            </Pressable>

            <Pressable
              style={[
                styles.starActionBtnGhost,
                {
                  backgroundColor: focusMode ? "rgba(127,219,255,0.22)" : palette.ghostBtn,
                  borderWidth: focusMode ? 1 : 0,
                  borderColor: focusMode ? "rgba(127,219,255,0.60)" : "transparent",
                },
              ]}
              onPress={() => {
                toggleFocusMode();
                setStarMenuOpen(false);
              }}
            >
              <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText }}>
                {focusMode ? "集中モード: ON" : "集中モード: OFF"}
              </ThemedText>
            </Pressable>

            <Pressable style={[styles.starActionBtnGhost, { backgroundColor: palette.ghostBtn }]} onPress={toggleTheme}>
              <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText }}>
                {themeMode === "dark" ? "ライトモード" : "ダークモード"}
              </ThemedText>
            </Pressable>

            <View style={[styles.sectionDivider, { borderColor: palette.panelBorder }]} />

            <ThemedText type="defaultSemiBold" style={{ color: palette.text, marginTop: 12, fontSize: 13 }}>
              ボタン
            </ThemedText>

            <View style={styles.sizeBlock}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <ThemedText style={{ color: palette.textDim, fontSize: 12 }}>サイズ</ThemedText>
                <ThemedText style={{ color: palette.textDim, fontSize: 12 }}>{Math.round(btnScale * 100)}%</ThemedText>
              </View>

              <View style={{ marginTop: 10 }}>
                <Slider
                  value={btnScale}
                  minimumValue={0.75}
                  maximumValue={1.35}
                  step={0.01}
                  onValueChange={(v) => setBtnScale(v)}
                  onSlidingComplete={(v) => persistBtnScale(v)}
                  minimumTrackTintColor={palette.btnBg}
                  maximumTrackTintColor={palette.light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.25)"}
                  thumbTintColor={palette.btnBg}
                />
              </View>
            </View>

            <Pressable
              style={[
                styles.starActionBtnGhost,
                {
                  backgroundColor: layoutEditMode ? "rgba(127,219,255,0.22)" : palette.ghostBtn,
                  borderWidth: layoutEditMode ? 1 : 0,
                  borderColor: layoutEditMode ? "rgba(127,219,255,0.60)" : "transparent",
                },
              ]}
              onPress={() => {
                setLayoutEditMode((v) => !v);
                closeAllMenus();
              }}
            >
              <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText }}>
                {layoutEditMode ? "調整を終了" : "位置調整"}
              </ThemedText>
            </Pressable>

            <Pressable
              style={[styles.starActionBtnGhost, { backgroundColor: palette.ghostBtn }]}
              onPress={async () => {
                await resetLayout();
                setStarMenuOpen(false);
              }}
            >
              <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText }}>
                初期化
              </ThemedText>
            </Pressable>
          </View>
        </>
      )}

      {/* ✅ Favorites list popup */}
      {favMenuOpen && !buttonsHidden && (
        <>
          <Pressable style={styles.backdrop} onPress={() => setFavMenuOpen(false)} />
          <View style={[styles.favPopup, favPopupStyle, { backgroundColor: palette.panelBg, borderColor: palette.panelBorder }]} pointerEvents="auto">
            <ThemedText type="defaultSemiBold" style={[styles.favTitle, { color: palette.text }]}>
              {"お気に入り\n（★メニューから開けます）"}
            </ThemedText>

            <Pressable style={[styles.favAddBtn, { backgroundColor: palette.btnBg }]} onPress={addFavoriteCurrent}>
              <ThemedText type="defaultSemiBold" style={{ color: palette.btnText }}>
                現在のページを追加
              </ThemedText>
            </Pressable>

            {favorites.length === 0 ? (
              <ThemedText style={{ color: palette.textDim, fontSize: 12, marginTop: 8 }}>まだありません</ThemedText>
            ) : (
              <ScrollView style={{ maxHeight: 360, marginTop: 8 }} contentContainerStyle={{ paddingBottom: 6 }}>
                {favorites.map((item) => {
                  const displayName = (item.label && item.label.trim()) || item.title || "Untitled";
                  const kindLabel =
                    item.kind === "video" ? "動画" : item.kind === "channel" ? "チャンネル" : item.kind === "playlist" ? "再生リスト" : "ページ";
                  const isEditing = editingId === item.id;

                  return (
                    <View style={[styles.favItemRow, { backgroundColor: palette.light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)" }]} key={item.id}>
                      <Pressable style={{ flex: 1 }} onPress={() => !isEditing && openFromList(item.url)}>
                        {!isEditing ? (
                          <>
                            <ThemedText type="defaultSemiBold" style={{ color: palette.text, fontSize: 12 }} numberOfLines={2}>
                              {displayName}
                            </ThemedText>
                            <ThemedText style={{ color: palette.textDim, fontSize: 11 }} numberOfLines={1}>
                              {kindLabel}
                            </ThemedText>
                          </>
                        ) : (
                          <>
                            <TextInput
                              value={editingText}
                              onChangeText={setEditingText}
                              placeholder="名前（空でリセット）"
                              placeholderTextColor={palette.textDim}
                              style={[
                                styles.nameInput,
                                {
                                  color: palette.text,
                                  borderColor: palette.panelBorder,
                                  backgroundColor: palette.light ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.55)",
                                },
                              ]}
                              autoFocus
                              returnKeyType="done"
                              onSubmitEditing={commitEditLabel}
                            />
                            <ThemedText style={{ color: palette.textDim, fontSize: 11 }} numberOfLines={1}>
                              {kindLabel}
                            </ThemedText>
                          </>
                        )}
                      </Pressable>

                      {!isEditing ? (
                        <View style={styles.favRightButtons}>
                          <Pressable style={[styles.favSmallBtn, { backgroundColor: palette.ghostBtn }]} onPress={() => startEditLabel(item)}>
                            <ThemedText style={[styles.favSmallBtnText, { color: palette.ghostBtnText }]}>名前変更</ThemedText>
                          </Pressable>

                          <Pressable style={[styles.favDeleteBtn, { backgroundColor: palette.btnBg }]} onPress={() => removeFavorite(item.id)}>
                            <ThemedText style={{ color: palette.btnText, fontSize: 12 }}>削除</ThemedText>
                          </Pressable>
                        </View>
                      ) : (
                        <View style={styles.favRightButtons}>
                          <Pressable style={[styles.favSmallBtn, { backgroundColor: palette.ghostBtn }]} onPress={commitEditLabel}>
                            <ThemedText style={[styles.favSmallBtnText, { color: palette.ghostBtnText }]}>保存</ThemedText>
                          </Pressable>
                          <Pressable style={[styles.favSmallBtnCancel, { backgroundColor: palette.ghostBtn }]} onPress={cancelEditLabel}>
                            <ThemedText style={[styles.favSmallBtnText, { color: palette.ghostBtnText }]}>×</ThemedText>
                          </Pressable>
                        </View>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </>
      )}

      {/* ✅ History popup */}
      {historyMenuOpen && !buttonsHidden && (
        <>
          <Pressable style={styles.backdrop} onPress={() => setHistoryMenuOpen(false)} />
          <View style={[styles.historyPopup, historyPopupStyle, { backgroundColor: palette.panelBg, borderColor: palette.panelBorder }]} pointerEvents="auto">
            <ThemedText type="defaultSemiBold" style={[styles.favTitle, { color: palette.text }]}>
              履歴（最新10件）
            </ThemedText>

            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Pressable style={[styles.historyClearBtn, { backgroundColor: palette.btnBg }]} onPress={clearHistory}>
                <ThemedText type="defaultSemiBold" style={{ color: palette.btnText, fontSize: 12 }}>
                  クリア
                </ThemedText>
              </Pressable>
            </View>

            {history.length === 0 ? (
              <ThemedText style={{ color: palette.textDim, fontSize: 12, marginTop: 8 }}>まだありません</ThemedText>
            ) : (
              <ScrollView style={{ maxHeight: 360, marginTop: 8 }} contentContainerStyle={{ paddingBottom: 6 }}>
                {history.map((item) => {
                  const kindLabel =
                    item.kind === "video" ? "動画" : item.kind === "channel" ? "チャンネル" : item.kind === "playlist" ? "再生リスト" : "ページ";

                  return (
                    <View style={[styles.favItemRow, { backgroundColor: palette.light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)" }]} key={item.id}>
                      <Pressable style={{ flex: 1 }} onPress={() => openFromList(item.url)}>
                        <ThemedText type="defaultSemiBold" style={{ color: palette.text, fontSize: 12 }} numberOfLines={2}>
                          {item.title || "Untitled"}
                        </ThemedText>
                        <ThemedText style={{ color: palette.textDim, fontSize: 11 }} numberOfLines={1}>
                          {kindLabel}
                        </ThemedText>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </>
      )}

      {/* ✅ Speed popup */}
      {rateMenuOpen && !buttonsHidden && (
        <>
          <Pressable style={styles.backdrop} onPress={() => setRateMenuOpen(false)} />
          <View style={[styles.ratePopup, ratePopupStyle, { backgroundColor: palette.panelBg, borderColor: palette.panelBorder }]} pointerEvents="auto">
            <ThemedText type="defaultSemiBold" style={[styles.rateTitle, { color: palette.text }]}>
              再生速度 {targetRate.toFixed(1)}x
            </ThemedText>

            <View style={{ marginTop: 8 }}>
              <Slider
                value={rateSliderValue}
                minimumValue={1}
                maximumValue={3}
                step={0.5}
                onSlidingStart={() => {
                  rateSliderInteractingRef.current = true;
                }}
                onValueChange={(v) => {
                  setRateSliderValue(v);
                }}
                onSlidingComplete={async (v) => {
                  rateSliderInteractingRef.current = false;
                  const r = Number(v);
                  await applyManualPlaybackRate(clamp(r, 1, 3));
                }}
                minimumTrackTintColor={palette.btnBg}
                maximumTrackTintColor={palette.light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.25)"}
                thumbTintColor={palette.btnBg}
              />
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                <ThemedText style={{ color: palette.textDim, fontSize: 11 }}>1.0x</ThemedText>
                <ThemedText style={{ color: palette.textDim, fontSize: 11 }}>3.0x</ThemedText>
              </View>
            </View>

            <View style={{ marginTop: 10 }}>
              <ThemedText style={{ color: palette.textDim, fontSize: 12 }}>カスタム倍率（16倍まで）</ThemedText>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
                <TextInput
                  value={customRateDraft}
                  onChangeText={setCustomRateDraft}
                  keyboardType="decimal-pad"
                  placeholder="例: 2.5"
                  placeholderTextColor={palette.textDim}
                  style={[
                    styles.customRateInput,
                    {
                      color: palette.text,
                      borderColor: palette.panelBorder,
                      backgroundColor: palette.light ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.55)",
                    },
                  ]}
                  returnKeyType="done"
                  onSubmitEditing={applyCustomRate}
                />
                <Pressable style={[styles.customRateApplyBtn, { backgroundColor: palette.btnBg }]} onPress={applyCustomRate}>
                  <ThemedText type="defaultSemiBold" style={{ color: palette.btnText, fontSize: 12 }}>
                    適用
                  </ThemedText>
                </Pressable>
              </View>
            </View>

            <Pressable
              style={[styles.actionBtn, { backgroundColor: palette.btnBg }]}
              onPress={async () => {
                setRateMenuOpen(false);
                await reloadCurrentVideo();
              }}
            >
              <ThemedText type="defaultSemiBold" style={{ color: palette.btnText }}>
                再読み込み
              </ThemedText>
            </Pressable>

            <Pressable
              style={[styles.actionBtn, { backgroundColor: palette.ghostBtn, marginTop: 8 }]}
              onPress={() => {
                setRateMenuOpen(false);
                openMemoPanel();
              }}
            >
              <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText }}>
                メモ
              </ThemedText>
            </Pressable>

            <View style={[styles.filterBlock, { borderColor: palette.panelBorder }]}>
              <ThemedText style={{ color: palette.textDim, fontSize: 12 }}>検索フィルタ</ThemedText>

              <TextInput
                value={filterKeyword}
                onChangeText={setFilterKeyword}
                placeholder="ワード（例: 料理 レシピ）"
                placeholderTextColor={palette.textDim}
                style={[
                  styles.filterInput,
                  {
                    color: palette.text,
                    borderColor: palette.panelBorder,
                    backgroundColor: palette.light ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.55)",
                  },
                ]}
                returnKeyType="done"
                onSubmitEditing={() => {
                  const kw = filterKeyword.trim();
                  if (!kw) return;
                  applyVideoFilter(filterMode === "none" ? "match" : filterMode, kw, filterLogic);
                }}
              />

              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
                <Pressable
                  style={[styles.filterBtn, { backgroundColor: filterLogic === "and" ? palette.btnBg : palette.ghostBtn }]}
                  onPress={() => {
                    setFilterLogic("and");
                    const kw = filterKeyword.trim();
                    if (!kw) return;
                    if (filterMode === "none") return;
                    webRef.current?.injectJavaScript(makeApplyVideoFilterJS(filterMode, kw, "and"));
                  }}
                >
                  <ThemedText style={{ color: filterLogic === "and" ? palette.btnText : palette.ghostBtnText, fontSize: 12 }}>AND</ThemedText>
                </Pressable>

                <Pressable
                  style={[styles.filterBtn, { backgroundColor: filterLogic === "or" ? palette.btnBg : palette.ghostBtn }]}
                  onPress={() => {
                    setFilterLogic("or");
                    const kw = filterKeyword.trim();
                    if (!kw) return;
                    if (filterMode === "none") return;
                    webRef.current?.injectJavaScript(makeApplyVideoFilterJS(filterMode, kw, "or"));
                  }}
                >
                  <ThemedText style={{ color: filterLogic === "or" ? palette.btnText : palette.ghostBtnText, fontSize: 12 }}>OR</ThemedText>
                </Pressable>
              </View>

              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
                <Pressable
                  style={[styles.filterBtn, { backgroundColor: filterMode === "match" ? palette.btnBg : palette.ghostBtn }]}
                  onPress={() => {
                    const kw = filterKeyword.trim();
                    if (!kw) return;
                    applyVideoFilter("match", kw, filterLogic);
                    setRateMenuOpen(false);
                  }}
                >
                  <ThemedText style={{ color: filterMode === "match" ? palette.btnText : palette.ghostBtnText, fontSize: 12 }}>一致検索</ThemedText>
                </Pressable>

                <Pressable
                  style={[styles.filterBtn, { backgroundColor: filterMode === "exclude" ? palette.btnBg : palette.ghostBtn }]}
                  onPress={() => {
                    const kw = filterKeyword.trim();
                    if (!kw) return;
                    applyVideoFilter("exclude", kw, filterLogic);
                    setRateMenuOpen(false);
                  }}
                >
                  <ThemedText style={{ color: filterMode === "exclude" ? palette.btnText : palette.ghostBtnText, fontSize: 12 }}>除外検索</ThemedText>
                </Pressable>

                <Pressable
                  style={[styles.filterBtn, { backgroundColor: palette.ghostBtn }]}
                  onPress={() => {
                    setFilterMode("none");
                    webRef.current?.injectJavaScript(makeApplyVideoFilterJS("none", "", filterLogic));
                    setRateMenuOpen(false);
                  }}
                >
                  <ThemedText style={{ color: palette.ghostBtnText, fontSize: 12 }}>解除</ThemedText>
                </Pressable>
              </View>
            </View>
          </View>
        </>
      )}

      {/* ✅ Memo popup */}
      {memoOpen && !buttonsHidden && (
        <>
          <Pressable
            style={styles.backdrop}
            onPress={() => {
              setMemoOpen(false);
              setEditingMemoId(null);
              setEditingMemoText("");
            }}
          />
          <View style={[styles.memoPopup, memoPopupStyle, { backgroundColor: palette.panelBg, borderColor: palette.panelBorder }]} pointerEvents="auto">
            <ThemedText type="defaultSemiBold" style={[styles.memoTitle, { color: palette.text }]}>
              メモ
            </ThemedText>

            {editingMemoId ? (
              <>
                <TextInput
                  value={editingMemoText}
                  onChangeText={setEditingMemoText}
                  placeholder="編集..."
                  placeholderTextColor={palette.textDim}
                  style={[
                    styles.memoInput,
                    {
                      color: palette.text,
                      borderColor: palette.panelBorder,
                      backgroundColor: palette.light ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.55)",
                    },
                  ]}
                  multiline
                  textAlignVertical="top"
                  autoFocus
                />

                <View style={styles.memoBtnRow}>
                  <Pressable style={[styles.memoBtn, { backgroundColor: palette.btnBg }]} onPress={commitEditMemo}>
                    <ThemedText type="defaultSemiBold" style={{ color: palette.btnText, fontSize: 12 }}>
                      保存
                    </ThemedText>
                  </Pressable>

                  <Pressable style={[styles.memoBtnGhost2, { backgroundColor: palette.ghostBtn }]} onPress={cancelEditMemo}>
                    <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText, fontSize: 12 }}>
                      キャンセル
                    </ThemedText>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <TextInput
                  value={memoDraft}
                  onChangeText={setMemoDraft}
                  placeholder="ここにメモを記入"
                  placeholderTextColor={palette.textDim}
                  style={[
                    styles.memoInput,
                    {
                      color: palette.text,
                      borderColor: palette.panelBorder,
                      backgroundColor: palette.light ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.55)",
                    },
                  ]}
                  multiline
                  textAlignVertical="top"
                />

                <View style={styles.memoBtnRow}>
                  <Pressable style={[styles.memoBtn, { backgroundColor: palette.btnBg }]} onPress={addMemo}>
                    <ThemedText type="defaultSemiBold" style={{ color: palette.btnText, fontSize: 12 }}>
                      追加
                    </ThemedText>
                  </Pressable>

                  <Pressable style={[styles.memoBtnGhost2, { backgroundColor: palette.ghostBtn }]} onPress={() => setMemoDraft("")}>
                    <ThemedText type="defaultSemiBold" style={{ color: palette.ghostBtnText, fontSize: 12 }}>
                      クリア
                    </ThemedText>
                  </Pressable>
                </View>
              </>
            )}

            <View style={[styles.memoListBlock, { borderColor: palette.panelBorder }]}>
              <ThemedText style={{ color: palette.textDim, fontSize: 12 }}>メモ一覧</ThemedText>

              {memos.length === 0 ? (
                <ThemedText style={{ color: palette.textDim, fontSize: 12, marginTop: 8 }}>まだありません</ThemedText>
              ) : (
                <ScrollView style={{ maxHeight: 260, marginTop: 8 }} contentContainerStyle={{ paddingBottom: 6 }}>
                  {memos.map((m) => (
                    <View key={m.id} style={[styles.memoItemRow, { backgroundColor: palette.light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)" }]}>
                      <Pressable style={{ flex: 1 }} onPress={() => startEditMemo(m)}>
                        <ThemedText style={{ color: palette.text, fontSize: 12 }} numberOfLines={4}>
                          {m.text}
                        </ThemedText>
                      </Pressable>

                      <View style={{ alignItems: "flex-end", marginLeft: 10 }}>
                        <Pressable style={[styles.memoSmallBtn, { backgroundColor: palette.ghostBtn }]} onPress={() => startEditMemo(m)}>
                          <ThemedText style={{ color: palette.ghostBtnText, fontSize: 11 }}>編集</ThemedText>
                        </Pressable>

                        <Pressable style={[styles.memoDeleteBtn, { backgroundColor: palette.btnBg, marginTop: 8 }]} onPress={() => deleteMemo(m.id)}>
                          <ThemedText style={{ color: palette.btnText, fontSize: 11 }}>削除</ThemedText>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        </>
      )}

      {layoutEditMode && !buttonsHidden && (
        <View style={[styles.layoutHint, { backgroundColor: palette.panelBg, borderColor: "rgba(127,219,255,0.35)" }]} pointerEvents="none">
          <ThemedText style={[styles.layoutHintText, { color: palette.text }]}>ドラッグで自由に配置できます。★ →「調整を終了」で完了。</ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  webNotice: {
    margin: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  note: { fontSize: 12, opacity: 0.8 },

  errorOverlay: {
    position: "absolute",
    left: 12,
    right: 12,
    top: 60,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    zIndex: 300,
  },
  retryBtn: {
    marginTop: 10,
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
  },

  backdrop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 250,
    backgroundColor: "transparent",
  },
  backdropFull: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "transparent",
  },

  editBadge: {
    position: "absolute",
    right: -10,
    top: -10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: "rgba(127,219,255,0.9)",
  },
  editBadgeText: {
    color: "#111",
    fontSize: 10,
    letterSpacing: 0.5,
  },

  favFab: {
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  fab: {
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },

  skipFab: {
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },

  starPopup: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    zIndex: 260,
    overflow: "hidden",
  },
  starTitle: { marginBottom: 10, fontSize: 13 },

  starActionBtnGhost: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center",
  },

  sectionDivider: {
    marginTop: 10,
    borderTopWidth: 1,
  },

  sizeBlock: {
    marginTop: 10,
  },

  favPopup: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    zIndex: 260,
    overflow: "hidden",
  },
  favTitle: { marginBottom: 10, fontSize: 13 },

  historyPopup: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    zIndex: 260,
    overflow: "hidden",
  },
  historyClearBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignSelf: "flex-start",
  },

  favAddBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center",
  },

  favItemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
    marginBottom: 8,
  },

  favRightButtons: {
    alignItems: "flex-end",
    justifyContent: "center",
  },

  favDeleteBtn: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignSelf: "flex-start",
  },

  favSmallBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignSelf: "flex-start",
  },
  favSmallBtnCancel: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignSelf: "flex-start",
  },
  favSmallBtnText: { fontSize: 12 },

  nameInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 12,
    marginBottom: 6,
  },

  memoPopup: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    zIndex: 260,
    overflow: "hidden",
  },
  memoTitle: { fontSize: 13 },

  memoInput: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 12,
    minHeight: 90,
  },

  memoBtnRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 8,
    flexWrap: "wrap",
  },
  memoBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginLeft: 8,
    marginTop: 8,
  },
  memoBtnGhost2: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginLeft: 8,
    marginTop: 8,
  },

  memoListBlock: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
  },

  memoItemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
    marginBottom: 8,
  },

  memoSmallBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignSelf: "flex-start",
  },

  memoDeleteBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignSelf: "flex-start",
  },

  ratePopup: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    zIndex: 260,
    overflow: "hidden",
  },
  rateTitle: { marginBottom: 10, fontSize: 13 },

  customRateInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 12,
  },
  customRateApplyBtn: {
    marginLeft: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
  },

  actionBtn: {
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center",
  },

  filterBlock: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  filterInput: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 12,
  },
  filterBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    marginRight: 8,
    marginBottom: 8,
  },

  skipConfigOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "flex-end",
    padding: 12,
    zIndex: 999,
  },
  skipConfigPopup: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  skipPresetBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    marginRight: 8,
    marginBottom: 8,
  },
  skipInput: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 12,
  },
  skipSaveBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginLeft: 8,
  },
  skipCancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginLeft: 8,
  },

  layoutHint: {
    position: "absolute",
    left: 10,
    right: 10,
    top: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    zIndex: 120,
  },
  layoutHintText: {
    fontSize: 12,
    textAlign: "center",
  },
});
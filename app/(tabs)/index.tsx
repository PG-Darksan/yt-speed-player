import { ThemedText } from "@/components/themed-text";
import React, { useMemo, useRef, useState } from "react";
import { Platform, Pressable, StatusBar, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

/**
 * WebView内で常駐させるスクリプト
 * - window.__YT_RATE_CTRL__ に targetRate と applyNow を生やす
 * - YouTubeのSPA遷移やvideo差し替えを検知して、常に targetRate を適用
 */
function makeBootstrapJS(initialRate: number) {
  return `
    (function() {
      try {
        // すでに注入済みなら初期倍率だけ更新して終了
        if (window.__YT_RATE_CTRL__) {
          window.__YT_RATE_CTRL__.targetRate = ${initialRate};
          window.__YT_RATE_CTRL__.applyNow && window.__YT_RATE_CTRL__.applyNow("reinjected");
          true; return;
        }

        var ctrl = {
          targetRate: ${initialRate},
          lastHref: location.href,
          lastVideo: null,
          timer: null,
          obs: null,
          applyLock: false,
          applyNow: function(reason) {
            if (ctrl.applyLock) return;
            ctrl.applyLock = true;
            try {
              var v = document.querySelector("video");
              ctrl.lastVideo = v || null;

              if (v) {
                try { v.playbackRate = ctrl.targetRate; } catch(e) {}
              }
            } finally {
              ctrl.applyLock = false;
            }
          }
        };

        window.__YT_RATE_CTRL__ = ctrl;

        // URL変化（SPA遷移）を検知して再適用
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

        // DOM変化（video差し替え）を検知して再適用
        ctrl.obs = new MutationObserver(function() {
          var v = document.querySelector("video");
          if (v && v !== ctrl.lastVideo) {
            ctrl.lastVideo = v;
            ctrl.applyNow("video_replaced");
          }
        });
        ctrl.obs.observe(document.documentElement, { childList: true, subtree: true });

        // 戻されたら再適用（強制維持）
        ctrl.timer = setInterval(function() {
          var v = document.querySelector("video");

          // SPA遷移保険
          if (location.href !== ctrl.lastHref) {
            ctrl.lastHref = location.href;
            ctrl.applyNow("href_poll");
            return;
          }

          if (!v) return;

          var actual = null;
          try { actual = v.playbackRate; } catch(e) { actual = null; }

          if (actual !== null && actual !== ctrl.targetRate) {
            ctrl.applyNow("rate_changed");
          }
        }, 500);

        ctrl.applyNow("boot");
      } catch (e) {
        // noop
      }
      true;
    })();
  `;
}

/**
 * ボタン押下時に確実に効かせるためのJS
 * injectJavaScript で targetRate を直に更新→applyNow
 */
function makeSetTargetRateJS(rate: number) {
  return `
    (function() {
      try {
        var ctrl = window.__YT_RATE_CTRL__;
        if (!ctrl) { return true; }
        ctrl.targetRate = ${rate};
        ctrl.applyNow && ctrl.applyNow("manual_button");
      } catch (e) {}
      true;
    })();
  `;
}

export default function HomeScreen() {
  const webRef = useRef<WebView>(null);

  // 固定の動画（必要ならここを変える）
  const [videoId] = useState("dQw4w9WgXcQ");

  const rateOptions: number[] = [1, 1.5, 2, 2.5, 3];
  const [targetRate, setTargetRate] = useState<number>(3);

  // ★ 追加：速度メニューの開閉
  const [rateMenuOpen, setRateMenuOpen] = useState(false);

  const youtubeUrl = useMemo(() => {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }, [videoId]);

  const topPad = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;

  const onPressRate = (r: number) => {
    setTargetRate(r);
    if (Platform.OS !== "web") {
      webRef.current?.injectJavaScript(makeSetTargetRateJS(r));
    }
    // ★ 追加：選んだら閉じる（気になるならこの行消せば開きっぱにもできる）
    setRateMenuOpen(false);
  };

  if (Platform.OS === "web") {
    return (
      <View style={[styles.root, { paddingTop: topPad }]}>
        <View style={styles.webNotice}>
          <ThemedText type="subtitle">WebではWebView注入は使えません</ThemedText>
          <ThemedText style={styles.note}>
            Expo Goでスマホ（Android/iOS）から開いてください。
          </ThemedText>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: topPad }]}>
      {/* 全画面 WebView */}
      <WebView
        ref={webRef}
        source={{ uri: youtubeUrl }}
        javaScriptEnabled
        domStorageEnabled
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        injectedJavaScript={makeBootstrapJS(targetRate)}
        onLoadEnd={() => {
          // ロード直後に「今のtarget」を強制適用
          webRef.current?.injectJavaScript(makeSetTargetRateJS(targetRate));
        }}
      />

      {/* ★ 左上：小さい「速度」ボタン + 押したら倍率一覧 */}
      <View style={[styles.overlayTopLeft, { top: 10 + topPad }]}>
        <Pressable
          style={styles.speedToggle}
          onPress={() => setRateMenuOpen((v) => !v)}
        >
          <ThemedText type="defaultSemiBold" style={styles.speedToggleText}>
            速度
          </ThemedText>
          {/* いまの倍率を小さく見せたいならここを残す。不要なら削除OK */}
          <ThemedText style={styles.speedToggleSub}>{targetRate}x</ThemedText>
        </Pressable>

        {rateMenuOpen && (
          <View style={styles.ratePopup}>
            <View style={styles.rateRow}>
              {rateOptions.map((r) => {
                const active = r === targetRate;
                return (
                  <Pressable
                    key={r}
                    style={[styles.rateButton, active ? styles.rateButtonActive : null]}
                    onPress={() => onPressRate(r)}
                  >
                    <ThemedText
                      type="defaultSemiBold"
                      style={[styles.rateText, active ? styles.rateTextActive : null]}
                    >
                      {r}x
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </View>

      {/* ★ 画面のどこかを押したら閉じる…をやりたければ
          WebViewの上に透明オーバーレイを置く必要があるので、必要なら言って！ */}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },

  webNotice: {
    margin: 12,
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  note: { fontSize: 12, opacity: 0.7 },

  // ★ 左上固定
  overlayTopLeft: {
    position: "absolute",
    left: 10,
    alignItems: "flex-start",
  },

  // ★「速度」ボタン（小さめ）
  speedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  speedToggleText: {
    color: "#fff",
    fontSize: 12,
  },
  speedToggleSub: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 11,
  },

  // ★ ポップアップ（倍率一覧）
  ratePopup: {
    marginTop: 8,
    padding: 10,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
  },

  rateRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },

  // 非アクティブ：半透明の黒
  rateButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },

  // アクティブ：水色
  rateButtonActive: {
    backgroundColor: "#7FDBFF",
    borderColor: "#7FDBFF",
  },

  rateText: {
    color: "#fff",
    fontSize: 12,
  },
  rateTextActive: {
    color: "#111",
  },
});

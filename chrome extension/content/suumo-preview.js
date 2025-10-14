// content/suumo-preview.js
(function () {
  if (window.__suumoPreviewHooked) return;
  window.__suumoPreviewHooked = true;
  console.log("[Texel][content] suumo-preview loaded");

  // =========== Helpers ===========
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const ABS  = (u) => { try { return new URL(u, location.href).href; } catch { return u || ""; } };
  const textOf = (el) => norm(el ? (el.innerText || el.textContent || "") : "");
  const htmlToText = (el) => {
    if (!el) return "";
    const h = (el.innerHTML || "").replace(/<br\s*\/?>/gi, "\n").replace(/&nbsp;/gi, " ");
    const tmp = document.createElement("div");
    tmp.innerHTML = h;
    return norm(tmp.innerText || tmp.textContent || "");
  };

  // サムネURL → 高解像度の resizeImage に正規化（直リンク /gazo/... は避ける）
  function toFullImageUrl(u) {
    try {
      const abs = new URL(u, location.href);

      // 既に resizeImage の場合は w/h を増やして返す
      if (/\/resizeImage/i.test(abs.pathname)) {
        const hi = new URL(abs.href);
        hi.searchParams.set("w", "1600");
        hi.searchParams.set("h", "1200");
        return hi.href;
      }

      // /gazo/... は案件によって直リンク不可 → resizeImage 化
      if (/\/gazo\//i.test(abs.pathname)) {
        const rel = (abs.pathname + abs.search).replace(/^\//, "");
        const hi = new URL(
          `/chukai/jj/common/resizeImage?src=${encodeURIComponent(rel)}&w=1600&h=1200`,
          location.origin
        );
        return hi.href;
      }

      return abs.href;
    } catch {
      return u || "";
    }
  }

  // ==== 同一オリジンで画像を Base64(DataURL) に変換（404/サイズ違いフォールバック付き） ====
  async function fetchAsBase64(url) {
    const first = new URL(url, location.href);
    const tryUrls = [first.href];

    // /gazo/... が来たら resizeImage に変換して試す
    if (!/\/resizeImage/i.test(first.pathname) && /\/gazo\//i.test(first.pathname)) {
      const rel = (first.pathname + first.search).replace(/^\//, "");
      tryUrls.push(new URL(
        `/chukai/jj/common/resizeImage?src=${encodeURIComponent(rel)}&w=1600&h=1200`,
        location.origin
      ).href);
    }

    // 既に resizeImage の場合でも w/h が小さければ上げて再試行
    if (/\/resizeImage/i.test(first.pathname)) {
      const hi = new URL(first.href);
      const w = +(hi.searchParams.get("w") || 0);
      const h = +(hi.searchParams.get("h") || 0);
      if (w < 1600 || h < 1200) {
        hi.searchParams.set("w", "1600");
        hi.searchParams.set("h", "1200");
        tryUrls.push(hi.href);
      }
    }

    let lastErr = null;
    for (const candidate of tryUrls) {
      try {
        const res = await fetch(candidate, { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const mime = blob.type || "image/jpeg";
        const buf  = await blob.arrayBuffer();

        // ArrayBuffer -> Base64
        let binary = "";
        const bytes = new Uint8Array(buf);
        const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        }
        return `data:${mime};base64,${btoa(binary)}`;
      } catch (e) {
        lastErr = e; // 次を試す
      }
    }
    throw lastErr || new Error("fetchAsBase64 failed");
  }

  // 複数URLを順次 Base64 化
  async function fetchImagesBase64(urls = []) {
    const out = [];
    for (const u of urls) {
      try {
        const b64 = await fetchAsBase64(u);
        out.push({ url: u, ok: true, base64: b64 });
      } catch (e) {
        out.push({ url: u, ok: false, error: e?.message || String(e) });
      }
    }
    return out;
  }

  // =========== Main scrape ===========
  function scrape() {
    // 物件コード（bc/bkcどちらでも拾う）
    const bk =
      document.querySelector('input[name="bukkenCd"]')?.value?.trim() ||
      new URL(location.href).searchParams.get("bc") ||
      new URL(location.href).searchParams.get("bkc") ||
      document.getElementById("js-bukken_code")?.textContent?.trim() ||
      "";

    const title =
      norm(document.querySelector(".mainIndexK")?.textContent || "") ||
      norm(document.querySelector("h1,h2")?.textContent || "");

    // 表から汎用的に key/value 抽出
    const kv = {};
    document.querySelectorAll("table").forEach(tbl => {
      tbl.querySelectorAll("tr").forEach(tr => {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        const k = textOf(th);
        const v = textOf(td);
        if (k && v) kv[k] = v;
      });
    });
    const getByLabels = (labels) => {
      for (const label of labels) {
        if (kv[label]) return kv[label];
        const hit = Object.keys(kv).find(k => k.includes(label));
        if (hit) return kv[hit];
      }
      return "";
    };

    // 主要項目
    const price   = getByLabels(["価格", "賃料"]);
    const plan    = getByLabels(["間取り", "間取"]);
    const area    = getByLabels(["専有面積", "面積"]);
    const balcony = getByLabels(["バルコニー面積", "バルコニー"]);
    const floor   = getByLabels(["所在階", "階数"]);
    const dir     = getByLabels(["向き", "方位"]);
    const built   = getByLabels(["築年月", "完成時期", "完成時期(築年月)"]);
    const addr    = getByLabels(["所在地", "住所"]);
    const traffic = getByLabels(["交通", "アクセス"]);
    const reno    = getByLabels(["リフォーム", "リノベーション"]);
    const total   = getByLabels(["総戸数"]);
    const struct  = getByLabels(["構造", "構造・階建"]);
    const rights  = getByLabels(["土地権利", "敷地の権利形態", "所有権"]);
    const manage  = getByLabels(["管理形態", "管理会社", "管理費"]);
    const parking = getByLabels(["駐車場"]);
    const energy  = getByLabels(["エネルギー消費性能", "省エネ"]);

    // 画像ブロック（ご提示DOMに合わせて安全に）
    const root = document.querySelector(".mt20 .cf.w910.ph5.pb5") || document.body;

    const pickSrc = (img) =>
      img.getAttribute("rel") ||
      img.currentSrc ||
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy") ||
      "";

    const mainBlock   = root.querySelector(".fl.w454.mt5");
    const mainImg     = mainBlock?.querySelector("img") || null;
    const mainCaption = textOf(mainBlock?.parentElement?.querySelector(".bw.mt10"));

    const upperLis  = Array.from(root.querySelectorAll(".fr.ofh.w450 ul.cf.w456 > li"));
    const lowerLis  = Array.from(root.querySelectorAll(".fl.ofh.w910  ul.cf.w928  > li"));

    function imgItemFrom(liOrImg, extraCaption = "") {
      const img = liOrImg.tagName === "IMG" ? liOrImg : liOrImg.querySelector("img");
      if (!img) return null;
      const thumb = ABS(pickSrc(img));
      const full  = toFullImageUrl(thumb);
      const alt   = img.getAttribute("alt") || "";
      let caption = extraCaption;
      if (!caption && liOrImg.querySelector) {
        caption = textOf(liOrImg.querySelector(".w222")) || "";
      }
      return {
        url: full,
        thumbUrl: thumb,
        alt,
        caption,
        w: img.naturalWidth || img.width || 0,
        h: img.naturalHeight || img.height || 0
      };
    }

    const items = [];
    if (mainImg) {
      const it = imgItemFrom(mainImg, mainCaption);
      if (it) items.push(it);
    }
    for (const li of upperLis) {
      const it = imgItemFrom(li);
      if (it) items.push(it);
    }
    for (const li of lowerLis) {
      const it = imgItemFrom(li);
      if (it) items.push(it);
    }

    // 間取り推定
    const isFloorplanByText = (x) =>
      /間取|間取り|間取図|madori|floor-?plan/i.test(x.alt) ||
      /madori|floor-?plan/i.test(x.url) ||
      /間取図|区画図/.test(x.caption || "");

    const isProbablyFloorplanByShape = (x) => {
      const min = Math.min(x.w || 0, x.h || 0);
      const ar = (x.w && x.h) ? x.w / x.h : 1;
      return min >= 200 && ar >= 0.6 && ar <= 2.2;
    };

    let floorplan = items.find(isFloorplanByText) || null;
    if (!floorplan) floorplan = items.find(isProbablyFloorplanByShape) || null;

    // 室内写真（タイトル/説明付き）
    const roomImages = [];
    const seen = new Set();
    for (const it of items) {
      if (floorplan && it.url === floorplan.url) continue;
      if (!it.url || seen.has(it.url)) continue;
      if (/logo|sprite|\.gif(\?|$)/i.test(it.url)) continue;
      seen.add(it.url);
      roomImages.push({ url: it.url, title: it.alt || "", desc: it.caption || "" });
    }

    // おすすめ・特徴・イベント
    const recommendEls = Array.from(document.querySelectorAll("p.fs14, .fs14 p, .fs14"))
      .filter(el => /おすすめポイント|▼立地|▼特徴|▼設備|リフォーム|周辺環境/.test(el.innerText || el.textContent || ""));
    const recommendText = recommendEls.map(htmlToText).filter(Boolean).join("\n\n");

    let featureItems = [];
    Array.from(document.querySelectorAll("div.mt10")).forEach(d => {
      const parts = (d.textContent || "").split("/").map(x => norm(x)).filter(Boolean);
      if (parts.some(p => /(沿線|スーパー|リフォーム|キッチン|乾燥機|収納|洗面|対面|セキュ|張替|温水|フローリング|WIC|ウォークイン|ペット|小学校|エレベーター|食器洗|浄水)/.test(p))) {
        featureItems.push(...parts);
      }
    });
    featureItems = Array.from(new Set(featureItems));

    const eventP = Array.from(document.querySelectorAll("p.mt5"))
      .find(p => /(現地見学会|内覧会|予約制)/.test(p.innerText || p.textContent || ""));
    const eventInfo = eventP ? htmlToText(eventP) : "";

    const details = {
      price, plan, area, balcony, floor, direction: dir, built,
      address: addr, traffic, renovation: reno, totalUnits: total,
      structure: struct, landRights: rights, management: manage,
      parking, energyPerformance: energy,
      features: featureItems, eventInfo, recommendRaw: recommendText
    };

    // メモ用テキスト
    const lines = [];
    if (title)    lines.push(`・物件名：${title}`);
    if (addr)     lines.push(`・所在地：${addr}`);
    if (traffic)  lines.push(`・交通：${traffic}`);
    if (plan)     lines.push(`・間取り：${plan}`);
    if (area)     lines.push(`・専有面積：${area}`);
    if (balcony)  lines.push(`・バルコニー：${balcony}`);
    if (floor)    lines.push(`・所在階：${floor}`);
    if (dir)      lines.push(`・向き：${dir}`);
    if (built)    lines.push(`・築年月：${built}`);
    if (price)    lines.push(`・価格：${price}`);
    if (reno)     lines.push(`・リフォーム：${reno}`);
    if (struct)   lines.push(`・構造：${struct}`);
    if (total)    lines.push(`・総戸数：${total}`);
    if (rights)   lines.push(`・権利：${rights}`);
    if (manage)   lines.push(`・管理：${manage}`);
    if (parking)  lines.push(`・駐車場：${parking}`);
    if (recommendText) { lines.push("— 物件のおすすめポイント —"); lines.push(recommendText); }
    if (featureItems.length) { lines.push("— 特徴・設備 —"); lines.push(featureItems.map(i => `・${i}`).join("\n")); }
    if (eventInfo) { lines.push("— 現地見学会 —"); lines.push(eventInfo); }
    const memoText = lines.join("\n");

    return {
      ok: true,
      bk,
      title,
      memoText,
      floorplanUrl: floorplan ? floorplan.url : "",
      // 互換：従来の配列
      roomImageUrls: roomImages.map(x => x.url),
      // 新規：キャプション付き
      roomImages,
      details
    };
  }

  // =========== Messaging ===========
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SCRAPE_SUUMO_PREVIEW") {
      try { sendResponse(scrape()); }
      catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
      return true;
    }
    if (msg?.type === "FETCH_IMAGES_BASE64") {
      (async () => {
        try {
          const result = await fetchImagesBase64(msg.urls || []);
          sendResponse({ ok: true, result });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }
  });
})();

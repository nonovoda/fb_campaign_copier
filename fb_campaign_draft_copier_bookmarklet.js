(() => {
  // ============================================
  // FB Campaign Draft Copier
  // Test build: copy campaign hierarchy between ad accounts
  // Campaign -> Ad Sets -> Ads
  // ============================================

  const Config = {
    VERSION: "2026.05.06-test.1",
    API_VERSION: "v23.0",
    API_URL: "https://graph.facebook.com/v23.0/",
    ROOT_ID: "ywb-campaign-copier-root",
    STYLE_ID: "ywb-campaign-copier-styles"
  };

  class Logger {
    constructor(ui = null) {
      this.ui = ui;
    }

    setUI(ui) {
      this.ui = ui;
    }

    log(message, type = "info") {
      if (this.ui && this.ui.log) this.ui.log(message, type);
      const prefix = `[FB Campaign Copier][${type}]`;
      if (type === "error") console.error(prefix, message);
      else if (type === "warning") console.warn(prefix, message);
      else console.log(prefix, message);
    }

    info(message) { this.log(message, "info"); }
    success(message) { this.log(message, "success"); }
    warning(message) { this.log(message, "warning"); }
    error(message) { this.log(message, "error"); }
  }

  const logger = new Logger();

  class FbApi {
    constructor() {
      this.apiUrl = Config.API_URL;
      this.requestTimeoutMs = 45000;
      this.nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
    }

    async fetchWithFallback(finalUrl, options) {
      if (this.nativeFetch) {
        return this.nativeFetch(finalUrl, options);
      }

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options?.method || "GET", finalUrl, true);
        xhr.withCredentials = true;
        xhr.onload = () => {
          const headers = new Headers();
          const rawHeaders = xhr.getAllResponseHeaders().trim().split(/[\r\n]+/);
          rawHeaders.forEach(line => {
            const parts = line.split(": ");
            const header = parts.shift();
            const value = parts.join(": ");
            if (header) headers.append(header, value);
          });

          resolve(new Response(xhr.responseText, {
            status: xhr.status,
            statusText: xhr.statusText,
            headers
          }));
        };
        xhr.onerror = () => reject(new Error("XHR network error"));
        if (options?.headers) {
          Object.entries(options.headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
        }
        xhr.send(options?.body || null);
      });
    }

    getAccessToken() {
      const token = window.__accessToken;
      if (!token) {
        throw new Error("Не найден window.__accessToken. Открой Ads Manager / Business Manager и запусти скрипт там.");
      }
      return token;
    }

    async requestJson(finalUrl, options = {}) {
      let timeoutId = null;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Request timeout after ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs);
      });

      try {
        const response = await Promise.race([
          this.fetchWithFallback(finalUrl, options),
          timeoutPromise
        ]);

        const text = await response.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : {};
        } catch (_error) {
          json = { raw: text };
        }

        if (!response.ok || json?.error) {
          const message = json?.error?.message || text || `HTTP ${response.status}`;
          throw new Error(message);
        }

        return json;
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
      }
    }

    async get(path, qs = "") {
      const token = this.getAccessToken();
      let finalUrl = path.startsWith("http") ? path : this.apiUrl + path;

      if (qs) {
        finalUrl += finalUrl.includes("?") ? `&${qs}` : `?${qs}`;
      }

      if (!finalUrl.includes("access_token=")) {
        finalUrl += finalUrl.includes("?")
          ? `&access_token=${encodeURIComponent(token)}`
          : `?access_token=${encodeURIComponent(token)}`;
      }

      return this.requestJson(finalUrl, {
        method: "GET",
        mode: "cors",
        credentials: "include",
        referrer: "https://business.facebook.com/",
        referrerPolicy: "strict-origin-when-cross-origin"
      });
    }

    async post(path, body = {}) {
      const token = this.getAccessToken();
      const finalUrl = path.startsWith("http") ? path : this.apiUrl + path;
      const payload = { ...body, access_token: token };

      return this.requestJson(finalUrl, {
        method: "POST",
        mode: "cors",
        credentials: "include",
        referrer: "https://business.facebook.com/",
        referrerPolicy: "origin-when-cross-origin",
        headers: {
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(payload).toString()
      });
    }

    async getAllPages(path, qs = "") {
      let items = [];
      let page = await this.get(path, qs);

      if (Array.isArray(page?.data)) {
        items = items.concat(page.data);
      }

      while (page?.paging?.next) {
        page = await this.get(page.paging.next);
        if (Array.isArray(page?.data)) {
          items = items.concat(page.data);
        }
      }

      return items;
    }
  }

  const API = new FbApi();

  const Utils = {
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    safeJson(value) {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    },

    cleanName(name, suffix) {
      const base = name || "Copied campaign";
      return `${base} ${suffix}`.trim();
    },

    removeUndefined(obj) {
      return Object.fromEntries(
        Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== "")
      );
    },

    optionLabel(account) {
      const id = account.account_id || String(account.id || "").replace("act_", "");
      return `${id} — ${account.name || "Без названия"}`;
    }
  };

  class AccountManager {
    constructor() {
      this.accounts = [];
    }


    async loadViaMeAdAccounts() {
      return API.getAllPages("me/adaccounts", "fields=id,account_id,name,account_status,currency,timezone_name&limit=200");
    }

    async loadViaMeFields() {
      const result = await API.get("me", "fields=adaccounts.limit(200){id,account_id,name,account_status,currency,timezone_name}");
      return Array.isArray(result?.adaccounts?.data) ? result.adaccounts.data : [];
    }

    normalizeAccounts(accounts) {
      return accounts.map(acc => ({
        id: String(acc.id || `act_${acc.account_id}`).replace("act_", ""),
        account_id: acc.account_id || String(acc.id || "").replace("act_", ""),
        name: acc.name || acc.account_id || acc.id,
        status: acc.account_status,
        currency: acc.currency,
        timezone_name: acc.timezone_name
      }));
    }

    async loadAll() {
      logger.info("Загружаю рекламные аккаунты...");

      let accounts = [];
      try {
        accounts = await this.loadViaMeAdAccounts();
      } catch (error) {
        logger.warning(`me/adaccounts недоступен: ${error.message || error}`);
      }

      if (!accounts.length) {
        try {
          accounts = await this.loadViaMeFields();
        } catch (error) {
          logger.warning(`me?fields=adaccounts недоступен: ${error.message || error}`);
        }
      }

      this.accounts = this.normalizeAccounts(accounts);

      if (!this.accounts.length) {
        logger.warning("Аккаунты не найдены. Убедись, что открыт Ads Manager нужного Business и есть права ads_management/ads_read.");
      }

      logger.success(`Загружено аккаунтов: ${this.accounts.length}`);
      return this.accounts;
    }

    getAll() {
      return this.accounts;
    }

    find(id) {
      return this.accounts.find(acc => acc.account_id === id || acc.id === id);
    }
  }

  const accountManager = new AccountManager();

  class CampaignCopier {
    constructor() {
      this.created = {
        campaignId: null,
        adSetMap: new Map(),
        adMap: new Map(),
        creativeMap: new Map()
      };
    }

    async loadCampaigns(accountId) {
      logger.info(`Загружаю кампании из ${accountId}...`);

      const fields = [
        "id",
        "name",
        "objective",
        "status",
        "configured_status",
        "effective_status",
        "buying_type",
        "special_ad_categories",
        "special_ad_category_country",
        "bid_strategy",
        "daily_budget",
        "lifetime_budget",
        "budget_remaining",
        "spend_cap",
        "start_time",
        "stop_time",
        "smart_promotion_type",
        "is_skadnetwork_attribution",
        "source_campaign_id"
      ].join(",");

      const statusFilter = encodeURIComponent(JSON.stringify(["ACTIVE","PAUSED","ARCHIVED","DELETED","IN_PROCESS","WITH_ISSUES"]));
      let campaigns = await API.getAllPages(`act_${accountId}/campaigns`, `fields=${fields}&effective_status=${statusFilter}&limit=200`);

      if (!campaigns.length) {
        logger.warning("Кампании не найдены через effective_status фильтр. Пробую запрос без фильтра...");
        campaigns = await API.getAllPages(`act_${accountId}/campaigns`, `fields=${fields}&limit=200`);
      }
      logger.success(`Найдено кампаний: ${campaigns.length}`);
      return campaigns;
    }

    async loadCampaignFullTree(campaignId) {
      logger.info(`Читаю кампанию ${campaignId}...`);

      const campaignFields = [
        "id",
        "name",
        "objective",
        "status",
        "configured_status",
        "buying_type",
        "special_ad_categories",
        "special_ad_category_country",
        "bid_strategy",
        "daily_budget",
        "lifetime_budget",
        "spend_cap",
        "start_time",
        "stop_time",
        "smart_promotion_type",
        "is_skadnetwork_attribution"
      ].join(",");

      const campaign = await API.get(campaignId, `fields=${campaignFields}`);

      logger.info(`Читаю группы объявлений...`);
      const adSetFields = [
        "id",
        "name",
        "status",
        "configured_status",
        "daily_budget",
        "lifetime_budget",
        "bid_amount",
        "bid_strategy",
        "billing_event",
        "optimization_goal",
        "destination_type",
        "promoted_object",
        "targeting",
        "attribution_spec",
        "start_time",
        "end_time",
        "pacing_type",
        "is_dynamic_creative",
        "use_new_app_click",
        "frequency_control_specs",
        "dsa_beneficiary",
        "dsa_payor"
      ].join(",");

      const adsets = await API.getAllPages(`${campaignId}/adsets`, `fields=${adSetFields}&limit=200`);
      logger.success(`Групп объявлений: ${adsets.length}`);

      const adsByAdSet = new Map();

      const adFields = [
        "id",
        "name",
        "status",
        "configured_status",
        "creative{id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,authorization_category,body,title,call_to_action_type,image_hash,image_url,thumbnail_url,video_id,object_type,object_url,link_url,url_tags}",
        "tracking_specs",
        "conversion_specs"
      ].join(",");

      for (const adset of adsets) {
        logger.info(`Читаю объявления из adset: ${adset.name}`);
        const ads = await API.getAllPages(`${adset.id}/ads`, `fields=${adFields}&limit=200`);
        adsByAdSet.set(adset.id, ads);
        logger.success(`${adset.name}: объявлений ${ads.length}`);
      }

      return { campaign, adsets, adsByAdSet };
    }

    buildCampaignPayload(sourceCampaign, targetAccountId, nameSuffix) {
      const payload = {
        name: Utils.cleanName(sourceCampaign.name, nameSuffix),
        objective: sourceCampaign.objective,
        buying_type: sourceCampaign.buying_type,
        status: sourceCampaign.status || sourceCampaign.configured_status || "PAUSED",
        special_ad_categories: Utils.safeJson(sourceCampaign.special_ad_categories || []),
        special_ad_category_country: Utils.safeJson(sourceCampaign.special_ad_category_country),
        bid_strategy: sourceCampaign.bid_strategy,
        daily_budget: sourceCampaign.daily_budget,
        lifetime_budget: sourceCampaign.lifetime_budget,
        spend_cap: sourceCampaign.spend_cap,
        start_time: sourceCampaign.start_time,
        stop_time: sourceCampaign.stop_time,
        smart_promotion_type: sourceCampaign.smart_promotion_type,
        is_skadnetwork_attribution: sourceCampaign.is_skadnetwork_attribution
      };

      return Utils.removeUndefined(payload);
    }

    buildAdSetPayload(sourceAdSet, newCampaignId, nameSuffix) {
      const payload = {
        name: Utils.cleanName(sourceAdSet.name, nameSuffix),
        campaign_id: newCampaignId,
        status: sourceAdSet.status || sourceAdSet.configured_status || "PAUSED",
        daily_budget: sourceAdSet.daily_budget,
        lifetime_budget: sourceAdSet.lifetime_budget,
        bid_amount: sourceAdSet.bid_amount,
        bid_strategy: sourceAdSet.bid_strategy,
        billing_event: sourceAdSet.billing_event,
        optimization_goal: sourceAdSet.optimization_goal,
        destination_type: sourceAdSet.destination_type,
        promoted_object: Utils.safeJson(sourceAdSet.promoted_object),
        targeting: Utils.safeJson(sourceAdSet.targeting),
        attribution_spec: Utils.safeJson(sourceAdSet.attribution_spec),
        start_time: sourceAdSet.start_time,
        end_time: sourceAdSet.end_time,
        pacing_type: Utils.safeJson(sourceAdSet.pacing_type),
        is_dynamic_creative: sourceAdSet.is_dynamic_creative,
        use_new_app_click: sourceAdSet.use_new_app_click,
        frequency_control_specs: Utils.safeJson(sourceAdSet.frequency_control_specs),
        dsa_beneficiary: sourceAdSet.dsa_beneficiary,
        dsa_payor: sourceAdSet.dsa_payor
      };

      return Utils.removeUndefined(payload);
    }

    buildCreativePayload(sourceCreative, targetAccountId, nameSuffix) {
      if (!sourceCreative) return null;

      const payload = {
        name: Utils.cleanName(sourceCreative.name || "Copied creative", nameSuffix),
        object_story_spec: Utils.safeJson(sourceCreative.object_story_spec),
        asset_feed_spec: Utils.safeJson(sourceCreative.asset_feed_spec),
        degrees_of_freedom_spec: Utils.safeJson(sourceCreative.degrees_of_freedom_spec),
        authorization_category: sourceCreative.authorization_category,
        body: sourceCreative.body,
        title: sourceCreative.title,
        call_to_action_type: sourceCreative.call_to_action_type,
        image_hash: sourceCreative.image_hash,
        video_id: sourceCreative.video_id,
        object_url: sourceCreative.object_url,
        link_url: sourceCreative.link_url,
        url_tags: sourceCreative.url_tags
      };

      return Utils.removeUndefined(payload);
    }

    buildAdPayload(sourceAd, newAdSetId, newCreativeId, nameSuffix) {
      const payload = {
        name: Utils.cleanName(sourceAd.name, nameSuffix),
        adset_id: newAdSetId,
        creative: Utils.safeJson({ creative_id: newCreativeId }),
        status: sourceAd.status || sourceAd.configured_status || "PAUSED",
        tracking_specs: Utils.safeJson(sourceAd.tracking_specs),
        conversion_specs: Utils.safeJson(sourceAd.conversion_specs)
      };

      return Utils.removeUndefined(payload);
    }

    async copyCampaign({ sourceAccountId, targetAccountId, campaignId, copyAds = true, nameSuffix = "[copy]" }) {
      this.created = {
        campaignId: null,
        adSetMap: new Map(),
        adMap: new Map(),
        creativeMap: new Map()
      };

      logger.info("Начинаю копирование...");
      logger.info(`Источник: ${sourceAccountId}`);
      logger.info(`Цель: ${targetAccountId}`);
      logger.info(`Кампания: ${campaignId}`);

      const tree = await this.loadCampaignFullTree(campaignId);
      const { campaign, adsets, adsByAdSet } = tree;

      logger.info(`Создаю кампанию: ${campaign.name}`);
      const campaignPayload = this.buildCampaignPayload(campaign, targetAccountId, nameSuffix);
      const createdCampaign = await API.post(`act_${targetAccountId}/campaigns`, campaignPayload);

      const newCampaignId = createdCampaign.id;
      if (!newCampaignId) throw new Error(`Кампания не создана: ${JSON.stringify(createdCampaign)}`);

      this.created.campaignId = newCampaignId;
      logger.success(`Кампания создана: ${newCampaignId}`);

      for (const sourceAdSet of adsets) {
        logger.info(`Создаю adset: ${sourceAdSet.name}`);
        const adSetPayload = this.buildAdSetPayload(sourceAdSet, newCampaignId, nameSuffix);
        const createdAdSet = await API.post(`act_${targetAccountId}/adsets`, adSetPayload);
        const newAdSetId = createdAdSet.id;

        if (!newAdSetId) {
          logger.error(`Adset не создан: ${sourceAdSet.name} — ${JSON.stringify(createdAdSet)}`);
          continue;
        }

        this.created.adSetMap.set(sourceAdSet.id, newAdSetId);
        logger.success(`Adset создан: ${sourceAdSet.name} → ${newAdSetId}`);

        if (!copyAds) continue;

        const ads = adsByAdSet.get(sourceAdSet.id) || [];
        for (const sourceAd of ads) {
          try {
            const sourceCreative = sourceAd.creative;
            let newCreativeId = null;

            if (sourceCreative?.id) {
              if (this.created.creativeMap.has(sourceCreative.id)) {
                newCreativeId = this.created.creativeMap.get(sourceCreative.id);
              } else {
                logger.info(`Создаю creative для ad: ${sourceAd.name}`);
                const creativePayload = this.buildCreativePayload(sourceCreative, targetAccountId, nameSuffix);

                if (!creativePayload || Object.keys(creativePayload).length <= 1) {
                  throw new Error("Недостаточно данных creative для пересоздания.");
                }

                const createdCreative = await API.post(`act_${targetAccountId}/adcreatives`, creativePayload);
                newCreativeId = createdCreative.id;

                if (!newCreativeId) {
                  throw new Error(`Creative не создан: ${JSON.stringify(createdCreative)}`);
                }

                this.created.creativeMap.set(sourceCreative.id, newCreativeId);
                logger.success(`Creative создан: ${sourceCreative.id} → ${newCreativeId}`);
              }
            }

            if (!newCreativeId) {
              throw new Error("Нет creative_id для создания объявления.");
            }

            logger.info(`Создаю ad: ${sourceAd.name}`);
            const adPayload = this.buildAdPayload(sourceAd, newAdSetId, newCreativeId, nameSuffix);
            const createdAd = await API.post(`act_${targetAccountId}/ads`, adPayload);

            if (!createdAd.id) {
              throw new Error(`Ad не создан: ${JSON.stringify(createdAd)}`);
            }

            this.created.adMap.set(sourceAd.id, createdAd.id);
            logger.success(`Ad создан: ${sourceAd.name} → ${createdAd.id}`);
          } catch (error) {
            logger.warning(`Ad пропущен: ${sourceAd.name}. Причина: ${error.message || error}`);
          }
        }
      }

      logger.success("Копирование завершено.");
      logger.success(`Новая кампания: ${newCampaignId}`);

      return {
        campaignId: newCampaignId,
        adsetsCreated: this.created.adSetMap.size,
        adsCreated: this.created.adMap.size,
        creativesCreated: this.created.creativeMap.size
      };
    }
  }

  const campaignCopier = new CampaignCopier();

  class CampaignCopierUI {
    constructor() {
      this.root = null;
      this.logArea = null;
      this.accounts = [];
      this.campaigns = [];
      this.selectedSourceAccountId = "";
      this.selectedTargetAccountId = "";
      this.selectedCampaignId = "";
      this.buttons = {};
    }

    ensureStyles() {
      if (document.getElementById(Config.STYLE_ID)) return;

      const style = document.createElement("style");
      style.id = Config.STYLE_ID;
      style.textContent = `
        #${Config.ROOT_ID} {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: min(620px, calc(100vw - 24px));
          max-height: calc(100vh - 24px);
          overflow-y: auto;
          z-index: 2147483647;
          border-radius: 16px;
          border: 1px solid rgba(89, 130, 113, 0.38);
          background: rgba(13, 21, 19, 0.97);
          color: #e9ffef;
          box-shadow: 0 22px 55px rgba(0, 0, 0, 0.48);
          padding: 18px;
          font: 13px/1.4 Inter, "Segoe UI", Arial, sans-serif;
        }
        #${Config.ROOT_ID} * { box-sizing: border-box; }
        #${Config.ROOT_ID} h2 { margin: 0; color: #4dff8f; font-size: 22px; text-align: center; }
        #${Config.ROOT_ID} .subtitle { margin: 5px 0 14px; color: #9eb7a7; font-size: 12px; text-align: center; }
        #${Config.ROOT_ID} .close {
          position: absolute;
          top: 10px;
          right: 10px;
          width: 32px;
          height: 32px;
          border-radius: 9px;
          border: 1px solid rgba(89, 130, 113, 0.45);
          background: rgba(11, 19, 17, 0.95);
          color: #d6f3e2;
          font-size: 18px;
          cursor: pointer;
        }
        #${Config.ROOT_ID} .close:hover { border-color: #4dff8f; color: #4dff8f; }
        #${Config.ROOT_ID} .section { margin: 10px 0; }
        #${Config.ROOT_ID} label { display: block; margin-bottom: 6px; font-size: 12px; color: #b9d2c3; font-weight: 700; }
        #${Config.ROOT_ID} select,
        #${Config.ROOT_ID} input[type="text"] {
          width: 100%;
          border: 1px solid #2f4a40;
          border-radius: 9px;
          background: #121f1b;
          color: #e8fff0;
          padding: 9px;
          font-size: 13px;
        }
        #${Config.ROOT_ID} .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        #${Config.ROOT_ID} .checkbox-row { display: flex; align-items: center; gap: 8px; color: #b9d2c3; font-size: 12px; }
        #${Config.ROOT_ID} .checkbox-row input { accent-color: #4dff8f; }
        #${Config.ROOT_ID} .btn {
          width: 100%;
          min-height: 42px;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid #4dff8f;
          background: linear-gradient(150deg, #4dff8f 0%, #00ff66 100%);
          color: #031609;
          font-weight: 800;
          font-size: 13px;
          cursor: pointer;
          margin-top: 10px;
        }
        #${Config.ROOT_ID} .btn.secondary {
          background: #121f1b;
          color: #e8fff0;
          border-color: #2f4a40;
        }
        #${Config.ROOT_ID} .btn:disabled { opacity: .65; cursor: not-allowed; }
        #${Config.ROOT_ID} .log {
          width: 100%;
          height: 190px;
          overflow-y: auto;
          background: #0b1210;
          border: 1px solid #22372f;
          border-radius: 10px;
          padding: 8px;
          font-size: 11px;
          line-height: 1.4;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        }
        #${Config.ROOT_ID} .hint { color: #9eb7a7; font-size: 11px; margin-top: 5px; }
        #${Config.ROOT_ID} a { color: #7ddaa3; text-decoration: none; }
        #${Config.ROOT_ID} a:hover { color: #4dff8f; }
      `;

      document.head.appendChild(style);
    }

    createRoot() {
      const old = document.getElementById(Config.ROOT_ID);
      if (old) old.remove();

      this.root = document.createElement("div");
      this.root.id = Config.ROOT_ID;

      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "×";
      close.onclick = () => this.root.remove();

      const title = document.createElement("h2");
      title.textContent = "FB Campaign Draft Copier";

      const subtitle = document.createElement("div");
      subtitle.className = "subtitle";
      subtitle.textContent = `v ${Config.VERSION}`;

      this.root.append(close, title, subtitle);
      return this.root;
    }

    createSection(labelText, element) {
      const section = document.createElement("div");
      section.className = "section";

      const label = document.createElement("label");
      label.textContent = labelText;

      section.append(label, element);
      return section;
    }

    createButton(id, text, onClick, secondary = false) {
      const button = document.createElement("button");
      button.id = id;
      button.className = secondary ? "btn secondary" : "btn";
      button.textContent = text;
      button.dataset.originalText = text;
      this.buttons[id] = button;

      button.onclick = async () => {
        this.setButtonLoading(id, true);
        try {
          await onClick();
        } catch (error) {
          logger.error(error.message || String(error));
        } finally {
          this.setButtonLoading(id, false);
        }
      };

      return button;
    }

    setButtonLoading(id, loading) {
      const button = this.buttons[id];
      if (!button) return;
      button.disabled = loading;
      button.textContent = loading ? "Выполняется..." : button.dataset.originalText;
    }

    fillAccountSelect(select, placeholder) {
      select.innerHTML = "";

      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.disabled = true;
      defaultOption.selected = true;
      defaultOption.textContent = placeholder;
      select.appendChild(defaultOption);

      this.accounts.forEach(acc => {
        const option = document.createElement("option");
        option.value = acc.account_id;
        option.textContent = Utils.optionLabel(acc);
        select.appendChild(option);
      });
    }

    refreshCampaignSelect() {
      const select = document.getElementById("ywbCampaignSelect");
      if (!select) return;

      select.innerHTML = "";

      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.disabled = true;
      defaultOption.selected = true;
      defaultOption.textContent = this.campaigns.length ? "-- Выберите кампанию --" : "-- Сначала выберите source РК --";
      select.appendChild(defaultOption);

      this.campaigns.forEach(campaign => {
        const option = document.createElement("option");
        option.value = campaign.id;
        option.textContent = `${campaign.name} · ${campaign.effective_status || campaign.configured_status || campaign.status || "unknown"} · ${campaign.id}`;
        select.appendChild(option);
      });
    }

    createLogArea() {
      const section = document.createElement("div");
      section.className = "section";

      const label = document.createElement("label");
      label.textContent = "Лог:";

      this.logArea = document.createElement("div");
      this.logArea.className = "log";

      section.append(label, this.logArea);
      return section;
    }

    log(message, type = "info") {
      if (!this.logArea) return;

      const item = document.createElement("div");
      item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

      if (type === "error") item.style.color = "#ff8f8f";
      else if (type === "success") item.style.color = "#9bff7d";
      else if (type === "warning") item.style.color = "#ffd27a";
      else item.style.color = "#d4e8db";

      this.logArea.appendChild(item);
      this.logArea.scrollTop = this.logArea.scrollHeight;
    }

    async show() {
      this.ensureStyles();
      const root = this.createRoot();

      const sourceSelect = document.createElement("select");
      sourceSelect.id = "ywbSourceAccountSelect";
      sourceSelect.onchange = async () => {
        this.selectedSourceAccountId = sourceSelect.value;
        this.selectedCampaignId = "";
        this.campaigns = [];
        this.refreshCampaignSelect();

        if (!this.selectedSourceAccountId) return;
        this.campaigns = await campaignCopier.loadCampaigns(this.selectedSourceAccountId);
        this.refreshCampaignSelect();
      };

      const campaignSelect = document.createElement("select");
      campaignSelect.id = "ywbCampaignSelect";
      campaignSelect.onchange = () => {
        this.selectedCampaignId = campaignSelect.value;
      };

      const targetSelect = document.createElement("select");
      targetSelect.id = "ywbTargetAccountSelect";
      targetSelect.onchange = () => {
        this.selectedTargetAccountId = targetSelect.value;
      };

      const suffixInput = document.createElement("input");
      suffixInput.type = "text";
      suffixInput.id = "ywbNameSuffix";
      suffixInput.value = "[copy]";
      suffixInput.placeholder = "Например: [copy]";

      const copyAdsWrapper = document.createElement("div");
      copyAdsWrapper.className = "checkbox-row";

      const copyAdsCheckbox = document.createElement("input");
      copyAdsCheckbox.type = "checkbox";
      copyAdsCheckbox.id = "ywbCopyAds";
      copyAdsCheckbox.checked = true;

      const copyAdsLabel = document.createElement("label");
      copyAdsLabel.htmlFor = "ywbCopyAds";
      copyAdsLabel.textContent = "Пробовать копировать ads и creatives. Если FB не примет creative, объявление будет пропущено.";

      copyAdsWrapper.append(copyAdsCheckbox, copyAdsLabel);

      const sourceSection = this.createSection("1. Source РК:", sourceSelect);
      const campaignSection = this.createSection("2. Кампания для копирования:", campaignSelect);
      const targetSection = this.createSection("3. Target РК:", targetSelect);
      const suffixSection = this.createSection("4. Суффикс к названиям:", suffixInput);

      this.fillAccountSelect(sourceSelect, "-- Выберите source РК --");
      this.fillAccountSelect(targetSelect, "-- Выберите target РК --");
      this.refreshCampaignSelect();

      const runButton = this.createButton("ywbRunCopy", "Скопировать кампанию", async () => {
        if (!this.selectedSourceAccountId) {
          alert("Выберите source РК.");
          return;
        }
        if (!this.selectedCampaignId) {
          alert("Выберите кампанию.");
          return;
        }
        if (!this.selectedTargetAccountId) {
          alert("Выберите target РК.");
          return;
        }
        if (this.selectedSourceAccountId === this.selectedTargetAccountId) {
          alert("Source и target РК совпадают. Выберите разные аккаунты.");
          return;
        }

        const result = await campaignCopier.copyCampaign({
          sourceAccountId: this.selectedSourceAccountId,
          targetAccountId: this.selectedTargetAccountId,
          campaignId: this.selectedCampaignId,
          copyAds: copyAdsCheckbox.checked,
          nameSuffix: suffixInput.value || "[copy]"
        });

        alert(`Готово. Новая кампания: ${result.campaignId}\nAdsets: ${result.adsetsCreated}\nAds: ${result.adsCreated}\nCreatives: ${result.creativesCreated}`);
      });

      const copyBookmarkletButton = this.createButton("ywbCopyBookmarklet", "Скопировать как bookmarklet", async () => {
        copyScriptAsBase64Bookmarklet();
      }, true);

      root.append(
        sourceSection,
        campaignSection,
        targetSection,
        suffixSection,
        copyAdsWrapper,
        runButton,
        copyBookmarkletButton,
        this.createLogArea()
      );

      document.body.appendChild(root);
      logger.setUI(this);
      logger.success("Интерфейс готов.");
    }
  }

  async function initCampaignCopier() {
    const loading = document.createElement("div");
    loading.textContent = "Загружаю FB Campaign Draft Copier...";
    Object.assign(loading.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: "2147483647",
      background: "#0f1715",
      color: "#e8fff0",
      border: "1px solid #2f4a40",
      borderRadius: "12px",
      padding: "16px 18px",
      font: "700 14px Inter, Segoe UI, Arial, sans-serif"
    });

    document.body.appendChild(loading);

    try {
      await accountManager.loadAll();
      loading.remove();

      const ui = new CampaignCopierUI();
      await ui.show();
    } catch (error) {
      loading.remove();
      console.error(error);
      alert(`Ошибка запуска: ${error.message || error}`);
    }
  }

  function copyScriptAsBase64Bookmarklet() {
    try {
      const script = document.currentScript?.textContent;
      let scriptContent = script;

      if (!scriptContent || !scriptContent.includes("FB Campaign Draft Copier")) {
        alert("Автосборка bookmarklet из canvas/console может не сработать. Скопируй весь JS-файл вручную и оберни в javascript:...");
        return;
      }

      const base64Content = btoa(unescape(encodeURIComponent(scriptContent)));
      const bookmarkletCode = `javascript:eval(decodeURIComponent(escape(atob("${base64Content}"))));`;

      navigator.clipboard.writeText(bookmarkletCode)
        .then(() => alert("Bookmarklet скопирован в буфер обмена."))
        .catch(() => {
          const textArea = document.createElement("textarea");
          textArea.value = bookmarkletCode;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand("copy");
          textArea.remove();
          alert("Bookmarklet скопирован в буфер обмена.");
        });
    } catch (error) {
      alert(`Ошибка создания bookmarklet: ${error.message || error}`);
    }
  }

  window.ywbInitCampaignCopier = initCampaignCopier;
  window.ywbCopyCampaignCopierBookmarklet = copyScriptAsBase64Bookmarklet;

  initCampaignCopier();
})();

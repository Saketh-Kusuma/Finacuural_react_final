// API_BASE is baked in by webpack (process.env.API_BASE).
// • macOS: backend runs HTTPS (office-addin-dev-certs) → https://localhost:8000
// • Windows: backend runs HTTP (Edge WebView2 allows http from HTTPS taskpane)
//            → http://localhost:8000
// The webpack.config.js picks the right default per platform at build time.
// At runtime the window.__FINACCRUAL_CONFIG__.API_BASE override takes precedence
// (useful for production deployments).
export const API_BASE =
  (typeof process !== "undefined" && process.env && process.env.API_BASE) ||
  (typeof window !== "undefined" && window.__FINACCRUAL_CONFIG__ && window.__FINACCRUAL_CONFIG__.API_BASE) ||
  "http://localhost:8000";


export function getBackendOrigin() {
  try {
    return new URL(API_BASE, window.location.href).origin;
  } catch (_) {
    return "";
  }
}

export function isTrustedOrigin(origin) {
  if (!origin) return false;
  if (typeof window !== "undefined" && origin === window.location.origin) return true;
  const backendOrigin = getBackendOrigin();
  if (backendOrigin && origin === backendOrigin) return true;
  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
      return true;
    }
  }
  return false;
}

export function isTokenExpired(token) {
  if (!token) return true;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const payloadStr = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr);
    if (!payload.exp) return false;
    return (payload.exp * 1000) <= Date.now();
  } catch (_) {
    return true;
  }
}

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("fa_jwt_token");
  if (token && isTokenExpired(token)) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("fa_session_expired"));
    }
    throw new Error("Session expired. Please sign in again.");
  }

  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(path.startsWith("http") ? path : `${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401) {
    let errJson = null;
    try {
      errJson = await response.clone().json();
    } catch (_) {}

    if (errJson?.code === "ERR_ERP_SESSION_EXPIRED") {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("fa_erp_session_expired", { detail: errJson }));
      }
      throw new Error(errJson.message || "Your ERP session has expired. Please reconnect.");
    }

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("fa_session_expired"));
    }
    throw new Error("Session expired. Please sign in again.");
  }

  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Request failed.");
  return response;
}

export function openAuth(provider, onProfile, loginHint, onCancel) {
  let url = `${API_BASE}/api/${provider === "google" ? "auth/google" : "microsoft"}/connect`;
  if (loginHint) url += `?login_hint=${encodeURIComponent(loginHint)}`;
  const popup = window.open(url, `fa_${provider}_auth`, "width=520,height=640,resizable=yes,scrollbars=yes");
  if (!popup) throw new Error("The sign-in window was blocked. Please allow popups and try again.");
  const receive = (event) => {
    if (!isTrustedOrigin(event.origin)) return;
    const data = event.data || {};
    const types = provider === "google" ? ["google_authed", "google_profile"] : ["microsoft_authed", "ms_authed", "microsoft_profile", "ms_profile"];
    if (!types.includes(data.type)) return;
    clearInterval(closedTimer);
    window.removeEventListener("message", receive);
    onProfile({ ...data, provider });
  };
  window.addEventListener("message", receive);

  // Re-enable buttons if the user closes the popup without completing auth
  const closedTimer = setInterval(() => {
    if (popup.closed) {
      clearInterval(closedTimer);
      window.removeEventListener("message", receive);
      if (onCancel) onCancel();
    }
  }, 500);
}

export function openErp(provider, user, reconnectId = null) {
  const path = provider === "quickbooks" ? "/api/quickbooks/connect" : "/api/xero/connect";
  const queryObj = {
    tier: user.plan || "",
    mail: user.email || "",
    token: localStorage.getItem("fa_jwt_token") || ""
  };
  if (reconnectId) {
    queryObj.reconnectId = reconnectId;
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("fa_pending_reconnect_id", reconnectId);
    }
  }
  const params = new URLSearchParams(queryObj);
  return window.open(`${API_BASE}${path}?${params.toString()}`, `fa_${provider}_auth`, "width=800,height=600,resizable=yes,scrollbars=yes");
}

export function openTrialSelectDialog(onAction) {
  const dialogUrl = window.location.origin + "/trialselect.html";

  // If running inside Office Add-in host with dialog API available
  if (
    typeof Office !== "undefined" &&
    Office.context &&
    Office.context.ui &&
    Office.context.ui.displayDialogAsync
  ) {
    let dialog = null;
    Office.context.ui.displayDialogAsync(
      dialogUrl,
      { height: 60, width: 45, displayInIframe: true },
      (asyncResult) => {
        if (asyncResult.status === Office.AsyncResultStatus.Failed) {
          console.warn("displayDialogAsync failed, falling back to popup:", asyncResult.error.message);
          openTrialPopupFallback(dialogUrl, onAction);
        } else {
          dialog = asyncResult.value;
          dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
            try {
              const message = typeof arg.message === "string" ? JSON.parse(arg.message) : arg.message;
              if (dialog) dialog.close();
              if (message?.type === "START_TRIAL") onAction("START_TRIAL");
              if (message?.type === "VIEW_PLANS") onAction("VIEW_PLANS");
            } catch (err) {
              console.error("Error parsing dialog message:", err);
            }
          });
        }
      }
    );
    return;
  }

  // Fallback if not inside Office or displayDialogAsync not available
  openTrialPopupFallback(dialogUrl, onAction);
}

function openTrialPopupFallback(url, onAction) {
  const popup = window.open(
    url,
    "fa_trialselect",
    "width=640,height=560,resizable=yes,scrollbars=yes"
  );
  const receive = (event) => {
    if (!isTrustedOrigin(event.origin)) return;
    let data = event.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (_) {}
    }
    if (data?.type === "START_TRIAL" || data?.type === "VIEW_PLANS") {
      window.removeEventListener("message", receive);
      if (popup && !popup.closed) popup.close();
      onAction(data.type);
    }
  };
  window.addEventListener("message", receive);
}

async function fetchMasterDataFallback(provider, companyId, tier, mode = "") {
  const query = {
    companyId: companyId || "",
    platform: provider || "",
    tier: tier || ""
  };
  if (mode) query.mode = mode;
  const params = new URLSearchParams(query);
  const response = await apiFetch(`/api/pull-master-data?${params.toString()}`, { method: "GET" });
  return await response.json();
}

export async function fetchMasterDataStream(provider, companyId, tier, onProgress) {
  const params = new URLSearchParams({
    companyId: companyId || "",
    platform: provider || "",
    tier: tier || "",
    stream: "true"
  });

  try {
    const response = await apiFetch(`/api/pull-master-data?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "text/event-stream" }
    });

    if (!response.body || typeof response.body.getReader !== "function") {
      console.warn("ReadableStream not supported on response body, falling back to JSON pull.");
      return await fetchMasterDataFallback(provider, companyId, tier);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const payload = JSON.parse(line.replace("data: ", "").trim());
            if (payload.type === "progress" && typeof onProgress === "function") {
              onProgress(payload);
            } else if (payload.type === "start" && typeof onProgress === "function") {
              onProgress(payload);
            } else if (payload.type === "complete") {
              finalData = payload.data;
            } else if (payload.type === "error") {
              throw new Error(payload.error || "Data sync error");
            }
          } catch (pErr) {
            if (pErr.message && !pErr.message.includes("Unexpected token")) throw pErr;
          }
        }
      }
    }

    if (finalData) return finalData;
    return await fetchMasterDataFallback(provider, companyId, tier);
  } catch (err) {
    console.warn("Stream pull encountered an error, falling back to standard JSON pull:", err);
    return await fetchMasterDataFallback(provider, companyId, tier);
  }
}

export async function fetchIncrementalDataStream(provider, companyId, tier, onProgress) {
  const params = new URLSearchParams({
    companyId: companyId || "",
    platform: provider || "",
    tier: tier || "",
    stream: "true",
    mode: "incremental"
  });

  try {
    const response = await apiFetch(`/api/pull-master-data?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "text/event-stream" }
    });

    if (!response.body || typeof response.body.getReader !== "function") {
      console.warn("ReadableStream not supported on response body, falling back to JSON incremental pull.");
      return await fetchMasterDataFallback(provider, companyId, tier, "incremental");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const payload = JSON.parse(line.replace("data: ", "").trim());
            if (payload.type === "progress" && typeof onProgress === "function") {
              onProgress(payload);
            } else if (payload.type === "start" && typeof onProgress === "function") {
              onProgress(payload);
            } else if (payload.type === "complete") {
              finalData = payload.data;
            } else if (payload.type === "error") {
              throw new Error(payload.error || "Incremental sync error");
            }
          } catch (pErr) {
            if (pErr.message && !pErr.message.includes("Unexpected token")) throw pErr;
          }
        }
      }
    }

    if (finalData) return finalData;
    return await fetchMasterDataFallback(provider, companyId, tier, "incremental");
  } catch (err) {
    console.warn("Stream incremental pull encountered an error, falling back to standard JSON pull:", err);
    return await fetchMasterDataFallback(provider, companyId, tier, "incremental");
  }
}

export async function fetchCompanyRecordCount(companyId) {
  if (!companyId) return 0;
  try {
    const res = await apiFetch(`/api/connections/${companyId}/count`);
    const data = await res.json();
    if (data && typeof data.totalRecords === "number") {
      return data.totalRecords;
    }
  } catch (err) {
    console.warn("GET /count failed, attempting /activate fallback:", err);
  }

  // Fallback: POST /api/connections/:id/activate
  try {
    const res = await apiFetch(`/api/connections/${companyId}/activate`, { method: "POST" });
    const data = await res.json();
    if (data && typeof data.totalRecords === "number") {
      return data.totalRecords;
    }
  } catch (err) {
    console.warn("Fallback /activate count failed:", err);
  }

  return 0;
}



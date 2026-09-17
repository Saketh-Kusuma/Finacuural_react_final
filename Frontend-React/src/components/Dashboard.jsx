import { useEffect, useState } from "react";
import { ConnectedDashboard } from "./ConnectedDashboard";
import { initials } from "./ui";
import { AccountMenu } from "./AccountMenu";
import { isTrustedOrigin, apiFetch } from "../taskpane/api";

/* ---- Inline SVG icons ---- */
function BellIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#16a34a"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LinkIcon({ size = 18, stroke = "#2563eb" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function QBLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="#2CA01C" />
      <text
        x="16"
        y="21"
        fontSize="14"
        fontWeight="800"
        fill="white"
        textAnchor="middle"
        fontFamily="'Inter', sans-serif"
      >
        qb
      </text>
    </svg>
  );
}

function XeroLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="#13B5EA" />
      <text
        x="16"
        y="21"
        fontSize="12"
        fontWeight="800"
        fill="white"
        textAnchor="middle"
        fontFamily="'Inter', sans-serif"
      >
        xero
      </text>
    </svg>
  );
}

export function Dashboard({
  user,
  onConnect,
  onLogout,
  onChangePlan,
  notify,
  unreadCount = 0,
  onToggleNotifications,
  onTrialExpired,
}) {
  const [menu, setMenu] = useState(false);
  const [connected, setConnected] = useState(
    () => localStorage.getItem("fa_erp_connected") === "true",
  );
  const [provider, setProvider] = useState(
    () => localStorage.getItem("fa_erp_type") || "",
  );
  const [checkingConnections, setCheckingConnections] = useState(
    () => !connected && sessionStorage.getItem("fa_erp_user_disconnected") !== "true",
  );

  useEffect(() => {
    let mounted = true;
    const email = user?.email || localStorage.getItem("fa_user_email") || "";
    const isManuallyDisconnected = sessionStorage.getItem("fa_erp_user_disconnected") === "true";

    if (isManuallyDisconnected || !email) {
      setCheckingConnections(false);
      return;
    }

    apiFetch(`/api/connections?mail=${encodeURIComponent(email)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!mounted) return;
        if (Array.isArray(data) && data.length > 0) {
          const activeConn = data.find((c) => c.status !== "Disconnected") || data[0];
          if (activeConn && activeConn.status !== "Disconnected") {
            const detectedProvider = (activeConn.platform || "").toLowerCase().includes("xero")
              ? "xero"
              : "quickbooks";
            localStorage.setItem("fa_erp_connected", "true");
            localStorage.setItem("fa_erp_type", detectedProvider);
            if (activeConn.companyId) {
              localStorage.setItem("fa_current_company_id", activeConn.companyId);
            }
            setProvider(detectedProvider);
            setConnected(true);
          }
        }
      })
      .catch((err) => {
        console.warn("Could not check ERP connections:", err);
      })
      .finally(() => {
        if (mounted) setCheckingConnections(false);
      });

    return () => {
      mounted = false;
    };
  }, [user?.email]);

  useEffect(() => {
    const receive = (event) => {
      if (!isTrustedOrigin(event.origin)) return;
      const next =
        event.data === "xero_connected"
          ? "xero"
          : event.data === "qb_connected"
            ? "quickbooks"
            : null;
      if (!next) return;
      sessionStorage.removeItem("fa_erp_user_disconnected");
      localStorage.setItem("fa_erp_connected", "true");
      localStorage.setItem("fa_erp_type", next);
      setProvider(next);
      setConnected(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  const connect = async (next) => {
    sessionStorage.removeItem("fa_erp_user_disconnected");
    // Before opening OAuth, check if the backend still has an active connection
    // for this provider. If yes, restore it and skip OAuth entirely.
    const email = user?.email || localStorage.getItem("fa_user_email") || "";
    if (email) {
      try {
        const res = await apiFetch(`/api/connections?mail=${encodeURIComponent(email)}`);
        const conns = await res.json();
        if (Array.isArray(conns) && conns.length > 0) {
          const providerMatch = conns.find(
            (c) =>
              c.status !== "Disconnected" &&
              (next === "xero"
                ? (c.platform || "").toLowerCase().includes("xero")
                : !(c.platform || "").toLowerCase().includes("xero"))
          );
          if (providerMatch) {
            // Active token still exists on backend — restore and go to ConnectedDashboard
            const detectedProvider = (providerMatch.platform || "").toLowerCase().includes("xero")
              ? "xero"
              : "quickbooks";
            localStorage.setItem("fa_erp_connected", "true");
            localStorage.setItem("fa_erp_type", detectedProvider);
            if (providerMatch.companyId) {
              localStorage.setItem("fa_current_company_id", providerMatch.companyId);
            }
            setProvider(detectedProvider);
            setConnected(true);
            return;
          }
        }
      } catch (_) {
        // If the check fails, fall through to OAuth
      }
    }
    // No active connection found — proceed with OAuth
    setProvider(next);
    onConnect(next);
  };
  const name = user.name || localStorage.getItem("fa_user_name") || "there";
  const firstName = name.split(" ")[0] || name;
  const subId =
    user.subscriptionId || localStorage.getItem("fa_subscription_id") || "—";
  const rawPlan =
    user.plan ||
    localStorage.getItem("fa_plan") ||
    localStorage.getItem("fa_subscription_plan") ||
    "Trial";
  const plan =
    rawPlan.toLowerCase().includes("plan") ||
    rawPlan.toLowerCase().includes("trial")
      ? rawPlan
      : `${rawPlan} Plan`;

  const [copied, setCopied] = useState(false);

  const copySubId = () => {
    if (subId && subId !== "—") {
      navigator.clipboard
        ?.writeText(subId)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {});
    }
  };

  if (connected) {
    return (
      <ConnectedDashboard
        provider={provider}
        user={user}
        notify={notify}
        unreadCount={unreadCount}
        onToggleNotifications={onToggleNotifications}
        logout={onLogout}
        onChangePlan={onChangePlan}
        onConnect={onConnect}
        onTrialExpired={onTrialExpired}
        disconnect={() => {
          sessionStorage.setItem("fa_erp_user_disconnected", "true");
          localStorage.removeItem("fa_erp_connected");
          localStorage.removeItem("fa_erp_type");
          localStorage.removeItem("fa_current_company_id");
          setConnected(false);
        }}
      />
    );
  }

  if (checkingConnections) {
    return (
      <div className="loading-screen" style={{ minHeight: "100%" }}>
        <div className="loading-spinner" />
        <span className="loading-text">Loading dashboard...</span>
      </div>
    );
  }

  return (
    <section
      className="view active"
      style={{ display: "flex", flexDirection: "column", position: "relative" }}
    >
      {/* ===== Brand Header ===== */}
      <div className="dash-brand-header pattern-bg">
        <div className="dash-brand-left">
          <div className="dash-logo-box">FA</div>
          <div>
            <div className="dash-brand-title">FinAccrual</div>
          </div>
        </div>
        <div className="dash-brand-right">
          <button
            className="fa-notif-bell-btn"
            aria-label="Notifications"
            onClick={() => onToggleNotifications && onToggleNotifications("56px")}
          >
            <BellIcon />
            {unreadCount > 0 && (
              <span className="fa-notif-badge">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
          <button
            className="dash-avatar-btn header-avatar"
            onClick={() => setMenu(!menu)}
          >
            {initials(name)}
          </button>
        </div>
      </div>

      {/* ===== Account dropdown menu (Exact Vanilla Frontend Menu with Icons) ===== */}
      {menu && (
        <AccountMenu
          user={user}
          planClean={rawPlan}
          onClose={() => setMenu(false)}
          onLogout={onLogout}
          onChangePlan={onChangePlan}
          notify={notify}
        />
      )}

      {/* ===== Main Scrollable Area ===== */}
      <div className="dash-main-scrollable">
        {/* Welcome */}
        <div className="dash-welcome-container">
          <div className="dash-welcome-text-col">
            <h2 className="dash-welcome-title">Welcome, {firstName}!</h2>
            <p className="dash-welcome-subtitle">
              Let's connect your accounting software to start syncing data with
              Excel.
            </p>
          </div>
        </div>

        {/* Plan Summary Card */}
        <div className="dash-plan-summary-card">
          <div className="plan-col">
            <span className="plan-col-label">Subscription ID</span>
            <span className="plan-col-value">
              {subId}
              <button
                className="btn-copy-subid"
                title={copied ? "Copied!" : "Copy Subscription ID"}
                onClick={copySubId}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </span>
          </div>
          <div className="plan-col-divider" />
          <div className="plan-col">
            <span className="plan-col-label">Plan</span>
            <span className="plan-col-badge-green">{plan}</span>
          </div>
          <div className="plan-col-divider" />
          <div className="plan-col">
            <span className="plan-col-label">Status</span>
            <span className="plan-col-status">
              <span className="status-dot-green">●</span> Active
            </span>
          </div>
        </div>

        {/* Connect Accounting Software */}
        <div className="dash-connect-section">
          <div className="connect-section-header">
            <div className="connect-icon-circle">
              <LinkIcon />
            </div>
            <div className="connect-header-text">
              <div className="connect-title">Connect Accounting Software</div>
              <div className="connect-subtitle">
                Link your accounting software to start syncing data with Excel.
              </div>
            </div>
          </div>

          <div className="erp-provider-cards-large">
            {/* QuickBooks Card */}
            <div
              className="erp-card-large"
              role="button"
              tabIndex="0"
              onClick={() => connect("quickbooks")}
              onKeyDown={(e) => e.key === "Enter" && connect("quickbooks")}
            >
              <div className="erp-logo-large">
                <QBLogo />
              </div>
              <h3 className="erp-card-title">QuickBooks</h3>
              <p className="erp-card-desc">
                Connect and sync your QuickBooks data with Excel.
              </p>
              <div className="btn-connect-full btn-qb-full">
                <LinkIcon size={14} stroke="currentColor" />
                Connect QuickBooks →
              </div>
            </div>

            {/* Xero Card */}
            <div
              className="erp-card-large"
              role="button"
              tabIndex="0"
              onClick={() => connect("xero")}
              onKeyDown={(e) => e.key === "Enter" && connect("xero")}
            >
              <div className="erp-logo-large">
                <XeroLogo />
              </div>
              <h3 className="erp-card-title">Xero</h3>
              <p className="erp-card-desc">
                Connect and sync your Xero data with Excel.
              </p>
              <div className="btn-connect-full btn-xero-full">
                <LinkIcon size={14} stroke="currentColor" />
                Connect Xero →
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

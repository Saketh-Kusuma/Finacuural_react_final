import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, openErp, isTrustedOrigin, fetchCompanyRecordCount } from "../../taskpane/api";
import { ExcelService } from "../../taskpane/services/excelService";

export function formatRelativeTime(dateInput, status) {
  if (status === "Disconnected") return "Disconnected";
  if (status === "Not Synced" || !dateInput) return "Not Synced";
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return "Not Synced";
  const diffMs = new Date() - date;
  if (diffMs < 0) return "Just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 45) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr === 1 ? "1 hour ago" : `${diffHr} hours ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
  return date.toLocaleDateString();
}

export function useCompanyConnections({
  provider,
  user,
  planClean,
  notify,
  addLog,
  onConnect,
  onChangePlan,
}) {
  const isXero = (provider || "").toLowerCase() === "xero";
  const label = isXero ? "Xero" : "QuickBooks";

  const maxCompanies = planClean.toLowerCase().includes("pro")
    ? 10
    : planClean.toLowerCase().includes("standard")
      ? 3
      : 1;

  const [connections, setConnections] = useState([]);
  const [activeCompanyId, setActiveCompanyId] = useState(
    () => localStorage.getItem("fa_current_company_id") || null
  );

  const [companyRecordCounts, setCompanyRecordCounts] = useState(() => {
    const counts = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("fa_records_")) {
        const id = key.replace("fa_records_", "");
        const val = Number(localStorage.getItem(key));
        if (!isNaN(val)) counts[id] = val;
      }
    }
    return counts;
  });

  const [isCountingRecords, setIsCountingRecords] = useState(null);

  const platformConns = connections.filter(
    (c) => (c.platform || "").toLowerCase() === (provider || "").toLowerCase()
  );

  const activeConnection =
    platformConns.find((c) => c.companyId === activeCompanyId) ||
    platformConns[0] ||
    connections.find(
      (c) => (c.platform || "").toLowerCase() === (provider || "").toLowerCase()
    ) ||
    connections[0];

  const companyName =
    activeConnection?.companyName ||
    (isXero ? "sushanth" : "Sandbox Company GB ce1f");
  const realmId =
    activeConnection?.companyId || "c90dc421-681f-4bc6-a3c0-812a6c44ab03";
  const lastSyncText = formatRelativeTime(
    activeConnection?.lastSyncedAt,
    activeConnection?.status
  );

  const connectedCount = platformConns.length;
  const remainingCompanies = Math.max(0, maxCompanies - connectedCount);

  const reloadConnections = useCallback(async () => {
    const email = user.email || localStorage.getItem("fa_user_email") || "";
    if (!email) return [];
    try {
      const res = await apiFetch(`/api/connections?mail=${encodeURIComponent(email)}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setConnections(data);
        return data;
      }
    } catch (_) {}
    return [];
  }, [user.email]);

  useEffect(() => {
    let mounted = true;
    const email = user.email || localStorage.getItem("fa_user_email") || "";
    if (email) {
      apiFetch(`/api/connections?mail=${encodeURIComponent(email)}`)
        .then((res) => res.json())
        .then((data) => {
          if (mounted && Array.isArray(data) && data.length > 0) {
            setConnections(data);
          }
        })
        .catch(() => {});
    }
    return () => {
      mounted = false;
    };
  }, [user.email]);

  // Sync record count updates from storage / events
  useEffect(() => {
    const handleRecordUpdate = (e) => {
      const { companyId, count } = e.detail || {};
      if (companyId && typeof count === "number") {
        setCompanyRecordCounts((prev) => ({ ...prev, [companyId]: count }));
      }
    };
    window.addEventListener("fa_records_updated", handleRecordUpdate);
    return () => window.removeEventListener("fa_records_updated", handleRecordUpdate);
  }, []);

  useEffect(() => {
    if (Array.isArray(connections) && connections.length > 0) {
      setCompanyRecordCounts((prev) => {
        let changed = false;
        const next = { ...prev };
        connections.forEach((c) => {
          if (c.companyId && c.recordCount != null && next[c.companyId] === undefined) {
            next[c.companyId] = c.recordCount;
            localStorage.setItem(`fa_records_${c.companyId}`, String(c.recordCount));
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }
  }, [connections]);

  const platformConnsRef = useRef(platformConns);
  useEffect(() => {
    platformConnsRef.current = platformConns;
  }, [platformConns]);

  useEffect(() => {
    const receive = (event) => {
      if (!isTrustedOrigin(event.origin)) return;

      let data = event.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (_) {}
      }

      if (data?.type === "company_already_connected") {
        const compName = data.companyName || "This company";
        notify(
          "Company Already Connected",
          "error",
          `"${compName}" is already connected to your dashboard. Please select a different company to add.`,
          provider
        );
        if (addLog) addLog(`Add Company failed: "${compName}" is already connected.`);
        return;
      }

      if (data === "qb_connected" || data === "xero_connected") {
        if (addLog) addLog(`Connection completed: ${data}`);
        const pendingReconnectId = typeof sessionStorage !== "undefined"
          ? sessionStorage.getItem("fa_pending_reconnect_id")
          : null;
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.removeItem("fa_pending_reconnect_id");
        }

        const prevIds = new Set((platformConnsRef.current || []).map((c) => c.companyId));

        reloadConnections().then((conns) => {
          if (pendingReconnectId) {
            const reconnected = conns.find((c) => c.companyId === pendingReconnectId);
            if (reconnected) {
              setActiveCompanyId(reconnected.companyId);
              localStorage.setItem("fa_current_company_id", reconnected.companyId);
              notify("Company reconnected successfully.", "success", `${reconnected.companyName || label} is now active and re-authorized.`, provider);
              return;
            }
          }

          const matching = conns.filter(
            (c) => (c.platform || "").toLowerCase() === (provider || "").toLowerCase()
          );

          // If this was an "Add Another Company" action (not reconnect), verify a new company was actually added
          if (!pendingReconnectId && prevIds.size > 0) {
            const newlyAdded = matching.find((c) => !prevIds.has(c.companyId));
            if (!newlyAdded) {
              const currentComp = matching.find((c) => c.companyId === activeCompanyId) || matching[0];
              const compName = currentComp?.companyName || label + " Company";
              notify(
                "Company Already Connected",
                "error",
                `"${compName}" is already connected to your dashboard. Please select a different company to add.`,
                provider
              );
              if (addLog) addLog(`Add Company failed: "${compName}" is already connected.`);
              return;
            }
          }

          if (matching.length > 0) {
            const newest = matching[matching.length - 1];
            setActiveCompanyId(newest.companyId);
            localStorage.setItem("fa_current_company_id", newest.companyId);
            notify("Company connected successfully.", "success", `${newest.companyName || label} is now connected.`, provider);
          }
        });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [provider, reloadConnections, addLog, label, notify, activeCompanyId]);

  useEffect(() => {
    const handleErpExpired = (event) => {
      const details = event?.detail || {};
      if (addLog) addLog(`ERP session expired: ${details.message || "Please reconnect company."}`);
      notify("Connection Expired", "error", details.message || `Your ${label} connection has expired. Please click Reconnect to restore access.`, provider);
      reloadConnections();
    };
    window.addEventListener("fa_erp_session_expired", handleErpExpired);
    return () => window.removeEventListener("fa_erp_session_expired", handleErpExpired);
  }, [label, provider, addLog, notify, reloadConnections]);


  const handleAddCompanyClick = async () => {

    const email = user.email || localStorage.getItem("fa_user_email") || "";
    let conns = connections;
    try {
      const res = await apiFetch("/api/connections?mail=" + encodeURIComponent(email));
      const data = await res.json();
      if (Array.isArray(data)) {
        conns = data;
        setConnections(data);
      }
    } catch (_) {}

    const connsForProvider = (conns || []).filter(
      (c) => (c.platform || "").toLowerCase() === (provider || "quickbooks").toLowerCase()
    );

    if (connsForProvider.length >= maxCompanies) {
      const alertMsg = `Your ${planClean} Plan limits active ${label} connections to ${maxCompanies} companies. Please upgrade your plan to connect more companies.`;
      notify(`Company limit reached (${connsForProvider.length}/${maxCompanies})`, "error", alertMsg, provider);
      if (onChangePlan) {
        onChangePlan();
      }
      return;
    }

    if (addLog) addLog(`Opening ${label} connection window...`);

    if (onConnect) {
      onConnect(provider);
    } else {
      const popup = openErp(provider, user);
      if (!popup) {
        notify("Connection window blocked. Please allow popups.", "error", null, provider);
      }
    }
  };

  const switchingRef = useRef(false);
  const switchActiveCompany = async (companyId) => {
    if (switchingRef.current) return;
    switchingRef.current = true;
    try {
      await ExcelService.clearMasterData();
      localStorage.removeItem("fa_step_setup");
      localStorage.removeItem("fa_step_pull");
      localStorage.removeItem(`fa_step_setup_${companyId}`);
      localStorage.removeItem(`fa_step_pull_${companyId}`);
    } catch (err) {
      console.error("Error clearing Excel data: ", err);
    }
    setActiveCompanyId(companyId);
    localStorage.setItem("fa_current_company_id", companyId);
    window.dispatchEvent(new CustomEvent("fa_company_switched", { detail: { companyId } }));

    const targetConn = platformConns.find((c) => c.companyId === companyId);
    try {
      const res = await apiFetch(`/api/connections/${companyId}/activate`, { method: "POST" });
      const actData = await res.json().catch(() => ({}));
      const totalRecords = typeof actData?.totalRecords === "number" ? actData.totalRecords : null;

      if (totalRecords !== null) {
        setCompanyRecordCounts((prev) => ({ ...prev, [companyId]: totalRecords }));
        localStorage.setItem(`fa_records_${companyId}`, String(totalRecords));
      }

      if (targetConn) {
        if (addLog) {
          if (totalRecords !== null) {
            addLog(`Data completed. (${totalRecords} records found for ${targetConn.companyName})`);
          } else {
            addLog(`Switched active company to: ${targetConn.companyName}`);
          }
        }
        if (totalRecords !== null) {
          notify(
            "Data completed.",
            "success",
            `Successfully fetched all ${totalRecords} records across all entities for this company.`,
            provider
          );
        } else {
          notify(
            `Active company updated to ${targetConn.companyName}`,
            "success",
            null,
            provider
          );
        }
      }
      reloadConnections();
    } catch (err) {
      console.error("Error activating company:", err);
      notify("Failed to switch active company.", "error", null, provider);
    } finally {
      switchingRef.current = false;
    }
  };

  const handleCompanyClick = async (company) => {
    if (!company) return;
    const compId = company.companyId || company.tenant_id || realmId;
    const compName = company.companyName || companyName || label;

    if (company.status === "Disconnected") {
      notify(
        "Company Disconnected",
        "error",
        `"${compName}" is disconnected. Please click Reconnect to authorize access.`,
        provider
      );
      return;
    }

    const isCurrentActive = compId === activeCompanyId;

    if (!isCurrentActive) {
      await switchActiveCompany(compId);
      return;
    }

    try {
      setIsCountingRecords(compId);
      const totalRecords = await fetchCompanyRecordCount(compId);
      setCompanyRecordCounts((prev) => ({ ...prev, [compId]: totalRecords }));
      localStorage.setItem(`fa_records_${compId}`, String(totalRecords));

      notify(
        "Data completed.",
        "success",
        `Successfully fetched all ${totalRecords} records across all entities for this company.`,
        provider
      );
      if (addLog) {
        addLog(`Data completed. (${totalRecords} records found for ${compName})`);
      }
    } catch (err) {
      console.error("Error fetching company record count:", err);
      notify("Record count unavailable.", "error", "Could not fetch company records.", provider);
    } finally {
      setIsCountingRecords(null);
    }
  };

  const handleDisconnectCompany = async (company) => {
    const compId = company.companyId;
    const compName = company.companyName || "Company";
    if (addLog) addLog(`Disconnecting ${compName}...`);
    try {
      await apiFetch(`/api/connections/${compId}`, { method: "DELETE" });
      if (activeCompanyId === compId) {
        setActiveCompanyId(null);
        localStorage.removeItem("fa_current_company_id");
      }
      try {
        await ExcelService.clearMasterData();
        localStorage.removeItem("fa_step_setup");
        localStorage.removeItem("fa_step_pull");
        localStorage.removeItem(`fa_step_setup_${compId}`);
        localStorage.removeItem(`fa_step_pull_${compId}`);
      } catch (_) {}
      notify("Company disconnected.", "success", null, provider);
      if (addLog) addLog(`Company disconnected: ${compName}`);
      reloadConnections();
    } catch (_) {
      notify("Failed to disconnect company.", "error", null, provider);
    }
  };

  const handleRenameCompany = async (renamingCompany, newName) => {
    const trimmed = (newName || "").trim();
    if (!trimmed || !renamingCompany) return;
    try {
      await apiFetch(`/api/connections/${renamingCompany.companyId}/rename`, {
        method: "PATCH",
        body: JSON.stringify({ companyName: trimmed }),
      });
      notify("Company renamed successfully.", "success", null, provider);
      reloadConnections();
    } catch (_) {
      notify("Failed to rename company.", "error", null, provider);
    }
  };

  return {
    label,
    isXero,
    maxCompanies,
    connections,
    platformConns,
    activeCompanyId,
    activeConnection,
    companyName,
    realmId,
    lastSyncText,
    connectedCount,
    remainingCompanies,
    reloadConnections,
    handleAddCompanyClick,
    switchActiveCompany,
    handleCompanyClick,
    companyRecordCounts,
    isCountingRecords,
    handleDisconnectCompany,
    handleRenameCompany,
  };
}

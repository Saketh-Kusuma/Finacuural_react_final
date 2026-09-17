import React from "react";
import { AddIcon } from "./DashboardIcons";
import { formatRelativeTime } from "./useCompanyConnections";

export function CompanyListSection({
  label,
  isXero,
  provider,
  platformConns,
  activeConnection,
  companyName,
  realmId,
  lastSyncText,
  connectedCount,
  onAddCompanyClick,
  onSwitchActiveCompany,
  onReconnectCompany,
  onOpenContextMenu,
  companyRecordCounts = {},
  onCompanyClick,
  isCountingRecords,
}) {
  const singleCompId = activeConnection?.companyId || realmId;
  const singleRecordCount = companyRecordCounts?.[singleCompId] ?? activeConnection?.recordCount;
  const isSingleCounting = isCountingRecords === singleCompId || (isCountingRecords === true);

  return (
    <>
      <div className="fa-section-header">
        <span className="fa-section-title">
          {label.toUpperCase()} COMPANIES
        </span>
        <button
          className="fa-btn-add"
          onClick={onAddCompanyClick}
        >
          <AddIcon />
          Add Another Company
        </button>
      </div>

      <div className="fa-company-list">
        {platformConns.length === 0 ? (
          <div
            className="fa-company-item active-company"
            style={{ cursor: activeConnection?.status === "Disconnected" ? "default" : "pointer" }}
            onClick={() => {
              if (onCompanyClick) {
                onCompanyClick(activeConnection || { companyId: realmId, companyName, platform: provider });
              }
            }}
          >
            <input
              type="radio"
              name="companyRadio"
              className="fa-company-radio"
              checked
              readOnly
            />
            <div
              className={`fa-company-icon ${isXero ? "xero-company-icon" : ""}`}
            >
              {isXero ? "xero" : "qb"}
            </div>
            <div className="fa-company-info">
              <div className="fa-company-name">{companyName}</div>
              <div className="fa-company-tag">
                Last Sync: {lastSyncText}
                {isSingleCounting ? (
                  <span style={{ color: "#2563eb", fontStyle: "italic" }}> • Fetching records...</span>
                ) : singleRecordCount != null && activeConnection?.status !== "Disconnected" ? (
                  <span> • {Number(singleRecordCount).toLocaleString()} records</span>
                ) : null}
              </div>
            </div>
            <div className="fa-company-actions">
              {activeConnection?.status === "Disconnected" ? (
                <button
                  className="fa-btn-reconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReconnectCompany(activeConnection || { companyId: realmId, companyName, platform: provider });
                  }}
                >
                  Reconnect
                </button>
              ) : (
                <span className="fa-badge-active">ACTIVE</span>
              )}
              {activeConnection?.status !== "Disconnected" && (
                <button
                  className="fa-btn-dots"
                  title="More options"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenContextMenu(
                      e,
                      activeConnection
                        ? { ...activeConnection, companyName: companyName || activeConnection.companyName, platform: provider || activeConnection.platform }
                        : { companyId: realmId, companyName, platform: provider, status: activeConnection?.status }
                    );
                  }}
                >
                  ⋮
                </button>
              )}
            </div>
          </div>
        ) : (
          platformConns.map((c) => {
            const isActive = c.companyId === activeConnection?.companyId;
            const isDisconnected = c.status === "Disconnected";
            const cIsXero = (c.platform || "").toLowerCase() === "xero";
            const cDisplayName = c.companyName || (cIsXero ? "Xero Organisation" : "QuickBooks Company");
            const cLastSync = formatRelativeTime(c.lastSyncedAt, c.status);
            const compId = c.companyId;
            const recordCount = companyRecordCounts?.[compId] ?? c.recordCount;
            const isCountingThis = isCountingRecords === compId || (isCountingRecords === true && isActive);

            return (
              <div
                key={c.companyId}
                className={`fa-company-item ${isActive && !isDisconnected ? "active-company" : ""} ${isDisconnected ? "disconnected-company" : ""}`}
                style={{ cursor: isDisconnected ? "default" : "pointer" }}
                onClick={() => {
                  if (onCompanyClick) {
                    onCompanyClick(c);
                  } else if (!isDisconnected && !isActive) {
                    onSwitchActiveCompany(c.companyId);
                  }
                }}
              >
                <input
                  type="radio"
                  name="companyRadio"
                  className="fa-company-radio"
                  checked={isActive && !isDisconnected}
                  onChange={() => {
                    if (onCompanyClick) {
                      onCompanyClick(c);
                    } else if (!isDisconnected) {
                      onSwitchActiveCompany(c.companyId);
                    }
                  }}
                />
                <div
                  className={`fa-company-icon ${cIsXero ? "xero-company-icon" : ""}`}
                >
                  {cIsXero ? "xero" : "qb"}
                </div>
                <div className="fa-company-info">
                  <div className="fa-company-name">
                    {cDisplayName}
                    {isDisconnected && (
                      <span style={{ color: "#ef4444", fontSize: 10, marginLeft: 4 }}>(Disconnected)</span>
                    )}
                  </div>
                  <div className="fa-company-tag">
                    Last Sync: {cLastSync}
                    {isCountingThis ? (
                      <span style={{ color: "#2563eb", fontStyle: "italic" }}> • Fetching records...</span>
                    ) : recordCount != null && !isDisconnected ? (
                      <span> • {Number(recordCount).toLocaleString()} records</span>
                    ) : null}
                  </div>
                </div>
                <div className="fa-company-actions">
                  {isActive && !isDisconnected ? (
                    <span className="fa-badge-active">ACTIVE</span>
                  ) : isDisconnected ? (
                    <button
                      className="fa-btn-reconnect"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReconnectCompany(c);
                      }}
                    >
                      Reconnect
                    </button>
                  ) : (
                    <button
                      className="fa-btn-switch"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onCompanyClick) {
                          onCompanyClick(c);
                        } else {
                          onSwitchActiveCompany(c.companyId);
                        }
                      }}
                    >
                      Switch
                    </button>
                  )}
                  {!isDisconnected && (
                    <button
                      className="fa-btn-dots"
                      title="More options"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenContextMenu(e, c);
                      }}
                    >
                      ⋮
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="fa-company-list-footer">
        Showing {connectedCount} {label}{" "}
        {connectedCount === 1 ? "company" : "companies"}
      </div>
    </>
  );
}

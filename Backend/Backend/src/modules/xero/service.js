'use strict';

const logger = require('../../core/logger');
const XeroApiClient = require('./services/xeroApiClient');
const XeroAuthService = require('./services/xeroAuthService');
const XeroEntityService = require('./services/xeroEntityService');
const XeroConnectionService = require('./services/xeroConnectionService');
const eventBus = require('../../core/events');

/**
 * XeroService (Facade)
 * -----------------------------------------------------------------
 * Preserves 100% backward-compatibility for all callers by exposing
 * static methods that delegate to dedicated sub-services:
 *   - xeroApiClient: Request headers, org name resolution, error checks
 *   - xeroAuthService: OAuth exchange, tenant selection, token refresh
 *   - xeroEntityService: Contacts, accounts, tracking categories
 *   - xeroConnectionService: Connections list, stats, activate, sync
 * -----------------------------------------------------------------
 */
class XeroService {
    static get PLAN_LIMITS() { return XeroConnectionService.PLAN_LIMITS; }

    static getMaxConnections(plan) {
        return XeroConnectionService.getMaxConnections(plan);
    }

    static _db() {
        return XeroConnectionService._db();
    }

    // --- OAuth & Token Methods ---
    static async exchangeAndSaveToken(code, sessionInfo, userId) {
        return XeroAuthService.exchangeAndSaveToken(code, sessionInfo, userId);
    }

    static async exchangeTokensOnly(code) {
        return XeroAuthService.exchangeTokensOnly(code);
    }

    static async saveSelectedTenants(selectedTenantIds, tokens, allTenants, userId, sessionInfo) {
        return XeroAuthService.saveSelectedTenants(selectedTenantIds, tokens, allTenants, userId, sessionInfo);
    }

    static async refreshAccessToken() {
        return XeroAuthService.refreshAccessToken();
    }

    static async getAllTokens(userId) {
        return XeroAuthService.getAllTokens(userId);
    }

    // --- Client / Header Helpers ---
    static async _tenantHeaders(tenantId) {
        return XeroApiClient._tenantHeaders(tenantId);
    }

    static async _resolveOrgName(token, tenantId, headers) {
        return XeroApiClient._resolveOrgName(token, tenantId, headers);
    }

    // --- Entity Query Methods ---
    static async _getEntityList(url, mapFn, logLabel, userId) {
        return XeroEntityService._getEntityList(url, mapFn, logLabel, userId);
    }

    static async getOrganisation(userId) {
        return XeroEntityService.getOrganisation(userId);
    }

    static async getContacts(userId) {
        return XeroEntityService.getContacts(userId);
    }

    static async getAccounts(userId) {
        return XeroEntityService.getAccounts(userId);
    }

    static async getClasses(userId) {
        return XeroEntityService.getClasses(userId);
    }

    static async getLocations(userId) {
        return XeroEntityService.getLocations(userId);
    }

    // --- Connection Management Methods ---
    static async listConnections(userId) {
        return XeroConnectionService.listConnections(userId);
    }

    static async getConnectionStats(userId, plan) {
        return XeroConnectionService.getConnectionStats(userId, plan);
    }

    static async disconnectConnection(companyId, userId) {
        return XeroConnectionService.disconnectConnection(companyId, userId);
    }

    static async updateRecordCount(companyId, userId, recordCount) {
        return XeroConnectionService.updateRecordCount(companyId, userId, recordCount);
    }

    static async activateConnection(companyId, userId) {
        return XeroConnectionService.activateConnection(companyId, userId);
    }

    static async renameConnection(companyId, userId, companyName) {
        return XeroConnectionService.renameConnection(companyId, userId, companyName);
    }

    static async getTotalRecordCountsForToken(token) {
        return XeroConnectionService.getTotalRecordCountsForToken(token);
    }

    static async pullMasterData(companyId, tier, userId, isIncremental = false) {
        return XeroConnectionService.pullMasterData(companyId, tier, userId, isIncremental);
    }

    /**
     * Batched sync with onProgress callback — used by the SSE streaming controller.
     * Mirrors QuickBooksService.pullMasterDataMultithreaded signature.
     */
    static async pullMasterDataBatched(companyId, tier, userId, onProgress = null, isIncremental = false) {
        return XeroConnectionService.pullMasterDataBatched(companyId, tier, userId, onProgress, isIncremental);
    }
}

// Plan downgrade listener
eventBus.on('user.downgraded', async ({ userId, email }) => {
    try {
        const { XeroToken, User } = require('../../core/database');
        let targetUserId = userId;
        if (!targetUserId && email) {
            const userObj = await User.findOne({ where: { email } });
            if (userObj) targetUserId = userObj.id;
        }
        if (targetUserId) {
            const deletedCount = await XeroToken.destroy({ where: { user_id: targetUserId } });
            logger.info(`[XeroService] Plan downgrade: cleared ${deletedCount} connections for ${targetUserId}`);
        }
    } catch (err) {
        logger.error(`[XeroService] Failed to clear connections on downgrade for ${userId || email}:`, err.message);
    }
});

module.exports = XeroService;
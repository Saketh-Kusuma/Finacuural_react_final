'use strict';

const logger = require('../../core/logger');
const QuickBooksApiClient = require('./services/qbApiClient');
const QuickBooksEntityService = require('./services/qbEntityService');
const QuickBooksSyncService = require('./services/qbSyncService');
const QuickBooksConnectionService = require('./services/qbConnectionService');
const eventBus = require('../../core/events');

/**
 * QuickBooksService (Facade)
 * -----------------------------------------------------------------
 * Preserves 100% backward-compatibility for all callers by exposing
 * static methods that delegate to dedicated sub-services:
 *   - qbApiClient: Raw query execution, paging, and backoff retries
 *   - qbEntityService: Entity getters and paginated entity fetchers
 *   - qbSyncService: Multithreaded sync, pagination, and batch export
 *   - qbConnectionService: Connection lifecycle, activation, and status
 * -----------------------------------------------------------------
 */
class QuickBooksService {
    static get SEQUENTIAL_ENTITY_ORDER() { return QuickBooksSyncService.SEQUENTIAL_ENTITY_ORDER; }
    static get PULL_PAGE_SIZE() { return QuickBooksSyncService.PULL_PAGE_SIZE; }
    static get PLAN_LIMITS() { return QuickBooksConnectionService.PLAN_LIMITS; }

    static getMaxConnections(plan) {
        return QuickBooksConnectionService.getMaxConnections(plan);
    }

    static _db() {
        return QuickBooksConnectionService._db();
    }

    // --- OAuth & Connection Methods ---
    static async exchangeAndSaveToken(code, realmId, sessionInfo, userId) {
        return QuickBooksConnectionService.exchangeAndSaveToken(code, realmId, sessionInfo, userId);
    }

    static async listConnections(userId) {
        return QuickBooksConnectionService.listConnections(userId);
    }

    static async getConnectionStats(userId, plan) {
        return QuickBooksConnectionService.getConnectionStats(userId, plan);
    }

    static async disconnectConnection(companyId, userId) {
        return QuickBooksConnectionService.disconnectConnection(companyId, userId);
    }

    static async updateRecordCount(companyId, userId, recordCount) {
        return QuickBooksConnectionService.updateRecordCount(companyId, userId, recordCount);
    }

    static async activateConnection(companyId, userId) {
        return QuickBooksConnectionService.activateConnection(companyId, userId);
    }

    static async renameConnection(companyId, userId, companyName) {
        return QuickBooksConnectionService.renameConnection(companyId, userId, companyName);
    }

    static async pullMasterData(companyId, tier, userId, cursorByCompany) {
        return QuickBooksConnectionService.pullMasterData(companyId, tier, userId, cursorByCompany);
    }

    // --- API Client Query Methods ---
    static async executeQuery(query, token) {
        return QuickBooksApiClient.executeQuery(query, token);
    }

    static async queryAll(entityName, token, batchSize = 1000) {
        return QuickBooksApiClient.queryAll(entityName, token, batchSize);
    }

    static async executeWithRetryAndBackoff(fn, retries = 5, delay = 500) {
        return QuickBooksApiClient.executeWithRetryAndBackoff(fn, retries, delay);
    }

    static async queryPage(entityName, token, startPosition, pageSize) {
        return QuickBooksApiClient.queryPage(entityName, token, startPosition, pageSize);
    }

    // --- Entity Query Methods ---
    static async getCompanyInfo(token, userId) {
        return QuickBooksEntityService.getCompanyInfo(token, userId);
    }

    static async getCompanyMetadata(token) {
        return QuickBooksEntityService.getCompanyMetadata(token);
    }

    static async getCompanyInfoAndOrgNames(userId) {
        return QuickBooksEntityService.getCompanyInfoAndOrgNames(userId);
    }

    static async _getEntityList(entityName, mapperFn, logLabel, userId) {
        return QuickBooksEntityService._getEntityList(entityName, mapperFn, logLabel, userId);
    }

    static async getCustomers(userId) {
        return QuickBooksEntityService.getCustomers(userId);
    }

    static async getVendors(userId) {
        return QuickBooksEntityService.getVendors(userId);
    }

    static async getAccounts(userId) {
        return QuickBooksEntityService.getAccounts(userId);
    }

    static async getClasses(userId) {
        return QuickBooksEntityService.getClasses(userId);
    }

    static async getLocations(userId) {
        return QuickBooksEntityService.getLocations(userId);
    }

    static async _queryEntityPage(entityName, mapperFn, activeTokens, startPosition, pageSize, orgNameByTokenId) {
        return QuickBooksEntityService._queryEntityPage(entityName, mapperFn, activeTokens, startPosition, pageSize, orgNameByTokenId);
    }

    static async getCustomersPage(activeTokens, startPosition, pageSize, orgNameByTokenId) {
        return QuickBooksEntityService.getCustomersPage(activeTokens, startPosition, pageSize, orgNameByTokenId);
    }

    static async getVendorsPage(activeTokens, startPosition, pageSize, orgNameByTokenId) {
        return QuickBooksEntityService.getVendorsPage(activeTokens, startPosition, pageSize, orgNameByTokenId);
    }

    static async getAccountsPage(activeTokens, startPosition, pageSize, orgNameByTokenId) {
        return QuickBooksEntityService.getAccountsPage(activeTokens, startPosition, pageSize, orgNameByTokenId);
    }

    static async getClassesPage(activeTokens, startPosition, pageSize, orgNameByTokenId) {
        return QuickBooksEntityService.getClassesPage(activeTokens, startPosition, pageSize, orgNameByTokenId);
    }

    static async getLocationsPage(activeTokens, startPosition, pageSize, orgNameByTokenId) {
        return QuickBooksEntityService.getLocationsPage(activeTokens, startPosition, pageSize, orgNameByTokenId);
    }

    // --- Sync & Pagination Methods ---
    static async getTotalRecordCountsForToken(token) {
        return QuickBooksSyncService.getTotalRecordCountsForToken(token);
    }

    static async fetchEntityPagesRecursiveAutoTuned(entityName, token, startPosition = 1, currentBatchSize = 1000, accumulatedRecords = [], onChunkCallback = null, updatedSince = null) {
        return QuickBooksSyncService.fetchEntityPagesRecursiveAutoTuned(entityName, token, startPosition, currentBatchSize, accumulatedRecords, onChunkCallback, updatedSince);
    }

    static async pullMasterDataMultithreaded(companyId, tier, userId, onProgress = null, isIncremental = false) {
        return QuickBooksSyncService.pullMasterDataMultithreaded(companyId, tier, userId, onProgress, isIncremental);
    }

    static async _fetchAllPaginatedEntitiesForToken(token, pageSize = 10) {
        return QuickBooksSyncService._fetchAllPaginatedEntitiesForToken(token, pageSize);
    }

    static async _fetchOnePageForToken(token, priorCursor, pageSize = QuickBooksSyncService.PULL_PAGE_SIZE) {
        return QuickBooksSyncService._fetchOnePageForToken(token, priorCursor, pageSize);
    }

    static async exportMasterDataBatch(userId) {
        return QuickBooksSyncService.exportMasterDataBatch(userId);
    }
}

// Plan downgrade listener
eventBus.on('user.downgraded', async ({ userId, email }) => {
    try {
        const { QuickBooksToken, User } = require('../../core/database');
        let targetUserId = userId;
        if (!targetUserId && email) {
            const userObj = await User.findOne({ where: { email } });
            if (userObj) targetUserId = userObj.id;
        }
        if (targetUserId) {
            const deletedCount = await QuickBooksToken.destroy({ where: { user_id: targetUserId } });
            logger.info(`[QuickBooksService] Plan downgrade: cleared ${deletedCount} connections for ${targetUserId}`);
        }
    } catch (err) {
        logger.error(`[QuickBooksService] Failed to clear connections on downgrade for ${userId || email}:`, err.message);
    }
});

module.exports = QuickBooksService;

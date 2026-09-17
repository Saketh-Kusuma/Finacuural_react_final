'use strict';

const axios = require('axios');
const CONSTANTS = require('../../../core/constants');
const XeroMapper = require('../mapper');
const XeroApiClient = require('./xeroApiClient');
const XeroEntityService = require('./xeroEntityService');
const XeroTokenRepository = require('../repository');
const XeroTokenManager = require('../oauth/XeroTokenManager');
const logger = require('../../../core/logger');
const { ErpSessionExpiredError } = require('../../../core/errors/AppError');

class XeroConnectionService {
    static PLAN_LIMITS = { trial: 1, basic: 1, standard: 3, pro: 10 };

    static getMaxConnections(plan) {
        return XeroConnectionService.PLAN_LIMITS[(plan || 'pro').toLowerCase()] ?? 10;
    }

    static _db() {
        return {
            XeroToken: require('../../../core/database').XeroToken,
            Op: require('sequelize').Op
        };
    }

    static async listConnections(userId) {
        const { XeroToken } = XeroConnectionService._db();
        const xeroWhere = userId ? { user_id: userId } : {};
        const xeroTokens = await XeroToken.findAll({ where: xeroWhere });

        return xeroTokens.map(t => ({
            platform:     'Xero',
            companyName:  t.company_name || 'Xero Organisation',
            companyId:    t.tenant_id,
            status:       t.status || 'Not Synced',
            lastSyncedAt: t.last_synced_at || t.updatedAt || null,
            createdAt:    t.createdAt || null,
            recordCount:  t.record_count != null ? t.record_count : null
        }));
    }

    static async getConnectionStats(userId, plan) {
        const { XeroToken, Op } = XeroConnectionService._db();
        const maxAllowed = XeroConnectionService.getMaxConnections(plan);

        const whereClause = { status: { [Op.ne]: 'Disconnected' } };
        if (userId) whereClause.user_id = userId;

        const xeroCount = await XeroToken.count({ where: whereClause });

        return {
            plan: (plan || 'pro').toLowerCase(),
            maxAllowed,
            connected: xeroCount,
            remaining: Math.max(0, maxAllowed - xeroCount)
        };
    }

    static async disconnectConnection(companyId, userId) {
        if (!userId) return false;
        const { XeroToken } = XeroConnectionService._db();
        const [updated] = await XeroToken.update(
            { status: 'Disconnected' },
            { where: { tenant_id: companyId, user_id: userId } }
        );
        return updated > 0;
    }

    static async updateRecordCount(companyId, userId, recordCount) {
        if (!userId || !companyId) return false;
        const { XeroToken } = XeroConnectionService._db();
        const [updated] = await XeroToken.update(
            { record_count: recordCount },
            { where: { tenant_id: companyId, user_id: userId } }
        );
        return updated > 0;
    }

    static async activateConnection(companyId, userId) {
        if (!userId) return false;
        const { XeroToken, Op } = XeroConnectionService._db();

        const [updated] = await XeroToken.update(
            { status: 'Active' },
            { where: { tenant_id: companyId, user_id: userId, status: { [Op.ne]: 'Not Synced' } } }
        );
        if (updated > 0) return true;

        const existing = await XeroToken.findOne({ where: { tenant_id: companyId, user_id: userId } });
        return !!existing;
    }

    static async renameConnection(companyId, userId, companyName) {
        if (!userId) return false;
        const { XeroToken } = XeroConnectionService._db();
        const [updated] = await XeroToken.update(
            { company_name: companyName },
            { where: { tenant_id: companyId, user_id: userId } }
        );
        return updated > 0;
    }

    /**
     * Pre-flight / count query to calculate total records across all entity types for a Xero token.
     * Uses zero loops — pure functional execution via Promise.all, map, filter, and reduce.
     */
    static async getTotalRecordCountsForToken(token) {
        const tenantId = token.companyId || token.tenant_id;
        if (!tenantId) return { Customer: 0, Vendor: 0, Account: 0, Class: 0, Location: 0, total: 0 };

        try {
            const headers = await XeroApiClient._tenantHeaders(tenantId);
            const [contactsRaw, accRes, classRes] = await Promise.all([
                XeroApiClient.queryAllContacts(token).catch(() => ({ Contacts: [] })),
                axios.get(CONSTANTS.XERO.ACCOUNTS_URL, { headers }).catch(() => null),
                axios.get(CONSTANTS.XERO.TRACKING_CATEGORIES_URL, { headers }).catch(() => null)
            ]);

            const contacts = XeroMapper.toContactList(contactsRaw);
            const accounts = accRes ? XeroMapper.toAccountList(accRes.data) : [];
            const classes = classRes ? XeroMapper.toTrackingList(classRes.data, 'class') : [];
            const locations = classRes ? XeroMapper.toTrackingList(classRes.data, 'location') : [];

            const Customer = contacts.filter(c => c.isCustomer || !c.isSupplier).length;
            const Vendor = contacts.filter(c => c.isSupplier).length;
            const Account = accounts.length;
            const Class = classes.length;
            const Location = locations.length;
            const total = Customer + Vendor + Account + Class + Location;

            return { Customer, Vendor, Account, Class, Location, total };
        } catch (err) {
            logger.warn(`Could not fetch total record counts for Xero tenant ${tenantId}:`, err.message);
            return { Customer: 0, Vendor: 0, Account: 0, Class: 0, Location: 0, total: 0 };
        }
    }

    static async pullMasterData(companyId, tier, userId, isIncremental = false) {
        if (!userId) return null;
        const { XeroToken, Op } = XeroConnectionService._db();
        const maxAllowed = XeroConnectionService.getMaxConnections(tier);

        const rawTokens = companyId
            ? await XeroToken.findAll({ where: { tenant_id: companyId, user_id: userId } })
            : await XeroToken.findAll({ where: { user_id: userId, status: { [Op.ne]: 'Disconnected' } }, order: [['updated_at', 'DESC']] });

        const tokens = rawTokens.slice(0, maxAllowed).map(t => ({
            platform:    'xero',
            companyId:   t.tenant_id,
            companyName: t.company_name || 'Xero Organisation',
            tenant_id:   t.tenant_id,
            lastSyncedAt: t.last_synced_at
        }));

        const results = await Promise.all(tokens.map(async (token) => {
            try {
                const xeroGet = async (url, extraHeaders = {}) => {
                    const accessToken = await XeroTokenManager.getValidToken(token.companyId);
                    const headers = {
                        Authorization:    `Bearer ${accessToken}`,
                        'Xero-Tenant-Id': token.companyId,
                        Accept:           'application/json',
                        ...extraHeaders
                    };
                    return axios.get(url, {
                        headers,
                        validateStatus: (status) => (status >= 200 && status < 300) || status === 304
                    });
                };

                const ifModifiedSince = (isIncremental && token.lastSyncedAt)
                    ? new Date(token.lastSyncedAt).toUTCString()
                    : null;
                const deltaHeaders = ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : {};

                const orgSettled = await Promise.allSettled([xeroGet(CONSTANTS.XERO.ORGANISATION_URL)]);
                if (orgSettled[0].status === 'rejected') {
                    const reason = orgSettled[0].reason;

                    if (reason instanceof ErpSessionExpiredError) {
                        throw reason;
                    }

                    if (XeroApiClient.isAuthError(reason)) {
                        await XeroToken.update(
                            { status: 'Disconnected' },
                            { where: { tenant_id: token.companyId } }
                        );
                        throw new ErpSessionExpiredError(
                            'Xero',
                            `Xero refresh token expired/revoked for company "${token.companyName}" (${token.companyId}): ${reason?.message}`
                        );
                    }
                    throw reason;
                }
                const orgRes = orgSettled[0].value;

                const [contactRes, accRes, classRes] = await Promise.all([
                    xeroGet(CONSTANTS.XERO.CONTACTS_URL, deltaHeaders).catch(() => null),
                    xeroGet(CONSTANTS.XERO.ACCOUNTS_URL, deltaHeaders).catch(() => null),
                    xeroGet(CONSTANTS.XERO.TRACKING_CATEGORIES_URL).catch(() => null)
                ]);

                const company  = orgRes ? XeroMapper.toOrganisation(orgRes.data) : null;
                const orgName  = company?.name || token.companyName;
                const companyList = company ? [{ ...company, id: token.companyId }] : [];

                const contacts  = contactRes ? XeroMapper.toContactList(contactRes.data, token.lastSyncedAt) : [];
                const accounts  = accRes     ? XeroMapper.toAccountList(accRes.data, token.lastSyncedAt)     : [];
                const classes   = classRes   ? XeroMapper.toTrackingList(classRes.data, 'class', token.lastSyncedAt)    : [];
                const locations = classRes   ? XeroMapper.toTrackingList(classRes.data, 'location', token.lastSyncedAt) : [];

                const tag = items => items.map(i => ({ ...i, clientId: orgName, clientName: orgName }));
                const isFirstSync = !token.lastSyncedAt;

                if (contactRes && accRes && classRes) {
                    await XeroToken.update(
                        { last_synced_at: new Date(), status: 'Active' },
                        { where: { tenant_id: token.companyId } }
                    );
                }

                return {
                    company: companyList,
                    customers: tag(contacts.filter(c => c.isCustomer || !c.isSupplier)),
                    vendors: tag(contacts.filter(c => c.isSupplier)),
                    accounts: tag(accounts),
                    classes: tag(classes),
                    locations: tag(locations),
                    isFirstSync
                };
            } catch (err) {
                logger.error(`Error pulling Xero data for connection ${token.companyId}:`, err.message);
                throw err;
            }
        }));

        return results.reduce((acc, curr) => ({
            company: [...acc.company, ...curr.company],
            customers: [...acc.customers, ...curr.customers],
            vendors: [...acc.vendors, ...curr.vendors],
            accounts: [...acc.accounts, ...curr.accounts],
            classes: [...acc.classes, ...curr.classes],
            locations: [...acc.locations, ...curr.locations],
            isFirstSync: acc.isFirstSync && curr.isFirstSync
        }), { company: [], customers: [], vendors: [], accounts: [], classes: [], locations: [], isFirstSync: true });
    }

    /**
     * Batched Master Data Sync Engine — Xero edition.
     *
     * Mirrors QuickBooksSyncService.pullMasterDataMultithreaded:
     *  - Contacts are fetched page-by-page (Xero paginates at 100/page).
     *  - Accounts + TrackingCategories are single-request (non-paginated).
     *  - onProgress fires after each contacts page chunk for SSE streaming.
     *  - Updates last_synced_at + status on the XeroToken row on completion.
     *
     * @param {string}   companyId     - tenant_id to scope to one org, or null for all
     * @param {string}   tier          - subscription plan ('trial'|'basic'|'standard'|'pro')
     * @param {string}   userId
     * @param {Function} [onProgress]  - ({ type, companyName?, companyId?, fetchedRecords?, currentEntity? }) => void
     * @param {boolean}  [isIncremental]
     * @returns {Promise<AggregatedMasterData|null>}
     */
    static async pullMasterDataBatched(companyId, tier, userId, onProgress = null, isIncremental = false) {
        if (!userId) return null;
        const customLogger = require('../../../config/logger');
        const { XeroToken, Op } = XeroConnectionService._db();
        const maxAllowed = XeroConnectionService.getMaxConnections(tier);

        const CONTACTS_PAGE_SIZE = 100; // Xero hard cap per page

        const rawTokens = companyId
            ? await XeroToken.findAll({ where: { tenant_id: companyId, user_id: userId } })
            : await XeroToken.findAll({ where: { user_id: userId, status: { [Op.ne]: 'Disconnected' } }, order: [['updated_at', 'DESC']] });

        const tokens = rawTokens.slice(0, maxAllowed).map(t => ({
            platform:    'xero',
            companyId:   t.tenant_id,
            companyName: t.company_name || 'Xero Organisation',
            tenant_id:   t.tenant_id,
            lastSyncedAt: t.last_synced_at
        }));

        if (!tokens || tokens.length === 0) return null;

        const results = await tokens.reduce(async (companyAccPromise, token) => {
            const companyAcc = await companyAccPromise;

            const tenantId = token.companyId;
            const headers  = await XeroApiClient._tenantHeaders(tenantId);

            // --- Organisation (company info) ---
            const orgSettled = await Promise.allSettled([
                axios.get(CONSTANTS.XERO.ORGANISATION_URL, { headers })
            ]);

            if (orgSettled[0].status === 'rejected') {
                const reason = orgSettled[0].reason;
                if (reason instanceof ErpSessionExpiredError) throw reason;
                if (XeroApiClient.isAuthError(reason)) {
                    await XeroToken.update(
                        { status: 'Disconnected' },
                        { where: { tenant_id: tenantId } }
                    );
                    throw new ErpSessionExpiredError(
                        'Xero',
                        `Xero refresh token expired/revoked for company "${token.companyName}" (${tenantId}): ${reason?.message}`
                    );
                }
                throw reason;
            }

            const company   = XeroMapper.toOrganisation(orgSettled[0].value.data);
            const orgName   = company?.name || token.companyName;
            const companyList = company ? [{ ...company, id: tenantId }] : [];

            let totalFetchedSoFar = 0;
            customLogger.info({ tenantId, orgName, isIncremental }, 'Starting Xero Master Data Sync');

            if (typeof onProgress === 'function') {
                onProgress({ type: 'start', companyName: orgName, companyId: tenantId });
            }

            // --- Contacts: paginated ---
            const ifModifiedSince = (isIncremental && token.lastSyncedAt)
                ? new Date(token.lastSyncedAt).toUTCString()
                : null;
            const deltaHeaders = ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : {};

            const onChunk = (chunkSize) => {
                totalFetchedSoFar += chunkSize;
                customLogger.debug({ chunkSize, totalFetchedSoFar, tenantId }, 'Fetched Xero contacts chunk');
                if (typeof onProgress === 'function') {
                    onProgress({ type: 'progress', fetchedRecords: totalFetchedSoFar, currentEntity: 'Contacts' });
                }
            };

            const contactsRaw = await XeroApiClient.queryAllContacts(
                token,
                CONTACTS_PAGE_SIZE,
                deltaHeaders,
                onChunk
            );

            // --- Accounts + TrackingCategories: non-paginated, fetch in parallel ---
            const accountsHeaders = ifModifiedSince ? { ...headers, 'If-Modified-Since': ifModifiedSince } : headers;
            const [accRes, classRes] = await Promise.all([
                axios.get(CONSTANTS.XERO.ACCOUNTS_URL, { headers: accountsHeaders })
                    .catch(() => null),
                axios.get(CONSTANTS.XERO.TRACKING_CATEGORIES_URL, { headers })
                    .catch(() => null)
            ]);

            // Count non-paged records toward progress
            const accCount  = accRes?.data?.Accounts?.length   || 0;
            const catCount  = classRes?.data?.TrackingCategories?.length || 0;
            totalFetchedSoFar += accCount + catCount;
            if (accCount + catCount > 0 && typeof onProgress === 'function') {
                onProgress({ type: 'progress', fetchedRecords: totalFetchedSoFar, currentEntity: 'Accounts & Categories' });
            }

            const contacts  = XeroMapper.toContactList(contactsRaw, token.lastSyncedAt);
            const accounts  = accRes   ? XeroMapper.toAccountList(accRes.data, token.lastSyncedAt)                    : [];
            const classes   = classRes ? XeroMapper.toTrackingList(classRes.data, 'class',    token.lastSyncedAt)     : [];
            const locations = classRes ? XeroMapper.toTrackingList(classRes.data, 'location', token.lastSyncedAt)     : [];

            const tag = (items) => items.map(i => ({ ...i, clientId: orgName, clientName: orgName }));
            const isFirstSync = !token.lastSyncedAt;

            await XeroToken.update(
                { last_synced_at: new Date(), status: 'Active' },
                { where: { tenant_id: tenantId } }
            );

            customLogger.info({ tenantId, totalRecords: totalFetchedSoFar }, 'Xero Master Data Sync Complete');

            companyAcc.push({
                company: companyList,
                customers: tag(contacts.filter(c => c.isCustomer || !c.isSupplier)),
                vendors:   tag(contacts.filter(c => c.isSupplier)),
                accounts:  tag(accounts),
                classes:   tag(classes),
                locations: tag(locations),
                isFirstSync,
                isDone: true
            });

            return companyAcc;
        }, Promise.resolve([]));

        return results.reduce((acc, curr) => ({
            company:    [...acc.company,    ...curr.company],
            customers:  [...acc.customers,  ...curr.customers],
            vendors:    [...acc.vendors,    ...curr.vendors],
            accounts:   [...acc.accounts,   ...curr.accounts],
            classes:    [...acc.classes,    ...curr.classes],
            locations:  [...acc.locations,  ...curr.locations],
            isFirstSync: acc.isFirstSync && curr.isFirstSync,
            isDone: true
        }), { company: [], customers: [], vendors: [], accounts: [], classes: [], locations: [], isFirstSync: true, isDone: true });
    }
}

module.exports = XeroConnectionService;

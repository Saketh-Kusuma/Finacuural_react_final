'use strict';

const axios = require('axios');
const querystring = require('querystring');
const config = require('../../../core/config');
const CONSTANTS = require('../../../core/constants');
const { encodeBasicAuth } = require('../../../core/helpers');
const QuickBooksTokenRepository = require('../repository');
const QuickBooksMapper = require('../mapper');
const QuickBooksApiClient = require('./qbApiClient');
const QuickBooksSyncService = require('./qbSyncService');
const logger = require('../../../core/logger');
const { AppError, ErpSessionExpiredError } = require('../../../core/errors/AppError');

class QuickBooksConnectionService {
    static PLAN_LIMITS = { trial: 1, basic: 1, standard: 3, pro: 10 };

    static getMaxConnections(plan) {
        return QuickBooksConnectionService.PLAN_LIMITS[(plan || 'pro').toLowerCase()] ?? 10;
    }

    static _db() {
        return {
            QuickBooksToken: require('../../../core/database').QuickBooksToken,
            Op: require('sequelize').Op
        };
    }

    /**
     * Exchange OAuth authorization code for tokens, query CompanyInfo, and persist connection.
     */
    static async exchangeAndSaveToken(code, realmId, sessionInfo, userId) {
        const credentials = encodeBasicAuth(config.QB.CLIENT_ID, config.QB.CLIENT_SECRET);

        const response = await axios.post(
            CONSTANTS.QUICKBOOKS.TOKEN_URL,
            querystring.stringify({
                grant_type:   'authorization_code',
                code,
                redirect_uri: config.QB.REDIRECT_URI
            }),
            {
                headers: {
                    Accept:         'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization:  `Basic ${credentials}`
                }
            }
        );

        const tokenData = response.data;

        let companyName = 'QuickBooks Company';
        try {
            const url = `${CONSTANTS.QUICKBOOKS.BASE_URL}/v3/company/${realmId}/query`;
            const compRes = await axios.get(url, {
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/text'
                },
                params: { query: 'SELECT * FROM CompanyInfo' }
            });
            const compInfo = QuickBooksMapper.toCompanyInfo(compRes.data);
            companyName = compInfo ? (compInfo.name || compInfo.legalName || realmId) : 'QuickBooks Company';
        } catch (compErr) {
            logger.warn(`Could not fetch company info directly during OAuth exchange for realm ${realmId}:`, compErr.message);
        }

        await QuickBooksTokenRepository.upsertToken({
            realm_id: realmId,
            access_token: tokenData.access_token || '',
            refresh_token: tokenData.refresh_token || '',
            token_type: tokenData.token_type || '',
            expires_in: Math.floor(Date.now() / 1000) + (tokenData.expires_in || 0),
            x_refresh_token_expires_in: Math.floor(Date.now() / 1000) + (tokenData.x_refresh_token_expires_in || 0),
            session_info: sessionInfo,
            user_id: userId,
            company_name: companyName,
            status: 'Not Synced'
        });
    }

    static async listConnections(userId) {
        const { QuickBooksToken } = QuickBooksConnectionService._db();
        const qbWhere = userId ? { user_id: userId } : {};
        const qbTokens = await QuickBooksToken.findAll({ where: qbWhere });

        return qbTokens.map(t => ({
            platform:     'QuickBooks',
            companyName:  t.company_name || 'QuickBooks Company',
            companyId:    t.realm_id,
            status:       t.status || 'Not Synced',
            lastSyncedAt: t.last_synced_at || t.updated_at || null,
            createdAt:    t.created_at || null,
            recordCount:  t.record_count != null ? t.record_count : null
        }));
    }

    static async getConnectionStats(userId, plan) {
        const { QuickBooksToken, Op } = QuickBooksConnectionService._db();
        const maxAllowed = QuickBooksConnectionService.getMaxConnections(plan);

        const whereClause = { status: { [Op.ne]: 'Disconnected' } };
        if (userId) whereClause.user_id = userId;

        const qbCount = await QuickBooksToken.count({ where: whereClause });

        return {
            plan: (plan || 'pro').toLowerCase(),
            maxAllowed,
            connected: qbCount,
            remaining: Math.max(0, maxAllowed - qbCount)
        };
    }

    static async disconnectConnection(companyId, userId) {
        if (!userId) return false;
        const { QuickBooksToken } = QuickBooksConnectionService._db();
        const [updated] = await QuickBooksToken.update(
            { status: 'Disconnected' },
            { where: { realm_id: companyId, user_id: userId } }
        );
        return updated > 0;
    }

    static async updateRecordCount(companyId, userId, recordCount) {
        if (!userId || !companyId) return false;
        const { QuickBooksToken } = QuickBooksConnectionService._db();
        const [updated] = await QuickBooksToken.update(
            { record_count: recordCount },
            { where: { realm_id: companyId, user_id: userId } }
        );
        return updated > 0;
    }

    static async activateConnection(companyId, userId) {
        if (!userId) return false;
        const { QuickBooksToken, Op } = QuickBooksConnectionService._db();

        const [updated] = await QuickBooksToken.update(
            { status: 'Active' },
            { where: { realm_id: companyId, user_id: userId, status: { [Op.ne]: 'Not Synced' } } }
        );
        if (updated > 0) return true;

        const existing = await QuickBooksToken.findOne({ where: { realm_id: companyId, user_id: userId } });
        return !!existing;
    }

    static async renameConnection(companyId, userId, companyName) {
        if (!userId) return false;
        const { QuickBooksToken } = QuickBooksConnectionService._db();
        const [updated] = await QuickBooksToken.update(
            { company_name: companyName },
            { where: { realm_id: companyId, user_id: userId } }
        );
        return updated > 0;
    }

    static async pullMasterData(companyId, tier, userId, cursorByCompany) {
        if (!userId) return null;
        const { QuickBooksToken, Op } = QuickBooksConnectionService._db();
        const maxAllowed = QuickBooksConnectionService.getMaxConnections(tier);

        const rawTokens = companyId
            ? await QuickBooksToken.findAll({ where: { realm_id: companyId, user_id: userId } })
            : await QuickBooksToken.findAll({ where: { user_id: userId, status: { [Op.ne]: 'Disconnected' } }, order: [['updated_at', 'DESC']] });

        const tokens = rawTokens.slice(0, maxAllowed).map(t => ({
            platform:     'quickbooks',
            companyId:    t.realm_id,
            companyName:  t.company_name || 'QuickBooks Company',
            realm_id:     t.realm_id,
            lastSyncedAt: t.last_synced_at
        }));

        const safeCursorByCompany = cursorByCompany && typeof cursorByCompany === 'object' ? cursorByCompany : {};

        const results = await Promise.all(tokens.map(async (token) => {
            try {
                const rawComp = await QuickBooksApiClient.executeQuery('SELECT * FROM CompanyInfo', token);
                const comp = QuickBooksMapper.toCompanyInfo(rawComp);
                const companyList = comp ? [{ ...comp, id: token.companyId }] : [];

                const priorCursor = safeCursorByCompany[token.companyId] || null;
                const pageResult = await QuickBooksSyncService._fetchOnePageForToken(token, priorCursor, QuickBooksSyncService.PULL_PAGE_SIZE);
                const pagedEntities = pageResult.recordsByEntity;
                const rawCust  = { QueryResponse: { Customer:   pagedEntities.Customer } };
                const rawVend  = { QueryResponse: { Vendor:     pagedEntities.Vendor } };
                const rawAcc   = { QueryResponse: { Account:    pagedEntities.Account } };
                const rawClass = { QueryResponse: { Class:      pagedEntities.Class } };
                const rawLoc   = { QueryResponse: { Department: pagedEntities.Department } };

                const orgName = comp?.name || comp?.legalName || token.companyName;
                const tag = (list) => list.map(i => ({ ...i, clientId: orgName, clientName: orgName }));

                const isFirstSync = !token.lastSyncedAt;

                await QuickBooksToken.update(
                    pageResult.isDone
                        ? { last_synced_at: new Date(), status: 'Active' }
                        : { status: 'Active' },
                    { where: { realm_id: token.companyId } }
                );

                return {
                    company: companyList,
                    customers: tag(QuickBooksMapper.toCustomerList(rawCust, token.lastSyncedAt)),
                    vendors: tag(QuickBooksMapper.toVendorList(rawVend, token.lastSyncedAt)),
                    accounts: tag(QuickBooksMapper.toAccountList(rawAcc, token.lastSyncedAt)),
                    classes: tag(QuickBooksMapper.toClassList(rawClass, token.lastSyncedAt)),
                    locations: tag(QuickBooksMapper.toLocationList(rawLoc, token.lastSyncedAt)),
                    isFirstSync,
                    companyIdForCursor: token.companyId,
                    cursor: pageResult.cursor,
                    isDone: pageResult.isDone
                };
            } catch (err) {
                logger.error(`Error pulling QB data for connection ${token.companyId}:`, err.message);

                const faultError = err.response?.data?.Fault?.Error?.[0];
                if (faultError?.code === '8020' || (faultError?.Message && faultError.Message.includes('Subscription is not active'))) {
                    await QuickBooksToken.update(
                        { status: 'Disconnected' },
                        { where: { realm_id: token.companyId } }
                    );
                    throw new AppError(
                        'Your QuickBooks subscription has expired or been suspended. Please log into QuickBooks to update your billing.',
                        403,
                        'ERR_QB_SUBSCRIPTION_EXPIRED'
                    );
                }

                const isTokenError = err.response?.status === 401
                    || err.statusCode === 401
                    || (err.message && (err.message.includes('Token expired') || err.message.includes('401') || err.message.includes('grant')));

                if (isTokenError || err.message?.includes('OAuth')) {
                    await QuickBooksToken.update(
                        { status: 'Disconnected' },
                        { where: { realm_id: token.companyId } }
                    );
                    throw new ErpSessionExpiredError(
                        'QuickBooks',
                        `QuickBooks refresh token expired/revoked for company "${token.companyName}" (${token.companyId}): ${err.message}`
                    );
                }

                throw err;
            }
        }));

        const aggregated = results.reduce((acc, curr) => ({
            company: [...acc.company, ...curr.company],
            customers: [...acc.customers, ...curr.customers],
            vendors: [...acc.vendors, ...curr.vendors],
            accounts: [...acc.accounts, ...curr.accounts],
            classes: [...acc.classes, ...curr.classes],
            locations: [...acc.locations, ...curr.locations],
            isFirstSync: acc.isFirstSync && curr.isFirstSync,
            isDone: acc.isDone && !!curr.isDone
        }), { company: [], customers: [], vendors: [], accounts: [], classes: [], locations: [], isFirstSync: true, isDone: true });

        aggregated.cursor = {};
        results.forEach(r => {
            if (r && r.companyIdForCursor) {
                aggregated.cursor[r.companyIdForCursor] = r.cursor;
            }
        });

        return aggregated;
    }
}

module.exports = QuickBooksConnectionService;

'use strict';

const querystring = require('querystring');
const exceljs = require('exceljs');
const config = require('../../core/config');
const CONSTANTS = require('../../core/constants');
const { generateOAuthState, renderOAuthBlockedPage } = require('../../core/helpers');
const QuickBooksService = require('./service');
const QuickBooksTokenRepository = require('./repository');
const { ValidationError, AppError } = require('../../core/errors/AppError');
const asyncHandler = require('../../core/errors/asyncHandler');

/**
 * QuickbooksController
 * -----------------------------------------------------------------
 * Handles all incoming HTTP requests for the QuickBooks module.
 * Delegates business logic and pagination to QuickBooksService.
 * Handlers are wrapped in asyncHandler for centralized error handling.
 * -----------------------------------------------------------------
 */
class QuickbooksController {

    // ── OAuth Handlers ───────────────────────────────────────────────

    /**
     * GET /api/quickbooks/connect
     */
    connectQuickbooks = asyncHandler(async (req, res, next) => {
        const { QuickBooksToken } = require('../../core/database');
        const userId = req.user.userId || req.user.id;
        const { Op } = require('sequelize');
        const tier = (req.query.tier || 'pro').toLowerCase();

        let maxAllowed = 10;
        if (tier === 'trial') maxAllowed = 1;
        else if (tier === 'basic') maxAllowed = 1;
        else if (tier === 'standard') maxAllowed = 3;

        const reconnectId = String(req.query.reconnectId || '').trim() || null;

        if (reconnectId) {
            const reconnectTarget = await QuickBooksToken.findOne({ where: { realm_id: reconnectId, user_id: userId } });
            if (!reconnectTarget) {
                return res.send(renderOAuthBlockedPage({
                    title: 'Company Not Found',
                    lines: [
                        'The company you tried to reconnect is no longer part of your account.',
                        'Please reload the add-in and try again.'
                    ]
                }));
            }
        } else {
            const whereClause = { status: { [Op.ne]: 'Disconnected' }, user_id: userId };
            const qbCount = await QuickBooksToken.count({ where: whereClause });

            if (qbCount >= maxAllowed) {
                return res.send(renderOAuthBlockedPage({
                    title: 'Connection Limit Reached',
                    lines: [
                        `Your subscription tier (${tier.toUpperCase()}) allows a maximum of ${maxAllowed} connected company.`,
                        'Please disconnect an existing company or upgrade your plan to connect more.'
                    ]
                }));
            }
        }

        const state = generateOAuthState();
        req.session.oauth_state = state;
        req.session.user_id = userId;
        req.session.qb_tier = tier;
        req.session.qb_max_allowed = maxAllowed;
        req.session.qb_reconnect_id = reconnectId;

        const params = {
            client_id:     config.QB.CLIENT_ID,
            response_type: 'code',
            scope:         CONSTANTS.QUICKBOOKS.SCOPES,
            redirect_uri:  config.QB.REDIRECT_URI,
            state
        };

        const authUrl = `${CONSTANTS.QUICKBOOKS.AUTH_URL}?${querystring.stringify(params)}`;
        res.redirect(authUrl);
    });

    /**
     * GET /api/quickbooks/callback
     */
    quickbooksCallback = async (req, res, next) => {
        try {
            const { code, realmId } = req.query;
            const userId = req.session?.user_id || req.session?.admin?.id || null;

            const tier       = (req.session?.qb_tier || 'pro').toLowerCase();
            const maxAllowed = req.session?.qb_max_allowed || 10;
            const reconnectId = req.session?.qb_reconnect_id || null;

            if (reconnectId && String(realmId) !== String(reconnectId)) {
                delete req.session.qb_reconnect_id;
                return res.send(renderOAuthBlockedPage({
                    title: 'Invalid Company Selected',
                    icon: '🚫',
                    lines: [
                        'You started a reconnect for one specific company, but a different company was authorized in QuickBooks.',
                        'Please click Reconnect again and choose the same company in the Intuit window.'
                    ]
                }));
            }

            if (!reconnectId && userId) {
                const { QuickBooksToken } = require('../../core/database');
                const { Op } = require('sequelize');

                const alreadyConnected = await QuickBooksToken.findOne({
                    where: {
                        user_id: userId,
                        realm_id: String(realmId),
                        status: { [Op.ne]: 'Disconnected' }
                    }
                });

                if (alreadyConnected) {
                    const compName = alreadyConnected.company_name || realmId;
                    return res.send(renderOAuthBlockedPage({
                        title: 'Company Already Connected',
                        icon: '⚠️',
                        errorPayload: {
                            type: 'company_already_connected',
                            platform: 'quickbooks',
                            realmId: String(realmId),
                            companyName: compName
                        },
                        lines: [
                            `The company "${compName}" is already connected to your FinAccrual account.`,
                            'To add another company, please select a different company during the QuickBooks authorization step.'
                        ]
                    }));
                }

                const otherCount = await QuickBooksToken.count({
                    where: { user_id: userId, realm_id: { [Op.ne]: realmId } }
                });

                if (otherCount + 1 > maxAllowed) {
                    return res.send(renderOAuthBlockedPage({
                        title: 'Connection Limit Reached',
                        lines: [
                            `Your subscription tier (${tier.toUpperCase()}) allows a maximum of ${maxAllowed} company in total.`,
                            `You have already connected ${otherCount} ${otherCount === 1 ? 'company' : 'companies'} on this account.`,
                            'Reconnect one of your existing companies, or upgrade your plan to add a new one.'
                        ]
                    }));
                }
            }

            const sessionInfo = JSON.stringify(req.session || {});
            await QuickBooksService.exchangeAndSaveToken(code, realmId, sessionInfo, userId);
            delete req.session.qb_reconnect_id;
            return res.send(CONSTANTS.QUICKBOOKS.SUCCESS_HTML);
        } catch (error) {
            const details = JSON.stringify(error.response?.data || error.message);
            next(new ValidationError('Failed to connect QuickBooks. Please try again.', details));
        }
    };

    /**
     * GET /api/quickbooks/tokens
     */
    listQuickbooksTokens = asyncHandler(async (req, res, next) => {
        const tokens = await QuickBooksTokenRepository.getAllTokens(req.user.userId || req.user.id);
        res.json({ tokens });
    });

    /**
     * POST /api/quickbooks/disconnect
     */
    disconnectQuickbooks = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        await QuickBooksTokenRepository.clearTokens(userId);
        res.json({ success: true, message: 'QuickBooks tokens cleared successfully.' });
    });

    // ── Data Handlers ────────────────────────────────────────────────

    /**
     * GET /api/quickbooks/customers
     */
    getCustomers = asyncHandler(async (req, res, next) => {
        const customers = await QuickBooksService.getCustomers(req.user.userId || req.user.id);
        res.json({ customers });
    });

    /**
     * GET /api/quickbooks/vendors
     */
    getVendors = asyncHandler(async (req, res, next) => {
        const vendors = await QuickBooksService.getVendors(req.user.userId || req.user.id);
        res.json({ vendors });
    });

    /**
     * GET /api/quickbooks/accounts
     */
    getAccounts = asyncHandler(async (req, res, next) => {
        const accounts = await QuickBooksService.getAccounts(req.user.userId || req.user.id);
        res.json({ accounts });
    });

    /**
     * GET /api/quickbooks/classes
     */
    getClasses = asyncHandler(async (req, res, next) => {
        const classes = await QuickBooksService.getClasses(req.user.userId || req.user.id);
        res.json({ classes });
    });

    /**
     * GET /api/quickbooks/locations
     */
    getLocations = asyncHandler(async (req, res, next) => {
        const locations = await QuickBooksService.getLocations(req.user.userId || req.user.id);
        res.json({ locations });
    });

    /**
     * GET /api/quickbooks/company
     */
    getCompanyInfo = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const company = await QuickBooksService.getCompanyInfo(undefined, userId);
        if (!company) {
            throw new AppError(
                'The requested resource was not found.',
                404,
                'ERR_NOT_FOUND',
                'No active QuickBooks company found. Please connect QuickBooks first.'
            );
        }
        res.json({ company });
    });

    /**
     * GET /api/quickbooks/export
     */
    exportMasterData = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const { company, customers, vendors, accounts, classes, locations } =
            await QuickBooksService.exportMasterDataBatch(userId);

        const wb = new exceljs.Workbook();

        if (company) {
            const wsCompany = wb.addWorksheet('Company');
            wsCompany.addRow(['ID', 'Company Name', 'Legal Name']);
            wsCompany.addRow([company.id, company.name, company.legalName]);
        }

        const wsCustomers = wb.addWorksheet('Customers');
        wsCustomers.addRow(['ID', 'Name', 'Company Name', 'Email', 'Balance']);
        wsCustomers.addRows(customers.map(c => [c.id, c.name, c.companyName, c.email, c.balance]));

        const wsVendors = wb.addWorksheet('Vendors');
        wsVendors.addRow(['ID', 'Name', 'Company Name', 'Email', 'Balance']);
        wsVendors.addRows(vendors.map(v => [v.id, v.name, v.companyName, v.email, v.balance]));

        const wsAccounts = wb.addWorksheet('Accounts');
        wsAccounts.addRow(['ID', 'Acct #', 'Name', 'Account Type', 'Sub Type', 'Balance']);
        wsAccounts.addRows(accounts.map(a => [a.id, a.acctNum, a.name, a.accountType, a.accountSubType, a.currentBalance]));

        const wsClasses = wb.addWorksheet('Classes');
        wsClasses.addRow(['ID', 'Name', 'Status']);
        wsClasses.addRows(classes.map(c => [c.id, c.name, c.active]));

        const wsLocations = wb.addWorksheet('Locations');
        wsLocations.addRow(['ID', 'Name', 'Status']);
        wsLocations.addRows(locations.map(l => [l.id, l.name, l.active]));

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="quickbooks_master_data.xlsx"');

        await wb.xlsx.write(res);
        res.end();
    });

    // ── Connection Handlers ──────────────────────────────────────────

    /**
     * GET /api/quickbooks/connections
     */
    listConnections = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const list = await QuickBooksService.listConnections(userId);
        return res.json(list);
    });

    /**
     * GET /api/quickbooks/connections/stats
     */
    getConnectionStats = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const plan = req.query.plan || 'pro';

        const stats = {
            plan: plan.toLowerCase(),
            maxPerPlatform: 10,
            quickbooks: { connected: 0, remaining: 10 }
        };

        if (plan === 'trial')    stats.maxPerPlatform = 1;
        else if (plan === 'basic')    stats.maxPerPlatform = 1;
        else if (plan === 'standard') stats.maxPerPlatform = 3;

        const qbStats = await QuickBooksService.getConnectionStats(userId, plan);
        stats.quickbooks = {
            connected: qbStats.connected,
            remaining: qbStats.remaining
        };

        return res.json(stats);
    });

    /**
     * DELETE /api/quickbooks/connections/:id
     */
    disconnectConnection = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const success = await QuickBooksService.disconnectConnection(companyId, userId);
        return res.json({ success: !!success });
    });

    /**
     * POST /api/quickbooks/connections/:id/activate
     */
    activateConnection = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const success = await QuickBooksService.activateConnection(companyId, userId);

        let totalRecords = 0;
        if (success) {
            try {
                const token = { companyId, realm_id: companyId };
                const countInfo = await QuickBooksService.getTotalRecordCountsForToken(token);
                totalRecords = countInfo.total;
            } catch (err) {}
        }

        return res.json({ success: !!success, totalRecords });
    });

    /**
     * GET /api/quickbooks/connections/:id/count
     */
    getConnectionRecordCount = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        try {
            const token = { companyId, realm_id: companyId };
            const countInfo = await QuickBooksService.getTotalRecordCountsForToken(token);
            return res.json({
                success: true,
                companyId,
                totalRecords: countInfo.total,
                details: countInfo
            });
        } catch (err) {
            return res.json({
                success: false,
                companyId,
                totalRecords: 0,
                error: err.message
            });
        }
    });

    /**
     * PATCH /api/quickbooks/connections/:id/rename
     */
    renameConnection = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const { companyName } = req.body;
        if (!companyName) {
            throw new ValidationError('companyName is required.');
        }

        const success = await QuickBooksService.renameConnection(companyId, userId, companyName);
        return res.json({ success: !!success });
    });

    /**
     * PATCH /api/quickbooks/connections/:id/record-count
     */
    updateRecordCount = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const { recordCount } = req.body;
        if (recordCount == null || isNaN(Number(recordCount))) {
            throw new ValidationError('recordCount must be a number.');
        }
        const success = await QuickBooksService.updateRecordCount(companyId, userId, Number(recordCount));
        return res.json({ success: !!success });
    });

    /**
     * GET /api/quickbooks/pull-master-data?companyId=...&tier=...&stream=...
     */
    pullMasterData = asyncHandler(async (req, res, next) => {
        const { companyId, tier, mode, stream } = req.query;
        const isIncremental = mode === 'incremental';
        const userId = req.user.userId || req.user.id;

        if (stream === 'true' || req.headers.accept?.includes('text/event-stream')) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.status(200);

            const heartbeatInterval = setInterval(() => {
                res.write(': heartbeat ping\n\n');
            }, 15000);

            try {
                const onProgress = (event) => {
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                };

                const aggregated = await QuickBooksService.pullMasterDataMultithreaded(companyId, tier, userId, onProgress, isIncremental);
                clearInterval(heartbeatInterval);

                res.write(`data: ${JSON.stringify({ type: 'complete', data: aggregated })}\n\n`);
                return res.end();
            } catch (err) {
                clearInterval(heartbeatInterval);
                res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
                return res.end();
            }
        }

        const aggregated = await QuickBooksService.pullMasterDataMultithreaded(companyId, tier, userId, null, isIncremental);

        if (!aggregated) {
            throw new AppError('The requested resource was not found.', 404, 'ERR_NOT_FOUND', `No active connections found for quickbooks.`);
        }

        return res.json({
            company:   aggregated.company.length === 1 ? aggregated.company[0] : aggregated.company,
            customers: aggregated.customers,
            vendors:   aggregated.vendors,
            accounts:  aggregated.accounts,
            classes:   aggregated.classes,
            locations: aggregated.locations,
            isFirstSync: aggregated.isFirstSync,
            isDone: true
        });
    });

    /**
     * GET /api/quickbooks/refresh-incremental?companyId=...&tier=...
     */
    refreshIncremental = asyncHandler(async (req, res, next) => {
        const { companyId, tier } = req.query;
        const userId = req.user.userId || req.user.id;
        const aggregated = await QuickBooksService.pullMasterDataMultithreaded(companyId, tier, userId, null, true);

        if (!aggregated) {
            throw new AppError('No active connection found for refresh.', 404, 'ERR_NOT_FOUND', 'QuickBooks connection not found.');
        }

        return res.json({
            company:   aggregated.company.length === 1 ? aggregated.company[0] : aggregated.company,
            customers: aggregated.customers,
            vendors:   aggregated.vendors,
            accounts:  aggregated.accounts,
            classes:   aggregated.classes,
            locations: aggregated.locations,
            isFirstSync: false,
            isIncremental: true,
            isDone: true
        });
    });
}

module.exports = new QuickbooksController();

'use strict';

const querystring = require('querystring');
const config = require('../../core/config');
const CONSTANTS = require('../../core/constants');
const { generateOAuthState, renderOAuthBlockedPage } = require('../../core/helpers');
const { renderCompanySelectionPage } = require('./views/companySelection.view');
const XeroService = require('./service');
const XeroTokenRepository = require('./repository');
const { ValidationError, AppError } = require('../../core/errors/AppError');
const asyncHandler = require('../../core/errors/asyncHandler');

/**
 * XeroController
 * -----------------------------------------------------------------
 * Handles all incoming HTTP requests for the Xero module.
 * Delegates business logic to XeroService and view rendering to views/.
 * Handlers are wrapped in asyncHandler for centralized error handling.
 * -----------------------------------------------------------------
 */
class XeroController {

    // ── OAuth Handlers ───────────────────────────────────────────────

    /**
     * GET /api/xero/connect
     */
    connectXero = asyncHandler(async (req, res, next) => {
        const { XeroToken } = require('../../core/database');
        const userId = req.user.userId || req.user.id;
        const { Op } = require('sequelize');
        const tier = (req.query.tier || 'pro').toLowerCase();

        let maxAllowed = 10;
        if (tier === 'trial') maxAllowed = 1;
        else if (tier === 'basic') maxAllowed = 1;
        else if (tier === 'standard') maxAllowed = 3;

        const reconnectId = String(req.query.reconnectId || '').trim() || null;

        if (reconnectId) {
            const reconnectTarget = await XeroToken.findOne({ where: { tenant_id: reconnectId, user_id: userId } });
            if (!reconnectTarget) {
                return res.send(renderOAuthBlockedPage({
                    title: 'Organisation Not Found',
                    lines: [
                        'The organisation you tried to reconnect is no longer part of your account.',
                        'Please reload the add-in and try again.'
                    ]
                }));
            }
        } else {
            const whereClause = { status: { [Op.ne]: 'Disconnected' }, user_id: userId };
            const xeroCount = await XeroToken.count({ where: whereClause });

            if (xeroCount >= maxAllowed) {
                return res.send(renderOAuthBlockedPage({
                    title: 'Connection Limit Reached',
                    lines: [
                        `Your subscription tier (${tier.toUpperCase()}) allows a maximum of ${maxAllowed} connected organisation.`,
                        'Please disconnect an existing organisation or upgrade your plan to connect more.'
                    ]
                }));
            }
        }

        const state = generateOAuthState();
        req.session.oauth_state = state;
        req.session.xero_state = state;
        req.session.user_id = userId;
        req.session.xero_tier = tier;
        req.session.xero_max_allowed = maxAllowed;
        req.session.xero_reconnect_id = reconnectId;

        const params = {
            response_type: 'code',
            client_id:     config.XERO.CLIENT_ID,
            redirect_uri:  config.XERO.REDIRECT_URI,
            scope:         CONSTANTS.XERO.SCOPES,
            state
        };

        const authUrl = `${CONSTANTS.XERO.AUTH_URL}?${querystring.stringify(params)}`;
        res.redirect(authUrl);
    });

    /**
     * GET /api/xero/callback
     */
    xeroCallback = async (req, res, next) => {
        try {
            const { code } = req.query;
            const userId      = req.session?.user_id || req.session?.admin?.id || null;
            const tier        = req.session?.xero_tier || 'pro';
            const maxAllowed  = req.session?.xero_max_allowed || 10;
            const reconnectId = req.session?.xero_reconnect_id || null;

            const { tokens, tenants: allTenants } = await XeroService.exchangeTokensOnly(code);

            let tenants = allTenants;
            if (reconnectId) {
                tenants = allTenants.filter(t => String(t.tenantId) === String(reconnectId));
                if (tenants.length === 0) {
                    delete req.session.xero_reconnect_id;
                    return res.send(renderOAuthBlockedPage({
                        title: 'Invalid Company Selected',
                        icon: '🚫',
                        lines: [
                            'You started a reconnect for one specific organisation, but it was not among the organisations you authorized in Xero.',
                            'Please click Reconnect again and grant access to the same organisation.'
                        ]
                    }));
                }
            }

            if (tenants.length === 0) {
                return res.status(400).send(`
                    <html><body style="font-family:sans-serif;text-align:center;padding:40px;">
                        <h2>No Xero organisations found.</h2>
                        <p>Make sure your Xero account has at least one organisation.</p>
                        <button onclick="window.close()">Close</button>
                    </body></html>
                `);
            }

            req.session.xero_pending_tokens  = tokens;
            req.session.xero_pending_tenants = tenants;
            req.session.xero_pending_user_id = userId;

            const { XeroToken } = require('../../core/database');
            const { Op } = require('sequelize');
            const whereClause = userId ? { user_id: userId } : {};
            const existingActive = await XeroToken.findAll({
                where: { ...whereClause, status: { [Op.ne]: 'Disconnected' } }
            });
            const activeTenantIds = new Set(existingActive.map(t => t.tenant_id));

            return res.send(renderCompanySelectionPage({ tenants, activeTenantIds, tier, maxAllowed }));
        } catch (err) {
            const details = JSON.stringify(err.response?.data || err.message);
            next(new ValidationError('Failed to connect Xero. Please try again.', details));
        }
    };

    /**
     * POST /api/xero/select-companies
     */
    selectCompanies = asyncHandler(async (req, res, next) => {
        const { selectedTenantIds } = req.body;

        if (!selectedTenantIds || !Array.isArray(selectedTenantIds) || selectedTenantIds.length === 0) {
            throw new ValidationError('No companies selected.');
        }

        const tokens      = req.session?.xero_pending_tokens;
        const tenants     = req.session?.xero_pending_tenants;
        const userId      = req.session?.xero_pending_user_id || req.session?.user_id || null;
        const sessionInfo = JSON.stringify(req.session || {});

        if (!tokens || !tenants) {
            throw new ValidationError('Session expired. Please reconnect Xero.');
        }

        const reconnectId = req.session?.xero_reconnect_id || null;
        if (reconnectId) {
            const isExactTarget = selectedTenantIds.length === 1 &&
                String(selectedTenantIds[0]) === String(reconnectId);
            if (!isExactTarget) {
                throw new ValidationError(
                    'Invalid company selected. A reconnect can only restore the organisation it was started for.'
                );
            }
        }

        const { XeroToken } = require('../../core/database');
        const whereClause = userId ? { user_id: userId } : {};
        const otherCount = await XeroToken.count({
            where: {
                ...whereClause,
                tenant_id: {
                    [require('sequelize').Op.notIn]: selectedTenantIds
                }
            }
        });

        const maxAllowed = req.session?.xero_max_allowed || 10;
        if (otherCount + selectedTenantIds.length > maxAllowed) {
            throw new ValidationError(
                `Your plan allows a maximum of ${maxAllowed} Xero companies. You currently have ${otherCount} connected companies and selected ${selectedTenantIds.length} more.`
            );
        }

        await XeroService.saveSelectedTenants(selectedTenantIds, tokens, tenants, userId, sessionInfo);

        delete req.session.xero_pending_tokens;
        delete req.session.xero_pending_tenants;
        delete req.session.xero_pending_user_id;
        delete req.session.xero_reconnect_id;
        delete req.session.xero_state;
        delete req.session.oauth_state;

        return res.json({ success: true, connected: selectedTenantIds.length });
    });

    /**
     * POST /api/xero/disconnect
     */
    disconnectXero = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        await XeroTokenRepository.clearTokens(userId);
        res.json({ success: true, message: 'Xero tokens cleared successfully.' });
    });

    /**
     * GET /api/xero/tokens
     */
    listXeroTokens = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const tokens = await XeroTokenRepository.getAllTokens(userId);
        res.json({ success: true, tokens });
    });

    // ── Data Handlers ────────────────────────────────────────────────

    /**
     * GET /api/xero/contacts
     */
    getContacts = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const contacts = await XeroService.getContacts(userId);
        res.json({ contacts });
    });

    /**
     * GET /api/xero/accounts
     */
    getAccounts = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const accounts = await XeroService.getAccounts(userId);
        res.json({ accounts });
    });

    /**
     * GET /api/xero/classes
     */
    getClasses = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const classes = await XeroService.getClasses(userId);
        res.json({ classes });
    });

    /**
     * GET /api/xero/locations
     */
    getLocations = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const locations = await XeroService.getLocations(userId);
        res.json({ locations });
    });

    /**
     * GET /api/xero/organisation
     */
    getOrganisation = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const organisation = await XeroService.getOrganisation(userId);
        res.json({ organisation });
    });

    // ── Connection Handlers ──────────────────────────────────────────

    /**
     * GET /api/xero/connections
     */
    listConnections = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const list = await XeroService.listConnections(userId);
        return res.json(list);
    });

    /**
     * GET /api/xero/connections/stats
     */
    getConnectionStats = asyncHandler(async (req, res, next) => {
        const userId = req.user.userId || req.user.id;
        const plan = req.query.plan || 'pro';

        const stats = {
            plan: plan.toLowerCase(),
            maxPerPlatform: 10,
            xero:       { connected: 0, remaining: 10 }
        };

        if (plan === 'trial')    stats.maxPerPlatform = 1;
        else if (plan === 'basic')    stats.maxPerPlatform = 1;
        else if (plan === 'standard') stats.maxPerPlatform = 3;

        const xeroStats = await XeroService.getConnectionStats(userId, plan);
        stats.xero = {
            connected: xeroStats.connected,
            remaining: xeroStats.remaining
        };

        return res.json(stats);
    });

    /**
     * DELETE /api/xero/connections/:id
     */
    disconnectConnection = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const success = await XeroService.disconnectConnection(companyId, userId);
        return res.json({ success: !!success });
    });

    /**
     * POST /api/xero/connections/:id/activate
     */
    activateConnection = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const success = await XeroService.activateConnection(companyId, userId);

        let totalRecords = 0;
        if (success) {
            try {
                const countInfo = await XeroService.getTotalRecordCountsForToken({ companyId, tenant_id: companyId });
                totalRecords = countInfo.total;
            } catch (err) {}
        }

        return res.json({ success: !!success, totalRecords });
    });

    /**
     * GET /api/xero/connections/:id/count
     */
    getConnectionRecordCount = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        try {
            const countInfo = await XeroService.getTotalRecordCountsForToken({ companyId, tenant_id: companyId });
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
     * PATCH /api/xero/connections/:id/rename
     */
    renameConnection = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const { companyName } = req.body;
        if (!companyName) {
            throw new ValidationError('companyName is required.');
        }

        const success = await XeroService.renameConnection(companyId, userId, companyName);
        return res.json({ success: !!success });
    });

    /**
     * PATCH /api/xero/connections/:id/record-count
     */
    updateRecordCount = asyncHandler(async (req, res, next) => {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const { recordCount } = req.body;
        if (recordCount == null || isNaN(Number(recordCount))) {
            throw new ValidationError('recordCount must be a number.');
        }
        const success = await XeroService.updateRecordCount(companyId, userId, Number(recordCount));
        return res.json({ success: !!success });
    });

    /**
     * GET /api/xero/pull-master-data?companyId=...&tier=...&stream=...&mode=...
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

                const aggregated = await XeroService.pullMasterDataBatched(companyId, tier, userId, onProgress, isIncremental);
                clearInterval(heartbeatInterval);

                res.write(`data: ${JSON.stringify({ type: 'complete', data: aggregated })}\n\n`);
                return res.end();
            } catch (err) {
                clearInterval(heartbeatInterval);
                res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
                return res.end();
            }
        }

        const aggregated = await XeroService.pullMasterDataBatched(companyId, tier, userId, null, isIncremental);

        if (!aggregated) {
            throw new AppError('The requested resource was not found.', 404, 'ERR_NOT_FOUND', `No active connections found for xero.`);
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
     * GET /api/xero/refresh-incremental?companyId=...&tier=...&stream=...
     */
    refreshIncremental = asyncHandler(async (req, res, next) => {
        const { companyId, tier, stream } = req.query;
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

                const aggregated = await XeroService.pullMasterDataBatched(companyId, tier, userId, onProgress, true);
                clearInterval(heartbeatInterval);

                res.write(`data: ${JSON.stringify({ type: 'complete', data: aggregated })}\n\n`);
                return res.end();
            } catch (err) {
                clearInterval(heartbeatInterval);
                res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
                return res.end();
            }
        }

        const aggregated = await XeroService.pullMasterDataBatched(companyId, tier, userId, null, true);

        if (!aggregated) {
            throw new AppError('No active connection found for refresh.', 404, 'ERR_NOT_FOUND', 'Xero connection not found.');
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

module.exports = new XeroController();
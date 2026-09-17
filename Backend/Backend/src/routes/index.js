'use strict';
 
/**
 * API Router
 * ------------------------------------------------------------------
 * This file mounts module routers and maps the unified global
 * connections and pull-master-data routes dynamically to the loaded
 * platform integrations (QuickBooks and Xero).
 *
 * This design is 100% loosely coupled: if QuickBooks or Xero is
 * commented out or removed for regional deployment, the endpoints
 * continue to function seamlessly without throwing module errors.
 * ------------------------------------------------------------------
 */
 
const express = require('express');
const router  = express.Router();
const { AppError } = require('../core/errors/AppError');
const { validate } = require('../core/middleware/validate');
const schemas = require('../core/validation/schemas');
 
// ── Core domain modules ───────────────────────────────────────────
const authRoutes        = require('../modules/auth/auth.routes');
const billingRoutes     = require('../modules/billing/billing.routes');
 
// ── Accounting integrations (conditionally imported / mounted) ────
let quickbooksRoutes;
try {
    quickbooksRoutes = require('../modules/quickbooks/routes');
} catch (e) {
    quickbooksRoutes = null;
}
 
let xeroRoutes;
try {
    xeroRoutes = require('../modules/xero/routes');
} catch (e) {
    xeroRoutes = null;
}
 
// ── Legacy / compatibility ────────────────────────────────────────
const adminRoutes = require('../modules/admin/routes');

// ── Per-user notification history ─────────────────────────────────
const notificationsRoutes = require('../modules/notifications/routes');
const excelValidationRoutes = require('../modules/excelValidation/routes');
 
const { sequelize } = require('../core/database');
const config = require('../core/config');

router.get('/health', async (req, res) => {
    let dbStatus = 'disconnected';
    try {
        await sequelize.authenticate();
        dbStatus = 'connected';
    } catch (err) {}
    return res.status(200).json({
        success: true,
        server: 'healthy',
        instance: config.INSTANCE_ID,
        database: dbStatus
    });
});

 
router.use('/auth', authRoutes);
router.use('/', billingRoutes);
 
if (quickbooksRoutes) {
    router.use('/quickbooks', quickbooksRoutes);
}
if (xeroRoutes) {
    router.use('/xero', xeroRoutes);
}
 
router.use('/admin', adminRoutes);

// GET/POST /api/notifications, PATCH /api/notifications/mark-read,
// DELETE /api/notifications — all JWT-protected and scoped to
// req.user.userId inside notifications/routes.js + controller.js.
router.use('/notifications', notificationsRoutes);
router.use('/excel-validation', excelValidationRoutes);

const authController = require('../modules/auth/auth.controller');
 
// Backward-compat aliases for OAuth providers
router.get('/google/connect',    authController.googleConnect);
router.get('/google/callback',   authController.googleCallback);
router.get('/microsoft/connect', authController.microsoftConnect);
router.get('/microsoft/callback', authController.microsoftCallback);
 
const { authenticate } = require('../modules/auth/auth.middleware');
 
// ── Dynamic Connections Routes ────────────────────────────────────
// ── Dynamic Connections Routes ────────────────────────────────────
 
// GET /api/connections
// The owning email is taken exclusively from the verified JWT
// (req.user.email, set by `authenticate`) — never from req.query.mail.
// Trusting a client-suppliable query param here would let any
// authenticated user list (and, via the endpoints below, disconnect/
// activate/rename/pull data for) another user's ERP connections just by
// passing their email.
router.get('/connections', authenticate, async (req, res, next) => {
    try {
        const userId = req.user.userId || req.user.id;
 
        const list = [];
       
        if (quickbooksRoutes) {
            const QuickBooksService = require('../modules/quickbooks/service');
            const qbList = await QuickBooksService.listConnections(userId);
            list.push(...qbList);
        }
 
        if (xeroRoutes) {
            const XeroService = require('../modules/xero/service');
            const xeroList = await XeroService.listConnections(userId);
            list.push(...xeroList);
        }
 
        return res.json(list);
    } catch (err) {
        return next(err);
    }
});
 
// GET /api/connections/stats
router.get('/connections/stats', authenticate, validate(schemas.connectionStatsQuery, 'query'), async (req, res, next) => {
    try {
        const userId = req.user.userId || req.user.id;
        const plan = req.query.plan || 'pro';
 
        const stats = {
            plan: plan.toLowerCase(),
            maxPerPlatform: 10,
            quickbooks: { connected: 0, remaining: 10 },
            xero:       { connected: 0, remaining: 10 }
        };
 
        if (plan === 'basic')    stats.maxPerPlatform = 1;
        else if (plan === 'standard') stats.maxPerPlatform = 3;
 
        if (quickbooksRoutes) {
            const QuickBooksService = require('../modules/quickbooks/service');
            const qbStats = await QuickBooksService.getConnectionStats(userId, plan);
            stats.quickbooks = {
                connected: qbStats.connected,
                remaining: qbStats.remaining
            };
        }
 
        if (xeroRoutes) {
            const XeroService = require('../modules/xero/service');
            const xeroStats = await XeroService.getConnectionStats(userId, plan);
            stats.xero = {
                connected: xeroStats.connected,
                remaining: xeroStats.remaining
            };
        }
 
        return res.json(stats);
    } catch (err) {
        return next(err);
    }
});
 
// DELETE /api/connections/:id
// `mail` (req.user.email) is passed through to the service layer so the
// update can only ever match a row this user actually owns — otherwise
// any authenticated user could disconnect another user's company just by
// knowing/guessing its companyId.
router.delete('/connections/:id', authenticate, async (req, res, next) => {
    try {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        let success = false;
 
        if (quickbooksRoutes) {
            const QuickBooksService = require('../modules/quickbooks/service');
            const qbSuccess = await QuickBooksService.disconnectConnection(companyId, userId);
            if (qbSuccess) success = true;
        }
 
        if (!success && xeroRoutes) {
            const XeroService = require('../modules/xero/service');
            const xeroSuccess = await XeroService.disconnectConnection(companyId, userId);
            if (xeroSuccess) success = true;
        }
 
        return res.json({ success });
    } catch (err) {
        return next(err);
    }
});
 
// POST /api/connections/:id/activate
// Same ownership scoping as DELETE above.
router.post('/connections/:id/activate', authenticate, async (req, res, next) => {
    try {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        let success = false;
        let totalRecords = 0;
 
        if (quickbooksRoutes) {
            const QuickBooksService = require('../modules/quickbooks/service');
            const qbSuccess = await QuickBooksService.activateConnection(companyId, userId);
            if (qbSuccess) {
                success = true;
                try {
                    const countInfo = await QuickBooksService.getTotalRecordCountsForToken({ companyId, realm_id: companyId });
                    totalRecords = countInfo.total;
                } catch (cErr) {}
            }
        }
 
        if (!success && xeroRoutes) {
            const XeroService = require('../modules/xero/service');
            const xeroSuccess = await XeroService.activateConnection(companyId, userId);
            if (xeroSuccess) {
                success = true;
                try {
                    const countInfo = await XeroService.getTotalRecordCountsForToken({ companyId, tenant_id: companyId });
                    totalRecords = countInfo.total;
                } catch (cErr) {}
            }
        }
 
        return res.json({ success, totalRecords });
    } catch (err) {
        return next(err);
    }
});

// GET /api/connections/:id/count
router.get('/connections/:id/count', authenticate, async (req, res, next) => {
    try {
        const companyId = req.params.id;
        let totalRecords = 0;
        let details = null;
        let success = false;

        if (quickbooksRoutes) {
            const QuickBooksService = require('../modules/quickbooks/service');
            try {
                const countInfo = await QuickBooksService.getTotalRecordCountsForToken({ companyId, realm_id: companyId });
                if (countInfo && countInfo.total !== undefined) {
                    totalRecords = countInfo.total;
                    details = countInfo;
                    success = true;
                }
            } catch (_) {}
        }

        if (!success && xeroRoutes) {
            const XeroService = require('../modules/xero/service');
            try {
                const countInfo = await XeroService.getTotalRecordCountsForToken({ companyId, tenant_id: companyId });
                if (countInfo && countInfo.total !== undefined) {
                    totalRecords = countInfo.total;
                    details = countInfo;
                    success = true;
                }
            } catch (_) {}
        }

        return res.json({ success, companyId, totalRecords, details });
    } catch (err) {
        return next(err);
    }
});
 
// PATCH /api/connections/:id/rename
// Same ownership scoping as DELETE above.
router.patch('/connections/:id/rename', authenticate, validate(schemas.renameConnection), async (req, res, next) => {
    try {
        const companyId = req.params.id;
        const userId = req.user.userId || req.user.id;
        const { companyName } = req.body;
 
        let success = false;
 
        if (quickbooksRoutes) {
            const QuickBooksService = require('../modules/quickbooks/service');
            const qbSuccess = await QuickBooksService.renameConnection(companyId, userId, companyName);
            if (qbSuccess) success = true;
        }
 
        if (!success && xeroRoutes) {
            const XeroService = require('../modules/xero/service');
            const xeroSuccess = await XeroService.renameConnection(companyId, userId, companyName);
            if (xeroSuccess) success = true;
        }
 
        return res.json({ success });
    } catch (err) {
        return next(err);
    }
});
 
// GET /api/pull-master-data?companyId=...&platform=...&tier=...&cursor=...
// Same ownership scoping — a companyId this user doesn't own returns "not
// found" rather than silently pulling and returning another user's data.
//
// `cursor` (optional) is the JSON-encoded per-company, per-entity
// pagination cursor returned as `cursor` by a PREVIOUS call. It MUST be
// forwarded to the service and echoed back in the response: this is the
// endpoint the Excel add-in's Pull Master Data / Refresh Schedule
// buttons actually call, and without the round-trip every click would
// silently restart the cycle at the first entity's first record instead
// of advancing. Omitting it (or sending {}) starts a fresh cycle.
router.get('/pull-master-data', authenticate, validate(schemas.pullMasterDataQuery, 'query'), async (req, res, next) => {
    try {
        const { companyId, platform, tier, cursor, mode } = req.query;
        const isIncremental = mode === 'incremental';

        let cursorByCompany = {};
        if (cursor) {
            try {
                const parsed = JSON.parse(cursor);
                if (parsed && typeof parsed === 'object') cursorByCompany = parsed;
            } catch (parseErr) {
                // Malformed/tampered cursor — fail safe by starting a
                // fresh cycle rather than throwing, since a bad cursor
                // should never be able to break the Pull/Refresh button.
                cursorByCompany = {};
            }
        }
 
        const userId = req.user.userId || req.user.id;
        const normPlatform = platform.toLowerCase();
        let aggregated = null;
        let tokenRefreshed = false;
 
        if (companyId) {
            try {
                if (normPlatform === 'quickbooks' && quickbooksRoutes) {
                    const QuickBooksTokenManager = require('../modules/quickbooks/oauth/QuickBooksTokenManager');
                    const tokenRecord = await QuickBooksTokenManager.tokenRepository.getToken(companyId);
                    if (tokenRecord && QuickBooksTokenManager.isExpiringSoon(tokenRecord.expiresAt)) {
                        tokenRefreshed = true;
                    }
                } else if (normPlatform === 'xero' && xeroRoutes) {
                    const XeroTokenManager = require('../modules/xero/oauth/XeroTokenManager');
                    const tokenRecord = await XeroTokenManager.tokenRepository.getToken(companyId);
                    if (tokenRecord && XeroTokenManager.isExpiringSoon(tokenRecord.expiresAt)) {
                        tokenRefreshed = true;
                    }
                }
            } catch (preCheckErr) {
                // Fail-safe: log but do not block the pull if token checking has an issue
                console.error('Error pre-checking token expiration:', preCheckErr);
            }
        }
 
        if (req.headers.accept?.includes('text/event-stream') || req.query.stream === 'true') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Accel-Buffering', 'no');
            res.status(200);
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }
            res.write(': sse-ready\n\n');

            const heartbeatInterval = setInterval(() => {
                res.write(': heartbeat ping\n\n');
            }, 15000);

            const onProgress = (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            };

            try {
                if (normPlatform === 'quickbooks' && quickbooksRoutes) {
                    const QuickBooksService = require('../modules/quickbooks/service');
                    aggregated = await QuickBooksService.pullMasterDataMultithreaded(companyId, tier, userId, onProgress, isIncremental);
                } else if (normPlatform === 'xero' && xeroRoutes) {
                    const XeroService = require('../modules/xero/service');
                    aggregated = await XeroService.pullMasterData(companyId, tier, userId, isIncremental);
                }
                clearInterval(heartbeatInterval);
                res.write(`data: ${JSON.stringify({ type: 'complete', data: aggregated })}\n\n`);
                return res.end();
            } catch (streamErr) {
                clearInterval(heartbeatInterval);
                res.write(`data: ${JSON.stringify({ type: 'error', error: streamErr.message })}\n\n`);
                return res.end();
            }
        }

        if (normPlatform === 'quickbooks' && quickbooksRoutes) {
            const QuickBooksService = require('../modules/quickbooks/service');
            aggregated = await QuickBooksService.pullMasterDataMultithreaded(companyId, tier, userId, null, isIncremental);
        } else if (normPlatform === 'xero' && xeroRoutes) {
            const XeroService = require('../modules/xero/service');
            aggregated = await XeroService.pullMasterData(companyId, tier, userId, isIncremental);
        }
 
        if (!aggregated) {
            throw new AppError('The requested resource was not found.', 404, 'ERR_NOT_FOUND', `No active connections found for ${platform}.`);
        }
 
        return res.json({
            company:   aggregated.company.length === 1 ? aggregated.company[0] : aggregated.company,
            customers: aggregated.customers,
            vendors:   aggregated.vendors,
            accounts:  aggregated.accounts,
            classes:   aggregated.classes,
            locations: aggregated.locations,
            // Tells the frontend's Refresh Schedule flow whether this is the
            // connection's very first pull (write everything) or a later
            // one (append only isNew-flagged records) — see
            // QuickBooksService/XeroService.pullMasterData.
            isFirstSync: aggregated.isFirstSync,
            // Pagination hand-back. The client stores `cursor` and sends
            // it on its next click to continue the cycle; `isDone` tells
            // it the cycle finished ("Data completed.") rather than
            // "Batch written. Click Pull Master Data again...".
            //
            // A provider whose service doesn't paginate (Xero returns its
            // whole dataset in one call) reports no `isDone` of its own —
            // default that to true so the client shows "Data completed."
            // once instead of looping on "Batch written." forever with a
            // cursor that never advances.
            cursor: aggregated.cursor,
            isDone: aggregated.isDone === undefined ? true : aggregated.isDone,
            tokenRefreshed
        });
    } catch (err) {
        return next(err);
    }
});
 
module.exports = router;
 
 
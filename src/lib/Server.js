'use strict';

const crypto = require('node:crypto');
const { createServer } = require('node:http');
const { stat, readFile } = require('node:fs/promises');
const { resolve, sep } = require('node:path');
const { exec } = require('node:child_process');

const expressSession = require('express-session');
const debug = require('debug')('Server');

const {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  fromNodeMiddleware,
  getRouterParam,
  toNodeListener,
  readBody,
  setHeader,
  serveStatic,
} = require('h3');

const WireGuard = require('../services/WireGuard');

const {
  CHECK_UPDATE,
  PORT,
  WEBUI_HOST,
  RELEASE,
  PASSWORD,
  LANG,
  UI_TRAFFIC_STATS,
  UI_CHART_TYPE,
} = require('../config');

module.exports = class Server {

  constructor() {
    const app = createApp();
    this.app = app;

    app.use(fromNodeMiddleware(expressSession({
      secret: crypto.randomBytes(256).toString('hex'),
      resave: true,
      saveUninitialized: true,
    })));

    const router = createRouter();
    app.use(router);

    router
      .get('/api/release', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return RELEASE;
      }))

      .get('/api/check-update', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return CHECK_UPDATE;
      }))

      .get('/api/lang', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `"${LANG}"`;
      }))

      .get('/api/ui-traffic-stats', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return UI_TRAFFIC_STATS;
      }))

      .get('/api/ui-chart-type', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `"${UI_CHART_TYPE}"`;
      }))

      // Authentication
      .get('/api/session', defineEventHandler((event) => {
        const requiresPassword = !!process.env.PASSWORD;
        const authenticated = requiresPassword
          ? !!(event.node.req.session && event.node.req.session.authenticated)
          : true;

        return {
          requiresPassword,
          authenticated,
        };
      }))
      .post('/api/session', defineEventHandler(async (event) => {
        const { password } = await readBody(event);

        if (typeof password !== 'string') {
          throw createError({
            status: 401,
            message: 'Missing: Password',
          });
        }

        if (password !== PASSWORD) {
          throw createError({
            status: 401,
            message: 'Incorrect Password',
          });
        }

        event.node.req.session.authenticated = true;
        event.node.req.session.save();

        debug(`New Session: ${event.node.req.session.id}`);

        return { success: true };
      }))
      .post('/api/ping', defineEventHandler(async (event) => {
        const { ip } = await readBody(event);
      
        if (!ip) {
          throw createError({
            status: 400,
            message: 'Missing IP address',
          });
        }
      

        return new Promise((resolve, reject) => {
          exec(`ping -c 4 ${ip}`, (error, stdout, stderr) => {
            if (error) {
              console.error(`Ping command failed: ${stderr}`);
              return reject(createError({
                status: 502,
                message: `Ping failed: ${stderr}`,
              }));
            }
      
            // Извлечение среднего времени пинга
            const match = stdout.match(/round-trip min\/avg\/max = [\d.]+\/([\d.]+)\/[\d.]+ ms/);
            if (match && match[1]) {
              const avgPing = match[1];
              resolve({ averagePing: avgPing });
            } else {
              reject(createError({
                status: 500,
                message: 'Failed to parse ping output',
              }));
            }
          });
        });
      }));

    // WireGuard
    app.use(
      fromNodeMiddleware((req, res, next) => {
        if (!PASSWORD || !req.url.startsWith('/api/')) {
          return next();
        }

        const authHeader = req.headers.authorization;
        if (authHeader === `Bearer ${PASSWORD}`) {
          return next();
        }

        if (req.session && req.session.authenticated) {
          return next();
        }

        return res.status(401).json({
          error: 'Not Logged In',
        });
      }),
    );

    const router2 = createRouter();
    app.use(router2);


    router2
      .delete('/api/session', defineEventHandler((event) => {
        const sessionId = event.node.req.session.id;

        event.node.req.session.destroy();

        debug(`Deleted Session: ${sessionId}`);
        return { success: true };
      }))
      .get('/api/wireguard/client', defineEventHandler(() => {
        return WireGuard.getClients();
      }))
      .get('/api/wireguard/client/:clientId/qrcode.svg', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const svg = await WireGuard.getClientQRCodeSVG({ clientId });
        setHeader(event, 'Content-Type', 'image/svg+xml');
        return svg;
      }))
      .get('/api/wireguard/client/:clientId/configuration', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const client = await WireGuard.getClient({ clientId });
        const config = await WireGuard.getClientConfiguration({ clientId });
        const configName = client.name
          .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
          .replace(/(-{2,}|-$)/g, '-')
          .replace(/-$/, '')
          .substring(0, 32);
        setHeader(event, 'Content-Disposition', `attachment; filename="${configName || clientId}.conf"`);
        setHeader(event, 'Content-Type', 'text/plain');
        return config;
      }))
      .post('/api/wireguard/client', defineEventHandler(async (event) => {
        const { name } = await readBody(event);
        const client = await WireGuard.createClient({ name });
        if (!client) {
          // Нужно вернуть ошибку например если превышено количестов пользователей на сервере
          throw createError({ status: 500 });
        }
        // Нужно вернуть wg_id
        return { wgId: client.id}
      }))
      .delete('/api/wireguard/client/:clientId', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        await WireGuard.deleteClient({ clientId });
        return { success: true };
      }))
      .post('/api/wireguard/client/:clientId/enable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.enableClient({ clientId });
        return { success: true };
      }))
      .post('/api/wireguard/client/:clientId/disable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.disableClient({ clientId });
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/name', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { name } = await readBody(event);
        await WireGuard.updateClientName({ clientId, name });
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/address', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { address } = await readBody(event);
        await WireGuard.updateClientAddress({ clientId, address });
        return { success: true };
      }));
      

    const safePathJoin = (base, target) => {
      // Manage web root (edge case)
      if (target === '/') {
        return `${base}${sep}`;
      }

      // Prepend './' to prevent absolute paths
      const targetPath = `.${sep}${target}`;

      // Resolve the absolute path
      const resolvedPath = resolve(base, targetPath);

      // Check if resolvedPath is a subpath of base
      if (resolvedPath.startsWith(`${base}${sep}`)) {
        return resolvedPath;
      }

      throw createError({
        status: 400,
        message: 'Bad Request',
      });
    };

    // Static assets
    const publicDir = '/app/www';
    app.use(
      defineEventHandler((event) => {
        return serveStatic(event, {
          getContents: (id) => {
            return readFile(safePathJoin(publicDir, id));
          },
          getMeta: async (id) => {
            const filePath = safePathJoin(publicDir, id);

            const stats = await stat(filePath).catch(() => {});
            if (!stats || !stats.isFile()) {
              return;
            }

            if (id.endsWith('.html')) setHeader(event, 'Content-Type', 'text/html');
            if (id.endsWith('.js')) setHeader(event, 'Content-Type', 'application/javascript');
            if (id.endsWith('.json')) setHeader(event, 'Content-Type', 'application/json');
            if (id.endsWith('.css')) setHeader(event, 'Content-Type', 'text/css');
            if (id.endsWith('.png')) setHeader(event, 'Content-Type', 'image/png');
            if (id.endsWith('.svg')) setHeader(event, 'Content-Type', 'image/svg+xml');

            return {
              size: stats.size,
              mtime: stats.mtimeMs,
            };
          },
        });
      }),
    );

    createServer(toNodeListener(app)).listen(PORT, WEBUI_HOST);
    debug(`Listening on http://${WEBUI_HOST}:${PORT}`);
  }

};

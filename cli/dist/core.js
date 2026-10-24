"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.CLILogger = exports.CLIError = exports.ENV = exports.DEVICE_API_V1 = exports.DEVICE_API_BASE = exports.DB_PATH = exports.CONFIG_DIR = void 0;
exports.apiCached = apiCached;
exports.apiCachedApps = apiCachedApps;
exports.clearApiCache = clearApiCache;
exports.apiRequest = apiRequest;
exports.apiProbe = apiProbe;
exports.getFlagValue = getFlagValue;
exports.normalizePositionalArg = normalizePositionalArg;
exports.validateUrl = validateUrl;
exports.requireConfirmation = requireConfirmation;
exports.redact = redact;
exports.sleep = sleep;
exports.getDbSizeMb = getDbSizeMb;
const fs_1 = require("fs");
const child_process_1 = require("child_process");
const path_1 = require("path");
const readline_1 = require("readline");
exports.CONFIG_DIR = process.env.CONFIG_DIR || process.env.DATA_DIR || ((0, fs_1.existsSync)('/var/lib/iotistic/agent') ? '/var/lib/iotistic/agent' : '/app/data');
exports.DB_PATH = process.env.DATABASE_PATH || (0, path_1.join)(exports.CONFIG_DIR, 'agent.sqlite');
const DEVICE_API_PORT = process.env.DEVICE_API_PORT || '48484';
exports.DEVICE_API_BASE = process.env.DEVICE_API_URL || `http://localhost:${DEVICE_API_PORT}`;
exports.DEVICE_API_V1 = `${exports.DEVICE_API_BASE}/v1`;
exports.ENV = {
    isContainer: (0, fs_1.existsSync)('/.dockerenv'),
    hasDocker: (() => {
        try {
            (0, child_process_1.execSync)('docker --version', { stdio: 'ignore' });
            return true;
        }
        catch {
            return false;
        }
    })(),
};
class CLIError extends Error {
    exitCode;
    context;
    constructor(message, exitCode = 1, context) {
        super(message);
        this.exitCode = exitCode;
        this.context = context;
        this.name = 'CLIError';
    }
}
exports.CLIError = CLIError;
class CLILogger {
    info(message, context) {
        const contextStr = context ? ` ${JSON.stringify(context)}` : '';
        console.log(`[INFO] ${message}${contextStr}`);
    }
    error(message, error, context) {
        const errorStr = error ? ` - ${error.message}` : '';
        const contextStr = context ? ` ${JSON.stringify(context)}` : '';
        console.error(`[ERROR] ${message}${errorStr}${contextStr}`);
    }
    warn(message, context) {
        const contextStr = context ? ` ${JSON.stringify(context)}` : '';
        console.warn(`[WARN] ${message}${contextStr}`);
    }
    debug(message, context) {
        if (process.env.DEBUG === 'true') {
            const contextStr = context ? ` ${JSON.stringify(context)}` : '';
            console.log(`[DEBUG] ${message}${contextStr}`);
        }
    }
}
exports.CLILogger = CLILogger;
exports.logger = new CLILogger();
const apiCache = new Map();
let adminSessionCookie;
let adminSessionRequest;
function getAdminCredentials() {
    const username = process.env.IOTCTL_USERNAME;
    const password = process.env.IOTCTL_PASSWORD;
    return username && password ? { username, password } : undefined;
}
async function promptForAdminCredentials() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Set IOTCTL_USERNAME and IOTCTL_PASSWORD to authenticate with the Device API');
    }
    const readline = (0, readline_1.createInterface)({ input: process.stdin, output: process.stdout });
    let username;
    try {
        username = (await new Promise((resolve) => {
            readline.question('Device API username: ', resolve);
        })).trim();
    }
    finally {
        readline.close();
    }
    const input = process.stdin;
    input.setRawMode(true);
    input.setEncoding('utf8');
    const password = await new Promise((resolve, reject) => {
        let value = '';
        const cleanup = () => {
            input.setRawMode(false);
            input.pause();
            input.removeListener('data', onData);
            process.stdout.write('\n');
        };
        const onData = (keys) => {
            for (const key of keys) {
                if (key === '\u0003' || key === '\u0004') {
                    cleanup();
                    reject(new Error('Authentication cancelled'));
                    return;
                }
                if (key === '\r' || key === '\n') {
                    cleanup();
                    resolve(value);
                    return;
                }
                if (key === '\u007f' || key === '\b') {
                    value = value.slice(0, -1);
                }
                else {
                    value += key;
                }
            }
        };
        input.on('data', onData);
        input.resume();
        process.stdout.write('Device API password: ');
    });
    if (!username || !password) {
        throw new Error('A username and password are required to authenticate with the Device API');
    }
    return { username, password };
}
async function login() {
    const credentials = getAdminCredentials() ?? await promptForAdminCredentials();
    const response = await fetch(`${exports.DEVICE_API_V1}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) {
        throw new Error('Device API login succeeded without returning a session cookie');
    }
    return cookie;
}
async function getAdminSessionCookie() {
    if (adminSessionCookie)
        return adminSessionCookie;
    const request = adminSessionRequest ??= login();
    try {
        adminSessionCookie = await request;
        return adminSessionCookie;
    }
    finally {
        if (adminSessionRequest === request)
            adminSessionRequest = undefined;
    }
}
function isNotAuthenticated(status, body) {
    if (status !== 401)
        return false;
    try {
        return JSON.parse(body).error === 'Not authenticated';
    }
    catch {
        return false;
    }
}
async function fetchApiResponse(endpoint, options) {
    const request = (cookie) => {
        const headers = new Headers(options.headers);
        if (!headers.has('Content-Type'))
            headers.set('Content-Type', 'application/json');
        if (cookie)
            headers.set('Cookie', cookie);
        return fetch(endpoint, {
            ...options,
            headers,
            signal: options.signal ?? AbortSignal.timeout(5000),
        });
    };
    const cookie = adminSessionCookie;
    const response = await request(cookie);
    if (response.status !== 401 ||
        !isNotAuthenticated(response.status, await response.clone().text())) {
        return response;
    }
    if (cookie && adminSessionCookie === cookie)
        adminSessionCookie = undefined;
    const sessionCookie = await getAdminSessionCookie();
    return sessionCookie ? request(sessionCookie) : response;
}
async function apiCached(endpoint) {
    if (!apiCache.has(endpoint)) {
        apiCache.set(endpoint, apiRequest(endpoint));
    }
    return apiCache.get(endpoint);
}
async function apiCachedApps() {
    const response = await apiCached(`${exports.DEVICE_API_V1}/apps`);
    const list = Array.isArray(response?.apps) ? response.apps : [];
    const apps = {};
    for (const app of list) {
        apps[String(app.appId)] = app;
    }
    return apps;
}
function clearApiCache() {
    apiCache.clear();
}
async function apiRequest(endpoint, options = {}) {
    try {
        const response = await fetchApiResponse(endpoint, options);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`HTTP ${response.status}: ${error}`);
        }
        const text = await response.text();
        if (!text || text === 'OK') {
            return { success: true };
        }
        const json = JSON.parse(text);
        return json.Data ?? json;
    }
    catch (error) {
        if (error.code === 'ECONNREFUSED') {
            throw new CLIError('Cannot connect to agent', 1, {
                endpoint: exports.DEVICE_API_BASE,
                hint: 'Make sure the agent is running',
            });
        }
        throw error;
    }
}
async function apiProbe(endpoint, options = {}) {
    try {
        const response = await fetchApiResponse(endpoint, options);
        const text = await response.text();
        let parsed = undefined;
        if (text && text !== 'OK') {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = text;
            }
        }
        return {
            ok: response.ok,
            status: response.status,
            data: parsed,
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error.message,
        };
    }
}
function getFlagValue(flag) {
    const args = process.argv.slice(2);
    const byEquals = args.find((arg) => arg.startsWith(`${flag}=`));
    if (byEquals) {
        return byEquals.split('=')[1];
    }
    const index = args.indexOf(flag);
    if (index === -1 || !args[index + 1]) {
        return undefined;
    }
    return args[index + 1];
}
function normalizePositionalArg(arg) {
    if (!arg || arg.startsWith('--')) {
        return undefined;
    }
    return arg;
}
function validateUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    catch {
        return false;
    }
}
function requireConfirmation(message) {
    const args = process.argv.slice(2);
    if (!args.includes('--yes')) {
        console.log(`\n⚠️  ${message}`);
        console.log('Use --yes flag to confirm this action\n');
        throw new CLIError('Confirmation required', 1, {
            hint: 'Add --yes flag to confirm',
        });
    }
}
function redact(value) {
    if (!value || value.length <= 8) {
        return value ? '****' : 'not set';
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getDbSizeMb() {
    if (!(0, fs_1.existsSync)(exports.DB_PATH)) {
        return null;
    }
    const stats = (0, fs_1.statSync)(exports.DB_PATH);
    return (stats.size / 1024 / 1024).toFixed(2);
}
//# sourceMappingURL=core.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.schemaDriftGet = schemaDriftGet;
exports.schemaDriftSet = schemaDriftSet;
exports.schemaDriftResetAdvanced = schemaDriftResetAdvanced;
const core_1 = require("../core");
const KNOWN_FIELDS = new Set([
    'enabled', 'warmupBatches', 'consecutiveMissingThreshold', 'alertCooldownMs',
    'minFieldPresenceRatio', 'adaptiveRetireBatches', 'adaptiveRetireMs',
    'alertOnDriftTypes', 'adaptivePromotionBatches', 'adaptivePromotionRatio',
    'adaptivePromotionMinElapsedMs', 'minTypeDominanceRatio', 'maxTrackedFields',
    'maxTrackedDevices', 'maxTraversalDepth', 'maxFieldsPerBatch',
    'maxRenameCandidates', 'maxRenameFieldLength', 'logSampleSize',
    'checkIntervalBatches',
]);
const SENSITIVITY_FIELDS = new Set([
    'consecutiveMissingThreshold', 'minFieldPresenceRatio',
    'adaptivePromotionBatches', 'adaptivePromotionMinElapsedMs',
    'minTypeDominanceRatio',
]);
const OPERATOR_FIELDS = new Set([
    'enabled', 'consecutiveMissingThreshold', 'minFieldPresenceRatio',
    'adaptivePromotionBatches', 'adaptivePromotionMinElapsedMs',
    'minTypeDominanceRatio', 'alertCooldownMs', 'alertOnDriftTypes',
]);
function humanMs(ms) {
    if (ms >= 86_400_000)
        return `${ms / 86_400_000}d`;
    if (ms >= 3_600_000)
        return `${ms / 3_600_000}h`;
    if (ms >= 60_000)
        return `${ms / 60_000}m`;
    return `${ms / 1000}s`;
}
function formatValue(key, value) {
    if (value == null)
        return '(not set)';
    if (typeof value === 'number' && key.toLowerCase().endsWith('ms')) {
        return `${value} (${humanMs(value)})`;
    }
    if (Array.isArray(value))
        return value.join(', ');
    return String(value);
}
function printConfig(config, sensitivity) {
    core_1.logger.info('Schema Drift Configuration', { sensitivity });
    console.log('');
    console.log('  Operator controls:');
    for (const key of OPERATOR_FIELDS) {
        if (key in config) {
            console.log(`    ${key}: ${formatValue(key, config[key])}`);
        }
    }
    console.log('');
    console.log('  Advanced parameters:');
    for (const [key, value] of Object.entries(config)) {
        if (!OPERATOR_FIELDS.has(key)) {
            console.log(`    ${key}: ${formatValue(key, value)}`);
        }
    }
}
async function schemaDriftGet() {
    const data = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/schema-drift/config`);
    printConfig(data.config, data.sensitivity);
}
async function schemaDriftSet(...args) {
    if (args.length === 0 || args.length % 2 !== 0) {
        throw new core_1.CLIError('Key-value pairs required', 1, {
            usage: 'iotctl schema-drift set <key> <value> [<key> <value> ...]',
        });
    }
    const patch = {};
    const sensitivityWarnings = [];
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i];
        const raw = args[i + 1];
        if (!KNOWN_FIELDS.has(key)) {
            throw new core_1.CLIError(`Unknown drift option: ${key}`, 1, {
                hint: `Known fields: ${[...KNOWN_FIELDS].join(', ')}`,
            });
        }
        let parsed = raw;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            // keep as string
        }
        patch[key] = parsed;
        if (SENSITIVITY_FIELDS.has(key)) {
            sensitivityWarnings.push(key);
        }
    }
    if (sensitivityWarnings.length > 0) {
        core_1.logger.warn('Modifying sensitivity-preset fields — sensitivity may change to "custom"', {
            fields: sensitivityWarnings,
        });
    }
    const data = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/schema-drift/config`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
    printConfig(data.config, data.sensitivity);
}
async function schemaDriftResetAdvanced() {
    const data = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/schema-drift/config/reset-advanced`, {
        method: 'POST',
    });
    core_1.logger.info('Advanced settings restored to defaults');
    printConfig(data.config, data.sensitivity);
}
//# sourceMappingURL=schema-drift.js.map
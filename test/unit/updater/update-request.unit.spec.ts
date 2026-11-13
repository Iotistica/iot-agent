import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { queueAgentUpdateRequest } from '../../../src/update/update-request';

describe('queueAgentUpdateRequest', () => {
	let directory: string;
	let requestFile: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'iotistica-update-request-'));
		requestFile = join(directory, 'update.lock');
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it('atomically publishes a validated version and force flag', () => {
		queueAgentUpdateRequest('1.2.3', true, requestFile);

		expect(readFileSync(requestFile, 'utf8')).toBe('1.2.3\ntrue\n');
	});

	it('allows the latest alias used by the local CLI', () => {
		queueAgentUpdateRequest('latest', false, requestFile);

		expect(readFileSync(requestFile, 'utf8')).toBe('latest\nfalse\n');
	});

	it('rejects invalid versions before publishing a request', () => {
		expect(() => queueAgentUpdateRequest('../../etc/passwd', false, requestFile)).toThrow('Invalid update version');
		expect(() => readFileSync(requestFile, 'utf8')).toThrow();
	});

	it('rejects a second request while one is pending', () => {
		queueAgentUpdateRequest('1.2.3', false, requestFile);

		expect(() => queueAgentUpdateRequest('1.2.4', false, requestFile)).toThrow('already pending or running');
		expect(readFileSync(requestFile, 'utf8')).toBe('1.2.3\nfalse\n');
	});

	it('rejects a request while the root worker is processing an update', () => {
		writeFileSync(`${requestFile}.running`, '1.2.3\nfalse\n');

		expect(() => queueAgentUpdateRequest('1.2.4', false, requestFile)).toThrow('already pending or running');
		expect(() => readFileSync(requestFile, 'utf8')).toThrow();
	});
});
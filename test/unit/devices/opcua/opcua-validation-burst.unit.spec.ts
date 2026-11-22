/**
 * Validation burst management tests.
 *
 * These verify the chunking and result-mapping logic used by
 * validateNodeIds() and refreshNamespaceEvidence() in adapter.ts.
 * The actual OPC-UA session is not available in unit tests, so we
 * replicate the loop structures and verify correctness at scale.
 */

const VALIDATION_BATCH_SIZE = 200;
const ATTRS_PER_NODE = 4;

/** Simulates the chunked validation loop from adapter.ts. */
function simulateValidation(
	nodeCount: number,
	readFn: (batch: { nodeId: string }[]) => { isGood: boolean }[],
): { valid: string[]; invalid: string[]; resultCount: number } {
	const dataPoints = Array.from({ length: nodeCount }, (_, i) => ({
		nodeId: `ns=2;s=Device/test/Point_${i}`,
		name: `point_${i}`,
	}));

	const results: { isGood: boolean }[] = [];
	const invalid: string[] = [];
	const batchFailedNodeIds = new Set<string>();

	for (let start = 0; start < dataPoints.length; start += VALIDATION_BATCH_SIZE) {
		const batch = dataPoints.slice(start, start + VALIDATION_BATCH_SIZE);
		const nodesToRead = batch.flatMap(dp => [
			{ nodeId: dp.nodeId },
			{ nodeId: dp.nodeId },
			{ nodeId: dp.nodeId },
			{ nodeId: dp.nodeId },
		]);

		try {
			const batchResults = readFn(nodesToRead);
			for (const r of batchResults) results.push(r);
		} catch {
			for (const dp of batch) {
				invalid.push(dp.nodeId);
				batchFailedNodeIds.add(dp.nodeId);
			}
			continue;
		}
	}

	const valid: string[] = [];
	let resultOffset = 0;
	for (const dp of dataPoints) {
		if (batchFailedNodeIds.has(dp.nodeId)) continue;
		const valueResult = results[resultOffset];
		resultOffset += ATTRS_PER_NODE;
		if (valueResult?.isGood) {
			valid.push(dp.nodeId);
		} else {
			invalid.push(dp.nodeId);
		}
	}

	return { valid, invalid, resultCount: results.length };
}

describe('Validation burst management', () => {
	describe('request sizing', () => {
		it('splits 4000 nodes into 20 batches of 200', () => {
			let batchCount = 0;
			let maxOpsPerRequest = 0;

			simulateValidation(4000, (batch) => {
				batchCount++;
				maxOpsPerRequest = Math.max(maxOpsPerRequest, batch.length);
				return batch.map(() => ({ isGood: true }));
			});

			expect(batchCount).toBe(20);
			expect(maxOpsPerRequest).toBe(VALIDATION_BATCH_SIZE * ATTRS_PER_NODE); // 800
		});

		it('handles non-round counts (e.g. 4007 nodes)', () => {
			let batchCount = 0;
			let lastBatchSize = 0;

			simulateValidation(4007, (batch) => {
				batchCount++;
				lastBatchSize = batch.length;
				return batch.map(() => ({ isGood: true }));
			});

			expect(batchCount).toBe(Math.ceil(4007 / VALIDATION_BATCH_SIZE)); // 21
			expect(lastBatchSize).toBe((4007 % VALIDATION_BATCH_SIZE) * ATTRS_PER_NODE); // 7 * 4 = 28
		});
	});

	describe('4-attribute result mapping', () => {
		it('maps 4 consecutive results per node correctly', () => {
			const { valid, invalid } = simulateValidation(100, (batch) => {
				return batch.map(() => ({ isGood: true }));
			});

			expect(valid).toHaveLength(100);
			expect(invalid).toHaveLength(0);
		});

		it('marks a node invalid when its first attribute (Value) is not good', () => {
			const { valid, invalid } = simulateValidation(5, (batch) => {
				return batch.map((_, i) => {
					const nodeIdx = Math.floor(i / ATTRS_PER_NODE);
					const attrIdx = i % ATTRS_PER_NODE;
					// Node 2: Value attribute returns bad
					if (nodeIdx === 2 && attrIdx === 0) return { isGood: false };
					return { isGood: true };
				});
			});

			expect(valid).toHaveLength(4);
			expect(invalid).toHaveLength(1);
			expect(invalid[0]).toBe('ns=2;s=Device/test/Point_2');
		});
	});

	describe('batch failure isolation', () => {
		it('marks only the failed batch as invalid, preserving others', () => {
			let batchIdx = 0;
			const { valid, invalid } = simulateValidation(600, (batch) => {
				const currentBatch = batchIdx++;
				// Fail the second batch (index 1)
				if (currentBatch === 1) throw new Error('Simulated OPC-UA timeout');
				return batch.map(() => ({ isGood: true }));
			});

			// Batch 0 (nodes 0-199): valid
			// Batch 1 (nodes 200-399): all invalid due to batch failure
			// Batch 2 (nodes 400-599): valid
			expect(valid).toHaveLength(400);
			expect(invalid).toHaveLength(200);

			// Verify the failed batch is exactly nodes 200-399
			for (let i = 200; i < 400; i++) {
				expect(invalid).toContain(`ns=2;s=Device/test/Point_${i}`);
			}
			// Verify nodes before and after the failed batch are valid
			for (let i = 0; i < 200; i++) {
				expect(valid).toContain(`ns=2;s=Device/test/Point_${i}`);
			}
			for (let i = 400; i < 600; i++) {
				expect(valid).toContain(`ns=2;s=Device/test/Point_${i}`);
			}
		});

		it('handles multiple batch failures', () => {
			let batchIdx = 0;
			const { valid, invalid } = simulateValidation(1000, (batch) => {
				const currentBatch = batchIdx++;
				if (currentBatch === 0 || currentBatch === 4) throw new Error('Simulated error');
				return batch.map(() => ({ isGood: true }));
			});

			expect(invalid).toHaveLength(400); // 2 failed batches × 200 nodes
			expect(valid).toHaveLength(600);
		});

		it('result offset stays aligned after a batch failure', () => {
			let batchIdx = 0;
			const { valid, invalid } = simulateValidation(600, (batch) => {
				const currentBatch = batchIdx++;
				if (currentBatch === 1) throw new Error('Simulated error');
				return batch.map((_, i) => {
					const nodeIdx = Math.floor(i / ATTRS_PER_NODE);
					// In batch 2, node index 0 (global index 400) has bad Value
					if (currentBatch === 2 && nodeIdx === 0 && i % ATTRS_PER_NODE === 0) {
						return { isGood: false };
					}
					return { isGood: true };
				});
			});

			// 200 valid from batch 0, batch 1 all failed (200), batch 2: 1 failed + 199 valid
			expect(valid).toHaveLength(399);
			expect(invalid).toHaveLength(201);
			expect(invalid).toContain('ns=2;s=Device/test/Point_400');
		});
	});

	describe('namespace evidence chunking', () => {
		it('chunks large verified-node reads at 100', () => {
			const EVIDENCE_CHUNK = 100;
			const nodeIds = Array.from({ length: 4000 }, (_, i) => `ns=2;s=Node_${i}`);
			const chunks: number[] = [];

			for (let start = 0; start < nodeIds.length; start += EVIDENCE_CHUNK) {
				const chunk = nodeIds.slice(start, start + EVIDENCE_CHUNK);
				chunks.push(chunk.length);
			}

			expect(chunks).toHaveLength(40);
			expect(chunks.every(c => c === 100)).toBe(true);
		});

		it('preserves result ordering across chunks', () => {
			const EVIDENCE_CHUNK = 100;
			const nodeIds = Array.from({ length: 250 }, (_, i) => `ns=2;s=Node_${i}`);
			const values: { nodeId: string; isGood: boolean }[] = [];

			for (let start = 0; start < nodeIds.length; start += EVIDENCE_CHUNK) {
				const chunk = nodeIds.slice(start, start + EVIDENCE_CHUNK);
				const chunkValues = chunk.map((nodeId, j) => ({
					nodeId,
					isGood: (start + j) % 50 !== 0, // every 50th fails
				}));
				for (const v of chunkValues) values.push(v);
			}

			expect(values).toHaveLength(250);
			expect(values[0].isGood).toBe(false);   // index 0
			expect(values[1].isGood).toBe(true);
			expect(values[50].isGood).toBe(false);  // index 50
			expect(values[100].isGood).toBe(false);  // index 100 (chunk boundary)
			expect(values[101].isGood).toBe(true);
			expect(values[200].isGood).toBe(false);  // index 200 (chunk boundary)

			// Verify identity: each result maps back to its nodeId
			for (let i = 0; i < 250; i++) {
				expect(values[i].nodeId).toBe(`ns=2;s=Node_${i}`);
			}
		});

		it('cancels early if staleness check fails between chunks', () => {
			const EVIDENCE_CHUNK = 100;
			const nodeIds = Array.from({ length: 300 }, (_, i) => `ns=2;s=Node_${i}`);
			let chunksProcessed = 0;
			let cancelled = false;

			const isCurrent = () => chunksProcessed < 2; // becomes stale after 2 chunks

			for (let start = 0; start < nodeIds.length; start += EVIDENCE_CHUNK) {
				if (!isCurrent()) {
					cancelled = true;
					break;
				}
				nodeIds.slice(start, start + EVIDENCE_CHUNK);
				chunksProcessed++;
			}

			expect(chunksProcessed).toBe(2);
			expect(cancelled).toBe(true);
		});
	});
});

import { describe, it, expect } from '@jest/globals'
import { PayloadChunkCalculator } from '../../../../src/publish/core/chunk-calculator'

describe('PayloadChunkCalculator', () => {
  const calc = new PayloadChunkCalculator()

  describe('calculateOptimalChunkSize', () => {
    it('should calculate optimal chunk size for 256 KB MQTT (Azure)', () => {
      const result = calc.calculateOptimalChunkSize(256 * 1024, 'json', 150)
      // With 256KB, 80% safety = 204.8KB, minus 500B overhead = 204,300B
      // Per reading: 150B, so ~1362 readings possible
      expect(result).toBeGreaterThan(1000)
      expect(result).toBeLessThan(2000)
    })

    it('should calculate optimal chunk size for 1 MB MQTT (Mosquitto)', () => {
      const result = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 150)
      // With 1MB, 80% safety = 819.2KB, minus 500B = 838,500B
      // Per reading: 150B, so ~5590 readings possible
      expect(result).toBeGreaterThan(5000)
      expect(result).toBeLessThan(6000)
    })

    it('should calculate optimal chunk size for 128 KB (AWS)', () => {
      const result = calc.calculateOptimalChunkSize(128 * 1024, 'json', 150)
      // With 128KB, 80% safety = 102.4KB, minus 500B = 104,448B
      // Per reading: 150B, so ~696 readings possible
      expect(result).toBeGreaterThan(500)
      expect(result).toBeLessThan(1000)
    })

    it('should handle compression - msgpack reduces size by ~40%', () => {
      const noCompression = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 150)
      const withMsgpack = calc.calculateOptimalChunkSize(1024 * 1024, 'msgpack', 150)

      // With msgpack compression (0.6x), can fit more readings
      expect(withMsgpack).toBeGreaterThan(noCompression)
      expect(withMsgpack).toBeGreaterThan(noCompression * 1.3)
    })

    it('should handle compression - msgpack+deflate reduces size by ~75%', () => {
      const noCompression = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 150)
      const withDeflate = calc.calculateOptimalChunkSize(1024 * 1024, 'msgpack+deflate', 150)

      // With deflate compression (0.25x), can fit significantly more readings
      expect(withDeflate).toBeGreaterThan(noCompression * 2.5)
    })

    it('should handle case-insensitive compression method', () => {
      const lower = calc.calculateOptimalChunkSize(1024 * 1024, 'msgpack', 150)
      const upper = calc.calculateOptimalChunkSize(1024 * 1024, 'MSGPACK', 150)
      const mixed = calc.calculateOptimalChunkSize(1024 * 1024, 'MsgPack', 150)

      expect(lower).toBe(upper)
      expect(lower).toBe(mixed)
    })

    it('should return at least 1 reading even with tiny payload size', () => {
      const result = calc.calculateOptimalChunkSize(100, 'json', 150)
      expect(result).toBe(1)
    })

    it('should return 1 for negative payload size', () => {
      const result = calc.calculateOptimalChunkSize(-1000, 'json', 150)
      expect(result).toBe(1)
    })

    it('should return 1 for zero payload size', () => {
      const result = calc.calculateOptimalChunkSize(0, 'json', 150)
      expect(result).toBe(1)
    })

    it('should handle default reading size if not provided', () => {
      const withDefault = calc.calculateOptimalChunkSize(1024 * 1024)
      const explicit = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 150)

      expect(withDefault).toBe(explicit)
    })

    it('should respect 80% safety margin', () => {
      const result = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 150)
      // Expected: (819200 - 500) / 150 = ~5460
      expect(result).toBeGreaterThan(5000)
      expect(result).toBeLessThan(6000)
    })

    it('should handle custom reading size', () => {
      const small = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 50)
      const large = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 300)

      // Smaller readings = more can fit per chunk
      expect(small).toBeGreaterThan(large)
      expect(small).toBeGreaterThan(large * 2)
    })

    it('should handle unknown compression method (defaults to no compression)', () => {
      const result = calc.calculateOptimalChunkSize(1024 * 1024, 'unknown-method', 150)
      const json = calc.calculateOptimalChunkSize(1024 * 1024, 'json', 150)

      expect(result).toBe(json)
    })
  })

  describe('getDefaultMaxPayloadSize', () => {
    it('should return 256 KB for azure', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('azure')).toBe(256 * 1024)
    })

    it('should return 128 KB for aws', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('aws')).toBe(128 * 1024)
    })

    it('should return 128 KB for gcp', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('gcp')).toBe(128 * 1024)
    })

    it('should return 256 KB for mqtt-azure', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('mqtt-azure')).toBe(256 * 1024)
    })

    it('should return 128 KB for mqtt-aws', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('mqtt-aws')).toBe(128 * 1024)
    })

    it('should return 1 MB for generic mqtt', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('mqtt')).toBe(1024 * 1024)
    })

    it('should return 1 MB for unknown type', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('unknown')).toBe(1024 * 1024)
    })

    it('should return 1 MB for empty string', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('')).toBe(1024 * 1024)
    })

    it('should return Infinity for noop', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('noop')).toBe(Infinity)
    })

    it('should return 10 MB for influxdb', () => {
      expect(PayloadChunkCalculator.getDefaultMaxPayloadSize('influxdb')).toBe(10 * 1024 * 1024)
    })
  })

  describe('isValidPayloadSize', () => {
    it('should accept 256 KB', () => {
      expect(PayloadChunkCalculator.isValidPayloadSize(256 * 1024)).toBe(true)
    })

    it('should accept 1 MB', () => {
      expect(PayloadChunkCalculator.isValidPayloadSize(1024 * 1024)).toBe(true)
    })

    it('should reject < 1 KB', () => {
      expect(PayloadChunkCalculator.isValidPayloadSize(512)).toBe(false)
    })

    it('should reject > 100 MB', () => {
      expect(PayloadChunkCalculator.isValidPayloadSize(101 * 1024 * 1024)).toBe(false)
    })

    it('should reject 0', () => {
      expect(PayloadChunkCalculator.isValidPayloadSize(0)).toBe(false)
    })

    it('should reject negative', () => {
      expect(PayloadChunkCalculator.isValidPayloadSize(-1024)).toBe(false)
    })
  })

  describe('formatBytes', () => {
    it('should format bytes', () => {
      expect(PayloadChunkCalculator.formatBytes(512)).toBe('512 B')
      expect(PayloadChunkCalculator.formatBytes(1024)).toBe('1.0 KB')
      expect(PayloadChunkCalculator.formatBytes(256 * 1024)).toBe('256.0 KB')
      expect(PayloadChunkCalculator.formatBytes(1024 * 1024)).toBe('1.0 MB')
      expect(PayloadChunkCalculator.formatBytes(10 * 1024 * 1024)).toBe('10.0 MB')
    })
  })
})


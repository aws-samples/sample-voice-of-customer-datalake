/**
 * @fileoverview Tests for responseParser.ts
 * @module api/responseParser.test
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { parseResponse, createResponseParser } from './responseParser'

describe('responseParser', () => {
  describe('parseResponse', () => {
    it('parses valid JSON response without schema', async () => {
      const mockData = { name: 'test', value: 123 }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(mockData),
      } as unknown as Response

      const result = await parseResponse<{ name: string; value: number }>(mockResponse)

      expect(result).toEqual(mockData)
      expect(mockResponse.json).toHaveBeenCalledOnce()
    })

    it('validates response against provided schema', async () => {
      const schema = z.object({
        id: z.string(),
        count: z.number(),
      })
      const mockData = { id: 'abc', count: 42 }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(mockData),
      } as unknown as Response

      const result = await parseResponse(mockResponse, schema)

      expect(result).toEqual(mockData)
    })

    it('throws ZodError when response does not match schema', async () => {
      const schema = z.object({
        id: z.string(),
        count: z.number(),
      })
      const invalidData = { id: 123, count: 'not a number' }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(invalidData),
      } as unknown as Response

      await expect(parseResponse(mockResponse, schema)).rejects.toThrow()
    })

    it('handles null values in response', async () => {
      const mockResponse = {
        json: vi.fn().mockResolvedValue(null),
      } as unknown as Response

      const result = await parseResponse<null>(mockResponse)

      expect(result).toBeNull()
    })

    it('handles array responses', async () => {
      const mockData = [{ id: 1 }, { id: 2 }, { id: 3 }]
      const mockResponse = {
        json: vi.fn().mockResolvedValue(mockData),
      } as unknown as Response

      const result = await parseResponse<Array<{ id: number }>>(mockResponse)

      expect(result).toEqual(mockData)
      expect(result).toHaveLength(3)
    })

    it('handles nested object responses', async () => {
      const mockData = {
        user: { name: 'John', profile: { age: 30 } },
        items: [{ id: 1 }, { id: 2 }],
      }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(mockData),
      } as unknown as Response

      const result = await parseResponse<typeof mockData>(mockResponse)

      expect(result.user.profile.age).toBe(30)
      expect(result.items).toHaveLength(2)
    })

    it('validates complex nested schema', async () => {
      const schema = z.object({
        data: z.object({
          items: z.array(z.object({
            id: z.string(),
            value: z.number(),
          })),
        }),
        meta: z.object({
          total: z.number(),
        }),
      })
      const mockData = {
        data: { items: [{ id: 'a', value: 1 }] },
        meta: { total: 1 },
      }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(mockData),
      } as unknown as Response

      const result = await parseResponse(mockResponse, schema)

      expect(result.data.items[0].id).toBe('a')
      expect(result.meta.total).toBe(1)
    })
  })

  describe('createResponseParser', () => {
    it('creates reusable parser for schema', async () => {
      const schema = z.object({
        success: z.boolean(),
        message: z.string(),
      })
      const parser = createResponseParser(schema)

      const mockData = { success: true, message: 'OK' }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(mockData),
      } as unknown as Response

      const result = await parser(mockResponse)

      expect(result).toEqual(mockData)
    })

    it('throws when parsed data does not match schema', async () => {
      const schema = z.object({
        success: z.boolean(),
        message: z.string(),
      })
      const parser = createResponseParser(schema)

      const invalidData = { success: 'yes', message: 123 }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(invalidData),
      } as unknown as Response

      await expect(parser(mockResponse)).rejects.toThrow()
    })

    it('can be used multiple times with different responses', async () => {
      const schema = z.object({ id: z.number() })
      const parser = createResponseParser(schema)

      const response1 = { json: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as Response
      const response2 = { json: vi.fn().mockResolvedValue({ id: 2 }) } as unknown as Response

      const result1 = await parser(response1)
      const result2 = await parser(response2)

      expect(result1.id).toBe(1)
      expect(result2.id).toBe(2)
    })

    it('validates optional fields correctly', async () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      })
      const parser = createResponseParser(schema)

      const mockData = { required: 'value' }
      const mockResponse = {
        json: vi.fn().mockResolvedValue(mockData),
      } as unknown as Response

      const result = await parser(mockResponse)

      expect(result.required).toBe('value')
      expect(result.optional).toBeUndefined()
    })

    it('validates union types correctly', async () => {
      const schema = z.object({
        status: z.union([z.literal('success'), z.literal('error')]),
      })
      const parser = createResponseParser(schema)

      const successResponse = {
        json: vi.fn().mockResolvedValue({ status: 'success' }),
      } as unknown as Response
      const errorResponse = {
        json: vi.fn().mockResolvedValue({ status: 'error' }),
      } as unknown as Response
      const invalidResponse = {
        json: vi.fn().mockResolvedValue({ status: 'unknown' }),
      } as unknown as Response

      expect((await parser(successResponse)).status).toBe('success')
      expect((await parser(errorResponse)).status).toBe('error')
      await expect(parser(invalidResponse)).rejects.toThrow()
    })
  })
})

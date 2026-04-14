'use strict';

const { parsePagination, enrichPagination } = require('../pagination');

describe('parsePagination', () => {
  it('defaults to page=1, limit=10', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 10 });
  });

  it('parses explicit values', () => {
    expect(parsePagination({ page: '3', limit: '25' })).toEqual({ page: 3, limit: 25 });
  });

  it('clamps page below 1 to 1', () => {
    expect(parsePagination({ page: '0' }).page).toBe(1);
    expect(parsePagination({ page: '-5' }).page).toBe(1);
  });

  it('treats limit=0 as missing and applies default', () => {
    // parseInt('0') || 10 evaluates to 10 because 0 is falsy
    expect(parsePagination({ limit: '0' }).limit).toBe(10);
  });

  it('clamps explicit negative limit to 1', () => {
    // parseInt('-1') is -1 (truthy), then clamped to 1
    expect(parsePagination({ limit: '-1' }).limit).toBe(1);
  });

  it('caps limit at 100', () => {
    expect(parsePagination({ limit: '200' }).limit).toBe(100);
  });

  it('ignores non-numeric values and falls back to defaults', () => {
    expect(parsePagination({ page: 'abc', limit: 'xyz' })).toEqual({ page: 1, limit: 10 });
  });
});

describe('enrichPagination', () => {
  const makeReq = (url = '/v1/topics?lang=en') => ({
    originalUrl: url,
    protocol: 'http',
    get: () => 'localhost:3000',
  });

  it('adds has_more=false when on last page', () => {
    const p = { page: 1, limit: 10, total: 8 };
    const enriched = enrichPagination(p, makeReq());
    expect(enriched.has_more).toBe(false);
    expect(enriched.next_page_url).toBeNull();
  });

  it('adds has_more=true and next_page_url when more pages exist', () => {
    const p = { page: 1, limit: 10, total: 25 };
    const enriched = enrichPagination(p, makeReq('/v1/topics?lang=en'));
    expect(enriched.has_more).toBe(true);
    expect(enriched.next_page_url).toContain('page=2');
    expect(enriched.next_page_url).toContain('limit=10');
  });

  it('preserves existing pagination fields', () => {
    const p = { page: 2, limit: 10, total: 35 };
    const enriched = enrichPagination(p, makeReq());
    expect(enriched.page).toBe(2);
    expect(enriched.limit).toBe(10);
    expect(enriched.total).toBe(35);
    expect(enriched.has_more).toBe(true);
  });

  it('handles req=null gracefully (no next_page_url)', () => {
    const p = { page: 1, limit: 10, total: 25 };
    const enriched = enrichPagination(p, null);
    expect(enriched.has_more).toBe(true);
    expect(enriched.next_page_url).toBeNull();
  });
});

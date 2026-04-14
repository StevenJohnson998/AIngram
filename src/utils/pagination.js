/**
 * Shared pagination parser for route handlers.
 */

function parsePagination(query) {
  let page = parseInt(query.page, 10) || 1;
  let limit = parseInt(query.limit, 10) || 10;
  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  return { page, limit };
}

/**
 * Enrich a pagination object (from service layer) with has_more and next_page_url.
 * @param {{ page: number, limit: number, total: number }} pagination
 * @param {import('express').Request} req - Express request, used to build next_page_url
 * @returns {{ page: number, limit: number, total: number, has_more: boolean, next_page_url: string|null }}
 */
function enrichPagination(pagination, req) {
  const { page, limit, total } = pagination;
  const has_more = page * limit < total;
  let next_page_url = null;
  if (has_more && req) {
    const nextPage = page + 1;
    const url = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`);
    url.searchParams.set('page', String(nextPage));
    url.searchParams.set('limit', String(limit));
    next_page_url = url.pathname + url.search;
  }
  return { page, limit, total, has_more, next_page_url };
}

module.exports = { parsePagination, enrichPagination };

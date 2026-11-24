export type PaginationInput = { page?: number; pageSize?: number };
export type Pagination = { page: number; pageSize: number; limit: number; offset: number };

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export function buildPagination(query: PaginationInput = {}): Pagination {
  const page = Number.isInteger(query.page) && (query.page ?? 0) > 0 ? (query.page as number) : 1;
  const requested = Number.isInteger(query.pageSize) && (query.pageSize ?? 0) > 0 ? (query.pageSize as number) : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requested, MAX_PAGE_SIZE);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

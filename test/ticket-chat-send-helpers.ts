import type { Unchecked } from '../src/types/unchecked';
import assert from 'node:assert/strict';

export function mockRegos({
  ticket,
  addResult,
  addError,
  setResponsibleError,
  onAdd,
  onAddFile,
  onSetParticipants,
  onSetResponsible,
  onGetMessages,
  messages,
  files,
  chatFiles,
  users,
  cdn,
  onCdnFetch,
}: Unchecked = {}) {
  (global as any).fetch = async (url?: any, options?: any) => {
    const urlStr = String(url);
    if (cdn) {
      if (cdn.redirectFrom && urlStr === cdn.redirectFrom) {
        if (onCdnFetch) onCdnFetch({ ...options, url: urlStr, redirected: true });
        return new Response(null, {
          status: cdn.redirectStatus || 302,
          headers: { location: cdn.url },
        });
      }
      if (urlStr === cdn.url) {
        if (onCdnFetch) onCdnFetch(options);
        const range = options?.headers?.Range || options?.headers?.range || '';
        if (range && cdn.rangeBody != null) {
          return new Response(cdn.rangeBody, {
            status: 206,
            headers: {
              'content-type': cdn.contentType || 'application/octet-stream',
              'content-range': cdn.contentRange || 'bytes 0-4/10',
              'accept-ranges': 'bytes',
            },
          });
        }
        return new Response(cdn.body, {
          status: 200,
          headers: {
            'content-type': cdn.contentType || 'application/octet-stream',
            'accept-ranges': 'bytes',
          },
        });
      }
    }
    const endpoint = urlStr.split('/v1/')[1] || '';
    const body = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : {};

    if (endpoint === 'Ticket/Get') {
      const rows = ticket ? [ticket] : [];
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: rows,
            next_offset: rows.length,
            total: rows.length,
          };
        },
      };
    }

    if (endpoint === 'Ticket/SetParticipants') {
      if (onSetParticipants) onSetParticipants(body);
      return {
        ok: true,
        async json() {
          return { ok: true, result: { row_affected: 1, ids: [ticket?.id].filter(Boolean) } };
        },
      };
    }

    if (endpoint === 'Ticket/SetResponsible') {
      if (onSetResponsible) onSetResponsible(body);
      if (setResponsibleError) {
        return {
          ok: true,
          async json() {
            return {
              ok: false,
              result: {
                error: setResponsibleError.code || 'PermissionDenied',
                description: setResponsibleError.description || 'Not allowed',
              },
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { ok: true, result: { row_affected: 1, ids: [ticket?.id].filter(Boolean) } };
        },
      };
    }

    if (endpoint === 'ChatMessage/AddFile') {
      if (onAddFile) onAddFile(body);
      return {
        ok: true,
        async json() {
          return { ok: true, result: { file_id: 321 } };
        },
      };
    }

    if (endpoint === 'ChatMessage/Add') {
      if (onAdd) onAdd(body);
      if (addError) {
        return {
          ok: true,
          async json() {
            return {
              ok: false,
              result: {
                error: addError.code || '1220',
                description: addError.description || 'Chat is closed',
              },
            };
          },
        };
      }
      assert.equal(body.chat_id, ticket.chat_id);
      assert.ok(
        String(body.text || '').trim() || (Array.isArray(body.file_ids) && body.file_ids.length)
      );
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: addResult || { new_id: 'created-msg-1' },
          };
        },
      };
    }

    if (endpoint === 'ChatMessage/Get') {
      if (onGetMessages) onGetMessages(body);
      const rows = messages || [];
      const newestFirst = [...rows].sort((a?: any, b?: any) => {
        const dateA = Number(a?.created_date) || 0;
        const dateB = Number(b?.created_date) || 0;
        if (dateA !== dateB) return dateB - dateA;
        return String(b?.id || '').localeCompare(String(a?.id || ''));
      });
      const limit = Math.max(1, Number(body.limit) || newestFirst.length || 1);
      const offset = Math.max(0, Number(body.offset) || 0);
      const slice = newestFirst.slice(offset, offset + limit);
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: slice,
            next_offset: offset + slice.length,
            total: newestFirst.length,
          };
        },
      };
    }

    if (endpoint === 'User/Get') {
      const rows = users || [];
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: rows,
            next_offset: rows.length,
            total: rows.length,
          };
        },
      };
    }

    if (endpoint === 'ChatMessage/GetFiles') {
      const source = chatFiles || files || [];
      const rows = source.map((item?: any) => (item?.file ? item : { file: item }));
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: rows,
            next_offset: rows.length,
            total: rows.length,
          };
        },
      };
    }

    if (endpoint === 'File/Get') {
      const rows = files || [];
      const filter = Array.isArray(body.filters) ? body.filters[0] : null;
      const filterId = filter?.Value != null ? Number(filter.Value) : null;
      const filtered =
        Number.isFinite(filterId) && filterId! > 0
          ? rows.filter((row?: any) => Number(row.id) === filterId)
          : rows;
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: filtered,
            next_offset: filtered.length,
            total: filtered.length,
          };
        },
      };
    }

    throw new Error(`Unexpected Regos endpoint: ${endpoint || urlStr}`);
  };
}
